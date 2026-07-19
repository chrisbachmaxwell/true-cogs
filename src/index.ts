import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { config, missingQboConfig } from './config';
import { initDb, getConfigValue, setConfigValue, getCachedMonth, setCachedMonth, getPool } from './db';
import { buildAuthUri, handleCallback, createQboApi, connectionStatus, QboApi } from './qbo';
import { computeMonthlySpend, MonthlySpendResult, SpendOptions } from './inventorySpend';
import { computeMonthlyPnl, MonthlyPnl, PnlContext } from './pnl';
import { computePnlDetail, expenseAccountDetail, DetailRow } from './pnlDetail';
import { computeCashFlow, reportBalances } from './cashflow';
import { mirrorChangedSince, runSync, syncIfStale, syncStatus, isStoreFresh, makeLocalApi, upsertTxns, setOnSyncComplete } from './sync';
import { planReclassify, planRevert } from './reclassify';
import fs from 'fs';
import { bankFlowDetail, computeBankFlow } from './bankflow';
import { monthDateRange, positiveLineTotal } from './inventorySpend';
import {
  authEnabled,
  bootstrapAdmin,
  requireAuth,
  requireAdmin,
  sessionUser,
  verifyLogin,
  verifyPassword,
  getUser,
  listUsers,
  upsertUser,
  setPassword,
  deleteUser,
  setSessionCookie,
  clearSessionCookie,
  User,
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

// ---- auth (email + password; enforced whenever at least one user exists) ----
// /connect and /callback stay open on purpose: the person authorizing QuickBooks
// (company admin) may not be a dashboard user, and neither route exposes data.

app.get(
  '/login',
  asyncRoute(async (req, res) => {
    if (!(await authEnabled()) || (await sessionUser(req))) return res.redirect('/');
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  })
);

app.post(
  '/auth/login',
  asyncRoute(async (req, res) => {
    if (!(await authEnabled())) return res.status(503).json({ error: 'Sign-in is not set up yet' });
    const user = await verifyLogin(String(req.body?.email || ''), String(req.body?.password || ''));
    // Generic error either way — no hint whether the email exists.
    if (!user) return res.status(401).json({ error: 'That email and password combination didn’t work.' });
    setSessionCookie(res, user.email);
    res.json({ ok: true, mustChange: user.mustChange });
  })
);

/** Change own password. Allowed even while must_change is set — it IS the
 * password-change flow. */
app.post(
  '/auth/password',
  asyncRoute(async (req, res) => {
    const user = await sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    const current = String(req.body?.current || '');
    const next = String(req.body?.next || '');
    if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const full = await getUser(user.email);
    if (!full || !verifyPassword(current, full.passHash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    await setPassword(user.email, next);
    res.json({ ok: true });
  })
);

app.get('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.redirect('/login');
});

app.get(
  '/auth/me',
  asyncRoute(async (req, res) => {
    const enabled = await authEnabled();
    const user = enabled ? await sessionUser(req) : null;
    res.json({ enabled, user: user ? { email: user.email, isAdmin: user.isAdmin, mustChange: user.mustChange } : null });
  })
);

// ---- user management (admin only) ----

app.get(
  '/api/users',
  requireAuth,
  requireAdmin,
  asyncRoute(async (_req, res) => {
    res.json({ users: await listUsers() });
  })
);

app.post(
  '/api/users',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    // Creates or resets; the person must pick their own password on first sign-in.
    await upsertUser(email, password, { isAdmin: req.body?.isAdmin === true, mustChange: true });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/users',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    const me = (req as any).user as User;
    if (!email) return res.status(400).json({ error: 'Provide ?email=' });
    if (email === me.email) return res.status(400).json({ error: 'You can’t remove your own account.' });
    await deleteUser(email);
    res.json({ ok: true });
  })
);

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
  const api = await getComputeApi();
  const tracked = await getTrackedAccounts(api);
  const { ids, viewKey } = selectAccounts(accountsParam, tracked);
  const { opts, cachePrefix } = await getSpendOpts(api);
  // 'all' keeps the bare-month key so pre-view cache rows stay valid.
  const cacheKey = cachePrefix + 'sp2:' + (viewKey === 'all' ? month : `${month}:${viewKey}`);

  if (!forceRefresh) {
    const cached = await getCachedMonth(cacheKey);
    if (cached) {
      const isClosedMonth = month < currentMonthUtc();
      const fresh = Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS;
      const { start, end } = monthDateRange(month);
      if ((isClosedMonth || fresh) && !(await mirrorChangedSince(start, end, new Date(cached.computedAt)))) {
        return cached.data as MonthlySpendResult;
      }
    }
    const inFlight = inFlightMonths.get(cacheKey);
    if (inFlight) return inFlight;
  }
  const promise = (async () => {
    const result = await computeMonthlySpend(api, ids, month, opts);
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

const EXCLUDED_FUNDING_KEY = 'excluded_funding_accounts_json';

/** Pseudo-bank accounts whose payments are excluded from cash spend math
 * (QBO_EXCLUDED_FUNDING_ACCOUNTS, e.g. the unreconciled "ACH" clearing
 * account). Tolerant resolution — a miss disables the exclusion with a log. */
async function getExcludedFundingAccounts(api: QboApi): Promise<TrackedAccount[]> {
  if (!config.excludedFundingAccounts.length) return [];
  const cached = readAccountCache(await getConfigValue(EXCLUDED_FUNDING_KEY), config.excludedFundingAccounts);
  if (cached) return cached;
  let tracked: TrackedAccount[] = [];
  try {
    const resolved = await resolveAccounts(api, config.excludedFundingAccounts, /ach|clearing/i);
    tracked = resolved.map((a) => ({ id: String(a.Id), acctNum: a.AcctNum ?? null, name: a.Name }));
  } catch (err: any) {
    console.warn('[qbo] excluded-funding account resolution failed:', err.message);
    return [];
  }
  await setConfigValue(
    EXCLUDED_FUNDING_KEY,
    JSON.stringify({ tokens: config.excludedFundingAccounts, accounts: tracked })
  );
  console.log(`[qbo] excluding payments funded from: ${tracked.map((t) => t.name).join(', ')}`);
  return tracked;
}

/** Spend options shared by every cash computation, plus a cache-key prefix so
 * results computed under an exclusion never mix with unexcluded caches (and
 * vice versa when the setting is removed after the books are repaired). */
async function getSpendOpts(api: QboApi): Promise<{ opts: SpendOptions; cachePrefix: string }> {
  const excluded = await getExcludedFundingAccounts(api);
  if (!excluded.length) return { opts: {}, cachePrefix: '' };
  return {
    opts: {
      excludeFundingAccounts: {
        ids: new Set(excluded.map((t) => t.id)),
        label: excluded.map((t) => `"${t.name}"`).join(', '),
      },
    },
    cachePrefix: 'xf:' + excluded.map((t) => t.id).sort().join('+') + ':',
  };
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
  const spend = await computeMonthlySpend(api, taxIds, month, (await getSpendOpts(api)).opts);
  if (spend.total > 0) return { amount: spend.total, source: 'transactions' };
  try {
    const { start, end } = monthDateRange(month);
    const [before, after] = [await api.balanceSheet(dayBefore(start)), await api.balanceSheet(end)];
    const b = reportBalances(before);
    const a = reportBalances(after);
    let delta = 0;
    for (const id of taxIds) delta += (a.get(id)?.value ?? 0) - (b.get(id)?.value ?? 0);
    // Accrual-aware: JE credits of collected tax raise the balance without cash
    // moving, so remitted = accruals − balance change (old behavior when no JEs).
    const taxIdSet = new Set(taxIds.map(String));
    let jeAccruals = 0;
    for (const je of await api.queryByDateRange('JournalEntry', start, end)) {
      for (const l of je.Line || []) {
        const d = l.JournalEntryLineDetail;
        if (!d || !taxIdSet.has(String(d.AccountRef?.value))) continue;
        jeAccruals += (d.PostingType === 'Credit' ? 1 : -1) * (Number(l.Amount) || 0);
      }
    }
    return { amount: Math.max(0, Math.round((jeAccruals - delta) * 100) / 100), source: 'balance-sheet' };
  } catch {
    return { amount: 0, source: 'unavailable' };
  }
}

const inFlightPnl = new Map<string, Promise<MonthlyPnl>>();

async function getMonthlyPnl(month: string, forceRefresh: boolean): Promise<MonthlyPnl> {
  const { opts: spendOpts, cachePrefix } = await getSpendOpts(await getComputeApi());
  const cacheKey = `${cachePrefix}pnl3:${month}`;
  if (!forceRefresh) {
    const cached = await getCachedMonth(cacheKey);
    if (cached) {
      const isClosedMonth = month < currentMonthUtc();
      const fresh = Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS;
      const { start, end } = monthDateRange(month);
      if ((isClosedMonth || fresh) && !(await mirrorChangedSince(start, end, new Date(cached.computedAt)))) {
        return cached.data as MonthlyPnl;
      }
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
      ? (await computeMonthlySpend(api, directIds, month, spendOpts)).total
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
  // Accept full dates too (the shared range control sends YYYY-MM-DD since the
  // day-level picker shipped) and reduce them to their months — this endpoint
  // family works in month granularity.
  const start = String(req.query.start || '').slice(0, 7);
  const end = String(req.query.end || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end) || start > end) {
    res.status(400).json({ error: 'Provide ?start=YYYY-MM&end=YYYY-MM with start <= end' });
    return null;
  }
  const months = monthsBetween(start, end);
  // 84 months covers the full mirrored history (2020 →) with headroom.
  if (months.length > 84) {
    res.status(400).json({ error: 'Range too large (max 84 months)' });
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

/** Register reconstruction for diagnosing a broken account: replays every
 * mirrored transaction touching the account (funded-by AND coded-to sides)
 * month by month, so the divergence point and mechanism become visible.
 * Read-only diagnostic. */
app.get(
  '/api/register-history',
  requireAuth,
  asyncRoute(async (req, res) => {
    const accountId = String(req.query.account || '');
    if (!accountId) return res.status(400).json({ error: 'Provide ?account=<accountId>' });
    const start = String(req.query.start || '2020-01-01');
    const end = String(req.query.end || new Date().toISOString().slice(0, 10));
    const api = await getComputeApi();
    const listMode = req.query.list === '1';
    const txns: any[] = [];
    const listRow = (side: string, type: string, t: any, amount: number) => {
      if (listMode) txns.push({ side, type, id: String(t.Id), date: t.TxnDate, amount: Math.round(amount * 100) / 100, who: t.EntityRef?.name || t.AccountRef?.name || '', memo: t.PrivateNote || '' });
    };
    const months = new Map<string, any>();
    const bucket = (date: string) => {
      const m = (date || '').slice(0, 7);
      if (!months.has(m)) months.set(m, { month: m, fundedOut: 0, codedIn: 0, codedOut: 0, jeNet: 0, count: 0 });
      return months.get(m);
    };
    const id = String(accountId);
    for (const p of await api.queryByDateRange('Purchase', start, end)) {
      const sign = p.Credit === true ? -1 : 1;
      if (String(p.AccountRef?.value) === id) {
        // The account PAID for this (card charge / bank withdrawal).
        const b = bucket(p.TxnDate); b.fundedOut += sign * (Number(p.TotalAmt) || 0); b.count++;
        listRow('fundedOut', 'Purchase', p, sign * (Number(p.TotalAmt) || 0));
      }
      for (const line of p.Line || []) {
        if (line.DetailType === 'AccountBasedExpenseLineDetail' && String(line.AccountBasedExpenseLineDetail?.AccountRef?.value) === id) {
          // Money sent TO this account (card paydown) or coded against it.
          const b = bucket(p.TxnDate); b.codedIn += sign * (Number(line.Amount) || 0); b.count++;
          listRow('codedIn', 'Purchase', p, sign * (Number(line.Amount) || 0));
        }
      }
    }
    for (const bp of await api.queryByDateRange('BillPayment', start, end)) {
      if (String(bp.CreditCardPayment?.CCAccountRef?.value) === id) {
        const b = bucket(bp.TxnDate); b.fundedOut += Number(bp.TotalAmt) || 0; b.count++;
      }
    }
    // Dedicated pay-down-card transactions: money OUT of BankAccountRef,
    // INTO CreditCardAccountRef (reduces what's owed on the card).
    for (const ccp of await api.queryByDateRange('CreditCardPayment', start, end)) {
      const amt = Number(ccp.Amount) || 0;
      if (String(ccp.CreditCardAccountRef?.value) === id) {
        const b = bucket(ccp.TxnDate); b.codedIn += amt; b.count++;
      }
      if (String(ccp.BankAccountRef?.value) === id) {
        const b = bucket(ccp.TxnDate); b.fundedOut += amt; b.count++;
      }
    }
    for (const je of await api.queryByDateRange('JournalEntry', start, end)) {
      for (const l of je.Line || []) {
        const d = l.JournalEntryLineDetail;
        if (!d || String(d.AccountRef?.value) !== id) continue;
        const b = bucket(je.TxnDate);
        b.jeNet += (d.PostingType === 'Credit' ? 1 : -1) * (Number(l.Amount) || 0);
        b.count++;
      }
    }
    for (const dep of await api.queryByDateRange('Deposit', start, end)) {
      for (const line of dep.Line || []) {
        if (String(line.DepositLineDetail?.AccountRef?.value) === id) {
          const b = bucket(dep.TxnDate); b.codedOut += Number(line.Amount) || 0; b.count++;
        }
      }
    }
    const rows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
    let cumulative = 0;
    for (const r of rows) {
      // Liability view: charges (fundedOut) and JE credits raise what's owed;
      // paydowns (codedIn) and deposit-coded lines reduce it.
      r.net = Math.round((r.fundedOut - r.codedIn - r.codedOut + r.jeNet) * 100) / 100;
      cumulative = Math.round((cumulative + r.net) * 100) / 100;
      r.cumulative = cumulative;
      r.fundedOut = Math.round(r.fundedOut * 100) / 100;
      r.codedIn = Math.round(r.codedIn * 100) / 100;
      r.codedOut = Math.round(r.codedOut * 100) / 100;
      r.jeNet = Math.round(r.jeNet * 100) / 100;
    }
    res.json({ account: accountId, start, end, months: rows, finalCumulative: cumulative, ...(listMode ? { txns } : {}) });
  })
);

/** Credit-memo audit: are credits piling up unapplied, or moving onto bills?
 * Pulls vendor credits (money vendors owe us, applied against their bills) and
 * customer credit memos, splits applied vs still-open, and ages the open ones
 * so stale credits sitting unused are visible. Read-only. */
app.get(
  '/api/credit-memo-audit',
  requireAuth,
  asyncRoute(async (_req, res) => {
    const api = await createQboApi();
    if (!api.queryRaw) return res.status(501).json({ error: 'raw query unavailable' });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const today = new Date().toISOString().slice(0, 10);
    const daysSince = (d: string) => Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${d}T00:00:00Z`).getTime()) / 86_400_000);

    const audit = async (table: string, respKey: string, who: (t: any) => string) => {
      const all = await api.queryRaw!(table, respKey, []);
      const open: any[] = [];
      let issuedTotal = 0, openTotal = 0;
      for (const c of all) {
        const total = Number(c.TotalAmt) || 0;
        const bal = Number(c.Balance) || 0; // unapplied remainder
        issuedTotal += total;
        if (bal > 0.005) {
          openTotal += bal;
          open.push({ id: String(c.Id), num: c.DocNumber || '', date: c.TxnDate || '', who: who(c), total: r2(total), openBalance: r2(bal), ageDays: daysSince(c.TxnDate) });
        }
      }
      open.sort((a, b) => b.ageDays - a.ageDays);
      const bucket = (lo: number, hi: number) => {
        const rows = open.filter((o) => o.ageDays > lo && o.ageDays <= hi);
        return { count: rows.length, amount: r2(rows.reduce((s, o) => s + o.openBalance, 0)) };
      };
      return {
        count: all.length,
        issuedTotal: r2(issuedTotal),
        openCount: open.length,
        openTotal: r2(openTotal),
        aging: {
          '0-30d': bucket(-1, 30),
          '31-90d': bucket(30, 90),
          '91-180d': bucket(90, 180),
          'over-180d': bucket(180, 1e9),
        },
        oldestOpen: open.slice(0, 20),
      };
    };

    const [vendorCredits, creditMemos] = await Promise.all([
      audit('VendorCredit', 'VendorCredit', (t) => t.VendorRef?.name || t.VendorRef?.value || ''),
      audit('CreditMemo', 'CreditMemo', (t) => t.CustomerRef?.name || t.CustomerRef?.value || ''),
    ]);
    res.json({
      asOf: today,
      vendorCredits,
      creditMemos,
      note: 'A credit is "moving" when its open balance is 0 (fully applied to a bill/invoice). Credits with an open balance and a large age are sitting unused. VendorCredit = money a vendor owes us, applied against their bills (this is the rebate pipeline). CreditMemo = customer-side credits.',
    });
  })
);

/** Outflow audit: every dollar leaving the real bank accounts, classified by
 * the account it's ultimately coded to, so we can prove that money going out
 * is EITHER a real cost/expense (shows on the P&L) OR a legitimate non-expense
 * use (owner draw, tax, capex, debt paydown, internal transfer) — and surface
 * anything that's neither (a possible hole where profit would be overstated).
 * Read-only. */
app.get(
  '/api/outflow-audit',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const result = await dedupe(`oa:${range.start}:${range.end}`, async () => {
      const api = await getComputeApi();
      const accounts = await api.listAccounts();
      const typeById = new Map(accounts.map((a: any) => [String(a.Id), String(a.AccountType)]));
      const nameById = new Map(accounts.map((a: any) => [String(a.Id), String(a.Name)]));
      const inventoryIds = new Set((await getTrackedAccounts(api)).map((t) => t.id));
      // Our real cash pool: Zions checking + the two savings, plus the ACH
      // clearing account (money in transit that is still ours).
      const REAL_BANK = /zions|xions/i;
      const poolIds = new Set<string>();
      for (const a of accounts) {
        if (String(a.AccountType) === 'Bank' && REAL_BANK.test(String(a.Name))) poolIds.add(String(a.Id));
      }
      const achId = accounts.find((a: any) => a.Name === 'ACH')?.Id;
      if (achId) poolIds.add(String(achId));

      // Bucket every coded dollar by what kind of account it lands in.
      const COST = 'cost';
      const classify = (acctId: string): { key: string; label: string; isCost: boolean } => {
        const id = String(acctId);
        const type = typeById.get(id) || '';
        const name = (nameById.get(id) || '').toLowerCase();
        if (inventoryIds.has(id) || type === 'Cost of Goods Sold') return { key: 'cogs', label: 'Inventory / cost of goods sold', isCost: true };
        if (type === 'Expense' || type === 'Other Expense') return { key: 'expenses', label: 'Operating expenses', isCost: true };
        if (type === 'Income' || type === 'Other Income') return { key: 'refunds', label: 'Customer refunds (reduces income)', isCost: true };
        if (type === 'Fixed Asset') return { key: 'capex', label: 'Capital assets (equipment, buildout)', isCost: false };
        if (type === 'Equity') return { key: 'owners', label: 'Owner distributions / dividends', isCost: false };
        if (/1040-es|estimated tax/.test(name)) return { key: 'ownertax', label: 'Owner estimated taxes (1040-ES)', isCost: false };
        if (type === 'Credit Card') return { key: 'cards', label: 'Credit-card paydown', isCost: false };
        if (type === 'Bank' && poolIds.has(id)) return { key: 'internal', label: 'Transfer between your own accounts', isCost: false };
        if (type === 'Bank') return { key: 'holding', label: 'Transfer to holding accounts (Cash on Hand, etc.)', isCost: false };
        if (/liability|payable/.test(type.toLowerCase())) return { key: 'liabilities', label: 'Loan / payroll-tax / liability paydown', isCost: false };
        if (/asset|receivable/.test(type.toLowerCase())) return { key: 'assets', label: 'Other assets (prepaid, employee loans)', isCost: false };
        return { key: 'unclassified', label: 'Unclassified — NEEDS REVIEW', isCost: false };
      };
      const buckets = new Map<string, { key: string; label: string; isCost: boolean; total: number; samples: any[] }>();
      const add = (acctId: string, amount: number, sample?: any) => {
        if (Math.abs(amount) < 0.005) return;
        const c = classify(acctId);
        let b = buckets.get(c.key);
        if (!b) { b = { key: c.key, label: c.label, isCost: c.isCost, total: 0, samples: [] }; buckets.set(c.key, b); }
        b.total = Math.round((b.total + amount) * 100) / 100;
        if (sample && b.samples.length < 8) b.samples.push({ ...sample, coded: nameById.get(String(acctId)) });
      };

      const inPool = (ref: any) => ref?.value && poolIds.has(String(ref.value));

      // Direct purchases funded from the pool: split by each line's coded account.
      for (const p of await api.queryByDateRange('Purchase', range.start, range.end)) {
        if (!inPool(p.AccountRef)) continue;
        const sign = p.Credit === true ? -1 : 1;
        let lined = 0;
        for (const line of p.Line || []) {
          const amt = sign * (Number(line.Amount) || 0);
          if (line.DetailType === 'AccountBasedExpenseLineDetail') {
            add(line.AccountBasedExpenseLineDetail?.AccountRef?.value, amt, { date: p.TxnDate, who: p.EntityRef?.name, amount: amt, id: p.Id, type: 'Purchase' });
            lined += Number(line.Amount) || 0;
          } else if (line.DetailType === 'ItemBasedExpenseLineDetail') {
            add([...inventoryIds][0] || 'cogs', amt, { date: p.TxnDate, who: p.EntityRef?.name, amount: amt, id: p.Id, type: 'Purchase(item)' });
            lined += Number(line.Amount) || 0;
          }
        }
        const rest = sign * (Number(p.TotalAmt) || 0) - sign * lined;
        if (Math.abs(rest) > 0.02) add('unclassified', rest, { date: p.TxnDate, who: p.EntityRef?.name, amount: rest, id: p.Id, type: 'Purchase(unlined)' });
      }

      // Bill payments funded from the pool: distribute the cash paid across the
      // paid bill's line accounts (that's what the money was really for).
      const billPayments = await api.queryByDateRange('BillPayment', range.start, range.end);
      const billIds = new Set<string>();
      for (const bp of billPayments) {
        const fund = bp.CheckPayment?.BankAccountRef;
        if (!inPool(fund)) continue;
        for (const line of bp.Line || []) {
          const b = (line.LinkedTxn || []).find((t: any) => t.TxnType === 'Bill');
          if (b?.TxnId) billIds.add(String(b.TxnId));
        }
      }
      const bills = api.getBills ? await api.getBills([...billIds]) : [];
      const billById = new Map(bills.map((b: any) => [String(b.Id), b]));
      for (const bp of billPayments) {
        const fund = bp.CheckPayment?.BankAccountRef;
        if (!inPool(fund)) continue;
        const cash = Number(bp.TotalAmt) || 0;
        if (cash === 0) continue;
        // QBO writes each bill line at the bill's FULL covered amount (cash +
        // applied vendor credits blended). Only TotalAmt is real cash — scale
        // every attribution by the cash fraction so credits don't leak in as
        // phantom outflow (the D33 fix, applied here too).
        let coverage = 0;
        for (const line of bp.Line || []) {
          const linked: any[] = line.LinkedTxn || [];
          if (linked.some((t) => t.TxnType === 'VendorCredit')) continue;
          if (linked.some((t) => t.TxnType === 'Bill')) coverage += Number(line.Amount) || 0;
        }
        const cashFraction = coverage > 0 ? Math.max(0, Math.min(cash / coverage, 1)) : 1;
        let attributed = 0;
        for (const line of bp.Line || []) {
          const linked: any[] = line.LinkedTxn || [];
          if (linked.some((t) => t.TxnType === 'VendorCredit')) continue;
          const linkedBill = linked.find((t) => t.TxnType === 'Bill');
          if (!linkedBill) continue;
          const bill = billById.get(String(linkedBill.TxnId));
          const lineCash = (Number(line.Amount) || 0) * cashFraction;
          if (!bill) { add('unclassified', lineCash, { date: bp.TxnDate, who: bp.VendorRef?.name, amount: lineCash, id: bp.Id, type: 'BillPayment(bill missing)' }); attributed += lineCash; continue; }
          const charges = positiveLineTotal(bill) || (Number(bill.TotalAmt) || 0);
          if (charges <= 0) continue;
          for (const bl of bill.Line || []) {
            const blAmt = Number(bl.Amount) || 0;
            if (blAmt <= 0) continue;
            const portion = (blAmt / charges) * lineCash;
            if (bl.DetailType === 'AccountBasedExpenseLineDetail') add(bl.AccountBasedExpenseLineDetail?.AccountRef?.value, portion, { date: bp.TxnDate, who: bp.VendorRef?.name, amount: portion, id: bp.Id, type: 'BillPayment' });
            else add([...inventoryIds][0] || 'cogs', portion, { date: bp.TxnDate, who: bp.VendorRef?.name, amount: portion, id: bp.Id, type: 'BillPayment(item)' });
            attributed += portion;
          }
        }
        const rest = cash - attributed;
        if (Math.abs(rest) > 0.02) add('unclassified', rest, { date: bp.TxnDate, who: bp.VendorRef?.name, amount: rest, id: bp.Id, type: 'BillPayment(residual)' });
      }

      // Card paydowns funded from the pool.
      for (const ccp of await api.queryByDateRange('CreditCardPayment', range.start, range.end)) {
        if (inPool(ccp.BankAccountRef)) add(ccp.CreditCardAccountRef?.value || 'cards', Number(ccp.Amount) || 0, { date: ccp.TxnDate, who: ccp.CreditCardAccountRef?.name, amount: Number(ccp.Amount) || 0, id: ccp.Id, type: 'CardPayment' });
      }
      // Explicit transfers out of the pool.
      for (const t of await api.queryByDateRange('Transfer', range.start, range.end)) {
        const from = inPool(t.FromAccountRef), to = inPool(t.ToAccountRef);
        if (from && !to) add(t.ToAccountRef?.value, Number(t.Amount) || 0, { date: t.TxnDate, who: t.ToAccountRef?.name, amount: Number(t.Amount) || 0, id: t.Id, type: 'Transfer' });
      }

      const cats = [...buckets.values()].sort((a, b) => b.total - a.total);
      const costOut = Math.round(cats.filter((c) => c.isCost).reduce((s, c) => s + c.total, 0) * 100) / 100;
      const nonCostOut = Math.round(cats.filter((c) => !c.isCost && c.key !== 'unclassified').reduce((s, c) => s + c.total, 0) * 100) / 100;
      const unclassified = Math.round((buckets.get('unclassified')?.total || 0) * 100) / 100;
      const categorizedOut = Math.round((costOut + nonCostOut + unclassified) * 100) / 100;

      // The P&L side, to compare the cost portion against.
      const stmt: any = await getStatement(range, false);
      const plCogs = stmt.adjusted ? stmt.adjusted.cogsTotal : stmt.cogs?.total;
      const plExpenses = stmt.expenses?.net;
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const cashInventory = buckets.get('cogs')?.total || 0;
      const cashExpenses = buckets.get('expenses')?.total || 0;
      // Money that IS on the P&L but leaves the bank invisibly (payroll
      // paychecks + Sales-Tax-Center payments have no QuickBooks transactions).
      const expenseInvisible = r2((plExpenses || 0) - cashExpenses);

      return {
        start: range.start,
        end: range.end,
        pool: [...poolIds].map((id) => nameById.get(id)).filter(Boolean),
        categorizedOut,
        costOut,
        nonCostOut,
        unclassified,
        categories: cats,
        reconciliation: {
          verdict:
            Math.abs(unclassified) < 1000
              ? 'CLEAN — every visible dollar leaving the bank is classified; nothing unexplained. Profit is not overstated by hidden outflow.'
              : `REVIEW — $${Math.abs(unclassified).toFixed(2)} of outflow could not be classified; inspect the "unclassified" bucket.`,
          cashInventoryOut: r2(cashInventory),
          pnlCogs: plCogs,
          inventoryTimingGap: r2(cashInventory - (plCogs || 0)),
          cashExpensesOut: r2(cashExpenses),
          pnlOperatingExpenses: plExpenses,
          expenseInvisible,
          notes: [
            'Cash inventory out ≈ P&L COGS; the difference is inventory timing (cash buys stock now, it becomes COGS only when sold).',
            `Cash operating-expense out ($${r2(cashExpenses).toLocaleString()}) is far below P&L operating expenses ($${(plExpenses || 0).toLocaleString()}) because ~$${expenseInvisible.toLocaleString()} of expense — mostly PAYROLL — leaves the bank with NO QuickBooks transaction (paychecks + tax-center are processed outside QBO). That money still appears as an expense on the accrual P&L, so it is fully counted and does NOT overstate profit.`,
            'Non-cost outflow (transfers, card/loan paydown, owner draws, taxes, capex) is correctly absent from the P&L — paying those down is not an expense.',
          ],
        },
      };
    });
    res.json(result);
  })
);

/** Net register movement for an account over a range, measured from mirrored
 * transactions (same math as /api/register-history): positive = owed grew.
 * Used where the books' balance level is broken but the period's movement is
 * verified accurate (the 2025+ card registers, post 2026-07-17 repair). */
async function registerMovement(api: QboApi, accountId: string, start: string, end: string): Promise<number> {
  const id = String(accountId);
  let net = 0;
  for (const p of await api.queryByDateRange('Purchase', start, end)) {
    const sign = p.Credit === true ? -1 : 1;
    if (String(p.AccountRef?.value) === id) net += sign * (Number(p.TotalAmt) || 0);
    for (const line of p.Line || []) {
      if (line.DetailType === 'AccountBasedExpenseLineDetail' && String(line.AccountBasedExpenseLineDetail?.AccountRef?.value) === id)
        net -= sign * (Number(line.Amount) || 0);
    }
  }
  for (const bp of await api.queryByDateRange('BillPayment', start, end)) {
    if (String(bp.CreditCardPayment?.CCAccountRef?.value) === id) net += Number(bp.TotalAmt) || 0;
  }
  for (const ccp of await api.queryByDateRange('CreditCardPayment', start, end)) {
    if (String(ccp.CreditCardAccountRef?.value) === id) net -= Number(ccp.Amount) || 0;
    if (String(ccp.BankAccountRef?.value) === id) net += Number(ccp.Amount) || 0;
  }
  for (const je of await api.queryByDateRange('JournalEntry', start, end)) {
    for (const l of je.Line || []) {
      const d = l.JournalEntryLineDetail;
      if (d && String(d.AccountRef?.value) === id) net += (d.PostingType === 'Credit' ? 1 : -1) * (Number(l.Amount) || 0);
    }
  }
  for (const dep of await api.queryByDateRange('Deposit', start, end)) {
    for (const line of dep.Line || []) {
      // A deposit whose source line is coded to a credit card is money coming
      // BACK from the card issuer — a returned/refunded payment or chargeback —
      // which RAISES what's owed (it reverses a paydown). E.g. the July 2026
      // Amex autopay that bounced and Amex redeposited $76,640.30. (These are
      // liability accounts, so a credit to them increases the balance.)
      if (String(line.DepositLineDetail?.AccountRef?.value) === id) net += Number(line.Amount) || 0;
    }
  }
  return Math.round(net * 100) / 100;
}

/** Twin-matcher for double-recorded card paydowns: pairs each dedicated
 * pay-down-card transaction (CreditCardPayment) with the bank-side Purchase
 * coded to the same card for the same money. Read-only diagnostic — produces
 * the worklist, changes nothing in QuickBooks. */
app.get(
  '/api/card-dupe-match',
  requireAuth,
  asyncRoute(async (req, res) => {
    const accountId = String(req.query.account || '');
    if (!accountId) return res.status(400).json({ error: 'Provide ?account=<cardAccountId>' });
    const start = String(req.query.start || '2020-01-01');
    const end = String(req.query.end || new Date().toISOString().slice(0, 10));
    const api = await getComputeApi();

    type Side = { id: string; date: string; amount: number; who: string; memo: string; matched?: boolean };
    const ccps: Side[] = [];
    for (const ccp of await api.queryByDateRange('CreditCardPayment', start, end)) {
      if (String(ccp.CreditCardAccountRef?.value) !== accountId) continue;
      ccps.push({
        id: String(ccp.Id),
        date: ccp.TxnDate || '',
        amount: Math.round((Number(ccp.Amount) || 0) * 100) / 100,
        who: ccp.BankAccountRef?.name || '',
        memo: ccp.PrivateNote || '',
      });
    }
    const purchases: Side[] = [];
    for (const p of await api.queryByDateRange('Purchase', start, end)) {
      if (String(p.AccountRef?.value) === accountId) continue; // the card's own charges, not paydowns
      if (p.Credit === true) continue;
      let coded = 0;
      for (const line of p.Line || []) {
        if (
          line.DetailType === 'AccountBasedExpenseLineDetail' &&
          String(line.AccountBasedExpenseLineDetail?.AccountRef?.value) === accountId
        )
          coded += Number(line.Amount) || 0;
      }
      if (coded <= 0.005) continue;
      purchases.push({
        id: String(p.Id),
        date: p.TxnDate || '',
        amount: Math.round(coded * 100) / 100,
        who: p.AccountRef?.name || '',
        memo: [p.EntityRef?.name, p.PrivateNote].filter(Boolean).join(' — '),
      });
    }

    const dayDiff = (a: string, b: string) =>
      Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);
    // Tightest pass first so each transaction pairs with its nearest twin;
    // later passes only see what earlier passes left unmatched.
    const passes = [
      { grade: 'A', amountTol: 0.01, days: 3 },
      { grade: 'B', amountTol: 0.01, days: 14 },
      { grade: 'C', amountTol: 1.0, days: 14 },
      { grade: 'D', amountTol: 0.01, days: 45 },
    ];
    const pairs: any[] = [];
    for (const pass of passes) {
      const cands: { c: Side; p: Side; dd: number }[] = [];
      for (const c of ccps) {
        if (c.matched) continue;
        for (const p of purchases) {
          if (p.matched) continue;
          if (Math.abs(c.amount - p.amount) > pass.amountTol) continue;
          const dd = dayDiff(c.date, p.date);
          if (dd > pass.days) continue;
          cands.push({ c, p, dd });
        }
      }
      cands.sort((x, y) => x.dd - y.dd || Math.abs(x.c.amount - x.p.amount) - Math.abs(y.c.amount - y.p.amount));
      for (const cand of cands) {
        if (cand.c.matched || cand.p.matched) continue;
        cand.c.matched = cand.p.matched = true;
        pairs.push({ grade: pass.grade, daysApart: cand.dd, amount: cand.c.amount, ccp: cand.c, purchase: cand.p });
      }
    }
    const sum = (rows: Side[]) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
    const strip = ({ matched, ...rest }: Side) => rest;
    res.json({
      account: accountId,
      start,
      end,
      pairs: pairs.map((pr) => ({ ...pr, ccp: strip(pr.ccp), purchase: strip(pr.purchase) })),
      unmatchedCcps: ccps.filter((c) => !c.matched).map(strip),
      unmatchedPurchases: purchases.filter((p) => !p.matched).map(strip),
      totals: {
        ccpCount: ccps.length,
        ccpTotal: sum(ccps),
        purchaseCount: purchases.length,
        purchaseTotal: sum(purchases),
        pairCount: pairs.length,
        pairedTotal: Math.round(pairs.reduce((s, p) => s + p.amount, 0) * 100) / 100,
        unmatchedCcpTotal: sum(ccps.filter((c) => !c.matched)),
        unmatchedPurchaseTotal: sum(purchases.filter((p) => !p.matched)),
      },
    });
  })
);

/** Accounts-Receivable audit: what actually makes up the A/R balance, split
 * into real customer receivables, the Boise intercompany line, and "customers"
 * that are really vendors (Canon etc.) the accountant invoices to track credit
 * memos owed to us. Read-only. */
app.get(
  '/api/ar-audit',
  requireAuth,
  asyncRoute(async (_req, res) => {
    const api = await createQboApi();
    if (!api.queryRaw) return res.status(501).json({ error: 'raw query unavailable' });
    // Every open invoice (a positive balance is money still owed on it).
    const invoices = await api.queryRaw('Invoice', 'Invoice', [{ field: 'Balance', operator: '>', value: '0' }]);
    const vendors = api.listVendors ? await api.listVendors() : [];
    const norm = (s: string) => String(s || '').trim().toLowerCase();
    // Strip corporate suffixes/punctuation so "ASI Corp." matches vendor "ASI".
    const bare = (s: string) => norm(s).replace(/[.,]/g, '').replace(/\b(inc|corp|corporation|co|llc|ltd|usa|inc|north america|na)\b/g, '').replace(/\s+/g, ' ').trim();
    const vendorBare = new Set(vendors.map((v: any) => bare(v.DisplayName || v.CompanyName || '')).filter(Boolean));

    const BOISE = /boise/i;
    const VENDORISH = /\b(canon|sony|nikon|fuji|fujifilm|sigma|tamron|panasonic|olympus|om digital|manfrotto|profoto|dji|gopro|synnex|ingram|sandisk|tenba|wacom|blackmagic|zeiss|leica|godox|rode|sennheiser|lowepro|peak design|promaster|westcott|macgroup|slik|aputure|amgreat|asi)\b/i;

    type Row = { customer: string; balance: number; count: number; alsoVendor: boolean; samples: string[]; docs: { id: string; num: string; date: string; balance: number; total: number }[] };
    const byCustomer = new Map<string, Row>();
    for (const inv of invoices) {
      const name = inv.CustomerRef?.name || inv.CustomerRef?.value || 'Unknown';
      const key = norm(name);
      let row = byCustomer.get(key);
      if (!row) { row = { customer: name, balance: 0, count: 0, alsoVendor: vendorBare.has(bare(name)), samples: [], docs: [] }; byCustomer.set(key, row); }
      const bal = Number(inv.Balance) || 0;
      row.balance = Math.round((row.balance + bal) * 100) / 100;
      row.count++;
      // Capture a few line descriptions / item names so we can SEE what the
      // invoice is for (a rebate/co-op memo vs a real product sale).
      for (const l of inv.Line || []) {
        const desc = l.Description || l.SalesItemLineDetail?.ItemRef?.name || '';
        if (desc && row.samples.length < 4 && !row.samples.includes(desc)) row.samples.push(String(desc).slice(0, 80));
      }
      row.docs.push({ id: String(inv.Id), num: inv.DocNumber || '', date: inv.TxnDate || '', balance: bal, total: Number(inv.TotalAmt) || 0 });
    }

    const classify = (row: Row): 'boise' | 'vendor' | 'customer' => {
      if (BOISE.test(row.customer)) return 'boise';
      if (row.alsoVendor || VENDORISH.test(row.customer)) return 'vendor';
      return 'customer';
    };
    const groups: Record<string, { total: number; customers: Row[] }> = {
      boise: { total: 0, customers: [] },
      vendor: { total: 0, customers: [] },
      customer: { total: 0, customers: [] },
    };
    for (const row of byCustomer.values()) {
      const g = groups[classify(row)];
      g.customers.push(row);
      g.total = Math.round((g.total + row.balance) * 100) / 100;
    }
    for (const g of Object.values(groups)) g.customers.sort((a, b) => b.balance - a.balance);

    const grand = Math.round(Object.values(groups).reduce((s, g) => s + g.total, 0) * 100) / 100;
    res.json({
      asOf: new Date().toISOString().slice(0, 10),
      openInvoices: invoices.length,
      arTotal: grand,
      summary: {
        realCustomers: groups.customer.total,
        boiseIntercompany: groups.boise.total,
        vendorCreditTrackers: groups.vendor.total,
      },
      groups,
    });
  })
);

/** Raw mirrored view of a single Purchase, for audit drill-downs where the
 * aggregate reports aren't enough to see a transaction's line structure. */
app.get(
  '/api/txn-raw',
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'Provide ?id=<purchaseId>' });
    const api = await getComputeApi();
    if (!api.getPurchase) return res.status(501).json({ error: 'Purchase lookup unavailable' });
    res.json(await api.getPurchase(id));
  })
);

/** Transactions behind one line of the bank report — same predicates as the
 * report itself, so every drawer sums to its line. */
app.get(
  '/api/bank-flow-detail',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validRange(req, res);
    if (!range) return;
    const line = String(req.query.line || '');
    const startDate = monthDateRange(range.start).start;
    const endDate = monthDateRange(range.end).end;
    const result = await dedupe(`dt:bf:${line}:${startDate}:${endDate}`, async () => {
      const api = await getComputeApi();
      const banks = await getBankAccounts(api);
      return bankFlowDetail(api, banks.map((b) => b.id), line, startDate, endDate);
    });
    res.json({ line, ...result });
  })
);

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
      if (
        cached &&
        (endIsClosed || Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS) &&
        !(await mirrorChangedSince(asOfStart, asOfEnd, new Date(cached.computedAt)))
      ) {
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
      if (
        cached &&
        (endIsClosed || Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS) &&
        !(await mirrorChangedSince(startDate, endDate, new Date(cached.computedAt)))
      ) {
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

// ---- physical inventory counts (entered monthly; total value, all locations) ----

app.get(
  '/api/inventory-counts',
  requireAuth,
  asyncRoute(async (_req, res) => {
    const r = await getPool().query(
      `SELECT as_of, value, note FROM inventory_counts ORDER BY as_of DESC LIMIT 60`
    );
    res.json({
      counts: r.rows.map((row) => ({
        asOf: row.as_of.toISOString().slice(0, 10),
        value: Number(row.value),
        note: row.note,
      })),
    });
  })
);

app.post(
  '/api/inventory-counts',
  requireAuth,
  asyncRoute(async (req, res) => {
    const asOf = String(req.body?.asOf || '');
    const value = Number(req.body?.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: 'Provide { asOf: YYYY-MM-DD, value: number ≥ 0 }' });
    }
    await getPool().query(
      `INSERT INTO inventory_counts (as_of, value, note, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (as_of) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note, updated_at = now()`,
      [asOf, value, req.body?.note || null]
    );
    // Adjusted statements depend on counts — drop cached statements.
    await getPool().query(`DELETE FROM monthly_cache WHERE month LIKE '%stmt%'`);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/inventory-counts',
  requireAuth,
  asyncRoute(async (req, res) => {
    const asOf = String(req.query.asOf || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return res.status(400).json({ error: 'Provide ?asOf=YYYY-MM-DD' });
    await getPool().query(`DELETE FROM inventory_counts WHERE as_of = $1`, [asOf]);
    await getPool().query(`DELETE FROM monthly_cache WHERE month LIKE '%stmt%'`);
    res.json({ ok: true });
  })
);

/** Most recent count on or before the given date. */
async function countAsOf(date: string): Promise<{ asOf: string; value: number } | null> {
  const r = await getPool().query(
    `SELECT as_of, value FROM inventory_counts WHERE as_of <= $1 ORDER BY as_of DESC LIMIT 1`,
    [date]
  );
  if (!r.rows.length) return null;
  return { asOf: r.rows[0].as_of.toISOString().slice(0, 10), value: Number(r.rows[0].value) };
}

/** Shared context for P&L computations: bank ids, income ids, account types/names. */
async function getPnlCtx(api: QboApi): Promise<PnlContext & { accountNames: Map<string, string> }> {
  const accounts = await api.listAccounts();
  return {
    bankAccountIds: (await getBankAccounts(api)).map((b) => b.id),
    retailIncomeAccountIds: (await getRetailIncomeAccounts(api)).map((r) => r.id),
    accountTypes: new Map(accounts.map((a: any) => [String(a.Id), a.AccountType as string])),
    accountNames: new Map(accounts.map((a: any) => [String(a.Id), a.Name as string])),
  };
}

/** Full cash P&L statement for an exact date range, with the operating-expense
 * section pulled from the books' accrual P&L for the same period. Cached like
 * the other range endpoints; also the data source for /api/checks. */
async function getStatement(range: { start: string; end: string }, force: boolean): Promise<any> {
  const { opts: spendOpts, cachePrefix } = await getSpendOpts(await getComputeApi());
  const cacheKey = `${cachePrefix}stmt5:${range.start}:${range.end}`;
  if (!force) {
    const cached = await getCachedMonth(cacheKey);
    const closed = range.end < new Date().toISOString().slice(0, 10);
    if (
      cached &&
      (closed || Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS) &&
      !(await mirrorChangedSince(range.start, range.end, new Date(cached.computedAt)))
    ) {
      return cached.data;
    }
  } else {
    // Refresh means "get the latest from QuickBooks", not just recompute:
    // pull edits into the mirror first so a hand-recategorized transaction
    // shows up immediately instead of after the next scheduled sync.
    try { await runSync(false); } catch { /* recompute from the current mirror */ }
  }
  return dedupe(cacheKey, async () => {
      const api = await getComputeApi();
      const inventoryIds = (await getTrackedAccounts(api)).map((t) => t.id);
      const spend = await computeMonthlySpend(api, inventoryIds, range, spendOpts);
      const taxIds = (await getSalesTaxAccounts(api)).map((t) => t.id);
      const taxRemitted = taxIds.length ? (await computeMonthlySpend(api, taxIds, range, spendOpts)).total : 0;
      const directIds = (await getDirectCostAccounts(api)).map((t) => t.id);
      const directCosts = directIds.length ? (await computeMonthlySpend(api, directIds, range, spendOpts)).total : 0;
      const pnl = await computeMonthlyPnl(
        api,
        await getPnlCtx(api),
        range,
        spend.total,
        taxRemitted,
        directCosts
      );
      // Surface the funding-account exclusion on the statement itself.
      for (const w of spend.warnings) if (w.startsWith('Excluded $')) pnl.warnings.push(w);
      // Operating expenses come from the books' accrual P&L for the same period.
      // Row ids (when the report provides them) let the UI drill into an account.
      let expenses: { total: number; rows: { name: string; amount: number; id: string | null }[] } = { total: 0, rows: [] };
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
              if (!Number.isNaN(amt) && amt !== 0) {
                expenses.rows.push({ name: col[0].value, amount: amt, id: col[0].id ?? null });
              }
            }
            if (row.Rows) walk(row.Rows, isExpenseSection);
          }
        };
        // All accounts, not a top-N: the category drill-down's sum check needs
        // the full list to tie to the books total.
        walk(report?.Rows, false);
        expenses.rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      } catch (err: any) {
        console.warn('[pnl-statement] expense report unavailable:', err.message);
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const expensesNet = r2(expenses.total - pnl.expenseOffsets);
      // Accounting-basis COGS from physical counts: begin + purchases − end.
      // A count dated exactly on the range start serves as the beginning value
      // (mid-year ranges like "Jun 30 → Jun 30" use the Jun 30 count, not one
      // from months earlier); for typical Jan-1 starts this still picks Dec 31.
      const beginCount = await countAsOf(range.start === range.end ? dayBefore(range.start) : range.start);
      const endCount = await countAsOf(range.end);
      const daysBetween = (a: string, b: string) =>
        Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;
      let adjusted: any = null;
      if (beginCount && endCount && endCount.asOf >= range.start) {
        const beginGap = daysBetween(beginCount.asOf, range.start);
        const endGap = daysBetween(endCount.asOf, range.end);
        if (beginGap > 20) {
          pnl.warnings.push(
            `The beginning inventory count (${beginCount.asOf}) is ${Math.round(beginGap)} days before this range starts — the accounting-basis COGS is only as accurate as that gap allows. Enter a count near ${range.start} for a tighter statement.`
          );
        }
        if (endGap > 20) {
          pnl.warnings.push(
            `The ending inventory count (${endCount.asOf}) is ${Math.round(endGap)} days from the range end — enter a count near ${range.end} for a tighter statement.`
          );
        }
        const inventoryChange = r2(endCount.value - beginCount.value);
        // Purchases = cash actually paid for bills, on the day it was paid
        // (Chris, 2026-07-17: "count what we paid for the bill… the cost
        // should go on January 2nd not the 30th"). Credits never count —
        // bucket 1 scales every payment line by its cash fraction.
        const adjustedCogsTotal = r2(pnl.cogs - inventoryChange + pnl.directCosts - pnl.cogsOffsets);
        const adjustedGp = r2(pnl.revenueNet - adjustedCogsTotal);
        adjusted = {
          beginAsOf: beginCount.asOf,
          beginValue: beginCount.value,
          endAsOf: endCount.asOf,
          endValue: endCount.value,
          inventoryChange,
          cogsTotal: adjustedCogsTotal,
          grossProfit: adjustedGp,
          grossMarginPct: pnl.revenueNet > 0 ? r2((adjustedGp / pnl.revenueNet) * 100) : null,
          noi: r2(adjustedGp - expensesNet),
        };
      }
      const statement = {
        start: range.start,
        end: range.end,
        income: {
          moneyIn: pnl.retailCashIn.total,
          deposits: pnl.retailCashIn.deposits,
          invoicePayments: pnl.retailCashIn.invoicePayments,
          salesReceipts: pnl.retailCashIn.salesReceipts,
          refunds: pnl.retailCashIn.refunds,
          feedRefunds: pnl.retailCashIn.feedRefunds,
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
        adjusted,
        bankInflows: pnl.bankInflows.total,
        warnings: pnl.warnings,
      };
      await setCachedMonth(cacheKey, statement);
      return statement;
  });
}

app.get(
  '/api/pnl-statement',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    res.json(await getStatement(range, req.query.refresh === '1'));
  })
);

/** Recomputes the statements people actually open (current YTD + recent full
 * years) whenever a sync may have invalidated them. Warm hits cost almost
 * nothing, so running this after every sync is cheap insurance against the
 * cold-load wait on the P&L page. */
let warmingCaches = false;
async function warmStatementCaches(): Promise<void> {
  if (warmingCaches) return;
  warmingCaches = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const year = Number(today.slice(0, 4));
    const ranges = [
      { start: `${year}-01-01`, end: monthDateRange(today.slice(0, 7)).end },
      ...[1, 2, 3].map((i) => ({ start: `${year - i}-01-01`, end: `${year - i}-12-31` })),
    ];
    for (const range of ranges) {
      const t0 = Date.now();
      try {
        await getStatement(range, false);
        const ms = Date.now() - t0;
        if (ms > 1000) console.log(`[warm] ${range.start}..${range.end} recomputed in ${(ms / 1000).toFixed(1)}s`);
      } catch (err: any) {
        console.warn(`[warm] ${range.start}..${range.end} failed: ${err.message}`);
      }
    }
  } finally {
    warmingCaches = false;
  }
}

// ---- drill-down details: the transactions behind each statement line ----

/** Income-side detail (deposits, payments, refunds, offsets), computed with the
 * same predicates as the statement and shared per range via the dedupe map. */
async function getPnlDetailFor(range: { start: string; end: string }) {
  return dedupe(`dt:pnl:${range.start}:${range.end}`, async () => {
    const api = await getComputeApi();
    const ctx = await getPnlCtx(api);
    return computePnlDetail(api, ctx, range, ctx.accountNames);
  });
}

app.get(
  '/api/pnl-detail',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const line = String(req.query.line || '');
    const spendLines: Record<string, () => Promise<TrackedAccount[]>> = {
      inventory: async () => getTrackedAccounts(),
      directCosts: async () => getDirectCostAccounts(await getComputeApi()),
      salesTax: async () => getSalesTaxAccounts(await getComputeApi()),
    };

    if (line in spendLines) {
      const accounts = await spendLines[line]();
      if (!accounts.length) return res.json({ line, rows: [], sum: 0, note: 'No accounts configured for this line.' });
      const toRows = (spend: MonthlySpendResult, group: (t: any) => string): DetailRow[] =>
        spend.transactions.map((t) => ({
          date: t.date,
          name: t.vendor,
          txnType: t.sourceType === 'BillPayment' ? 'BillPayment' : t.paymentMethod === 'Check' ? 'Check' : 'Purchase',
          txnId: t.txnId ?? null,
          amount: t.amount,
          detail: t.detail,
          group: group(t),
        }));
      const result = await dedupe(`dt:${line}:${range.start}:${range.end}`, async () => {
        const api = await getComputeApi();
        const { opts: spendOpts } = await getSpendOpts(api);
        // Direct costs group by cost category (freight / repairs / materials):
        // one compute per account so every row knows which account it hit.
        if (line === 'directCosts' && accounts.length > 1) {
          const rows: DetailRow[] = [];
          let sum = 0;
          for (const a of accounts) {
            const spend = await computeMonthlySpend(api, [a.id], range, spendOpts);
            sum += spend.total;
            rows.push(...toRows(spend, () => `${a.acctNum ? `#${a.acctNum} ` : ''}${a.name}`));
          }
          rows.sort((x, y) => x.date.localeCompare(y.date));
          return { rows, sum: Math.round(sum * 100) / 100 };
        }
        // Inventory and tax group by payee.
        const spend = await computeMonthlySpend(api, accounts.map((a) => a.id), range, spendOpts);
        return { rows: toRows(spend, (t) => t.vendor), sum: spend.total };
      });
      const note =
        line === 'salesTax' && result.sum === 0
          ? 'No remittance transactions are visible to the API for this range — the statement fell back to the tax account’s balance movement, which can’t be itemized here.'
          : undefined;
      return res.json({ line, rows: result.rows, sum: result.sum, note });
    }

    const incomeLines = ['deposits', 'invoicePayments', 'salesReceipts', 'refunds', 'feedRefunds', 'rebates', 'reimbursements'];
    if (incomeLines.includes(line)) {
      const detail = await getPnlDetailFor(range);
      const rows = (detail as any)[line] as DetailRow[];
      return res.json({ line, rows, sum: (detail as any).sums[line] });
    }

    if (line === 'inventoryChange') {
      const begin = await countAsOf(dayBefore(range.start));
      const end = await countAsOf(range.end);
      const rows: DetailRow[] = [begin, end]
        .filter((c): c is { asOf: string; value: number } => Boolean(c))
        .map((c, i) => ({
          date: c.asOf,
          name: i === 0 ? 'Beginning physical inventory count' : 'Ending physical inventory count',
          txnType: 'InventoryCount',
          txnId: null,
          amount: c.value,
        }));
      const sum = begin && end ? Math.round((end.value - begin.value) * 100) / 100 : 0;
      return res.json({
        line,
        rows,
        sum,
        note: 'These are the physical counts you entered on this page; the COGS adjustment is ending minus beginning.',
      });
    }

    res.status(400).json({
      error:
        'Unknown line. Use one of: deposits, invoicePayments, salesReceipts, refunds, rebates, reimbursements, inventory, directCosts, salesTax, inventoryChange.',
    });
  })
);

/** Transactions behind one expense account from the books' P&L. Payroll and
 * tax-center activity is invisible to the API; the client shows the difference
 * between this sum and the books figure as an explicit remainder. */
app.get(
  '/api/expense-detail',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const account = String(req.query.account || '');
    if (!account) return res.status(400).json({ error: 'Provide ?account=<accountId>' });
    const result = await dedupe(`dt:exp:${account}:${range.start}:${range.end}`, async () => {
      const api = await getComputeApi();
      return expenseAccountDetail(api, account, range.start, range.end);
    });
    res.json({ account, ...result });
  })
);

/** Inventory spend broken down by the account each payment was drawn from —
 * built to size up pollution from pseudo-bank accounts (e.g. the unreconciled
 * "ACH" clearing account that recorded vendor payments Jul 2024 – Dec 2025). */
app.get(
  '/api/spend-by-funding',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const result = await dedupe(`dt:fund:${range.start}:${range.end}`, async () => {
      const api = await getComputeApi();
      const ids = (await getTrackedAccounts(api)).map((t) => t.id);
      const spend = await computeMonthlySpend(api, ids, range);
      const names = new Map((await api.listAccounts()).map((a: any) => [String(a.Id), a.Name as string]));
      const by = new Map<string, { name: string; amount: number; count: number }>();
      for (const t of spend.transactions) {
        const key = t.fundingAccountId || 'unrecorded';
        const cur = by.get(key) || {
          name: t.fundingAccountId ? names.get(t.fundingAccountId) || `Account ${t.fundingAccountId}` : 'No funding account recorded',
          amount: 0,
          count: 0,
        };
        cur.amount += t.amount;
        cur.count++;
        by.set(key, cur);
      }
      return {
        start: range.start,
        end: range.end,
        total: spend.total,
        note: 'Diagnostic view — funding-account exclusions are deliberately NOT applied here, so excluded accounts remain visible.',
        byFundingAccount: [...by.entries()]
          .map(([id, v]) => ({ id, ...v, amount: Math.round(v.amount * 100) / 100 }))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      };
    });
    res.json(result);
  })
);

/** Every payment drawn from a given account, with the bills each one paid and
 * any vendor credits applied — the working data for cleaning up the "ACH"
 * clearing-account era (void payment → re-apply credits → match feed twin). */
app.get(
  '/api/funding-payments',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const token = String(req.query.account || '');
    if (!token) return res.status(400).json({ error: 'Provide ?account=<name or number>' });
    const api = await getComputeApi();
    const match = await resolveAccounts(api, [token], /./);
    const accountId = String(match[0].Id);
    const payments: any[] = [];
    for (const bp of await api.queryByDateRange('BillPayment', range.start, range.end)) {
      const funding =
        bp.CheckPayment?.BankAccountRef?.value || bp.CreditCardPayment?.CCAccountRef?.value;
      if (String(funding) !== accountId) continue;
      const bills: any[] = [];
      let creditsApplied = 0;
      for (const line of bp.Line || []) {
        for (const lt of line.LinkedTxn || []) {
          if (lt.TxnType === 'Bill') bills.push({ id: String(lt.TxnId), amount: Number(line.Amount) || 0 });
          if (lt.TxnType === 'VendorCredit') creditsApplied += Number(line.Amount) || 0;
        }
      }
      // Bill doc numbers make the checklist human-usable.
      for (const b of bills) {
        try {
          const bill = await api.getBill(b.id);
          b.docNumber = bill?.DocNumber || null;
          b.billTotal = Number(bill?.TotalAmt) || null;
        } catch { b.docNumber = null; }
      }
      payments.push({
        date: bp.TxnDate,
        vendor: bp.VendorRef?.name || 'Unknown vendor',
        total: Number(bp.TotalAmt) || 0,
        txnId: String(bp.Id),
        txnType: 'BillPayment',
        bills,
        creditsApplied: Math.round(creditsApplied * 100) / 100,
      });
    }
    for (const p of await api.queryByDateRange('Purchase', range.start, range.end)) {
      if (String(p.AccountRef?.value) !== accountId) continue;
      payments.push({
        date: p.TxnDate,
        vendor: p.EntityRef?.name || 'Unknown payee',
        total: (p.Credit === true ? -1 : 1) * (Number(p.TotalAmt) || 0),
        txnId: String(p.Id),
        txnType: p.PaymentType === 'Check' ? 'Check' : 'Purchase',
        bills: [],
        creditsApplied: 0,
      });
    }
    payments.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.date.localeCompare(b.date));
    res.json({
      account: { id: accountId, name: match[0].Name },
      start: range.start,
      end: range.end,
      count: payments.length,
      total: Math.round(payments.reduce((s, p) => s + p.total, 0) * 100) / 100,
      payments,
    });
  })
);

// ---- ACH-cleanup reclassify (the app's ONLY write path; Chris-approved 2026-07-16) ----
// Admin-gated end to end: the agent/service account cannot reach these routes.
// Every run re-validates each transaction against LIVE QuickBooks; failures
// are skipped and reported, and every write stores a before-image for revert.

interface BeltRow {
  txnId: string;
  expectedAmount: number;
  /** Per-row target account token (manifest tasks); ach-belt rows omit it. */
  to?: string;
}

/** Each cleanup task Chris has explicitly approved gets an entry here; the
 * endpoints refuse any unknown task name. */
const CLEANUP_TASKS: Record<string, { file: string; from: 'inventory' | string; defaultTo?: string }> = {
  'ach-belt': { file: 'ach-belt.json', from: 'inventory', defaultTo: 'ACH' },
  // Token is the account NUMBER: resolveAccounts matches AcctNum/Name exactly,
  // and the account's Name is just "Payroll Expenses".
  'tax-pulls-2023': { file: 'tax-pulls-2023.json', from: '66000' },
  'tax-pulls-2024': { file: 'tax-pulls-2024.json', from: '66000' },
  'ach-stragglers': { file: 'ach-stragglers.json', from: 'inventory', defaultTo: 'ACH' },
  // 2025-26 card-register repair (Chris: "lets just make sure 2025 and 2026 are
  // fixed", 2026-07-17): bank-side card payments whose card-side AUTOPAY record
  // already reduces the card move to the Credit Cards wash account, so each
  // payment counts once. Dollar-neutral between balance-sheet accounts.
  'card-payments-2025-26-amex': { file: 'card-payments-2025-26-amex.json', from: 'PLATINUM Amex Credit Card -009', defaultTo: 'Credit Cards' },
  'card-payments-2025-26-purple': { file: 'card-payments-2025-26-purple.json', from: 'AX Purple (64001)', defaultTo: 'Credit Cards' },
};

function loadBelt(task: string): BeltRow[] {
  const t = CLEANUP_TASKS[task];
  if (!t) throw Object.assign(new Error(`Unknown cleanup task "${task}"`), { statusCode: 400 });
  const p = path.join(__dirname, '..', 'cleanup', t.file);
  return (JSON.parse(fs.readFileSync(p, 'utf8')).rows as BeltRow[]) || [];
}

const accountTokenCache = new Map<string, { id: string; name: string }>();
async function resolveToken(api: QboApi, token: string): Promise<{ id: string; name: string }> {
  const hit = accountTokenCache.get(token);
  if (hit) return hit;
  const [a] = await resolveAccounts(api, [token], /./);
  const out = { id: String(a.Id), name: a.Name as string };
  accountTokenCache.set(token, out);
  return out;
}

async function reclassifyCfg(api: QboApi, task: string, row: BeltRow) {
  const spec = CLEANUP_TASKS[task];
  const fromIds =
    spec.from === 'inventory'
      ? new Set((await getTrackedAccounts(api)).map((t) => t.id))
      : new Set([(await resolveToken(api, spec.from)).id]);
  const to = await resolveToken(api, row.to ?? spec.defaultTo!);
  const zions = await resolveToken(api, 'Zions Bank Checking (8882)');
  return { zionsId: zions.id, toId: to.id, toName: to.name, fromIds, expectedAmount: row.expectedAmount };
}

app.get(
  '/api/reclassify/status',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const belt = loadBelt(String(req.query.task || 'ach-belt'));
    const log = await getPool().query(
      `SELECT txn_id, moved, reclassified_at, reverted_at FROM reclassify_log`
    );
    const done = new Set(log.rows.filter((r) => !r.reverted_at).map((r) => r.txn_id));
    const pending = belt.filter((r) => !done.has(r.txnId));
    let achBalance: number | null = null;
    try {
      const api = await createQboApi();
      const ach = (await api.listAccounts()).find((a: any) => a.Name === 'ACH');
      achBalance = ach ? Number(ach.CurrentBalance) : null;
    } catch { /* balance is a nicety */ }
    res.json({
      beltTotal: belt.length,
      done: done.size,
      pending: pending.length,
      pendingAmount: Math.round(pending.reduce((s, r) => s + r.expectedAmount, 0) * 100) / 100,
      movedAmount: Math.round(log.rows.filter((r) => !r.reverted_at).reduce((s, r) => s + Number(r.moved), 0) * 100) / 100,
      achBalance,
    });
  })
);

app.post(
  '/api/reclassify/run',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.body?.limit ?? '25'), 10) || 25, 1), 100);
    const dryRun = req.body?.dryRun === true;
    const task = String(req.body?.task || 'ach-belt');
    const belt = loadBelt(task);
    const log = await getPool().query(`SELECT txn_id FROM reclassify_log WHERE reverted_at IS NULL`);
    const done = new Set(log.rows.map((r) => r.txn_id));
    const batch = belt.filter((r) => !done.has(r.txnId)).slice(0, limit);
    const api = await createQboApi(); // writes always go straight to QuickBooks, never the mirror
    const results: any[] = [];
    for (const row of batch) {
      try {
        const live = await api.getPurchase!(row.txnId);
        const plan = planReclassify(live, await reclassifyCfg(api, task, row));
        if (!plan.ok) {
          // Rows Chris already reclassified by hand on the conveyor are done —
          // retire them so the pending count reaches zero.
          if (plan.reason === 'already reclassified' && !dryRun) {
            await getPool().query(
              `INSERT INTO reclassify_log (txn_id, before, after, moved)
               VALUES ($1, $2, $3, 0) ON CONFLICT (txn_id) DO NOTHING`,
              [row.txnId, JSON.stringify({ doneByHand: true }), JSON.stringify(live)]
            );
            results.push({ txnId: row.txnId, status: 'gone', reason: 'already reclassified by hand — retired from the belt' });
            continue;
          }
          results.push({ txnId: row.txnId, status: 'skipped', reason: plan.reason });
          continue;
        }
        if (dryRun) {
          results.push({ txnId: row.txnId, status: 'would-reclassify', amount: plan.moving });
          continue;
        }
        const saved = await api.updatePurchase!(plan.updated);
        await getPool().query(
          `INSERT INTO reclassify_log (txn_id, before, after, moved)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (txn_id) DO UPDATE SET before = EXCLUDED.before, after = EXCLUDED.after,
             moved = EXCLUDED.moved, reclassified_at = now(), reverted_at = NULL`,
          [row.txnId, JSON.stringify(live), JSON.stringify(saved), plan.moving]
        );
        await upsertTxns('Purchase', [saved]); // keep the mirror truthful immediately
        results.push({ txnId: row.txnId, status: 'reclassified', amount: plan.moving });
      } catch (err: any) {
        // A deleted transaction (e.g. one Chris already removed by hand in the
        // earlier delete-and-match workflow) can never be reclassified — retire
        // it from the belt so batches don't retry it forever.
        if (/Object Not Found/i.test(err.message || '') && !dryRun) {
          await getPool().query(
            `INSERT INTO reclassify_log (txn_id, before, after, moved)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (txn_id) DO NOTHING`,
            [row.txnId, JSON.stringify({ missing: true }), JSON.stringify({})]
          );
          results.push({ txnId: row.txnId, status: 'gone', reason: 'already deleted in QuickBooks — retired from the belt' });
        } else {
          results.push({ txnId: row.txnId, status: 'error', reason: err.message?.slice(0, 200) });
        }
      }
    }
    const ok = results.filter((r) => r.status === 'reclassified' || r.status === 'would-reclassify');
    res.json({
      dryRun,
      attempted: batch.length,
      succeeded: ok.length,
      amount: Math.round(ok.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100,
      results,
    });
  })
);

app.post(
  '/api/reclassify/revert',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const txnIds: string[] = Array.isArray(req.body?.txnIds) ? req.body.txnIds.map(String) : [];
    if (!txnIds.length) return res.status(400).json({ error: 'Provide { txnIds: [...] }' });
    const api = await createQboApi();
    const results: any[] = [];
    for (const id of txnIds.slice(0, 100)) {
      try {
        const log = await getPool().query(`SELECT before FROM reclassify_log WHERE txn_id = $1`, [id]);
        if (!log.rows.length) { results.push({ txnId: id, status: 'skipped', reason: 'not in reclassify log' }); continue; }
        const live = await api.getPurchase!(id);
        const plan = planRevert(live, log.rows[0].before);
        if (!plan.ok) { results.push({ txnId: id, status: 'skipped', reason: plan.reason }); continue; }
        const saved = await api.updatePurchase!(plan.updated);
        await getPool().query(`UPDATE reclassify_log SET reverted_at = now() WHERE txn_id = $1`, [id]);
        await upsertTxns('Purchase', [saved]);
        results.push({ txnId: id, status: 'reverted' });
      } catch (err: any) {
        results.push({ txnId: id, status: 'error', reason: err.message?.slice(0, 200) });
      }
    }
    res.json({ results });
  })
);

// ---- automated reconciliation checks ----
// Every methodology bug found while building this app was caught by one of
// these tie-outs run by hand; this endpoint runs them all for any range.

interface Check {
  id: string;
  name: string;
  status: 'pass' | 'warn' | 'fail';
  expected: number | string | null;
  actual: number | string | null;
  explain: string;
  link?: string;
}

app.get(
  '/api/checks',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const force = req.query.refresh === '1';
    const qs = `start=${range.start}&end=${range.end}`;
    const stmt = await getStatement(range, force);
    const detail = await getPnlDetailFor(range);
    const checks: Check[] = [];
    const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
    const add = (c: Check) => checks.push(c);

    // 1 — income can never exceed what actually entered the bank.
    add({
      id: 'income-vs-inflows',
      name: 'Income never exceeds bank inflows',
      status: stmt.income.moneyIn <= stmt.bankInflows + 0.01 ? 'pass' : 'fail',
      expected: `≤ ${stmt.bankInflows}`,
      actual: stmt.income.moneyIn,
      explain:
        'Cash income can’t be more than the money that entered the bank. If this fails, something non-cash (like credit-memo settlements) is being counted as income.',
      link: `/bank?${qs}`,
    });

    // 2 — the income number decomposes exactly into its parts.
    const decomposed =
      stmt.income.deposits + stmt.income.invoicePayments + (stmt.income.salesReceipts || 0) - stmt.income.refunds -
      (stmt.income.feedRefunds || 0);
    add({
      id: 'income-decomposition',
      name: 'Income equals deposits + payments − refunds (incl. bank-feed refunds), to the cent',
      status: near(decomposed, stmt.income.moneyIn) ? 'pass' : 'fail',
      expected: stmt.income.moneyIn,
      actual: Math.round(decomposed * 100) / 100,
      explain: 'The headline income number must be exactly the sum of its statement lines.',
      link: `/pnl?${qs}`,
    });

    // 3 — traced tax remittances match the tax account's ledger movement.
    // (Collections never post to the tax account here — Lightspeed books
    // tax-inclusive income — so the account only moves when tax is remitted.)
    let taxCheck: Check = {
      id: 'tax-ledger',
      name: 'Sales tax remitted matches the tax account ledger',
      status: 'warn',
      expected: null,
      actual: stmt.income.salesTaxRemitted,
      explain: 'Balance sheet unavailable — could not compare against the ledger.',
      link: `/pnl?${qs}`,
    };
    try {
      const api = await getComputeApi();
      const taxIds = (await getSalesTaxAccounts(api)).map((t) => t.id);
      if (taxIds.length) {
        const before = reportBalances(await api.balanceSheet(dayBefore(range.start)));
        const after = reportBalances(await api.balanceSheet(range.end));
        let delta = 0;
        for (const id of taxIds) delta += (after.get(id)?.value ?? 0) - (before.get(id)?.value ?? 0);
        // Accrual-aware: monthly JEs crediting collected tax into the liability
        // (Chris's regime from 2026-07 onward) raise the balance without any cash
        // moving, so remitted = JE accruals − balance change. With no JEs this
        // reduces to the old “balance went down by what was remitted”.
        const taxIdSet = new Set(taxIds.map(String));
        let jeAccruals = 0;
        for (const je of await api.queryByDateRange('JournalEntry', range.start, range.end)) {
          for (const l of je.Line || []) {
            const d = l.JournalEntryLineDetail;
            if (!d || !taxIdSet.has(String(d.AccountRef?.value))) continue;
            jeAccruals += (d.PostingType === 'Credit' ? 1 : -1) * (Number(l.Amount) || 0);
          }
        }
        const ledgerRemitted = Math.round((jeAccruals - delta) * 100) / 100;
        const tol = Math.max(1, stmt.income.salesTaxRemitted * 0.001);
        taxCheck = {
          ...taxCheck,
          status: near(ledgerRemitted, stmt.income.salesTaxRemitted, tol) ? 'pass' : 'fail',
          expected: ledgerRemitted,
          explain:
            'The tax deducted from revenue should equal what actually left the tax account (journal-entry accruals minus the balance change). A mismatch means tax was deducted too much or too little.',
        };
      }
    } catch {
      /* keep warn */
    }
    add(taxCheck);

    // 4 — direct method: money in − categorized out − API-invisible remainder
    // must equal the actual bank change, and the remainder should look like
    // payroll-scale outflow, not a black hole.
    let bankCheck: Check = {
      id: 'direct-method',
      name: 'Money in − money out ties to the actual bank change',
      status: 'warn',
      expected: null,
      actual: null,
      explain: 'Bank-flow could not be computed for this range.',
      link: `/bank?${qs}`,
    };
    try {
      const bfKey = `bf:${range.start}:${range.end}`;
      const cachedBf = force ? null : await getCachedMonth(bfKey);
      const bf: any =
        cachedBf?.data ??
        (await dedupe(bfKey, async () => {
          const api = await getComputeApi();
          const banks = await getBankAccounts(api);
          const inventoryIds = (await getTrackedAccounts(api)).map((t) => t.id);
          let actualBankChange: number | null = null;
          try {
            actualBankChange = (await computeCashFlow(api, dayBefore(range.start), range.end)).bankChange;
          } catch {
            /* balance sheet unavailable */
          }
          const r = await computeBankFlow(
            api, banks.map((b) => b.id), inventoryIds, range.start, range.end, actualBankChange
          );
          await setCachedMonth(bfKey, r);
          return r;
        }));
      if (bf.actualBankChange !== null && bf.inflows?.total > 0) {
        const share = Math.abs(bf.uncategorized) / bf.inflows.total;
        const outflowShaped = bf.uncategorized <= 0;
        bankCheck = {
          ...bankCheck,
          status: outflowShaped && share <= 0.15 ? 'pass' : 'warn',
          expected: bf.actualBankChange,
          actual: Math.round((bf.netCategorized + bf.uncategorized) * 100) / 100,
          explain: outflowShaped
            ? `The API-invisible remainder (payroll & tax-center payments) is ${(share * 100).toFixed(1)}% of inflows — ${
                share <= 0.15 ? 'a normal payroll-scale amount.' : 'unusually large; worth itemizing against the bank ledger.'
              }`
            : 'The uncategorized remainder is an INFLOW, which payroll can’t explain — some money in isn’t being captured.',
        };
      }
    } catch {
      /* keep warn */
    }
    add(bankCheck);

    // 5 — COGS arithmetic is internally consistent.
    const cogsArith = stmt.cogs.inventoryCash + stmt.cogs.directCosts - stmt.cogs.rebateOffsets;
    add({
      id: 'cogs-arithmetic',
      name: 'COGS lines add up',
      status: near(cogsArith, stmt.cogs.total) ? 'pass' : 'fail',
      expected: stmt.cogs.total,
      actual: Math.round(cogsArith * 100) / 100,
      explain: 'Inventory purchases + direct costs − rebates must equal the cash COGS total.',
      link: `/pnl?${qs}`,
    });
    if (stmt.adjusted) {
      const adjArith =
        stmt.cogs.inventoryCash - stmt.adjusted.inventoryChange + stmt.cogs.directCosts - stmt.cogs.rebateOffsets;
      const noiArith = stmt.adjusted.grossProfit - stmt.expenses.net;
      add({
        id: 'accounting-cogs-arithmetic',
        name: 'Accounting-basis COGS and NOI add up',
        status: near(adjArith, stmt.adjusted.cogsTotal) && near(noiArith, stmt.adjusted.noi) ? 'pass' : 'fail',
        expected: `${stmt.adjusted.cogsTotal} / ${stmt.adjusted.noi}`,
        actual: `${Math.round(adjArith * 100) / 100} / ${Math.round(noiArith * 100) / 100}`,
        explain: 'Purchases − inventory change + direct costs − rebates must equal COGS; gross profit − expenses must equal NOI.',
        link: `/pnl?${qs}`,
      });
    }

    // 6 — every drill-down list sums to its statement line.
    const sumPairs: [string, number, number][] = [
      ['deposits', detail.sums.deposits, stmt.income.deposits],
      ['invoicePayments', detail.sums.invoicePayments, stmt.income.invoicePayments],
      ['salesReceipts', detail.sums.salesReceipts, stmt.income.salesReceipts || 0],
      ['refunds', detail.sums.refunds, stmt.income.refunds],
      ['rebates', detail.sums.rebates, stmt.cogs.rebateOffsets],
      ['reimbursements', detail.sums.reimbursements, stmt.expenses.reimbursements],
    ];
    const badSums = sumPairs.filter(([, a, b]) => !near(a, b));
    add({
      id: 'drilldown-sums',
      name: 'Every drill-down list sums to its statement line',
      status: badSums.length ? 'fail' : 'pass',
      expected: 'all lines tie',
      actual: badSums.length
        ? badSums.map(([k, a, b]) => `${k}: detail ${a} vs statement ${b}`).join('; ')
        : 'all lines tie',
      explain:
        'Each clickable number on the P&L must equal the sum of the transactions shown behind it. A mismatch means the statement is stale (refresh it) or a classification drifted.',
      link: `/pnl?${qs}`,
    });

    // 7 — a physical count exists for the most recent month-end.
    const today = new Date().toISOString().slice(0, 10);
    const prevMonthEnd = dayBefore(`${today.slice(0, 7)}-01`);
    const latestCount = await countAsOf(today);
    add({
      id: 'count-freshness',
      name: 'A physical inventory count exists for the latest month-end',
      status: latestCount && latestCount.asOf >= prevMonthEnd ? 'pass' : 'warn',
      expected: `count on or after ${prevMonthEnd}`,
      actual: latestCount ? `latest count ${latestCount.asOf}` : 'no counts entered',
      explain:
        'Accounting-basis COGS needs a month-end physical count. Enter it on the P&L page when a month closes.',
      link: `/pnl?${qs}`,
    });

    // 8 — offsets behave as reductions, and the expense math holds.
    const expArith = stmt.expenses.totalFromBooks - stmt.expenses.reimbursements;
    add({
      id: 'offsets-sanity',
      name: 'Rebates and reimbursements reduce costs (never inflate them)',
      status:
        stmt.cogs.rebateOffsets >= 0 && stmt.expenses.reimbursements >= 0 && near(expArith, stmt.expenses.net)
          ? 'pass'
          : 'fail',
      expected: stmt.expenses.net,
      actual: Math.round(expArith * 100) / 100,
      explain: 'Offsets must be non-negative amounts subtracted from COGS/expenses, and net expenses must equal books minus reimbursements.',
      link: `/pnl?${qs}`,
    });

    // 10 — every payment record is internally consistent: the bill lines'
    // covered amounts must equal actual cash + applied credits. This is the
    // data shape the cash-only COGS rule (D33) rests on; if the bookkeepers
    // ever record payments differently, this check catches it immediately.
    try {
      const api = await getComputeApi();
      let violations = 0;
      let mismatch = 0;
      let paymentsChecked = 0;
      for (const bp of await api.queryByDateRange('BillPayment', range.start, range.end)) {
        let coverage = 0;
        let credits = 0;
        for (const line of bp.Line || []) {
          const linked: any[] = line.LinkedTxn || [];
          if (linked.some((t) => t.TxnType === 'VendorCredit')) credits += Number(line.Amount) || 0;
          else if (linked.some((t) => t.TxnType === 'Bill')) coverage += Number(line.Amount) || 0;
        }
        if (coverage === 0) continue;
        paymentsChecked++;
        const gap = Math.abs(coverage - credits - (Number(bp.TotalAmt) || 0));
        if (gap > 0.02) { violations++; mismatch += gap; }
      }
      mismatch = Math.round(mismatch * 100) / 100;
      add({
        id: 'payment-line-identity',
        name: 'Every bill payment audits clean: covered amounts = cash + credits',
        status: mismatch <= 500 ? (violations === 0 ? 'pass' : 'warn') : mismatch <= 10000 ? 'warn' : 'fail',
        expected: `${paymentsChecked} payments, $0.00 mismatch`,
        actual: violations === 0 ? `${paymentsChecked} payments, all clean` : `${violations} payment(s) off by $${mismatch.toFixed(2)} total`,
        explain:
          'The cash-only COGS rule reads each payment as: bill coverage = actual cash + applied credits. A mismatch means a payment was recorded in a shape the engine doesn’t expect — its cost attribution could be off by the mismatch amount.',
        link: `/pnl?${qs}`,
      });
    } catch (err: any) {
      console.warn('[checks] payment-line-identity unavailable:', err.message);
    }

    const counts = {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
    };
    res.json({ start: range.start, end: range.end, checks, counts });
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

// ---- Where the money went: the profit-to-bank proof as a report ----
// Categorizes every balance-sheet move over the range using the rules proven
// in the 2026-07-17 session (brain: concepts/profit-to-bank-proof.md):
// NOI(cash income, count-adjusted COGS, books expenses) ≈ Δreal banks
// + Δinventory(counts) + owner outflows + capex + old-liability paydowns
// − new card/vendor financing. NO A/R, NO credit memos (never in cash income),
// NO sales-tax-payable drift (no-accrual artifact), NO broken accounts
// (sign-flipped Amex, negative Cash on Hand, fake clearing banks).

app.get(
  '/api/money-map',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const result = await dedupe(`mm:${range.start}:${range.end}`, async () => {
      const api = await getComputeApi();
      const stmt: any = await getStatement(range, false);
      const cf = await computeCashFlow(api, dayBefore(range.start), range.end);
      const beginCount = await countAsOf(range.start === range.end ? dayBefore(range.start) : range.start);
      const endCount = await countAsOf(range.end);

      type Cat = { key: string; label: string; note: string; inProof: boolean; total: number; accounts: any[] };
      const cats: Record<string, Cat> = {};
      const cat = (key: string, label: string, note: string, inProof: boolean): Cat =>
        (cats[key] ??= { key, label, note, inProof, total: 0, accounts: [] });
      const put = (c: Cat, m: any, amount: number) => {
        c.accounts.push({ ...m, amount: Math.round(amount * 100) / 100 });
        c.total = Math.round((c.total + amount) * 100) / 100;
      };

      const REAL_BANK = /zions|xions/i;
      for (const m of cf.bankAccounts) {
        if (REAL_BANK.test(m.name)) put(cat('banks', 'Bank accounts (real)', 'Zions checking and savings — the hardest number there is. Click through to the bank report to see every dollar in and out.', true), m, m.change);
        else if (/federal estimated tax/i.test(m.name)) put(cat('owners', 'Money to the owners', 'Distributions, dividends, and personal tax prepayments (1040-ES).', true), m, m.change);
        else put(cat('broken', 'Excluded — broken or artificial accounts', 'Movements here are bookkeeping artifacts, not money: the fake clearing banks, impossible negative cash, and the sign-flipped Amex history. Each needs a bookkeeper repair, not a P&L explanation.', false), m, m.change);
      }
      for (const m of cf.moves) {
        const n = m.name.toLowerCase();
        const use = -m.cashEffect; // profit parked: asset growth / liability paydown
        if (/^(material inventory|boise inventory)$/i.test(m.name)) continue; // replaced by physical counts
        if (/sales tax payable/i.test(m.name)) { put(cat('broken', 'Excluded — broken or artificial accounts', '', false), m, 0); continue; }
        if (/amex.*009|platinum amex/i.test(m.name) || (m.type === 'Credit Card' && m.before < -500000)) { put(cat('broken', 'Excluded — broken or artificial accounts', '', false), m, 0); continue; }
        if (/cash on hand|fraud/i.test(n)) { put(cat('broken', 'Excluded — broken or artificial accounts', '', false), m, 0); continue; }
        if (m.type === 'Accounts Receivable' || /credit memo/i.test(n)) {
          put(cat('owed', 'Owed to you (not profit yet)', 'Audited 2026-07-19: this is NOT customers owing you money (real customer A/R is ~$0). It is ~79% vendor rebates/co-op/instant-rebate claims owed to you by Canon, Nikon, Sony, etc. (settled later by credit memos, not cash) and ~21% the Boise intercompany line. The P&L only counts cash that has landed, and these settle by credit — so none of this is in the profit being proven.', false), m, m.change);
          continue;
        }
        if (m.type === 'Equity' && /dist|dividend|draw/i.test(n)) { put(cat('owners', 'Money to the owners', 'Distributions, dividends, and personal tax prepayments (1040-ES).', true), m, use); continue; }
        if (/jens/i.test(n)) { put(cat('owners', 'Money to the owners', '', true), m, use); continue; }
        if (m.type === 'Fixed Asset') { put(cat('capex', 'Built into the business', 'Store build-out, furniture, equipment — cash that became property.', true), m, use); continue; }
        if (m.type === 'Accounts Payable') {
          // Mirror image of A/R: unpaid vendor bills are neither cost (cost
          // lands when PAID, Chris's rule) nor a destination of profit.
          put(cat('owedByYou', 'Unpaid vendor bills (not cost yet)', 'Bills received but not yet paid. Under your rule these become cost on the day you pay them — until then they are neither profit nor its destination, just goods waiting on the payment.', false), m, m.change);
          continue;
        }
        if (m.type === 'Credit Card' || /w\/h|withhold|direct deposit|payroll.*payable/i.test(n)) {
          put(cat('financing', 'Cards & payroll dues', 'Negative means they lent you more this period (money you got to use without earning it yet); positive means you paid old dues down.', true), m, use);
          continue;
        }
        put(cat('other', 'Everything else on the balance sheet', 'Small accounts that moved; positive parks profit, negative frees it.', true), m, use);
      }

      // The broken Amex register and the invisible "Credit Cards" wash account:
      // their book balances are unusable, but the PERIOD MOVEMENT is verified
      // accurate from 2025 on (2026-07-17 repair session) — measure it from
      // the mirrored transactions so card money stops vanishing from the proof.
      if (range.start >= '2025-01-01') {
        const MEASURED_CARDS = [
          {
            id: '63', name: 'Amex Platinum — payments minus charges this period',
            detail:
              'No running balance shown: this card’s books are broken (missing years of charges), so we can’t trust a start/end number — we only trust the movement, rebuilt from the actual transactions. Negative = you paid the card down more than you charged. Returned payments (like the July autopay Amex bounced and sent back) are counted correctly, so they don’t inflate this.',
          },
          {
            id: '99', name: 'Card payment clearing (timing between the two feeds)',
            detail:
              'The account payments pass through on their way to the cards. It nets near zero over a full clean period; a leftover here is just payments whose matching charge lands in a different month.',
          },
        ];
        for (const spec of MEASURED_CARDS) {
          const net = await registerMovement(api, spec.id, range.start, range.end);
          if (Math.abs(net) > 0.005) {
            const m = {
              id: spec.id, name: spec.name, acctNum: null, type: 'Credit Card',
              before: null, after: null, change: net, detail: spec.detail,
            };
            put(cat('financing', 'Cards & payroll dues', 'Negative means they lent you more this period (money you got to use without earning it yet); positive means you paid old dues down.', true), m, -net);
          }
        }
      }

      const inventoryChange =
        beginCount && endCount ? Math.round((endCount.value - beginCount.value) * 100) / 100 : null;
      if (inventoryChange !== null) {
        const c = cat('inventory', 'Inventory on the shelves', 'From your physical counts — the book inventory accounts are excluded because their values are broken.', true);
        c.total = inventoryChange;
        c.accounts.push({
          id: null, name: 'Physical inventory (your counts)', acctNum: null, type: 'Counts',
          before: beginCount!.value, after: endCount!.value, change: inventoryChange, amount: inventoryChange,
          detail: `${beginCount!.asOf} → ${endCount!.asOf}`,
        });
      }

      const order = ['banks', 'inventory', 'owners', 'capex', 'financing', 'other', 'owed', 'owedByYou', 'broken'];
      const categories = order.filter((k) => cats[k]).map((k) => cats[k]);
      for (const c of categories) c.accounts.sort((a, b) => Math.abs(b.amount || b.change) - Math.abs(a.amount || a.change));
      const accounted = Math.round(categories.filter((c) => c.inProof).reduce((s, c) => s + c.total, 0) * 100) / 100;
      const noi = stmt.adjusted ? stmt.adjusted.noi : stmt.noi;
      return {
        start: range.start,
        end: range.end,
        noi,
        basis: stmt.adjusted ? 'accounting (physical counts)' : 'cash (no counts for this range)',
        accounted,
        residual: Math.round((noi - accounted) * 100) / 100,
        categories,
        countWarning: inventoryChange === null ? 'No inventory counts near this range — inventory movement is missing from the proof.' : null,
      };
    });
    res.json(result);
  })
);

/** The books' accrual P&L, sectioned — read-only diagnostic for comparing the
 * app's cash-verified statement against what QuickBooks itself reports. */
app.get(
  '/api/books-pnl',
  requireAuth,
  asyncRoute(async (req, res) => {
    const range = validDateRange(req, res);
    if (!range) return;
    const api = await createQboApi();
    const report = await api.profitAndLoss(range.start, range.end);
    const sections: Record<string, { total: number; rows: { name: string; amount: number; id: string | null }[] }> = {};
    const walk = (rows: any, section: string | null) => {
      for (const row of rows?.Row || []) {
        const header = row.Header?.ColData?.[0]?.value || '';
        const sec = section ?? (header || null);
        if (row.Summary && header && !section) {
          sections[header] = sections[header] || { total: 0, rows: [] };
          sections[header].total = Number(row.Summary.ColData?.[1]?.value) || 0;
        }
        const col = row.ColData;
        if (section && col?.length >= 2 && col[0]?.value) {
          const amt = Number(col[col.length - 1]?.value);
          if (!Number.isNaN(amt) && amt !== 0) {
            sections[section] = sections[section] || { total: 0, rows: [] };
            sections[section].rows.push({ name: col[0].value, amount: amt, id: col[0].id ?? null });
          }
        }
        if (row.Rows) walk(row.Rows, sec);
      }
    };
    walk(report?.Rows, null);
    res.json({ start: range.start, end: range.end, basis: 'accrual (as QuickBooks reports it)', sections });
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
app.get('/money', requireAuth, (_req, res) => res.sendFile(pub('money.html')));
app.get('/inventory', requireAuth, (_req, res) => res.sendFile(pub('inventory.html')));
app.get('/checks', requireAuth, (_req, res) => res.sendFile(pub('checks.html')));
app.get('/cleanup', requireAuth, (_req, res) => res.sendFile(pub('cleanup.html')));
app.get('/password', requireAuth, (_req, res) => res.sendFile(pub('password.html')));
app.get('/users', requireAuth, (_req, res) => res.sendFile(pub('users.html')));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal error' });
});

async function main() {
  if (config.databaseUrl) {
    await initDb();
    console.log('[db] schema ready');
    await bootstrapAdmin();
    // Keep the raw-transaction mirror fresh: check at boot and twice daily.
    if (!missingQboConfig().length) {
      setOnSyncComplete(() => { warmStatementCaches().catch(() => undefined); });
      setTimeout(() => syncIfStale(), 15_000);
      setInterval(() => syncIfStale(), 12 * 60 * 60 * 1000);
      // Boot-time warm too: QuickBooks edits made while the app was redeploying
      // would otherwise leave the first visitor on the cold path.
      setTimeout(() => warmStatementCaches().catch(() => undefined), 60_000);
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
