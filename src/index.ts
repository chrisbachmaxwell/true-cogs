import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { config, missingQboConfig } from './config';
import { initDb, getConfigValue, setConfigValue, getCachedMonth, setCachedMonth } from './db';
import { buildAuthUri, handleCallback, createQboApi, connectionStatus, QboApi } from './qbo';
import { computeMonthlySpend, MonthlySpendResult } from './inventorySpend';
import { computeMonthlyPnl, MonthlyPnl } from './pnl';
import { computeCashFlow, reportBalances } from './cashflow';
import { runSync, syncIfStale, syncStatus, isStoreFresh, makeLocalApi } from './sync';
import { computeBankFlow } from './bankflow';
import { monthDateRange } from './inventorySpend';
import {
  authConfigured,
  requireAuth,
  sessionEmail,
  requestLoginLink,
  consumeLoginToken,
  setSessionCookie,
  clearSessionCookie,
} from './auth';

const app = express();
// Railway terminates TLS at its proxy; trust it so req.protocol is https.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

app.get('/connect', (_req, res) => {
  const missing = missingQboConfig();
  if (missing.length) {
    return res.status(503).send(`QuickBooks is not configured. Missing env vars: ${missing.join(', ')}`);
  }
  res.redirect(buildAuthUri());
});

app.get(
  '/callback',
  asyncRoute(async (req, res) => {
    await handleCallback(req.originalUrl);
    // Account id can change between companies/environments — re-resolve on reconnect.
    await setConfigValue(ACCOUNTS_KEY, '');
    await setConfigValue('bank_accounts_json', '');
    await setConfigValue('retail_income_accounts_json', '');
    res.redirect('/?connected=1');
  })
);

// ---- auth (email magic link; enforced only when RESEND_API_KEY is set) ----
// /connect and /callback stay open on purpose: the person authorizing QuickBooks
// (company admin) may not be a dashboard user, and neither route exposes data.

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

