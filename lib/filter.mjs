// Filtering and fit-scoring. Pure functions over a normalized Job — no I/O, so
// this is the piece that is cheap to test and to reason about.

const lower = (s) => String(s ?? '').toLowerCase();

export const INDIA_CITIES = /\b(noida|delhi|gurgaon|gurugram|bangalore|bengaluru|hyderabad|pune|mumbai|chennai|kolkata|jaipur|ahmedabad|kochi|cochin|chandigarh|coimbatore|indore|lucknow|nagpur|surat|vadodara|udaipur)\b/;

// Countries that commonly appear as "Remote - <Country>" and mean remote
// *within* that country. India is excluded on purpose.
const LOCKED_COUNTRIES = [
  'united kingdom', 'uk', 'ireland', 'germany', 'france', 'spain', 'sweden',
  'netherlands', 'poland', 'portugal', 'italy', 'denmark', 'norway', 'finland',
  'switzerland', 'austria', 'belgium', 'canada', 'australia', 'new zealand',
  'brazil', 'mexico', 'argentina', 'japan', 'korea', 'israel', 'singapore',
  'estonia', 'latvia', 'lithuania', 'czech republic', 'romania', 'greece',
  'hungary', 'slovakia', 'slovenia', 'croatia', 'iceland', 'luxembourg',
];

// Matches "2+ years", "3 years", "2-3 years", "5+ years", "8-10 years" —
// any stated floor of 2 through 10 years. Deliberately does NOT match "0-2
// years" or "1-2 years": those ranges include 0/1, meaning a true beginner
// still qualifies. The negative lookbehind is what tells those two cases
// apart.
//
// Hard exclude, not a soft down-rank — per explicit user decision
// (2026-09-14) to target ONLY entry-level/internship roles, no experienced
// roles at all. This used to be two separate soft penalties (a -0.6 nudge
// for 2-4yr, a -1 nudge for 5+yr); both are gone now that either case drops
// the posting from the queue entirely.
//
// Known imprecision, accepted because a false match here only loses one
// otherwise-attainable posting, not the reverse: "founded 3 years ago"
// would also match and get excluded.
export function requiresExperience(blob) {
  return /(?<!\b[01]\s*[-–]\s*)\b([2-9]|10)\+?\s*(?:[-–]\s*\d+\+?\s*)?years?\b/i.test(blob);
}

function countryLockedRemote(loc) {
  if (!/remote/.test(loc)) return null;
  if (/\b(global|worldwide|anywhere|everywhere|emea|apac|asia|india)\b/.test(loc)) return null;
  for (const c of LOCKED_COUNTRIES) {
    if (new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(loc)) return c;
  }
  return null;
}

// A hard exclude, not a soft down-rank like countryLockedRemote — WORK_AUTH_US
// is "no", and a US company's "remote" posting almost always means remote
// *within* the US, even when it separately says it offers sponsorship (that
// means visa sponsorship for someone relocating to the US on OPT/CPT/H-1B,
// not permission to work from India).
//
// Deliberately scoped to the location FIELD only, never the full JD body:
// "us" is one of the most common words in English prose ("join us", "let us
// know"), so checking it against free-form description text would false-
// positive constantly. A location field is short and structured — "US" only
// ever appears there as the country abbreviation — so it's safe there.
//
// Uses a word-boundary regex rather than literal deny-list phrases on
// purpose: a phrase list needs every connector word enumerated ("Remote -
// US", "Remote (US)", "US Remote" ...) and still missed "Remote in USA" in
// production (confirmed: 27 of 118 queued jobs were exactly this phrase).
// Also catches "North America" — found via a real leak (Hightouch's "Remote
// (North America)" posting, paired with an explicit E-Verify requirement in
// the JD body, i.e. US work-eligibility) — which names neither "US"/"USA"
// nor a LOCKED_COUNTRIES entry, so it cleared both existing checks.
function isUsLockedRemote(loc) {
  const l = normalize(loc);
  if (!/\bremote\b/.test(l)) return false;
  if (/\b(global|worldwide|anywhere|everywhere|emea|apac|asia|india)\b/.test(l)) return false;
  return /\b(usa|us|united states|north america)\b/.test(l);
}

