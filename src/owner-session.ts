// Owner session for private drops.
//
// A private drop (visibility = 'private') is viewable only by its owner.
// The browser proves ownership with a signed `hb_owner` cookie, minted by
// /auth/github/callback after the human signs in with the same GitHub
// account that owns the drop (see ownerSignIn routes in github-oauth.ts).
//
// Scope is deliberately narrow: the cookie is Path=/p, so it only rides on
// viewer, raw and OG requests — never on /api/* or /mcp, which keep using
// the hb_ bearer token. It is not an account surface: there is no page that
// lists anything; it only answers "is this browser the owner of this drop?".
//
// SameSite=Lax keeps it off cross-site subresource requests. That matters
// for /p/<slug>/raw: drops run in an opaque sandbox origin, so a script in
// someone else's drop that fetch()es your private drop's /raw is cross-site
// and the cookie isn't attached.

import type { Drop } from "./types";
import { signOwnerToken, verifyOwnerToken } from "./crypto";

export const OWNER_COOKIE = "hb_owner";
export const OWNER_SESSION_TTL_S = 7 * 24 * 3600;

export async function ownerSessionCookie(
  userId: string,
  pepper: string
): Promise<string> {
  const exp = Date.now() + OWNER_SESSION_TTL_S * 1000;
  const value = await signOwnerToken(userId, exp, pepper);
  return `${OWNER_COOKIE}=${value}; Path=/p; HttpOnly; Secure; SameSite=Lax; Max-Age=${OWNER_SESSION_TTL_S}`;
}

export function clearOwnerSessionCookie(): string {
  return `${OWNER_COOKIE}=; Path=/p; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// The user id this browser is signed in as, or null.
export async function getOwnerSession(
  cookieHeader: string,
  pepper: string
): Promise<string | null> {
  const value = getCookie(cookieHeader, OWNER_COOKIE);
  if (!value) return null;
  return verifyOwnerToken(value, pepper);
}

// True when the drop is private and this session isn't its owner.
export function isHiddenFrom(drop: Drop, sessionUserId: string | null): boolean {
  return drop.visibility === "private" && sessionUserId !== drop.user_id;
}

export function getCookie(header: string, name: string): string | null {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}
