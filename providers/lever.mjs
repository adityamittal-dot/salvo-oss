// Lever — public postings API.
// https://api.lever.co/v0/postings/{slug}?mode=json
import { fetchJsonWithRetry } from './_http.mjs';

const ALLOWED_HOSTS = new Set(['api.lever.co']);

function assertUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lever: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`lever: must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`lever: untrusted host "${parsed.hostname}"`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) return assertUrl(entry.api);
  const slug = entry.slug || (entry.careers_url || '').match(/jobs\.lever\.co\/([^/?#]+)/)?.[1];
  if (!slug) return null;
  return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
}

export default {
  id: 'lever',

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
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    assertUrl(apiUrl);

    const json = await fetchJsonWithRetry(apiUrl, { redirect: 'error' });
    const postings = Array.isArray(json) ? json : [];

    return postings
      .map((p) => {
        if (!p?.text || !p?.hostedUrl) return null;
        const loc = p.categories?.location || '';
        const commitment = p.categories?.commitment || '';
        const workplace = p.workplaceType || '';
        return {
          title: String(p.text),
          url: String(p.hostedUrl),
          company: entry.name,
          location: [loc, workplace, commitment].filter(Boolean).join(' · '),
          description: typeof p.descriptionPlain === 'string' ? p.descriptionPlain : '',
          postedAt: Number.isFinite(p.createdAt) ? p.createdAt : undefined,
          source: 'lever',
          ats: 'lever',
        };
      })
      .filter(Boolean);
  },
};
