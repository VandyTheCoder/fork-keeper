import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../src/github.js';
import { backupCommitMessage } from '../../src/message.js';
import { apply } from '../../src/sync.js';
import { createFakeGitHub } from '../helpers/fake-github.js';
import { fakeClock } from '../helpers/clock.js';

const OPTIONS = {
  dryRun: false, pattern: 'backup/{branch}/{date}', date: '2026-10-01',
  detectedAt: '2026-10-01 00:04', timeZone: 'Asia/Phnom_Penh',
  runUrl: 'https://github.com/me/hub/actions/runs/1',
};

function setup({ maxWrites } = {}) {
  const gh = createFakeGitHub();
  const clock = fakeClock();
  const client = createClient({ token: 't', fetch: gh.fetch, now: clock.now, sleep: clock.sleep, maxWrites });
  const ctx = (forkBranches = new Map()) => ({ fork: 'me/b', upstream: 'org/a', forkBranches });
  const writes = () => gh.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  return { gh, client, ctx, writes };
}

// Upstream rewrote main: both heads descend from `base` but have diverged.
function rewrite(gh) {
  const base = gh.commit();
  const old = gh.commit([base], 'fork head');
  const fresh = gh.commit([base], 'rewritten upstream head');
  gh.setRef('me/b', 'refs/heads/main', old);
  gh.setRef('org/a', 'refs/heads/main', fresh);
  const op = {
    kind: 'branch', name: 'main', from: old, to: fresh, outcome: 'backup-force',
    comparison: { status: 'diverged', aheadBy: 1, behindBy: 1, mergeBase: base },
  };
  return { base, old, fresh, op };
}

test('create writes branch and tag refs at the upstream SHA', async () => {
  const { gh, client, ctx } = setup();
  const c = gh.commit();
  const tagSha = gh.tag('org/a', 'v1', c, { annotated: true });
  const ops = [
    { kind: 'branch', name: 'dev', to: c, outcome: 'create' },
    { kind: 'tag', name: 'v1', to: tagSha, outcome: 'create' },
  ];
  const { results } = await apply(client, ctx(), ops, OPTIONS);
  assert.deepEqual(results.map((r) => r.status), ['done', 'done']);
  assert.equal(gh.getRef('me/b', 'refs/heads/dev'), c);
  assert.equal(gh.getRef('me/b', 'refs/tags/v1'), tagSha);
});

test('fast-forward updates the ref with force: false', async () => {
  const { gh, client, ctx } = setup();
  const c1 = gh.commit();
  const c2 = gh.commit([c1]);
  gh.setRef('me/b', 'refs/heads/main', c1);
  const { results } = await apply(client, ctx(), [{ kind: 'branch', name: 'main', from: c1, to: c2, outcome: 'fast-forward' }], OPTIONS);
  assert.equal(results[0].status, 'done');
  assert.equal(gh.getRef('me/b', 'refs/heads/main'), c2);
  assert.equal(gh.requests.at(-1).body.force, false);
});

test('a rejected fast-forward is reported as a fork change, not forced', async () => {
  const { gh, client, ctx } = setup();
  const c1 = gh.commit();
  const moved = gh.commit([c1]);
  const up = gh.commit([c1]);
  gh.setRef('me/b', 'refs/heads/main', moved); // someone pushed to the fork after planning
  const { results } = await apply(client, ctx(), [{ kind: 'branch', name: 'main', from: c1, to: up, outcome: 'fast-forward' }], OPTIONS);
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].error, 'fork changed during run; retried next run');
  assert.equal(gh.getRef('me/b', 'refs/heads/main'), moved);
});

test('fast-forward handles URL-special branch names', async () => {
  const { gh, client, ctx } = setup();
  const c1 = gh.commit();
  const c2 = gh.commit([c1]);
  gh.setRef('me/b', 'refs/heads/feature/x#1', c1);
  await apply(client, ctx(), [{ kind: 'branch', name: 'feature/x#1', from: c1, to: c2, outcome: 'fast-forward' }], OPTIONS);
  assert.equal(gh.requests.at(-1).path, '/repos/me/b/git/refs/heads/feature/x%231');
  assert.equal(gh.getRef('me/b', 'refs/heads/feature/x#1'), c2);
});

test('backup-force saves the old head in a backup branch, then force-syncs', async () => {
  const { gh, client, ctx, writes } = setup();
  const { base, old, fresh, op } = rewrite(gh);
  const { results, partial } = await apply(client, ctx(new Map([['main', old]])), [op], OPTIONS);

  assert.equal(partial, false);
  assert.equal(results[0].status, 'done');
  assert.equal(results[0].backupName, 'backup/main/2026-10-01');
  const backup = gh.getRef('me/b', 'refs/heads/backup/main/2026-10-01');
  assert.deepEqual(gh.commits.get(backup).parents, [old]);
  assert.equal(gh.commits.get(backup).tree, gh.commits.get(old).tree);
  assert.equal(gh.commits.get(backup).message, backupCommitMessage({
    branch: 'main', upstream: 'org/a', fork: 'me/b', from: old, to: fresh, mergeBase: base, behindBy: 1,
    detectedAt: OPTIONS.detectedAt, timeZone: OPTIONS.timeZone, runUrl: OPTIONS.runUrl,
  }));
  assert.equal(gh.getRef('me/b', 'refs/heads/main'), fresh);
  assert.deepEqual(writes(), [
    'POST /repos/me/b/git/commits',
    'POST /repos/me/b/git/refs',
    'PATCH /repos/me/b/git/refs/heads/main',
  ]);
  assert.equal(gh.requests.at(-1).body.force, true);
});