app.get('/login', (req, res) => {
  if (!authConfigured() || sessionEmail(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.post(
  '/auth/request',
  asyncRoute(async (req, res) => {
    if (!authConfigured()) return res.status(503).json({ error: 'Sign-in is not configured' });
    // Same response whether or not the address is allowed — no enumeration.
    requestLoginLink(req.body?.email, baseUrl(req)).catch((err) =>
      console.error('[auth] failed to send login link:', err)
    );
    res.json({ ok: true });
  })
);

app.get(
  '/auth/verify',
  asyncRoute(async (req, res) => {
    const email = await consumeLoginToken(String(req.query.token || ''));
    if (!email) {
      return res
        .status(400)
        .send('This sign-in link is invalid, expired, or already used. <a href="/login">Request a new one</a>.');
    }
    setSessionCookie(res, email);
    res.redirect('/');
  })
);

app.get('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.redirect('/login');
});

app.use(['/api/inventory-spend', '/api/inventory-spend/trend', '/api/pnl', '/api/status'], requireAuth);

/** Data source for computations: the local mirror when it's fresh, otherwise
 * the live API. The remote client is always created (token upkeep + report
 * and fallback delegation). */
async function getComputeApi(): Promise<QboApi> {
  const remote = await createQboApi();
  return (await isStoreFresh()) ? makeLocalApi(remote) : remote;
}

const ACCOUNTS_KEY = 'inventory_accounts_json';

interface TrackedAccount {
  id: string;
  acctNum: string | null;
  name: string;
}

/** Resolves configured tokens (account number or exact name, case-insensitive)
 * against the chart of accounts. Result is cached; /callback clears it. */
async function resolveAccounts(api: QboApi, tokens: string[], hint: RegExp): Promise<any[]> {
  const all = await api.listAccounts();
  const matched: any[] = [];
  const misses: string[] = [];
  for (const token of tokens) {
    const t = token.toLowerCase();
    const hit = all.find(
      (a) =>
        (a.AcctNum || '').toLowerCase() === t ||
        (a.Name || '').toLowerCase() === t ||
        (a.FullyQualifiedName || '').toLowerCase() === t
    );
    if (hit) matched.push(hit);
    else misses.push(token);
  }
  if (misses.length) {
    const candidates = all
      .filter((a) => hint.test(a.Name || ''))
      .map((a) => `${a.AcctNum ? `#${a.AcctNum} ` : ''}${a.Name}`)
      .join(', ');
    throw new Error(
      `No chart-of-accounts match for: ${misses.join(', ')}. Similar accounts: ${candidates || 'none'}`
    );
  }
  return matched;
}

/** Tracked accounts, resolved once and stored so cache keys and view filters
 * work without hitting QuickBooks. Cleared on /callback. */
/** Reads a cached account resolution, invalidating it when the configured
 * token list has changed since it was stored (env var edits apply on deploy). */
function readAccountCache(raw: string | null, tokens: string[]): TrackedAccount[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return null; // legacy shape without tokens — re-resolve
    if (JSON.stringify(parsed.tokens) !== JSON.stringify(tokens)) return null;
    return parsed.accounts as TrackedAccount[];
  } catch {
    return null;
  }
}

async function getTrackedAccounts(api?: QboApi): Promise<TrackedAccount[]> {
  const cached = readAccountCache(await getConfigValue(ACCOUNTS_KEY), config.inventoryAccounts);
  if (cached) return cached;
  const resolved = await resolveAccounts(
    api ?? (await getComputeApi()),
    config.inventoryAccounts,
    /inventory/i
  );
  const tracked: TrackedAccount[] = resolved.map((a) => ({
    id: String(a.Id),
    acctNum: a.AcctNum ?? null,
    name: a.Name,
  }));
  await setConfigValue(ACCOUNTS_KEY, JSON.stringify({ tokens: config.inventoryAccounts, accounts: tracked }));
  console.log(
    `[qbo] resolved inventory accounts: ${tracked.map((t) => `${t.name} (#${t.acctNum || '?'} → Id ${t.id})`).join(', ')}`
  );
  return tracked;
}

/** ?accounts=all (default) or a comma list of account numbers/names, e.g.
 * ?accounts=11901. Returns the ids to filter by and a stable cache-key suffix. */
function selectAccounts(
  param: unknown,
  tracked: TrackedAccount[]
): { ids: string[]; viewKey: string } {
  const raw = String(param || 'all').trim();
  if (!raw || raw.toLowerCase() === 'all') {
    return { ids: tracked.map((t) => t.id), viewKey: 'all' };
  }
  const tokens = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const selected = tracked.filter(
    (t) => tokens.includes((t.acctNum || '').toLowerCase()) || tokens.includes(t.name.toLowerCase())
  );
  if (selected.length !== tokens.length) {
    throw Object.assign(
      new Error(
        `Unknown account filter "${raw}". Tracked accounts: ` +
          tracked.map((t) => `#${t.acctNum || '?'} ${t.name}`).join(', ')
      ),
      { statusCode: 400 }
    );
  }
  return {
    ids: selected.map((t) => t.id),
    viewKey: selected.map((t) => t.acctNum || t.id).sort().join('+'),
  };
}

function currentMonthUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

const CURRENT_MONTH_CACHE_TTL_MS = 60 * 60 * 1000; // re-compute the open month hourly

// The dashboard requests the current month and the trend at once; both can ask
// for the same uncached month+view, so identical computations share one promise.
const inFlightMonths = new Map<string, Promise<MonthlySpendResult>>();

async function getMonthlySpend(
  month: string,
  forceRefresh: boolean,
  accountsParam?: unknown
): Promise<MonthlySpendResult> {
  const tracked = await getTrackedAccounts();
  const { ids, viewKey } = selectAccounts(accountsParam, tracked);
  // 'all' keeps the bare-month key so pre-view cache rows stay valid.
  const cacheKey = viewKey === 'all' ? month : `${month}:${viewKey}`;

  if (!forceRefresh) {
    const cached = await getCachedMonth(cacheKey);
    if (cached) {
      const isClosedMonth = month < currentMonthUtc();
      const fresh = Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS;
      if (isClosedMonth || fresh) return cached.data as MonthlySpendResult;
    }
    const inFlight = inFlightMonths.get(cacheKey);
    if (inFlight) return inFlight;
  }
  const promise = (async () => {
    const api = await getComputeApi();
    const result = await computeMonthlySpend(api, ids, month);
    await setCachedMonth(cacheKey, result);
    return result;
  })().finally(() => inFlightMonths.delete(cacheKey));
  inFlightMonths.set(cacheKey, promise);
  return promise;
}

app.get(
  '/api/inventory-spend',
  asyncRoute(async (req, res) => {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Provide ?month=YYYY-MM' });
    }
    const result = await getMonthlySpend(month, req.query.refresh === '1', req.query.accounts);
    res.json(result);
  })
);

app.get(
  '/api/inventory-spend/trend',
  asyncRoute(async (req, res) => {
    const months = Math.min(Math.max(parseInt(String(req.query.months || '12'), 10) || 12, 1), 36);
    const now = new Date();
    const list: { month: string; total: number; bucket1Total: number; bucket2Total: number; bookedTotal: number }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const month = d.toISOString().slice(0, 7);
      const r = await getMonthlySpend(month, false, req.query.accounts);
      list.push({
        month,
        total: r.total,
        bucket1Total: r.bucket1Total,
        bucket2Total: r.bucket2Total,
        bookedTotal: r.bookedTotal,
      });
    }
    res.json({ months: list });
  })
);

const BANK_ACCOUNTS_KEY = 'bank_accounts_json';

/** All Bank-type accounts from the chart of accounts, cached like the
 * inventory accounts. Cleared on /callback. */
async function getBankAccounts(api?: QboApi): Promise<TrackedAccount[]> {
  const cached = await getConfigValue(BANK_ACCOUNTS_KEY);
  if (cached) return JSON.parse(cached) as TrackedAccount[];
  const all = await (api ?? (await getComputeApi())).listAccounts();
  const banks: TrackedAccount[] = all
    .filter((a) => a.AccountType === 'Bank')
    .map((a) => ({ id: String(a.Id), acctNum: a.AcctNum ?? null, name: a.Name }));
  await setConfigValue(BANK_ACCOUNTS_KEY, JSON.stringify(banks));
  console.log(`[qbo] bank accounts: ${banks.map((b) => `${b.name} (#${b.acctNum || '?'})`).join(', ') || 'none'}`);
  return banks;
}

const RETAIL_ACCOUNTS_KEY = 'retail_income_accounts_json';

/** Income account(s) counted as revenue. QBO_RETAIL_INCOME_ACCOUNTS=all tracks
 * every Income / Other Income account in the chart. Cleared on /callback. */
async function getRetailIncomeAccounts(api: QboApi): Promise<TrackedAccount[]> {
  const cached = readAccountCache(await getConfigValue(RETAIL_ACCOUNTS_KEY), config.retailIncomeAccounts);
  if (cached) return cached;
  const wantAll = config.retailIncomeAccounts.length === 1 &&
    config.retailIncomeAccounts[0].toLowerCase() === 'all';
  const resolved = wantAll
    ? (await api.listAccounts()).filter(
        (a) => a.AccountType === 'Income' || a.AccountType === 'Other Income'
      )
    : await resolveAccounts(api, config.retailIncomeAccounts, /sales|income|revenue/i);
  const tracked: TrackedAccount[] = resolved.map((a) => ({
    id: String(a.Id),
    acctNum: a.AcctNum ?? null,
    name: a.Name,
  }));
  await setConfigValue(RETAIL_ACCOUNTS_KEY, JSON.stringify({ tokens: config.retailIncomeAccounts, accounts: tracked }));
  console.log(
    `[qbo] retail income accounts: ${tracked.map((t) => `${t.name} (#${t.acctNum || '?'} → Id ${t.id})`).join(', ')}`
  );
  return tracked;
}

// Item → income-account map. Item catalogs are large, so this is held in memory
// and refreshed every 6 hours rather than persisted.
let itemMapCache: { map: Map<string, string>; loadedAt: number } | null = null;
const ITEM_MAP_TTL_MS = 6 * 60 * 60 * 1000;

async function getItemIncomeMap(api: QboApi): Promise<Map<string, string>> {
  if (itemMapCache && Date.now() - itemMapCache.loadedAt < ITEM_MAP_TTL_MS) {
    return itemMapCache.map;
  }
  const items = await api.listItems();
  const map = new Map<string, string>();
  for (const item of items) {
    const income = item.IncomeAccountRef?.value;
    if (income) map.set(String(item.Id), String(income));
  }
  console.log(`[qbo] item→income-account map loaded: ${map.size} of ${items.length} items`);
  itemMapCache = { map, loadedAt: Date.now() };
  return map;
}

const DIRECT_COST_KEY = 'direct_cost_accounts_json';

/** Direct-cost accounts (freight, repairs, materials) added to COGS. */
async function getDirectCostAccounts(api: QboApi): Promise<TrackedAccount[]> {
  const cached = readAccountCache(await getConfigValue(DIRECT_COST_KEY), config.directCostAccounts);
  if (cached) return cached;
  let tracked: TrackedAccount[] = [];
  try {
    const resolved = await resolveAccounts(api, config.directCostAccounts, /freight|repair|material/i);
    tracked = resolved.map((a) => ({ id: String(a.Id), acctNum: a.AcctNum ?? null, name: a.Name }));
  } catch (err: any) {
    console.warn('[qbo] direct-cost account resolution failed:', err.message);
    return [];
  }
  await setConfigValue(DIRECT_COST_KEY, JSON.stringify({ tokens: config.directCostAccounts, accounts: tracked }));
  return tracked;
}

const TAX_ACCOUNTS_KEY = 'sales_tax_accounts_json';

/** Sales-tax liability account(s), e.g. #21900. Resolution failure downgrades
 * to "no netting" with a warning instead of breaking the P&L. */
async function getSalesTaxAccounts(api: QboApi): Promise<TrackedAccount[]> {
  const cached = readAccountCache(await getConfigValue(TAX_ACCOUNTS_KEY), config.salesTaxAccounts);
  if (cached) return cached;
  let tracked: TrackedAccount[] = [];
  try {
    const resolved = await resolveAccounts(api, config.salesTaxAccounts, /tax/i);
    tracked = resolved.map((a) => ({ id: String(a.Id), acctNum: a.AcctNum ?? null, name: a.Name }));
  } catch (err: any) {
    console.warn('[qbo] sales-tax account resolution failed:', err.message);
    return [];
  }
  await setConfigValue(TAX_ACCOUNTS_KEY, JSON.stringify({ tokens: config.salesTaxAccounts, accounts: tracked }));
  return tracked;
}

/** Cash remitted to the sales-tax account(s) in a month: the same payment-
 * tracing engine as COGS, pointed at the tax liability account. If no
 * remittance transactions are visible (Sales-Tax-Center payments are hidden
 * from the API), falls back to the tax account's balance-sheet movement. */
async function getSalesTaxRemitted(api: QboApi, month: string): Promise<{ amount: number; source: string }> {
  const taxAccounts = await getSalesTaxAccounts(api);
  if (!taxAccounts.length) return { amount: 0, source: 'none' };
  const taxIds = taxAccounts.map((t) => t.id);
  const spend = await computeMonthlySpend(api, taxIds, month);
  if (spend.total > 0) return { amount: spend.total, source: 'transactions' };
  try {
    const { start, end } = monthDateRange(month);
    const [before, after] = [await api.balanceSheet(dayBefore(start)), await api.balanceSheet(end)];
    const b = reportBalances(before);
    const a = reportBalances(after);
    let delta = 0;
    for (const id of taxIds) delta += (a.get(id)?.value ?? 0) - (b.get(id)?.value ?? 0);
    // Balance falling = remittances exceeding recorded collections.
    return { amount: Math.max(0, Math.round(-delta * 100) / 100), source: 'balance-sheet' };
  } catch {
    return { amount: 0, source: 'unavailable' };
  }
}

const inFlightPnl = new Map<string, Promise<MonthlyPnl>>();

async function getMonthlyPnl(month: string, forceRefresh: boolean): Promise<MonthlyPnl> {
  const cacheKey = `pnl:${month}`;
  if (!forceRefresh) {
    const cached = await getCachedMonth(cacheKey);
    if (cached) {
      const isClosedMonth = month < currentMonthUtc();
      const fresh = Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS;
      if (isClosedMonth || fresh) return cached.data as MonthlyPnl;
    }
    const inFlight = inFlightPnl.get(cacheKey);
    if (inFlight) return inFlight;
  }
  const promise = (async () => {
    const spend = await getMonthlySpend(month, forceRefresh); // combined accounts, cached
    const api = await getComputeApi();
    const tax = await getSalesTaxRemitted(api, month);
    const directIds = (await getDirectCostAccounts(api)).map((t) => t.id);
    const directCosts = directIds.length
      ? (await computeMonthlySpend(api, directIds, month)).total
      : 0;
    const result = await computeMonthlyPnl(
      api,
      {
        bankAccountIds: (await getBankAccounts(api)).map((b) => b.id),
        retailIncomeAccountIds: (await getRetailIncomeAccounts(api)).map((r) => r.id),
        accountTypes: new Map(
          (await api.listAccounts()).map((a: any) => [String(a.Id), a.AccountType as string])
        ),
      },
      month,
      spend.total,
      tax.amount,
      directCosts
    );
    if (tax.source === 'balance-sheet') {
      result.warnings.push(
        'Sales tax remitted derived from the tax account balance movement (remittance transactions not visible to the API).'
      );
    }
    await setCachedMonth(cacheKey, result);
    return result;
  })().finally(() => inFlightPnl.delete(cacheKey));
  inFlightPnl.set(cacheKey, promise);
  return promise;
}

app.get(
  '/api/pnl',
  asyncRoute(async (req, res) => {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Provide ?month=YYYY-MM' });
    }
    res.json(await getMonthlyPnl(month, req.query.refresh === '1'));
  })
);

/** Flattens QBO's nested report rows into { name, id, value } leaf accounts. */
function flattenReportRows(rows: any, out: { name: string; id: string | null; value: number }[] = []) {
  for (const row of rows?.Row || []) {
    const col = row.ColData;
    if (col?.length >= 2 && col[0]?.value) {
      const value = Number(col[col.length - 1]?.value);
      if (!Number.isNaN(value)) {
        out.push({ name: col[0].value, id: col[0].id ?? null, value });
      }
    }
    if (row.Rows) flattenReportRows(row.Rows, out);
  }
  return out;
}

function monthsBetween(start: string, end: string): string[] {
  const list: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    list.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return list;
}

function validRange(req: Request, res: Response): { start: string; end: string; months: string[] } | null {
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end) || start > end) {
    res.status(400).json({ error: 'Provide ?start=YYYY-MM&end=YYYY-MM with start <= end' });
    return null;
  }
  const months = monthsBetween(start, end);
  if (months.length > 24) {
    res.status(400).json({ error: 'Range too large (max 24 months)' });
    return null;
  }
  return { start, end, months };
}

/** Aggregated P&L + spend over a month range, driven by the monthly caches. */
app.get(
  '/api/summary',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validRange(req, res);
    if (!range) return;
    const months = [];
    const totals = {
      income: 0, incomeDeposits: 0, incomeInvoicePayments: 0, incomeReceipts: 0, incomeRefunds: 0,
      salesTaxRemitted: 0, revenueNet: 0, cogsOffsets: 0, expenseOffsets: 0, directCosts: 0,
      bankInflows: 0, cogs: 0, grossProfit: 0, bookedCogs: 0, vendorCreditsApplied: 0,
    };
    const warnings: string[] = [];
    for (const month of range.months) {
      const [pnl, spend] = [await getMonthlyPnl(month, false), await getMonthlySpend(month, false)];
      months.push({
        month,
        income: pnl.retailCashIn.total,
        bankInflows: pnl.bankInflows.total,
        cogs: pnl.cogs,
        grossProfit: pnl.grossProfit,
        margin: pnl.grossMarginPct,
        booked: spend.bookedTotal,
      });
      totals.income += pnl.retailCashIn.total;
      totals.salesTaxRemitted += pnl.salesTaxRemitted ?? 0;
      totals.revenueNet += pnl.revenueNet ?? pnl.retailCashIn.total;
      totals.cogsOffsets += pnl.cogsOffsets ?? 0;
      totals.expenseOffsets += pnl.expenseOffsets ?? 0;
      totals.directCosts += pnl.directCosts ?? 0;
      totals.incomeDeposits += pnl.retailCashIn.deposits;
      totals.incomeInvoicePayments += pnl.retailCashIn.invoicePayments;
      totals.incomeReceipts += pnl.retailCashIn.salesReceipts;
      totals.incomeRefunds += pnl.retailCashIn.refunds;
      totals.bankInflows += pnl.bankInflows.total;
      totals.cogs += pnl.cogs;
      totals.grossProfit += pnl.grossProfit;
      totals.bookedCogs += spend.bookedTotal;
      totals.vendorCreditsApplied += spend.vendorCreditsApplied;
      warnings.push(...pnl.warnings.map((w) => `${month}: ${w}`), ...spend.warnings.map((w) => `${month}: ${w}`));
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = r2(totals[k]);
    res.json({
      start: range.start,
      end: range.end,
      totals: {
        ...totals,
        grossMarginPct: totals.revenueNet > 0 ? r2((totals.grossProfit / totals.revenueNet) * 100) : null,
      },
      months,
      warnings,
    });
  })
);

// Long-running range computations share one in-flight promise per cache key,
// so repeated requests (edge timeouts, impatient reloads) can't stack work.
const inFlightRange = new Map<string, Promise<any>>();

function dedupe<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const existing = inFlightRange.get(key);
  if (existing) return existing as Promise<T>;
  const p = compute().finally(() => inFlightRange.delete(key));
  inFlightRange.set(key, p);
  return p;
}

