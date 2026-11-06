/**
 * GitHub sign-in for data-folder sync — the OAuth device flow
 * (docs/github-sync.md, src/server/github-oauth.ts).
 *
 *   POST   → start (or restart) a sign-in: 200 {userCode, verificationUri,
 *            expiresAt}; the server polls GitHub in the background and the
 *            client watches GET /api/github-sync for the account to appear.
 *            503 {error} when no OAuth client ID is configured; 502 {error}
 *            when GitHub refuses or can't be reached.
 *   DELETE → sign out (deletes the saved token, cancels a pending flow):
 *            200 {status}. `?pending=1` cancels only the pending flow.
 */

import { GithubLoginError, cancelGithubLogin, githubSyncStatus, signOutGithub, startGithubLogin } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	try {
		return Response.json(await startGithubLogin());
	} catch (error) {
		const message = error instanceof GithubLoginError ? error.message : "Couldn't start GitHub sign-in.";
		const status = message.startsWith("GitHub sign-in isn't configured") ? 503 : 502;
		return Response.json({ error: message }, { status });
	}
}

export async function DELETE(request: Request) {
	if (new URL(request.url).searchParams.get("pending") === "1") cancelGithubLogin();
	else signOutGithub();
	return Response.json({ status: githubSyncStatus() });
}
