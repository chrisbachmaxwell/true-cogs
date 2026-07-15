import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { config, missingQboConfig } from './config';
import { initDb, getConfigValue, setConfigValue, getCachedMonth, setCachedMonth } from './db';
import { buildAuthUri, handleCallback, createQboApi, connectionStatus, QboApi } from './qbo';
import { computeMonthlySpend, MonthlySpendResult } from './inventorySpend';
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
    await setConfigValue('inventory_account_id', '');
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

app.use(['/api/inventory-spend', '/api/inventory-spend/trend', '/api/status'], requireAuth);

const ACCOUNT_ID_KEY = 'inventory_account_id';

async function getInventoryAccountId(api: QboApi): Promise<string> {
  const cached = await getConfigValue(ACCOUNT_ID_KEY);
  if (cached) return cached;
  const accounts = await api.findAccountsByName(config.inventoryAccountName);
  if (!accounts.length) {
    throw new Error(
      `No account named "${config.inventoryAccountName}" found in the Chart of Accounts`
    );
  }
  const account = accounts.find((a) => a.Active !== false) || accounts[0];
  await setConfigValue(ACCOUNT_ID_KEY, account.Id);
  console.log(`[qbo] resolved "${config.inventoryAccountName}" account → Id ${account.Id}`);
  return account.Id;
}

function currentMonthUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

const CURRENT_MONTH_CACHE_TTL_MS = 60 * 60 * 1000; // re-compute the open month hourly

// The dashboard requests the current month and the trend at once; both can ask
// for the same uncached month, so identical computations share one promise.
const inFlightMonths = new Map<string, Promise<MonthlySpendResult>>();

async function getMonthlySpend(month: string, forceRefresh: boolean): Promise<MonthlySpendResult> {
  if (!forceRefresh) {
    const cached = await getCachedMonth(month);
    if (cached) {
      const isClosedMonth = month < currentMonthUtc();
      const fresh = Date.now() - new Date(cached.computedAt).getTime() < CURRENT_MONTH_CACHE_TTL_MS;
      if (isClosedMonth || fresh) return cached.data as MonthlySpendResult;
    }
    const inFlight = inFlightMonths.get(month);
    if (inFlight) return inFlight;
  }
  const promise = (async () => {
    const api = await createQboApi();
    const accountId = await getInventoryAccountId(api);
    const result = await computeMonthlySpend(api, accountId, month);
    await setCachedMonth(month, result);
    return result;
  })().finally(() => inFlightMonths.delete(month));
  inFlightMonths.set(month, promise);
  return promise;
}

app.get(
  '/api/inventory-spend',
  asyncRoute(async (req, res) => {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Provide ?month=YYYY-MM' });
    }
    const result = await getMonthlySpend(month, req.query.refresh === '1');
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
      const r = await getMonthlySpend(month, false);
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
        const account = await api.getAccount(await getInventoryAccountId(api));
        status.inventoryAccount = {
          id: account.Id,
          name: account.Name,
          acctNum: account.AcctNum ?? null,
          fullyQualifiedName: account.FullyQualifiedName,
          type: account.AccountType,
          active: account.Active,
        };
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
  res.status(500).json({ error: err.message || 'Internal error' });
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
