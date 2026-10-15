// Agent-ready discoverability layer.
//
// Inspired by the criteria at https://isitagentready.com:
//   - /robots.txt with explicit AI-bot allowances and sitemap pointer
//   - /sitemap.xml listing public URLs
//   - /llms.txt — the de-facto agent-friendly site index (plain text)
//   - /.well-known/agent-card.json — compact capability descriptor
//   - /openapi.json — OpenAPI 3.1 spec for the public API
//   - /.well-known/patterns/* is served from patterns.ts; it is advertised
//     here (llms.txt, agent card, OpenAPI, Link header, sitemap)
//   - HTTP `Link:` headers on the landing page advertising the above
//   - JSON-LD Service schema on the landing page (added inline in landing.ts)
//
// Everything here is content-negotiation friendly: `Accept: text/plain`,
// `Accept: text/markdown`, `Accept: application/json` all do reasonable
// things on the agent-aimed endpoints.

import { buildPatternIndex } from "./patterns";

export function robotsTxt(publicUrl: string): string {
  // One group, many User-agent lines. A crawler obeys only the single group
  // that names it most specifically, so rules placed after the last named
  // group bind that agent alone. Listing every agent above one shared rule
  // block keeps the explicit allow-list and applies the disallows to all.
  return `# htmlbin is built for agents. All AI crawlers are welcome.
# See ${publicUrl}/llms.txt for the agent-friendly site index.
# Signed and auth-only paths are not crawled, by any agent.

User-agent: *
User-agent: GPTBot
User-agent: ChatGPT-User
User-agent: OAI-SearchBot
User-agent: ClaudeBot
User-agent: Claude-Web
User-agent: anthropic-ai
User-agent: PerplexityBot
User-agent: Perplexity-User
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: Bytespider
User-agent: Meta-ExternalAgent
User-agent: cohere-ai
Allow: /
Disallow: /api/auth/
Disallow: /verify

Sitemap: ${publicUrl}/sitemap.xml
`;
}