const dayBefore = (isoDate: string) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Balance-sheet diff over the range: bank change + where the cash went. */
app.get(
  '/api/cash-flow',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validRange(req, res);
    if (!range) return;
    const asOfStart = dayBefore(monthDateRange(range.start).start);
    const asOfEnd = monthDateRange(range.end).end;
    const cacheKey = `cf:${asOfStart}:${asOfEnd}`;
    if (req.query.refresh !== '1') {
      const cached = await getCachedMonth(cacheKey);
      const endIsClosed = range.end < currentMonthUtc();
      if (cached && (endIsClosed || Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS)) {
        return res.json(cached.data);
      }
    }
    const result = await dedupe(cacheKey, async () => {
      const api = await getComputeApi();
      const r = await computeCashFlow(api, asOfStart, asOfEnd);
      await setCachedMonth(cacheKey, r);
      return r;
    });
    res.json(result);
  })
);

/** Direct-method bank reconciliation over the range: every inflow and every
 * categorizable outflow, with the API-invisible remainder reported honestly. */
app.get(
  '/api/bank-flow',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validRange(req, res);
    if (!range) return;
    const startDate = monthDateRange(range.start).start;
    const endDate = monthDateRange(range.end).end;
    const cacheKey = `bf:${startDate}:${endDate}`;
    if (req.query.refresh !== '1') {
      const cached = await getCachedMonth(cacheKey);
      const endIsClosed = range.end < currentMonthUtc();
      if (cached && (endIsClosed || Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS)) {
        return res.json(cached.data);
      }
    }
    const result = await dedupe(cacheKey, async () => {
      const api = await getComputeApi();
      const banks = await getBankAccounts(api);
      const inventoryIds = (await getTrackedAccounts(api)).map((t) => t.id);
      // Actual bank change comes from the balance-sheet diff at the range edges.
      let actualBankChange: number | null = null;
      try {
        const cf = await computeCashFlow(api, dayBefore(startDate), endDate);
        actualBankChange = cf.bankChange;
      } catch (err: any) {
        console.warn('[bank-flow] balance sheet unavailable:', err.message);
      }
      const r = await computeBankFlow(
        api, banks.map((b) => b.id), inventoryIds, startDate, endDate, actualBankChange
      );
      await setCachedMonth(cacheKey, r);
      return r;
    });
    res.json(result);
  })
);

