// GitHub OAuth at /verify. Replaces the Turnstile-only checkpoint.
//
// Why GitHub:
//   Turnstile only proves a human is on the page. It does nothing about
//   the same human running the device-code flow over and over to mint
//   fresh tokens. Binding every account to a UNIQUE github_user_id makes
//   "delete token, get new token" reset nothing — the same account is
//   recycled, all quotas stick. Creating a *second* GitHub account has
//   real friction (rate limits, email verification, the slow ramp on a
//   throwaway account's reputation) which is the point.
//
// Flow:
//   1. Human lands on /verify?code=<verify_code>
//   2. Clicks "Sign in with GitHub" → POST /auth/github/start (form field
//      `code`). Same-origin only.
//   3. Worker sets a browser-binding cookie `<nonce>.<verify_code>` and
//      redirects to github.com/login/oauth/authorize, state=<nonce>
//   4. GitHub bounces back to /auth/github/callback?code=<gh_code>&state=<nonce>
//   5. Worker checks state against the cookie, takes the verify code from
//      the cookie, exchanges gh_code for an access token, fetches /user
//   6. Lookup user by github_user_id; create one if it's the first time
//   7. Mark the verification row verified + attach api_token; render the
//      shared success view. The agent's poll claims the token (one-time
//      read) and only then is it written to `tokens` and usable.
//
// Dev mock:
//   When GITHUB_CLIENT_ID === "dev-mock", /auth/github/start skips the
//   round-trip to github.com and synthesizes a deterministic github
//   identity from a `mock_login` form field. The e2e script uses this.
//   Production binds the real client id/secret and the mock path is
//   unreachable.
//
// Why the binding cookie:
//   The verify code used to be the OAuth state, with nothing tying it to
//   the browser. Anyone who had authorized the app before could be sent a
//   link (to /auth/github/start, or straight to GitHub's authorize URL
//   with state=<attacker's code>); GitHub skips its consent screen for an
//   app the account already authorized, so the victim's account was bound
//   to the attacker's poll token without a single prompt. Now the state is
//   a nonce that only exists in a cookie this site set after a same-origin
//   POST from /verify, so the sign-in has to start in the victim's own
//   browser, on our page, from a click.

import { Hono } from "hono";
import * as Sentry from "@sentry/cloudflare";
import type { Bindings, Variables } from "./types";
import { constantTimeEqual, newApiToken, newUserId, randomBase62 } from "./crypto";
import { getCookie } from "./cookies";
import { createUser, getUserByGitHubId, rateLimit } from "./db";
import { CLAIM_TTL_MS } from "./auth";
import { verifyPage } from "./views/verify";

const DEV_MOCK = "dev-mock";

// `__Host-` keeps sibling subdomains from planting this cookie. SameSite=Lax
// still sends it on GitHub's top-level redirect back to the callback.
const BIND_COOKIE = "__Host-hb_oauth";
const BIND_TTL_S = 10 * 60;
const CLEAR_BIND_COOKIE = `${BIND_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// A cross-site page (or a sandboxed drop, whose origin is "null") must not
// be able to start a sign-in. Browsers send Sec-Fetch-Site on form POSTs;
// Origin is the fallback for older ones.
function isSameOriginPost(c: any): boolean {
  const site = c.req.header("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  return c.req.header("Origin") === new URL(c.req.url).origin;
}

export const githubOAuthRoutes = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

// Old GET links land on the verify page; a GET never starts a sign-in.
githubOAuthRoutes.get("/auth/github/start", (c) => {
  const code = (c.req.query("code") ?? "").trim().toUpperCase();
  return c.redirect(`/verify?code=${encodeURIComponent(code)}`, 302);
});

// Start: bind this browser, then bounce the human to GitHub (or the
// dev-mock callback).
githubOAuthRoutes.post("/auth/github/start", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const code = String(form?.get("code") ?? "").trim().toUpperCase();
  if (!isSameOriginPost(c)) {
    return c.html(
      verifyPage(c.env, {
        code,
        error: "Sign-in has to start from this page. Press the button below.",
      }),
      403
    );
  }
  if (!code) {
    return c.html(
      verifyPage(c.env, {
        code: "",
        error: "Missing verification code. Open the link your agent printed.",
      }),
      400
    );
  }

  const verification = await c.env.DB.prepare(
    `SELECT code, status, expires_at FROM verifications WHERE code = ?`
  )
    .bind(code)
    .first<{ code: string; status: string; expires_at: number }>();

  if (!verification) {
    return c.html(
      verifyPage(c.env, {
        code,
        error: `No pending request for "${code}". Did the agent print a different code?`,
      }),
      404
    );
  }
  if (verification.expires_at < Date.now()) {
    return c.html(
      verifyPage(c.env, {
        code,
        error: "This code has expired. Ask your agent to start a new flow.",
      }),
      410
    );
  }
  if (verification.status !== "pending") {
    return c.html(
      verifyPage(c.env, {
        code,
        error: `This code is already ${verification.status}.`,
      }),
      409
    );
  }

  const nonce = randomBase62(32);
  c.header(
    "Set-Cookie",
    `${BIND_COOKIE}=${nonce}.${code}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${BIND_TTL_S}`
  );

  // Dev mock: short-circuit github.com so e2e + offline dev still works.
  if (c.env.GITHUB_CLIENT_ID === DEV_MOCK) {
    const mockLogin = String(form?.get("mock_login") ?? "dev-user").slice(0, 40);
    const cbUrl = new URL(`${c.env.PUBLIC_URL}/auth/github/callback`);
    cbUrl.searchParams.set("state", nonce);
    cbUrl.searchParams.set("code", "mock");
    cbUrl.searchParams.set("mock_login", mockLogin);
    return c.redirect(cbUrl.toString(), 303);
  }

  const redirectUri = `${c.env.PUBLIC_URL}/auth/github/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", nonce);
  authorize.searchParams.set("allow_signup", "true");
  return c.redirect(authorize.toString(), 303);
});