// llms.txt — see https://llmstxt.org. Plain text, top-level, agent-aimed.
export function llmsTxt(publicUrl: string): string {
  const host = stripScheme(publicUrl);
  return `# htmlbin

> Agent-first HTML hosting. Drop self-contained HTML, get a public URL.
> Built for the HTML-as-output-format era. The whole product is reachable
> via a single API; no signup, no dashboard.

A drop is one HTML artifact published at ${host}/p/<id>. Each drop has
versions; the URL never changes when you iterate.

## Quick start (for agents)

If you are an agent landing on this page, fetch this URL — it returns a
machine-readable protocol descriptor (JSON by default; markdown with
Accept: text/markdown) you can follow end-to-end:

  ${publicUrl}/api/onboard

It walks you through a 4-step flow: device-code auth → one-time human
"Sign in with GitHub" at /verify (one htmlbin account per GitHub
identity, read:user scope only) → token (revealed exactly once on
/api/auth/poll) → POST your HTML.

## MCP

POST ${publicUrl}/mcp is a Streamable HTTP MCP endpoint. Send
Authorization: Bearer hb_… on every request, including initialize.
The token is the one /api/auth/poll reveals after the human signs in
with GitHub. The endpoint does not open its own login.

The reference skill is at
${publicUrl}/.well-known/agent-skills/htmlbin/SKILL.md.

## Patterns

Common drop kinds (PR explainers, summary roundups, plan/spec writeups,
session explainers) have optional authoring patterns: small markdown
files with triggers, a content checklist, and layout directions. List
them at ${publicUrl}/.well-known/patterns/index.json and fetch one at
${publicUrl}/.well-known/patterns/<name>.md. Patterns installed in
./.htmlbin/patterns/ or ~/.config/htmlbin/patterns/ take precedence.

## Endpoints

- ${publicUrl}/                              — landing (memo addressed to agents)
- ${publicUrl}/index.md                      — landing rendered as markdown (also served when Accept: text/markdown)
- ${publicUrl}/api/onboard                   — agent onboarding (JSON descriptor by default; markdown with Accept: text/markdown or ?format=md)
- ${publicUrl}/openapi.json                  — full OpenAPI 3.1 spec
- ${publicUrl}/.well-known/agent-card.json   — compact capability descriptor
- ${publicUrl}/.well-known/agent-skills/index.json  — Agent Skills Discovery (RFC v0.2.0) index
- ${publicUrl}/.well-known/api-catalog       — API catalog (RFC 9727, linkset+json)
- ${publicUrl}/.well-known/patterns/index.json      — pattern catalog (official starter patterns, JSON)
- ${publicUrl}/.well-known/patterns/<name>.md       — one pattern as markdown (prescriptive ones also list a template_url)
- ${publicUrl}/sitemap.xml                   — sitemap

## API surface

### auth
- POST /api/auth/start         → { code, verification_url, poll_token }
- GET  /api/auth/poll?token=…  → { status, api_token? }       (one-time read)

### mcp (auth: Bearer hb_…)
- POST /mcp   → Streamable HTTP. Tools: whoami, create_drop, get_drop, list_drops, update_drop, patch_drop, delete_drop, list_versions, get_version, delete_version, set_passcode

### drops (auth: Bearer hb_…)
- POST   /api/drops                  → upload HTML (creates v1)
- GET    /api/drops                  → list yours
- GET    /api/drops/:slug            → metadata
- PUT    /api/drops/:slug            → mints a new version
- PATCH  /api/drops/:slug            → title / description / metadata only
- GET    /api/drops/:slug/versions   → list versions
- GET    /api/drops/:slug/v/:n       → version metadata + context
- DELETE /api/drops/:slug/v/:n       → delete one version
- DELETE /api/drops/:slug            → delete (all versions)
- POST   /api/drops/:slug/passcode   → set/change/remove passcode
- GET    /api/tokens                 → list your tokens (revoked ones carry revoked_at)
- DELETE /api/tokens/:id             → revoke a token (id = first 12 hex)

### viewer
- GET /p/:slug          → public viewer (latest version)
- GET /p/:slug?v=N      → pinned to version N
- GET /p/:slug/raw      → raw HTML, edge-cached
- GET /p/:slug/raw?v=N  → raw HTML for a specific version

Drops run sandboxed in an opaque origin: scripts, forms, modals, popups
and downloads work; localStorage, sessionStorage, IndexedDB and cookies
do not, and the page cannot navigate the top window. Keep page state in
memory or the URL hash; open outbound links with target="_blank".

## Limits

- 2 MB per HTML
- 60 writes / minute / account
- 500 writes / day / account
- 500 drops per account
- 200 versions per drop
- 10-minute TTL on verification codes

## Errors

All errors are JSON: { "error": { "code", "message", "details"? } } with an
appropriate HTTP status. Switch on error.code. Common codes: unauthorized,
invalid_token, rate_limited, daily_quota_exceeded, html_too_large,
forbidden, not_found, version_conflict, passcode_too_short, quota_exceeded,
version_limit_reached. Every 429 carries a Retry-After header.

## Source

Open source. Edge-hosted. Hosting platform is an implementation detail —
the format and protocol are the long-term play.

`;
}

export function sitemapXml(publicUrl: string): string {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${publicUrl}/`, priority: "1.0" },
    { loc: `${publicUrl}/api/onboard`, priority: "0.9" },
    // /mcp is POST-only (GET answers 405), so it is advertised in the Link
    // header, llms.txt, the agent card and OpenAPI, but not listed here.
    { loc: `${publicUrl}/llms.txt`, priority: "0.6" },
    { loc: `${publicUrl}/openapi.json`, priority: "0.6" },
    { loc: `${publicUrl}/.well-known/patterns/index.json`, priority: "0.5" },
    ...buildPatternIndex(publicUrl).patterns.map((p) => ({
      loc: p.url,
      priority: "0.4",
    })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>
`;
}