/** Inflow composition: every deposit line in the range grouped by the account
 * it credits, so income-counted vs non-income inflows can be audited. */
app.get(
  '/api/deposit-lines',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validRange(req, res);
    if (!range) return;
    const startDate = monthDateRange(range.start).start;
    const endDate = monthDateRange(range.end).end;
    const api = await getComputeApi();
    const [deposits, accounts] = [
      await api.queryByDateRange('Deposit', startDate, endDate),
      await api.listAccounts(),
    ];
    const meta = new Map(accounts.map((a: any) => [String(a.Id), a]));
    const byAccount = new Map<string, { name: string; type: string; amount: number; lines: number }>();
    let linkedTxnTotal = 0;
    let depositTotal = 0;
    for (const d of deposits) {
      depositTotal += Number(d.TotalAmt) || 0;
      for (const line of d.Line || []) {
        const ref = line.DepositLineDetail?.AccountRef?.value;
        if (ref) {
          const acct = meta.get(String(ref));
          const key = String(ref);
          const cur = byAccount.get(key) || {
            name: acct?.Name || `Account ${ref}`,
            type: acct?.AccountType || 'Unknown',
            amount: 0,
            lines: 0,
          };
          cur.amount += Number(line.Amount) || 0;
          cur.lines++;
          byAccount.set(key, cur);
        } else if ((line.LinkedTxn || []).length) {
          linkedTxnTotal += Number(line.Amount) || 0;
        }
      }
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    res.json({
      start: startDate,
      end: endDate,
      depositCount: deposits.length,
      depositTotal: r2(depositTotal),
      linkedTxnPortion: r2(linkedTxnTotal),
      byAccount: [...byAccount.entries()]
        .map(([id, v]) => ({ id, ...v, amount: r2(v.amount) }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    });
  })
);

/** Where customer Payment cash landed: grouped by DepositToAccountRef. */
app.get(
  '/api/payments-audit',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validRange(req, res);
    if (!range) return;
    const startDate = monthDateRange(range.start).start;
    const endDate = monthDateRange(range.end).end;
    const api = await getComputeApi();
    const [payments, receipts, accounts] = [
      await api.queryByDateRange('Payment', startDate, endDate),
      await api.queryByDateRange('SalesReceipt', startDate, endDate),
      await api.listAccounts(),
    ];
    const meta = new Map(accounts.map((a: any) => [String(a.Id), a]));
    const summarize = (txns: any[]) => {
      const by = new Map<string, { name: string; type: string; amount: number; count: number }>();
      for (const t of txns) {
        const ref = t.DepositToAccountRef?.value;
        const key = ref ? String(ref) : 'none';
        const acct = ref ? meta.get(String(ref)) : null;
        const cur = by.get(key) || {
          name: acct?.Name || (ref ? `Account ${ref}` : 'No deposit account set'),
          type: acct?.AccountType || 'Unknown',
          amount: 0,
          count: 0,
        };
        cur.amount += Number(t.TotalAmt) || 0;
        cur.count++;
        by.set(key, cur);
      }
      return [...by.values()].map((v) => ({ ...v, amount: Math.round(v.amount * 100) / 100 }))
        .sort((a, b) => b.amount - a.amount);
    };
    const byCustomer = (txns: any[], bankOnly: boolean | null) => {
      const banks = new Set((accounts as any[]).filter((a) => a.AccountType === 'Bank').map((a) => String(a.Id)));
      const by = new Map<string, { amount: number; count: number }>();
      for (const t of txns) {
        const isBank = banks.has(String(t.DepositToAccountRef?.value || ''));
        if (bankOnly !== null && isBank !== bankOnly) continue;
        const name = t.CustomerRef?.name || 'Unknown customer';
        const cur = by.get(name) || { amount: 0, count: 0 };
        cur.amount += Number(t.TotalAmt) || 0;
        cur.count++;
        by.set(name, cur);
      }
      return [...by.entries()]
        .map(([customer, v]) => ({ customer, amount: Math.round(v.amount * 100) / 100, count: v.count }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 20);
    };
    res.json({
      start: startDate,
      end: endDate,
      payments: summarize(payments),
      salesReceipts: summarize(receipts),
      bankPaymentsByCustomer: byCustomer(payments, true),
      nonBankPaymentsByCustomer: byCustomer(payments, false),
    });
  })
);

