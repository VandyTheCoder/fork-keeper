import { FatalError, PartialStop } from './errors.js';
import { GitHubError, isWorkflowPermissionError, refPath } from './github.js';
import { backupCommitMessage } from './message.js';
import { MAX_BACKUP_SUFFIX, pickFreeBackupName, renderBackupName } from './refname.js';

export const MESSAGES = {
  auth: 'Token invalid or expired — rotate the secret passed as `token`.',
  noAccess: (fork, detail) => `Token can't reach \`${fork}\` — it needs write access to the fork (fine-grained token: `
    + 'Contents + Workflows: Read and write; classic token: repo + workflow scopes, SSO-authorised if the org '
    + `enforces SSO). GitHub said: ${detail}`,
  notFork: (fork) => `\`${fork}\` is not a fork; nothing to mirror.`,
  noParent: (fork) => `Upstream unreachable — \`${fork}\` no longer has a parent repository (the upstream was `
    + 'deleted or detached). Nothing changed.',
  upstreamUnreachable: (fork, upstream, detail) => `Upstream \`${upstream}\` is unreachable — it was deleted, or `
    + `this token lost read access to it. Nothing changed in \`${fork}\`. GitHub said: ${detail}`,
};

const isStatus = (err, ...statuses) => err instanceof GitHubError && statuses.includes(err.status);

async function listRefs(client, repo, kind) {
  let refs;
  try {
    refs = await client.paginate(`/repos/${repo}/git/matching-refs/${kind}`);
  } catch (err) {
    if (isStatus(err, 409)) return new Map(); // empty repository
    throw err;
  }
  const prefix = `refs/${kind}/`;
  return new Map(refs.filter((r) => r.ref.startsWith(prefix)).map((r) => [r.ref.slice(prefix.length), r.object.sha]));
}

const detailOf = (err) => `${err.status} ${err.message}`;

export async function resolve(client, fork) {
  let repo;
  try {
    repo = await client.request('GET', `/repos/${fork}`);
  } catch (err) {
    if (isStatus(err, 401)) throw new FatalError(MESSAGES.auth);
    if (isStatus(err, 403, 404)) throw new FatalError(MESSAGES.noAccess(fork, detailOf(err)));
    throw err;
  }
  if (!repo.fork) throw new FatalError(MESSAGES.notFork(fork));
  const upstream = repo.parent?.full_name;
  if (!upstream) throw new FatalError(MESSAGES.noParent(fork));

  let upstreamBranches;
  let upstreamTags;
  try {
    upstreamBranches = await listRefs(client, upstream, 'heads');
    upstreamTags = await listRefs(client, upstream, 'tags');
  } catch (err) {
    if (isStatus(err, 403, 404)) throw new FatalError(MESSAGES.upstreamUnreachable(fork, upstream, detailOf(err)));
    throw err;
  }
  let forkBranches;
  let forkTags;
  try {
    forkBranches = await listRefs(client, fork, 'heads');
    forkTags = await listRefs(client, fork, 'tags');
  } catch (err) {
    if (isStatus(err, 403, 404)) throw new FatalError(MESSAGES.noAccess(fork, detailOf(err)));
    throw err;
  }

  return { fork, upstream, defaultBranch: repo.parent.default_branch, upstreamBranches, upstreamTags, forkBranches, forkTags };
}

export async function compareBranches(client, fork, pairs) {
  const comparisons = new Map();
  for (const { name, from, to } of pairs) {
    try {
      const c = await client.request('GET', `/repos/${fork}/compare/${from}...${to}?per_page=1`);
      comparisons.set(name, {
        status: c.status,
        aheadBy: c.ahead_by,
        behindBy: c.behind_by,
        mergeBase: c.merge_base_commit?.sha ?? null,
      });
    } catch (err) {
      if (err instanceof PartialStop || !(err instanceof GitHubError)) throw err;
      if (err.status === 404 && /no common ancestor/i.test(err.message)) {
        comparisons.set(name, { status: 'diverged', aheadBy: null, behindBy: null, mergeBase: null });
        continue;
      }
      comparisons.set(name, { error: `compare failed: ${err.status} ${err.message}` });
    }
  }
  return comparisons;
}

const WRITES_PER_BACKUP = 3; // backup commit, backup ref, forced update
const WRITES_FOR_REF_AND_FORCE = 2; // backup ref + forced update

function describeWriteError(err) {
  if (isWorkflowPermissionError(err)) return 'PAT lacks Workflows: Read and write';
  if (err.status === 401) return MESSAGES.auth;
  if (err.status === 403) return 'Token cannot write to the fork — it needs Contents: Read and write (fine-grained) or the repo scope (classic)';
  return `GitHub ${err.status}: ${err.message}`;
}

async function attempt(op, call, explain = () => null) {
  try {
    await call();
    return { ...op, status: 'done' };
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    return { ...op, status: 'error', error: explain(err) ?? describeWriteError(err) };
  }
}

