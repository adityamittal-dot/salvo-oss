// Ashby — public posting-api. Heavily used by YC companies.
// Ashby carries a ~10s server-side latency floor and rate-limits repeated
// unauthenticated hits, so it gets a longer timeout and a slower backoff than
// the shared default (see career-ops providers/ashby.mjs for the diagnosis).
import { fetchJsonWithRetry, toEpochMs } from './_http.mjs';

const TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const ALLOWED_HOSTS = new Set(['api.ashbyhq.com']);

function assertUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ashby: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`ashby: must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`ashby: untrusted host "${parsed.hostname}"`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) return assertUrl(entry.api);
  const slug = entry.slug || (entry.careers_url || '').match(/jobs\.ashbyhq\.com\/([^/?#]+)/)?.[1];
  if (!slug) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
}

// workplaceType wins over isRemote: boards in the wild carry `isRemote: true`
// alongside `workplaceType: "Hybrid"` for office-anchored roles, and trusting
// isRemote alone defeats a remote-only filter.
function formatLocation(j) {
  const parts = [];
  if (typeof j.location === 'string' && j.location.trim()) parts.push(j.location.trim());
  if (Array.isArray(j.secondaryLocations)) {
    for (const s of j.secondaryLocations) {
      if (s?.location && typeof s.location === 'string') parts.push(s.location.trim());
    }
  }
  const wt = typeof j.workplaceType === 'string' ? j.workplaceType.trim().toLowerCase() : '';
  const isRemote = wt ? wt === 'remote' : j.isRemote === true;
  if (isRemote && !parts.some((p) => /remote/i.test(p))) parts.push('Remote');
  return [...new Set(parts)].join(' · ');
}

export default {
  id: 'ashby',

  detect(entry) {
    try {
      const url = resolveApiUrl(entry);
      return url ? { url } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);
    assertUrl(apiUrl);

    const json = await fetchJsonWithRetry(
      apiUrl,
      { timeoutMs: TIMEOUT_MS, redirect: 'error' },
      { retries: 2, baseDelayMs: BACKOFF_BASE_MS },
    );
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];

    return jobs
      .map((j) => {
        if (!j?.title || !j?.jobUrl) return null;
        return {
          title: String(j.title),
          url: String(j.jobUrl),
          company: entry.name,
          location: formatLocation(j),
          description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
          postedAt: toEpochMs(j.publishedAt),
          source: 'ashby',
          ats: 'ashby',
        };
      })
      .filter(Boolean);
  },
};
