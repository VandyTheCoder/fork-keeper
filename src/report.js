// Everything the user sees: log lines, annotations, step summary, outputs.

export const LABELS = Object.freeze({
  create: 'CREATE',
  'fast-forward': 'FAST-FORWARD',
  'backup-force': 'BACKUP → FORCE-SYNC',
  'tag-moved': 'TAG-MOVED',
  retained: 'RETAINED',
  error: 'ERROR',
  'up-to-date': 'UP-TO-DATE',
});

const WRITING_OUTCOMES = new Set(['create', 'fast-forward', 'backup-force']);
const short = (sha) => (sha ? sha.slice(0, 7) : '—');
const refLabel = (r) => `${r.kind === 'tag' ? 'tag' : 'branch'} ${r.name}`;
const refKey = (r) => `${r.kind === 'tag' ? 'tags' : 'heads'}/${r.name}`;
const encodeSegment = (segment) => encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29');
const urlPath = (name) => name.split('/').map(encodeSegment).join('/');
const isQuiet = (r) => r.outcome === 'up-to-date' && r.status === 'done';

export function escapeMd(text) {
  const entities = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };
  return String(text).replace(/[\\`*_|<>&[\]]/g, (c) => entities[c] ?? `\\${c}`);
}

export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function countOutcomes(results) {
  const counts = {};
  for (const outcome of Object.keys(LABELS)) {
    const n = results.filter((r) => r.outcome === outcome).length;
    if (n > 0) counts[outcome] = n;
  }
  return counts;
}

export function exitCode(results) {
  return results.some((r) => r.status === 'error') ? 1 : 0;
}

export function logLine(r) {
  const prefix = r.status === 'planned' ? 'would ' : '';
  let detail = '';
  if (r.status === 'error' || r.status === 'skipped') detail = ` — ${r.error}`;
  else if (r.backupName) detail = ` (backup: ${r.backupName})`;
  return `${prefix}${LABELS[r.outcome]}: ${refLabel(r)}${detail}`.replace(/[\r\n]+/g, ' ');
}

export function annotations(results, { partial }) {
  const lines = [];
  const warn = (text) => lines.push(`::warning::${escapeData(text)}`);
  for (const r of results) {
    if (r.outcome === 'backup-force' && r.status === 'done') {
      warn(`Upstream rewrote ${r.name}; previous state saved as ${r.backupName}, then force-synced.`);
    }
    if (r.outcome === 'tag-moved') warn(`Upstream moved tag ${r.name}; the fork keeps the original.`);
    if (r.status === 'error') lines.push(`::error::${escapeData(`${refLabel(r)}: ${r.error}`)}`);
  }
  if (partial) warn('Run stopped early (GitHub rate limit or write budget); the next run continues.');
  return lines;
}

export function outputsFor({ results, partial, dryRun, fork, upstream }) {
  const done = results.filter((r) => r.status === 'done');
  const summary = {
    upstream,
    fork,
    dryRun,
    partial,
    counts: countOutcomes(results),
    refs: results.filter((r) => !isQuiet(r)).map((r) => ({
      ref: refKey(r),
      outcome: r.outcome,
      status: r.status,
      from: r.from ?? null,
      to: r.to ?? null,
      backup: r.backupName ?? null,
      error: r.error ?? null,
    })),
  };
  return {
    changed: String(done.some((r) => WRITING_OUTCOMES.has(r.outcome))),
    rewritten: String(done.filter((r) => r.outcome === 'backup-force').length),
    summary: JSON.stringify(summary),
  };
}

export function formatOutputs(outputs, delimiter) {
  return Object.entries(outputs).map(([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`).join('');
}

function detail(r, fork, serverUrl) {
  const repoUrl = `${serverUrl}/${fork}`;
  let backup = '';
  if (r.backupName) {
    backup = r.status === 'planned'
      ? escapeMd(r.backupName)
      : `[${escapeMd(r.backupName)}](${repoUrl}/tree/${urlPath(r.backupName)})`;
  }
  if (r.status === 'error') return `⚠ ${escapeMd(r.error)}${backup ? ` · backup ${backup}` : ''}`;
  if (r.status === 'skipped') return `not processed — run stopped early${backup ? ` · backup ${backup} already created` : ''}`;
  switch (r.outcome) {
    case 'create': return `at ${short(r.to)}`;
    case 'fast-forward': return `${short(r.from)} → ${short(r.to)} · [diff](${repoUrl}/compare/${r.from}...${r.to})`;
    case 'backup-force': return `backup ${backup} · ${short(r.from)} → ${short(r.to)}`;
    case 'tag-moved': return `fork keeps ${short(r.from)}; upstream now ${short(r.to)}`;
    case 'retained': return 'deleted upstream; kept in fork';
    default: return '';
  }
}

export function stepSummary(results, { fork, upstream, dryRun, partial, serverUrl }) {
  const lines = [`## fork-keeper: ${escapeMd(fork)} ← ${escapeMd(upstream)}${dryRun ? ' (dry run — nothing written)' : ''}`, ''];
  if (partial) lines.push('> ⚠ Run stopped early (GitHub rate limit or write budget). The next run continues from here.', '');
  lines.push('| Outcome | Refs |', '|---|---|');
  for (const [outcome, n] of Object.entries(countOutcomes(results))) lines.push(`| ${LABELS[outcome]} | ${n} |`);
  lines.push('');
  const notable = results.filter((r) => !isQuiet(r));
  if (notable.length === 0) {
    lines.push(partial && results.length === 0 ? 'No refs were processed.' : 'Everything is already up to date.');
  } else {
    lines.push('| Ref | Outcome | Detail |', '|---|---|---|');
    for (const r of notable) {
      lines.push(`| ${escapeMd(refLabel(r))} | ${r.status === 'planned' ? 'would ' : ''}${LABELS[r.outcome]} | ${detail(r, fork, serverUrl)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
