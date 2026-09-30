// Pure planning: one outcome per ref, from both repos' refs and the compare
// results. No I/O here; sync.js carries out what this returns.

const STATUS_TO_OUTCOME = {
  ahead: 'fast-forward',
  behind: 'backup-force',
  diverged: 'backup-force',
  identical: 'up-to-date',
};

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function inScopeBranches({ branches, upstreamBranches, forkBranches, backupRegex }) {
  if (branches !== '*') return [...branches];
  const names = new Set(upstreamBranches.keys());
  for (const name of forkBranches.keys()) {
    if (!backupRegex.test(name)) names.add(name);
  }
  return [...names];
}

export function branchesToCompare(input) {
  const { upstreamBranches, forkBranches } = input;
  return inScopeBranches(input)
    .filter((name) => upstreamBranches.has(name) && forkBranches.has(name)
      && upstreamBranches.get(name) !== forkBranches.get(name))
    .map((name) => ({ name, from: forkBranches.get(name), to: upstreamBranches.get(name) }));
}

function planBranch(name, { upstreamBranches, forkBranches, comparisons }) {
  const to = upstreamBranches.get(name);
  const from = forkBranches.get(name);
  const op = { kind: 'branch', name, from, to };
  if (to === undefined && from === undefined) return { ...op, outcome: 'error', error: 'not found upstream or in fork' };
  if (to === undefined) return { ...op, outcome: 'retained' };
  if (from === undefined) return { ...op, outcome: 'create' };
  if (from === to) return { ...op, outcome: 'up-to-date' };

  const comparison = comparisons.get(name);
  if (!comparison) throw new Error(`plan: missing comparison for branch "${name}"`);
  if (comparison.error) return { ...op, outcome: 'error', error: comparison.error };
  const outcome = STATUS_TO_OUTCOME[comparison.status];
  if (!outcome) return { ...op, outcome: 'error', error: `unexpected compare status "${comparison.status}"` };
  return { ...op, outcome, comparison };
}

function planTags({ upstreamTags, forkTags }) {
  const names = new Set([...upstreamTags.keys(), ...forkTags.keys()]);
  return [...names].map((name) => {
    const to = upstreamTags.get(name);
    const from = forkTags.get(name);
    const op = { kind: 'tag', name, from, to };
    if (to === undefined) return { ...op, outcome: 'retained' };
    if (from === undefined) return { ...op, outcome: 'create' };
    return { ...op, outcome: from === to ? 'up-to-date' : 'tag-moved' };
  });
}

export function plan(input) {
  const branchOps = inScopeBranches(input).map((name) => planBranch(name, input));
  const isDefault = (op) => (op.name === input.defaultBranch ? 1 : 0);
  branchOps.sort((a, b) => isDefault(b) - isDefault(a) || byName(a, b));
  const tagOps = input.tags ? planTags(input).sort(byName) : [];
  return [...branchOps, ...tagOps];
}