// Compact agent-capability card. Self-describing JSON intended for any
// agent that lands on / and follows the well-known link.
export function agentCard(publicUrl: string): object {
  return {
    schema_version: "1.0",
    name: "htmlbin",
    description:
      "Agent-first HTML hosting. Drop self-contained HTML, get a public URL.",
    home: publicUrl,
    contact: `${publicUrl}/`,
    onboarding: {
      url: `${publicUrl}/api/onboard`,
      content_types: ["application/json", "text/markdown"],
      summary:
        "Single endpoint that returns the full agent protocol as a JSON descriptor by default. Send Accept: text/markdown or ?format=md for the same protocol as a markdown walkthrough.",
    },
    auth: {
      type: "device_code",
      start: `${publicUrl}/api/auth/start`,
      poll: `${publicUrl}/api/auth/poll`,
      verify_human_at: `${publicUrl}/verify`,
      token_format: "Bearer hb_<base62>",
      token_lifetime: "non-expiring (revocable)",
    },
    mcp: {
      url: `${publicUrl}/mcp`,
      transport: "streamable_http",
      auth: "Authorization: Bearer hb_<base62>",
      summary:
        "Same token as the REST API. GitHub sign-in happens once, when that token is minted. Send the header on every request, including initialize.",
    },
    skill: {
      url: `${publicUrl}/.well-known/agent-skills/htmlbin/SKILL.md`,
      summary: "Reference skill for the HTTP API and the MCP tools.",
    },
    patterns: {
      index: `${publicUrl}/.well-known/patterns/index.json`,
      pattern_url: `${publicUrl}/.well-known/patterns/<name>.md`,
      summary:
        "Optional authoring patterns for common drop kinds (PR explainers, summary roundups, plan/spec writeups, session explainers). The index lists each pattern's name, description, triggers, url, and template_url for prescriptive ones. Patterns in ./.htmlbin/patterns/ or ~/.config/htmlbin/patterns/ take precedence.",
    },
    drop_runtime: {
      origin: "opaque (sandboxed)",
      sandbox_allows: ["scripts", "forms", "modals", "downloads", "popups", "popups-to-escape-sandbox"],
      unavailable: ["localStorage", "sessionStorage", "IndexedDB", "document.cookie", "top-level navigation"],
      summary:
        "Published HTML runs in a sandbox without allow-same-origin. Storage APIs and cookies throw or are unavailable, and requests back to htmlbin carry no cookies, so guard any storage use with try/catch and keep state in memory or the URL hash. Links meant to leave the page need target=\"_blank\".",
    },
    capabilities: [
      {
        id: "publish_html",
        description:
          "Upload self-contained HTML up to 2 MB; receive a permanent public URL. Creates v1. Returns the full Drop with status 201. Optional `metadata` (string→string, ≤10 keys) attaches owner-side tags for later lookup.",
        method: "POST",
        path: "/api/drops",
        accepts: ["title", "description?", "html", "passcode?", "context?", "metadata?"],
      },
      {
        id: "update_html",
        description:
          "PUT mints a NEW version on the same slug — URL is preserved across iterations. `html` is required; title/description/metadata optional. Metadata replace semantics: omit → untouched, {} → cleared.",
        method: "PUT",
        path: "/api/drops/:slug",
        accepts: ["html", "title?", "description?", "context?", "metadata?"],
      },
      {
        id: "update_metadata",
        description:
          "PATCH updates title, description, and/or metadata without minting a new version. Returns 400 metadata_only_on_patch if `html` is included. Metadata replace semantics: omit → untouched, {} → cleared.",
        method: "PATCH",
        path: "/api/drops/:slug",
        accepts: ["title?", "description?", "metadata?"],
      },
      {
        id: "list_versions",
        method: "GET",
        path: "/api/drops/:slug/versions",
      },
      {
        id: "get_version",
        description: "Includes the optional context recorded at that version.",
        method: "GET",
        path: "/api/drops/:slug/v/:n",
      },
      {
        id: "delete_drop",
        description: "Returns 204 No Content.",
        method: "DELETE",
        path: "/api/drops/:slug",
      },
      {
        id: "delete_version",
        description:
          "Delete a single version. Refused for the last remaining version; if the deleted version was the head, latest_version is recomputed. Returns the updated Drop.",
        method: "DELETE",
        path: "/api/drops/:slug/v/:n",
      },
      {
        id: "list_my_drops",
        description:
          "Paginated list. Query params: page (default 1), pageSize (default 50, max 200), sortBy (created_at|updated_at|view_count), sortOrder (asc|desc). Also supports repeated `metadata.<key>=<value>` params for AND-filtering — the canonical lookup-then-mutate primitive for finding a drop you previously tagged (any tag combination — PR previews, session artifacts, client portfolios, document kinds, etc).",
        method: "GET",
        path: "/api/drops",
      },
      {
        id: "lock_with_passcode",
        description:
          "Set, change, or remove a passcode (soft share gate, not encryption). Pass empty string to remove. Returns the updated Drop.",
        method: "POST",
        path: "/api/drops/:slug/passcode",
      },
      {
        id: "whoami",
        description:
          "Returns user_id, created_at, drop_count, and current token info (id, label, created_at, last_used_at).",
        method: "GET",
        path: "/api/me",
      },
      {
        id: "list_my_tokens",
        description:
          "List this user's tokens across machines, including revoked ones (revoked_at set). No plaintext.",
        method: "GET",
        path: "/api/tokens",
      },
      {
        id: "revoke_token",
        description:
          "Revoke a specific token by its short id (first 12 hex chars of the hash). Returns 204 No Content.",
        method: "DELETE",
        path: "/api/tokens/:id",
      },
    ],
    error_shape: {
      shape: "{ error: { code, message, details? } }",
      switch_on: "error.code",
      note:
        "All 4xx/5xx responses use this shape. Rate-limited responses (429) additionally carry a Retry-After header.",
    },
    naming_convention: "snake_case",
    cors: {
      posture: "deny",
      note:
        "No CORS headers are set. Browser cross-origin XHR will fail by design. htmlbin is an agent-side API; call it from server-side scripts and agent runtimes, not from arbitrary third-party web pages.",
    },
    versioning: {
      semantics:
        "Every PUT with a new html body increments the version. Slug + URL stay stable.",
      view_specific_version: "/p/<slug>?v=<n>",
      raw_specific_version: "/p/<slug>/raw?v=<n>",
    },
    cross_machine_auth: {
      method: "Run /api/auth/start on a new machine and sign in with the same GitHub account at /verify. We bind one htmlbin account per GitHub identity.",
      result: "Both devices share the same user_id with separate tokens.",
    },
    limits: {
      max_html_bytes: 2_097_152,
      max_context_bytes: 65_536,
      max_versions_per_drop: 200,
      writes_per_minute: 60,
      writes_per_day: 500,
      drops_per_account: 500,
      verification_ttl_seconds: 600,
    },
    spec: {
      openapi: `${publicUrl}/openapi.json`,
      llms_txt: `${publicUrl}/llms.txt`,
      agent_skills_index: `${publicUrl}/.well-known/agent-skills/index.json`,
      api_catalog: `${publicUrl}/.well-known/api-catalog`,
      patterns_index: `${publicUrl}/.well-known/patterns/index.json`,
    },
    license: "MIT",
  };
}

