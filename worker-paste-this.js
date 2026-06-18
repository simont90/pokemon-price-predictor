/**
 * Pokémon Price Predictor — Marketplace Scanner Worker
 * =====================================================
 * A Cloudflare Worker that proxies live listing data from:
 *   • eBay UK + eBay US — via the official Browse API (OAuth client_credentials)
 *   • Cardmarket EU     — via lightweight HTML scraping (no public API exists)
 *
 * Endpoints
 * ---------
 *   GET /search?q=<query>&max=<fairValueGBP>&grade=<raw|7|8|9|10>&fx=<usdToGbp>
 *       → returns { ebay_uk: [...], ebay_us: [...], cardmarket: [...], deals: [...] }
 *       where `deals` is a merged, value-scored list (cheapest vs fair value first).
 *
 *   GET /health   → simple OK probe
 *
 *   GET    /sync?key=<syncKey>   → returns last-saved blob (or {data:null,ts:0})
 *   PUT    /sync?key=<syncKey>   → body stored as the blob for this key
 *   DELETE /sync?key=<syncKey>   → wipes the blob for this key
 *       Cross-device sync for collection / wishlist / reassignments etc.
 *       Backed by a KV namespace bound as `SYNC_KV`. If the binding is
 *       missing, sync endpoints return 503 so the client can show a setup hint.
 *
 * Secrets (set with `wrangler secret put`):
 *   EBAY_CLIENT_ID
 *   EBAY_CLIENT_SECRET
 *
 * KV bindings (set in Cloudflare dashboard → Worker → Settings → Variables
 * → KV Namespace Bindings):
 *   SYNC_KV  → bind to a KV namespace named e.g. `pokemon-sync`
 *
 *
 * CORS: open to https://simont90.github.io (and localhost for dev). Tighten in
 * production by editing ALLOWED_ORIGINS below.
 */

const ALLOWED_ORIGINS = [
  'https://simont90.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const CARDMARKET_SEARCH = 'https://www.cardmarket.com/en/Pokemon/Products/Search';

// ---- CORS helper ----
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ---- eBay OAuth client_credentials token (cached in memory per isolate) ----
let _ebayToken = null;
let _ebayTokenExp = 0;
async function getEbayToken(env) {
  const now = Date.now();
  if (_ebayToken && now < _ebayTokenExp - 60_000) return _ebayToken;
  const creds = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  if (!res.ok) throw new Error(`eBay token ${res.status}: ${await res.text()}`);
  const json = await res.json();
  _ebayToken = json.access_token;
  _ebayTokenExp = now + (json.expires_in * 1000);
  return _ebayToken;
}

// ---- eBay search (Browse API) ----
// We pull a wide page (up to 100 listings per marketplace) so the client-side
// risk band has the full catalog to rate — including premium overpriced ones.
// Without this, sort=price+limit=15 means popular cards only ever surface the
// 15 cheapest results, which for graded singles is mostly mislabeled junk.
async function searchEbay(env, marketplaceId, query, maxPrice, currency) {
  const token = await getEbayToken(env);
  const url = new URL(EBAY_BROWSE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '100');
  url.searchParams.set('sort', 'price'); // cheapest first
  // Filter: BIN only, price <= maxPrice in marketplace currency, condition: used or new
  const filters = [
    'buyingOptions:{FIXED_PRICE}',
    `price:[..${maxPrice.toFixed(2)}]`,
    `priceCurrency:${currency}`,
    'itemLocationCountry:' + (marketplaceId === 'EBAY_GB' ? 'GB' : 'US'),
  ];
  url.searchParams.set('filter', filters.join(','));

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    return { error: `eBay ${marketplaceId} ${res.status}`, detail: txt.slice(0, 200), items: [] };
  }
  const json = await res.json();
  const items = (json.itemSummaries || []).map(it => ({
    title: it.title,
    price: parseFloat(it.price?.value || '0'),
    currency: it.price?.currency || currency,
    image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || '',
    url: it.itemWebUrl,
    condition: it.condition || '',
    seller: it.seller?.username || '',
    location: it.itemLocation?.country || '',
    source: marketplaceId === 'EBAY_GB' ? 'eBay UK' : 'eBay US',
  }));
  return { items };
}