/** Day-granular date range: ?start=YYYY-MM-DD&end=YYYY-MM-DD (also accepts
 * YYYY-MM, expanded to the whole month — June means through June 30). */
function validDateRange(req: Request, res: Response): { start: string; end: string } | null {
  let start = String(req.query.start || '');
  let end = String(req.query.end || '');
  if (/^\d{4}-\d{2}$/.test(start)) start = monthDateRange(start).start;
  if (/^\d{4}-\d{2}$/.test(end)) end = monthDateRange(end).end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    res.status(400).json({ error: 'Provide ?start=YYYY-MM-DD&end=YYYY-MM-DD (start <= end)' });
    return null;
  }
  return { start, end };
}

/** Full cash P&L statement for an exact date range, with the operating-expense
 * section pulled from the books' accrual P&L for the same period. */
app.get(
  '/api/pnl-statement',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const cacheKey = `stmt:${range.start}:${range.end}`;
    if (req.query.refresh !== '1') {
      const cached = await getCachedMonth(cacheKey);
      const closed = range.end < new Date().toISOString().slice(0, 10);
      if (cached && (closed || Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS)) {
        return res.json(cached.data);
      }
    }
    const result = await dedupe(cacheKey, async () => {
      const api = await getComputeApi();
      const inventoryIds = (await getTrackedAccounts(api)).map((t) => t.id);
      const spend = await computeMonthlySpend(api, inventoryIds, range);
      const taxIds = (await getSalesTaxAccounts(api)).map((t) => t.id);
      const taxRemitted = taxIds.length ? (await computeMonthlySpend(api, taxIds, range)).total : 0;
      const directIds = (await getDirectCostAccounts(api)).map((t) => t.id);
      const directCosts = directIds.length ? (await computeMonthlySpend(api, directIds, range)).total : 0;
      const pnl = await computeMonthlyPnl(
        api,
        {
          bankAccountIds: (await getBankAccounts(api)).map((b) => b.id),
          retailIncomeAccountIds: (await getRetailIncomeAccounts(api)).map((r) => r.id),
          accountTypes: new Map(
            (await api.listAccounts()).map((a: any) => [String(a.Id), a.AccountType as string])
          ),
        },
        range,
        spend.total,
        taxRemitted,
        directCosts
      );
      // Operating expenses come from the books' accrual P&L for the same period.
      let expenses: { total: number; rows: { name: string; amount: number }[] } = { total: 0, rows: [] };
      try {
        const report = await api.profitAndLoss(range.start, range.end);
        const walk = (rows: any, inExpenses: boolean) => {
          for (const row of rows?.Row || []) {
            const header = row.Header?.ColData?.[0]?.value || '';
            const isExpenseSection = inExpenses || header === 'Expenses';
            if (row.Summary && header === 'Expenses') {
              expenses.total = Number(row.Summary.ColData?.[1]?.value) || 0;
            }
            const col = row.ColData;
            if (isExpenseSection && col?.length >= 2 && col[0]?.value) {
              const amt = Number(col[col.length - 1]?.value);
              if (!Number.isNaN(amt) && amt !== 0) expenses.rows.push({ name: col[0].value, amount: amt });
            }
            if (row.Rows) walk(row.Rows, isExpenseSection);
          }
        };
        walk(report?.Rows, false);
        expenses.rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
        expenses.rows = expenses.rows.slice(0, 30);
      } catch (err: any) {
        console.warn('[pnl-statement] expense report unavailable:', err.message);
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const expensesNet = r2(expenses.total - pnl.expenseOffsets);
      const statement = {
        start: range.start,
        end: range.end,
        income: {
          moneyIn: pnl.retailCashIn.total,
          deposits: pnl.retailCashIn.deposits,
          invoicePayments: pnl.retailCashIn.invoicePayments,
          salesReceipts: pnl.retailCashIn.salesReceipts,
          refunds: pnl.retailCashIn.refunds,
          salesTaxRemitted: pnl.salesTaxRemitted,
          netRevenue: pnl.revenueNet,
        },
        cogs: {
          inventoryCash: pnl.cogs,
          directCosts: pnl.directCosts,
          rebateOffsets: pnl.cogsOffsets,
          total: r2(pnl.cogs + pnl.directCosts - pnl.cogsOffsets),
          bookedReference: spend.bookedTotal,
          vendorCreditsApplied: spend.vendorCreditsApplied,
        },
        grossProfit: pnl.grossProfit,
        grossMarginPct: pnl.grossMarginPct,
        expenses: {
          totalFromBooks: expenses.total,
          reimbursements: pnl.expenseOffsets,
          net: expensesNet,
          rows: expenses.rows,
        },
        noi: r2(pnl.grossProfit - expensesNet),
        bankInflows: pnl.bankInflows.total,
        warnings: pnl.warnings,
      };
      await setCachedMonth(cacheKey, statement);
      return statement;
    });
    res.json(result);
  })
);

