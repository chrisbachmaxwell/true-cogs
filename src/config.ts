export interface AppConfig {
  port: number;
  qboClientId: string | undefined;
  qboClientSecret: string | undefined;
  qboEnvironment: 'sandbox' | 'production';
  qboRedirectUri: string | undefined;
  tokenEncryptionKey: string | undefined;
  databaseUrl: string | undefined;
  /** Chart-of-accounts entries whose spend we track — each token matches an
   * account number (AcctNum) or exact account name, case-insensitive. */
  inventoryAccounts: string[];
  /** Income accounts counted as retail sales for the cash P&L (same matching). */
  retailIncomeAccounts: string[];
  /** Direct-cost accounts (freight, customer repairs, materials) whose cash
   * payments are added to COGS. */
  directCostAccounts: string[];
  /** Sales-tax liability account(s): remittances to them are deducted from
   * revenue, because the POS sync books tax-inclusive amounts into income. */
  salesTaxAccounts: string[];
  /** Pseudo-bank accounts whose payments are EXCLUDED from all cash spend math
   * (e.g. the unreconciled "ACH" clearing account whose Jul 2024 – Dec 2025
   * bill payments duplicate real bank payments). Statements show what was
   * excluded. Remove once the books are repaired. */
  excludedFundingAccounts: string[];
  /** Seeds the first admin when the users table is empty. Auth is enforced
   * whenever at least one user exists. */
  adminEmail: string | undefined;
  adminInitialPassword: string | undefined;
  /** Optional service account (e.g. for an agent that tests the live app),
   * created at boot only if it doesn't already exist. */
  agentEmail: string | undefined;
  agentPassword: string | undefined;
  agentIsAdmin: boolean;
  /** Resend API key for magic-link sign-in emails (D36). Absent = email
   * sign-in offline; password sign-in always remains available. */
  resendApiKey: string | undefined;
  /** Generic SMTP (D36a) — works with Gmail app passwords, Microsoft 365,
   * or any mail provider; takes precedence over Resend when set. */
  smtpHost: string | undefined;
  smtpPort: number;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  /** From-address for sign-in emails. Resend's shared onboarding sender works
   * out of the box; a verified pictureline.com sender is nicer. */
  authFromEmail: string;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  qboClientId: process.env.QBO_CLIENT_ID,
  qboClientSecret: process.env.QBO_CLIENT_SECRET,
  qboEnvironment:
    (process.env.QBO_ENVIRONMENT || 'sandbox') === 'production' ? 'production' : 'sandbox',
  qboRedirectUri: process.env.QBO_REDIRECT_URI,
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  databaseUrl: process.env.DATABASE_URL,
  inventoryAccounts: (process.env.QBO_INVENTORY_ACCOUNTS ||
    process.env.QBO_INVENTORY_ACCOUNT_NAME ||
    'Material Inventory')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  retailIncomeAccounts: (process.env.QBO_RETAIL_INCOME_ACCOUNTS || '40100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  directCostAccounts: (process.env.QBO_DIRECT_COST_ACCOUNTS || '51300,50600,50200')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  salesTaxAccounts: (process.env.QBO_SALES_TAX_ACCOUNTS || '21900')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  excludedFundingAccounts: (process.env.QBO_EXCLUDED_FUNDING_ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  adminEmail: process.env.ADMIN_EMAIL || 'chrism@pictureline.com',
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD,
  agentEmail: process.env.AGENT_EMAIL,
  agentPassword: process.env.AGENT_PASSWORD,
  agentIsAdmin: process.env.AGENT_IS_ADMIN === 'true',
  resendApiKey: process.env.RESEND_API_KEY,
  smtpHost: process.env.SMTP_HOST,
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  authFromEmail: process.env.AUTH_FROM_EMAIL || process.env.SMTP_USER || 'Pictureline Reports <onboarding@resend.dev>',
};

/** Missing env vars are reported per-feature instead of crashing the whole app,
 * so an empty shell can be deployed to Railway before credentials exist. */
export function missingQboConfig(): string[] {
  const missing: string[] = [];
  if (!config.qboClientId) missing.push('QBO_CLIENT_ID');
  if (!config.qboClientSecret) missing.push('QBO_CLIENT_SECRET');
  if (!config.qboRedirectUri) missing.push('QBO_REDIRECT_URI');
  if (!config.tokenEncryptionKey) missing.push('TOKEN_ENCRYPTION_KEY');
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  return missing;
}
