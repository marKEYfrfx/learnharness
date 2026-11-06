/**
 * GITHUB SYNC — the pure half (docs/github-sync.md, owner 2026-10-31): the
 * data folder (config.PATHS.data, the LH_DATA_DIR seam) is tracked as a git
 * repository and pushed to a private GitHub repo the user created.
 *
 * Browser-safe: types, constants, and pure helpers only — the engine
 * (isomorphic-git), the OAuth device flow and the credentials file live
 * server-side (src/server/github-sync.ts, src/server/github-oauth.ts,
 * src/store/github-credentials.ts).
 *
 * Owner decisions: OAuth device flow · isomorphic-git (no system git) ·
 * automatic interval + "Sync now" · the user creates the repo and pastes
 * owner/name. Implementation calls (flagged in the plan): push-only, branch
 * `main`, 5-minute interval, off by default.
 */

/** The `githubSync` settings section (delta, non-secret). */
export interface GithubSyncSettings {
	/** Automatic background sync. Absent = off (explicit opt-in). */
	enabled?: boolean;
	/** The target repository as "owner/name". Absent/empty = not set. */
	repo?: string;
}

/** The one branch sync commits to and pushes. */
export const GITHUB_SYNC_BRANCH = "main";

/** How often the background check runs (only acts when something changed
 *  or an earlier push is still outstanding). */
export const GITHUB_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** The OAuth scope the device flow requests: pushing to a PRIVATE repo
 *  needs `repo` (GitHub offers no narrower OAuth scope for that). */
export const GITHUB_SYNC_SCOPE = "repo";

/** The data folder's .gitignore, written on first sync (and refreshed when
 *  it no longer matches). `debug/` holds raw provider-stream recordings;
 *  the tmp patterns are the stores' atomic-write scratch files
 *  (`<file>.tmp-<id>` in store/graph.ts + store/auth.ts,
 *  `<file>.<uuid>.tmp` in store/source-organization.ts). */
export const DATA_GITIGNORE = [
	"# Written by LearnHarness GitHub sync — edits are overwritten.",
	"debug/",
	"*.tmp-*",
	"*.tmp",
	"",
].join("\n");

/** GitHub owner/repo name rules (owner: 1–39 alnum/hyphen; repo: alnum,
 *  `.`, `_`, `-`, not `.`/`..`). */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Normalize what the user pasted into "owner/name", or null when it is not
 * a GitHub repository reference. Accepts `owner/name`,
 * `https://github.com/owner/name`, an optional `.git` suffix and trailing
 * slash, and `git@github.com:owner/name.git`.
 */
export function parseRepoSlug(raw: string): string | null {
	let value = raw.trim();
	if (!value) return null;
	const ssh = /^git@github\.com:(.+)$/i.exec(value);
	if (ssh?.[1]) value = ssh[1];
	else if (/^https?:\/\//i.test(value)) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return null;
		}
		if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") return null;
		if (url.search || url.hash || url.username || url.password) return null;
		value = url.pathname.replace(/^\/+/, "");
	}
	value = value.replace(/\/+$/, "").replace(/\.git$/i, "");
	const [owner, name, ...rest] = value.split("/");
	if (owner === undefined || name === undefined || rest.length) return null;
	if (!OWNER_RE.test(owner) || owner.endsWith("-") || owner.includes("--")) return null;
	if (!REPO_RE.test(name) || name === "." || name === "..") return null;
	return `${owner}/${name}`;
}

/** The HTTPS remote URL for a slug (the token rides in onAuth, never in
 *  the URL — the URL lands in .git/config inside the pushed folder). */
export function repoRemoteUrl(slug: string): string {
	return `https://github.com/${slug}.git`;
}

/** Sanitize the stored section: wrong-typed fields drop, the repo is kept
 *  only in normalized form. Never throws. */
