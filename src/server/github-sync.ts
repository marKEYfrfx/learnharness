/**
 * THE GITHUB SYNC ENGINE (docs/github-sync.md, owner 2026-10-31): tracks
 * the data folder (config.PATHS.data — the LH_DATA_DIR seam) as a git
 * repository with isomorphic-git (owner decision: bundled, no system git)
 * and pushes branch `main` to the user's own private GitHub repo.
 *
 * One run = ensure repo (init · .gitignore · origin URL) → stage
 * everything (`add -A` equivalent) → commit if anything changed → push
 * when the local branch is ahead of what GitHub last acknowledged (so an
 * earlier failed push retries even with nothing new to commit).
 *
 * PUSH-ONLY: never pulls, merges or force-pushes. A remote with commits
 * this folder lacks is reported, not overwritten.
 *
 * Concurrency: one run at a time — a caller arriving mid-run joins it.
 * Scheduler: an unref'd interval (GITHUB_SYNC_INTERVAL_MS) that acts only
 * when sync is enabled, signed in, and a repo is set; HMR-stable via
 * globalThis.
 */

import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import nodeHttp from "isomorphic-git/http/node";
import { PATHS } from "../../config.ts";
import {
	DATA_GITIGNORE,
	GITHUB_SYNC_BRANCH,
	GITHUB_SYNC_INTERVAL_MS,
	planStaging,
	repoRemoteUrl,
	resolveGithubSync,
	summarizeChanges,
	syncCommitMessage,
	type GithubSyncRun,
	type GithubSyncStatus,
	type StatusRow,
} from "../core/github-sync.ts";
import { readGithubCredentials, type GithubCredentials } from "../store/github-credentials.ts";
import { readSettings } from "../store/settings.ts";
import { githubClientId, githubLoginStatus } from "./github-oauth.ts";

type HttpClient = typeof nodeHttp;

export interface SyncFolderOptions {
	/** The working tree (the data folder). */
	dir: string;
	/** "owner/name". */
	repo: string;
	credentials: GithubCredentials;
	/** Test seams: an alternative remote URL (local smart-HTTP server) and
	 *  HTTP client. Production uses https://github.com/<repo>.git. */
	remoteUrl?: string;
	http?: HttpClient;
	now?: () => Date;
}

const LOCAL_REF = `refs/heads/${GITHUB_SYNC_BRANCH}`;
const TRACKING_REF = `refs/remotes/origin/${GITHUB_SYNC_BRANCH}`;

async function resolveOrNull(dir: string, ref: string): Promise<string | null> {
	try {
		return await git.resolveRef({ fs, dir, ref });
	} catch {
		return null;
	}
}

/** Create/repair the repository scaffolding. Idempotent. */
async function ensureRepo(dir: string, remoteUrl: string): Promise<void> {
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(path.join(dir, ".git"))) {
		await git.init({ fs, dir, defaultBranch: GITHUB_SYNC_BRANCH });
	}
	// A pre-existing repo checked out on another branch would get a commit
	// every tick that never pushes (sync only pushes `main`) — refuse instead.
	const branch = await git.currentBranch({ fs, dir, fullname: false });
	if (branch !== GITHUB_SYNC_BRANCH) {
		throw new Error(`the data folder's git repository is on branch "${branch ?? "(detached)"}"; sync only commits and pushes "${GITHUB_SYNC_BRANCH}".`);
	}
	const ignoreFile = path.join(dir, ".gitignore");
	let current: string | null = null;
	try {
		current = fs.readFileSync(ignoreFile, "utf-8");
	} catch {
		/* absent */
	}
	if (current !== DATA_GITIGNORE) fs.writeFileSync(ignoreFile, DATA_GITIGNORE, "utf-8");
	if ((await git.getConfig({ fs, dir, path: "remote.origin.url" })) !== remoteUrl) {
		await git.setConfig({ fs, dir, path: "remote.origin.url", value: remoteUrl });
		await git.setConfig({ fs, dir, path: "remote.origin.fetch", value: "+refs/heads/*:refs/remotes/origin/*" });
	}
}

/** Plain-language failure lines for the Settings section. */
export function describeSyncError(error: unknown, repo: string): string {
	const e = error as { code?: string; data?: Record<string, unknown>; message?: string } | null;
	if (e?.code === "HttpError") {
		const status = e.data?.statusCode;
		if (status === 401) return "GitHub rejected the saved sign-in — sign out and sign in again.";
		if (status === 403) return `Your GitHub account can't push to ${repo}.`;
		if (status === 404) return `Repository ${repo} wasn't found, or your account has no access to it.`;
		return `GitHub answered ${String(status)} ${String(e.data?.statusMessage ?? "")}`.trim() + ".";
	}
	if (e?.code === "PushRejectedError" || e?.code === "GitPushError") {
		return `GitHub rejected the push: ${repo} has commits this folder doesn't. Use an empty repository — sync never overwrites remote history.`;
	}
	if (e?.code === "SmartHttpError" || e?.code === "UnknownTransportError") {
		return `Couldn't talk to GitHub (${e.message ?? e.code}).`;
	}
	const message = e?.message ?? String(error);
	if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(message)) {
		return "Couldn't reach GitHub — check the internet connection.";
	}
	return `Sync failed: ${message}`;
}

/**
 * One sync of `dir` → `repo`. Never throws: failures come back as
 * `{ok: false, error}` (a commit made before a failed push stays local and
 * the next run pushes it).
 */