test('backup names already in the fork get a numeric suffix', async () => {
  const { gh, client, ctx } = setup();
  const { old, op } = rewrite(gh);
  gh.setRef('me/b', 'refs/heads/backup/main/2026-10-01', old);
  const known = new Map([['main', old], ['backup/main/2026-10-01', old]]);
  const { results } = await apply(client, ctx(known), [op], OPTIONS);
  assert.equal(results[0].backupName, 'backup/main/2026-10-01-2');
});

test('a backup name taken since resolve is detected via 422 and skipped', async () => {
  const { gh, client, ctx } = setup();
  const { old, op } = rewrite(gh);
  gh.setRef('me/b', 'refs/heads/backup/main/2026-10-01', old); // not in ctx.forkBranches
  const { results } = await apply(client, ctx(new Map([['main', old]])), [op], OPTIONS);
  assert.equal(results[0].status, 'done');
  assert.equal(results[0].backupName, 'backup/main/2026-10-01-2');
});

test('if the backup cannot be made, the branch is never forced', async () => {
  const { gh, client, ctx, writes } = setup();
  const { old, op } = rewrite(gh);
  gh.fail('POST', /\/git\/commits$/, { status: 500, body: { message: 'boom' } }, { times: 4 });
  const { results } = await apply(client, ctx(new Map([['main', old]])), [op], OPTIONS);
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /^backup failed, force skipped: GitHub 500: boom$/);
  assert.equal(gh.getRef('me/b', 'refs/heads/main'), old);
  assert.ok(!writes().some((w) => w.startsWith('PATCH')));
});

test('a force refused for workflow permission keeps the backup and says so', async () => {
  const { gh, client, ctx } = setup();
  const { old, op } = rewrite(gh);
  gh.fail('PATCH', /\/git\/refs\/heads\/main$/, {
    status: 422,
    body: { message: 'refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope' },
  });
  const { results } = await apply(client, ctx(new Map([['main', old]])), [op], OPTIONS);
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].backupName, 'backup/main/2026-10-01');
  assert.equal(results[0].error, 'backup backup/main/2026-10-01 created, but force-sync failed: PAT lacks Workflows: Read and write');
  assert.ok(gh.getRef('me/b', 'refs/heads/backup/main/2026-10-01'));
});

test('a backup is not started without budget for all three writes', async () => {
  const { gh, client, ctx, writes } = setup({ maxWrites: 2 });
  const { old, op } = rewrite(gh);
  const { results, partial } = await apply(client, ctx(new Map([['main', old]])), [op], OPTIONS);
  assert.equal(partial, true);
  assert.equal(results[0].status, 'skipped');
  assert.deepEqual(writes(), []);
});

test('when the budget runs out, remaining refs are skipped and the run is partial', async () => {
  const { gh, client, ctx } = setup({ maxWrites: 1 });
  const c = gh.commit();
  const ops = [
    { kind: 'branch', name: 'a', to: c, outcome: 'create' },
    { kind: 'branch', name: 'b', to: c, outcome: 'create' },
    { kind: 'branch', name: 'c', to: c, outcome: 'create' },
  ];
  const { results, partial } = await apply(client, ctx(), ops, OPTIONS);
  assert.equal(partial, true);
  assert.deepEqual(results.map((r) => r.status), ['done', 'skipped', 'skipped']);
});

test('dry-run writes nothing and reports the backup name it would use', async () => {
  const { gh, client, ctx, writes } = setup();
  const { old, op } = rewrite(gh);
  const c = gh.commit();
  const ops = [op, { kind: 'branch', name: 'dev', to: c, outcome: 'create' }];
  const { results } = await apply(client, ctx(new Map([['main', old]])), ops, { ...OPTIONS, dryRun: true });
  assert.deepEqual(writes(), []);
  assert.deepEqual(results.map((r) => r.status), ['planned', 'planned']);
  assert.equal(results[0].backupName, 'backup/main/2026-10-01');
});

test('no-write outcomes pass straight through', async () => {
  const { client, ctx, writes } = setup();
  const ops = [
    { kind: 'branch', name: 'a', from: 'x', to: 'x', outcome: 'up-to-date' },
    { kind: 'branch', name: 'b', from: 'x', outcome: 'retained' },
    { kind: 'tag', name: 'v1', from: 'x', to: 'y', outcome: 'tag-moved' },
    { kind: 'branch', name: 'typo', outcome: 'error', error: 'not found upstream or in fork' },
  ];
  const { results } = await apply(client, ctx(), ops, OPTIONS);
  assert.deepEqual(results.map((r) => r.status), ['done', 'done', 'done', 'error']);
  assert.deepEqual(writes(), []);
});
