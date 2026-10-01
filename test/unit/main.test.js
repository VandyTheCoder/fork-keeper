import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/main.js';
import { createFakeGitHub } from '../helpers/fake-github.js';
import { fakeClock } from '../helpers/clock.js';

function parseOutputs(text) {
  const out = {};
  const re = /^(\S+)<<(\S+)\n([\s\S]*?)\n\2\n/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out[m[1]] = m[3];
  return out;
}

function harness() {
  const gh = createFakeGitHub();
  const clock = fakeClock(Date.parse('2026-09-30T17:04:00Z')); // 00:04 on 1 Oct in Phnom Penh
  const dir = mkdtempSync(join(tmpdir(), 'fork-keeper-'));
  const lines = [];
  const env = {
    INPUT_TOKEN: 'ghp_SECRET', INPUT_REPOSITORY: 'me/b', INPUT_TIMEZONE: 'Asia/Phnom_Penh',
    GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'me/hub', GITHUB_RUN_ID: '42',
  };
  return {
    gh,
    lines,
    exec: (extra = {}) => run({ env: { ...env, ...extra }, fetch: gh.fetch, sleep: clock.sleep, now: clock.now, log: (l) => lines.push(l), uuid: () => 'fixed' }),
    outputs: () => parseOutputs(readFileSync(env.GITHUB_OUTPUT, 'utf8')),
    outputFile: () => readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    summary: () => readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'),
    writes: () => gh.requests.filter((r) => r.method !== 'GET'),
  };
}

function forcePushed(h) {
  const base = h.gh.commit();
  const old = h.gh.commit([base]);
  const rewritten = h.gh.commit([base]);
  h.gh.setRef('org/a', 'refs/heads/main', rewritten);
  h.gh.setRef('me/b', 'refs/heads/main', old);
  return { old, rewritten };
}

test('first run fast-forwards main and backfills branches and tags', async () => {
  const h = harness();
  const c1 = h.gh.commit();
  const c2 = h.gh.commit([c1]);
  h.gh.setRef('org/a', 'refs/heads/main', c2);
  h.gh.setRef('org/a', 'refs/heads/develop', c1);
  const v1 = h.gh.tag('org/a', 'v1', c1, { annotated: true });
  h.gh.setRef('me/b', 'refs/heads/main', c1);

  assert.equal(await h.exec(), 0);
  assert.equal(h.gh.getRef('me/b', 'refs/heads/main'), c2);
  assert.equal(h.gh.getRef('me/b', 'refs/heads/develop'), c1);
  assert.equal(h.gh.getRef('me/b', 'refs/tags/v1'), v1);
  assert.equal(h.outputs().changed, 'true');
  assert.equal(h.outputs().rewritten, '0');
});

test('an upstream force-push is backed up (local date) before the fork follows it', async () => {
  const h = harness();
  const { old, rewritten } = forcePushed(h);

  assert.equal(await h.exec(), 0);
  const backup = h.gh.getRef('me/b', 'refs/heads/backup/main/2026-10-01');
  assert.ok(backup, 'backup branch uses the Phnom Penh date');
  const commit = h.gh.commits.get(backup);
  assert.deepEqual(commit.parents, [old]);
  assert.match(commit.message, /^backup: main before upstream history rewrite\n/);
  assert.match(commit.message, /^Detected: {2}2026-10-01 00:04 \(Asia\/Phnom_Penh\)$/m);
  assert.match(commit.message, /^Run: {2}https:\/\/github\.com\/me\/hub\/actions\/runs\/42$/m);
  assert.equal(h.gh.getRef('me/b', 'refs/heads/main'), rewritten);
  assert.equal(h.outputs().rewritten, '1');
  assert.ok(h.lines.some((l) => l.startsWith('::warning::Upstream rewrote main;')));
});

test('a second run with nothing new makes no writes and no compare calls', async () => {
  const h = harness();
  forcePushed(h);
  await h.exec();
  const before = h.gh.requests.length;

  assert.equal(await h.exec(), 0);
  const second = h.gh.requests.slice(before);
  assert.equal(second.filter((r) => r.method !== 'GET').length, 0);
  assert.equal(second.filter((r) => r.path.includes('/compare/')).length, 0);
  assert.equal(h.outputs().changed, 'false');
  assert.match(h.summary(), /Everything is already up to date\./);
});

test('dry-run via INPUT_DRY-RUN plans without writing', async () => {
  const h = harness();
  const { old } = forcePushed(h);

  assert.equal(await h.exec({ 'INPUT_DRY-RUN': 'true' }), 0);
  assert.equal(h.writes().length, 0);
  assert.equal(h.gh.getRef('me/b', 'refs/heads/main'), old);
  assert.match(h.summary(), /would BACKUP → FORCE-SYNC/);
  assert.equal(h.outputs().changed, 'false');
});

test('a fatal problem exits 1 with one plain-English error', async () => {
  const h = harness();
  h.gh.repoMeta['me/b'].fork = false;
  assert.equal(await h.exec(), 1);
  assert.deepEqual(h.lines.filter((l) => l.startsWith('::error::')), ['::error::`me/b` is not a fork; nothing to mirror.']);
});

test('invalid inputs exit 1 before any request', async () => {
  const h = harness();
  assert.equal(await h.exec({ INPUT_TIMEZONE: 'Mars/Olympus' }), 1);
  assert.equal(h.gh.requests.length, 0);
  assert.match(h.lines[0], /^::error::timezone "Mars\/Olympus"/);
});

test('a failed force after a successful backup fails the run and names the backup', async () => {
  const h = harness();
  forcePushed(h);
  h.gh.fail('PATCH', /\/git\/refs\/heads\/main$/, {
    status: 422,
    body: { message: 'refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope' },
  });
  assert.equal(await h.exec(), 1);
  assert.ok(h.lines.includes('::error::branch main: backup backup/main/2026-10-01 created, but force-sync failed: PAT lacks Workflows: Read and write'));
});

test('branch names with URL-special characters are synced', async () => {
  const h = harness();
  const c1 = h.gh.commit();
  const c2 = h.gh.commit([c1]);
  h.gh.setRef('org/a', 'refs/heads/main', c1);
  h.gh.setRef('me/b', 'refs/heads/main', c1);
  h.gh.setRef('org/a', 'refs/heads/feature/x#1', c2);
  h.gh.setRef('me/b', 'refs/heads/feature/x#1', c1);
  assert.equal(await h.exec(), 0);
  assert.equal(h.gh.getRef('me/b', 'refs/heads/feature/x#1'), c2);
});

test('the token never appears in logs, outputs or the summary', async () => {
  const h = harness();
  forcePushed(h);
  await h.exec();
  assert.ok(!h.lines.join('\n').includes('ghp_SECRET'));
  assert.ok(!h.outputFile().includes('ghp_SECRET'));
  assert.ok(!h.summary().includes('ghp_SECRET'));
});

test('outputs use a random ghadelimiter', async () => {
  const h = harness();
  forcePushed(h);
  await h.exec();
  assert.match(h.outputFile(), /^changed<<ghadelimiter_fixed\n/);
});
