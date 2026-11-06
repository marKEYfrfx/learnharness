/**
 * GitHub sync (docs/github-sync.md): the pure helpers, the settings
 * section, the OAuth device flow (fake fetch + clock), and the
 * isomorphic-git engine END TO END against a local smart-HTTP git server
 * (`git http-backend` behind node:http, bare repo in a tmp dir, Basic auth
 * required) — the same protocol GitHub speaks. The engine tests skip when
 * no system `git` is on PATH (the server side only; the app itself never
 * needs one).
 *
 * LH_DATA_DIR / LH_AUTH_FILE redirect to a fresh tmp dir BEFORE the
 * imports (the config seam is module-load bound). Tokens are throwaway
 * strings, never real secrets.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-github-sync-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_GITHUB_CLIENT_ID;

const { parseRepoSlug, planStaging, summarizeChanges, resolveGithubSync, DATA_GITIGNORE } = await import("../src/core/github-sync.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { parseGithubSyncSettingsBody, SETTINGS_SECTIONS } = await import("../src/server/settings-body.ts");
const oauth = await import("../src/server/github-oauth.ts");
const engine = await import("../src/server/github-sync.ts");
const { readGithubCredentials, writeGithubCredentials } = await import("../src/store/github-credentials.ts");
const { GITHUB_SYNC_CREDENTIALS_FILE } = await import("../config.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("parseRepoSlug", () => {
	it("accepts owner/name and github.com URLs, normalized", () => {
		assert.equal(parseRepoSlug("me/backup"), "me/backup");
		assert.equal(parseRepoSlug("  me/backup.git "), "me/backup");
		assert.equal(parseRepoSlug("https://github.com/me/lh-data"), "me/lh-data");
		assert.equal(parseRepoSlug("https://github.com/me/lh-data.git/"), "me/lh-data");
		assert.equal(parseRepoSlug("git@github.com:me/lh_data.v2.git"), "me/lh_data.v2");
	});
	it("rejects everything else", () => {
		for (const bad of ["", "me", "me/", "/backup", "a/b/c", "https://gitlab.com/me/x", "https://github.com/me/x?tab=1", "-me/x", "me--x/y", "me/..", "me/has space"]) {
			assert.equal(parseRepoSlug(bad), null, bad);
		}
	});
});

describe("planStaging / summarizeChanges", () => {
	it("is the git add -A equivalent", () => {
		const matrix = [
			["new.json", 0, 2, 0],
			["same.json", 1, 1, 1],
			["edited.json", 1, 2, 1],
			["gone.json", 1, 0, 1],
			["staged-then-deleted.json", 0, 0, 3],
		] as const;
		const plan = planStaging(matrix as never);
		assert.deepEqual(plan.add, ["new.json", "edited.json"]);
		assert.deepEqual(plan.remove, ["gone.json", "staged-then-deleted.json"]);
		assert.deepEqual(summarizeChanges(matrix as never), { added: 1, modified: 1, deleted: 1 });
	});
});

describe("githubSync settings section", () => {
	it("sanitizer keeps valid fields, normalizes the repo, drops junk", () => {
		const s = sanitizeUserSettings({ version: 1, githubSync: { enabled: true, repo: "https://github.com/me/backup.git", extra: 1 } });
		assert.deepEqual(s?.githubSync, { enabled: true, repo: "me/backup" });
		assert.deepEqual(sanitizeUserSettings({ version: 1, githubSync: { enabled: "yes", repo: "nope" } })?.githubSync, {});
		assert.deepEqual(resolveGithubSync(undefined), { enabled: false, repo: null });
	});
	it("PUT parser is strict and registered", () => {
		assert.equal(SETTINGS_SECTIONS.githubSync, parseGithubSyncSettingsBody);
		assert.deepEqual(parseGithubSyncSettingsBody({ enabled: true, repo: "me/backup" }), { ok: true, settings: { enabled: true, repo: "me/backup" } });
		assert.deepEqual(parseGithubSyncSettingsBody({ repo: "" }), { ok: true, settings: {} });
		assert.equal(parseGithubSyncSettingsBody({ enabled: 1 }).ok, false);
		assert.equal(parseGithubSyncSettingsBody({ repo: "not a repo" }).ok, false);
	});
});

describe("credentials store", () => {
	it("lives beside auth.json (outside the data folder), mode 0600", () => {
		assert.equal(path.dirname(GITHUB_SYNC_CREDENTIALS_FILE), TMP);
		assert.ok(!GITHUB_SYNC_CREDENTIALS_FILE.startsWith(process.env.LH_DATA_DIR!));
		writeGithubCredentials({ token: "gho_throwaway", login: "tester", id: 42, scope: "repo", savedAt: "2026-10-31T00:00:00.000Z" });
		assert.equal(readGithubCredentials()?.login, "tester");
		if (process.platform !== "win32") assert.equal(fs.statSync(GITHUB_SYNC_CREDENTIALS_FILE).mode & 0o777, 0o600);
		oauth.signOutGithub();
		assert.equal(readGithubCredentials(), null);
	});
});

// ─── Device flow ─────────────────────────────────────────────────────────────

function fakeGithub(tokenReplies: Record<string, unknown>[]) {
	const calls: { url: string; body: string }[] = [];
	const sleeps: number[] = [];
	const saved: unknown[] = [];
	let clock = 1_000_000;
	const deps = {
		clientId: () => "Iv1.testclient",
		now: () => clock,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			clock += ms;
		},
		save: (c: unknown) => saved.push(c),
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, body: String(init?.body ?? "") });
			const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			if (url === "https://github.com/login/device/code") {
				return json({ device_code: "dc-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
			}
			if (url === "https://github.com/login/oauth/access_token") return json(tokenReplies.shift() ?? { error: "authorization_pending" });
			if (url === "https://api.github.com/user") {
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gho_minted");
				return json({ login: "tester", id: 42 });
			}
			return json({}, 404);
		}) as typeof fetch,
	};
	return { deps, calls, sleeps, saved };
}

describe("OAuth device flow", () => {
	it("polls through pending + slow_down, then saves the account", async () => {
		const gh = fakeGithub([{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: "gho_minted", scope: "repo", token_type: "bearer" }]);
		const started = await oauth.startGithubLogin(gh.deps);
		assert.equal(started.userCode, "ABCD-1234");
		assert.equal(started.verificationUri, "https://github.com/login/device");
		assert.match(gh.calls[0]!.body, /client_id=Iv1.testclient/);
		assert.match(gh.calls[0]!.body, /scope=repo/);
		await oauth.githubLoginLoop();
		assert.deepEqual(gh.sleeps, [5000, 5000, 10000]);
		assert.match(gh.calls[1]!.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
		assert.equal(gh.saved.length, 1);
		assert.deepEqual({ ...(gh.saved[0] as object), savedAt: undefined }, { token: "gho_minted", login: "tester", id: 42, scope: "repo", savedAt: undefined });
		assert.deepEqual(oauth.githubLoginStatus(), { pendingLogin: null, loginError: null });
	});

	it("reports a denied sign-in", async () => {
		const gh = fakeGithub([{ error: "access_denied" }]);
		await oauth.startGithubLogin(gh.deps);
		assert.equal(oauth.githubLoginStatus().pendingLogin?.userCode, "ABCD-1234");
		await oauth.githubLoginLoop();
		assert.equal(gh.saved.length, 0);
		assert.equal(oauth.githubLoginStatus().loginError, "Sign-in was cancelled on GitHub.");
	});

	it("cancel stops the poll loop without saving", async () => {
		const gh = fakeGithub([{ access_token: "gho_minted", scope: "repo" }]);
		const deps = { ...gh.deps, sleep: async () => oauth.cancelGithubLogin() };
		await oauth.startGithubLogin(deps);
		await oauth.githubLoginLoop();
		assert.equal(gh.saved.length, 0);
		assert.equal(oauth.githubLoginStatus().pendingLogin, null);
	});

	it("refuses to start without a client ID", async () => {
		const gh = fakeGithub([]);
		await assert.rejects(oauth.startGithubLogin({ ...gh.deps, clientId: () => "" }), /isn't configured/);
		assert.equal(gh.calls.length, 0);
	});
});

// ─── Engine, end to end ──────────────────────────────────────────────────────

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;
const TOKEN = "gho_throwaway_token";
const CREDS = { token: TOKEN, login: "tester", id: 42, scope: "repo", savedAt: "2026-10-31T00:00:00.000Z" };
const AUTH = `Basic ${Buffer.from(`${TOKEN}:x-oauth-basic`).toString("base64")}`;

/** A minimal smart-HTTP git server: `git http-backend` as CGI, Basic auth required. */
function startGitServer(projectRoot: string): Promise<{ url: string; close: () => void }> {
	const server = http.createServer((req, res) => {
		if (req.headers.authorization !== AUTH) {
			res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
			res.end("unauthorized");
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		const cgi = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: projectRoot,
				GIT_HTTP_EXPORT_ALL: "1",
				REMOTE_USER: "tester",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: req.method ?? "GET",
				CONTENT_TYPE: req.headers["content-type"] ?? "",
				...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
			},
		});
		req.pipe(cgi.stdin);
		let buffer = Buffer.alloc(0);
		let headersDone = false;
		cgi.stdout.on("data", (chunk: Buffer) => {
			if (headersDone) return void res.write(chunk);
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end === -1) return;
			headersDone = true;
			let status = 200;
			for (const line of buffer.subarray(0, end).toString().split("\r\n")) {
				const [name, ...rest] = line.split(":");
				const value = rest.join(":").trim();
				if (name!.toLowerCase() === "status") status = Number.parseInt(value, 10);
				else res.setHeader(name!, value);
			}
			res.writeHead(status);
			res.write(buffer.subarray(end + 4));
		});
		cgi.on("close", () => res.end());
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
		});
	});
}

