// Shared Web Crypto helpers — token encryption (AES-GCM) and OAuth-flow-cookie
// signing (HMAC) both need base64/base64url plumbing and key import, so it lives
// here once rather than duplicated between tokenManager.ts and routes/auth.ts.
// See plan.md §5.2 for why AES-GCM + a dedicated TOKEN_ENCRYPTION_KEY were chosen.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBytes(padded);
}

// --- Token encryption (AES-256-GCM) ---

export async function importAesKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(base64Key), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

// Stored value is base64(iv || ciphertext) — a fresh random IV every call, so
// encrypting the same tokens twice never produces the same bytes.
export async function encryptJSON(key: CryptoKey, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64(combined);
}

export async function decryptJSON<T>(key: CryptoKey, blob: string): Promise<T> {
  const combined = base64ToBytes(blob);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// --- OAuth-flow-cookie signing (HMAC-SHA256) ---

export async function importHmacKey(base64Secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(base64Secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// Compact "payload.signature" token, both base64url. verifyJSON returns null
// (never throws) on a missing/malformed/tampered token so callers can treat
// any failure the same way: reject the flow, don't trust partial data.
export async function signJSON(key: CryptoKey, data: unknown): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(data)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${bytesToBase64Url(sig)}`;
}

export async function verifyJSON<T>(key: CryptoKey, token: string): Promise<T | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  // Everything below can throw on malformed input (atob() on non-base64
  // data throws InvalidCharacterError, not just JSON.parse) — the function's
  // contract is "null on anything wrong", so all of it needs to be guarded,
  // not just the final parse.
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(sig),
      new TextEncoder().encode(payload),
    );
    if (!valid) return null;
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as T;
  } catch {
    return null;
  }
}

// --- PKCE (RFC 7636) ---

export function generateCodeVerifier(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function generateState(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}
