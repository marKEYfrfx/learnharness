"use client";
/**
 * Settings → Sync (docs/github-sync.md): back up the data folder to a
 * private GitHub repo. Three blocks:
 *  - Account: device-flow sign-in (code + github.com/login/device link while
 *    pending; the status poll picks up the account when GitHub confirms).
 *  - Repository: owner/name of an EMPTY private repo the user created
 *    (owner decision) — saved on blur/Enter through the dialog's write seam.
 *  - Sync: the automatic toggle (5-minute checks) + "Sync now" + the last
 *    result line.
 *
 * Talks to /api/github-sync* for status/actions; config rides the settings
 * record (PUT /api/settings/githubSync via `onSectionChange`).
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { GITHUB_SYNC_INTERVAL_MS, parseRepoSlug, type GithubSyncRun, type GithubSyncSettings, type GithubSyncStatus } from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

const POLL_MS = 2000;

async function readJSON<T>(res: Response): Promise<T & { error?: string }> {
	return (await res.json().catch(() => ({}))) as T & { error?: string };
}

/** "12:31" today, "Oct 30, 12:31" otherwise. */
function when(iso: string): string {
	const d = new Date(iso);
	const sameDay = d.toDateString() === new Date().toDateString();
	return sameDay
		? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function lastRunText(run: GithubSyncRun | null): string {
	if (!run) return "Not synced yet.";
	if (!run.ok) return `${when(run.at)} — ${run.error ?? "Sync failed."}`;
	if (run.pushed) return `Synced ${when(run.at)}${run.committed ? ` · commit ${run.committed}` : ""}.`;
	return `Checked ${when(run.at)} — already up to date.`;
}

export function GithubSyncSection({
	section,
	onSectionChange,
	initialStatus = null,
}: {
	section: GithubSyncSettings | undefined;
	onSectionChange: (next: GithubSyncSettings) => Promise<void> | void;
	/** SSR/test seam: render with a status instead of fetching first. */
	initialStatus?: GithubSyncStatus | null;
}) {
	const [status, setStatus] = useState<GithubSyncStatus | null>(initialStatus);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [draft, setDraft] = useState(section?.repo ?? "");
	useEffect(() => setDraft(section?.repo ?? ""), [section?.repo]);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/github-sync");
			if (res.ok) setStatus((await readJSON<{ status: GithubSyncStatus }>(res)).status);
		} catch {
			/* keep the last status; the next poll retries */
		}
	}, []);
	useEffect(() => void refresh(), [refresh]);

	// Poll only while something is in motion (a pending sign-in or a run).
	const moving = Boolean(status?.pendingLogin || status?.running);
	useEffect(() => {
		if (!moving) return;
		const id = setInterval(() => void refresh(), POLL_MS);
		return () => clearInterval(id);
	}, [moving, refresh]);

	const act = async (input: string, init: RequestInit) => {
		setActionError(null);
		setBusy(true);
		try {
			const res = await fetch(input, init);
			const body = await readJSON<{ status?: GithubSyncStatus }>(res);
			if (!res.ok) setActionError(body.error ?? `Request failed (${res.status}).`);
			if (body.status) setStatus(body.status);
			else await refresh();
		} catch {
			setActionError("Couldn't reach the app server.");
		} finally {
			setBusy(false);
		}
	};
	const signIn = () => act("/api/github-sync/login", { method: "POST" });
	const signOut = () => act("/api/github-sync/login", { method: "DELETE" });
	const cancel = () => act("/api/github-sync/login?pending=1", { method: "DELETE" });
	const syncNow = () => act("/api/github-sync", { method: "POST" });

	const saveRepo = () => {
		const trimmed = draft.trim();
		const slug = trimmed ? parseRepoSlug(trimmed) : "";
		if (slug === null) {
			setActionError("Repository must look like owner/name (or a github.com URL).");
			return;
		}
		setActionError(null);
		if (slug === (section?.repo ?? "")) return setDraft(slug);
		setDraft(slug);
		const next: GithubSyncSettings = { ...section };
		if (slug) next.repo = slug;
		else delete next.repo;
		if (!slug) delete next.enabled; // no repo → nothing to sync automatically
		void Promise.resolve(onSectionChange(next)).then(refresh);
	};

	const setEnabled = (on: boolean) => {
		void Promise.resolve(onSectionChange({ ...section, enabled: on })).then(async () => {
			if (on) await syncNow(); // first sync right away, not in 5 minutes
			else await refresh();
		});
	};

	if (!status) return <p className="text-xs text-muted-foreground/70">Loading sync status…</p>;

	const signedIn = status.account !== null;
	const repo = section?.repo ?? "";
	const ready = signedIn && repo !== "";
	const running = status.running || busy;
	const minutes = Math.round(GITHUB_SYNC_INTERVAL_MS / 60000);

	return (
		<>
			<SettingsGroup label="Account" testid="sync-account">
				<SettingsRow
					label="GitHub"
					testid="row-github-account"
					hint={
						!status.clientConfigured ? (
							"Sign-in isn't configured in this build (no GitHub OAuth client ID)."
						) : status.pendingLogin ? (
							<span data-testid="github-pending">
								Enter <span className="font-mono text-foreground">{status.pendingLogin.userCode}</span> at{" "}
								<a href={status.pendingLogin.verificationUri} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
									{status.pendingLogin.verificationUri.replace(/^https:\/\//, "")} ↗
								</a>
							</span>
						) : signedIn ? (
							<span data-testid="github-account">
								Signed in as @{status.account!.login} ·{" "}
								<a href="https://github.com/settings/applications" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
									Manage access ↗
								</a>
							</span>
						) : (
							status.loginError ?? "Sign in to push this app's data to a private repo you own."
						)
					}
				>
					{status.clientConfigured && (status.pendingLogin ? (
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="github-cancel" disabled={busy} onClick={() => void cancel()}>
							Cancel
						</Button>
					) : signedIn ? (
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="github-sign-out" disabled={busy} onClick={() => void signOut()}>
							Sign out
						</Button>
					) : (
						<Button type="button" size="xs" className="cursor-pointer" data-testid="github-sign-in" disabled={busy} onClick={() => void signIn()}>
							Sign in with GitHub
						</Button>
					))}
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="Repository" testid="sync-repo">
				<SettingsRow label="Repository" hint="An empty private repo you created on GitHub, as owner/name." testid="row-github-repo">
					<input
						type="text"
						value={draft}
						spellCheck={false}
						placeholder="owner/name"
						aria-label="GitHub repository"
						data-testid="github-repo-input"
						onChange={(e) => setDraft(e.target.value)}
						onBlur={saveRepo}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								saveRepo();
							}
						}}
						className="h-7 w-56 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="Sync" testid="sync-run">
				<SettingsRow
					label="Sync automatically"
					hint={`Checks every ${minutes} minutes and pushes when something changed.`}
					testid="row-github-auto"
					dimmed={!ready}
				>
					<Toggle checked={status.settings.enabled} disabled={!ready} label="github auto sync" onChange={setEnabled} />
				</SettingsRow>
				<SettingsRow
					label="Sync now"
					testid="row-github-now"
					dimmed={!ready}
					hint={<span role="status" data-testid="github-last-run">{lastRunText(status.last)}</span>}
				>
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer disabled:cursor-not-allowed"
						data-testid="github-sync-now"
						disabled={!ready || running}
						aria-busy={running}
						onClick={() => void syncNow()}
					>
						{running && <BrailleSpinner label="Syncing" />}
						Sync now
					</Button>
				</SettingsRow>
				{actionError && (
					<p role="alert" className="text-xs text-red-500" data-testid="github-sync-error">
						{actionError}
					</p>
				)}
				<p className="text-xs text-muted-foreground/70" data-testid="github-sync-folder">
					Tracks <span className="font-mono">{status.dataDir}</span> as a git repository. API keys and the GitHub sign-in are stored outside it and never pushed. Push-only: sync never overwrites commits already on GitHub.
				</p>
			</SettingsGroup>
		</>
	);
}
