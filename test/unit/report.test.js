import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotations, countOutcomes, escapeData, escapeMd, exitCode, formatOutputs, logLine, outputsFor, stepSummary,
} from '../../src/report.js';

const sha = (c) => c.repeat(40);
const results = [
  { kind: 'branch', name: 'main', outcome: 'backup-force', status: 'done', from: sha('a'), to: sha('b'), backupName: 'backup/main/2026-10-01' },
  { kind: 'branch', name: 'dev', outcome: 'fast-forward', status: 'done', from: sha('c'), to: sha('d') },
  { kind: 'branch', name: 'old', outcome: 'retained', status: 'done', from: sha('e') },
  { kind: 'tag', name: 'v1', outcome: 'tag-moved', status: 'done', from: sha('f'), to: sha('1') },
  { kind: 'branch', name: 'same', outcome: 'up-to-date', status: 'done', from: sha('2'), to: sha('2') },
];
const ctx = { fork: 'me/b', upstream: 'org/a', dryRun: false, partial: false, serverUrl: 'https://github.com' };

test('escapeMd neutralises table and HTML characters', () => {
  assert.equal(escapeMd('a|b<c>`d&'), 'a\\|b&lt;c&gt;\\`d&amp;');
});

test('escapeData stops newline injection into workflow commands', () => {
  assert.equal(escapeData('x\n::error::y%\r'), 'x%0A::error::y%25%0D');
});

test('formatOutputs uses the heredoc form with the given delimiter', () => {
  assert.equal(formatOutputs({ changed: 'true', summary: '{"a":1}' }, 'D'), 'changed<<D\ntrue\nD\nsummary<<D\n{"a":1}\nD\n');
});

test('countOutcomes counts every result, omitting zeroes', () => {
  assert.deepEqual(countOutcomes(results), { 'fast-forward': 1, 'backup-force': 1, 'tag-moved': 1, retained: 1, 'up-to-date': 1 });
});

test('outputsFor counts real writes and summarises notable refs', () => {
  const out = outputsFor({ results, partial: false, dryRun: false, fork: 'me/b', upstream: 'org/a' });
  assert.equal(out.changed, 'true');
  assert.equal(out.rewritten, '1');
  const summary = JSON.parse(out.summary);
  assert.equal(summary.fork, 'me/b');
  assert.equal(summary.upstream, 'org/a');
  assert.equal(summary.refs.length, 4);
  assert.deepEqual(summary.refs[0], {
    ref: 'heads/main', outcome: 'backup-force', status: 'done', from: sha('a'), to: sha('b'),
    backup: 'backup/main/2026-10-01', error: null,
  });
  assert.equal(summary.refs[3].ref, 'tags/v1');
});

test('outputsFor reports no change for planned (dry-run) results', () => {
  const planned = results.map((r) => ({ ...r, status: r.outcome === 'up-to-date' ? 'done' : 'planned' }));
  const out = outputsFor({ results: planned, partial: false, dryRun: true, fork: 'me/b', upstream: 'org/a' });
  assert.equal(out.changed, 'false');
  assert.equal(out.rewritten, '0');
});

test('annotations warn on rewrites, moved tags and partial runs; error on failures', () => {
  const failing = [...results, { kind: 'branch', name: 'x', outcome: 'create', status: 'error', error: 'line1\nline2' }];
  assert.deepEqual(annotations(failing, { partial: true }), [
    '::warning::Upstream rewrote main; previous state saved as backup/main/2026-10-01, then force-synced.',
    '::warning::Upstream moved tag v1; the fork keeps the original.',
    '::error::branch x: line1%0Aline2',
    '::warning::Run stopped early (GitHub rate limit or write budget); the next run continues.',
  ]);
});

test('exitCode is 1 only when a ref errored', () => {
  assert.equal(exitCode(results), 0);
  assert.equal(exitCode([...results, { kind: 'branch', name: 'x', outcome: 'error', status: 'error', error: 'e' }]), 1);
});

test('logLine names the outcome and ref, prefixing dry-run plans with "would"', () => {
  assert.equal(logLine(results[0]), 'BACKUP → FORCE-SYNC: branch main (backup: backup/main/2026-10-01)');
  assert.equal(logLine({ ...results[1], status: 'planned' }), 'would FAST-FORWARD: branch dev');
  assert.equal(logLine({ kind: 'tag', name: 'v2', outcome: 'create', status: 'skipped', error: 'GitHub rate limit reached' }),
    'CREATE: tag v2 — GitHub rate limit reached');
});

test('stepSummary lists notable refs with links and hides up-to-date ones', () => {
  const md = stepSummary(results, ctx);
  assert.match(md, /^## fork-keeper: me\/b ← org\/a\n/);
  assert.match(md, /\| BACKUP → FORCE-SYNC \| 1 \|/);
  assert.match(md, /\| branch main \| BACKUP → FORCE-SYNC \| backup \[backup\/main\/2026-10-01\]\(https:\/\/github.com\/me\/b\/tree\/backup\/main\/2026-10-01\) · aaaaaaa → bbbbbbb \|/);
  assert.match(md, /\| branch dev \| FAST-FORWARD \| ccccccc → ddddddd · \[diff\]\(https:\/\/github.com\/me\/b\/compare\/c{40}\.\.\.d{40}\) \|/);
  assert.match(md, /\| tag v1 \| TAG-MOVED \| fork keeps fffffff; upstream now 1111111 \|/);
  assert.doesNotMatch(md, /branch same/);
});

test('stepSummary escapes ref names and marks dry runs', () => {
  const md = stepSummary([{ kind: 'branch', name: 'x|y', outcome: 'create', status: 'planned', to: sha('9') }], { ...ctx, dryRun: true });
  assert.match(md, /\(dry run — nothing written\)/);
  assert.match(md, /\| branch x\\\|y \| would CREATE \| at 9999999 \|/);
});

test('stepSummary says so when everything is up to date', () => {
  assert.match(stepSummary([results[4]], ctx), /Everything is already up to date\./);
});