async function createBackupRef(client, fork, base, sha, taken) {
  for (;;) {
    const name = pickFreeBackupName(base, taken);
    if (!name) return null;
    if (client.writesRemaining() < WRITES_FOR_REF_AND_FORCE) throw new PartialStop('write-budget');
    try {
      await client.request('POST', `/repos/${fork}/git/refs`, { ref: `refs/heads/${name}`, sha });
      taken.add(name);
      return name;
    } catch (err) {
      if (isStatus(err, 422) && /already exists/i.test(err.message)) {
        taken.add(name);
        continue;
      }
      throw err;
    }
  }
}

// Hard rule: the forced update is only sent after the backup ref exists.
async function backupThenForce(client, ctx, op, options, taken) {
  const { fork, upstream } = ctx;
  const base = renderBackupName(options.pattern, { branch: op.name, date: options.date });
  if (options.dryRun) return { ...op, status: 'planned', backupName: pickFreeBackupName(base, taken) ?? base };
  if (client.writesRemaining() < WRITES_PER_BACKUP) throw new PartialStop('write-budget');

  let backupName;
  try {
    const old = await client.request('GET', `/repos/${fork}/git/commits/${op.from}`);
    const message = backupCommitMessage({
      branch: op.name, upstream, fork, from: op.from, to: op.to,
      mergeBase: op.comparison.mergeBase, behindBy: op.comparison.behindBy,
      detectedAt: options.detectedAt, timeZone: options.timeZone, runUrl: options.runUrl,
    });
    const commit = await client.request('POST', `/repos/${fork}/git/commits`, { message, tree: old.tree.sha, parents: [op.from] });
    backupName = await createBackupRef(client, fork, base, commit.sha, taken);
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    return { ...op, status: 'error', error: `backup failed, force skipped: ${describeWriteError(err)}` };
  }
  if (!backupName) {
    return { ...op, status: 'error', error: `no free backup branch name (${base} … -${MAX_BACKUP_SUFFIX}); force skipped` };
  }

  try {
    await client.request('PATCH', `/repos/${fork}/git/refs/${refPath(`heads/${op.name}`)}`, { sha: op.to, force: true });
  } catch (err) {
    if (err instanceof PartialStop) {
      err.result = { ...op, status: 'skipped', backupName, error: `backup ${backupName} created, but force-sync not sent: ${err.message}` };
      throw err;
    }
    if (!(err instanceof GitHubError)) throw err;
    return { ...op, status: 'error', backupName, error: `backup ${backupName} created, but force-sync failed: ${describeWriteError(err)}` };
  }
  return { ...op, status: 'done', backupName };
}

// A CREATE can 422 "already exists" if another run (or a stale plan) got there first.
// That is only a no-op, not an error, when the existing ref already points at op.to.
async function createRef(client, fork, op) {
  const kind = op.kind === 'tag' ? 'tags' : 'heads';
  try {
    await client.request('POST', `/repos/${fork}/git/refs`, { ref: `refs/${kind}/${op.name}`, sha: op.to });
    return { ...op, status: 'done' };
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    if (err.status === 422 && /already exists/i.test(err.message)) {
      const existing = await client.request('GET', `/repos/${fork}/git/ref/${refPath(`${kind}/${op.name}`)}`);
      if (existing.object.sha === op.to) return { ...op, status: 'done' };
    }
    return { ...op, status: 'error', error: describeWriteError(err) };
  }
}

async function applyOne(client, ctx, op, options, taken) {
  const { fork } = ctx;
  switch (op.outcome) {
    case 'up-to-date':
    case 'retained':
    case 'tag-moved':
      return { ...op, status: 'done' };
    case 'error':
      return { ...op, status: 'error' };
    case 'create': {
      if (options.dryRun) return { ...op, status: 'planned' };
      return createRef(client, fork, op);
    }
    case 'fast-forward': {
      if (options.dryRun) return { ...op, status: 'planned' };
      return attempt(
        op,
        () => client.request('PATCH', `/repos/${fork}/git/refs/${refPath(`heads/${op.name}`)}`, { sha: op.to, force: false }),
        (err) => (err.status === 422 && /fast.?forward/i.test(err.message) ? 'fork changed during run; retried next run' : null),
      );
    }
    case 'backup-force':
      return backupThenForce(client, ctx, op, options, taken);
    default:
      throw new Error(`apply: unknown outcome "${op.outcome}"`);
  }
}

export async function apply(client, ctx, ops, options) {
  const taken = new Set(ctx.forkBranches.keys());
  const results = [];
  let stop = null;
  for (const op of ops) {
    if (stop) {
      results.push({ ...op, status: 'skipped', error: stop.message });
      continue;
    }
    try {
      results.push(await applyOne(client, ctx, op, options, taken));
    } catch (err) {
      if (!(err instanceof PartialStop)) throw err;
      stop = err;
      results.push(err.result ?? { ...op, status: 'skipped', error: err.message });
    }
  }
  return { results, partial: stop !== null };
}
