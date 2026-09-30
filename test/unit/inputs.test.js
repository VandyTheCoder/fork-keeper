import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputs } from '../../src/inputs.js';
import { InputError } from '../../src/errors.js';

const base = { INPUT_TOKEN: 'tkn', INPUT_REPOSITORY: 'me/b' };

function errorsOf(env) {
  try {
    parseInputs(env);
  } catch (err) {
    assert.ok(err instanceof InputError);
    return err.messages;
  }
  return assert.fail('expected an InputError');
}

test('defaults apply when optional inputs are absent', () => {
  assert.deepEqual(parseInputs(base), {
    token: 'tkn', repository: 'me/b', branches: '*', tags: true, dryRun: false,
    timeZone: 'UTC', pattern: 'backup/{branch}/{date}',
  });
});

test('reads hyphenated input names exactly as the runner exports them', () => {
  const inputs = parseInputs({
    ...base,
    'INPUT_DRY-RUN': 'true',
    'INPUT_BACKUP-BRANCH-PATTERN': 'bk/{branch}/{date}',
    INPUT_DRY_RUN: 'false', // underscore form must be ignored
  });
  assert.equal(inputs.dryRun, true);
  assert.equal(inputs.pattern, 'bk/{branch}/{date}');
});

test('inputs passed as empty strings fall back to their defaults', () => {
  const inputs = parseInputs({
    ...base, INPUT_BRANCHES: '', INPUT_TAGS: ' ', INPUT_TIMEZONE: '',
    'INPUT_DRY-RUN': '', 'INPUT_BACKUP-BRANCH-PATTERN': '',
  });
  assert.equal(inputs.branches, '*');
  assert.equal(inputs.tags, true);
  assert.equal(inputs.timeZone, 'UTC');
  assert.equal(inputs.dryRun, false);
  assert.equal(inputs.pattern, 'backup/{branch}/{date}');
});

test('repository falls back to GITHUB_REPOSITORY when empty', () => {
  assert.equal(parseInputs({ INPUT_TOKEN: 't', INPUT_REPOSITORY: '', GITHUB_REPOSITORY: 'me/hub' }).repository, 'me/hub');
});

test('branches accepts a newline-separated list, trimmed and de-duplicated', () => {
  assert.deepEqual(parseInputs({ ...base, INPUT_BRANCHES: ' main \ndevelop\n\nmain\n' }).branches, ['main', 'develop']);
});

test('a single listed branch may use a pattern without {branch}', () => {
  const inputs = parseInputs({ ...base, INPUT_BRANCHES: 'main', 'INPUT_BACKUP-BRANCH-PATTERN': 'backup/{date}' });
  assert.equal(inputs.pattern, 'backup/{date}');
});

test('booleans accept any letter case', () => {
  assert.equal(parseInputs({ ...base, INPUT_TAGS: 'FALSE' }).tags, false);
  assert.equal(parseInputs({ ...base, 'INPUT_DRY-RUN': 'True' }).dryRun, true);
});

test('collects every problem in one error', () => {
  const messages = errorsOf({
    INPUT_TOKEN: '', INPUT_REPOSITORY: 'not-a-repo', INPUT_TAGS: 'yes',
    INPUT_TIMEZONE: 'Mars/Olympus', 'INPUT_BACKUP-BRANCH-PATTERN': 'backup/{date}',
  });
  assert.equal(messages.length, 5);
  assert.match(messages[0], /token is required/);
  assert.match(messages[1], /repository must look like "owner\/name"/);
  assert.match(messages[2], /tags must be "true" or "false"/);
  assert.match(messages[3], /timezone "Mars\/Olympus" is not a valid IANA time zone/);
  assert.match(messages[4], /must contain \{branch\}/);
});

test('"*" cannot be mixed with branch names', () => {
  assert.match(errorsOf({ ...base, INPUT_BRANCHES: 'main\n*' })[0], /use "\*" alone/);
});

test('invalid branch names in the list are rejected', () => {
  assert.match(errorsOf({ ...base, INPUT_BRANCHES: 'main\nbad name' })[0], /"bad name" is not a valid branch name/);
});

test('error messages never contain the token', () => {
  const messages = errorsOf({ INPUT_TOKEN: 'ghp_SECRET', INPUT_REPOSITORY: 'bad' });
  assert.ok(messages.every((m) => !m.includes('ghp_SECRET')));
});