/** Trigger a sync of the raw-transaction mirror. ?full=1 re-pulls the window. */
app.get(
  '/api/sync',
  requireAuth,
  asyncRoute(async (req, res) => {
    const status = await syncStatus();
    if (status.running) return res.json({ started: false, ...status });
    runSync(req.query.full === '1').catch(() => undefined);
    res.json({ started: true, ...status });
  })
);

app.get(
  '/api/accounts',
  requireAuth,
  asyncRoute(async (req, res) => {
    const api = await getComputeApi();
    const type = String(req.query.type || '').toLowerCase();
    const accounts = (await api.listAccounts())
      .filter((a) => !type || (a.AccountType || '').toLowerCase().includes(type))
      .map((a) => ({
        id: a.Id,
        acctNum: a.AcctNum ?? null,
        name: a.Name,
        type: a.AccountType,
        subType: a.AccountSubType,
        active: a.Active,
        currentBalance: a.CurrentBalance,
      }));
    res.json({ count: accounts.length, accounts });
  })
);

app.get(
  '/api/balance-sheet',
  requireAuth,
  asyncRoute(async (req, res) => {
    const asOf = String(req.query.as_of || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return res.status(400).json({ error: 'Provide ?as_of=YYYY-MM-DD' });
    }
    const api = await getComputeApi();
    const report = await api.balanceSheet(asOf);
    res.json({ asOf, accounts: flattenReportRows(report?.Rows) });
  })
);

