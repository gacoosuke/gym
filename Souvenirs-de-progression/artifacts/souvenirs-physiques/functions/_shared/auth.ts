import type { Context, MiddlewareHandler } from "hono";
import type { AppContext, Member, SessionRecord } from "./types";

const PIN_ITERATIONS = 210_000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const EXTEND_SESSION_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

const PUBLIC_ROUTES = new Set([
  "GET /api/healthz",
  "GET /api/members",
  "POST /api/session",
  "POST /api/setup/pins",
]);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToBase64(new Uint8Array(digest));
}

export async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PIN_ITERATIONS },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export function createPinSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function verifyPin(
  pin: string,
  saltBase64: string,
  expectedBase64: string,
): Promise<boolean> {
  const actual = await hashPin(pin, base64ToBytes(saltBase64));
  return constantTimeEqual(actual, expectedBase64);
}

export async function verifySetupSecret(
  received: string | undefined,
  configured: string | undefined,
): Promise<boolean> {
  if (!received || !configured) return false;
  const [receivedDigest, configuredDigest] = await Promise.all([
    hashSessionToken(received),
    hashSessionToken(configured),
  ]);
  return constantTimeEqual(receivedDigest, configuredDigest);
}

export function sessionExpiry(envTtl: string | undefined): string {
  const parsed = Number(envTtl);
  const days = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 30), 3650) : 3650;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function enforceLoginRateLimit(
  c: Context<AppContext>,
): Promise<{ allowed: boolean; ipAddress: string }> {
  const ipAddress =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const entry = await c.env.DB.prepare(
    "SELECT attempts, window_started_at FROM login_attempts WHERE ip_address = ?",
  )
    .bind(ipAddress)
    .first<{ attempts: number; window_started_at: string }>();

  if (!entry) return { allowed: true, ipAddress };

  const elapsed = Date.now() - Date.parse(entry.window_started_at);
  if (!Number.isFinite(elapsed) || elapsed >= LOGIN_WINDOW_MS) {
    await c.env.DB.prepare("DELETE FROM login_attempts WHERE ip_address = ?")
      .bind(ipAddress)
      .run();
    return { allowed: true, ipAddress };
  }

  return { allowed: entry.attempts < LOGIN_MAX_ATTEMPTS, ipAddress };
}

export async function recordFailedLogin(
  db: D1Database,
  ipAddress: string,
): Promise<void> {
  const now = new Date().toISOString();
  const current = await db
    .prepare("SELECT attempts, window_started_at FROM login_attempts WHERE ip_address = ?")
    .bind(ipAddress)
    .first<{ attempts: number; window_started_at: string }>();
  const withinWindow =
    current !== null &&
    Date.now() - Date.parse(current.window_started_at) < LOGIN_WINDOW_MS;

  if (withinWindow) {
    await db
      .prepare(
        "UPDATE login_attempts SET attempts = attempts + 1 WHERE ip_address = ?",
      )
      .bind(ipAddress)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO login_attempts (ip_address, attempts, window_started_at)
         VALUES (?, 1, ?)
         ON CONFLICT(ip_address) DO UPDATE SET attempts = 1, window_started_at = excluded.window_started_at`,
      )
      .bind(ipAddress, now)
      .run();
  }
}

export const sessionMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.req.method === "OPTIONS" || PUBLIC_ROUTES.has(`${c.req.method} ${new URL(c.req.url).pathname}`)) {
    return next();
  }

  const authorization = c.req.header("Authorization");
  const token = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i)?.[1];
  if (!token) return c.json({ error: "Session requise." }, 401);

  const tokenHash = await hashSessionToken(token);
  const row = await c.env.DB.prepare(
    `SELECT s.token_hash, s.member_id, s.expires_at
     FROM sessions s
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<SessionRecord>();

  if (!row) return c.json({ error: "Session expirée. Reconnectez-vous dans les paramètres." }, 401);

  const memberRow = await c.env.DB.prepare(
    "SELECT id, name, color_theme AS color FROM members WHERE id = ?",
  )
    .bind(row.member_id)
    .first<Member>();
  if (!memberRow) return c.json({ error: "Membre introuvable." }, 401);

  c.set("member", memberRow);

  const expiresAt = Date.parse(row.expires_at);
  if (expiresAt - Date.now() < EXTEND_SESSION_WITHIN_MS) {
    await c.env.DB.prepare(
      `UPDATE sessions
       SET expires_at = ?, last_seen_at = ?
       WHERE token_hash = ?`,
    )
      .bind(sessionExpiry(c.env.SESSION_TTL_DAYS), new Date().toISOString(), tokenHash)
      .run();
  }

  await next();
};

export async function checkLoginLimit(
  c: Context<AppContext>,
): Promise<{ allowed: boolean; ipAddress: string }> {
  return enforceLoginRateLimit(c);
}