export function sanitizeGithubSync(raw: Record<string, unknown>): GithubSyncSettings {
	const out: GithubSyncSettings = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (typeof raw.repo === "string") {
		const slug = parseRepoSlug(raw.repo);
		if (slug) out.repo = slug;
	}
	return out;
}

/** The resolved view: what the scheduler acts on. */
export interface ResolvedGithubSync {
	enabled: boolean;
	repo: string | null;
}

export function resolveGithubSync(section: GithubSyncSettings | undefined): ResolvedGithubSync {
	return { enabled: section?.enabled === true, repo: section?.repo ? parseRepoSlug(section.repo) : null };
}

// ─── Staging (pure) ─────────────────────────────────────────────────────────

/** One isomorphic-git statusMatrix row: [filepath, HEAD, WORKDIR, STAGE]
 *  (0 = absent, 1 = same as HEAD, 2 = differs/present, 3 = differs from
 *  both — see isomorphic-git's statusMatrix docs). */
export type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];

export interface StagePlan {
	/** New or modified in the working tree → `git add`. */
	add: string[];
	/** Gone from the working tree but tracked/staged → `git rm`. */
	remove: string[];
}

/** Turn a status matrix into the adds/removes that make the index match
 *  the working tree exactly (the `git add -A` equivalent). */
export function planStaging(matrix: readonly StatusRow[]): StagePlan {
	const add: string[] = [];
	const remove: string[] = [];
	for (const [filepath, head, workdir, stage] of matrix) {
		if (workdir === 0) {
			if (head !== 0 || stage !== 0) remove.push(filepath);
		} else if (!(head === 1 && workdir === 1 && stage === 1)) {
			// workdir 1 = identical to HEAD; anything else must be (re)staged
			// unless the stage already holds the workdir version (stage 2 with
			// workdir 2 is "added/modified and staged" — re-adding is harmless).
			add.push(filepath);
		}
	}
	return { add, remove };
}

/** Counts for the commit message / status line, from the matrix BEFORE
 *  staging (HEAD vs WORKDIR). */
export function summarizeChanges(matrix: readonly StatusRow[]): { added: number; modified: number; deleted: number } {
	let added = 0;
	let modified = 0;
	let deleted = 0;
	for (const [, head, workdir] of matrix) {
		if (head === 0 && workdir !== 0) added++;
		else if (head === 1 && workdir === 0) deleted++;
		else if (head === 1 && workdir === 2) modified++;
	}
	return { added, modified, deleted };
}

export function syncCommitMessage(counts: { added: number; modified: number; deleted: number }, when: Date): string {
	const parts = [
		counts.added && `${counts.added} added`,
		counts.modified && `${counts.modified} modified`,
		counts.deleted && `${counts.deleted} deleted`,
	].filter(Boolean);
	return `LearnHarness sync ${when.toISOString()}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

// ─── Status DTO (GET /api/github-sync) ──────────────────────────────────────

/** The outcome of one sync run. */
export interface GithubSyncRun {
	/** ISO time the run finished. */
	at: string;
	ok: boolean;
	/** The commit created this run (short oid), if any. */
	committed?: string;
	/** True when the push sent something to GitHub. */
	pushed?: boolean;
	/** Human-readable failure — safe to render as-is. */
	error?: string;
}

/** What the Settings section renders. The token NEVER appears here. */
export interface GithubSyncStatus {
	/** A device-flow client ID is configured (config.GITHUB_OAUTH_CLIENT_ID). */
	clientConfigured: boolean;
	/** The signed-in GitHub account, or null. */
	account: { login: string } | null;
	/** An in-progress device-flow sign-in: show the code + link. */
	pendingLogin: { userCode: string; verificationUri: string; expiresAt: string } | null;
	/** Why the last sign-in attempt ended without a token (denied/expired/…). */
	loginError: string | null;
	settings: ResolvedGithubSync;
	/** The folder being tracked (display only). */
	dataDir: string;
	/** A run is in flight right now. */
	running: boolean;
	last: GithubSyncRun | null;
}