export async function syncFolder(options: SyncFolderOptions): Promise<GithubSyncRun> {
	const { dir, repo, credentials } = options;
	const now = options.now ?? (() => new Date());
	const remoteUrl = options.remoteUrl ?? repoRemoteUrl(repo);
	let committed: string | undefined;
	try {
		await ensureRepo(dir, remoteUrl);
		const cache = {};
		const matrix = (await git.statusMatrix({ fs, dir, cache })) as StatusRow[];
		const counts = summarizeChanges(matrix);
		const plan = planStaging(matrix);
		if (plan.add.length) await git.add({ fs, dir, filepath: plan.add, cache });
		for (const filepath of plan.remove) await git.remove({ fs, dir, filepath, cache });
		const head = await resolveOrNull(dir, LOCAL_REF);
		if (!head || counts.added + counts.modified + counts.deleted > 0) {
			const oid = await git.commit({
				fs,
				dir,
				cache,
				message: syncCommitMessage(counts, now()),
				author: { name: credentials.login, email: `${credentials.id}+${credentials.login}@users.noreply.github.com` },
			});
			committed = oid.slice(0, 7);
		}
		const local = await resolveOrNull(dir, LOCAL_REF);
		const acknowledged = await resolveOrNull(dir, TRACKING_REF);
		let pushed = false;
		if (local && local !== acknowledged) {
			const result = await git.push({
				fs,
				http: options.http ?? nodeHttp,
				dir,
				remote: "origin",
				ref: GITHUB_SYNC_BRANCH,
				// GitHub's documented OAuth-token basic auth: token as the
				// username, "x-oauth-basic" as the password. Sent up front (no
				// anonymous probe) and never written to .git/config.
				headers: {
					Authorization: `Basic ${Buffer.from(`${credentials.token}:x-oauth-basic`).toString("base64")}`,
					"User-Agent": "LearnHarness",
				},
			});
			if (!result.ok) throw new Error(result.error ?? "push failed");
			pushed = true;
			// isomorphic-git records the pushed oid under refs/remotes/origin/*;
			// make sure the ack ref matches even if a version doesn't.
			if ((await resolveOrNull(dir, TRACKING_REF)) !== local) {
				await git.writeRef({ fs, dir, ref: TRACKING_REF, value: local, force: true });
			}
		}
		return { at: now().toISOString(), ok: true, ...(committed ? { committed } : {}), pushed };
	} catch (error) {
		return { at: now().toISOString(), ok: false, ...(committed ? { committed } : {}), error: describeSyncError(error, repo) };
	}
}

// ─── Process-wide runner + scheduler ─────────────────────────────────────────

interface SyncState {
	running: Promise<GithubSyncRun> | null;
	last: GithubSyncRun | null;
	timer: ReturnType<typeof setInterval> | null;
	firstTimer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as typeof globalThis & { __lhGithubSync?: SyncState };
function state(): SyncState {
	g.__lhGithubSync ??= { running: null, last: null, timer: null, firstTimer: null };
	return g.__lhGithubSync;
}

function currentConfig() {
	return resolveGithubSync(readSettings()?.githubSync);
}

/**
 * Sync the data folder now (the "Sync now" button, and every scheduler
 * tick). Works whether or not automatic sync is enabled; needs a sign-in and
 * a repo. Joins an in-flight run instead of starting a second one.
 */
export function syncDataFolderNow(): Promise<GithubSyncRun> {
	const s = state();
	if (s.running) return s.running;
	const { repo } = currentConfig();
	const credentials = readGithubCredentials();
	const refuse = (error: string): Promise<GithubSyncRun> => {
		const run = { at: new Date().toISOString(), ok: false, error };
		s.last = run;
		return Promise.resolve(run);
	};
	if (!credentials) return refuse("Sign in with GitHub first.");
	if (!repo) return refuse("Set a repository first.");
	s.running = syncFolder({ dir: PATHS.data, repo, credentials })
		.then((run) => {
			s.last = run;
			if (!run.ok) console.warn(`[github-sync] ${run.error}`);
			return run;
		})
		.finally(() => {
			s.running = null;
		});
	return s.running;
}

/** One scheduler tick: acts only when fully configured AND enabled. */
export async function githubSyncTick(): Promise<void> {
	const { enabled, repo } = currentConfig();
	if (!enabled || !repo || !readGithubCredentials() || state().running) return;
	await syncDataFolderNow();
}

/** Start the background interval once per process (idempotent; unref'd so
 *  it never holds a process open). The first check runs a minute after
 *  boot, then every GITHUB_SYNC_INTERVAL_MS. */
export function startGithubSyncScheduler(): void {
	const s = state();
	if (s.timer) return;
	const tick = () => void githubSyncTick().catch((error) => console.error("[github-sync] tick failed:", error));
	s.firstTimer = setTimeout(tick, 60_000);
	s.firstTimer.unref?.();
	s.timer = setInterval(tick, GITHUB_SYNC_INTERVAL_MS);
	s.timer.unref?.();
}

/** GET /api/github-sync. The token never appears. */
export function githubSyncStatus(): GithubSyncStatus {
	const credentials = readGithubCredentials();
	const s = state();
	return {
		clientConfigured: githubClientId() !== "",
		account: credentials ? { login: credentials.login } : null,
		...githubLoginStatus(),
		settings: currentConfig(),
		dataDir: PATHS.data,
		running: s.running !== null,
		last: s.last,
	};
}

// Boot (like keys.ts's initAuthEnv): the server barrel imports this module
// on the first API request. Tests drive ticks explicitly instead.
if (process.env.NODE_ENV !== "test") startGithubSyncScheduler();
