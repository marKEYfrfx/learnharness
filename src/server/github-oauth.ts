/**
 * GitHub OAuth DEVICE FLOW for data-folder sync (docs/github-sync.md, owner
 * decision 2026-10-31). No client secret, no callback URL:
 *
 *   1. POST github.com/login/device/code → user_code + verification_uri;
 *      the Settings section shows the code and the link.
 *   2. This module polls POST github.com/login/oauth/access_token in the
 *      background, honoring `interval`, `slow_down`, `expired_token` and
 *      `access_denied` (GitHub's documented device-flow errors).
 *   3. On a token: GET api.github.com/user (login + id for commit
 *      authorship), then save to the credentials file (store/
 *      github-credentials.ts) — the token never leaves the server.
 *
 * State (the pending code, the last sign-in error) is in-memory, anchored on
 * globalThis so HMR re-imports keep one flow. A generation counter cancels
 * a superseded/abandoned poll loop.
 */

import { GITHUB_OAUTH_CLIENT_ID } from "../../config.ts";
import { GITHUB_SYNC_SCOPE } from "../core/github-sync.ts";
import { deleteGithubCredentials, writeGithubCredentials, type GithubCredentials } from "../store/github-credentials.ts";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const USER_AGENT = "LearnHarness";

/** The live client ID: LH_GITHUB_CLIENT_ID (dev override, read per call)
 *  over the committed config constant. "" = sign-in unavailable. */
export function githubClientId(): string {
	return process.env.LH_GITHUB_CLIENT_ID?.trim() || GITHUB_OAUTH_CLIENT_ID;
}

/** Injectable seams (tests swap the network and the clock). */
export interface GithubOAuthDeps {
	fetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	clientId: () => string;
	save: (credentials: GithubCredentials) => void;
}

const defaultDeps: GithubOAuthDeps = {
	fetch: (input, init) => fetch(input, init),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
	clientId: githubClientId,
	save: writeGithubCredentials,
};

interface PendingLogin {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresAt: number;
	intervalMs: number;
}

interface LoginState {
	pending: PendingLogin | null;
	error: string | null;
	/** Bumped by every start/cancel: a poll loop whose generation is stale exits. */
	generation: number;
	/** The running poll loop (tests await it). */
	loop: Promise<void> | null;
}

const g = globalThis as typeof globalThis & { __lhGithubLogin?: LoginState };
function state(): LoginState {
	g.__lhGithubLogin ??= { pending: null, error: null, generation: 0, loop: null };
	return g.__lhGithubLogin;
}

/** What GET /api/github-sync reports about sign-in. */
export function githubLoginStatus(): {
	pendingLogin: { userCode: string; verificationUri: string; expiresAt: string } | null;
	loginError: string | null;
} {
	const s = state();
	return {
		pendingLogin: s.pending
			? { userCode: s.pending.userCode, verificationUri: s.pending.verificationUri, expiresAt: new Date(s.pending.expiresAt).toISOString() }
			: null,
		loginError: s.error,
	};
}

/** Thrown for a sign-in that cannot start; `message` is safe to render. */
export class GithubLoginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GithubLoginError";
	}
}

async function postForm(deps: GithubOAuthDeps, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
	const res = await deps.fetch(url, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
		body: new URLSearchParams(form).toString(),
	});
	const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object") throw new GithubLoginError(`GitHub answered ${res.status} without a readable body.`);
	return body;
}

/**
 * Start a device-flow sign-in (replacing any pending one). Resolves with the
 * code to show; the token arrives later through the background poll.
 */
