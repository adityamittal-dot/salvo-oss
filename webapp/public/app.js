const state = {
  sheets: {},
  dailyLog: [],
  statusValues: [],
  activeSheet: 'Applications',
  sort: { key: 'score', dir: 'desc' },
  search: '',
  statusFilterVal: '',
};

const STATUS_ORDER = ['interview', 'offer', 'applied', 'prepared', 'discovered', 'rejected', 'closed'];

async function fetchData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    state.sheets = data.sheets;
    state.dailyLog = data.dailyLog;
    state.statusValues = data.statusValues;
    if (!state.sheets[state.activeSheet]) state.activeSheet = Object.keys(state.sheets)[0];
    document.getElementById('lastUpdated').textContent = `Loaded ${new Date().toLocaleTimeString()}`;
    renderAll();
  } catch (err) {
    // A silent blank page is the worst failure mode for a tool like this —
    // always show something rather than fail invisibly (a real bug here
    // once left the page looking empty with no indication anything was
    // wrong at all).
    showFatalError(err);
  }
}

function showFatalError(err) {
  console.error(err);
  const el = document.getElementById('summary');
  el.innerHTML = `<div class="stat-card wide" style="border-color:#c0392b"><div class="stat-label">Dashboard error</div><div style="margin-top:6px;font-size:0.85rem">${escapeHtml(err.message)} — check that the server is running (\`npm run dashboard\`) and reload.</div></div>`;
}

function renderAll() {
  try {
    renderTabs();
    renderStatusFilterOptions();
    renderSummary();
    renderTable();
  } catch (err) {
    showFatalError(err);
  }
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  for (const name of Object.keys(state.sheets)) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (name === state.activeSheet ? ' active' : '');
    btn.textContent = `${name} (${state.sheets[name].length})`;
    btn.onclick = () => {
      state.activeSheet = name;
      state.search = '';
      document.getElementById('searchBox').value = '';
      renderAll();
    };
    tabs.appendChild(btn);
  }
}

function renderStatusFilterOptions() {
  const sel = document.getElementById('statusFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All statuses</option>';
  for (const s of state.statusValues) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  }
  sel.value = current;
}

function renderSummary() {
  const rows = state.sheets[state.activeSheet] || [];
  const el = document.getElementById('summary');
  el.innerHTML = '';

  const counts = {};
  for (const s of STATUS_ORDER) counts[s] = 0;
  const bySource = {};
  const byCompany = {};
  let scoreSum = 0, scoreN = 0;

  for (const r of rows) {
    const status = String(r.status || 'discovered').toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
    const src = r.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
    const co = r.company || 'Unknown';
    byCompany[co] = (byCompany[co] || 0) + 1;
    const sc = Number(r.score);
    if (!Number.isNaN(sc)) { scoreSum += sc; scoreN++; }
  }

  el.appendChild(statCard('Tracked', rows.length));
  el.appendChild(statCard('Applied', counts.applied || 0));
  el.appendChild(statCard('Interview', counts.interview || 0));
  el.appendChild(statCard('Offer', counts.offer || 0));
  el.appendChild(statCard('Avg Score', scoreN ? (scoreSum / scoreN).toFixed(2) : '—'));

  const topCompanies = Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 5);
  el.appendChild(barCard('Top Companies', topCompanies));

  const sourceBars = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 6);
  el.appendChild(barCard('By Source', sourceBars));
}

function statCard(label, value) {
  const div = document.createElement('div');
  div.className = 'stat-card';
  div.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`;
  return div;
}

function barCard(label, entries) {
  const div = document.createElement('div');
  div.className = 'stat-card wide';
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const bars = entries
    .map(
      ([name, count]) => `
      <div class="mini-bar-row">
        <span class="mini-bar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="mini-bar-track"><span class="mini-bar-fill" style="width:${(count / max) * 100}%"></span></span>
        <span class="mini-bar-count">${count}</span>
      </div>`,
    )
    .join('');
  div.innerHTML = `<div class="stat-label">${label}</div><div class="mini-bars">${bars || '<span class="muted">—</span>'}</div>`;
  return div;
}

function getFilteredSortedRows() {
  const rows = state.sheets[state.activeSheet] || [];
  const q = state.search.trim().toLowerCase();
  let filtered = rows.filter((r) => {
    if (state.statusFilterVal && String(r.status || '').toLowerCase() !== state.statusFilterVal) return false;
    if (!q) return true;
    return `${r.company} ${r.title} ${r.location}`.toLowerCase().includes(q);
  });

  const { key, dir } = state.sort;
  filtered = filtered.slice().sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === 'score') { av = Number(av) || 0; bv = Number(bv) || 0; }
    else { av = String(av ?? '').toLowerCase(); bv = String(bv ?? '').toLowerCase(); }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return filtered;
}

const COLS = [
  { key: 'status', label: 'Status' },
  { key: 'company', label: 'Company' },
  { key: 'title', label: 'Role' },
  { key: 'score', label: 'Score' },
  { key: 'location', label: 'Location' },
  { key: 'source', label: 'Source' },
  { key: 'resumeFile', label: 'Resume' },
  { key: 'coverFile', label: 'Cover' },
  { key: 'atsMatch', label: 'ATS' },
  { key: 'appliedOn', label: 'Applied On' },
  { key: 'notes', label: 'Notes' },
  { key: 'url', label: 'Link' },
];

function renderTable() {
  const rows = getFilteredSortedRows();
  document.getElementById('rowCount').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}`;

  const thead = document.querySelector('#table thead');
  thead.innerHTML = '';
  const headRow = document.createElement('tr');
  for (const col of COLS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    if (state.sort.key === col.key) {
      th.classList.add('sorted');
      if (state.sort.dir === 'asc') th.classList.add('asc');
    }
    th.onclick = () => {
      if (state.sort.key === col.key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key: col.key, dir: 'desc' };
      renderTable();
    };
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.querySelector('#table tbody');
  tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = COLS.length;
    td.className = 'empty-state';
    td.textContent = 'No rows match.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    tbody.appendChild(renderRow(row));
  }
}

