/* Shared helpers: date-range state (URL ⇄ localStorage), fetch, formatting. */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

const Range = {
  get() {
    const p = new URLSearchParams(location.search);
    let start = p.get('start') || localStorage.getItem('range.start');
    let end = p.get('end') || localStorage.getItem('range.end');
    if (!start || !end || start > end) {
      start = todayISO().slice(0, 4) + '-01-01'; // YTD default
      end = todayISO();
    }
    return { start, end };
  },
  set(start, end) {
    localStorage.setItem('range.start', start);
    localStorage.setItem('range.end', end);
    const p = new URLSearchParams(location.search);
    p.set('start', start);
    p.set('end', end);
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  },
  qs() {
    const r = Range.get();
    return 'start=' + r.start + '&end=' + r.end;
  },
  label() {
    const r = Range.get();
    const f = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return f(r.start) + ' – ' + f(r.end);
  },
};

function applyPreset(p) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const iso = (d) => d.toISOString().slice(0, 10);
  const monthStart = (yy, mm) => new Date(Date.UTC(yy, mm, 1));
  const monthEnd = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0));
  let start, end;
  if (p === 'this') { start = iso(monthStart(y, m)); end = todayISO(); }
  else if (p === 'last') { start = iso(monthStart(y, m - 1)); end = iso(monthEnd(y, m - 1)); }
  else if (p === 'l3') { start = iso(monthStart(y, m - 2)); end = todayISO(); }
  else if (p === 'ytd') { start = y + '-01-01'; end = todayISO(); }
  else if (p === 'h1') { start = y + '-01-01'; end = y + '-06-30'; }
  else if (p === 't12') { start = iso(monthStart(y, m - 11)); end = todayISO(); }
  else return;
  Range.set(start, end);
}

/* Year + period → {start, end}. Period: full, h1, h2, q1..q4. */
const FIRST_DATA_YEAR = 2020;
function periodRange(year, period) {
  const spans = {
    full: ['01-01', '12-31'], h1: ['01-01', '06-30'], h2: ['07-01', '12-31'],
    q1: ['01-01', '03-31'], q2: ['04-01', '06-30'], q3: ['07-01', '09-30'], q4: ['10-01', '12-31'],
  };
  const s = spans[period] || spans.full;
  let end = year + '-' + s[1];
  if (end > todayISO()) end = todayISO(); // current year: don't run into the future
  return { start: year + '-' + s[0], end };
}
const PERIOD_NAMES = { full: 'Full year', h1: 'First half', h2: 'Second half', q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4' };

/* Renders the shared range control into #rangeBox and wires onChange. */
function mountRange(onChange) {
  const box = $('rangeBox');
  box.className = 'range';
  const thisYear = Number(todayISO().slice(0, 4));
  let yearOpts = '<option value="">Year…</option>';
  for (let y = thisYear; y >= FIRST_DATA_YEAR; y--) yearOpts += '<option value="' + y + '">' + y + '</option>';
  let periodOpts = '';
  for (const k of ['full', 'h1', 'h2', 'q1', 'q2', 'q3', 'q4']) periodOpts += '<option value="' + k + '">' + PERIOD_NAMES[k] + '</option>';
  box.innerHTML =
    '<select id="rrYear" title="Pick a year">' + yearOpts + '</select>' +
    '<select id="rrPeriod" title="Pick the part of the year">' + periodOpts + '</select>' +
    '<select id="rrPreset">' +
      '<option value="custom">Custom</option>' +
      '<option value="this">This month</option>' +
      '<option value="last">Last month</option>' +
      '<option value="l3">Last 3 months</option>' +
      '<option value="ytd">Year to date</option>' +
      '<option value="t12">Trailing 12 months</option>' +
    '</select>' +
    '<input type="date" id="rrStart"><span class="arrow">→</span><input type="date" id="rrEnd">' +
    '<button class="btn" id="rrRefresh" title="Recompute from source, bypassing caches">Refresh</button>' +
    '<span id="loading">loading…</span>';
  const r = Range.get();
  $('rrStart').value = r.start;
  $('rrEnd').value = r.end;
  const fire = (force) => { $('rangeLabel') && ($('rangeLabel').textContent = Range.label()); onChange(force === true); };
  const syncInputs = () => { const nr = Range.get(); $('rrStart').value = nr.start; $('rrEnd').value = nr.end; };
  const applyYearPeriod = () => {
    const y = $('rrYear').value;
    if (!y) return;
    const p = periodRange(Number(y), $('rrPeriod').value);
    Range.set(p.start, p.end);
    $('rrPreset').value = 'custom';
    syncInputs();
    fire();
  };
  // Reflect the current range in the year/period selects when it matches one.
  (function preselect() {
    const yr = r.start.slice(0, 4);
    if (r.end.slice(0, 4) !== yr) return;
    for (const k of Object.keys(PERIOD_NAMES)) {
      const p = periodRange(Number(yr), k);
      if (p.start === r.start && p.end === r.end) { $('rrYear').value = yr; $('rrPeriod').value = k; return; }
    }
  })();
  $('rrYear').addEventListener('change', applyYearPeriod);
  $('rrPeriod').addEventListener('change', applyYearPeriod);
  $('rrPreset').addEventListener('change', () => {
    if ($('rrPreset').value !== 'custom') {
      applyPreset($('rrPreset').value);
      $('rrYear').value = '';
      syncInputs();
      fire();
    }
  });
  for (const id of ['rrStart', 'rrEnd']) {
    $(id).addEventListener('change', () => {
      $('rrPreset').value = 'custom';
      $('rrYear').value = '';
      const s = $('rrStart').value, e = $('rrEnd').value;
      if (s && e && s <= e) { Range.set(s, e); fire(); }
    });
  }
  $('rrRefresh').addEventListener('click', () => fire(true));
  if ($('rangeLabel')) $('rangeLabel').textContent = Range.label();
}

async function jfetch(url) {
  const res = await fetch(url);
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  // Read as text first: when the server is busy or restarting, the hosting
  // proxy can answer with plain text ("upstream error") — surfacing a raw
  // JSON-parse failure at the user is never OK.
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error('The server is taking longer than usual (probably computing a big date range). Wait a minute and press Refresh.');
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* Guards against out-of-order async renders: when the range changes, responses
 * from superseded requests must never paint the page. Usage:
 *   const fresh = staleGuard();  ...await...  if (!fresh()) return; */
let __loadSeq = 0;
function staleGuard() {
  const my = ++__loadSeq;
  return () => my === __loadSeq;
}

function showBanner(html) {
  const b = $('banner');
  if (!b) return;
  b.innerHTML = html;
  b.classList.add('show');
}

async function checkStatus() {
  const s = await jfetch('/api/status');
  if (s.missingConfig) { showBanner('<strong>Not configured.</strong> Missing: ' + s.missingConfig.join(', ')); return null; }
  if (!s.connected) { showBanner('<strong>Not connected.</strong> <a class="connect" href="/connect">Connect QuickBooks</a>.'); return null; }
  if (s.staleWarning) showBanner('<strong>Connection warning.</strong> ' + escapeHtml(s.staleWarning) + ' <a class="connect" href="/connect">Reconnect</a>');
  return s;
}

function setLoading(on) { const l = $('loading'); if (l) l.classList.toggle('show', on); }

/* Keeps report links carrying the current range. */
function linkWithRange(path) { return path + '?' + Range.qs(); }
