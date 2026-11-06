/**
 * The GitHub sync credentials file (docs/github-sync.md): the OAuth token
 * the device flow minted plus the account it belongs to, at
 * config.GITHUB_SYNC_CREDENTIALS_FILE — BESIDE auth.json, never inside the
 * data folder that gets pushed. Same write discipline as store/auth.ts:
 * 0600, tmp-in-same-dir + rename (a partial write never leaves a relaxed
 * mode or a truncated file).
 *
 * The server's GitHub modules are the only readers/writers; no API ever
 * returns the token.
 */

import fs from "node:fs";
import path from "node:path";
import { GITHUB_SYNC_CREDENTIALS_FILE } from "../../config.ts";

export interface GithubCredentials {
	/** The OAuth access token (device flow, `repo` scope). */
	token: string;
	/** GitHub login (display + commit author name). */
	login: string;
	/** GitHub numeric user id (the noreply commit email). */
	id: number;
	/** Scopes GitHub granted, as reported by the token response. */
	scope: string;
	/** ISO time the token was saved. */
	savedAt: string;
}

function isCredentials(raw: unknown): raw is GithubCredentials {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const r = raw as Record<string, unknown>;
	return typeof r.token === "string" && r.token.length > 0
		&& typeof r.login === "string"
		&& typeof r.id === "number"
		&& typeof r.scope === "string"
		&& typeof r.savedAt === "string";
}

/** The saved credentials, or null when absent/corrupt (= signed out). */
export function readGithubCredentials(): GithubCredentials | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(GITHUB_SYNC_CREDENTIALS_FILE, "utf-8"));
		return isCredentials(raw) ? raw : null;
	} catch {
		return null;
	}
}

export function writeGithubCredentials(credentials: GithubCredentials): void {
	const dir = path.dirname(GITHUB_SYNC_CREDENTIALS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.github-sync-credentials.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(credentials, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, GITHUB_SYNC_CREDENTIALS_FILE);
}

/** Sign out. Absent = silent success (idempotent). */
export function deleteGithubCredentials(): void {
	fs.rmSync(GITHUB_SYNC_CREDENTIALS_FILE, { force: true });
}
