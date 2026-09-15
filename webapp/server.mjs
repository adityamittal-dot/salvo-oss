// Lite local dashboard for data/applications.xlsx — reads and writes the
// SAME file the tracker/Excel workflow already uses (no separate database,
// per explicit user decision 2026-09-15). Meant to run on localhost only;
// there is no auth because there is no network exposure — do not put this
// behind a public port.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ExcelJS from 'exceljs';
import { ROOT } from '../lib/config.mjs';
import { COLUMNS, USER_OWNED, STATUS_VALUES, TRACKED_SHEETS } from '../lib/sheet-columns.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const XLSX_PATH = join(ROOT, 'data/applications.xlsx');
const GENERATED_DIR = resolve(join(ROOT, 'data/generated'));
const PORT = Number(process.env.DASHBOARD_PORT) || 4173;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function cellValue(cell) {
  const v = cell.value;
  if (v && typeof v === 'object' && 'text' in v) {
    return { value: v.text, link: v.hyperlink || null };
  }
  return { value: v ?? '', link: null };
}

async function readWorkbook() {
  const workbook = new ExcelJS.Workbook();
  if (existsSync(XLSX_PATH)) await workbook.xlsx.readFile(XLSX_PATH);
  return workbook;
}

function readSheetRows(sheet) {
  if (!sheet) return [];
  const headers = [];
  sheet.getRow(1).eachCell((cell, col) => {
    headers[col] = COLUMNS.find((c) => c.header === cell.value)?.key;
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const { value, link } = cellValue(cell);
      record[key] = value;
      if (link) record[`${key}Link`] = link;
    });
    if (record.url) rows.push(record);
  });
  return rows;
}

function readDailyLog(workbook) {
  const sheet = workbook.getWorksheet('Daily Log');
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const d = row.getCell(1).value;
    rows.push({
      date: d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? ''),
      tracked: row.getCell(2).value ?? 0,
      discovered: row.getCell(3).value ?? 0,
      prepared: row.getCell(4).value ?? 0,
      applied: row.getCell(5).value ?? 0,
      interview: row.getCell(6).value ?? 0,
      rejected: row.getCell(7).value ?? 0,
    });
  });
  return rows;
}

async function handleGetData(res) {
  const workbook = await readWorkbook();
  const sheets = {};
  for (const name of TRACKED_SHEETS) {
    sheets[name] = readSheetRows(workbook.getWorksheet(name));
  }
  sendJson(res, 200, { sheets, dailyLog: readDailyLog(workbook), statusValues: STATUS_VALUES });
}

// Applications is the one real source of truth for every row that also
// appears in Internships (a filtered VIEW, rebuilt from Applications on every
// `npm run track` run — see tracker.mjs) — so an edit always lands there
// first if the url exists there, regardless of which tab the user was
// looking at. India Market has its own disjoint url set (a different
// pipeline, scan-india.mjs) and is genuinely independent, so it's only
// touched when the url isn't an Applications row.
async function handlePatchRow(req, res) {
  const body = await readJsonBody(req);
  const { sheet: sheetName, url, field, value } = body || {};
  if (!url || !field) return sendJson(res, 400, { error: 'url and field are required' });
  if (!USER_OWNED.has(field)) return sendJson(res, 400, { error: `field "${field}" is not editable` });
  if (field === 'status' && !STATUS_VALUES.includes(value)) {
    return sendJson(res, 400, { error: `invalid status "${value}"` });
  }

  const workbook = await readWorkbook();
  let sheet = workbook.getWorksheet('Applications');
  let row = findRowByUrl(sheet, url);
  if (!row) {
    sheet = workbook.getWorksheet(sheetName);
    row = findRowByUrl(sheet, url);
  }
  if (!row || !sheet) return sendJson(res, 404, { error: `row not found in Applications or ${sheetName}` });

  const col = COLUMNS.findIndex((c) => c.key === field) + 1;
  row.getCell(col).value = value;

  try {
    await workbook.xlsx.writeFile(XLSX_PATH);
  } catch (err) {
    if (err.code === 'EBUSY') {
      return sendJson(res, 409, { error: 'applications.xlsx is open in Excel — close it and try again' });
    }
    throw err;
  }
  sendJson(res, 200, { ok: true, sheet: sheet.name });
}

