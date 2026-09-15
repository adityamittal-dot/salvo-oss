// Discovery. Walks every entry in config/boards.yaml through the provider
// layer, normalizes and dedupes, applies the profile filters, and writes
// data/pipeline.json.
//
// Zero authentication: every provider here reads a public endpoint. Nothing in
// this script touches a logged-in session or a credential.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, loadProfile, loadBoards } from './lib/config.mjs';
import { applyFilters } from './lib/filter.mjs';
import { fetchAllJobs } from './lib/discover.mjs';

async function main() {
  const [profile, boards] = await Promise.all([loadProfile(), loadBoards()]);
  const { jobs: deduped } = await fetchAllJobs(boards);

  const { jobs, stats } = applyFilters(deduped, profile);

  console.log(
    `\nRaw ${stats.total} → deduped ${deduped.length} → ` +
      `dropped ${stats.stale} stale / ${stats.title} off-title / ${stats.location} off-location / ` +
      `${stats.experience} requires-experience ` +
      `→ kept ${stats.kept}`,
  );

  const applyMin = profile.scoring.apply_min;
  const readyCount = jobs.filter((j) => j.score >= applyMin && !j.blocked).length;
  console.log(`${readyCount} at or above apply threshold (${applyMin})`);

  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(
    join(ROOT, 'data/pipeline.json'),
    JSON.stringify({ scannedAt: new Date().toISOString(), stats, jobs }, null, 2),
  );
  console.log('\nWrote data/pipeline.json');

  if (jobs.length) {
    console.log('\nTop matches:');
    for (const j of jobs.slice(0, 10)) {
      console.log(`  ${j.score.toFixed(2)}  ${j.company} — ${j.title}`);
      console.log(`        ${j.location || 'location not stated'}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
