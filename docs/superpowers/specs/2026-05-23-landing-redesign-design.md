# Landing page redesign — design spec

- **Date:** 2026-05-23
- **Branch:** `landing-redesign-spec`
- **Status:** the install pill, extra prompt panes, and terminal section from earlier drafts are withdrawn. Do not build them.
- **Scope:** `src/views/landing.ts`, `src/views/chrome.ts`, `src/styles.ts`. No API, schema, or auth changes.

## Why

htmlbin v1 launched with a deliberately tight landing — modeline + HTTP memo + hero + single dark prompt slab + 4 examples + signoff. Since launch we shipped material capability that the landing should be able to point at:

- **Queryable drop metadata** — first-class external IDs, filterable on `GET /api/drops`.
- **Patterns** — pluggable file-based templates for recurring drop kinds.
- **`POST /mcp`** — the same bearer token as the HTTP API, for agents that speak that door.

A visitor finds the protocol at `/api/onboard`. The landing has one prompt that names that URL.

## Positioning (the framing the page must honor)

**htmlbin is a general-purpose, agent-first HTML hosting tool.** Initial product-market fit lives with developers. Long-term it should welcome anyone sharing work or ideas online.

**CI is one example use case, not the central pitch.** The landing must read as developer-first without becoming CI-only.

## Hard rules preserved (from CLAUDE.md)

1. One primary thing to copy. The hero's prompt slab is one payload and one button, labeled `Copy the prompt`.
2. No new auth surface. No signup, login UI, dashboard, or account page added.
3. Don't over-index on Cloudflare. The new copy doesn't name Cloudflare.
4. Aesthetic stays in DESIGN.md. No new color, no new font, no new shadow vocabulary.
5. Don't introduce new keywords. "Drop" stays casual English; we don't invent a category.
6. Single source of truth for styles (`src/styles.ts`).
7. Never push direct to main. This change ships through a PR + Cloudflare preview URL + user approval + merge → wrangler deploy.

## What the page is

- Nav: Docs, Patterns, GitHub, and one solid button, `Read the protocol`, linking to `/api/onboard`.
- One dark prompt slab. The visible text and the clipboard payload are the same string. The host comes from `PUBLIC_URL`.
- No traffic-light dots. No second pane. No install command in the header.
- App chrome (`/verify`, the viewer) keeps the live pill and `/api/onboard`. Both stay visible on a narrow screen.

### Capability notes (HTTP, not a second surface)

These are API facts the prompt can point at. They are not a terminal section on the landing.

#### Versions

`PUT /api/drops/<slug>` mints a new version. The public URL stays the same. Pin a past one with `?v=N`.

#### Tags and queries

`metadata` is a flat string map on create, replace, and patch. List with `GET /api/drops?metadata.<key>=<value>`.

#### Patterns

Official starters live at `/.well-known/patterns/`. Project-local files in `./.htmlbin/patterns/` win.

#### Passcodes

`POST /api/drops/<slug>/passcode` sets a share gate. An empty string clears it. The HTML in storage stays plaintext.

### Examples list with a `kind` column

The examples list keeps its mono shape and adds a third column: a small right-aligned uppercase `kind` label.

- Grid: `13ch 1fr 14ch`, mono throughout, 13px (slug + caption), 10.5px (kind) with `letter-spacing: 0.06em`.
- Whole row remains a single `<a>` — hovering anywhere turns the slug, caption, and kind all red.
- Mobile (`<600px`): kind column hidden, grid collapses to `11ch 1fr`.

**Five seed entries:**

| slug | caption | kind |
| --- | --- | --- |
| `/p/gDMy7Vb` | how htmlbin works — an animated explainer | EXPLAINER |
| `/p/1Wyf23j` | cross-platform gstack — pr #1111 deep dive | PR WRITEUP |
| `/p/ztx4J9P` | workers nav — three redesigns side by side | DESIGN |
| `/p/i2taphP` | google logo — animation playground | PLAYFUL |
| `/p/HYmZ6DjCM` | plan: queryable drop metadata | PLAN / SPEC |

The `EXAMPLES` array in `src/views/landing.ts` carries a `kind` field per item.

### Footer

One mono strip. Do not repeat the public host in the footer; the address bar already shows it.

```
— htmlbin             agent-card · /api/onboard · github
```

## Out of scope

- Account/dashboard/login UI (Hard Rule #4).
- A second prompt pane, an install pill, or a terminal section.
- New illustrations, animations, or images. The page remains type+code+rule based.

## Verification

- **PR preview:** GitHub Actions runs `wrangler versions upload`; user tests against the posted Cloudflare preview URL before merge.
- **Landing:** one prompt, one copy button, nav button opens `/api/onboard`. No install command in the HTML.
- **Type check:** `npm run typecheck`.
- **E2E:** `npm run test:e2e`.
