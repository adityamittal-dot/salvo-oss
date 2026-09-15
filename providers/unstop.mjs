// Unstop (unstop.com) — India-focused internships/jobs board. Public search
// API, no login: robots.txt explicitly Allows `/api/public/*` (and
// `/internship/`, `/job/` detail pages) for User-agent: *, so this is the
// same "public zero-auth endpoint" contract as remoteok/remotive/hn-hiring,
// just India-market instead of global-remote.
//
// Why keyword search instead of one bulk pull: Unstop's `jobs`/`internships`
// feeds are dominated by sales/marketing/finance postings (confirmed by
// hand — an unfiltered `jobs` pull returned ~850 results, filtered to ~1 in 6
// being remotely tech-adjacent). Searching per tech term server-side is the
// same thing a human doing this search on the site would do, and keeps the
// raw volume down before lib/filter.mjs's title/domain checks run.
import { fetchJsonWithRetry, sleep } from './_http.mjs';

const BASE_URL = 'https://unstop.com/api/public/opportunity/search-result';
const SUBTYPES = ['internships', 'jobs'];

// One search per term per subtype — kept aligned with the profile's actual
// target domain (config/profile.yaml target.titles / tech_domain_markers),
// not a generic "software" catch-all, so this doesn't reintroduce the same
// off-domain-leak class of bug fixed in lib/filter.mjs's titleMatches.
const DEFAULT_TERMS = [
  'software engineer', 'software developer', 'backend', 'full stack',
  'python', 'django', 'node', 'react', 'javascript', 'java developer',
  'ai engineer', 'machine learning', 'data engineer', 'devops', 'cloud',
  'golang', 'sde',
];

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLocation(record) {
  const jd = record.jobDetail || {};
  const cities = Array.isArray(jd.locations) ? jd.locations.filter(Boolean) : [];
  const typeLabel = { wfh: 'Remote', in_office: 'On-site', hybrid: 'Hybrid' }[jd.type] || '';
  if (cities.length) return `${cities.join(', ')}${typeLabel ? ` (${typeLabel})` : ''}, India`;
  if (typeLabel === 'Remote') return 'Remote, India';
  return 'India';
}

function buildDescription(record) {
  const jd = record.jobDetail || {};
  const skills = (record.required_skills || []).map((s) => s.skill_name || s.skill).filter(Boolean);
  const parts = [stripHtml(record.details)];
  if (skills.length) parts.push(`Skills: ${skills.join(', ')}.`);
  if (jd.min_experience != null || jd.max_experience != null) {
    parts.push(`Experience: ${jd.min_experience ?? 0}-${jd.max_experience ?? jd.min_experience ?? 0} years.`);
  }
  return parts.filter(Boolean).join(' ').slice(0, 4000);
}

// Paid-only, at the source — the user explicitly asked for paid opportunities
// only. Unstop's own structured field is more reliable here than a text-deny
// list would be (which is how lib/filter.mjs's compensation.deny works for
// every other provider — this just does the same job earlier and more
// precisely for a source where "unpaid" is a first-class, structured value).
function isPaid(record) {
  if (record.isPaid === true) return true;
  const p = record.jobDetail?.paid_unpaid;
  if (p) return p === 'paid';
  return record.isPaid !== false; // unknown -> keep, let the rest of the pipeline judge
}

async function fetchOnePage(subtype, term) {
  const url = `${BASE_URL}?opportunity=${subtype}&per_page=50&oppstatus=open&searchTerm=${encodeURIComponent(term)}`;
  const json = await fetchJsonWithRetry(
    url,
    { userAgent: 'Mozilla/5.0 (compatible; salvo-oss job-search tool; +https://github.com/adityamittal-dot/salvo-oss)' },
    { retries: 2 },
  );
  return Array.isArray(json?.data?.data) ? json.data.data : [];
}

export default {
  id: 'unstop',

  detect(entry) {
    return entry?.provider === 'unstop' ? { url: BASE_URL } : null;
  },

  async fetch(entry) {
    const terms = entry.searchTerms || DEFAULT_TERMS;
    const byId = new Map();

    for (const subtype of SUBTYPES) {
      for (const term of terms) {
        let records;
        try {
          records = await fetchOnePage(subtype, term);
        } catch {
          continue; // one bad term/subtype combo shouldn't fail the whole scan
        }
        for (const r of records) {
          if (r?.id) byId.set(r.id, r);
        }
        // Gentle pacing — this is ~34 sequential requests to one host per scan.
        await sleep(300);
      }
    }

    const jobs = [];
    for (const record of byId.values()) {
      if (!record.title || !record.seo_url) continue;
      if (!isPaid(record)) continue;
      jobs.push({
        title: String(record.title),
        url: String(record.seo_url),
        company: record.organisation?.name || 'Unknown',
        location: buildLocation(record),
        description: buildDescription(record),
        postedAt: Date.parse(record.approved_date || record.updated_at) || undefined,
        source: 'unstop',
        ats: 'unstop',
      });
    }
    return jobs;
  },
};
