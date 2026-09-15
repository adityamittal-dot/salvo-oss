// Excel application tracker. Merges the current pipeline into
// data/applications.xlsx, keyed by posting URL.
//
// Status and Notes are USER-OWNED columns: once a row exists, this script never
// overwrites what you typed there. Everything else (score, location, title) is
// refreshed from the latest scan. That is what makes it safe to run daily.
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import { ROOT, loadProfile } from './lib/config.mjs';
import { isInternship, titleMatches, requiresExperience } from './lib/filter.mjs';
import { COLUMNS, USER_OWNED, STATUS_FILL } from './lib/sheet-columns.mjs';

const XLSX_PATH = join(ROOT, 'data/applications.xlsx');
const PIPELINE_PATH = join(ROOT, 'data/pipeline.json');
const INDIA_PIPELINE_PATH = join(ROOT, 'data/pipeline-india.json');
const GENERATED_DIR = join(ROOT, 'data/generated');
// Excel sheet names cap at 31 chars.
const INDIA_SHEET = 'India Market';

const today = () => new Date().toISOString().slice(0, 10);

// Reads every data/generated/*/meta.json (written by tailor.mjs) and returns
// a Map keyed by posting URL, so a tailored resume shows up in the row for
// the posting it was written for even though the two scripts run separately.
async function loadResumeMeta() {
  const byUrl = new Map();
  if (!existsSync(GENERATED_DIR)) return byUrl;
  const dirs = await readdir(GENERATED_DIR);
  for (const d of dirs) {
    const metaPath = join(GENERATED_DIR, d, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      if (meta.url) byUrl.set(meta.url, meta);
    } catch {
      // corrupt meta.json for this posting — skip, don't fail the whole run
    }
  }
  return byUrl;
}

async function loadExisting(workbook, sheetName = 'Applications') {
  const sheet = workbook.getWorksheet(sheetName);
  const rows = new Map();
  if (!sheet) return rows;

  const headers = [];
  sheet.getRow(1).eachCell((cell, col) => {
    headers[col] = COLUMNS.find((c) => c.header === cell.value)?.key;
  });

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      // Hyperlinked cells come back as an object, not a string. For most
      // columns the display text IS the real value (e.g. url), but
      // resumeFile/coverFile display the label "Open" with the real
      // filesystem path only in .hyperlink — a real bug, found while
      // building the dashboard: reading back v.text for these two columns
      // silently replaced the real path with the literal string "Open" on
      // any row mergeRow() didn't freshly recompute that run (e.g. a job
      // that aged out of the live scan), and every rewrite after that
      // corrupted it further via pathToFileURL("Open") producing garbage.
      const v = cell.value;
      if (v && typeof v === 'object' && 'hyperlink' in v) {
        if (key === 'resumeFile' || key === 'coverFile') {
          try {
            record[key] = fileURLToPath(v.hyperlink);
            return;
          } catch {
            // hyperlink wasn't a valid file:// URL — fall through to text
          }
        }
        record[key] = v.text;
        return;
      }
      record[key] = v;
    });
    if (record.url) rows.set(String(record.url), record);
  });

  return rows;
}

function mergeRow(existing, job, stamp, resumeMeta) {
  const fresh = {
    status: 'discovered',
    company: job.company,
    title: job.title,
    score: job.score,
    location: job.location,
    source: job.source,
    resumeFile: '',
    coverFile: '',
    atsMatch: '',
    firstSeen: stamp,
    lastSeen: stamp,
    appliedOn: '',
    notes: (job.reasons || []).join('; '),
    url: job.url,
  };

  const merged = existing
    ? { ...fresh, firstSeen: existing.firstSeen || stamp, lastSeen: stamp }
    : fresh;

  if (existing) {
    for (const key of USER_OWNED) {
      if (existing[key] !== undefined && existing[key] !== null && existing[key] !== '') {
        merged[key] = existing[key];
      }
    }
  }

  if (resumeMeta) {
    merged.resumeFile = resumeMeta.resumePdfPath || '';
    merged.coverFile = resumeMeta.coverPdfPath || '';
    const matched = resumeMeta.keywordReport?.matched?.length || 0;
    const missing = resumeMeta.keywordReport?.missing?.length || 0;
    const totalKeywords = matched + missing;
    merged.atsMatch = totalKeywords ? `${matched}/${totalKeywords}` : '';
    // Auto-promote status once a resume exists — but only from the untouched
    // default. A status the user already set by hand (applied, rejected,
    // interview) is USER_OWNED above and was already carried forward, so this
    // never overwrites real progress.
    if (merged.status === 'discovered') merged.status = 'prepared';
  }

  return merged;
}

