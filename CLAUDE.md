# Pokémon Price Predictor — AI Pair-Programming Guide

Read this file in full before making any change. It is the shared contract
between every environment this project is edited from, so the project stays
coherent regardless of who edited last.

**Primary environment: Claude Code on the owner's Mac**, working in a local
clone. Cloud sessions (Claude Code on the web / Codespaces) are secondary —
useful away from the Mac, but they cannot drive a browser, reach the local
network, or deploy the worker without re-authenticating.

`origin/main` on GitHub is the single source of truth. Nothing exists until
it is pushed there — a local checkout has been lost before, and everything
survived precisely because it had been pushed.

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

- **Default branch:** `main` (GitHub Pages publishes from here). Work directly
  on `main` from any environment.
- **Always `git pull origin main` before starting a session.** Another
  environment may have committed since you last saw the tree. Two sessions
  have collided on this repo before; pulling first is what prevents it.
- **Always commit + push after a successful edit.** Never leave work
  uncommitted in a cloud container — those are reclaimed without warning.
  The next session's first move is always `git pull`, so anything not on
  `origin/main` is invisible.
- If a push is rejected because the remote moved, `git pull --rebase origin
  main`, resolve, re-verify, then push. Cache busters collide often here —
  take the higher value and bump past it, never backwards.
- Commit messages: imperative mood, scope-prefixed (`Marketplace Scan:
  fix...`, `Hold Strategy: add...`, `Sync: ...`).
- Push auth:
  - Mac → owner's GitHub credentials (set up once with `gh auth login`).
  - Codespaces / cloud → already authenticated via the environment's token.

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
   On the Mac this drives the live preview and real browser testing; in a
   cloud container it only serves headless checks — card images
   (pokemontcg.io) and live price APIs are blocked there, so art renders
   blank and prices fall back to the static database. Layout, behaviour and
   console errors are still accurate.
8. **All money is GBP-first.** USD is shown as a secondary tag. Prefer
   `fmtGBP()` / `usdToGbp()` helpers already in `app.js`.

---

## Worker editing rules

The worker is a single file: `worker-paste-this.js` in this repo. To change it:

1. Edit `worker-paste-this.js`.
2. Commit + push to GitHub (so the next session sees the latest).
3. Deploy: `npx wrangler deploy` from the repo root (wrangler.toml is checked in).
   - Mac: authenticated via OAuth (`npx wrangler login`), credentials in
     `~/.wrangler/config/default.toml`. Re-run the login after a fresh clone.
   - Codespaces: a `CLOUDFLARE_API_TOKEN` env var is already set, so
     `wrangler login` errors and is unnecessary — just deploy.
   - The Cloudflare dashboard no longer has an inline editor — wrangler is the only deploy path.
   - **Only the Mac and Codespaces can deploy.** Claude Code on the web has no
     Cloudflare credentials and cannot reach `*.workers.dev`; it can write and
     push worker code but never verify it live.
4. Verify after deploy: `curl https://pokemon-marketplace.simontariq.workers.dev/health` returns `ok`.

**Worker routes (do not break these):**

- `GET /health` → `ok` (used by uptime probes).
- `GET /search?q=&max=&fx=&fxEur=&grade=` → fanned-out eBay UK / eBay US /
  Cardmarket search, returns ranked deals. Cached 5 min at the edge.
- `GET /collectr?set=&number=&variant=` → resolves the card automatically and
  returns Collectr prices split by print, PSA grade prices, dated history and
  30/90-day trend. `productId=` / `url=` skip resolution. Credit-metered — see
  `COLLECTR_TOKEN`. **Do not use `?q=`**: the wrapper's `search_products`
  endpoint is broken — it returns the same fabricated 12 rows for any query
  (verified with a control query), ignores `limit`, and every `image_url` is a
  YouTube link. Product ids must come from a pasted Collectr URL.
  - `grade_id` 1–11 = PSA 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10 in order; 52 =
    ungraded. Ids above 11 are other grading companies and are ignored.
    Established by matching against PriceCharting's labelled rows on Fossil
    Gengar #5 — id 3 = $157.50 against "Grade 2" $157.50, exact.
  - Prices are USD, not GBP. There is no currency field; the exact cent match
    with PriceCharting settles it.
  - `product_sub_type` is the print ("1st Edition Holofoil"), not the grade.
  - Resolution is free and does not touch the metered API: a category index
    page gives set name → groupId, and the set page carries the embedded
    catalogue keyed by card number. Both cached in KV for 30 days. The set page
    server-renders only its first 15 cards, which in a WOTC set is the holo
    run; anything past that needs a pasted product link.
  - Collectr splits Base Set into two groups — "Base Set (Unlimited)" (604) and
    "Base Set (1st Edition & Shadowless)" (1663) — so the selected print picks
    the group.
  - **Collectr is the primary price source; PriceCharting is the backup.** It
    leads on the raw price (the Live Market Price headline and
    `getCurrentPrice`) and on every PSA grade it carries. Order per grade is:
    your own override, then Collectr, then PriceCharting, then the ratio
    estimate. Tiles priced from Collectr are marked "via Collectr".
  - Placeholder prices are stripped in the worker before the client sees them:
    a grade priced below 60% of *both* its neighbours is a trough, not a price.
    Unlimited Fossil Gengar quotes PSA 9 at $99.99 between $341 and $839.
    Testing against both sides matters — a ladder that merely falls is often
    real at the bottom, where the same card has PSA 1 at $372 against PSA 2 at
    $157. Dropped values are listed in the response's `suspect` array.
  - `?refresh=1` bypasses the 24h price cache. Costs 2 credits.
