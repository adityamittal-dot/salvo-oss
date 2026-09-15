// Separate discovery pass for the INDIAN market: onsite/hybrid/remote
// internships AND entry-level roles physically based in India.
//
// Why this needs its own script rather than a profile.yaml tweak: the main
// scan.mjs profile is remote-first (`location.remote_only: true`) and
// lib/filter.mjs's isHybridOnsite() hard-excludes any posting whose location
// field says "hybrid" or "onsite" — a real, deliberate rule for a
// remote-from-India applicant searching GLOBAL companies (it's what keeps
// e.g. Cloudflare's Austin-hybrid posting out of the main queue). But
// someone physically based in India is not remote-only for a role that's
// actually IN India — an onsite Bengaluru posting is exactly what this pass
// wants, not what it should exclude. So this reuses the same
// providers/boards and the same title/domain logic as the main filter
// (titleMatches — covers both "Backend Engineer" and "Backend Engineer
// Intern"), but with its own location rule: no remote_only gate, no
// hybrid/onsite exclusion — only "is this in India".
//
// Scope: covers every source in config/boards.yaml, including the
// India-specific `unstop` provider (internships + entry-level jobs posted
// directly on Unstop) alongside the global Greenhouse/Ashby/Lever companies'
// India postings. Still an honest partial slice, not a scrape of every
// Indian job site — Naukri/Indeed India aren't wired up (heavier anti-bot
// postures than Unstop's openly-public search API).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, loadProfile, loadBoards } from './lib/config.mjs';
import { isFresh, requiresExperience, titleMatches, isInternship, scoreJob, INDIA_CITIES } from './lib/filter.mjs';
import { fetchAllJobs } from './lib/discover.mjs';

const lower = (s) => String(s ?? '').toLowerCase();
const normalize = (s) => lower(s).replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
const anyMatch = (haystack, needles = []) => {
  const h = normalize(haystack);
  return needles.some((n) => h.includes(normalize(n)));
};

function isIndiaLocation(job) {
  const loc = lower(job.location);
  return /\bindia\b/.test(loc) || INDIA_CITIES.test(loc);
}

async function main() {
  const [profile, boards] = await Promise.all([loadProfile(), loadBoards()]);
  const { jobs: deduped } = await fetchAllJobs(boards);

  const kept = [];
  const stats = { total: deduped.length, stale: 0, offIndia: 0, offTitle: 0, unpaid: 0, experience: 0, kept: 0 };

  for (const job of deduped) {
    if (!isFresh(job, profile.freshness_days ?? 30)) {
      stats.stale++;
      continue;
    }
    if (!isIndiaLocation(job)) {
      stats.offIndia++;
      continue;
    }
    // Same domain-scoped title logic as the main pipeline: target.titles
    // (backend/full-stack/AI/etc, any seniority word already excluded) OR an
    // internship signal + tech-domain marker. This is what keeps this list
    // to "intern or entry-level software-adjacent roles" per the user's own
    // scope, not every internship/job Unstop lists (most of which are
    // sales/marketing/finance).
    if (!titleMatches(job, profile.target)) {
      stats.offTitle++;
      continue;
    }
    const blob = lower(`${job.title} ${job.description} ${job.location}`);
    if (anyMatch(blob, profile.compensation?.deny)) {
      stats.unpaid++;
      continue;
    }
    if (requiresExperience(blob)) {
      stats.experience++;
      continue;
    }
    kept.push({ ...job, ...scoreJob(job, profile), isInternship: isInternship(job, profile.target) });
    stats.kept++;
  }

  kept.sort((a, b) => b.score - a.score);

  console.log(
    `Raw ${stats.total} → dropped ${stats.stale} stale / ${stats.offIndia} outside India / ` +
      `${stats.offTitle} off-title / ${stats.unpaid} unpaid / ${stats.experience} requires-experience ` +
      `→ kept ${stats.kept}`,
  );

  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(
    join(ROOT, 'data/pipeline-india.json'),
    JSON.stringify({ scannedAt: new Date().toISOString(), stats, jobs: kept }, null, 2),
  );
  console.log('\nWrote data/pipeline-india.json');

  if (kept.length) {
    console.log('\nTop matches:');
    for (const j of kept.slice(0, 20)) {
      console.log(`  ${j.score.toFixed(2)} ${j.isInternship ? '[Intern]' : '[Entry] '} ${j.company} — ${j.title}`);
      console.log(`        ${j.location}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
