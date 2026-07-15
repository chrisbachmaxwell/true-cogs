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

/* Renders the shared range control into #rangeBox and wires onChange. */
function mountRange(onChange) {
  const box = $('rangeBox');
  box.className = 'range';
  box.innerHTML =
    '<select id="rrPreset">' +
      '<option value="custom">Custom</option>' +
      '<option value="this">This month</option>' +
      '<option value="last">Last month</option>' +
      '<option value="l3">Last 3 months</option>' +
      '<option value="ytd">Year to date</option>' +
      '<option value="h1">H1 (Jan 1 – Jun 30)</option>' +
      '<option value="t12">Trailing 12 months</option>' +
    '</select>' +
    '<input type="date" id="rrStart"><span class="arrow">→</span><input type="date" id="rrEnd">' +
    '<button class="btn" id="rrRefresh" title="Recompute from source, bypassing caches">Refresh</button>' +
    '<span id="loading">loading…</span>';
  const r = Range.get();
  $('rrStart').value = r.start;
  $('rrEnd').value = r.end;
  const fire = (force) => { $('rangeLabel') && ($('rangeLabel').textContent = Range.label()); onChange(force === true); };
  $('rrPreset').addEventListener('change', () => {
    if ($('rrPreset').value !== 'custom') {
      applyPreset($('rrPreset').value);
      const nr = Range.get();
      $('rrStart').value = nr.start;
      $('rrEnd').value = nr.end;
      fire();
    }
  });
  for (const id of ['rrStart', 'rrEnd']) {
    $(id).addEventListener('change', () => {
      $('rrPreset').value = 'custom';
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
  const data = await res.json();
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