// ---- Cardmarket scrape (no public API; light HTML parse) ----
// We do a single GET against their search page and pull the product/price rows
// from the table. Cardmarket changes their HTML occasionally; if the structure
// shifts, update the regexes below.
async function searchCardmarket(query, maxEUR) {
  const url = new URL(CARDMARKET_SEARCH);
  url.searchParams.set('searchString', query);
  url.searchParams.set('idCategory', '6');
  url.searchParams.set('idGame', '6');
  url.searchParams.set('maxPrice', Math.round(maxEUR).toString());
  url.searchParams.set('sortBy', 'price_asc');

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; pokemon-price-predictor/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    return { error: `Cardmarket ${res.status}`, items: [] };
  }
  const html = await res.text();

  // Each product row is rendered inside a <div class="row no-gutters" ...>.
  // We extract: product name, link, lowest price ("from"), and image.
  const items = [];
  const productRegex = /<a[^>]+href="(\/en\/Pokemon\/Products\/Singles\/[^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<div class="col-price[^>]*>\s*<span[^>]*>([\d,\.]+)\s*&euro;/g;
  let m;
  while ((m = productRegex.exec(html)) !== null && items.length < 50) {
    const [, href, name, priceStr] = m;
    const price = parseFloat(priceStr.replace(/\./g, '').replace(',', '.'));
    if (!isNaN(price) && price > 0 && price <= maxEUR) {
      items.push({
        title: name.trim(),
        price,
        currency: 'EUR',
        image: '',
        url: `https://www.cardmarket.com${href}`,
        condition: '',
        seller: '',
        location: 'EU',
        source: 'Cardmarket',
      });
    }
  }
  return { items };
}

// ---- Score & merge ----
function scoreDeals(buckets, fairValueGBP, fxUsdToGbp, fxEurToGbp) {
  const all = [];
  for (const item of buckets) {
    let priceGBP = item.price;
    if (item.currency === 'USD') priceGBP = item.price * fxUsdToGbp;
    if (item.currency === 'EUR') priceGBP = item.price * fxEurToGbp;
    const spreadPct = fairValueGBP > 0 ? ((fairValueGBP - priceGBP) / fairValueGBP) * 100 : 0;
    let signal = 'WATCH';
    if (spreadPct >= 25) signal = 'STRONG VALUE';
    else if (spreadPct >= 10) signal = 'VALUE';
    else if (spreadPct >= 0) signal = 'FAIR';
    else signal = 'PREMIUM';
    all.push({ ...item, priceGBP, spreadPct, signal });
  }
  all.sort((a, b) => b.spreadPct - a.spreadPct);
  return all;
}

// ---- eBay listing image proxy ----
// Accepts ?url=<eBay listing URL>, fetches the listing page, and extracts
// all carousel image URLs from eBay's embedded JSON data and meta tags.
// No extra API permissions needed — reads the public listing page.
function _jsonResp(status, body, ch) {
  return new Response(JSON.stringify(body), { status, headers: { ...ch, 'Content-Type': 'application/json' } });
}

