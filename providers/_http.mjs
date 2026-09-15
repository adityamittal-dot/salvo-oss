// Shared fetch helpers for providers. Adapted from career-ops' providers/_http.mjs.
// Every provider call goes through here so timeout, User-Agent and retry policy
// are uniform, and so no provider ever calls bare fetch().

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'salvo-oss/0.1 (personal job search tool; +https://github.com/adityamittal-dot/salvo-oss)';
export const BROWSER_LIKE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULT_POLICY = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

export function sleep(ms, ctx) {
  if (ctx?.sleep) return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

async function request(url, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: opts.redirect ?? 'follow',
      headers: {
        'User-Agent': opts.userAgent ?? USER_AGENT,
        Accept: opts.accept ?? 'application/json, text/plain, */*',
        ...opts.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      err.body = body.slice(0, 500);
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await request(url, opts);
  return res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await request(url, { accept: 'text/html,application/xhtml+xml,*/*', ...opts });
  return res.text();
}

function isRetryable(err) {
  if (err?.name === 'AbortError') return true;
  const s = err?.status;
  if (s === 429) return true;
  if (typeof s === 'number' && s >= 500) return true;
  // Transport-level failure carries no .status.
  return s === undefined && err instanceof Error && !/redirect/i.test(err.message);
}

// Retry-After is honoured but clamped: a hostile `Retry-After: 86400` must not
// stall the whole sweep.
function retryDelay(err, attempt, policy) {
  const header = Number(err?.retryAfter);
  if (Number.isFinite(header) && header > 0) {
    return Math.min(header * 1000, policy.maxDelayMs);
  }
  const backoff = policy.baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * policy.baseDelayMs;
  return Math.min(backoff + jitter, policy.maxDelayMs);
}

async function withRetry(fn, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  let lastErr;
  for (let attempt = 0; attempt <= p.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === p.retries || !isRetryable(err)) break;
      await sleep(retryDelay(err, attempt, p));
    }
  }
  lastErr.attempts = p.retries + 1;
  throw lastErr;
}

export function fetchJsonWithRetry(url, opts = {}, policy) {
  return withRetry(() => fetchJson(url, opts), policy);
}

export function fetchTextWithRetry(url, opts = {}, policy) {
  return withRetry(() => fetchText(url, opts), policy);
}

// NaN-safe Date.parse — `|| undefined` would also null a valid epoch 0.
export function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function safeEncodeURIComponent(value) {
  try {
    return encodeURIComponent(String(value));
  } catch {
    return null;
  }
}
