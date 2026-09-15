// RemoteOK — free public JSON feed, remote-only by construction.
// Board-wide feed: reached via an explicit `provider: remoteok` entry.
// The first array element is RemoteOK's legal notice, not a job.
import { fetchJsonWithRetry, toEpochMs, BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const FEED_URL = 'https://remoteok.com/api';

// RemoteOK's own API serves some non-English postings with double-encoded
// UTF-8: a real UTF-8 multi-byte sequence (e.g. U+2019 RIGHT SINGLE QUOTATION
// MARK, bytes E2 80 99) gets misread upstream as three separate Latin-1
// characters and re-escaped into the JSON as â — confirmed
// by inspecting the raw API bytes directly, not something happening in this
// project's fetch layer.
//
// Detect the pattern (a Latin-1-range UTF-8 "lead byte" — 0xC2/0xC3/0xE2/0xE3
// as a code point — followed by a Latin-1-range "continuation byte", 0x80-0xBF
// as a code point) and repair it by reinterpreting the JS string's code units
// as raw Latin-1 bytes, then decoding those bytes as UTF-8. Scoped to strings
// that actually show the pattern — running this on already-correct text would
// corrupt any genuine character above U+00FF.
const MOJIBAKE_RE = /[ÂÃâã][-¿]/;

function fixMojibake(str) {
  if (typeof str !== 'string' || !MOJIBAKE_RE.test(str)) return str;
  try {
    return Buffer.from(str, 'latin1').toString('utf8');
  } catch {
    return str; // repair attempt failed — return the original rather than throw
  }
}

export default {
  id: 'remoteok',

  detect(entry) {
    return entry?.provider === 'remoteok' ? { url: FEED_URL } : null;
  },

  async fetch(entry) {
    const json = await fetchJsonWithRetry(FEED_URL, {
      redirect: 'error',
      userAgent: BROWSER_LIKE_USER_AGENT,
    });
    if (!Array.isArray(json)) return [];

    return json
      .map((j) => {
        // The legal-notice element has no position/company.
        if (!j || typeof j !== 'object') return null;
        const title = j.position || j.title;
        if (!title || !j.url) return null;
        const tags = Array.isArray(j.tags) ? j.tags.join(', ') : '';
        return {
          title: fixMojibake(String(title)),
          url: String(j.url),
          company: fixMojibake(j.company) || 'Unknown',
          location: fixMojibake(j.location) || 'Remote',
          description: fixMojibake([j.description, tags].filter(Boolean).join('\n').slice(0, 4000)),
          postedAt: toEpochMs(j.date),
          source: 'remoteok',
          ats: 'remoteok',
        };
      })
      .filter(Boolean);
  },
};
