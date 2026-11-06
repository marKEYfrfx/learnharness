/** Settings → Sync (docs/github-sync.md): SSR markup per state + the live
 *  sign-in / repo-save interactions against a fake fetch. No network. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GithubSyncSection, lastRunText } from "../components/settings/github-sync-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { GithubSyncSettings, GithubSyncStatus } from "../src/core/github-sync.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
});
// React picks its native onInput path only when the document advertises it
// (dictation-picker.test.tsx precedent) — linkedom doesn't by default — and
// it decides at module load, so react-dom/client loads AFTER the DOM exists.
Object.assign(dom.document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
const roots: Root[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	globalThis.fetch = originalFetch;
});

const status = (over: Partial<GithubSyncStatus> = {}): GithubSyncStatus => ({
	clientConfigured: true,
	account: null,
	pendingLogin: null,
	loginError: null,
	settings: { enabled: false, repo: null },
	dataDir: "/Users/me/Library/Application Support/LearnHarness/data",
	running: false,
	last: null,
	...over,
});
const render = (s: GithubSyncStatus, section?: GithubSyncSettings) =>
	renderToStaticMarkup(<GithubSyncSection section={section} onSectionChange={() => {}} initialStatus={s} />);

describe("GithubSyncSection markup", () => {
	it("signed out: sign-in button, sync controls inert", () => {
		const html = render(status());
		assert.match(html, /data-testid="github-sign-in"/);
		assert.match(html, /data-testid="github-sync-now"[^>]*disabled/);
		assert.match(html, /Not synced yet/);
		assert.match(html, /Application Support\/LearnHarness\/data/);
	});
	it("no client ID: says so, no button", () => {
		const html = render(status({ clientConfigured: false }));
		assert.match(html, /Sign-in isn(&#x27;|')t configured/);
		assert.doesNotMatch(html, /github-sign-in/);
	});
	it("pending: shows the code and the verification link", () => {
		const html = render(status({ pendingLogin: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-10-31T17:00:00.000Z" } }));
		assert.match(html, /ABCD-1234/);
		assert.match(html, /href="https:\/\/github.com\/login\/device"/);
		assert.match(html, /data-testid="github-cancel"/);
	});
	it("signed in with a repo: everything live", () => {
		const html = render(status({ account: { login: "tester" }, settings: { enabled: true, repo: "me/backup" } }), { enabled: true, repo: "me/backup" });
		assert.match(html, /Signed in as @tester/);
		assert.match(html, /value="me\/backup"/);
		assert.doesNotMatch(html, /data-testid="github-sync-now"[^>]*disabled/);
		assert.match(html, /role="switch" aria-checked="true"/);
	});
	it("last-run line", () => {
		assert.match(lastRunText({ at: new Date().toISOString(), ok: true, pushed: true, committed: "abc1234" }), /^Synced .* · commit abc1234\.$/);
		assert.match(lastRunText({ at: new Date().toISOString(), ok: true, pushed: false }), /already up to date/);
		assert.match(lastRunText({ at: new Date().toISOString(), ok: false, error: "Set a repository first." }), /Set a repository first\./);
	});
	it("the dialog lists the Sync section", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.match(html, /data-testid="settings-nav-sync"/);
	});
});

describe("GithubSyncSection interactions", () => {
	it("Sign in → POST /login, then shows the pending code from status", async () => {
		const calls: string[] = [];
		let current = status();
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const key = `${init?.method ?? "GET"} ${String(input)}`;
			calls.push(key);
			if (key === "POST /api/github-sync/login") {
				current = status({ pendingLogin: { userCode: "WXYZ-9876", verificationUri: "https://github.com/login/device", expiresAt: "2026-10-31T17:00:00.000Z" } });
				return Response.json({ userCode: "WXYZ-9876" });
			}
			return Response.json({ status: current });
		}) as typeof fetch;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		await act(async () => root.render(<GithubSyncSection section={undefined} onSectionChange={() => {}} />));
		const button = host.querySelector<HTMLButtonElement>("[data-testid='github-sign-in']");
		assert.ok(button);
		await act(async () => button.click());
		assert.deepEqual(calls.slice(0, 3), ["GET /api/github-sync", "POST /api/github-sync/login", "GET /api/github-sync"]);
		assert.match(host.querySelector("[data-testid='github-pending']")?.textContent ?? "", /WXYZ-9876/);
	});

	it("repo input normalizes a pasted URL and saves on Enter; junk is refused", async () => {
		globalThis.fetch = (async () => Response.json({ status: status({ account: { login: "tester" } }) })) as unknown as typeof fetch;
		const saved: GithubSyncSettings[] = [];
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		await act(async () => root.render(<GithubSyncSection section={{}} onSectionChange={(next) => void saved.push(next)} />));
		const input = host.querySelector<HTMLInputElement>("[data-testid='github-repo-input']")!;
		const type = async (value: string) => {
			await act(async () => {
				Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
				input.dispatchEvent(new window.Event("input", { bubbles: true }));
			});
			await act(async () => {
				const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(enter, "key", { value: "Enter" });
				input.dispatchEvent(enter);
			});
		};
		await type("https://github.com/me/backup.git");
		assert.deepEqual(saved, [{ repo: "me/backup" }]);
		await type("not a repo");
		assert.equal(saved.length, 1);
		assert.match(host.querySelector("[data-testid='github-sync-error']")?.textContent ?? "", /owner\/name/);
	});
});
