import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchesToCompare, plan } from '../../src/plan.js';
import { backupNameRegex } from '../../src/refname.js';

const map = (obj = {}) => new Map(Object.entries(obj));
const input = (over = {}) => ({
  upstreamBranches: map(), forkBranches: map(), upstreamTags: map(), forkTags: map(),
  branches: '*', tags: true, defaultBranch: 'main',
  backupRegex: backupNameRegex('backup/{branch}/{date}'), comparisons: map(), ...over,
});
const brief = (ops) => ops.map((o) => `${o.kind}:${o.name}:${o.outcome}`);

test('a branch missing in the fork is created', () => {
  assert.deepEqual(brief(plan(input({ upstreamBranches: map({ dev: 'a1' }) }))), ['branch:dev:create']);
});

test('identical branches are up to date and need no compare call', () => {
  const p = input({ upstreamBranches: map({ main: 'a1' }), forkBranches: map({ main: 'a1' }) });
  assert.deepEqual(branchesToCompare(p), []);
  assert.deepEqual(brief(plan(p)), ['branch:main:up-to-date']);
});

test('only shared branches with different commits are compared', () => {
  const p = input({ upstreamBranches: map({ main: 'a2', dev: 'd1', x: 'x1' }), forkBranches: map({ main: 'a1', dev: 'd1' }) });
  assert.deepEqual(branchesToCompare(p), [{ name: 'main', from: 'a1', to: 'a2' }]);
});

test('compare statuses map to fast-forward or backup-force', () => {
  const p = input({
    upstreamBranches: map({ main: 'a2', b: 'b2', c: 'c2' }),
    forkBranches: map({ main: 'a1', b: 'b1', c: 'c1' }),
    comparisons: new Map([
      ['main', { status: 'ahead', aheadBy: 1, behindBy: 0, mergeBase: 'a1' }],
      ['b', { status: 'behind', aheadBy: 0, behindBy: 2, mergeBase: 'b2' }],
      ['c', { status: 'diverged', aheadBy: 1, behindBy: 1, mergeBase: 'c0' }],
    ]),
  });
  const ops = plan(p);
  assert.deepEqual(brief(ops), ['branch:main:fast-forward', 'branch:b:backup-force', 'branch:c:backup-force']);
  assert.deepEqual(ops[2].comparison, { status: 'diverged', aheadBy: 1, behindBy: 1, mergeBase: 'c0' });
  assert.equal(ops[2].from, 'c1');
  assert.equal(ops[2].to, 'c2');
});

test('a failed compare becomes an error for that branch only', () => {
  const p = input({
    upstreamBranches: map({ main: 'a2' }), forkBranches: map({ main: 'a1' }),
    comparisons: new Map([['main', { error: 'compare failed: 404 Not Found' }]]),
  });
  const [op] = plan(p);
  assert.equal(op.outcome, 'error');
  assert.equal(op.error, 'compare failed: 404 Not Found');
});

test('a missing comparison is a programming error', () => {
  const p = input({ upstreamBranches: map({ main: 'a2' }), forkBranches: map({ main: 'a1' }) });
  assert.throws(() => plan(p), /missing comparison for branch "main"/);
});

test('fork-only branches are retained, except the fork\'s own backup branches', () => {
  const p = input({ forkBranches: map({ old: 'o1', 'backup/main/2026-10-01': 'k1', 'backup/main/2026-10-01-2': 'k2' }) });
  assert.deepEqual(brief(plan(p)), ['branch:old:retained']);
});

test('an upstream branch that looks like a backup name is still mirrored', () => {
  const p = input({ upstreamBranches: map({ 'backup/x/2026-01-01': 'u1' }) });
  assert.deepEqual(brief(plan(p)), ['branch:backup/x/2026-01-01:create']);
});

test('with a branch list, only listed branches are considered', () => {
  const p = input({
    branches: ['main', 'gone', 'typo'],
    upstreamBranches: map({ main: 'a1', other: 'z1' }),
    forkBranches: map({ main: 'a1', gone: 'g1' }),
  });
  const ops = plan(p);
  assert.deepEqual(brief(ops), ['branch:main:up-to-date', 'branch:gone:retained', 'branch:typo:error']);
  assert.equal(ops[2].error, 'not found upstream or in fork');
});

test('tags are created, left alone when moved, and retained when deleted upstream', () => {
  const p = input({
    upstreamTags: map({ v1: 't1', v2: 't2', v3: 't3-moved' }),
    forkTags: map({ v1: 't1', v3: 't3', v0: 't0' }),
  });
  assert.deepEqual(brief(plan(p)), ['tag:v0:retained', 'tag:v1:up-to-date', 'tag:v2:create', 'tag:v3:tag-moved']);
});

test('tags: false ignores tags entirely', () => {
  const p = input({ tags: false, upstreamTags: map({ v1: 't1' }), forkTags: map({ v0: 't0' }) });
  assert.deepEqual(plan(p), []);
});

test('order: default branch first, other branches by name, then tags', () => {
  const p = input({
    defaultBranch: 'main',
    upstreamBranches: map({ zeta: 'z', alpha: 'a', main: 'm' }),
    upstreamTags: map({ v2: 't2', v1: 't1' }),
  });
  assert.deepEqual(brief(plan(p)), [
    'branch:main:create', 'branch:alpha:create', 'branch:zeta:create', 'tag:v1:create', 'tag:v2:create',
  ]);
});
