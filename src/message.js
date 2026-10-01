// The commit message recorded on every backup branch. Only SHAs, names,
// counts and URLs go in — never text written upstream.
export function backupCommitMessage({ branch, upstream, fork, from, to, mergeBase, behindBy, detectedAt, timeZone, runUrl }) {
  return [
    `backup: ${branch} before upstream history rewrite`,
    '',
    `Upstream ${upstream} rewrote \`${branch}\` (force-push or history rewrite).`,
    `fork-keeper preserved ${fork}'s previous \`${branch}\` here before syncing to it.`,
    '',
    `Previous ${branch}:  ${from}`,
    `New upstream ${branch}:  ${to}`,
    `Common ancestor:  ${mergeBase ?? 'none'}`,
    `Commits preserved only here:  ${behindBy ?? 'all (no common ancestor)'}`,
    `Detected:  ${detectedAt} (${timeZone})`,
    `Run:  ${runUrl}`,
    '',
  ].join('\n');
}
