// Probes every entry in config/boards.yaml and reports which are alive.
// ATS slugs go stale; this is how you prune the seed list without guessing.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, loadBoards } from './lib/config.mjs';
import { resolveProvider } from './providers/_registry.mjs';

async function probe(entry) {
  const resolved = await resolveProvider(entry);
  if (!resolved) return { entry, status: 'SKIPPED', detail: 'no provider claimed it' };
  try {
    const jobs = await resolved.provider.fetch(entry, { maxPages: 1 });
    if (!Array.isArray(jobs)) return { entry, status: 'BROKEN', detail: 'non-array' };
    if (jobs.length === 0) return { entry, status: 'EMPTY', detail: '0 postings' };
    return { entry, status: 'OK', detail: `${jobs.length} postings` };
  } catch (err) {
    const is404 = /HTTP 404/.test(err.message);
    return { entry, status: is404 ? 'DEAD' : 'ERROR', detail: err.message.slice(0, 90) };
  }
}

const ICON = { OK: '  ok  ', EMPTY: ' empty', DEAD: ' dead ', ERROR: ' error', BROKEN: 'broken', SKIPPED: ' skip ' };

async function main() {
  const boards = await loadBoards();
  const entries = [...(boards.job_boards || []), ...(boards.tracked_companies || [])];
  console.log(`Probing ${entries.length} sources...\n`);

  const counts = {};
  const results = [];
  for (const entry of entries) {
    const r = await probe(entry);
    results.push(r);
    counts[r.status] = (counts[r.status] || 0) + 1;
    console.log(`[${ICON[r.status]}] ${r.entry.name.padEnd(22)} ${r.detail}`);
  }

  console.log('\nSummary:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));

  const dead = results.filter((r) => r.status === 'DEAD').map((r) => r.entry.name);
  if (dead.length && process.argv.includes('--prune')) {
    const path = join(ROOT, 'config/boards.yaml');
    const lines = (await readFile(path, 'utf8')).split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s*name:\s*(.+?)\s*$/);
      if (m && dead.includes(m[1])) {
        // Skip this entry's block: the name line plus indented continuation lines.
        i++;
        while (i < lines.length && /^\s{4,}\S/.test(lines[i])) i++;
        i--;
        continue;
      }
      kept.push(lines[i]);
    }
    await writeFile(path, kept.join('\n'));
    console.log(`\nPruned ${dead.length} dead entries from config/boards.yaml`);
  } else if (dead.length) {
    console.log('\nRe-run with --prune to remove DEAD entries from config/boards.yaml.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
