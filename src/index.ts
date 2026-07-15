import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { config, missingQboConfig } from './config';
import { initDb, getConfigValue, setConfigValue, getCachedMonth, setCachedMonth } from './db';
import { buildAuthUri, handleCallback, createQboApi, connectionStatus, QboApi } from './qbo';
import { computeMonthlySpend, MonthlySpendResult } from './inventorySpend';
import { computeMonthlyPnl, MonthlyPnl } from './pnl';
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
    api ?? (await createQboApi()),
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
    const api = await createQboApi();
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
  const all = await (api ?? (await createQboApi())).listAccounts();
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
    const api = await createQboApi();
    const result = await computeMonthlyPnl(
      api,
      {
        bankAccountIds: (await getBankAccounts(api)).map((b) => b.id),
        retailIncomeAccountIds: (await getRetailIncomeAccounts(api)).map((r) => r.id),
        itemIncomeAccount: await getItemIncomeMap(api),
      },
      month,
      spend.total
    );
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

app.get(
  '/api/accounts',
  requireAuth,
  asyncRoute(async (req, res) => {
    const api = await createQboApi();
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
    const api = await createQboApi();
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
    if (status.connected) {
      // Surface which chart-of-accounts entry the spend math is keyed to, so the
      // account number can be verified against the books.
      try {
        const api = await createQboApi();
        status.inventoryAccounts = await getTrackedAccounts(api);
      } catch (err: any) {
        status.inventoryAccountError = err.message;
      }
    }
    res.json(status);
  })
);

// No express.static: the dashboard must only be reachable through the auth gate.
app.get(['/', '/index.html'], requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal error' });
});

async function main() {
  if (config.databaseUrl) {
    await initDb();
    console.log('[db] schema ready');
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
