# Pokémon Price Predictor — AI Pair-Programming Guide

Read this file in full before making any change. It is the shared contract
between two AI coding partners (Claude Code on the owner's Mac, Perplexity
Computer in the cloud sandbox) so the project stays coherent regardless of
who edited last.

If a rule here conflicts with a one-off user instruction in chat, the chat
wins for that turn — but propose updating this file so the convention sticks.

---

## Project overview

A single-page Pokémon TCG card valuation and collection app, GBP-first, with
an EN ↔ JP toggle. Built as a static site (HTML + vanilla JS + CSS, no
bundler) deployed to GitHub Pages. A Cloudflare Worker provides live
marketplace search, cross-device sync, and a Model Context Protocol server
for external AI assistants.

The owner: **simontariq** (`simontariq@me.com`), based in **GB / Europe/London**,
budget-conscious, advanced JS/Node developer, deep Pokémon TCG knowledge.

---

## Repos & deploy targets

| Asset | Location | How it deploys |
|---|---|---|
| Web app source | `github.com/simont90/pokemon-price-predictor` | Push to `main` → GitHub Pages auto-publishes |
| Live URL | `https://simont90.github.io/pokemon-price-predictor/` | Cache-busted via `?v=<buster>` querystring |
| Cloudflare Worker source | This repo: `worker-paste-this.js` + `wrangler.toml` | Deployed via `npx wrangler deploy` from repo root. Cloudflare removed the dashboard inline editor. |
| Worker live URL | `https://pokemon-marketplace.simontariq.workers.dev` | Routes: `/search`, `/sync`, `/mcp`, `/health` |
| KV namespace | Cloudflare → `pokemon-sync`, bound to worker as `SYNC_KV` (id: `6488eeadb6924bab9e71c36627c1658a`) | Holds per-user snapshots keyed `sync:<pair-code>` |

---

## File map (repo root)

```
index.html              # All UI scaffolding. Bumps cache buster in two places.
app.js                  # 10k+ lines, monolithic. All app logic, sync, MCP-irrelevant.
style.css               # Single stylesheet, ~5k lines.
data/cards-db.js        # 26k+ Pokémon cards (EN + JP), static.
data/sets-db.js         # Set metadata (release date, pack counts, etc.).
data/pokedex-db.js      # National Pokédex: normalised species name (EN + JP) → dex number.
worker-paste-this.js    # Latest Cloudflare Worker source — deploy via `npx wrangler deploy`.
wrangler.toml           # Wrangler config: worker name, KV binding. Do not store secrets here.
CLAUDE.md               # This file.
```

---

## Branching & push convention

- **Default branch:** `main` (GitHub Pages publishes from here).
- Perplexity Computer's sandbox checkout uses local branch `main_tmp` and
  pushes with `git push origin main_tmp:main`. Claude Code on the Mac
  should work directly on `main` (clean local checkout).
- **Always `git pull origin main` before starting a session.** The other AI
  may have committed since you last saw the tree.
