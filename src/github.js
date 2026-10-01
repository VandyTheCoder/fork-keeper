import { PartialStop } from './errors.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const SECONDARY_LIMIT_WAIT_MS = 60_000;
const WORKFLOW_REFUSAL = /refusing to allow .*workflow/i;

export class GitHubError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'GitHubError';
    this.status = status; // 0 means the request never got an HTTP response
    this.body = body;
  }
}

export function refPath(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

export function isWorkflowPermissionError(err) {
  return err instanceof GitHubError && WORKFLOW_REFUSAL.test(err.message);
}

export function createClient({
  token,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  baseUrl = 'https://api.github.com',
  writeGapMs = 1000,
  maxWrites = 400,
  maxPrimaryWaitMs = 5 * 60_000,
}) {
  let writes = 0;
  let lastWriteAt = -Infinity;

  function headers(hasBody) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fork-keeper',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  // null = not a rate limit; Infinity = limited for too long; else ms to wait.
  function rateLimitWait(res, message) {
    if (res.status !== 403 && res.status !== 429) return null;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter !== null) {
      const waitMs = Number(retryAfter) * 1000;
      return waitMs <= maxPrimaryWaitMs ? waitMs : Infinity;
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const waitMs = Math.max(0, Number(res.headers.get('x-ratelimit-reset')) * 1000 - now()) + 1000;
      return waitMs <= maxPrimaryWaitMs ? waitMs : Infinity;
    }
    if (res.status === 429 || /secondary rate limit/i.test(message)) return SECONDARY_LIMIT_WAIT_MS;
    return null;
  }

  async function send(method, url, body) {
    for (let attempt = 0; ; attempt += 1) {
      const canRetry = attempt < RETRY_DELAYS_MS.length;
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: headers(body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (cause) {
        if (canRetry) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new GitHubError(0, `Network error talking to GitHub: ${cause.message}`);
      }

      const text = await res.text();
      const data = text ? parseJson(text) : null;
      if (res.ok) return { data, headers: res.headers };

      const message = data?.message ?? `HTTP ${res.status}`;
      const wait = rateLimitWait(res, message);
      if (wait !== null) {
        if (wait === Infinity || !canRetry) throw new PartialStop('rate-limit');
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && canRetry) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new GitHubError(res.status, message, data);
    }
  }

  async function beforeWrite() {
    if (writes >= maxWrites) throw new PartialStop('write-budget');
    const gap = lastWriteAt + writeGapMs - now();
    if (gap > 0) await sleep(gap);
    writes += 1;
    lastWriteAt = now();
  }

  async function request(method, path, body) {
    if (method !== 'GET') await beforeWrite();
    return (await send(method, `${baseUrl}${path}`, body)).data;
  }

  async function paginate(path) {
    const items = [];
    let url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (url) {
      const { data, headers: responseHeaders } = await send('GET', url);
      if (Array.isArray(data)) items.push(...data);
      url = nextLink(responseHeaders.get('link'));
      if (url && !url.startsWith(`${baseUrl}/`)) {
        throw new GitHubError(0, 'Refusing to follow a pagination link off the API host');
      }
    }
    return items;
  }

  return { request, paginate, writesRemaining: () => maxWrites - writes };
}

function nextLink(header) {
  const next = header?.split(',').find((part) => /rel="next"/.test(part));
  return next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}
