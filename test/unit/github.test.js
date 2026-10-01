import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, createClient, isWorkflowPermissionError, refPath } from '../../src/github.js';
import { PartialStop } from '../../src/errors.js';
import { fakeClock } from '../helpers/clock.js';

// Replays scripted responses in order; an Error entry simulates a network failure.
function scripted(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    const { status = 200, body, headers = {} } = next;
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

function clientFor(responses, options = {}) {
  const clock = fakeClock(options.start);
  const { fetch, calls } = scripted(responses);
  const client = createClient({ token: 'ghp_T', fetch, now: clock.now, sleep: clock.sleep, ...options });
  return { client, calls, clock };
}

test('sends the token only in the Authorization header, with API version headers', async () => {
  const { client, calls } = clientFor([{ body: { ok: 1 } }]);
  assert.deepEqual(await client.request('GET', '/repos/me/b'), { ok: 1 });
  assert.equal(calls[0].url, 'https://api.github.com/repos/me/b');
  assert.equal(calls[0].headers.Authorization, 'Bearer ghp_T');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(calls[0].body, undefined);
  assert.ok(!calls[0].url.includes('ghp_T'));
});

test('sends JSON bodies on writes', async () => {
  const { client, calls } = clientFor([{ status: 201, body: { ref: 'x' } }]);
  await client.request('POST', '/repos/me/b/git/refs', { ref: 'refs/heads/x', sha: 'abc' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { ref: 'refs/heads/x', sha: 'abc' });
});

test('retries 5xx with 1 s then 2 s backoff, then succeeds', async () => {
  const { client, clock } = clientFor([{ status: 502 }, { status: 503 }, { body: [] }]);
  assert.deepEqual(await client.request('GET', '/x'), []);
  assert.deepEqual(clock.sleeps, [1000, 2000]);
});

test('gives up after three retries on network errors', async () => {
  const boom = () => new TypeError('fetch failed');
  const { client, clock } = clientFor([boom(), boom(), boom(), boom()]);
  await assert.rejects(client.request('GET', '/x'), (err) => err instanceof GitHubError && err.status === 0);
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000]);
});

test('waits for a primary rate-limit reset that is near', async () => {
  const start = 1_000_000;
  const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 60) };
  const { client, clock } = clientFor([{ status: 403, body: { message: 'API rate limit exceeded' }, headers }, { body: [] }], { start });
  await client.request('GET', '/x');
  assert.deepEqual(clock.sleeps, [61_000]);
});

test('stops as PartialStop when the primary reset is far away', async () => {
  const start = 1_000_000;
  const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 3600) };
  const { client, clock } = clientFor([{ status: 403, body: { message: 'API rate limit exceeded' }, headers }], { start });
  await assert.rejects(client.request('GET', '/x'), (err) => err instanceof PartialStop && err.reason === 'rate-limit');
  assert.deepEqual(clock.sleeps, []);
});

test('stops as PartialStop when retry-after exceeds the primary wait cap, without sleeping', async () => {
  const { client, calls, clock } = clientFor([
    { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'retry-after': '301' } },
  ], { maxPrimaryWaitMs: 300_000 });
  await assert.rejects(client.request('GET', '/x'), (err) => err instanceof PartialStop && err.reason === 'rate-limit');
  assert.deepEqual(clock.sleeps, []);
  assert.equal(calls.length, 1);
});

test('honours retry-after on a secondary rate limit', async () => {
  const { client, clock } = clientFor([
    { status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: { 'retry-after': '7' } },
    { body: {} },
  ]);
  await client.request('GET', '/x');
  assert.deepEqual(clock.sleeps, [7000]);
});

test('waits 60 s on a secondary-limit message without retry-after', async () => {
  const { client, clock } = clientFor([
    { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } },
    { body: {} },
  ]);
  await client.request('GET', '/x');
  assert.deepEqual(clock.sleeps, [60_000]);
});

test('a permission 403 is not retried', async () => {
  const { client, calls } = clientFor([{ status: 403, body: { message: 'Resource not accessible by personal access token' } }]);
  await assert.rejects(client.request('POST', '/x', {}), (err) => err instanceof GitHubError && err.status === 403
    && err.message === 'Resource not accessible by personal access token');
  assert.equal(calls.length, 1);
});

test('4xx errors carry the status and GitHub message', async () => {
  const { client } = clientFor([{ status: 422, body: { message: 'Reference already exists' } }]);
  await assert.rejects(client.request('POST', '/x', {}), (err) => err.status === 422 && err.message === 'Reference already exists');
});

test('writes are paced at least 1 s apart', async () => {
  const { client, clock } = clientFor([{ status: 201, body: {} }, { status: 201, body: {} }]);
  await client.request('POST', '/a', {});
  await client.request('POST', '/b', {});
  assert.deepEqual(clock.sleeps, [1000]);
});

test('the write budget ends the run as PartialStop without sending the request', async () => {
  const { client, calls } = clientFor([{ status: 201, body: {} }], { maxWrites: 1 });
  await client.request('POST', '/a', {});
  assert.equal(client.writesRemaining(), 0);
  await assert.rejects(client.request('PATCH', '/b', {}), (err) => err instanceof PartialStop && err.reason === 'write-budget');
  assert.equal(calls.length, 1);
});

test('GETs do not consume the write budget', async () => {
  const { client } = clientFor([{ body: {} }], { maxWrites: 0 });
  await client.request('GET', '/x');
  assert.equal(client.writesRemaining(), 0);
});

test('paginate follows Link rel="next" on the API host', async () => {
  const { client, calls } = clientFor([
    { body: [1, 2], headers: { link: '<https://api.github.com/x?per_page=100&page=2>; rel="next", <https://api.github.com/x?per_page=100&page=2>; rel="last"' } },
    { body: [3] },
  ]);
  assert.deepEqual(await client.paginate('/x'), [1, 2, 3]);
  assert.equal(calls[0].url, 'https://api.github.com/x?per_page=100');
  assert.equal(calls[1].url, 'https://api.github.com/x?per_page=100&page=2');
});

test('paginate refuses to follow a link off the API host', async () => {
  const { client } = clientFor([{ body: [1], headers: { link: '<https://evil.example/x?page=2>; rel="next"' } }]);
  await assert.rejects(client.paginate('/x'), /off the API host/);
});

test('refPath encodes each segment but keeps slashes', () => {
  assert.equal(refPath('heads/feature/x#1%+ñ'), 'heads/feature/x%231%25%2B%C3%B1');
});

test('isWorkflowPermissionError recognises GitHub\'s workflow refusal', () => {
  const refusal = new GitHubError(422, 'refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope');
  assert.equal(isWorkflowPermissionError(refusal), true);
  assert.equal(isWorkflowPermissionError(new GitHubError(422, 'Reference already exists')), false);
  assert.equal(isWorkflowPermissionError(new Error('refusing to allow workflow')), false);
});