- **Always commit + push after a successful edit.** Don't leave uncommitted
  work in either sandbox. The next session's first move is always `git
  pull`, so anything not on `origin/main` is invisible.
- Commit messages: imperative mood, scope-prefixed (`Marketplace Scan:
  fix...`, `Hold Strategy: add...`, `Sync: ...`).
- Push auth:
  - Claude Code → owner's GitHub credentials (set up once with `gh auth login`).
  - Perplexity Computer → `gh auth setup-git` + `api_credentials=["github"]`.

---

## Editing rules

1. **Pull first, always.** `git pull --rebase origin main` before the first edit of a session.
2. **One AI in a file at a time.** If you suspect the other AI is mid-flight
   (uncommitted local work elsewhere), don't start parallel edits on the
   same file. Just ask the owner. The owner is the synchroniser.
3. **Never rewrite app.js wholesale.** Surgical edits only. Always `grep` /
   read before edit. The file is large and monolithic by design — splitting
   it into modules has been explicitly deferred.
4. **Bump the cache buster on every push that changes `app.js`, `style.css`,
   or `index.html`.** Two places in `index.html`:
   - `<link rel="stylesheet" href="style.css?v=<buster>">`
   - `<script src="app.js?v=<buster>"></script>`
   The buster is a date prefix + alpha suffix, e.g. `20260617a`. Increment
   the suffix monotonically (`a → b → c → ...`). Skipping a letter is
   acceptable; going backwards is not.
5. **Vocabulary: never use "scrape" / "scraping" / "crawl" / "crawling".**
   Use "collect", "fetch", "gather", "read", "browse" instead. Applies to
   commit messages, comments, UI strings, and chat responses.
6. **Don't introduce build steps.** No bundler, no transpiler, no
   TypeScript, no React. Vanilla ES2022+ in `app.js`. The site must work
   when served as static files.
7. **Static server for local dev:** `python3 -m http.server 3000` from the
   project directory. Visit `http://127.0.0.1:3000/?v=<current-buster>`.
8. **All money is GBP-first.** USD is shown as a secondary tag. Prefer
   `fmtGBP()` / `usdToGbp()` helpers already in `app.js`.

---

## Worker editing rules

The worker is a single file: `worker-paste-this.js` in this repo. To change it:

1. Edit `worker-paste-this.js`.
2. Commit + push to GitHub (so the next session sees the latest).
3. Deploy: `npx wrangler deploy` from the repo root (wrangler.toml is checked in).
   - Wrangler is authenticated via OAuth; credentials in `~/.wrangler/config/default.toml`.
   - The Cloudflare dashboard no longer has an inline editor — wrangler is the only deploy path.
4. Verify after deploy: `curl https://pokemon-marketplace.simontariq.workers.dev/health` returns `ok`.

**Worker routes (do not break these):**

- `GET /health` → `ok` (used by uptime probes).
- `GET /search?q=&max=&fx=&fxEur=&grade=` → fanned-out eBay UK / eBay US /
  Cardmarket search, returns ranked deals. Cached 5 min at the edge.
- `GET /sync?key=` → returns stored snapshot JSON or `{data:null,ts:0}`.
- `PUT /sync?key=` → stores raw body (must be valid JSON, ≤ 5 MB).
- `DELETE /sync?key=` → deletes stored snapshot.
- `POST /mcp` → JSON-RPC 2.0 MCP server. Requires `Authorization: Bearer <pair-code>`.
- `GET /mcp` → returns server info JSON (not an SSE stream).

**Worker secrets (set in Cloudflare dashboard, not in this repo):**

- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` — eBay Browse API.
- `SYNC_KV` — binding to the `pokemon-sync` KV namespace.

---

## MCP server

The worker exposes 7 read-only tools at `POST /mcp` for external AI clients
(Claude.ai, Claude Desktop, Claude iOS). Auth is the same pair code used for
cross-device sync. Tool definitions live in the `MCP_TOOLS` constant in
`worker-paste-this.js` — when adding or renaming a tool, update both the
definition and the `dispatchTool` switch.

Current tools: `get_collection`, `get_wishlist`, `get_watchlist`,
`get_collection_stats`, `find_card_in_collection`, `get_hold_overrides`,
`search_marketplace_deals`.

When adding tools that need write access to the synced blob, do a
read-modify-write through `loadSnapshot()` and `env.SYNC_KV.put(...)`. Keep
all writes idempotent — clients may retry.

---

## Local storage keys (the "sync surface")

Everything prefixed `pkm-` is synced across devices via `/sync` PUT/GET.
Anything new that the user should see on other devices must use a `pkm-`
prefix. Anything device-local (caches, last-seen timestamps) should NOT
use the prefix.

Known synced keys:
- `pkm-portfolio` — owned cards.
- `pkm-wishlist` — wishlist.
- `pkm-watchlist-v1` — live-tracked listings.
- `pkm-compare` — comparison shelf.
- `pkm-mkt-reassignments` / `pkm-mkt-dismissals` — marketplace scan adjustments.
- `pkm-counterpart-overrides-v1` — manual EN/JP card mapping.
- `pkm-pc-overrides-v1` — PriceCharting URL overrides per card.
- `pkm-user-cards-v1` / `pkm-card-overrides-v1` — user-edited card metadata.
- `pkm-hold-overrides` — per-card grade-specific market price overrides.
- `pkm-acquisitions-v1` — how each card was obtained (pack pull vs single buy, cost basis).
- `pkm-budget-max-gbp` — max per card budget slider value (GBP, or 99999 = no limit).
- `pkm-ace-prices-v1` — per-card ACE Grading sold prices by grade (10/9/8/7), keyed by card ID.
- `pkm-binder-sort-v1` — binder page sort order (`dex` = National Pokédex, `prio` = priority, `az` = alphabetical).
- `pkm-vintage-v1` — Vintage page targets: `{ targets: { cardId: { grade, owned } } }` (WOTC-era PSA hunt list).
- `pkm-taste-recos-v1` — taste engine auto-adds: `{ cardId: { score, ts } }` — searched cards scoring ≥70 that joined the home recommendations.

Excluded from sync (device-local):
- `pkm-sync-prefs-v1`, `pkm-sync-pair-code`, `pkm-sync-endpoint`, `pkm-sync-meta`,
  `pkm-sync-last-hash` — the sync system's own state.
- `pkm-price-sync-last-v1` — refresh timestamp.

The `localStorage.setItem` override in `app.js` auto-pushes any `pkm-*` write
on a 4 s debounce. New synced keys "just work" as long as they follow the prefix.

---

## Owner preferences

- **Locale:** GB, currency GBP, date format DD/MM/YYYY.
- **Languages:** English primary, fluent Japanese — Japanese set/card names
  in the UI are expected and welcomed (don't romanise them away).
- **Tone:** concise, no exclamation points, no emojis unless requested. The
  owner is technical; skip beginner explanations.
- **Visual style:** dark mode default, accent colour `--accent: #e8b634` (yellow),
  Space Grotesk + JetBrains Mono fonts.
- **Mobile-first:** the owner runs the app on iPhone, iPad, and Mac mini M4.
  Test responsive at 390 × 844 (iPhone) as well as 1440 × 1100 (desktop).

---

## QA before push

For visual changes:
1. Reload the site in the local browser at the bumped cache buster.
2. For dashboard / multi-section changes, screenshot at desktop AND mobile.
3. Check no console errors (Cmd-Opt-J in Chrome).

For worker changes:
1. Add a node smoke test (see `pokemon-marketplace-worker/test-mcp.mjs` for
   the pattern).
2. Run it locally with `node test-*.mjs` and ensure all assertions pass.
3. After dashboard paste, `curl /health` to confirm deploy worked.

---

## Common pitfalls (do not repeat)

- **Worker secrets** (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`) are set in the
  Cloudflare dashboard under Workers → pokemon-marketplace → Settings → Variables.
  Do not put them in `wrangler.toml` or commit them.
- **Don't fetch a card image from `pokemontcg.io` without graceful
  fallback.** Many JP cards have no image; show a placeholder.
- **Don't store API keys in the client.** All third-party API calls go
  through the worker so secrets stay on the worker side.
- **Don't change pair-code format** without updating both the worker
  regex and the client generator. Current contract: 16–64 chars of `[A-Za-z0-9_-]`.
- **Don't ship without bumping the cache buster.** GitHub Pages caches
  aggressively; users will see stale code for hours otherwise.

---

## How to find what changed recently

```bash
git log --oneline -20                          # recent commits
git log --stat -1                              # last commit's files
grep -n "TODO\|FIXME\|XXX" app.js              # outstanding notes
```

---

## Contact

If something in this file is wrong or out of date, update it in the same
commit as the code change. The owner reviews `CLAUDE.md` deltas in PR /
commit diffs.
