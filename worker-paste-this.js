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

// ---- Main handler ----
async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
  if (url.pathname === '/health') return new Response('ok', { headers: corsHeaders(request) });
  if (url.pathname === '/sync') return handleSync(request, env, url);
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