// Callback: exchange the gh code, look up / create the user, mint the
// api token, mark verification verified.
githubOAuthRoutes.get("/auth/github/callback", async (c) => {
  const nonce = c.req.query("state") ?? "";
  const ghCode = c.req.query("code") ?? "";
  const ghError = c.req.query("error");

  // The binding cookie is single-use: every outcome below clears it.
  c.header("Set-Cookie", CLEAR_BIND_COOKIE);
  const bound = getCookie(c.req.header("Cookie") ?? "", BIND_COOKIE) ?? "";
  const dot = bound.indexOf(".");
  const boundNonce = dot > 0 ? bound.slice(0, dot) : "";
  // `state` keeps its old name below: it is the verify code, now read from
  // the cookie this browser was given, never from the URL.
  const state = dot > 0 ? bound.slice(dot + 1) : "";

  if (!nonce || !boundNonce || !state || !constantTimeEqual(nonce, boundNonce)) {
    return c.html(
      verifyPage(c.env, {
        code: "",
        error:
          "This sign-in didn't start in this browser. Open the link your agent printed and press the button there.",
      }),
      400
    );
  }
  if (ghError) {
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: `GitHub denied the sign-in (${ghError}). Try again.`,
      }),
      400
    );
  }
  if (!ghCode) {
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: "OAuth callback missing code. Start the flow again.",
      }),
      400
    );
  }

  // Re-check the verification (state hasn't been verified/expired in the
  // ~few seconds the human was at github.com).
  const verification = await c.env.DB.prepare(
    `SELECT code, status, label, expires_at FROM verifications WHERE code = ?`
  )
    .bind(state)
    .first<{
      code: string;
      status: string;
      label: string | null;
      expires_at: number;
    }>();

  if (!verification) {
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: `No pending request for "${state}". Did the agent print a different code?`,
      }),
      404
    );
  }
  if (verification.expires_at < Date.now()) {
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: "This code has expired. Ask your agent to start a new flow.",
      }),
      410
    );
  }
  if (verification.status !== "pending") {
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: `This code is already ${verification.status}.`,
      }),
      409
    );
  }

  // Cap callbacks per IP — exchanging codes against github.com is real
  // network spend, and a buggy agent retrying the callback shouldn't
  // hammer it.
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await rateLimit(c.env.DB, `gh:cb:${ip}`, 20, 60_000);
  if (!rl.ok) {
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: "Too many sign-in attempts. Try again in a minute.",
      }),
      429
    );
  }

  let githubUserId: number;
  let githubLogin: string;
  try {
    if (c.env.GITHUB_CLIENT_ID === DEV_MOCK) {
      githubLogin = (c.req.query("mock_login") ?? "dev-user").slice(0, 40);
      // Deterministic but per-login id, so two different mock_logins
      // create two different accounts. 32-bit space is plenty for tests.
      githubUserId = await stableMockId(githubLogin);
    } else {
      const exchanged = await exchangeCode(
        ghCode,
        c.env.GITHUB_CLIENT_ID,
        c.env.GITHUB_CLIENT_SECRET,
        `${c.env.PUBLIC_URL}/auth/github/callback`
      );
      const ghUser = await fetchGitHubUser(exchanged.access_token);
      githubUserId = ghUser.id;
      githubLogin = ghUser.login;
    }
  } catch (e) {
    console.error("github_oauth_failed", String(e));
    // An expired or reused GitHub code is the human's to retry; anything
    // else (bad client secret, redirect_uri mismatch, GitHub down) is ours
    // to see, so report it. Handled here, it never reaches withSentry.
    const ghCodeRejected =
      e instanceof GitHubOAuthError && e.githubError === "bad_verification_code";
    if (!ghCodeRejected) {
      Sentry.captureException(e, {
        tags: {
          github_oauth_error:
            e instanceof GitHubOAuthError ? e.githubError : "network",
        },
      });
    }
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: ghCodeRejected
          ? "That GitHub sign-in expired or was already used. Sign in with GitHub again."
          : e instanceof GitHubOAuthError
            ? "GitHub didn't accept this sign-in. The problem is on our side and has been reported."
            : "Couldn't reach GitHub to complete sign-in. Try again.",
      }),
      502
    );
  }

  // Upsert by github_user_id.
  let user = await getUserByGitHubId(c.env.DB, githubUserId);
  let linked = false;
  if (user) {
    // Existing identity → fresh token, same user_id. This is the
    // "same human on a new device" path that used to require pasting
    // an existing token.
    linked = true;
  } else {
    const newId = newUserId();
    try {
      await createUser(c.env.DB, newId, githubLogin, {
        id: githubUserId,
        login: githubLogin,
      });
      user = {
        id: newId,
        display_name: githubLogin,
        created_at: Date.now(),
        github_user_id: githubUserId,
        github_login: githubLogin,
      };
    } catch (e) {
      // A concurrent first sign-in for the same GitHub identity won the
      // UNIQUE(github_user_id) race. Use the row it created.
      user = await getUserByGitHubId(c.env.DB, githubUserId);
      if (!user) throw e;
      linked = true;
    }
  }

  // Conditional on status = 'pending' so a double-submitted callback can't
  // overwrite the first one's token. The token is written to `tokens` only
  // when the agent claims it in /api/auth/poll; until then it exists only
  // here, for at most CLAIM_TTL_MS.
  const now = Date.now();
  const apiToken = newApiToken();
  const marked = await c.env.DB.prepare(
    `UPDATE verifications
        SET status = 'verified', user_id = ?, api_token = ?, expires_at = ?
      WHERE code = ? AND status = 'pending' AND expires_at >= ?`
  )
    .bind(user.id, apiToken, now + CLAIM_TTL_MS, state, now)
    .run();
  if ((marked.meta?.changes ?? 0) === 0) {
    return c.html(
      verifyPage(c.env, {
        code: state,
        error: "This code was already used or has expired. Ask your agent to start a new flow.",
      }),
      409
    );
  }

  return c.html(
    verifyPage(c.env, {
      code: state,
      success: true,
      linked,
      githubLogin,
    })
  );
});

