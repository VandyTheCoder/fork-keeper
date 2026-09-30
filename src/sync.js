import { FatalError, PartialStop } from './errors.js';
import { GitHubError } from './github.js';

export const MESSAGES = {
  auth: 'Token invalid or expired — rotate the secret passed as `token`.',
  noAccess: (fork) => `Token can't reach \`${fork}\` — add it to the PAT's repository access with Contents + Workflows: Read and write.`,
  notFork: (fork) => `\`${fork}\` is not a fork; nothing to mirror.`,
  upstreamGone: (fork) => `Upstream no longer reachable — \`${fork}\` is now the only copy; nothing changed.`,
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

export async function resolve(client, fork) {
  let repo;
  try {
    repo = await client.request('GET', `/repos/${fork}`);
  } catch (err) {
    if (isStatus(err, 401)) throw new FatalError(MESSAGES.auth);
    if (isStatus(err, 403, 404)) throw new FatalError(MESSAGES.noAccess(fork));
    throw err;
  }
  if (!repo.fork) throw new FatalError(MESSAGES.notFork(fork));
  const upstream = repo.parent?.full_name;
  if (!upstream) throw new FatalError(MESSAGES.upstreamGone(fork));

  let upstreamBranches;
  let upstreamTags;
  try {
    upstreamBranches = await listRefs(client, upstream, 'heads');
    upstreamTags = await listRefs(client, upstream, 'tags');
  } catch (err) {
    if (isStatus(err, 403, 404)) throw new FatalError(MESSAGES.upstreamGone(fork));
    throw err;
  }
  let forkBranches;
  let forkTags;
  try {
    forkBranches = await listRefs(client, fork, 'heads');
    forkTags = await listRefs(client, fork, 'tags');
  } catch (err) {
    if (isStatus(err, 403, 404)) throw new FatalError(MESSAGES.noAccess(fork));
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
      comparisons.set(name, { error: `compare failed: ${err.status} ${err.message}` });
    }
  }
  return comparisons;
}
