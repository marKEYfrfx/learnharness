/**
 * GitHub sync of the data folder (docs/github-sync.md).
 *
 *   GET  → 200 {status} — GithubSyncStatus (account login, pending
 *          device-flow code, resolved settings, last run). Never the token.
 *   POST → "Sync now": 200 {run, status}. A run already in flight is
 *          joined, not duplicated. A refused run (not signed in / no repo)
 *          is still 200 with run.ok=false — the line renders as-is.
 *
 * Config (enabled, repo) writes go through PUT /api/settings/githubSync.
 */

import { githubSyncStatus, syncDataFolderNow } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ status: githubSyncStatus() });
}

export async function POST() {
	const run = await syncDataFolderNow();
	return Response.json({ run, status: githubSyncStatus() });
}