async function handleImgProxy(request, env, url) {
  const ch = corsHeaders(request);
  const rawUrl = (url.searchParams.get('url') || '').trim();
  if (!rawUrl) return _jsonResp(400, { error: 'Missing url param.' }, ch);

  const m = rawUrl.match(/\/itm\/(\d+)/);
  if (!m) return _jsonResp(400, { error: 'Paste a direct eBay listing URL (must contain /itm/{id}).' }, ch);
  const itemId = m[1];

  // Use Browse API item endpoint — same OAuth token as /search, no extra permissions.
  // Pipe chars in the item ID path segment must be percent-encoded.
  let token;
  try { token = await getEbayToken(env); } catch (e) {
    return _jsonResp(503, { error: `eBay auth failed: ${e.message}` }, ch);
  }

  const encodedId = `v1%7C${itemId}%7C0`;
  const hi = u => u.replace(/s-l\d+(\.\w+)$/, 's-l1600$1');

  for (const mktId of ['EBAY_GB', 'EBAY_US']) {
    let resp;
    try {
      resp = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodedId}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': mktId, 'Accept': 'application/json' },
      });
    } catch { continue; }
    if (!resp.ok) continue;
    const item = await resp.json();
    const images = [];
    if (item.image?.imageUrl) images.push(hi(item.image.imageUrl));
    for (const img of (item.additionalImages || [])) {
      if (img.imageUrl) images.push(hi(img.imageUrl));
    }
    if (!images.length) continue;
    return new Response(JSON.stringify({ images, title: item.title || '', itemId }), {
      headers: { ...ch, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  }
  return _jsonResp(404, { error: 'Listing not found or images unavailable.' }, ch);
}

// ---- AI card grading ----
// POST /grade-card — body: { imageUrl?: string } | { imageB64: string, mimeType: string }
// Requires ANTHROPIC_API_KEY secret in Cloudflare dashboard.
// Returns { centering, corners, edges, surface, verdict }
async function handleGradeCard(request, env) {
  const ch = corsHeaders(request);
  let body;
  try { body = await request.json(); } catch { return _jsonResp(400, { error: 'Invalid JSON body.' }, ch); }

  const { imageUrl, imageB64, mimeType = 'image/jpeg' } = body || {};
  if (!imageUrl && !imageB64) return _jsonResp(400, { error: 'Provide imageUrl or imageB64.' }, ch);
  if (!env.ANTHROPIC_API_KEY) return _jsonResp(503, { error: 'ANTHROPIC_API_KEY not configured in worker secrets.' }, ch);

  const imageContent = imageUrl
    ? { type: 'image', source: { type: 'url', url: imageUrl } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageB64 } };

  const prompt = `You are a PSA trading card grading expert. Analyse this Pokémon card image and score each criterion:

centering: 10=≤55/45, 8=up to 65/35, 6=up to 75/25, 4=worse
corners: 10=razor-sharp, 8=barely-visible wear, 6=slight rounding, 4=rounded/chipped
edges: 10=clean, 8=slight fraying, 6=visible nicks, 4=heavy chips
surface: 10=pristine, 8=faint scratches, 6=visible marks, 4=creases/staining

Then write one sentence (under 20 words) with a realistic best-case and worst-case PSA grade.

Reply with ONLY this JSON — no markdown, no extra text:
{"centering":10,"corners":8,"edges":10,"surface":8,"verdict":"Best case PSA 9, worst case PSA 7 — corners are the ceiling."}

Valid score values: 4, 6, 8, or 10 only.`;

  let claudeResp;
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: [imageContent, { type: 'text', text: prompt }] }],
      }),
    });
  } catch (e) {
    return _jsonResp(502, { error: `Claude API unreachable: ${e.message}` }, ch);
  }

  if (!claudeResp.ok) {
    const errTxt = await claudeResp.text().catch(() => '');
    return _jsonResp(502, { error: `Claude API error ${claudeResp.status}: ${errTxt.slice(0, 120)}` }, ch);
  }

  const result = await claudeResp.json();
  const raw = (result.content?.[0]?.text || '').trim();

  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch {}
  }
  if (!parsed) return _jsonResp(502, { error: 'Could not parse grading response.' }, ch);

  const valid = [4, 6, 8, 10];
  ['centering', 'corners', 'edges', 'surface'].forEach(k => {
    if (!valid.includes(parsed[k])) parsed[k] = 8;
  });

  return new Response(JSON.stringify(parsed), {
    headers: { ...ch, 'Content-Type': 'application/json' },
  });
}

