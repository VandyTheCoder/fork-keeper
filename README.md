# Fork Keeper

A GitHub Action that keeps a **fork** as a loss-proof backup of its upstream.
Run it on a schedule and every branch and tag in the fork tracks the upstream.
When the upstream force-pushes or rewrites history, the fork first saves its
previous state in a dated backup branch, then follows.

- **No clone, no credentials on disk.** Everything goes through the GitHub REST
  API, with the token only in a request header.
- **Never loses a commit.** GitHub itself enforces fast-forwards
  (`force: false`), and a branch is only force-updated after its backup exists.
- **Zero dependencies.** Plain Node 24; nothing vendored.

## What happens to each ref

| Upstream | Fork | Result |
|---|---|---|
| New branch or tag | missing | **Created** in the fork |
| Same commit | same commit | Nothing to do |
| Moved forward | behind | **Fast-forwarded** |
| Force-pushed or rewritten | old history | **Backed up**, then force-synced |
| Tag moved | old tag | Fork keeps the original tag (warning) |
| Deleted | exists | **Kept** in the fork |

A backup branch such as `backup/main/2026-10-01` holds one empty commit on top
of the fork's old history. Its message records what happened:

```
backup: main before upstream history rewrite

Upstream octo-org/project rewrote `main` (force-push or history rewrite).
fork-keeper preserved you/project's previous `main` here before syncing to it.

Previous main:  3f2a9c1…
New upstream main:  8d41e07…
Common ancestor:  a1b2c3d…
Commits preserved only here:  12
Detected:  2026-10-01 00:04 (Asia/Phnom_Penh)
Run:  https://github.com/you/project/actions/runs/123
```

## Quick start

There are two ways to run fork-keeper on a schedule. Both need a token that can read the
upstream and write to the fork.

### The token

Both kinds of token need **write access to the fork** and **read access to its upstream** —
a fine-grained token whose repository access covers only the fork fails as soon as the
upstream is private, even if the same account owns both.

