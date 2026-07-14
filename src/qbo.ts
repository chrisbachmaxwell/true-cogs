import crypto from 'crypto';
import OAuthClient from 'intuit-oauth';
import QuickBooks from 'node-quickbooks';
import { config } from './config';
import { loadTokens, saveTokens, TokenSet } from './tokenStore';

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh access token when <5 min remain
const QBO_MINOR_VERSION = 75;

/** Narrow surface consumed by the business logic, so it can be unit-tested with a mock. */
export interface QboApi {
  /** Runs `SELECT * FROM <entity> WHERE TxnDate >= start AND TxnDate <= end`, fully paginated. */
  queryByDateRange(entity: EntityName, start: string, end: string): Promise<any[]>;
  getBill(id: string): Promise<any>;
  findAccountsByName(name: string): Promise<any[]>;
}

export type EntityName = 'BillPayment' | 'Purchase' | 'Bill' | 'VendorCredit' | 'JournalEntry' | 'Deposit';

const FINDER_BY_ENTITY: Record<EntityName, string> = {
  BillPayment: 'findBillPayments',
  Purchase: 'findPurchases',
  Bill: 'findBills',
  VendorCredit: 'findVendorCredits',
  JournalEntry: 'findJournalEntries',
  Deposit: 'findDeposits',
};

function oauthClient(): any {
  return new OAuthClient({
    clientId: config.qboClientId,
    clientSecret: config.qboClientSecret,
    environment: config.qboEnvironment,
    redirectUri: config.qboRedirectUri,
  });
}

// Single-user internal tool: pending OAuth states kept in memory with a short TTL.
const pendingStates = new Map<string, number>();

export function buildAuthUri(): string {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);
  for (const [s, exp] of pendingStates) if (exp < Date.now()) pendingStates.delete(s);
  return oauthClient().authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state,
  });
}

function tokenSetFromAuthResponse(authResponse: any, realmId: string, connectedAt: number): TokenSet {
  const j = typeof authResponse.getJson === 'function' ? authResponse.getJson() : authResponse.json;
  const now = Date.now();
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    realmId,
    accessTokenExpiresAt: now + j.expires_in * 1000,
    refreshTokenExpiresAt: now + j.x_refresh_token_expires_in * 1000,
    lastRefreshedAt: now,
    connectedAt,
  };
}

/** Exchanges the OAuth callback for tokens and persists them. */
export async function handleCallback(callbackUrl: string): Promise<TokenSet> {
  const url = new URL(callbackUrl, 'http://localhost');
  const state = url.searchParams.get('state') || '';
  if (!pendingStates.has(state)) {
    throw new Error('OAuth state mismatch — start again from /connect');
  }
  pendingStates.delete(state);
  const realmId = url.searchParams.get('realmId');
  if (!realmId) throw new Error('Callback is missing realmId');

  const client = oauthClient();
  const authResponse = await client.createToken(callbackUrl);
  const existing = await loadTokens().catch(() => null);
  const tokens = tokenSetFromAuthResponse(authResponse, realmId, existing?.connectedAt ?? Date.now());
  await saveTokens(tokens);
  return tokens;
}

/** Returns stored tokens, refreshing first if the access token is close to expiry.
 * Refresh tokens rotate on every use, so the rotated pair is persisted immediately. */
export async function getFreshTokens(): Promise<TokenSet> {
  const tokens = await loadTokens();
  if (!tokens) throw new Error('Not connected to QuickBooks — visit /connect first');

  if (tokens.accessTokenExpiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return tokens;
  }
  const client = oauthClient();
  const authResponse = await client.refreshUsingToken(tokens.refreshToken);
  const refreshed = tokenSetFromAuthResponse(authResponse, tokens.realmId, tokens.connectedAt);
  await saveTokens(refreshed);
  console.log('[qbo] access token refreshed; refresh token rotated');
  return refreshed;
}

function qboClient(tokens: TokenSet): any {
  return new QuickBooks(
    config.qboClientId,
    config.qboClientSecret,
    tokens.accessToken,
    false, // no token secret in OAuth2
    tokens.realmId,
    config.qboEnvironment === 'sandbox',
    false, // debug
    QBO_MINOR_VERSION,
    '2.0',
    tokens.refreshToken
  );
}

