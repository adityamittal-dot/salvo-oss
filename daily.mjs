// Daily run: scan every source, refresh the tracker, and print today's queue.
// Schedule with Windows Task Scheduler:
//   schtasks /create /tn "salvo" /tr "cmd /c cd /d C:\Users\adity\GITHUB\Playwright && node daily.mjs" /sc daily /st 08:00
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import 'dotenv/config';
import { ROOT, loadProfile } from './lib/config.mjs';
import { updateTracker } from './tracker.mjs';

function run(script) {
  const r = spawnSync(process.execPath, [join(ROOT, script)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} exited with ${r.status}`);
}

async function main() {
  const profile = await loadProfile();
  const target = profile.scoring.daily_apply_target;

  run('scan.mjs');
  run('scan-india.mjs');

  // Deliberately NOT auto-running batch-tailor.mjs (the billed-API path) even
  // when a key is present in .env — user decision (2026-09-15): tailoring
  // goes through manual-tailor.mjs (Claude Code drafting it directly, zero
  // API cost) exclusively, no exceptions. Run `npm run manual-tailor` per
  // job, or dispatch it via a Claude Code session, as this project already
  // does for its whole outstanding queue.
  console.log('\nResume tailoring is manual-only now (see manual-tailor.mjs) — not run automatically here.');

  const { added, total, indiaCount } = await updateTracker();
  console.log(`\nTracker: ${added} new postings, ${total} tracked (${indiaCount} India market)`);

  const pipeline = JSON.parse(await readFile(join(ROOT, 'data/pipeline.json'), 'utf8'));
  const queue = pipeline.jobs.filter((j) => j.score >= profile.scoring.apply_min && !j.blocked);

  // Cap per company so one big board cannot fill the whole day.
  const perCompany = new Map();
  const today = [];
  for (const j of queue) {
    const n = perCompany.get(j.company) || 0;
    if (n >= profile.scoring.max_per_company) continue;
    perCompany.set(j.company, n + 1);
    today.push(j);
    if (today.length >= target) break;
  }

  console.log(`\nToday's queue (${today.length} of ${queue.length} eligible, target ${target}):`);
  for (const j of today) {
    console.log(`  ${j.score.toFixed(2)}  ${j.company.padEnd(22)} ${j.title}`);
  }
  if (queue.length < target) {
    console.log(`\nOnly ${queue.length} eligible today — add boards to config/boards.yaml to raise supply.`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
