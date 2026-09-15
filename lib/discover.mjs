// Shared source-fetching used by scan.mjs and any other discovery script
// (e.g. scan-india.mjs) — walks every entry in a boards config
// through the provider layer and returns the raw, deduped job list. Filtering
// and scoring are deliberately NOT done here: callers apply their own profile.
import { resolveProvider } from '../providers/_registry.mjs';
import { dedupe } from './filter.mjs';

const CONCURRENCY = 5;

async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchEntry(entry) {
  const resolved = await resolveProvider(entry);
  if (!resolved) {
    return { entry, jobs: [], error: 'no provider claimed this entry' };
  }
  try {
    const jobs = await resolved.provider.fetch(entry, {});
    if (!Array.isArray(jobs)) throw new Error('provider returned a non-array');
    return { entry, jobs, provider: resolved.provider.id };
  } catch (err) {
    return { entry, jobs: [], error: err.message, provider: resolved.provider.id };
  }
}

export async function fetchAllJobs(boards, { log = true } = {}) {
  const entries = [...(boards.job_boards || []), ...(boards.tracked_companies || [])];
  if (log) console.log(`Scanning ${entries.length} sources...\n`);

  const results = await pool(entries, CONCURRENCY, fetchEntry);

  const all = [];
  const failures = [];
  for (const r of results) {
    if (r.error) {
      failures.push(`  ${r.entry.name}: ${r.error}`);
      continue;
    }
    if (log) console.log(`  ${String(r.jobs.length).padStart(4)}  ${r.entry.name} (${r.provider})`);
    all.push(...r.jobs);
  }

  if (log && failures.length) {
    console.log(`\n${failures.length} source(s) failed:`);
    failures.forEach((f) => console.log(f));
  }

  return { jobs: dedupe(all), failures };
}