const gitOut = (gitDir: string, ...args: string[]) => execFileSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf-8" }).trim();

describe("sync engine (local smart-HTTP remote)", { skip: !HAS_GIT && "system git not installed" }, () => {
	const root = path.join(TMP, "remotes");
	const bare = path.join(root, "me", "backup.git");
	const dir = path.join(TMP, "engine-data");
	let server: { url: string; close: () => void };
	let remoteUrl: string;

	before(async () => {
		fs.mkdirSync(bare, { recursive: true });
		execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
		server = await startGitServer(root);
		remoteUrl = `${server.url}/me/backup.git`;
	});
	after(() => server?.close());

	const sync = (overrides: Partial<Parameters<typeof engine.syncFolder>[0]> = {}) =>
		engine.syncFolder({ dir, repo: "me/backup", credentials: CREDS, remoteUrl, ...overrides });
	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	};
	const remoteFiles = () => gitOut(bare, "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean).sort();

	it("first sync inits the folder, ignores debug + tmp files, and pushes", async () => {
		write("chats/a.json", '{"id":"a"}');
		write("settings.json", '{"version":1}');
		write("graph/nodes.jsonl", '{"n":1}\n');
		write("graph/nodes.jsonl.tmp-abc123", "partial");
		write("graph/source-organization.json.0f0f.tmp", "partial");
		write("debug/provider-events/a.jsonl", "raw");
		const run = await sync();
		assert.equal(run.ok, true, run.error);
		assert.equal(run.pushed, true);
		assert.match(run.committed ?? "", /^[0-9a-f]{7}$/);
		assert.deepEqual(remoteFiles(), [".gitignore", "chats/a.json", "graph/nodes.jsonl", "settings.json"]);
		assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8"), DATA_GITIGNORE);
		assert.equal(gitOut(bare, "log", "-1", "--format=%an <%ae>", "main"), "tester <42+tester@users.noreply.github.com>");
		// The token never lands in the pushed folder's git config.
		assert.ok(!fs.readFileSync(path.join(dir, ".git", "config"), "utf-8").includes(TOKEN));
	});

	it("no changes → no commit, no push", async () => {
		const before = gitOut(bare, "rev-parse", "main");
		const run = await sync();
		assert.deepEqual({ ok: run.ok, committed: run.committed, pushed: run.pushed }, { ok: true, committed: undefined, pushed: false });
		assert.equal(gitOut(bare, "rev-parse", "main"), before);
	});

	it("edits, additions and deletions land as one commit", async () => {
		write("chats/a.json", '{"id":"a","v":2}');
		write("chats/b.json", '{"id":"b"}');
		fs.rmSync(path.join(dir, "settings.json"));
		const run = await sync();
		assert.equal(run.ok, true, run.error);
		assert.equal(run.pushed, true);
		assert.deepEqual(remoteFiles(), [".gitignore", "chats/a.json", "chats/b.json", "graph/nodes.jsonl"]);
		assert.equal(gitOut(bare, "show", "main:chats/a.json"), '{"id":"a","v":2}');
		assert.match(gitOut(bare, "log", "-1", "--format=%s", "main"), /\(1 added, 1 modified, 1 deleted\)$/);
	});

	it("a rejected token keeps the commit local; the next good run pushes it", async () => {
		write("chats/c.json", '{"id":"c"}');
		const failed = await sync({ credentials: { ...CREDS, token: "gho_wrong" } });
		assert.equal(failed.ok, false);
		assert.match(failed.error ?? "", /sign in again/);
		assert.ok(failed.committed);
		assert.ok(!remoteFiles().includes("chats/c.json"));
		const retried = await sync();
		assert.equal(retried.ok, true, retried.error);
		assert.equal(retried.committed, undefined); // nothing new to commit…
		assert.equal(retried.pushed, true); // …but the outstanding commit went up
		assert.ok(remoteFiles().includes("chats/c.json"));
	});

	it("never overwrites a remote with history this folder lacks", async () => {
		// Someone else pushes to the repo (plain git, straight into the bare repo).
		const other = path.join(TMP, "other-clone");
		execFileSync("git", ["clone", "-q", bare, other]);
		fs.writeFileSync(path.join(other, "elsewhere.txt"), "x");
		execFileSync("git", ["-C", other, "add", "."]);
		execFileSync("git", ["-C", other, "-c", "user.name=o", "-c", "user.email=o@x", "commit", "-qm", "other machine"]);
		execFileSync("git", ["-C", other, "push", "-q", "origin", "main"]);
		const remoteHead = gitOut(bare, "rev-parse", "main");
		write("chats/d.json", '{"id":"d"}');
		const run = await sync();
		assert.equal(run.ok, false);
		assert.match(run.error ?? "", /has commits this folder doesn't/);
		assert.equal(gitOut(bare, "rev-parse", "main"), remoteHead);
	});

	it("refuses a pre-existing repo on another branch (no commit loop)", async () => {
		const other = path.join(TMP, "engine-data-branch");
		fs.mkdirSync(other, { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "master", other]);
		fs.writeFileSync(path.join(other, "x.json"), "{}");
		const run = await engine.syncFolder({ dir: other, repo: "me/backup", credentials: CREDS, remoteUrl });
		assert.equal(run.ok, false);
		assert.match(run.error ?? "", /on branch "master"/);
		assert.equal(spawnSync("git", ["-C", other, "rev-parse", "--verify", "-q", "HEAD"]).status, 1); // nothing committed
	});

	it("an unknown repo reads as not found", async () => {
		const run = await engine.syncFolder({ dir: path.join(TMP, "engine-data-2"), repo: "me/missing", credentials: CREDS, remoteUrl: `${server.url}/me/missing.git` });
		assert.equal(run.ok, false);
		assert.equal(run.error, "Repository me/missing wasn't found, or your account has no access to it.");
	});
});

describe("syncDataFolderNow refusals", () => {
	it("needs a sign-in, then a repo", async () => {
		oauth.signOutGithub();
		assert.equal((await engine.syncDataFolderNow()).error, "Sign in with GitHub first.");
		writeGithubCredentials(CREDS);
		assert.equal((await engine.syncDataFolderNow()).error, "Set a repository first.");
		const status = engine.githubSyncStatus();
		assert.deepEqual(status.account, { login: "tester" });
		assert.equal(status.clientConfigured, false);
		assert.equal(status.last?.error, "Set a repository first.");
		assert.ok(!JSON.stringify(status).includes(TOKEN));
		oauth.signOutGithub();
	});
});