function callFinder(qbo: any, method: string, criteria: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    qbo[method](criteria, (err: any, data: any) => {
      if (err) reject(new Error(`QBO ${method} failed: ${JSON.stringify(err.Fault || err)}`));
      else resolve(data);
    });
  });
}

const PAGE_SIZE = 1000; // QBO's max page size

export async function createQboApi(): Promise<QboApi> {
  const tokens = await getFreshTokens();
  const qbo = qboClient(tokens);

  async function queryAll(entity: EntityName, baseCriteria: any[]): Promise<any[]> {
    const method = FINDER_BY_ENTITY[entity];
    const results: any[] = [];
    let offset = 1; // STARTPOSITION is 1-based
    for (;;) {
      const criteria = [
        ...baseCriteria,
        { field: 'offset', value: offset },
        { field: 'limit', value: PAGE_SIZE },
      ];
      const data = await callFinder(qbo, method, criteria);
      const page: any[] = data?.QueryResponse?.[entity] || [];
      results.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return results;
  }

  return {
    queryByDateRange(entity, start, end) {
      return queryAll(entity, [
        { field: 'TxnDate', value: start, operator: '>=' },
        { field: 'TxnDate', value: end, operator: '<=' },
      ]);
    },
    getBill(id: string) {
      return new Promise((resolve, reject) => {
        qbo.getBill(id, (err: any, bill: any) => {
          if (err) reject(new Error(`QBO getBill(${id}) failed: ${JSON.stringify(err.Fault || err)}`));
          else resolve(bill);
        });
      });
    },
    findAccountsByName(name: string) {
      return callFinder(qbo, 'findAccounts', [{ field: 'Name', value: name }]).then(
        (data) => data?.QueryResponse?.Account || []
      );
    },
  };
}

export interface ConnectionStatus {
  connected: boolean;
  realmId?: string;
  environment: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  lastRefreshedAt?: string;
  connectedAt?: string;
  daysSinceLastRefresh?: number;
  daysUntilReauthRequired?: number;
  staleWarning?: string;
}

/** Intuit policy: refresh at least every ~100 days, full reauth after 5 years. */
export async function connectionStatus(): Promise<ConnectionStatus> {
  const tokens = await loadTokens().catch(() => null);
  if (!tokens) return { connected: false, environment: config.qboEnvironment };

  const now = Date.now();
  const daysSinceRefresh = (now - tokens.lastRefreshedAt) / 86_400_000;
  const fiveYearsMs = 5 * 365 * 86_400_000;
  const daysUntilReauth = (tokens.connectedAt + fiveYearsMs - now) / 86_400_000;

  let staleWarning: string | undefined;
  if (now > tokens.refreshTokenExpiresAt) {
    staleWarning = 'The refresh token has expired. Reconnect via /connect.';
  } else if (daysSinceRefresh > 80) {
    staleWarning = `No token refresh in ${Math.floor(daysSinceRefresh)} days — Intuit disconnects after ~100 days idle. Load any report to refresh, or reconnect via /connect.`;
  } else if (daysUntilReauth < 30) {
    staleWarning = `Connection is ${Math.max(0, Math.floor(daysUntilReauth))} days from Intuit's 5-year reauthorization limit. Reconnect via /connect soon.`;
  }
  if (staleWarning) console.warn(`[qbo] ${staleWarning}`);

  return {
    connected: true,
    realmId: tokens.realmId,
    environment: config.qboEnvironment,
    accessTokenExpiresAt: new Date(tokens.accessTokenExpiresAt).toISOString(),
    refreshTokenExpiresAt: new Date(tokens.refreshTokenExpiresAt).toISOString(),
    lastRefreshedAt: new Date(tokens.lastRefreshedAt).toISOString(),
    connectedAt: new Date(tokens.connectedAt).toISOString(),
    daysSinceLastRefresh: Math.floor(daysSinceRefresh),
    daysUntilReauthRequired: Math.floor(daysUntilReauth),
    staleWarning,
  };
}
