// Minimal Web Crypto helpers — Workers ships Web Crypto by default.

const ALPHABET_BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ALPHABET_HUMAN = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

export function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET_BASE62[bytes[i]! % ALPHABET_BASE62.length];
  }
  return out;
}

// Short, human-readable, easy to type (no ambiguous chars).
// Format: AAAA-BBBB (8 chars × 32-char alphabet = 40 bits — fine for 10-min TTL codes).
export function randomHumanCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += ALPHABET_HUMAN[bytes[i]! % ALPHABET_HUMAN.length];
    if (i === 3) out += "-";
  }
  return out;
}

// Per-user prefix lets humans recognize htmlbin tokens at a glance.
// Short prefix (`hb_`) keeps the token from feeling visually heavy.
export function newApiToken(): string {
  return `hb_${randomBase62(40)}`;
}

export function newPollToken(): string {
  return randomBase62(48);
}

export function newUserId(): string {
  return `u_${randomBase62(16)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Hash an API token for storage. Pepper from env binds it to this deployment.
export async function hashToken(token: string, pepper: string): Promise<string> {
  return sha256Hex(`${pepper}::${token}`);
}

// Password hashing for prototype password protection.
// PBKDF2 + SHA-256, 100k iterations — Workers-native, no extra deps.
export async function hashPassword(
  password: string,
  saltHex?: string
): Promise<{ hash: string; salt: string }> {
  const saltBytes = saltHex
    ? hexToBytes(saltHex)
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 100_000 },
    keyMaterial,
    256
  );
  return {
    hash: bytesToHex(new Uint8Array(bits)),
    salt: bytesToHex(saltBytes),
  };
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHashHex: string
): Promise<boolean> {
  const { hash } = await hashPassword(password, saltHex);
  return constantTimeEqual(hash, expectedHashHex);
}

// Sign a tiny opaque cookie value for unlocked drops.
// Cookie body: `${slug}.${expEpoch}.${hmacHex}`
//
// `binding` is the drop's current passcode hash. It goes into the MAC but
// not the cookie, so changing or removing the passcode invalidates every
// unlock cookie issued under the old one.
export async function signUnlockToken(
  slug: string,
  expEpoch: number,
  pepper: string,
  binding: string
): Promise<string> {
  const mac = await hmacHex(`${slug}|${expEpoch}|${binding}`, pepper);
  return `${slug}.${expEpoch}.${mac}`;
}

export async function verifyUnlockToken(
  token: string,
  slug: string,
  pepper: string,
  binding: string
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [s, expStr, mac] = parts;
  if (s !== slug) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmacHex(`${slug}|${exp}|${binding}`, pepper);
  return constantTimeEqual(mac!, expected);
}

// Owner-session cookie for private drops: `${userId}.${expEpoch}.${hmacHex}`.
// Parsed from the right so a user id containing "." can't shift the fields.
// The MAC is domain-separated ("owner|…") from unlock cookies, which share
// the same pepper.
export async function signOwnerToken(
  userId: string,
  expEpoch: number,
  pepper: string
): Promise<string> {
  const mac = await hmacHex(`owner|${userId}|${expEpoch}`, pepper);
  return `${userId}.${expEpoch}.${mac}`;
}

// Returns the user id the cookie was issued to, or null if it's malformed,
// expired, or forged.
export async function verifyOwnerToken(
  token: string,
  pepper: string
): Promise<string | null> {
  const macAt = token.lastIndexOf(".");
  const expAt = token.lastIndexOf(".", macAt - 1);
  if (macAt <= 0 || expAt <= 0) return null;
  const userId = token.slice(0, expAt);
  const exp = Number(token.slice(expAt + 1, macAt));
  const mac = token.slice(macAt + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = await hmacHex(`owner|${userId}|${exp}`, pepper);
  return constantTimeEqual(mac, expected) ? userId : null;
}

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