// ---- Main handler ----
async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
  if (url.pathname === '/health') return new Response('ok', { headers: corsHeaders(request) });
  if (url.pathname === '/sync') return handleSync(request, env, url);
  if (url.pathname === '/mcp') return handleMcp(request, env, url);
  if (url.pathname === '/img-proxy') return handleImgProxy(request, env, url);
  if (url.pathname === '/grade-card' && request.method === 'POST') return handleGradeCard(request, env);
  if (url.pathname !== '/search') return new Response('Not found', { status: 404, headers: corsHeaders(request) });

  const q = url.searchParams.get('q') || '';
  const fairValueGBP = parseFloat(url.searchParams.get('max') || '0');
  const fxUsdToGbp = parseFloat(url.searchParams.get('fx') || '0.79');
  const fxEurToGbp = parseFloat(url.searchParams.get('fxEur') || '0.86');
  const grade = url.searchParams.get('grade') || 'raw';

  if (!q || !fairValueGBP) {
    return new Response(JSON.stringify({ error: 'Missing q or max param' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const maxUSD = fairValueGBP / fxUsdToGbp;
  const maxEUR = fairValueGBP / fxEurToGbp;

  // Fan out to all three sources in parallel; tolerate per-source failures.
  const [ukRes, usRes, cmRes] = await Promise.allSettled([
    searchEbay(env, 'EBAY_GB', q, fairValueGBP, 'GBP'),
    searchEbay(env, 'EBAY_US', q, maxUSD, 'USD'),
    searchCardmarket(q, maxEUR),
  ]);

  const ukItems = ukRes.status === 'fulfilled' ? (ukRes.value.items || []) : [];
  const usItems = usRes.status === 'fulfilled' ? (usRes.value.items || []) : [];
  const cmItems = cmRes.status === 'fulfilled' ? (cmRes.value.items || []) : [];
  const errors = [];
  if (ukRes.status === 'rejected') errors.push('ebay_uk:' + ukRes.reason?.message);
  else if (ukRes.value.error) errors.push('ebay_uk:' + ukRes.value.error);
  if (usRes.status === 'rejected') errors.push('ebay_us:' + usRes.reason?.message);
  else if (usRes.value.error) errors.push('ebay_us:' + usRes.value.error);
  if (cmRes.status === 'rejected') errors.push('cardmarket:' + cmRes.reason?.message);
  else if (cmRes.value.error) errors.push('cardmarket:' + cmRes.value.error);

  const deals = scoreDeals([...ukItems, ...usItems, ...cmItems], fairValueGBP, fxUsdToGbp, fxEurToGbp);

  return new Response(JSON.stringify({
    query: q, grade, fairValueGBP, fxUsdToGbp, fxEurToGbp,
    counts: { ebay_uk: ukItems.length, ebay_us: usItems.length, cardmarket: cmItems.length },
    errors,
    deals: deals.slice(0, 200),
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300', // 5 min CDN cache
      ...corsHeaders(request),
    },
  });
}

// ---- Cross-device sync (KV-backed) ----
// The client picks a long random sync key once, saves it on each of their
// devices, and the worker just stores+returns whatever blob the client pushes.
// We don't inspect the payload — it's an opaque snapshot of localStorage. Cap
// the size at 5 MB so a corrupted client can't blow the KV value limit (25 MB).
async function handleSync(request, env, url) {
  const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders(request) };
  if (!env.SYNC_KV) {
    return new Response(JSON.stringify({
      error: 'Sync not configured',
      detail: 'Bind a KV namespace named SYNC_KV in the worker settings, then redeploy.',
    }), { status: 503, headers: jsonHeaders });
  }
  const key = url.searchParams.get('key') || '';
  // Sync keys are 16-64 chars of URL-safe base64. Anything else is rejected so a
  // typo or empty key can't accidentally wipe / overwrite real data.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
    return new Response(JSON.stringify({
      error: 'Invalid sync key',
      detail: 'Must be 16-64 characters of letters, digits, underscore, or hyphen.',
    }), { status: 400, headers: jsonHeaders });
  }
  const kvKey = `sync:${key}`;

  if (request.method === 'GET') {
    const stored = await env.SYNC_KV.get(kvKey);
    if (!stored) return new Response(JSON.stringify({ data: null, ts: 0 }), { headers: jsonHeaders });
    return new Response(stored, { headers: jsonHeaders });
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 5 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Payload too large', limitBytes: 5 * 1024 * 1024 }), {
        status: 413, headers: jsonHeaders,
      });
    }
    // Validate JSON shape — must be an object so a future migration can read it.
    try { JSON.parse(body); }
    catch (e) {
      return new Response(JSON.stringify({ error: 'Body must be valid JSON' }), { status: 400, headers: jsonHeaders });
    }
    await env.SYNC_KV.put(kvKey, body);
    return new Response(JSON.stringify({ ok: true, ts: Date.now(), bytes: body.length }), { headers: jsonHeaders });
  }
  if (request.method === 'DELETE') {
    await env.SYNC_KV.delete(kvKey);
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: jsonHeaders });
}

// =========================================================================
// Remote MCP Server (Model Context Protocol over Streamable HTTP)
// =========================================================================
// Spec: https://modelcontextprotocol.io/specification/2025-03-26
//
// Transport: Streamable HTTP. Clients POST JSON-RPC 2.0 messages to /mcp and
// the server replies with a single JSON body (no SSE — we don't push events).
//
// Auth: Bearer token = the sync pair code the user already has on their
// devices. The token doubles as the data-scope key — KV row sync:<code>
// holds that user's full app snapshot. No accounts, no OAuth dance, no
// PII leaving the worker.
//
// Tools all read from the snapshot; only search_marketplace_deals reaches
// out to eBay/Cardmarket via the existing /search pipeline.
// =========================================================================

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MCP_SERVER_INFO = { name: 'pokemon-price-predictor', version: '1.0.0' };
const PAIR_CODE_REGEX = /^[A-Za-z0-9_-]{16,64}$/;