// A hard exclude, scoped to the location FIELD only — never the JD body —
// for the same reason as isUsLockedRemote: "hybrid" shows up constantly in
// unrelated benefits copy ("flexible hybrid work model") and would false-
// positive on genuinely remote postings if checked against the whole JD.
//
// Found via a real leak: Cloudflare's location field was literally "Hybrid"
// (Austin, in-person days required, no sponsorship for export-controlled
// work) but the *title* — "Systems Engineer - Global Resource Management" —
// contains "global", an allow-list keyword, so the posting cleared
// locationMatches() anyway. The allow check spans location+title on
// purpose (titles do sometimes say "Remote"), so a false match on an
// unrelated word in the title needs its own hard stop rather than a tweak
// to the allow list.
function isHybridOnsite(loc) {
  return /\b(hybrid|on-?site)\b/.test(normalize(loc));
}

// Collapses hyphens/underscores/periods to spaces before matching, so a deny
// phrase written as "us based only" also catches "US-Based Only" or
// "us_based_only" — real postings are not consistent about punctuation, and
// a literal substring match silently misses variants (confirmed: a genuine
// "REMOTE (US-Based Only)" posting slipped past "us based only" this way).
function normalize(s) {
  return lower(s).replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
}

function anyMatch(haystack, needles = []) {
  const h = normalize(haystack);
  return needles.some((n) => h.includes(normalize(n)));
}

export function isFresh(job, freshnessDays) {
  if (!job.postedAt) return true; // Unknown date: keep, let scoring decide.
  const ageMs = Date.now() - job.postedAt;
  return ageMs <= freshnessDays * 24 * 60 * 60 * 1000;
}

// Real gap found by hand (2026-09-15): internship_titles words ("intern",
// "new grad", "campus", "global"...) are early-career SIGNALS, not domain
// signals — "Finance Analytics Intern", "Customer Analytics & Insights
// Global Early Career Professional" and "T&D Performance and Reliability
// Engineering Intern" all matched purely because they say "intern"/"global",
// regardless of subject. An internship-titles match on its own is no longer
// sufficient — it also needs a tech-domain word from tech_domain_markers, so
// a non-tech internship at a tech-adjacent-sounding company still gets
// excluded. A target.titles match (already domain-specific: "software
// engineer", "backend", "ai engineer"...) is unaffected and still passes on
// its own.
export function titleMatches(job, target) {
  const title = lower(job.title);
  if (anyMatch(title, target.exclude_titles)) return false;
  if (anyMatch(title, target.titles || [])) return true;
  if (!anyMatch(title, target.internship_titles || [])) return false;
  return anyMatch(title, target.tech_domain_markers || []);
}

export function isInternship(job, target) {
  return anyMatch(job.title, target.internship_titles || []);
}

// Deny terms are checked against the whole posting — a geographic restriction
// is usually stated in the body ("must be authorized to work in the US"), not
// in the location field.
//
// Allow terms are checked against the location field and title ONLY. Checking
// them against the description too was letting US-onsite roles through: almost
// every JD mentions "United States" somewhere, so an allow list containing
// country names matched on boilerplate rather than on actual eligibility.
export function locationMatches(job, locationCfg) {
  const whole = `${job.location} ${job.title} ${job.description}`;
  if (anyMatch(whole, locationCfg.deny)) return false;
  if (isUsLockedRemote(job.location)) return false;
  if (isHybridOnsite(job.location)) return false;
  if (!locationCfg.remote_only) return true;
  return anyMatch(`${job.location} ${job.title}`, locationCfg.allow);
}

// Rule-based fit score, 0-5. Deterministic and free; the LLM pass in score.mjs
// refines only the jobs that clear this bar, so we never spend tokens on noise.
export function isUnpaid(job, compensationCfg) {
  return anyMatch(`${job.title} ${job.description}`, compensationCfg?.deny);
}

