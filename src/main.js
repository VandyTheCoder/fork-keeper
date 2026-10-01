import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { FatalError, InputError, PartialStop } from './errors.js';
import { createClient } from './github.js';
import { parseInputs } from './inputs.js';
import { branchesToCompare, plan } from './plan.js';
import { backupNameRegex, formatDate, formatDateTime } from './refname.js';
import { annotations, escapeData, exitCode, formatOutputs, logLine, outputsFor, stepSummary } from './report.js';
import { apply, compareBranches, resolve } from './sync.js';

export async function run({
  env = process.env,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = () => Date.now(),
  log = (line) => console.log(line),
  uuid = randomUUID,
} = {}) {
  let inputs;
  try {
    inputs = parseInputs(env);
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    for (const message of err.messages) log(`::error::${escapeData(message)}`);
    return 1;
  }

  const client = createClient({ token: inputs.token, fetch, sleep, now });
  const instant = new Date(now());
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  const runUrl = env.GITHUB_RUN_ID
    ? `${serverUrl}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : 'local run';

  let ctx = null;
  let results = [];
  let partial = false;
  try {
    ctx = await resolve(client, inputs.repository);
    const planInput = { ...ctx, branches: inputs.branches, tags: inputs.tags, backupRegex: backupNameRegex(inputs.pattern) };
    const comparisons = await compareBranches(client, ctx.fork, branchesToCompare(planInput));
    ({ results, partial } = await apply(client, ctx, plan({ ...planInput, comparisons }), {
      dryRun: inputs.dryRun,
      pattern: inputs.pattern,
      timeZone: inputs.timeZone,
      date: formatDate(instant, inputs.timeZone),
      detectedAt: formatDateTime(instant, inputs.timeZone),
      runUrl,
    }));
  } catch (err) {
    if (err instanceof FatalError) {
      log(`::error::${escapeData(err.message)}`);
      return 1;
    }
    if (!(err instanceof PartialStop)) throw err;
    partial = true;
  }

  const fork = ctx?.fork ?? inputs.repository;
  const upstream = ctx?.upstream ?? 'unknown upstream';
  log(`::group::fork-keeper: ${fork} ← ${upstream}`);
  for (const r of results) log(logLine(r));
  log('::endgroup::');
  for (const line of annotations(results, { partial })) log(line);

  const outputs = outputsFor({ results, partial, dryRun: inputs.dryRun, fork, upstream });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, formatOutputs(outputs, `ghadelimiter_${uuid()}`));
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, stepSummary(results, { fork, upstream, dryRun: inputs.dryRun, partial, serverUrl }));
  }
  return exitCode(results);
}