const MCP_TOOLS = [
  {
    name: 'get_collection',
    description: 'Return every card currently in the user\'s Pokémon portfolio (the "My Collection" list in the app). Each entry includes the card id, name, set, number, language, quantity, condition/grade, acquisition price (GBP), and any per-card notes. Use this when the user asks what they own, how big their collection is, or to look up specific holdings.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Cap the number of entries returned. Default: all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_wishlist',
    description: 'Return the cards the user has wishlisted (cards they want to buy but don\'t own yet). Use when the user asks about wishlist, watch-buys, or what they\'re hunting for.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_watchlist',
    description: 'Return cards on the user\'s marketplace watchlist (cards they are actively monitoring for deals). Different from the wishlist — watchlist is for live price-tracking, wishlist is aspirational.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_collection_stats',
    description: 'Return aggregate statistics for the user\'s collection: total unique cards, total quantity, total amount invested in GBP, count by language (EN vs JP), count by grade (raw vs PSA), and last-sync timestamp. Use for portfolio-level summaries.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_card_in_collection',
    description: 'Search the user\'s portfolio + wishlist + watchlist for cards matching a name, set, or card-number fragment. Case-insensitive substring match. Returns up to 50 entries showing which list each match is in. Use when the user asks "do I own X?" or "have I wishlisted Y?".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment, set code, or card number to match (e.g. "Charizard", "sv4", "212/172").' },
        lists: { type: 'array', items: { type: 'string', enum: ['portfolio', 'wishlist', 'watchlist'] }, description: 'Which lists to search. Default: all three.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_hold_overrides',
    description: 'Return the user\'s manual market-price overrides — per-card actual eBay clearing prices they entered to correct the model\'s fair-value estimate. Keyed by card id, with sub-keys raw / psa7 / psa8 / psa9 / psa10 holding GBP values. Use when reasoning about which cards the user thinks are mispriced.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_marketplace_deals',
    description: 'Search live eBay UK, eBay US, and Cardmarket for listings of a specific card under a given fair-value ceiling. Returns ranked deals with seller, price, currency, URL, and a deal score. Use when the user asks "any good deals on X right now?" or wants to find underpriced listings.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Card name + set/number to search for (e.g. "Charizard ex 199/165 MEW", "リザードンVSTAR SAR"). Be specific to avoid noise.' },
        fair_value_gbp: { type: 'number', minimum: 0.01, description: 'Fair-value ceiling in GBP. Listings under this are surfaced; listings above are still returned but marked above-market.' },
        grade: { type: 'string', enum: ['raw', 'psa7', 'psa8', 'psa9', 'psa10'], description: 'Condition you\'re shopping for. Default: raw.' },
      },
      required: ['query', 'fair_value_gbp'],
      additionalProperties: false,
    },
  },
];

function mcpJson(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

function mcpError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return mcpJson({ jsonrpc: '2.0', id: id ?? null, error: err });
}

function mcpResult(id, result) {
  return mcpJson({ jsonrpc: '2.0', id, result });
}

function extractBearer(request) {
  const h = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

async function loadSnapshot(env, pairCode) {
  if (!env.SYNC_KV) return { error: 'SYNC_KV not bound. Bind a KV namespace in the worker settings.' };
  if (!PAIR_CODE_REGEX.test(pairCode)) return { error: 'Invalid pair code format.' };
  const raw = await env.SYNC_KV.get(`sync:${pairCode}`);
  if (!raw) return { snap: null, empty: true };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { error: 'Stored snapshot is not valid JSON.' }; }
  return { snap: parsed, empty: false };
}

// The browser stores localStorage values as JSON-encoded strings inside the
// snapshot's `data` map. Parse on demand and tolerate parse errors so a
// single bad key can't break a tool call.
function snapKey(snap, key, fallback) {
  if (!snap || !snap.data || typeof snap.data[key] !== 'string') return fallback;
  try { return JSON.parse(snap.data[key]); }
  catch { return fallback; }
}

function asTextContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function asError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function dispatchTool(name, args, env, pairCode) {
  const { snap, empty, error } = await loadSnapshot(env, pairCode);
  if (error) return asError(error);
  if (empty && name !== 'search_marketplace_deals') {
    return asError('No data synced for this pair code yet. Open the app on any device and tap Connect & sync first.');
  }

  switch (name) {
    case 'get_collection': {
      const portfolio = snapKey(snap, 'pkm-portfolio', []);
      const list = Array.isArray(portfolio) ? portfolio : [];
      const limit = args && Number.isInteger(args.limit) ? args.limit : list.length;
      return asTextContent({ count: list.length, items: list.slice(0, limit) });
    }
    case 'get_wishlist': {
      const wishlist = snapKey(snap, 'pkm-wishlist', []);
      const list = Array.isArray(wishlist) ? wishlist : [];
      return asTextContent({ count: list.length, items: list });
    }
    case 'get_watchlist': {
      const watchlist = snapKey(snap, 'pkm-watchlist-v1', []);
      const list = Array.isArray(watchlist) ? watchlist : [];
      return asTextContent({ count: list.length, items: list });
    }
    case 'get_collection_stats': {
      const portfolio = snapKey(snap, 'pkm-portfolio', []);
      const list = Array.isArray(portfolio) ? portfolio : [];
      let totalQty = 0, totalSpentGBP = 0, en = 0, jp = 0, raw = 0, graded = 0;
      for (const c of list) {
        const qty = Number(c.qty || c.quantity || 1) || 1;
        const spent = Number(c.paidGBP ?? c.priceGBP ?? c.acquiredGBP ?? 0) || 0;
        totalQty += qty;
        totalSpentGBP += spent * qty;
        const lang = (c.lang || c.language || '').toString().toLowerCase();
        if (lang.startsWith('jp') || lang === 'japanese') jp += qty;
        else en += qty;
        const grade = (c.grade || c.condition || 'raw').toString().toLowerCase();
        if (grade === 'raw' || grade === 'ungraded' || grade === '') raw += qty;
        else graded += qty;
      }
      return asTextContent({
        unique_cards: list.length,
        total_quantity: totalQty,
        total_spent_gbp: +totalSpentGBP.toFixed(2),
        by_language: { english: en, japanese: jp },
        by_grade: { raw, graded },
        last_sync_ts: snap?.ts || 0,
        last_sync_iso: snap?.ts ? new Date(snap.ts).toISOString() : null,
        device_label: snap?.device || null,
      });
    }
    case 'find_card_in_collection': {
      const query = (args && args.query ? String(args.query) : '').trim().toLowerCase();
      if (!query) return asError('query is required.');
      const lists = (args && Array.isArray(args.lists) && args.lists.length)
        ? args.lists
        : ['portfolio', 'wishlist', 'watchlist'];
      const buckets = {
        portfolio: snapKey(snap, 'pkm-portfolio', []),
        wishlist: snapKey(snap, 'pkm-wishlist', []),
        watchlist: snapKey(snap, 'pkm-watchlist-v1', []),
      };
      const matches = [];
      for (const listName of lists) {
        const arr = Array.isArray(buckets[listName]) ? buckets[listName] : [];
        for (const item of arr) {
          const hay = [item.name, item.cardName, item.set, item.setCode, item.number, item.cardNumber, item.id, item.i]
            .filter(Boolean).join(' ').toLowerCase();
          if (hay.includes(query)) matches.push({ list: listName, item });
          if (matches.length >= 50) break;
        }
        if (matches.length >= 50) break;
      }
      return asTextContent({ query, match_count: matches.length, matches });
    }
    case 'get_hold_overrides': {
      const overrides = snapKey(snap, 'pkm-hold-overrides', {});
      return asTextContent({ count: Object.keys(overrides || {}).length, overrides });
    }
    case 'search_marketplace_deals': {
      const q = args && args.query ? String(args.query).trim() : '';
      const fv = args && Number(args.fair_value_gbp) > 0 ? Number(args.fair_value_gbp) : 0;
      if (!q || !fv) return asError('query and fair_value_gbp are both required.');
      const grade = args.grade || 'raw';
      const fxUsdToGbp = 0.79;
      const fxEurToGbp = 0.86;
      const maxUSD = fv / fxUsdToGbp;
      const maxEUR = fv / fxEurToGbp;
      const [ukRes, usRes, cmRes] = await Promise.allSettled([
        searchEbay(env, 'EBAY_GB', q, fv, 'GBP'),
        searchEbay(env, 'EBAY_US', q, maxUSD, 'USD'),
        searchCardmarket(q, maxEUR),
      ]);
      const ukItems = ukRes.status === 'fulfilled' ? (ukRes.value.items || []) : [];
      const usItems = usRes.status === 'fulfilled' ? (usRes.value.items || []) : [];
      const cmItems = cmRes.status === 'fulfilled' ? (cmRes.value.items || []) : [];
      const deals = scoreDeals([...ukItems, ...usItems, ...cmItems], fv, fxUsdToGbp, fxEurToGbp);
      return asTextContent({
        query: q, grade, fair_value_gbp: fv,
        counts: { ebay_uk: ukItems.length, ebay_us: usItems.length, cardmarket: cmItems.length },
        deals: deals.slice(0, 30),
      });
    }
    default:
      return asError(`Unknown tool: ${name}`);
  }
}

