// Greenhouse — public board API, one entry per company slug.
// https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
import { fetchJsonWithRetry, toEpochMs } from './_http.mjs';

const ALLOWED_HOSTS = new Set(['boards-api.greenhouse.io', 'boards.greenhouse.io']);

function assertUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted host "${parsed.hostname}"`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) return assertUrl(entry.api);
  const slug = entry.slug || (entry.careers_url || '').match(/greenhouse\.io\/([^/?#]+)/)?.[1];
  if (!slug) return null;
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
}

// Greenhouse ships `content` as HTML-escaped HTML.
function stripHtml(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default {
  id: 'greenhouse',

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
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertUrl(apiUrl);

    const json = await fetchJsonWithRetry(apiUrl, { redirect: 'error' });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];

    return jobs
      .map((j) => {
        if (!j?.title || !j?.absolute_url) return null;
        return {
          title: String(j.title),
          url: String(j.absolute_url),
          company: entry.name,
          location: j.location?.name || '',
          description: stripHtml(j.content),
          postedAt: toEpochMs(j.updated_at || j.first_published),
          source: 'greenhouse',
          ats: 'greenhouse',
        };
      })
      .filter(Boolean);
  },
};
