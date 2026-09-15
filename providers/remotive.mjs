// Remotive — free public JSON API, remote-only.
// Board-wide feed: reached via an explicit `provider: remotive` entry.
import { fetchJsonWithRetry, toEpochMs } from './_http.mjs';

const FEED_URL = 'https://remotive.com/api/remote-jobs';

// Remotive's software category is the only one worth pulling for this profile;
// the unfiltered feed is mostly sales/support noise.
const CATEGORY = 'software-dev';

export default {
  id: 'remotive',

  detect(entry) {
    return entry?.provider === 'remotive' ? { url: FEED_URL } : null;
  },

  async fetch(entry) {
    const url = `${FEED_URL}?category=${encodeURIComponent(entry.category || CATEGORY)}`;
    const json = await fetchJsonWithRetry(url, { redirect: 'error' });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];

    return jobs
      .map((j) => {
        if (!j?.title || !j?.url) return null;
        return {
          title: String(j.title),
          url: String(j.url),
          company: j.company_name || 'Unknown',
          location: j.candidate_required_location || 'Remote',
          description: typeof j.description === 'string'
            ? j.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)
            : '',
          postedAt: toEpochMs(j.publication_date),
          source: 'remotive',
          ats: 'remotive',
        };
      })
      .filter(Boolean);
  },
};