async function handleMcp(request, env, url) {
  const cors = corsHeaders(request);
  // CORS preflight always OK; bearer is enforced on POST.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: { ...cors, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, Accept' },
    });
  }
  if (request.method === 'GET') {
    // Some clients hit GET /mcp to discover — return server info, not an SSE stream.
    return new Response(JSON.stringify({
      server: MCP_SERVER_INFO,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: 'streamable-http',
      auth: 'Authorization: Bearer <pair-code>',
      note: 'POST JSON-RPC 2.0 messages to this same URL.',
    }, null, 2), { headers: { 'Content-Type': 'application/json', ...cors } });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  const pairCode = extractBearer(request);
  if (!pairCode) {
    return new Response(JSON.stringify({ error: 'Missing Authorization: Bearer <pair-code> header' }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer', ...cors },
    });
  }
  if (!PAIR_CODE_REGEX.test(pairCode)) {
    return new Response(JSON.stringify({ error: 'Pair code must be 16-64 chars of [A-Za-z0-9_-]' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  let msg;
  try { msg = await request.json(); }
  catch { return mcpError(null, -32700, 'Parse error: body is not valid JSON'); }

  // Batched requests — array of messages. Process serially, drop notifications.
  const messages = Array.isArray(msg) ? msg : [msg];
  const responses = [];
  for (const m of messages) {
    const isNotification = !m || !('id' in m) || m.id === null || m.id === undefined;
    if (!m || m.jsonrpc !== '2.0' || !m.method) {
      if (!isNotification) {
        responses.push({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      }
      continue;
    }

    switch (m.method) {
      case 'initialize': {
        responses.push({
          jsonrpc: '2.0', id: m.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            instructions: 'Tools read the Pokémon collection synced to this pair code. Use search_marketplace_deals to scan eBay / Cardmarket for live listings.',
          },
        });
        break;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        // Notifications: no response.
        break;
      case 'ping':
        responses.push({ jsonrpc: '2.0', id: m.id, result: {} });
        break;
      case 'tools/list':
        responses.push({ jsonrpc: '2.0', id: m.id, result: { tools: MCP_TOOLS } });
        break;
      case 'tools/call': {
        const tname = m.params?.name;
        const targs = m.params?.arguments || {};
        if (!tname) {
          responses.push({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Missing tool name in params' } });
          break;
        }
        if (!MCP_TOOLS.find(t => t.name === tname)) {
          responses.push({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${tname}` } });
          break;
        }
        try {
          const result = await dispatchTool(tname, targs, env, pairCode);
          responses.push({ jsonrpc: '2.0', id: m.id, result });
        } catch (e) {
          responses.push({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: e.message || 'Tool execution failed' } });
        }
        break;
      }
      case 'resources/list':
      case 'prompts/list':
        // Not implemented; return empty arrays so probing clients don't error.
        responses.push({ jsonrpc: '2.0', id: m.id, result: m.method === 'resources/list' ? { resources: [] } : { prompts: [] } });
        break;
      default:
        if (!isNotification) {
          responses.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
        }
    }
  }

  // Pure-notification batch — spec says 202 Accepted with no body.
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: cors });
  }
  const body = Array.isArray(msg) ? responses : responses[0];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}


export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env); }
    catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
  },
};