export async function startGithubLogin(deps: GithubOAuthDeps = defaultDeps): Promise<{
	userCode: string;
	verificationUri: string;
	expiresAt: string;
}> {
	const clientId = deps.clientId();
	if (!clientId) throw new GithubLoginError("GitHub sign-in isn't configured: no OAuth client ID (see docs/github-sync.md).");
	const s = state();
	const generation = ++s.generation;
	s.pending = null;
	s.error = null;
	let body: Record<string, unknown>;
	try {
		body = await postForm(deps, DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_SYNC_SCOPE });
	} catch (error) {
		throw error instanceof GithubLoginError ? error : new GithubLoginError("Couldn't reach GitHub to start sign-in.");
	}
	if (typeof body.error === "string") {
		throw new GithubLoginError(
			body.error === "device_flow_disabled"
				? "Device flow is disabled for this OAuth App — enable it in the app's GitHub settings."
				: body.error === "Not Found"
					? "GitHub doesn't recognize the configured OAuth client ID."
					: `GitHub refused to start sign-in: ${typeof body.error_description === "string" ? body.error_description : body.error}`,
		);
	}
	const { device_code, user_code, verification_uri, expires_in, interval } = body;
	if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string") {
		throw new GithubLoginError("GitHub's sign-in response was missing the device code.");
	}
	if (generation !== s.generation) throw new GithubLoginError("Sign-in was superseded.");
	const pending: PendingLogin = {
		deviceCode: device_code,
		userCode: user_code,
		verificationUri: verification_uri,
		expiresAt: deps.now() + (typeof expires_in === "number" ? expires_in : 900) * 1000,
		intervalMs: (typeof interval === "number" ? interval : 5) * 1000,
	};
	s.pending = pending;
	s.loop = pollUntilDone(deps, generation, pending).catch((error) => {
		console.error("[github-sync] sign-in poll failed:", error);
	});
	return { userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: new Date(pending.expiresAt).toISOString() };
}

/** End the pending flow (if any) without a token. */
function finish(generation: number, error: string | null): void {
	const s = state();
	if (generation !== s.generation) return;
	s.pending = null;
	s.error = error;
}

async function pollUntilDone(deps: GithubOAuthDeps, generation: number, pending: PendingLogin): Promise<void> {
	const s = state();
	let intervalMs = pending.intervalMs;
	for (;;) {
		await deps.sleep(intervalMs);
		if (generation !== s.generation) return; // cancelled or superseded
		if (deps.now() >= pending.expiresAt) return finish(generation, "The sign-in code expired — start again.");
		let body: Record<string, unknown>;
		try {
			body = await postForm(deps, ACCESS_TOKEN_URL, {
				client_id: deps.clientId(),
				device_code: pending.deviceCode,
				grant_type: DEVICE_GRANT,
			});
		} catch {
			continue; // transient network trouble — keep polling until expiry
		}
		if (generation !== s.generation) return;
		if (typeof body.access_token === "string" && body.access_token) {
			const token = body.access_token;
			const user = await fetchGithubUser(deps, token);
			if (generation !== s.generation) return;
			if (!user) return finish(generation, "Signed in, but GitHub didn't return the account — try again.");
			deps.save({
				token,
				login: user.login,
				id: user.id,
				scope: typeof body.scope === "string" ? body.scope : "",
				savedAt: new Date(deps.now()).toISOString(),
			});
			return finish(generation, null);
		}
		switch (body.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				// GitHub: add 5 s (it may also send the new interval).
				intervalMs = typeof body.interval === "number" ? body.interval * 1000 : intervalMs + 5000;
				continue;
			case "expired_token":
				return finish(generation, "The sign-in code expired — start again.");
			case "access_denied":
				return finish(generation, "Sign-in was cancelled on GitHub.");
			default:
				return finish(
					generation,
					`GitHub sign-in failed: ${typeof body.error_description === "string" ? body.error_description : String(body.error ?? "unknown error")}`,
				);
		}
	}
}

/** GET /user for the token's account, or null. */
export async function fetchGithubUser(
	deps: Pick<GithubOAuthDeps, "fetch">,
	token: string,
): Promise<{ login: string; id: number } | null> {
	try {
		const res = await deps.fetch(USER_URL, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"User-Agent": USER_AGENT,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!res.ok) return null;
		const body = (await res.json()) as Record<string, unknown>;
		return typeof body.login === "string" && typeof body.id === "number" ? { login: body.login, id: body.id } : null;
	} catch {
		return null;
	}
}

/** Sign out: cancel any pending flow and delete the saved token. (The
 *  token itself stays valid on GitHub until the user revokes the app at
 *  github.com/settings/applications — the Settings section links there.) */
export function signOutGithub(): void {
	const s = state();
	s.generation++;
	s.pending = null;
	s.error = null;
	deleteGithubCredentials();
}

/** Cancel a pending sign-in without touching saved credentials. */
export function cancelGithubLogin(): void {
	const s = state();
	s.generation++;
	s.pending = null;
}

/** Test seam: await the background poll loop. */
export function githubLoginLoop(): Promise<void> | null {
	return state().loop;
}
