import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupCommitMessage } from '../../src/message.js';

const args = {
  branch: 'main', upstream: 'org/a', fork: 'me/b',
  from: '1'.repeat(40), to: '2'.repeat(40), mergeBase: '3'.repeat(40), behindBy: 12,
  detectedAt: '2026-10-01 00:04', timeZone: 'Asia/Phnom_Penh',
  runUrl: 'https://github.com/me/hub/actions/runs/42',
};

test('backupCommitMessage follows the spec format exactly', () => {
  assert.equal(backupCommitMessage(args), [
    'backup: main before upstream history rewrite',
    '',
    'Upstream org/a rewrote `main` (force-push or history rewrite).',
    'fork-keeper preserved me/b\'s previous `main` here before syncing to it.',
    '',
    `Previous main:  ${'1'.repeat(40)}`,
    `New upstream main:  ${'2'.repeat(40)}`,
    `Common ancestor:  ${'3'.repeat(40)}`,
    'Commits preserved only here:  12',
    'Detected:  2026-10-01 00:04 (Asia/Phnom_Penh)',
    'Run:  https://github.com/me/hub/actions/runs/42',
    '',
  ].join('\n'));
});

test('backupCommitMessage says "none" when there is no common ancestor', () => {
  assert.match(backupCommitMessage({ ...args, mergeBase: null }), /^Common ancestor: {2}none$/m);
});

test('backupCommitMessage explains an unknown preserved count for a full-history rewrite', () => {
  assert.match(backupCommitMessage({ ...args, mergeBase: null, behindBy: null }),
    /^Commits preserved only here: {2}all \(no common ancestor\)$/m);
});
