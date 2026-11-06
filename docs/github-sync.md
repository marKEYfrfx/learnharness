# GitHub sync — plan

Back up the data folder (`LH_DATA_DIR`; see `config.ts`) by tracking it as a
git repository and pushing it to a private GitHub repo the user owns.

## Decisions (owner, 2026-10-31)

| Question | Decision |
|---|---|
| Authentication | **OAuth device flow** ("Sign in with GitHub" → code → github.com/login/device) |
| Git engine | **isomorphic-git**, bundled npm dependency — no system `git` required |
| Timing | **Automatic** background check every few minutes **plus** a "Sync now" button |
| Repo setup | **User creates** an empty private repo on GitHub and pastes `owner/name` |

Implementation calls made inside those decisions (flag any you want changed):

- **OAuth App, `repo` scope.** An OAuth App is the plain device-flow client;
  pushing to a *private* repo needs the `repo` scope (GitHub has no narrower
  OAuth scope). A GitHub App would allow per-repo access but issues 8-hour
  expiring tokens with refresh — more moving parts, deferred.
- **Client ID** lives in `config.ts` as `GITHUB_OAUTH_CLIENT_ID`, overridable
  with `LH_GITHUB_CLIENT_ID`. A device-flow client ID is public (no client
  secret is involved), so it is safe to commit. Until it is filled in, the
  Settings section says sign-in isn't configured.
- **Push-only.** No pull/merge/restore in v1. One machine per repo. If the
  remote has commits the local folder lacks, the push is rejected and the
  status says so — never a force-push.
- **Branch `main`**, fixed. **Interval 5 minutes**, fixed (no knobs).
- **Off by default.** Nothing in the data folder changes until the user turns
  sync on.

## Where things live

| What | Where | Why |
|---|---|---|
| Sync config (`enabled`, `repo`) | `settings.json` → new `githubSync` section | Non-secret product preference; house settings record (delta, sanitized, section PUT) |
| OAuth token + GitHub login | `github-sync-credentials.json` **beside `auth.json`** (userData in the desktop app, repo root in dev), mode 0600 | Secret — must never be inside the folder being pushed, and must not show up as a generic row in Settings → Providers (which every unknown `auth.json` var does) |
| The git repository | `<data dir>/.git` | "Track the data folder as a repo" |
| Ignore rules | `<data dir>/.gitignore`, written on first sync | Keeps `debug/` (raw provider recordings) and atomic-write temp files (`*.tmp-*`, `*.tmp`) out |
| Runtime status (last result, in-flight flags, pending device code) | Memory, anchored on `globalThis` (HMR-stable, extraction-registry precedent) | Ephemeral |

## Pieces

**Core (pure, browser-safe)** — `src/core/github-sync.ts`
- `GithubSyncSettings` type, `parseRepoSlug()` (accepts `owner/name`,
  `https://github.com/owner/name`, `.git` suffix), constants (branch,
  interval, `.gitignore` body), the status DTO type, and the pure
  status-matrix → {add, remove} classifier + commit-message builder.
- `src/core/settings.ts`: `githubSync?` on `UserSettings` + sanitizer.

**Store** — `src/store/github-credentials.ts`
- read / write (tmp + rename, 0600, same discipline as `src/store/auth.ts`) /
  delete of `{ token, login, id, scope, savedAt }`.

**Server**
- `src/server/github-oauth.ts` — device flow: `POST github.com/login/device/code`
  → user code + verification URL; background poll of
  `POST github.com/login/oauth/access_token` honoring `interval`,
  `slow_down`, `expired_token`, `access_denied`; on success `GET api.github.com/user`
  for login/id, then save credentials. `fetch` injectable for tests.
- `src/server/github-sync.ts` — the engine (isomorphic-git):
  1. ensure repo: `init` (default branch `main`) if no `.git`, write `.gitignore`,
     set `remote.origin.url` to `https://github.com/<repo>.git`;
  2. stage: `statusMatrix` → `add` new/modified, `remove` deleted;
  3. commit if anything changed (author = GitHub login,
     `<id>+<login>@users.noreply.github.com`);
  4. push `main` if HEAD ≠ `refs/remotes/origin/main` (retries an earlier
     failed push even with no new changes), auth via `onAuth` with the token;
  5. map errors to plain lines (token rejected → sign in again; 404 → repo not
     found / no access; non-fast-forward → remote has other commits, use an
     empty repo).
  - One in-flight run at a time (promise mutex); "Sync now" while a run is
    active joins it.
  - Scheduler: `setInterval` every 5 min (unref'd, started once per process
    from the server barrel); each tick re-reads settings + credentials and
    runs only when enabled, signed in, and a repo is set.
- `src/server/settings-body.ts`: `parseGithubSyncSettingsBody` registered in
  `SETTINGS_SECTIONS` (strict shapes; repo must parse as a slug or be empty).

**Routes** (behind the existing `/api` desktop-capability proxy)
- `GET  /api/github-sync` → status DTO (never the token).
- `POST /api/github-sync` → Sync now; returns the run result.
- `POST /api/github-sync/login` → start device flow; returns user code + URL.
- `DELETE /api/github-sync/login` → sign out (deletes credentials file, cancels a pending flow).
- Config writes reuse `PUT /api/settings/githubSync`.

**UI** — `components/settings/github-sync-section.tsx`, new **Sync** entry in
the settings nav:
- Account row: "Sign in with GitHub" → shows the code + link while pending
  (polls status every 2 s) → "Signed in as @login · Sign out".
- Repository input (`owner/name`) saved on blur/Enter.
- "Sync automatically" toggle (disabled until signed in + repo set).
- "Sync now" button + last-result line (time, commit, error).
- Hint line showing the folder being tracked.

**Build safety**
- `.gitignore`, `next.config.ts` `outputFileTracingExcludes`, and the
  `scripts/build-server.mjs` secrets guard all learn
  `github-sync-credentials.json*` (same treatment as the other credential files).

## Tests (`tests/github-sync.test.ts`)
- Pure: slug parsing, settings sanitizer/parser, status-matrix classifier.
- Engine end-to-end against a **local smart-HTTP git server** (`git http-backend`
  behind a Node `http` server, bare repo in a tmp dir; requires the Authorization
  header): first sync inits + pushes; a change → new commit pushed; a deletion
  is committed; no change → no commit; `debug/` and temp files are ignored;
  wrong token → "sign in again" error; diverged remote → rejected, no force.
  Skipped when `git` isn't on PATH.
- Device flow with a fake `fetch`: pending → slow_down → token → credentials saved.

## Setup (one-time, per build)

1. github.com/settings/developers → **New OAuth App**. Any homepage and
   callback URL works (the device flow uses neither). Tick **Enable Device Flow**.
2. Copy the **Client ID** into `GITHUB_OAUTH_CLIENT_ID` in `config.ts`
   (or export `LH_GITHUB_CLIENT_ID` for a dev run). No client secret is needed.
3. In the app: Settings → **Sync** → Sign in with GitHub → enter the code at
   github.com/login/device → paste `owner/name` of an empty private repo →
   **Sync now** (or turn on **Sync automatically**).

## Known limits
- A sync can catch a file mid-write (most writers are atomic tmp+rename; JSONL
  appends are not). The next sync captures the settled state.
- `repo` scope grants access to all of the user's repos — the token stays in a
  0600 file outside the pushed folder and is never returned by any API.
- No restore flow yet: restoring is `git clone` of the repo into a data dir.
- A data folder that already holds a git repo on a branch other than `main`
  is refused (error line), rather than committing to a branch that never pushes.