- `GET /sync?key=` → returns stored snapshot JSON or `{data:null,ts:0}`.
- `PUT /sync?key=` → stores raw body (must be valid JSON, ≤ 5 MB).
- `DELETE /sync?key=` → deletes stored snapshot.
- `POST /mcp` → JSON-RPC 2.0 MCP server. Requires `Authorization: Bearer <pair-code>`.
- `GET /mcp` → returns server info JSON (not an SSE stream).

**Worker secrets — set with `npx wrangler secret put <NAME>`, never in this repo:**

- `ANTHROPIC_API_KEY` — server-side Claude calls (`/ai/chat`, `/ai/query`).
- `PSA_API_TOKEN` — PSA public API for `/cert`. Cert verification only: the
  public tier returns no population or pricing, and allows ~100 calls a day,
  so `/cert` caches every result permanently.
- `COLLECTR_TOKEN` — Collectr price history via the parse.bot REST wrapper
  (`X-API-Key`). Metered by credit: 1 per search, 2 per detail fetch, against a
  monthly allowance — so `/collectr` caches a card's product id forever and its
  prices for 24h. `COLLECTR_API_URL` optionally overrides the wrapper base URL
  if the endpoint is re-published.
- `POKEMONTCG_API_KEY` — optional. pokemontcg.io rate-limits Cloudflare's
  shared egress IPs hard on the anonymous tier; a free key from
  `dev.pokemontcg.io` removes that. `_pcgFetch` uses it when present.

**Other worker secrets (set in Cloudflare dashboard, not in this repo):**

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
- `pkm-psa-links-v1` — pinned PSA reference page per card: `{ cardId: { url, ts } }`.

Excluded from sync (device-local):
- `pkm-sync-prefs-v1`, `pkm-sync-pair-code`, `pkm-sync-endpoint`, `pkm-sync-meta`,
  `pkm-sync-last-hash` — the sync system's own state.
- `pkm-price-sync-last-v1` — refresh timestamp.
- `fx-rates-cache-v1` — 12h currency-rate cache. Deliberately unprefixed:
  rates are global, not user data. `init()` applies it synchronously and
  refreshes in the background — do **not** make startup await the FX API,
  it used to block the whole UI behind that request.

**Population data lives server-side, not here.** D1 `pop_history` is the
durable store (one dated reading per card per day, written by `PUT /pop` and
the daily cron); KV `pop:<cardId>` is only a 7-day cache. Read growth via
`GET /pop-history?cardId=`. There is no automated pop source —
`_fetchPikawizPop` is a stub returning `null`; pop arrives via the paste flow
on the card view.

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

## Card valuation methodology

Apply this framework any time the app evaluates whether a specific card/grade
is a good deal. It governs Hold Strategy AI analysis, Vintage grade picks,
and any "value" label surfaced in the UI.

### 1. Liquidity gates everything else

Before trusting any market-value figure, check two numbers at the target grade:
- **Population** (PSA pop report)
- **Sales count** in the trailing 90 days

Thresholds:
- **Thick data** (15+ sales/quarter, pop typically 700+): trust the aggregator average. Below-average pricing is a real signal.
- **Thin data** (under ~5 sales/quarter, or pop under ~200–300 at that grade): the mark is a rough guide only. A "value" built on 2–3 sales can be an outlier either direction. Widen out to the full sold range before drawing conclusions.

Never present a single "market value" number without stating which bucket it falls in.

### 2. Use the range, not the point estimate

Every aggregator value is roughly the midpoint of a spread. Pull low / average / high
from recent sales.
- Paying near the average = fair, not a deal.
- Paying in the bottom third of the observed range = a genuine deal.
- A price "below the mark" that's still above the low of the range isn't automatically cheap.

### 3. Check direction before treating "below mark" as good

A trailing average lags real-time price action.
- Below mark + flat/rising trend = real discount.
- Below mark + falling trend (negative % over 30–90 days) = the market catching down to where asks already are, not a bargain.
- Always surface the 30/90-day % change alongside any "below market" claim.

### 4. Grade-ladder check

Compare the % price step from the target grade to the grade above it, for the SAME card.
- Small step (e.g. under ~25%) → the lower grade is the value play, no reason to reach.
- Large step (50%+) → that's a real wall. Don't pay to cross it unless the higher grade is specifically the goal.