function writeSheet(workbook, records, sheetName = 'Applications') {
  // Rebuild the sheet rather than patching it: row order changes as scores move.
  const old = workbook.getWorksheet(sheetName);
  if (old) workbook.removeWorksheet(old.id);

  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = COLUMNS;

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  const order = { interview: 0, offer: 1, applied: 2, prepared: 3, discovered: 4, rejected: 5, closed: 6 };
  records.sort((a, b) => {
    const s = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    return s !== 0 ? s : (b.score || 0) - (a.score || 0);
  });

  for (const record of records) {
    const row = sheet.addRow(record);
    const fill = STATUS_FILL[String(record.status).toLowerCase()];
    if (fill) {
      row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    }
    const urlCell = row.getCell('url');
    if (record.url) {
      urlCell.value = { text: record.url, hyperlink: record.url };
      urlCell.font = { color: { argb: 'FF0563C1' }, underline: true };
    }
    for (const [field, label] of [['resumeFile', 'Open'], ['coverFile', 'Open']]) {
      if (!record[field]) continue;
      const cell = row.getCell(field);
      cell.value = { text: label, hyperlink: pathToFileURL(record[field]).href };
      cell.font = { color: { argb: 'FF0563C1' }, underline: true };
    }
    row.getCell('title').alignment = { wrapText: false };
  }

  sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };
  return sheet;
}

// Positional indices, not column keys: ExcelJS does not persist `key` in the
// .xlsx, so a sheet read back from disk has no keys and getCell('date') throws.
const LOG_HEADERS = ['Date', 'Tracked', 'Discovered', 'Prepared', 'Applied', 'Interview', 'Rejected'];

function writeDailyLog(workbook, records) {
  let sheet = workbook.getWorksheet('Daily Log');
  if (!sheet) {
    sheet = workbook.addWorksheet('Daily Log');
    sheet.addRow(LOG_HEADERS);
    sheet.getRow(1).font = { bold: true };
    LOG_HEADERS.forEach((_, i) => { sheet.getColumn(i + 1).width = i === 0 ? 12 : 11; });
  }

  const count = (s) => records.filter((r) => String(r.status).toLowerCase() === s).length;
  const stamp = today();
  const entry = {
    date: stamp,
    tracked: records.length,
    discovered: count('discovered'),
    prepared: count('prepared'),
    applied: count('applied'),
    interview: count('interview'),
    rejected: count('rejected'),
  };
  const values = [
    entry.date, entry.tracked, entry.discovered,
    entry.prepared, entry.applied, entry.interview, entry.rejected,
  ];

  // One row per day — re-running the same day updates in place.
  let target = null;
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const d = row.getCell(1).value;
    const asString = d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
    if (asString === stamp) target = row;
  });

  if (target) {
    values.forEach((v, i) => { target.getCell(i + 1).value = v; });
  } else {
    sheet.addRow(values);
  }
  return entry;
}

