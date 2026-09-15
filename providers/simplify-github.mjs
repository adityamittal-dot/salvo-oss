// SimplifyJobs' community-maintained internship and new-grad lists on GitHub.
// The README is a table, but the repo also ships the structured JSON behind
// it, which carries sponsorship and location as real fields.
//
// Board-wide feed, explicit `provider: simplify-github` with `repo:` set to
// one of the keys in REPOS. Every posting links to the employer's own
// application page — no Simplify account is involved.
import { fetchJsonWithRetry } from './_http.mjs';

const REPOS = {
  'internships-2027': 'SimplifyJobs/Summer2027-Internships',
  'internships-2026': 'SimplifyJobs/Summer2026-Internships',
  'new-grad': 'SimplifyJobs/New-Grad-Positions',
};

const jsonUrl = (repo) =>
  `https://raw.githubusercontent.com/${repo}/dev/.github/scripts/listings.json`;

// Categories that are never a fit for a software candidate.
const SKIP_CATEGORIES = new Set(['Hardware', 'Quant', 'Product', 'Design', 'Other']);

export default {
  id: 'simplify-github',

  detect(entry) {
    if (entry?.provider !== 'simplify-github') return null;
    const repo = REPOS[entry.repo];
    return repo ? { url: jsonUrl(repo) } : null;
  },

  async fetch(entry) {
    const repo = REPOS[entry.repo];
    if (!repo) throw new Error(`simplify-github: unknown repo "${entry.repo}" — use one of ${Object.keys(REPOS).join(', ')}`);

    const list = await fetchJsonWithRetry(jsonUrl(repo), { redirect: 'error', timeoutMs: 30_000 });
    if (!Array.isArray(list)) throw new Error('simplify-github: expected a JSON array');

    return list
      .map((j) => {
        if (!j?.active || j.is_visible === false) return null;
        if (!j.title || !j.url || !j.company_name) return null;
        if (SKIP_CATEGORIES.has(j.category)) return null;
        // Structured flag — far more reliable than keyword-matching the body.
        if (j.sponsorship === 'U.S. Citizenship is Required') return null;

        const locations = Array.isArray(j.locations) ? j.locations : [];
        const parts = [...locations];
        if (j.sponsorship === 'Offers Sponsorship') parts.push('Offers Sponsorship');

        const posted = Number(j.date_posted || j.date_updated);
        return {
          title: String(j.title),
          url: String(j.url),
          company: String(j.company_name),
          location: parts.join(' · '),
          description: [
            j.category ? `Category: ${j.category}` : '',
            Array.isArray(j.terms) ? `Terms: ${j.terms.join(', ')}` : '',
            `Sponsorship: ${j.sponsorship || 'unstated'}`,
            Array.isArray(j.degrees) ? `Degrees: ${j.degrees.join(', ')}` : '',
          ].filter(Boolean).join('\n'),
          postedAt: Number.isFinite(posted) && posted > 0 ? posted * 1000 : undefined,
          source: 'simplify-github',
          ats: 'external',
          sponsorship: j.sponsorship,
        };
      })
      .filter(Boolean);
  },
};
