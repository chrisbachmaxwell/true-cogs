export interface AppConfig {
  port: number;
  qboClientId: string | undefined;
  qboClientSecret: string | undefined;
  qboEnvironment: 'sandbox' | 'production';
  qboRedirectUri: string | undefined;
  tokenEncryptionKey: string | undefined;
  databaseUrl: string | undefined;
  /** Chart-of-accounts account name whose spend we track. */
  inventoryAccountName: string;
  /** Resend API key for magic-link sign-in emails. Auth is enforced only when set. */
  resendApiKey: string | undefined;
  /** Comma-separated allowlist of emails permitted to sign in. */
  authAllowedEmails: string;
  /** From address for sign-in emails. */
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
  inventoryAccountName: process.env.QBO_INVENTORY_ACCOUNT_NAME || 'Material Inventory',
  resendApiKey: process.env.RESEND_API_KEY,
  authAllowedEmails: process.env.AUTH_ALLOWED_EMAILS || 'chrism@pictureline.com',
  authFromEmail: process.env.AUTH_FROM_EMAIL || 'Pictureline Tracker <onboarding@resend.dev>',
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
