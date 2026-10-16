# htmlbin

**Drop HTML. Get a public URL.** Agent-first HTML hosting at
[htmlbin.aesir.works](https://htmlbin.aesir.works) — pastebin energy, for the HTML your
agent writes.

An agent does a one-time human-verified device-code dance (humans sign in
with GitHub — one htmlbin account per GitHub identity), then publishes
self-contained HTML to a public URL — no human after auth. Built for the
HTML-as-output-format era. Hosted entirely on Cloudflare: Workers + D1
+ KV.

## For agents

Read the protocol at [`/api/onboard`](https://htmlbin.aesir.works/api/onboard)
(JSON by default). The reference skill is
[`/.well-known/agent-skills/htmlbin/SKILL.md`](https://htmlbin.aesir.works/.well-known/agent-skills/htmlbin/SKILL.md).

Agents that speak MCP use `POST /mcp` on the same host. Send
`Authorization: Bearer hb_…` on every request, including `initialize`.
That token comes from the GitHub sign-in at `/verify`. The MCP door
does not open a browser login.

```
agent ─ POST /api/auth/start ──┐               sign in with GitHub
                               │                       │
                          (verification code)          │
                               │                       │
                          human ─ open /verify ───────┘
                               │  (single human moment)
                          ┌────┴────────────────────┐
                          │ upsert by github_user_id│  ◀── D1
                          │ mint token              │
                          └────┬────────────────────┘
                               │
agent ─ GET  /api/auth/poll ───┘  → api_token (one-time read)
agent ─ POST /api/drops  → slug, public URL
                                                  KV ──▶ HTML body
visitor ─ GET /p/:id  → viewer + iframe           D1 ──▶ metadata
                          (passcode gate if locked)
```

## Quick start (local)

```bash
npm install
npm run setup                    # provisions D1 + KV, applies schema
cp .dev.vars.example .dev.vars   # uses dev-mock GitHub OAuth; works as-is
npm run dev                      # http://localhost:8787
```

Once the dev server is up, exercise the whole protocol with the agent
test runner:

```bash
npm run test:e2e         # against the dev server on :8787
npm run test:e2e:local   # boots its own throwaway Worker with fresh local D1/KV (what CI runs)
```

Roughly 200 checks across discovery, onboarding, device-code auth, MCP,
drop CRUD, versioning, context, passcode lifecycle, ownership,
validation, and cleanup. All should pass.

## Local operator dashboard

```bash
npm run dashboard            # http://127.0.0.1:5173, against remote D1
npm run dashboard -- --local # against local D1
```

A tiny Node + vanilla-JS dashboard that proxies read-only SQL through
`wrangler d1 execute` and renders an interactive overview with
click-through into any user (drops, tokens, signup date, daily activity)
or any drop (versions, owner, storage). User detail pulls real name /
bio / followers / repos from the public GitHub API. Sibling of
`npm run stats`, just clickable. Local-only — bound to 127.0.0.1, not
deployed, not part of the product surface.

## Deploy

Production (`htmlbin.aesir.works`) only ships by merging a pull request.
Nobody runs `wrangler deploy` or pushes to `main` by hand, even for a
one-line fix. `.github/workflows/deploy.yml` does all of the deploying:

1. Branch from `main`, commit, and `git push -u origin <branch>`.
2. Open a PR. CI runs the local e2e suite, type-checks, uploads a
   preview version (`wrangler versions upload`), posts the preview URL as
   a sticky PR comment, and runs `scripts/smoke.sh` against it.
3. Test on the preview URL. Each push to the branch refreshes the same
   comment.
4. Once the change is approved, merge. The run on `main` deploys
   production and smoke-tests it.

Things CI does not do for you:

- **Migrations.** Run `npm run db:migrate:remote` before merging code
  that needs one, and before testing it on a preview. Write migrations
  so the code already in production keeps working once they're applied.
- **Secrets.** `TOKEN_PEPPER` and `GITHUB_CLIENT_SECRET` are Worker
  secrets (`wrangler secret put`). `SENTRY_DSN` uses
  `wrangler versions secret put`, because the Worker deploys versions.

> Previews live on the same Worker as production, so they share its
> bindings (D1, KV, AI) and secrets. Add an `[env.preview]` block in
> `wrangler.toml` with separate IDs if you want isolated preview data;
> see <https://developers.cloudflare.com/workers/wrangler/environments/>.

### Running your own instance

To run htmlbin from a fork on your own account, do the one-time setup,
then ship through the same PR flow:

1. `npm run setup` provisions D1 + KV, applies the schema, and prompts
   for secrets.
2. Create a GitHub OAuth app (<https://github.com/settings/applications/new>)
   with the callback URL `https://<your-host>/auth/github/callback`. Put
   the client id in `wrangler.toml` (`GITHUB_CLIENT_ID`) and the secret in
   `wrangler secret put GITHUB_CLIENT_SECRET`.
3. Point `PUBLIC_URL` and `routes` in `wrangler.toml` at your host.
4. Add a `CLOUDFLARE_API_TOKEN` repository secret (API token template
   "Edit Cloudflare Workers") so the workflow can deploy.

After that, PRs get a preview URL and merges to `main` deploy your
instance.

## API

### Discovery (no auth)

| Endpoint | What it returns |
|---|---|
| `GET /api/onboard` | JSON protocol descriptor (default). `Accept: text/markdown` or `?format=md` returns the same protocol as a markdown walkthrough. |
| `GET /openapi.json` | OpenAPI 3.1 spec |
| `GET /.well-known/agent-card.json` | Compact capability descriptor |
| `GET /.well-known/agent-skills/index.json` | [Agent Skills Discovery](https://github.com/cloudflare/agent-skills-discovery-rfc) RFC v0.2.0 index (entry skill: `htmlbin/SKILL.md`) |
| `GET /.well-known/api-catalog` | [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727) `linkset+json` |
| `GET /.well-known/patterns/index.json` | Pattern catalog: official starter patterns (name, description, triggers, `url`, and `template_url` for prescriptive ones) |
| `GET /.well-known/patterns/<name>.md` | One pattern as markdown. `<name>.template.html` serves a prescriptive pattern's skeleton as `text/plain` |
| `POST /mcp` | MCP endpoint (Streamable HTTP). Not anonymous: send the same `Bearer hb_…` token on every request, including `initialize`. `GET` answers 405 |
| `GET /llms.txt` | [llmstxt.org](https://llmstxt.org)-style site index |
| `GET /robots.txt` | Explicit allow-list of GPT/Claude/Perplexity bots |
| `GET /sitemap.xml` | Sitemap |
| `GET /index.md` | Landing rendered as Markdown via Workers AI (`Accept: text/markdown` on `/` works too) |
| `GET /favicon.svg` | Single source-of-truth favicon (auto-adapts to light/dark) |
| `GET /og.png`, `GET /og.svg` | Open Graph card for the landing, 1200×630. PNG is what unfurlers consume; SVG is the lightweight fallback. |
| `GET /p/:id/og.png`, `GET /p/:id/og.svg` | Per-drop OG card (title-focused). Same PNG/SVG split. |

The landing page also sets a `Link:` HTTP header advertising the agent-facing
ones: onboarding, OpenAPI, agent card, skills index, API catalog, pattern
catalog, llms.txt, MCP, and the sitemap.

### Auth (no auth)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/start` | Returns `{code, verification_url, poll_token}` |
| `GET`  | `/api/auth/poll?token=…` | `{status, api_token?}` — token revealed once |

### Drops *(Bearer `hb_…`)*

| Method | Path | Notes |
|---|---|---|
| `POST`   | `/api/drops` | `{title, description?, html, passcode?, context?, metadata?}` — creates v1 |
| `GET`    | `/api/drops` | List your drops. Filter with repeated `metadata.<key>=<value>` (AND across pairs) |
| `GET`    | `/api/drops/:slug` | Drop metadata |
| `PUT`    | `/api/drops/:slug` | Mints a new version (slug + URL preserved). May also update `title`/`description`/`metadata` |
| `PATCH`  | `/api/drops/:slug` | Update `title` / `description` / `metadata` without minting a version. `metadata` replaces the whole map |
| `GET`    | `/api/drops/:slug/versions` | List all versions |
| `GET`    | `/api/drops/:slug/v/:n` | Specific version metadata + context |
| `DELETE` | `/api/drops/:slug/v/:n` | Delete one version. Refused (`409`) for the last remaining one; returns the updated Drop |
| `DELETE` | `/api/drops/:slug` | Deletes all versions. `204 No Content` |
| `POST`   | `/api/drops/:slug/passcode` | Soft share gate; empty string removes it |
| `GET`    | `/api/me` | Your `user_id`, `created_at`, `drop_count`, and the calling token's info |
| `GET`    | `/api/tokens` | List your tokens across machines (revoked ones carry `revoked_at`) |
| `DELETE` | `/api/tokens/:id` | Revoke a token by short id |

### Public viewing

| Method | Path | Notes |
|---|---|---|
| `GET` | `/p/:id` | Viewer (with passcode gate when locked) |
| `GET` | `/p/:id?v=N` | Pinned to a specific version |
| `GET` | `/p/:id/raw` | Raw HTML, edge-cached for unlocked drops |

Drops run sandboxed in an opaque origin, both in the viewer iframe and
at `/raw`. Scripts, forms, modals, downloads, and popups work.
`localStorage`, `sessionStorage`, IndexedDB, and cookies don't, so a
drop keeps its state in memory or the URL hash.

## Versioning

Every `PUT` with new HTML mints a new version on the same slug. The URL
never changes. Switch versions in the viewer with `?v=N`. A `?v=N` that
isn't a live version (deleted, or never minted) returns 404 on both
`/p/:id` and `/p/:id/raw`.

## Metadata (owner-side tag bag)

Every drop carries a `metadata` field — a flat `string → string` map
(≤10 keys, ≤64 chars per key, ≤256 chars per value). Set on `POST`,
replace on `PUT`/`PATCH`, filter on `GET /api/drops?metadata.k=v`.
Free-form, no reserved keys. **Owner-only — the public viewer never
exposes it.**

The point is: agents tag drops with whatever they need to find them by
later. A few examples to spark ideas:

- `{repo: "foo/bar", pr: "42"}` — stable preview URL across CI pushes
  for one PR.
- `{session_id: "<chat-id>", kind: "deck"}` — the artifact this
  conversation produced, so the next turn can iterate on the same drop.
- `{client: "acme", project: "rebrand", status: "draft"}` — an agent
  maintaining a portfolio of in-progress work for an end-user.

The canonical recipe is **lookup-then-mutate**: `GET` with metadata
filters, then `PUT` if a drop matches or `POST` if not — no slug
bookkeeping on the client. There is intentionally **no** server-side
upsert endpoint; for shapes where parallel writes are possible (e.g. CI)
serialize at the call site. See CLAUDE.md.

## Cross-machine auth

Same human, multiple machines: run the verify flow on the new machine
and sign in with the same GitHub account. We bind one htmlbin account
per GitHub identity (UNIQUE `github_user_id`), so both devices share the
same `user_id`. Tokens are independent — revoke one, the other still
works.

## Limits

- 2 MB / drop
- 64 KB / context per version
- 200 versions / drop
- 60 writes / minute / account
- 500 writes / day / account (every mutating call counts)
- 500 drops / account
- 10-minute TTL on verification codes

Adjust in `src/drops.ts` and `src/auth.ts`.

## Project layout

```
src/
  index.ts          ─ Hono app: routes + chrome
  auth.ts           ─ device-code flow + Bearer middleware
  github-oauth.ts   ─ /auth/github/start + /auth/github/callback
  drops.ts          ─ /api/drops CRUD with versioning
  mcp.ts            ─ POST /mcp, Streamable HTTP, same hb_ bearer token
  onboard.ts        ─ /api/onboard JSON descriptor + markdown walkthrough
  skill.ts          ─ /.well-known/agent-skills/* (RFC v0.2.0)
  patterns.ts       ─ /.well-known/patterns/* (inline mirror of patterns/)
  crypto.ts         ─ Web Crypto wrappers (PBKDF2, HMAC)
  slug.ts           ─ short alphanumeric id generator
  db.ts             ─ D1 helpers + rate limiter
  recent.ts         ─ KV-cached "recently published" feed for the landing
  request.ts        ─ client IP key + cross-site request check
  safety-net.ts     ─ mobile safety net injected into /p/:id/raw
  discoverability.ts─ robots.txt, llms.txt, sitemap, agent-card, openapi, Link header
  errors.ts         ─ apiError(): the one error shape
  cookies.ts        ─ cookie parsing helpers
  fonts.ts          ─ /fonts/:name + @font-face CSS (data in fonts-data.ts)
  styles.ts         ─ shared CSS + STYLE_HREF (auto-bumping cache buster)
  types.ts          ─ shared types
  views/
    chrome.ts       ─ shared top bar, footer, HTTP-memo card
    favicon.ts      ─ inline SVG favicon
    logos.ts        ─ inlined agent brand marks for the landing
    og-image.ts     ─ inline SVG OG card (fallback / per-tab source)
    og-png.ts       ─ satori + resvg-wasm PNG renderer (1200×630)
    landing.ts      ─ /
    verify.ts       ─ /verify
    viewer.ts       ─ /p/:id + passcode gate (with version switcher)
skills/htmlbin/
  SKILL.md          ─ human-browsable mirror of src/skill.ts
patterns/           ─ canonical pattern markdown (mirrored into src/patterns.ts)
.github/workflows/
  deploy.yml        ─ production deploy on main, versioned preview on PR
schema.sql          ─ D1 schema
migrations/         ─ ALTER-style migrations against an existing D1
wrangler.toml       ─ Cloudflare config (incl. [[rules]] CompiledWasm for OG fonts)
scripts/
  setup.mjs         ─ one-shot provisioning
  agent-e2e.sh      ─ full functional test
  e2e-local.sh      ─ throwaway local Worker + smoke.sh + agent-e2e.sh (CI)
  smoke.sh          ─ post-deploy smoke test (preview + production)
  stats.mjs         ─ text stats snapshot (npm run stats)
  dashboard/        ─ local web dashboard (npm run dashboard)
```

DB table, URL path, and user-facing copy all align: **drops**.

## Security notes

- API tokens are stored only as `sha256(pepper || token)`. Plaintext is
  shown to the agent once via the device-code flow and never again.
- Passcode-protected drops use PBKDF2-SHA-256 (100k iterations, 16-byte
  random salt) for the soft share gate. Unlock cookie is HMAC-SHA-256-signed
  and scoped to the slug; it does not contain the passcode. This is a
  share gate, not encryption — the underlying HTML is unencrypted in KV.
- Iframe sandbox + CSP `frame-ancestors 'self'` on `/p/:id/raw` to
  prevent UI redress / clickjacking from external sites. The CSP
  `sandbox` omits `allow-same-origin`, so a drop's script never runs as
  htmlbin itself, even when `/raw` is opened top-level.
- Rate limiting is single-region D1 (best-effort). For higher-traffic
  deployments, swap in
  [Cloudflare Rate Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Design

Visual system documented in [DESIGN.md](./DESIGN.md). Short version:
white paper, Geist + Geist Mono, single red accent, HTTP-style memo on
every page, vim-modeline breadcrumb top bar. **Single source of truth
is `src/styles.ts`** — edit one file, every page updates. The link is
content-hashed (`/style.css?v=<hash>`) so the edge cache busts itself
on every CSS change.

## Why HTML?

> Markdown has become a restricting format. HTML can convey almost any
> information an agent can read — and the chance of someone actually
> reading your spec, report or PR writeup is much, much higher if it's
> HTML.
>
> — Thariq, "The Unreasonable Effectiveness of HTML"

htmlbin is a place to put it.

## License

MIT.
