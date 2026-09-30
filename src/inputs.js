import { InputError } from './errors.js';
import { isValidRefName, isValidTimeZone, validatePattern } from './refname.js';

export const DEFAULTS = Object.freeze({
  branches: '*',
  tags: 'true',
  'backup-branch-pattern': 'backup/{branch}/{date}',
  timezone: 'UTC',
  'dry-run': 'false',
});

// The runner exports input `foo-bar` as INPUT_FOO-BAR: spaces become
// underscores, hyphens are kept. An empty value means "use the default".
function readInput(env, name) {
  const value = (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
  return value === '' ? (DEFAULTS[name] ?? '') : value;
}

function parseBoolean(name, value, errors) {
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  errors.push(`${name} must be "true" or "false", got "${value}".`);
  return false;
}

function parseBranches(raw, errors) {
  if (raw === '*') return '*';
  const names = [...new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))];
  if (names.includes('*')) errors.push('branches: use "*" alone, not mixed with branch names.');
  for (const name of names) {
    if (name !== '*' && !isValidRefName(name)) errors.push(`branches: "${name}" is not a valid branch name.`);
  }
  return names;
}

export function parseInputs(env) {
  const errors = [];

  const token = readInput(env, 'token');
  if (!token) errors.push('token is required.');

  const repository = readInput(env, 'repository') || (env.GITHUB_REPOSITORY ?? '');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    errors.push(`repository must look like "owner/name", got "${repository}".`);
  }

  const branches = parseBranches(readInput(env, 'branches'), errors);
  const tags = parseBoolean('tags', readInput(env, 'tags'), errors);
  const dryRun = parseBoolean('dry-run', readInput(env, 'dry-run'), errors);

  const timeZone = readInput(env, 'timezone');
  if (!isValidTimeZone(timeZone)) {
    errors.push(`timezone "${timeZone}" is not a valid IANA time zone (e.g. Asia/Phnom_Penh).`);
  }

  const pattern = readInput(env, 'backup-branch-pattern');
  const multiBranch = branches === '*' || branches.length > 1;
  errors.push(...validatePattern(pattern, { multiBranch }));

  if (errors.length > 0) throw new InputError(errors);
  return { token, repository, branches, tags, dryRun, timeZone, pattern };
}
