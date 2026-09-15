// Opens each tailored application in a real, visible browser window, fills
// in the fields that are exact facts (name, email, phone, LinkedIn/GitHub,
// resume + cover letter files), and stops. It never clicks Submit — that
// decision, and every custom screening question, stays yours.
//
// Why this boundary and not further: platform ToS bans automated submission
// (and a ban is typically permanent), and a wrong answer to a screening
// question ("are you authorized to work in the US?", "do you have 3+ years
// with Kubernetes?") is a false statement on a real application, not a
// cosmetic mistake. Reviewing ~25 pre-filled forms costs you minutes; a
// banned account or a misrepresented qualification costs much more.
//
// Usage:
//   node prep-applications.mjs           process today's tailored queue
//   node prep-applications.mjs --url ".."  process one specific posting
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import 'dotenv/config';
import { ROOT, loadProfile } from './lib/config.mjs';
import * as greenhouse from './lib/ats/greenhouse.mjs';
import * as ashby from './lib/ats/ashby.mjs';
import * as lever from './lib/ats/lever.mjs';
import * as generic from './lib/ats/generic.mjs';

const GENERATED_DIR = join(ROOT, 'data/generated');
const XLSX_PATH = join(ROOT, 'data/applications.xlsx');

// Same detection patterns the discovery providers already use for these
// three ATS platforms — a posting's host is enough to know which form
// software rendered it.
function detectAts(url) {
  if (/(^|\.)greenhouse\.io$/.test(new URL(url).hostname)) return { name: 'greenhouse', handler: greenhouse };
  if (/(^|\.)ashbyhq\.com$/.test(new URL(url).hostname)) return { name: 'ashby', handler: ashby };
  if (/(^|\.)lever\.co$/.test(new URL(url).hostname)) return { name: 'lever', handler: lever };
  return { name: 'unknown', handler: generic };
}

async function loadAppliedStatus() {
  const byUrl = new Map();
  if (!existsSync(XLSX_PATH)) return byUrl;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(XLSX_PATH);
  const sheet = workbook.getWorksheet('Applications');
  if (!sheet) return byUrl;

  // Positional indices, matching tracker.mjs's own COLUMNS order — ExcelJS
  // does not persist column `key` into the file, so a sheet read back from
  // disk must be addressed by column number, not by name.
  const STATUS_COL = 1;
  const URL_COL = 14;
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const status = String(row.getCell(STATUS_COL).value || '').toLowerCase();
    const urlCell = row.getCell(URL_COL).value;
    const url = urlCell && typeof urlCell === 'object' ? urlCell.text : urlCell;
    if (url) byUrl.set(String(url), status);
  });
  return byUrl;
}

async function findMetaByUrl(url) {
  if (!existsSync(GENERATED_DIR)) return null;
  for (const d of await readdir(GENERATED_DIR)) {
    const metaPath = join(GENERATED_DIR, d, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      if (meta.url === url) return meta;
    } catch {
      // corrupt meta.json for this one — skip it, don't fail the whole run
    }
  }
  return null;
}

async function buildQueue(profile, onlyUrl) {
  const pipelinePath = join(ROOT, 'data/pipeline.json');
  if (!existsSync(pipelinePath)) throw new Error('data/pipeline.json not found — run `npm run scan` first');
  const pipeline = JSON.parse(await readFile(pipelinePath, 'utf8'));

  if (onlyUrl) {
    const job = pipeline.jobs.find((j) => j.url === onlyUrl);
    if (!job) throw new Error(`No job with url ${onlyUrl} in data/pipeline.json`);
    return [job];
  }

  const applied = await loadAppliedStatus();
  const target = profile.scoring.daily_apply_target;
  const perCompany = new Map();
  const queue = [];
  for (const j of pipeline.jobs) {
    if (j.score < profile.scoring.apply_min || j.blocked) continue;
    const status = applied.get(j.url);
    if (status && status !== 'discovered' && status !== 'prepared') continue; // already applied/interview/rejected/offer
    const n = perCompany.get(j.company) || 0;
    if (n >= profile.scoring.max_per_company) continue;
    perCompany.set(j.company, n + 1);
    queue.push(j);
    if (queue.length >= target) break;
  }
  return queue;
}

async function processJob(browser, job, rl) {
  const meta = await findMetaByUrl(job.url);
  if (!meta) {
    console.log(`\nSKIP: ${job.company} — ${job.title} has no tailored resume yet (run batch-tailor first).`);
    return;
  }

  const { name: atsName, handler } = detectAts(job.url);
  const applyUrl = atsName === 'ashby' ? ashby.applicationUrl(job.url) : job.url;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${job.company} — ${job.title}  [${atsName}]`);
  console.log(applyUrl);

  const page = await browser.newPage();
  try {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // React-based application forms (Greenhouse, Ashby) attach their click
    // handlers slightly after domcontentloaded — clicking Attach/Upload
    // immediately can silently no-op. Confirmed necessary live.
    await page.waitForTimeout(1500);
  } catch (err) {
    console.log(`  Could not load the page automatically (${err.message.split('\n')[0]}).`);
    console.log(`  Resume:       ${meta.resumePdfPath}`);
    console.log(`  Cover letter: ${meta.coverPdfPath}`);
    await rl.question('  Press Enter once you\'ve handled this one manually...');
    await page.close();
    return;
  }

  const profile = await loadProfile();
  const { filled, needsReview } = await handler.fill(page, {
    profile,
    resumePath: meta.resumePdfPath,
    coverLetterPath: meta.coverPdfPath,
  });

  console.log(`  Filled: ${filled.length ? filled.join(', ') : '(nothing — check the page)'}`);
  if (needsReview.length) {
    console.log(`  STILL NEEDS YOUR INPUT:`);
    for (const q of needsReview) console.log(`    - ${q}`);
  }
  console.log(`  Resume:       ${meta.resumePdfPath}`);
  console.log(`  Cover letter: ${meta.coverPdfPath}`);
  console.log('  The Submit button has NOT been touched — review everything, then submit yourself.');

  await rl.question('  Press Enter when you\'re done with this one (submitted, skipped, whatever you decided)...');
  await page.close();
}

async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const onlyUrl = urlIdx !== -1 ? args[urlIdx + 1] : null;

  const profile = await loadProfile();
  const queue = await buildQueue(profile, onlyUrl);

  if (!queue.length) {
    console.log('Nothing to prepare — either everything in range is already applied/rejected, or the queue is empty.');
    return;
  }

  console.log(`Preparing ${queue.length} application${queue.length > 1 ? 's' : ''}. A browser window will open for each one.`);
  console.log('Nothing is ever submitted automatically — you review and click Submit yourself.\n');

  const browser = await chromium.launch({ headless: false });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const job of queue) {
      await processJob(browser, job, rl);
    }
  } finally {
    rl.close();
    await browser.close();
  }

  console.log('\nDone. Update Status in data/applications.xlsx for anything you actually submitted.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