app.get(
  '/api/status',
  asyncRoute(async (_req, res) => {
    const missing = missingQboConfig();
    if (missing.length) {
      return res.json({ connected: false, environment: config.qboEnvironment, missingConfig: missing });
    }
    const status: any = await connectionStatus();
    status.sync = await syncStatus();
    if (status.connected) {
      // Surface which chart-of-accounts entry the spend math is keyed to, so the
      // account number can be verified against the books.
      try {
        const api = await getComputeApi();
        status.inventoryAccounts = await getTrackedAccounts(api);
      } catch (err: any) {
        status.inventoryAccountError = err.message;
      }
    }
    res.json(status);
  })
);

// No express.static: report pages are only reachable through the auth gate.
// Style/script assets carry no data and are served openly.
const pub = (f: string) => path.join(__dirname, '..', 'public', f);
app.get('/theme.css', (_req, res) => res.sendFile(pub('theme.css')));
app.get('/app.js', (_req, res) => res.sendFile(pub('app.js')));
app.get(['/', '/index.html'], requireAuth, (_req, res) => res.sendFile(pub('index.html')));
app.get('/pnl', requireAuth, (_req, res) => res.sendFile(pub('pnl.html')));
app.get('/bank', requireAuth, (_req, res) => res.sendFile(pub('bank.html')));
app.get('/cashflow', requireAuth, (_req, res) => res.sendFile(pub('cashflow.html')));
app.get('/inventory', requireAuth, (_req, res) => res.sendFile(pub('inventory.html')));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal error' });
});

async function main() {
  if (config.databaseUrl) {
    await initDb();
    console.log('[db] schema ready');
    // Keep the raw-transaction mirror fresh: check at boot and twice daily.
    if (!missingQboConfig().length) {
      setTimeout(() => syncIfStale(), 15_000);
      setInterval(() => syncIfStale(), 12 * 60 * 60 * 1000);
    }
  } else {
    console.warn('[db] DATABASE_URL not set — token storage and caching disabled');
  }
  app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (${config.qboEnvironment})`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