### 5. Mid-grade population dilution risk (grades 5–7 specifically)

Low pop in mid-grade vintage is often an artifact of low submission volume when the card
was cheap, not true scarcity — as prices rise, more raw copies get graded and land in
that band, diluting it. This is the biggest risk to any mid-grade thesis and it moves
*before* price does.
- Track population quarterly on anything held.
- Flag if pop at the target grade has grown meaningfully since purchase — that's an early warning, not a lagging indicator.

### 6. Card selection: signature card + budget-tier fit

- For any character, identify the **defining vintage appearance** — the card most associated with that Pokémon (e.g. Fossil 1st Ed Gengar 5/62). A low grade of a non-defining/filler card carries no character premium. A low grade of the defining card retains it.
- Flag characters with **no true vintage holo in the main WOTC sets** (Pikachu, Mew are known examples) — their vintage chases are promos/trophy cards, a different market (thin comps, higher counterfeit risk). Don't apply the same framework without a caveat.
- Flag when a character's entry price at the target grade band is an **order of magnitude off** the rest of a target list (e.g. 1st Ed Charizard vs. everything else at PSA 5–7). That's a signal to either substitute a cheaper print variant (Shadowless/Unlimited) or accept a different grade tier for that one card — not to silently force-fit it into the same budget.

### 7. Cross-grade optimizer — pick the smartest grade, not just judge one

Everything above evaluates a single grade. This step compares ALL grades of the same
card against each other to find where the smart money actually sits.

**Build the full curve.** For a candidate card, pull grades 1–10 (whatever has
population/sales data) and record per grade: pop, sales count (90d), avg/low/high sold,
30–90d trend, and a confidence label (thick/thin, from Section 1).

**Compute the step to the next grade up**, using average sold price:
- `step% = (avg[grade+1] - avg[grade]) / avg[grade]`
- Classify each step: **compressed** (<25%), **moderate** (25–50%), **wall** (50%+).

**Locate the walls.** Walk the curve from grade 10 down to grade 1. The first wall you
hit going down is the natural ceiling of "value" pricing — everything above it is paying
for the grade itself; everything at or just below it is paying mostly for the card.

**Candidate grades = the grade sitting directly below each wall**, filtered by:
- Confidence: thick data only. A cheap grade with 2 sales a year isn't a smart buy, it's an unverifiable one — flag but don't recommend it as the pick.
- Trend: exclude candidates on a falling trend unless the fall looks like it's bottoming against the grade below (check that grade's price hasn't also dropped).
- Budget: filter to the stated ceiling before ranking, not after.

**Rank survivors** by how close a realistic buy sits to the bottom of that grade's sold
range (Section 2), then by step size of the wall directly above them (bigger wall = more
value left on the table by not reaching one grade higher).

**Output format — always show the full curve, never just the winner:**

| Grade | Pop | Sales/90d | Avg | Range | Trend | Step to next | Confidence |
|---|---|---|---|---|---|---|---|

Then state the recommended grade(s) with the specific reasoning (which wall, what
confidence, what trend) — so the pick is auditable, not a black box. If two grades are
close calls, present both and say why, rather than forcing a single answer.

**Common outcome to expect:** the smart pick is very often NOT the cheapest grade
available. A pop-5000 PSA 3 might be cheap but sits on a compressed part of the curve
with no wall above it — no value being left behind by buying the 4 or 5 instead. The
best pick is the highest grade before a real price cliff, not the lowest price on the
sheet.

### 8. Trade / dealer-offer math

When evaluating a trade-in or dealer percentage (e.g. "80% of value"):
1. **Establish the base first, before the rate.** A dealer's own conservative estimate vs. an inflated aggregator mark changes the real outcome far more than the % does.
2. **Benchmark against a private sale net of fees** (~87% after ~13% marketplace fees) as the do-it-yourself baseline. The trade only wins if it beats that after accounting for any base-price haircut — otherwise it's convenience, not value.
3. On illiquid, thin-data cards specifically, trading away at a mark you believe is optimistic can beat a private sale — you're converting an uncertain number into guaranteed value. This is the one case where taking the mark at face value is correctly cautious rather than naive.

### Per-card checklist

For any card the tool evaluates, output:
1. Full grade curve (Section 7): pop, sales, avg/range, trend, confidence — per grade
2. Walls identified and the recommended grade(s) below them
3. Is this the character's defining vintage card? Does a true vintage holo exist at all?
4. Does the recommended grade's price fit the stated budget band, or does this card need a different set/print/grade to fit?
5. If evaluating a specific listing, its trade math (Section 8) if a trade is on the table

Don't collapse this into a single "good deal / bad deal" verdict — surface the curve and
let the confidence level (thick vs. thin data) at each grade determine how much weight
the recommendation should carry.

---

## Contact

If something in this file is wrong or out of date, update it in the same
commit as the code change. The owner reviews `CLAUDE.md` deltas in PR /
commit diffs.
