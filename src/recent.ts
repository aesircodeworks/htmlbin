import type { Bindings } from "./types";
import { listRecentPublicDrops } from "./db";

// KV read-through for the homepage "recently published" feed.
//
// The landing is the highest-volume route, so the D1 query runs at most
// once per TTL window (≤288/day) no matter how much traffic `/` gets, and
// KV gives every region the same list. Writes that change which drops are
// eligible (create, delete, passcode, title edit) drop the key so the next
// homepage hit rebuilds it — see invalidateRecentDrops() callers in
// drops.ts. Bump the `:v1` suffix if the cached shape changes.
const KEY = "feed:recent:v1";
const TTL_SECONDS = 300;
const LIMIT = 10;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type RecentDrop = { slug: string; title: string; created_at: number };

export async function getRecentDropsCached(env: Bindings): Promise<RecentDrop[]> {
  try {
    const cached = await env.DROPS_KV.get<RecentDrop[]>(KEY, "json");
    if (Array.isArray(cached)) return cached;
    const rows = await listRecentPublicDrops(env.DB, LIMIT, Date.now() - WINDOW_MS);
    await env.DROPS_KV.put(KEY, JSON.stringify(rows), { expirationTtl: TTL_SECONDS });
    return rows;
  } catch {
    // The feed is decoration. If KV or D1 is unhappy the homepage still
    // renders, just without the section.
    return [];
  }
}

export async function invalidateRecentDrops(env: Bindings): Promise<void> {
  try {
    await env.DROPS_KV.delete(KEY);
  } catch {
    // Worst case the feed is stale until the TTL runs out.
  }
}