- **Upstream public, or private and owned by the same account or organisation as the
  fork:** a fine-grained personal access token. Resource owner: the fork's owner.
  Repository access: *Only select repositories* → the fork, **and the upstream too if it's
  private** (a public upstream needs no entry — it's already readable). Permissions on the
  fork: **Contents: Read and write** and **Workflows: Read and write** (upstream workflow
  files are backed up too); on a private upstream, the fine-grained picker's defaults are
  enough since fork-keeper only reads it.
- **Upstream private and owned by someone else:** a fine-grained token can't select a
  repository outside its resource owner, so it can never reach this upstream. Use a classic
  token with the `repo` and `workflow` scopes instead. If the fork's organisation enforces
  SSO, authorise the token for it.

Pick an expiry and put the renewal in your calendar.

### Option 1 — a separate private hub (recommended)

Leaves the fork untouched and can back up several forks from one place. Create a private
repository (GitHub disables scheduled workflows in public repositories after 60 days
without activity), add the token as the secret `FORK_SYNC_TOKEN`, and add
`.github/workflows/backup.yml`:

```yaml
name: Backup forks
on:
  schedule:
    - cron: '0 17 * * *'   # 00:00 in UTC+7 — cron is always UTC
  workflow_dispatch:
permissions: {}
concurrency: { group: fork-sync, cancel-in-progress: false }
jobs:
  backup:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        fork: [you/project]           # one line per fork
    steps:
      - uses: VandyTheCoder/fork-keeper@v1.0.0   # better: pin the release's full commit SHA
        with:
          token: ${{ secrets.FORK_SYNC_TOKEN }}
          repository: ${{ matrix.fork }}
          timezone: Asia/Phnom_Penh
```

### Option 2 — a control branch inside the fork

Scheduled workflows only run from a repository's default branch. A workflow committed to
the fork's `main` would make it differ from upstream, so fork-keeper would back it up and
reset `main` — deleting its own schedule. Keep the workflow on a branch of its own:

1. Start from a fresh clone and create an orphan branch holding only the workflow and a
   README pointing readers to `main`. Add the tracked files with explicit paths — the
   orphan branch still has the fork's other files sitting untracked in the working tree,
   and a bare `git add .` would pull them all in:
   ```sh
   git clone https://github.com/you/project fork-keeper-setup && cd fork-keeper-setup
   git switch --orphan fork-keeper
   mkdir -p .github/workflows    # add sync.yml (below) and a README.md pointing to main
   git add .github README.md
   git commit -m "fork-keeper control branch"
   git push origin fork-keeper
   ```
2. In the fork's settings, make `fork-keeper` the **default branch** and enable Actions
   (GitHub disables them on forks).
3. Add the token as the Actions secret `FORK_SYNC_TOKEN`.

`.github/workflows/sync.yml` on the `fork-keeper` branch:

```yaml
name: Sync from upstream
on:
  schedule:
    - cron: '0 17 * * *'   # 00:00 in UTC+7 — cron is always UTC
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Plan only — write nothing'
        type: boolean
        default: false
permissions: {}
concurrency: { group: fork-sync, cancel-in-progress: false }
jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: VandyTheCoder/fork-keeper@v1.0.0   # better: pin the release's full commit SHA
        with:
          token: ${{ secrets.FORK_SYNC_TOKEN }}
          branches: main
          backup-branch-pattern: backup/{date}
          timezone: Asia/Phnom_Penh
          dry-run: ${{ inputs.dry_run }}
```

`branches: main` keeps the control branch out of the mirror. Note that enabling Actions in
a fork also enables any workflows the upstream has, and they will run on the commits
fork-keeper syncs.

**Security.** Once Actions are enabled in the fork, any workflow the upstream adds runs in
the fork on every sync and can read the fork's secrets; anyone with write access to the
fork can also run a workflow that reads repository secrets. Hardening if you still choose
Option 2: store the token as an **environment** secret whose deployment branches are
limited to `fork-keeper` (private repos need GitHub Pro/Team/Enterprise) and add
`environment: <name>` to the job; protect the `fork-keeper` branch; set the fork's default
`GITHUB_TOKEN` permissions to read-only; issue the token from a dedicated machine user that
can see only the upstream and the fork.

Try either setup first with a dry run (Run workflow, or `dry-run: true`): the job summary
shows what would happen without writing anything.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `token` | *(required)* | Fine-grained PAT with Contents + Workflows write on the fork |
| `repository` | the current repo | The fork (`owner/name`). The upstream is read from GitHub. |
| `branches` | `*` | `*` for every branch, or a newline-separated list of exact names |
| `tags` | `true` | Also back up tags |
| `backup-branch-pattern` | `backup/{branch}/{date}` | Backup branch name. Must contain `{date}`, and `{branch}` when several branches are synced. With `branches: main` you may use `backup/{date}`. |
| `timezone` | `UTC` | IANA zone for `{date}`, e.g. `Asia/Phnom_Penh` |
| `dry-run` | `false` | Plan and report only |

## Outputs

| Output | Meaning |
|---|---|
| `changed` | `true` if any ref in the fork was written |
| `rewritten` | Number of branches backed up and force-synced |
| `summary` | JSON with counts per outcome and every ref that was not already up to date |

Example — alert when history was rewritten:

```yaml
      - id: sync
        uses: VandyTheCoder/fork-keeper@v1.0.0
        with: { token: '${{ secrets.FORK_SYNC_TOKEN }}', repository: you/project }
      - if: always() && steps.sync.outputs.rewritten != '' && steps.sync.outputs.rewritten != '0'
        run: echo "Upstream rewrote history; see the job summary for backup branches."
```

## Good to know

- **Timing.** Scheduled runs use UTC and GitHub may start them some minutes
  late at busy times.
- **First run.** GitHub's fork dialog copies only the default branch by
  default, so the first run may create many branches and tags. Each run makes
  at most 400 writes, one second apart, to stay under GitHub's limits; if there
  is more, the run ends with a warning and the next run continues.
- **Exit status.** The run fails (and GitHub emails you) only when something
  could not be done. Rewrites, moved tags and partial runs pass with a warning.
- **Tags are permanent.** If upstream moves a tag, the fork keeps the original.
- **Deleted upstream branches are kept.** Your backup branches are never
  deleted automatically.

## Limits of a fork as a backup

- If the upstream is **private** and gets deleted, GitHub deletes its forks too.
- Losing access to a private upstream — removed from the org, collaborator access
  revoked — can delete your fork the same way, even though you never touched it.
- A DMCA takedown can disable a whole fork network.
- If the upstream is **public** and is deleted or made private, the fork survives.
- If a private upstream is later **made public**, GitHub detaches its existing forks into
  standalone repositories; fork-keeper's next run then stops with "`<B>` is not a fork;
  nothing to mirror."

## Security

- The token only ever travels in an `Authorization` header.
- Nothing written upstream (commit messages, file names) is printed or copied
  into logs, summaries or backup messages.
- Pin this action by full commit SHA; the release page lists it.

## License

MIT © 2026 Vandy Sodanheang
