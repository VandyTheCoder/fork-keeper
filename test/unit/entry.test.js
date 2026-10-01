import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const indexPath = join(repoRoot, 'src', 'index.js');

function runEntry(path) {
  return spawnSync(process.execPath, [path], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
}

test('invoking the entry point directly fails fast with no token', () => {
  const result = runEntry(indexPath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::token is required\./);
});

test('invoking the entry point through a symlink still runs it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fork-keeper-entry-'));
  try {
    const link = join(dir, 'link');
    symlinkSync(join(repoRoot, 'src'), link);
    const result = runEntry(join(link, 'index.js'));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::token is required\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
});
