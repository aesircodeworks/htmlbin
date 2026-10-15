// Small request helpers shared by the rate-limited routes.
import type { Context } from "hono";

// Rate-limit key for the caller's address. IPv6 clients are grouped by /64:
// an ordinary host is handed a whole /64, so keying on the full address
// would let one machine rotate through billions of fresh buckets.
export function clientIpKey(c: Context): string {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!ip.includes(":")) return ip;
  // Expand "::" so the first four groups are always the /64 prefix.
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase() || "0").join(":")}::/64`;
}

// True when a browser tells us this request came from another site (or from
// a sandboxed drop, whose origin is "null"). Requests with neither header
// are non-browser clients, which can't be driven by a visitor's page.
export function isCrossSiteBrowserRequest(c: Context): boolean {
  const site = c.req.header("Sec-Fetch-Site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = c.req.header("Origin");
  return origin !== undefined && origin !== new URL(c.req.url).origin;
}
