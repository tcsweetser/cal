export interface Env {
  DB: D1Database;
  TOKEN_STORE: KVNamespace;

  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  PRIMARY_ACCOUNT_EMAIL: string;
}