// OpenAPI 3.1 spec — small, intentionally narrow.
export function openApiSpec(publicUrl: string): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "htmlbin API",
      version: "1.3.0",
      summary:
        "Agent-first HTML hosting. Drop self-contained HTML, get a public URL.",
      description:
        "All endpoints under /api/. Auth uses a Bearer token minted via the /api/auth/start device-code flow. All field names use snake_case. All 4xx/5xx responses share the same Error shape (see components.schemas.Error).",
      contact: { url: publicUrl },
      license: { name: "MIT" },
    },
    servers: [{ url: publicUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "hb_<base62>",
        },
      },
      headers: {
        RetryAfter: {
          description:
            "Seconds until a retry can succeed (RFC 9110). Mirrored in the body as error.details.retry_after_seconds. For the count caps (quota_exceeded, version_limit_reached) it is a fixed 3600: time alone does not lift them. Delete a drop to free a drop slot; version numbers are never reused, so at the version cap publish a new drop.",
          schema: { type: "integer", minimum: 0 },
        },
      },
      responses: {
        WriteLimited: {
          description:
            "Write limit hit. error.code is rate_limited (60 writes/min/account) or daily_quota_exceeded (500 writes/day/account). Every mutating /api/drops call counts.",
          headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        Forbidden: {
          description: "forbidden: the drop belongs to another account.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        NotFound: {
          description: "Not found",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      schemas: {
        Drop: {
          type: "object",
          required: ["slug", "title", "url", "raw_url", "metadata", "created_at"],
          properties: {
            slug: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            url: { type: "string", format: "uri" },
            raw_url: { type: "string", format: "uri" },
            locked: { type: "boolean" },
            latest_version: { type: "integer" },
            view_count: { type: "integer" },
            metadata: { $ref: "#/components/schemas/Metadata" },
            created_at: { type: "integer", description: "unix ms" },
            updated_at: { type: "integer", description: "unix ms" },
          },
        },
        Metadata: {
          type: "object",
          description:
            "Owner-side tag bag — free-form string→string map for whatever an agent wants to track across its drops. Examples of what owners tag with: {repo, pr} for stable CI preview URLs, {session_id, kind} for per-conversation artifacts, {client, project, status} for portfolio work, {kind, topic} for buckets. Max 10 keys, 64 chars per key, 256 chars per value. Filterable on GET /api/drops via repeated `metadata.<key>=<value>` query params (AND across pairs). Not exposed on the public viewer.",
          additionalProperties: { type: "string", maxLength: 256 },
          maxProperties: 10,
        },
        VersionListItem: {
          type: "object",
          required: ["version", "size_bytes", "created_at", "is_latest"],
          properties: {
            version: { type: "integer" },
            size_bytes: { type: "integer" },
            has_context: { type: "boolean" },
            created_at: { type: "integer" },
            is_latest: { type: "boolean", description: "True for the version latest_version points at." },
          },
        },
        Version: {
          type: "object",
          required: ["slug", "version", "size_bytes", "created_at"],
          properties: {
            slug: { type: "string" },
            version: { type: "integer" },
            size_bytes: { type: "integer" },
            context: {
              type: ["string", "null"],
              description: "Optional reasoning trace recorded at this version",
            },
            created_at: { type: "integer" },
            is_latest: { type: "boolean" },
          },
        },
        Error: {
          type: "object",
          description:
            "Canonical error envelope. Every 4xx/5xx response uses this shape; switch on `error.code` (not `error.message`).",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  description: "Machine-readable identifier, e.g. 'html_too_large', 'not_found', 'rate_limited'.",
                },
                message: { type: "string", description: "Human-readable summary." },
                details: { type: "object", description: "Optional context (limits, fields, retry_after_seconds, etc.)." },
              },
            },
          },
        },
        Pagination: {
          type: "object",
          required: ["page", "page_size", "total_items", "total_pages", "sort_by", "sort_order"],
          properties: {
            page: { type: "integer" },
            page_size: { type: "integer" },
            total_items: { type: "integer" },
            total_pages: { type: "integer" },
            sort_by: { type: "string", enum: ["created_at", "updated_at", "view_count"] },
            sort_order: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
    },
    paths: {
      "/mcp": {
        post: {
          summary: "MCP endpoint (Streamable HTTP)",
          description:
            "JSON-RPC for MCP clients. Requires Authorization: Bearer hb_… on every request, including initialize. The token is minted after the human signs in with GitHub. Tools mirror the drops API: whoami, create_drop, get_drop, list_drops, update_drop, patch_drop, delete_drop, list_versions, get_version, delete_version, set_passcode.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "JSON-RPC result" },
            "401": { description: "Missing or unknown hb_ token" },
          },
        },
      },
      "/api/onboard": {
        get: {
          summary: "Agent protocol descriptor",
          description:
            "Returns the full agent protocol. JSON descriptor by default. Send Accept: text/markdown, or ?format=md, for the same protocol as a markdown walkthrough. Responses carry Vary: Accept.",
          parameters: [
            {
              name: "format",
              in: "query",
              required: false,
              description: "md returns the markdown walkthrough instead of JSON.",
              schema: { type: "string", enum: ["md"] },
            },
          ],
          responses: {
            "200": {
              description: "Protocol descriptor (JSON) or walkthrough (markdown)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    description:
                      "Structured protocol descriptor. Field values are mostly descriptive strings and examples, so the nested shapes are documented loosely here; treat the live response as authoritative.",
                    required: ["schema_version", "name", "public_url", "auth", "publish"],
                    properties: {
                      schema_version: { type: "string" },
                      name: { type: "string" },
                      public_url: { type: "string", format: "uri" },
                      summary: { type: "string" },
                      naming_convention: { type: "string" },
                      spec: { type: "object", description: "URLs of the other discovery surfaces" },
                      mcp: { type: "object" },
                      error_shape: { type: "object" },
                      auth: { type: "object", description: "Device-code flow: type, header, token_format, token_storage, steps[]" },
                      drop_shape: { type: "object" },
                      publish: { type: "object" },
                      iterate: { type: "object", description: "new_version (PUT) and metadata_only (PATCH)" },
                      list_my_drops: { type: "object" },
                      other_endpoints: { type: "object" },
                      patterns: { type: "object", description: "Pattern catalog URLs and resolution order" },
                      drop_runtime: { type: "object", description: "What published HTML can and cannot do in its sandbox" },
                      cross_machine: { type: "object" },
                      limits: { type: "object" },
                      rate_limits: { type: "object" },
                      errors: { type: "object" },
                      recommendations: { type: "object" },
                      notes: { type: "array", items: { type: "string" } },
                    },
                  },
                },
                "text/markdown": { schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/api/auth/start": {
        post: {
          summary: "Begin device-code flow",
          description:
            "Returns a short verification code, a verification_url, and a poll_token. The agent prints the URL to the human; the human opens it and signs in with GitHub (read:user scope). htmlbin binds one account per GitHub identity, so the token returned via /api/auth/poll attaches to that user.",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { label: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Code + poll token",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      verification_url: { type: "string", format: "uri" },
                      poll_token: { type: "string" },
                      expires_in: { type: "integer" },
                      poll_interval: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/auth/poll": {
        get: {
          summary: "Poll for verified token",
          parameters: [
            {
              name: "token",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Status (and api_token if verified, exactly once)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: {
                        type: "string",
                        enum: ["pending", "verified", "claimed", "expired"],
                      },
                      api_token: { type: "string" },
                      user_id: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/me": {
        get: {
          summary: "Caller identity, drop count, and current token info",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Caller info",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user_id: { type: "string" },
                      created_at: { type: ["integer", "null"] },
                      drop_count: { type: "integer" },
                      token: {
                        type: ["object", "null"],
                        properties: {
                          id: { type: "string" },
                          label: { type: ["string", "null"] },
                          created_at: { type: "integer" },
                          last_used_at: { type: ["integer", "null"] },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/tokens": {
        get: {
          summary: "List the caller's tokens (revoked ones included, with revoked_at)",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Array of tokens (no plaintext)",
              content: { "application/json": { schema: { type: "array", items: { type: "object" } } } },
            },
          },
        },
      },
      "/api/tokens/{id}": {
        delete: {
          summary: "Revoke a token by its 12-hex id",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{12}$" } },
          ],
          responses: {
            "204": { description: "Revoked" },
            "404": { description: "No matching token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/drops": {
        get: {
          summary: "List your drops (paginated)",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "page",      in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
            { name: "pageSize",  in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "sortBy",    in: "query", schema: { type: "string", enum: ["created_at", "updated_at", "view_count"], default: "created_at" } },
            { name: "sortOrder", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
            {
              name: "metadata.<key>",
              in: "query",
              description:
                "Repeatable. Filter drops by metadata tag — AND across pairs. Key must match /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/i, ≤64 chars. Example: ?metadata.repo=u/r&metadata.pr=42",
              schema: { type: "string", maxLength: 256 },
            },
          ],
          responses: {
            "200": {
              description: "Paginated drops",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["data", "pagination"],
                    properties: {
                      data: { type: "array", items: { $ref: "#/components/schemas/Drop" } },
                      pagination: { $ref: "#/components/schemas/Pagination" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Upload a new drop (creates v1)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title", "html"],
                  properties: {
                    title: { type: "string", maxLength: 200 },
                    description: { type: "string", maxLength: 500 },
                    html: { type: "string" },
                    passcode: { type: "string", minLength: 4, description: "Soft share gate, not encryption" },
                    context: { type: "string", description: "Optional reasoning trace (≤64KB, opt-in)" },
                    metadata: { $ref: "#/components/schemas/Metadata" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created — returns the full Drop",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Drop" } } },
            },
            "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": {
              description:
                "rate_limited, daily_quota_exceeded, or quota_exceeded (500 drops/account; Retry-After 3600). Every 429 carries Retry-After.",
              headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/api/drops/{slug}": {
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          summary: "Get metadata for one of your drops",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Drop", content: { "application/json": { schema: { $ref: "#/components/schemas/Drop" } } } },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        put: {
          summary: "Mint a new version (html required)",
          description: "PUT always mints a new version. `html` is required. `title`/`description`/`metadata` may be updated alongside the new version. Use PATCH for non-html-only edits.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["html"],
                  properties: {
                    html: { type: "string" },
                    title: { type: "string", maxLength: 200 },
                    description: { type: "string", maxLength: 500 },
                    context: { type: "string", description: "Optional reasoning trace (≤64KB, opt-in)" },
                    metadata: { $ref: "#/components/schemas/Metadata" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated — returns the full Drop with bumped latest_version", content: { "application/json": { schema: { $ref: "#/components/schemas/Drop" } } } },
            "400": { description: "Missing html / validation", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "version_conflict — a concurrent PUT minted the next version first; re-fetch and retry", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": {
              description:
                "rate_limited, daily_quota_exceeded, or version_limit_reached (200 versions/drop; Retry-After 3600). Every 429 carries Retry-After.",
              headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
        patch: {
          summary: "Update title / description / metadata (no new version)",
          description: "PATCH updates title, description, and/or metadata without minting a new version. Metadata replace semantics: omit to leave untouched, `{}` to clear, `{k:v}` to overwrite the whole map. Including `html` returns 400 metadata_only_on_patch.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string", maxLength: 200 },
                    description: { type: "string", maxLength: 500 },
                    metadata: { $ref: "#/components/schemas/Metadata" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated — returns the full Drop (latest_version unchanged)", content: { "application/json": { schema: { $ref: "#/components/schemas/Drop" } } } },
            "400": { description: "Included html or other validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { $ref: "#/components/responses/NotFound" },
            "429": { $ref: "#/components/responses/WriteLimited" },
          },
        },
        delete: {
          summary: "Delete drop (all versions)",
          security: [{ bearerAuth: [] }],
          responses: {
            "204": { description: "Deleted (no body)" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { $ref: "#/components/responses/NotFound" },
            "429": { $ref: "#/components/responses/WriteLimited" },
          },
        },
      },
      "/api/drops/{slug}/versions": {
        get: {
          summary: "List versions of a drop",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Array of versions",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/VersionListItem" } } } },
            },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/api/drops/{slug}/v/{n}": {
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "n",    in: "path", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        get: {
          summary: "Get one version's metadata + context",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Version", content: { "application/json": { schema: { $ref: "#/components/schemas/Version" } } } },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { description: "not_found (drop) or version_not_found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
        delete: {
          summary: "Delete a single version (refused for the last remaining)",
          description: "Returns the updated Drop. If the deleted version was the head, latest_version is recomputed.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Deleted — returns the updated Drop", content: { "application/json": { schema: { $ref: "#/components/schemas/Drop" } } } },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { description: "not_found (drop) or version_not_found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "409": { description: "last_version_cannot_be_deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": { $ref: "#/components/responses/WriteLimited" },
          },
        },
      },
      "/api/drops/{slug}/passcode": {
        post: {
          summary: "Set, change, or remove the passcode (soft share gate) on a drop",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["passcode"],
                  properties: {
                    passcode: { type: "string", description: "Empty string to remove" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated — returns the full Drop", content: { "application/json": { schema: { $ref: "#/components/schemas/Drop" } } } },
            "400": { description: "passcode_required, passcode_too_short, or invalid_slug", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": { $ref: "#/components/responses/NotFound" },
            "429": { $ref: "#/components/responses/WriteLimited" },
          },
        },
      },
      "/.well-known/patterns/index.json": {
        get: {
          summary: "Pattern catalog index",
          description:
            "Official starter patterns for common drop kinds. Each entry names the pattern and links its markdown; prescriptive patterns also carry template_url, a reference skeleton served as text/plain. Agent-side guidance only: the server never validates published HTML against a pattern.",
          responses: {
            "200": {
              description: "Pattern index",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["version", "patterns"],
                    properties: {
                      version: { type: "string" },
                      patterns: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["name", "description", "triggers", "url"],
                          properties: {
                            name: { type: "string" },
                            description: { type: "string" },
                            triggers: { type: "array", items: { type: "string" } },
                            url: { type: "string", format: "uri" },
                            template_url: { type: "string", format: "uri" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/.well-known/patterns/{filename}": {
        get: {
          summary: "One pattern (<name>.md) or its reference skeleton (<name>.template.html)",
          parameters: [
            { name: "filename", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Pattern markdown, or the skeleton as plain text",
              content: {
                "text/markdown": { schema: { type: "string" } },
                "text/plain": { schema: { type: "string" } },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/p/{slug}": {
        get: {
          summary: "Public viewer (HTML)",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Viewer page" },
            "404": { description: "Not found" },
          },
        },
      },
      "/p/{slug}/raw": {
        get: {
          summary: "Raw HTML, edge-cached",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "The drop, served as text/html",
              content: { "text/html": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
  };
}

// Build the discoverability `Link:` header value advertised on /.
export function linkHeader(publicUrl: string): string {
  const host = publicUrl.replace(/\/$/, "");
  return [
    `<${host}/index.md>; rel="alternate"; type="text/markdown"; title="this page as markdown"`,
    `<${host}/api/onboard>; rel="describedby"; type="application/json"; title="agent onboarding"`,
    `<${host}/openapi.json>; rel="service-desc"; type="application/openapi+json"`,
    `<${host}/.well-known/agent-card.json>; rel="https://agentprotocol.org/agent-card"; type="application/json"`,
    `<${host}/.well-known/agent-skills/index.json>; rel="https://agentskills.io/discovery"; type="application/json"; title="Agent Skills Discovery"`,
    `<${host}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
    `<${host}/.well-known/patterns/index.json>; rel="related"; type="application/json"; title="pattern catalog"`,
    `<${host}/llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt"`,
    `<${host}/mcp>; rel="service"; type="application/json"; title="MCP"`,
    `<${host}/sitemap.xml>; rel="sitemap"; type="application/xml"`,
  ].join(", ");
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