export function scoreJob(job, profile) {
  const blob = lower(`${job.title} ${job.description} ${job.location}`);
  const { skills, preference, target, compensation, location } = profile;

  let score = 0;
  const reasons = [];

  const primaryHits = (skills.primary || []).filter((s) => blob.includes(lower(s)));
  const secondaryHits = (skills.secondary || []).filter((s) => blob.includes(lower(s)));

  score += Math.min(primaryHits.length * 0.45, 2.0);
  score += Math.min(secondaryHits.length * 0.15, 0.6);
  if (primaryHits.length) reasons.push(`stack: ${primaryHits.slice(0, 5).join(', ')}`);

  if (titleMatches(job, target)) {
    score += 1.25;
    reasons.push('title match');
  }

  // Geographic eligibility is usually the binding constraint, so it's scored
  // from the location field directly rather than left to keyword boosts in
  // the body. A globally-open role and a role that merely says "Remote" are
  // not the same opportunity. "Home region eligible" is driven by YOUR OWN
  // `location.allow` list in profile.yaml (minus the generic global/remote
  // words, which are scored separately above) — customize that list for
  // wherever you actually are, this isn't hardcoded to any one country.
  const loc = lower(job.location);
  const restrictedTo = countryLockedRemote(loc);
  const genericAllowWords = new Set(['remote', 'worldwide', 'anywhere', 'global', 'distributed', 'everywhere']);
  const homeSignals = (location?.allow || []).filter((s) => !genericAllowWords.has(lower(s)));
  if (/\b(global|worldwide|anywhere|everywhere)\b/.test(loc)) {
    score += 1.25;
    reasons.push('open globally');
  } else if (homeSignals.length && anyMatch(loc, homeSignals)) {
    score += 1.0;
    reasons.push('home-region eligible');
  } else if (/\b(emea|asia|apac)\b/.test(loc)) {
    score += 0.75;
    reasons.push('EMEA/APAC region');
  } else if (restrictedTo) {
    // "Spain (Remote)" means remote *within Spain*. Not a hard drop — a few of
    // these do hire cross-border — but it belongs at the bottom of the queue.
    score -= 1.5;
    reasons.push(`remote but locked to ${restrictedTo}`);
  } else if (/remote/.test(loc)) {
    score += 0.35;
    reasons.push('remote, region unstated');
  }

  if (isInternship(job, target)) {
    score += 0.25;
    reasons.push('internship/early-career');
  }

  const boosts = (preference.boost_keywords || []).filter((k) => blob.includes(lower(k)));
  if (boosts.length) {
    score += Math.min(boosts.length * 0.3, 0.9);
    reasons.push(`open to remote/global: ${boosts.slice(0, 2).join(', ')}`);
  }

  const penalties = (preference.penalty_keywords || []).filter((k) => blob.includes(lower(k)));
  if (penalties.length) {
    score -= penalties.length * 1.5;
    reasons.push(`BLOCKER: ${penalties.slice(0, 2).join(', ')}`);
  }

  const unpaid = isUnpaid(job, compensation);
  if (unpaid) {
    score = 0;
    reasons.push('BLOCKER: unpaid/uncompensated');
  }

  return {
    score: Math.max(0, Math.min(5, Number(score.toFixed(2)))),
    reasons,
    blocked: penalties.length > 0 || unpaid,
  };
}

export function applyFilters(jobs, profile) {
  const kept = [];
  const stats = { total: jobs.length, stale: 0, title: 0, location: 0, experience: 0, kept: 0 };

  for (const job of jobs) {
    if (!isFresh(job, profile.freshness_days ?? 21)) {
      stats.stale++;
      continue;
    }
    if (!titleMatches(job, profile.target)) {
      stats.title++;
      continue;
    }
    if (!locationMatches(job, profile.location)) {
      stats.location++;
      continue;
    }
    // Hard exclude, applied before scoring: entry-level/internship only.
    if (requiresExperience(lower(`${job.title} ${job.description} ${job.location}`))) {
      stats.experience++;
      continue;
    }
    kept.push({ ...job, ...scoreJob(job, profile) });
    stats.kept++;
  }

  kept.sort((a, b) => b.score - a.score);
  return { jobs: kept, stats };
}

export function dedupe(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    const key = job.url;
    if (!key) continue;
    // Prefer the record with a description — aggregators often carry a stub.
    const prev = seen.get(key);
    if (!prev || (job.description?.length || 0) > (prev.description?.length || 0)) {
      seen.set(key, job);
    }
  }
  return [...seen.values()];
}
