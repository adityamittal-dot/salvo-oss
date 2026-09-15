// Tailors a resume + cover letter for every job in today's apply queue.
// Skips postings already tailored (a meta.json exists) unless --force.
// Sequential, not parallel: Gemini free-tier rate limits are per-minute, and
// tailoring is a one-time cost per posting, not something worth racing.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { ROOT, loadProfile } from './lib/config.mjs';
import { tailorForJob } from './tailor.mjs';
import { closeBrowser } from './lib/resume-render.mjs';

const GENERATED_DIR = join(ROOT, 'data/generated');
const DELAY_MS = 3000; // pace Gemini calls; also just less bursty overall

async function alreadyTailored(url) {
  if (!existsSync(GENERATED_DIR)) return false;
  const dirs = await readdir(GENERATED_DIR);
  for (const d of dirs) {
    const metaPath = join(GENERATED_DIR, d, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      if (meta.url === url) return true;
    } catch {
      // corrupt meta.json — treat as not tailored, will overwrite in a new dir
    }
  }
  return false;
}

async function main() {
  const force = process.argv.includes('--force');
  const profile = await loadProfile();
  const pipelinePath = join(ROOT, 'data/pipeline.json');
  if (!existsSync(pipelinePath)) throw new Error('data/pipeline.json not found — run `npm run scan` first');

  const pipeline = JSON.parse(await readFile(pipelinePath, 'utf8'));
  const target = profile.scoring.daily_apply_target;
  const queue = pipeline.jobs.filter((j) => j.score >= profile.scoring.apply_min && !j.blocked);

  const perCompany = new Map();
  const todaysQueue = [];
  for (const j of queue) {
    const n = perCompany.get(j.company) || 0;
    if (n >= profile.scoring.max_per_company) continue;
    perCompany.set(j.company, n + 1);
    todaysQueue.push(j);
    if (todaysQueue.length >= target) break;
  }

  console.log(`Tailoring up to ${todaysQueue.length} applications...\n`);

  let done = 0, skipped = 0, failed = 0;
  const needsReview = []; // overflowed the page budget even after auto-trim
  const failures = [];
  for (const job of todaysQueue) {
    if (!force && (await alreadyTailored(job.url))) {
      skipped++;
      continue;
    }
    try {
      const meta = await tailorForJob(job);
      done++;
      if (meta.pageCount > 1) {
        needsReview.push({ company: job.company, title: job.title, pageCount: meta.pageCount, dir: meta.slug });
      }
    } catch (err) {
      console.error(`  FAILED ${job.company} — ${job.title}: ${err.message}`);
      failures.push({ company: job.company, title: job.title, error: err.message });
      failed++;
    }
    if (done + failed < todaysQueue.length) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone: ${done} tailored, ${skipped} already had a resume, ${failed} failed.`);

  // Aggregated so these don't get lost scrolling back through 25 jobs' worth
  // of per-job console output — this is the punch list to actually look at.
  if (needsReview.length) {
    console.log(`\n${needsReview.length} NEED A MANUAL LOOK (still >1 page after auto-trim):`);
    for (const r of needsReview) {
      console.log(`  ${r.company} — ${r.title} (${r.pageCount} pages) -> data/generated/${r.dir}/resume.pdf`);
    }
  }
  if (failures.length) {
    console.log(`\n${failures.length} FAILED (no resume generated):`);
    for (const f of failures) {
      console.log(`  ${f.company} — ${f.title}: ${f.error}`);
    }
  }
  if (!needsReview.length && !failures.length && done > 0) {
    console.log('All tailored resumes fit one page cleanly.');
  }

  console.log('\nRun `npm run track` to pull the file links into data/applications.xlsx.');
  await closeBrowser();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(err.message);
    await closeBrowser();
    process.exit(1);
  });
}
