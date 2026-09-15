// Hacker News "Ask HN: Who is hiring?" — the monthly thread, via the public
// Algolia HN API. High signal for remote / startup roles that never reach a
// job board. Board-wide feed: explicit `provider: hn-hiring`.
//
// Each top-level comment is one company's posting, free-form. We parse the
// conventional first line (`Company | Role | Location | REMOTE | ...`) and keep
// the whole comment as the description so the scorer can still read it when the
// header does not follow the convention.
import { fetchJsonWithRetry } from './_http.mjs';

const SEARCH_URL =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=hiring';
const ITEM_URL = 'https://hn.algolia.com/api/v1/items/';

function stripHtml(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<p>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Acme Corp | Senior Backend | Remote (EU) | $120k" -> company + title + location
export function parseHeader(text) {
  const firstLine = text.split(/\n|\. /)[0] || '';
  const parts = firstLine.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { company: parts[0] || 'Unknown', title: '', location: '' };
  const [company, ...rest] = parts;
  const locationPart = rest.find((p) => /remote|onsite|hybrid|,|\bUS\b|\bEU\b|\bUK\b/i.test(p)) || '';
  const titlePart = rest.find((p) => p !== locationPart) || '';
  return { company, title: titlePart, location: locationPart };
}

export default {
  id: 'hn-hiring',

  detect(entry) {
    return entry?.provider === 'hn-hiring' ? { url: SEARCH_URL } : null;
  },

  async fetch() {
    const search = await fetchJsonWithRetry(SEARCH_URL, { redirect: 'error' });
    const stories = Array.isArray(search?.hits) ? search.hits : [];
    const latest = stories.find((s) => /who is hiring/i.test(s?.title || ''));
    if (!latest?.objectID) return [];

    const thread = await fetchJsonWithRetry(
      `${ITEM_URL}${encodeURIComponent(latest.objectID)}`,
      { redirect: 'error', timeoutMs: 30_000 },
    );
    const comments = Array.isArray(thread?.children) ? thread.children : [];

    return comments
      .map((c) => {
        if (!c?.text || c.author === null) return null;
        const text = stripHtml(c.text);
        if (text.length < 40) return null;
        const { company, title, location } = parseHeader(text);
        return {
          title: title || 'See posting',
          url: `https://news.ycombinator.com/item?id=${c.id}`,
          company: company || 'Unknown',
          location: location || (/remote/i.test(text) ? 'Remote' : ''),
          description: text.slice(0, 4000),
          postedAt: c.created_at_i ? c.created_at_i * 1000 : undefined,
          source: 'hn-hiring',
          ats: 'hn',
        };
      })
      .filter(Boolean);
  },
};
