import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../src/github.js';
import { FatalError } from '../../src/errors.js';
import { compareBranches, resolve } from '../../src/sync.js';
import { createFakeGitHub } from '../helpers/fake-github.js';
import { fakeClock } from '../helpers/clock.js';

function setup() {
  const gh = createFakeGitHub();
  const clock = fakeClock();
  return { gh, client: createClient({ token: 't', fetch: gh.fetch, now: clock.now, sleep: clock.sleep }) };
}

const fatalWith = (message) => (err) => err instanceof FatalError && err.message === message;

test('resolve reads the upstream from the fork\'s parent and lists both repos\' refs', async () => {
  const { gh, client } = setup();
  const c1 = gh.commit();
  const c2 = gh.commit([c1]);
  gh.setRef('org/a', 'refs/heads/main', c2);
  gh.setRef('org/a', 'refs/heads/feature/x', c1);
  const t1 = gh.tag('org/a', 'v1', c1, { annotated: true });
  gh.setRef('me/b', 'refs/heads/main', c1);

  const ctx = await resolve(client, 'me/b');
  assert.equal(ctx.fork, 'me/b');
  assert.equal(ctx.upstream, 'org/a');
  assert.equal(ctx.defaultBranch, 'main');
  assert.deepEqual([...ctx.upstreamBranches], [['main', c2], ['feature/x', c1]]);
  assert.deepEqual([...ctx.upstreamTags], [['v1', t1]]);
  assert.deepEqual([...ctx.forkBranches], [['main', c1]]);
  assert.deepEqual([...ctx.forkTags], []);
});

test('resolve: a fork that is not a fork is fatal', async () => {
  const { gh, client } = setup();
  gh.repoMeta['me/b'].fork = false;
  await assert.rejects(resolve(client, 'me/b'), fatalWith('`me/b` is not a fork; nothing to mirror.'));
});

test('resolve: a fork with no parent means the upstream is gone', async () => {
  const { gh, client } = setup();
  delete gh.repoMeta['me/b'].parent;
  await assert.rejects(resolve(client, 'me/b'),
    fatalWith('Upstream no longer reachable — `me/b` is now the only copy; nothing changed.'));
});

test('resolve: 401 means the token is invalid or expired', async () => {
  const { gh, client } = setup();
  gh.fail('GET', /^\/repos\/me\/b$/, { status: 401, body: { message: 'Bad credentials' } });
  await assert.rejects(resolve(client, 'me/b'),
    fatalWith('Token invalid or expired — rotate the secret passed as `token`.'));
});

test('resolve: 404 on the fork means the token cannot reach it', async () => {
  const { client } = setup();
  await assert.rejects(resolve(client, 'me/missing'), fatalWith(
    'Token can\'t reach `me/missing` — add it to the PAT\'s repository access with Contents + Workflows: Read and write.'));
});

test('resolve: an unreadable upstream is fatal and changes nothing', async () => {
  const { gh, client } = setup();
  gh.fail('GET', /^\/repos\/org\/a\/git\/matching-refs/, { status: 404, body: { message: 'Not Found' } });
  await assert.rejects(resolve(client, 'me/b'),
    fatalWith('Upstream no longer reachable — `me/b` is now the only copy; nothing changed.'));
  assert.equal(gh.requests.filter((r) => r.method !== 'GET').length, 0);
});

test('resolve: 403 on the fork\'s own ref listing means the token cannot reach it', async () => {
  const { gh, client } = setup();
  gh.fail('GET', /^\/repos\/me\/b\/git\/matching-refs\/heads$/, { status: 403, body: { message: 'Resource not accessible by personal access token' } });
  await assert.rejects(resolve(client, 'me/b'), fatalWith(
    'Token can\'t reach `me/b` — add it to the PAT\'s repository access with Contents + Workflows: Read and write.'));
});

test('resolve: an empty repository (409) has no refs', async () => {
  const { gh, client } = setup();
  gh.fail('GET', /^\/repos\/me\/b\/git\/matching-refs\/tags$/, { status: 409, body: { message: 'Git Repository is empty.' } });
  const ctx = await resolve(client, 'me/b');
  assert.equal(ctx.forkTags.size, 0);
});

test('compareBranches maps status, counts and merge base', async () => {
  const { gh, client } = setup();
  const base = gh.commit();
  const forkHead = gh.commit([base]);
  const upHead = gh.commit([base]);
  const ahead = gh.commit([forkHead]);
  const result = await compareBranches(client, 'me/b', [
    { name: 'main', from: forkHead, to: upHead },
    { name: 'dev', from: forkHead, to: ahead },
  ]);
  assert.deepEqual(result.get('main'), { status: 'diverged', aheadBy: 1, behindBy: 1, mergeBase: base });
  assert.deepEqual(result.get('dev'), { status: 'ahead', aheadBy: 1, behindBy: 0, mergeBase: forkHead });
  assert.ok(gh.requests.some((r) => r.path === `/repos/me/b/compare/${forkHead}...${upHead}?per_page=1`));
});

test('compareBranches records a GitHub error against that branch', async () => {
  const { client } = setup();
  const result = await compareBranches(client, 'me/b', [{ name: 'main', from: 'dead', to: 'beef' }]);
  assert.deepEqual(result.get('main'), { error: 'compare failed: 404 Not Found' });
});