function renderRow(row) {
  const tr = document.createElement('tr');
  tr.dataset.url = row.url;

  tr.appendChild(cell(statusCellContent(row)));
  tr.appendChild(cell(escapeHtml(row.company || '')));
  const roleTd = cell(escapeHtml(row.title || ''));
  roleTd.className = 'role-cell';
  tr.appendChild(roleTd);
  tr.appendChild(cell(scoreBadge(row.score)));
  tr.appendChild(cell(escapeHtml(row.location || '')));
  tr.appendChild(cell(escapeHtml(row.source || '')));
  tr.appendChild(cell(fileButton(row, 'resumeFile')));
  tr.appendChild(cell(fileButton(row, 'coverFile')));
  tr.appendChild(cell(escapeHtml(row.atsMatch || '')));
  tr.appendChild(cell(appliedOnInput(row)));
  const notesTd = cell(notesInput(row));
  notesTd.className = 'notes-cell';
  tr.appendChild(notesTd);
  tr.appendChild(cell(row.url ? `<a class="link" href="${escapeAttr(row.url)}" target="_blank" rel="noopener">View</a>` : ''));

  return tr;
}

function cell(contentOrNode) {
  const td = document.createElement('td');
  if (typeof contentOrNode === 'string') td.innerHTML = contentOrNode;
  else td.appendChild(contentOrNode);
  return td;
}

function statusCellContent(row) {
  const wrap = document.createElement('select');
  wrap.className = `status-select status-${String(row.status || 'discovered').toLowerCase()}`;
  for (const s of state.statusValues) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    if (String(row.status).toLowerCase() === s) opt.selected = true;
    wrap.appendChild(opt);
  }
  wrap.onchange = async () => {
    wrap.className = `status-select status-${wrap.value}`;
    const ok = await patchRow(row, 'status', wrap.value);
    if (ok) { row.status = wrap.value; flashRow(wrap); renderSummary(); }
  };
  return wrap;
}

function scoreBadge(score) {
  const n = Number(score);
  if (Number.isNaN(n)) return '';
  let bg = '#e2e2e6', fg = '#333';
  if (n >= 3.5) { bg = '#d1e7dd'; fg = '#0a3622'; }
  else if (n >= 2) { bg = '#fff3cd'; fg = '#4a3f1a'; }
  else { bg = '#f2f2f2'; fg = '#555'; }
  return `<span class="score-badge" style="background:${bg};color:${fg}">${n.toFixed(2)}</span>`;
}

function fileButton(row, field) {
  const link = row[`${field}Link`];
  if (!link) return document.createTextNode('—');
  const btn = document.createElement('button');
  btn.className = 'btn-link';
  btn.textContent = 'Open';
  btn.onclick = async () => {
    const res = await fetch(`/api/open?link=${encodeURIComponent(link)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || 'Could not open file');
    }
  };
  return btn;
}

function appliedOnInput(row) {
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'date-input';
  input.value = toDateInputValue(row.appliedOn);
  input.onchange = async () => {
    const ok = await patchRow(row, 'appliedOn', input.value);
    if (ok) { row.appliedOn = input.value; flashRow(input); }
  };
  return input;
}

function toDateInputValue(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function notesInput(row) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'notes-input';
  input.value = row.notes || '';
  input.placeholder = 'Add a note...';
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const ok = await patchRow(row, 'notes', input.value);
      if (ok) { row.notes = input.value; flashRow(input); }
    }, 700);
  };
  return input;
}

function flashRow(el) {
  const tr = el.closest('tr');
  if (!tr) return;
  tr.classList.remove('saved-flash');
  void tr.offsetWidth;
  tr.classList.add('saved-flash');
}

async function patchRow(row, field, value) {
  try {
    const res = await fetch('/api/row', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: state.activeSheet, url: row.url, field, value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || 'Save failed');
      return false;
    }
    return true;
  } catch (err) {
    alert('Save failed: ' + err.message);
    return false;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

document.getElementById('refreshBtn').onclick = fetchData;
document.getElementById('searchBox').oninput = (e) => { state.search = e.target.value; renderTable(); };
document.getElementById('statusFilter').onchange = (e) => { state.statusFilterVal = e.target.value; renderTable(); };

fetchData();