function findRowByUrl(sheet, url) {
  if (!sheet) return null;
  const headers = [];
  sheet.getRow(1).eachCell((cell, col) => {
    headers[col] = COLUMNS.find((c) => c.header === cell.value)?.key;
  });
  const urlCol = headers.indexOf('url');
  let found = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || found) return;
    const cell = row.getCell(urlCol);
    const v = cell.value;
    const text = v && typeof v === 'object' && 'text' in v ? v.text : v;
    if (String(text) === String(url)) found = row;
  });
  return found;
}

// Shared by /api/open and /api/download: the dashboard only ever has the
// file:// hyperlink the tracker stored on the cell (see tracker.mjs's
// writeSheet — resumeFile/coverFile cells are `{ text: 'Open', hyperlink:
// pathToFileURL(path).href }`), not a raw filesystem path, so that's what's
// accepted and converted back here. Restricted to files under
// data/generated (where tailor.mjs/manual-tailor.mjs write them) so this
// can't be turned into an arbitrary-file-read/open — it's only ever reachable
// from localhost anyway, but no reason to be sloppy about it.
function resolveGeneratedFile(link) {
  if (!link) return { error: 'link is required', status: 400 };
  let filePath;
  try {
    filePath = fileURLToPath(link);
  } catch {
    return { error: 'link is not a valid file:// URL', status: 400 };
  }
  const resolved = resolve(filePath);
  if (!resolved.startsWith(GENERATED_DIR + sep) || !existsSync(resolved)) {
    return { error: 'refusing to access a path outside data/generated', status: 403 };
  }
  return { path: resolved };
}

// Opens a resume/cover-letter PDF with the OS default viewer (in place, not
// downloaded) — handy when you just want to glance at it.
async function handleOpenFile(url, res) {
  const { path: resolved, error, status } = resolveGeneratedFile(url.searchParams.get('link'));
  if (error) return sendJson(res, status, { error });

  const child =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '""', resolved], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [resolved], { detached: true, stdio: 'ignore' });
  child.unref();
  sendJson(res, 200, { ok: true });
}

// Downloads a resume/cover-letter PDF as a real file-save, named after the
// company + posting (its own folder name under data/generated) rather than
// the generic "resume.pdf"/"cover-letter.pdf" every one of these is saved
// as on disk — useful the moment you have more than one tab's worth open.
async function handleDownloadFile(url, res) {
  const { path: resolved, error, status } = resolveGeneratedFile(url.searchParams.get('link'));
  if (error) return sendJson(res, status, { error });

  const slug = basename(dirname(resolved));
  const kind = basename(resolved, extname(resolved)); // "resume" or "cover-letter"
  const downloadName = `${slug}-${kind}.pdf`;

  const body = await readFile(resolved);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'Content-Length': body.length,
  });
  res.end(body);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  const safe = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(PUBLIC_DIR, safe);
  if (!resolve(filePath).startsWith(resolve(PUBLIC_DIR))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const body = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/data' && req.method === 'GET') return await handleGetData(res);
    if (url.pathname === '/api/row' && req.method === 'PATCH') return await handlePatchRow(req, res);
    if (url.pathname === '/api/open' && req.method === 'GET') return await handleOpenFile(url, res);
    if (url.pathname === '/api/download' && req.method === 'GET') return await handleDownloadFile(url, res);
    if (req.method === 'GET') return await serveStatic(url.pathname, res);
    res.writeHead(405);
    res.end('Method not allowed');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log('Reads/writes data/applications.xlsx directly — close it in Excel while using this.');
});