// ---------------------------------------------------------------------------

// GitHub answered, but refused. `githubError` is GitHub's own error code
// (e.g. bad_verification_code, incorrect_client_credentials,
// redirect_uri_mismatch) or a short label for a malformed response.
// A thrown fetch (GitHub unreachable) stays a plain Error.
class GitHubOAuthError extends Error {
  constructor(readonly githubError: string, message: string) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ access_token: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GitHubOAuthError(
      "non_json_response",
      `github token endpoint returned ${res.status} non-JSON: ${text.slice(0, 200)}`
    );
  }
  if (json.error) {
    throw new GitHubOAuthError(
      String(json.error),
      `github token error: ${json.error} ${json.error_description ?? ""}`
    );
  }
  if (!json.access_token) {
    throw new GitHubOAuthError(
      "missing_access_token",
      "github token response missing access_token"
    );
  }
  return { access_token: json.access_token };
}

async function fetchGitHubUser(
  accessToken: string
): Promise<{ id: number; login: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "htmlbin-oauth",
    },
  });
  if (!res.ok) {
    throw new GitHubOAuthError("user_fetch_failed", `github /user returned ${res.status}`);
  }
  const json = (await res.json()) as { id?: number; login?: string };
  if (typeof json.id !== "number" || typeof json.login !== "string") {
    throw new GitHubOAuthError(
      "user_response_invalid",
      "github /user response missing id/login"
    );
  }
  return { id: json.id, login: json.login };
}

// Dev-mock id: SHA-256(login) → first 4 bytes → uint32. Same login always
// resolves to the same id, different logins almost certainly don't collide.
async function stableMockId(login: string): Promise<number> {
  const buf = new TextEncoder().encode(login);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const v = new DataView(hash);
  // Bias the high bit off so the value comfortably fits in a SQLite INTEGER
  // and a JS number — and stays well below any plausible real GitHub id range.
  return v.getUint32(0) >>> 1;
}
