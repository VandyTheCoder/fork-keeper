# Changelog

## v1.0.0 — 2026-10-01

First release.

- Keeps every branch and tag of a fork in step with its upstream through the
  GitHub REST API: no clone, and the token only ever travels in an
  `Authorization` header.
- New upstream branches and tags are created in the fork; branches that moved
  forward are fast-forwarded (GitHub enforces `force: false`).
- When the upstream force-pushes or rewrites history — including a full
  rewrite with no common ancestor — the fork's previous state is saved in a
  dated backup branch first, and only then is the branch force-synced.
- Moved upstream tags are never overwritten; branches and tags deleted
  upstream are kept in the fork.
- Inputs `token`, `repository`, `branches`, `tags`, `backup-branch-pattern`,
  `timezone`, `dry-run`; outputs `changed`, `rewritten`, `summary`.
- At most 400 writes per run, one second apart; rate limits end a run early
  with a warning and the next run continues.
- Plain-English errors for expired tokens, missing access, a fork with no
  upstream, and GitHub outages.
