import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BACKUP_SUFFIX,
  backupNameRegex,
  formatDate,
  formatDateTime,
  isValidRefName,
  isValidTimeZone,
  pickFreeBackupName,
  renderBackupName,
  validatePattern,
} from '../../src/refname.js';

test('formatDate renders the calendar day in the given zone', () => {
  const instant = new Date('2026-09-30T17:00:00Z'); // 00:00 on 1 Oct in UTC+7
  assert.equal(formatDate(instant, 'UTC'), '2026-09-30');
  assert.equal(formatDate(instant, 'Asia/Phnom_Penh'), '2026-10-01');
});

test('formatDate keeps the previous day one minute before local midnight', () => {
  assert.equal(formatDate(new Date('2026-09-30T16:59:00Z'), 'Asia/Phnom_Penh'), '2026-09-30');
});

test('formatDateTime uses a 24-hour clock with 00 at midnight', () => {
  assert.equal(formatDateTime(new Date('2026-09-30T17:04:00Z'), 'Asia/Phnom_Penh'), '2026-10-01 00:04');
  assert.equal(formatDateTime(new Date('2026-09-30T13:30:00Z'), 'UTC'), '2026-09-30 13:30');
});

test('isValidTimeZone accepts IANA zones and rejects junk', () => {
  assert.equal(isValidTimeZone('Asia/Phnom_Penh'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone('not a zone'), false);
});

test('isValidRefName follows git check-ref-format rules', () => {
  for (const ok of ['main', 'feature/x', 'release/1.0', 'fix/ñandú', 'x#1', 'backup/main/2026-10-01-2']) {
    assert.equal(isValidRefName(ok), true, ok);
  }
  for (const bad of ['', '@', '-x', '/x', 'x/', 'a..b', 'a//b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b',
    'a*b', 'a[b', 'a\\b', 'a@{b', 'x.', 'x/.hidden', 'x.lock', 'x.lock/y', 'tab\there']) {
    assert.equal(isValidRefName(bad), false, JSON.stringify(bad));
  }
});

test('renderBackupName fills both placeholders', () => {
  assert.equal(renderBackupName('backup/{branch}/{date}', { branch: 'feature/x', date: '2026-10-01' }),
    'backup/feature/x/2026-10-01');
  assert.equal(renderBackupName('backup/{date}', { branch: 'main', date: '2026-10-01' }), 'backup/2026-10-01');
});

test('backupNameRegex matches rendered names with or without a collision suffix', () => {
  const re = backupNameRegex('backup/{branch}/{date}');
  assert.equal(re.test('backup/main/2026-10-01'), true);
  assert.equal(re.test('backup/feature/x/2026-10-01-3'), true);
  assert.equal(re.test('backup/main'), false);
  assert.equal(re.test('main'), false);
  assert.equal(re.test('xbackup/main/2026-10-01'), false);
});

test('backupNameRegex treats regex metacharacters in the pattern literally', () => {
  const re = backupNameRegex('bk.{date}');
  assert.equal(re.test('bk.2026-10-01'), true);
  assert.equal(re.test('bkX2026-10-01'), false);
});

test('pickFreeBackupName returns the base, then -2, -3 … up to the cap', () => {
  assert.equal(pickFreeBackupName('b/2026-10-01', new Set()), 'b/2026-10-01');
  assert.equal(pickFreeBackupName('b/2026-10-01', new Set(['b/2026-10-01'])), 'b/2026-10-01-2');
  assert.equal(pickFreeBackupName('b/2026-10-01', new Set(['b/2026-10-01', 'b/2026-10-01-2'])), 'b/2026-10-01-3');
  const all = new Set(['b', ...Array.from({ length: MAX_BACKUP_SUFFIX - 1 }, (_, i) => `b-${i + 2}`)]);
  assert.equal(pickFreeBackupName('b', all), null);
});

test('validatePattern requires {date}', () => {
  assert.deepEqual(validatePattern('backup/{branch}', { multiBranch: false }),
    ['backup-branch-pattern must contain {date}.']);
});

test('validatePattern requires {branch} only when several branches are synced', () => {
  assert.deepEqual(validatePattern('backup/{date}', { multiBranch: false }), []);
  const errors = validatePattern('backup/{date}', { multiBranch: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must contain \{branch\}/);
});

test('validatePattern rejects patterns that render invalid branch names', () => {
  const errors = validatePattern('backup {branch}/{date}', { multiBranch: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /invalid branch name/);
});

test('validatePattern rejects a pattern that would nest under the branch itself', () => {
  assert.deepEqual(validatePattern('{branch}/backup-{date}', { multiBranch: false }), [
    'backup-branch-pattern must not start with {branch}/ — the backup would clash with the branch itself.',
  ]);
});

test('validatePattern accepts a literal pattern that merely renders starting with a branch name', () => {
  assert.deepEqual(validatePattern('main/backups/{date}', { multiBranch: false }), []);
});