export async function updateTracker() {
  if (!existsSync(PIPELINE_PATH)) {
    throw new Error('data/pipeline.json not found — run `npm run scan` first');
  }
  const pipeline = JSON.parse(await readFile(PIPELINE_PATH, 'utf8'));
  const workbook = new ExcelJS.Workbook();
  if (existsSync(XLSX_PATH)) await workbook.xlsx.readFile(XLSX_PATH);

  const [rows, resumeMetaByUrl, profile] = await Promise.all([
    loadExisting(workbook, 'Applications'),
    loadResumeMeta(),
    loadProfile(),
  ]);
  const stamp = today();

  let added = 0;
  const records = new Map(rows);
  for (const job of pipeline.jobs || []) {
    const existing = rows.get(job.url);
    if (!existing) added++;
    records.set(job.url, mergeRow(existing, job, stamp, resumeMetaByUrl.get(job.url)));
  }

  // Self-healing repair pass: a row whose job has since aged out of the live
  // scan (so the loop above never touches it — mergeRow only runs for
  // pipeline.jobs) never gets its resumeFile/coverFile refreshed. Combined
  // with the "Open"-text hyperlink-corruption bug fixed in loadExisting()
  // above, some existing rows in applications.xlsx have a genuinely broken
  // path (literal "Open" or a garbage file:// URL) baked in from before that
  // fix existed. Repair every row directly from meta.json by url whenever
  // the currently-stored path doesn't point at a real file — independent of
  // whether this run's scan still returns that job.
  let repaired = 0;
  for (const [url, r] of records) {
    const meta = resumeMetaByUrl.get(url);
    if (!meta) continue;
    if (r.resumeFile && !existsSync(r.resumeFile) && meta.resumePdfPath) {
      r.resumeFile = meta.resumePdfPath;
      repaired++;
    }
    if (r.coverFile && !existsSync(r.coverFile) && meta.coverPdfPath) {
      r.coverFile = meta.coverPdfPath;
    }
  }

  // Prune stale rows that no longer match the (now entry-level/internship-only)
  // profile, but ONLY if the user never touched them (still 'discovered').
  // A row the user already moved to prepared/applied/interview/etc. is real
  // progress and is never removed just because the filter tightened.
  let pruned = 0;
  for (const [url, r] of records) {
    if (String(r.status).toLowerCase() !== 'discovered') continue;
    const title = String(r.title || '');
    const stillMatches =
      titleMatches({ title }, profile.target) &&
      !requiresExperience(`${title} ${r.location || ''}`.toLowerCase());
    if (!stillMatches) {
      records.delete(url);
      pruned++;
    }
  }

  const list = [...records.values()];
  writeSheet(workbook, list, 'Applications');

  // Internships is a filtered VIEW of Applications, rebuilt from it every run —
  // not an independent source of truth. Edit Status/Notes on the Applications
  // tab; edits made only on this tab will not be picked up next run.
  const internships = list.filter((r) => isInternship({ title: r.title }, profile.target));
  writeSheet(workbook, internships, 'Internships');

  // India Market is a real, independently-tracked sheet (own Status/Notes,
  // not just a filtered view) — sourced from scan-india.mjs's separate
  // pipeline file, since those postings (onsite/hybrid roles physically in
  // India, incl. Unstop) are deliberately excluded from the main
  // remote-first Applications pipeline.
  let indiaCount = 0;
  if (existsSync(INDIA_PIPELINE_PATH)) {
    const indiaPipeline = JSON.parse(await readFile(INDIA_PIPELINE_PATH, 'utf8'));
    const indiaRows = await loadExisting(workbook, INDIA_SHEET);
    const indiaRecords = new Map(indiaRows);
    for (const job of indiaPipeline.jobs || []) {
      const existing = indiaRows.get(job.url);
      indiaRecords.set(job.url, mergeRow(existing, job, stamp, resumeMetaByUrl.get(job.url)));
    }
    const indiaList = [...indiaRecords.values()];
    writeSheet(workbook, indiaList, INDIA_SHEET);
    indiaCount = indiaList.length;
  }

  const summary = writeDailyLog(workbook, list);

  await mkdir(join(ROOT, 'data'), { recursive: true });
  await workbook.xlsx.writeFile(XLSX_PATH);

  return {
    added,
    pruned,
    repaired,
    total: list.length,
    internshipCount: internships.length,
    indiaCount,
    summary,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  updateTracker()
    .then(({ added, pruned, repaired, total, internshipCount, indiaCount, summary }) => {
      console.log(
        `Tracker updated: ${added} new, ${pruned} pruned (out of scope), ${repaired} resume-link(s) repaired, ` +
          `${total} tracked total (${internshipCount} internships, ${indiaCount} India market)`,
      );
      console.log(
        `  discovered=${summary.discovered} prepared=${summary.prepared} ` +
          `applied=${summary.applied} interview=${summary.interview}`,
      );
      console.log('  data/applications.xlsx');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
