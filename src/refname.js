// Pure helpers: backup-branch names, git ref-name rules, and dates in a zone.

export const MAX_BACKUP_SUFFIX = 20;

const FORBIDDEN_CHARS = /[\x00-\x20\x7f~^:?*[\\]/;

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

export function formatDate(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatDateTime(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function isValidRefName(name) {
  if (typeof name !== 'string' || name === '' || name === '@') return false;
  if (FORBIDDEN_CHARS.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.startsWith('-') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

export function renderBackupName(pattern, { branch, date }) {
  return pattern.replace(/\{(branch|date)\}/g, (_, key) => (key === 'branch' ? branch : date));
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function backupNameRegex(pattern) {
  const body = pattern
    .split(/(\{branch\}|\{date\})/)
    .map((part) => {
      if (part === '{branch}') return '.+';
      if (part === '{date}') return '\\d{4}-\\d{2}-\\d{2}';
      return escapeRegex(part);
    })
    .join('');
  return new RegExp(`^${body}(?:-\\d+)?$`);
}

export function pickFreeBackupName(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= MAX_BACKUP_SUFFIX; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

export function validatePattern(pattern, { multiBranch }) {
  const errors = [];
  if (!pattern.includes('{date}')) errors.push('backup-branch-pattern must contain {date}.');
  if (multiBranch && !pattern.includes('{branch}')) {
    errors.push('backup-branch-pattern must contain {branch} when more than one branch is synced (branches is "*" or lists several).');
  }
  const sample = renderBackupName(pattern, { branch: 'main', date: '2026-01-01' });
  if (!isValidRefName(sample)) errors.push(`backup-branch-pattern renders an invalid branch name: "${sample}".`);
  if (sample.startsWith('main/')) {
    errors.push('backup-branch-pattern must not start with {branch}/ — the backup would clash with the branch itself.');
  }
  return errors;
}
