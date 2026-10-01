import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../../src/inputs.js';

const yml = readFileSync(new URL('../../action.yml', import.meta.url), 'utf8');
const section = (from, to) => yml.slice(yml.indexOf(`\n${from}:`), to ? yml.indexOf(`\n${to}:`) : undefined);
const keys = (text) => [...text.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]).sort();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('action.yml declares exactly the inputs the code reads', () => {
  assert.deepEqual(keys(section('inputs', 'outputs')),
    ['backup-branch-pattern', 'branches', 'dry-run', 'repository', 'tags', 'timezone', 'token']);
});

test('action.yml defaults match DEFAULTS in inputs.js', () => {
  for (const [name, value] of Object.entries(DEFAULTS)) {
    assert.match(yml, new RegExp(`^ {2}${escapeRe(name)}:\\n(?: {4}.*\\n)*? {4}default: '${escapeRe(value)}'$`, 'm'), name);
  }
});

test('action.yml declares the three outputs', () => {
  assert.deepEqual(keys(section('outputs', 'runs')), ['changed', 'rewritten', 'summary']);
});

test('action.yml runs node24 from src/main.js', () => {
  assert.match(yml, /^runs:\n {2}using: 'node24'\n {2}main: 'src\/main\.js'$/m);
});
