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
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ---- Auth helpers (JWT + PBKDF2 password hashing) ----
async function _jwtKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function _b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function _b64uDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function jwtSign(payload, secret, days = 120) {
  const key = await _jwtKey(secret);
  const enc = new TextEncoder();
  const h = _b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const b = _b64u(enc.encode(JSON.stringify({ ...payload, iat: now, exp: now + days * 86400 })));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${b}`));
  return `${h}.${b}.${_b64u(sig)}`;
}
async function jwtVerify(token, secret) {
  try {
    const [h, b, s] = token.split('.');
    if (!h || !b || !s) return null;
    const key = await _jwtKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, _b64uDec(s),
      new TextEncoder().encode(`${h}.${b}`));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(_b64uDec(b)));
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}
async function pwHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToU8(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) a[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return a;
}
async function authMiddleware(request, env) {
  if (!env.JWT_SECRET) return null;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return jwtVerify(auth.slice(7), env.JWT_SECRET);
}

// ---- Auth route handlers ----
async function handleAuthRegister(request, env) {
  const ch = corsHeaders(request);
  if (!env.SYNC_KV) return _jsonResp(503, { error: 'Storage not configured.' }, ch);
  if (!env.JWT_SECRET) return _jsonResp(503, { error: 'JWT_SECRET not set in worker secrets.' }, ch);
  let body; try { body = await request.json(); } catch { return _jsonResp(400, { error: 'Invalid JSON.' }, ch); }
  const { username = '', password = '' } = body;
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username))
    return _jsonResp(400, { error: 'Username: 3–32 chars, letters/digits/._- only.' }, ch);
  if (password.length < 8)
    return _jsonResp(400, { error: 'Password must be at least 8 characters.' }, ch);
  const uKey = `auth:user:${username.toLowerCase()}`;
  if (await env.SYNC_KV.get(uKey)) return _jsonResp(409, { error: 'Username already taken.' }, ch);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await pwHash(password, salt);
  await env.SYNC_KV.put(uKey, JSON.stringify({ username, passwordHash: hash, salt: saltHex, createdAt: new Date().toISOString() }));
  const token = await jwtSign({ sub: username.toLowerCase() }, env.JWT_SECRET);
  return _jsonResp(200, { token, username, expiresAt: new Date(Date.now() + 120 * 86400000).toISOString() }, ch);
}

async function handleAuthLogin(request, env) {
  const ch = corsHeaders(request);
  if (!env.SYNC_KV) return _jsonResp(503, { error: 'Storage not configured.' }, ch);
  if (!env.JWT_SECRET) return _jsonResp(503, { error: 'JWT_SECRET not set in worker secrets.' }, ch);
  let body; try { body = await request.json(); } catch { return _jsonResp(400, { error: 'Invalid JSON.' }, ch); }
  const { username = '', password = '' } = body;
  const uKey = `auth:user:${username.toLowerCase()}`;
  const raw = await env.SYNC_KV.get(uKey);
  // Always hash (constant-time behaviour) before checking existence
  const salt = raw ? hexToU8(JSON.parse(raw).salt) : crypto.getRandomValues(new Uint8Array(16));
  const hash = await pwHash(password, salt);
  if (!raw || hash !== JSON.parse(raw).passwordHash)
    return _jsonResp(401, { error: 'Invalid username or password.' }, ch);
  const user = JSON.parse(raw);
  const token = await jwtSign({ sub: username.toLowerCase() }, env.JWT_SECRET);
  return _jsonResp(200, { token, username: user.username, expiresAt: new Date(Date.now() + 120 * 86400000).toISOString() }, ch);
}

async function handleUserSync(request, env) {
  const ch = corsHeaders(request);
  if (!env.SYNC_KV) return _jsonResp(503, { error: 'Storage not configured.' }, ch);
  const claims = await authMiddleware(request, env);
  if (!claims) return _jsonResp(401, { error: 'Unauthorised — sign in first.' }, ch);
  const kvKey = `user:data:${claims.sub}`;
  if (request.method === 'GET') {
    const stored = await env.SYNC_KV.get(kvKey);
    if (!stored) return _jsonResp(200, { data: null, ts: 0 }, ch);
    return new Response(stored, { headers: { ...ch, 'Content-Type': 'application/json' } });
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 5 * 1024 * 1024) return _jsonResp(413, { error: 'Payload too large (max 5 MB).' }, ch);
    try { JSON.parse(body); } catch { return _jsonResp(400, { error: 'Body must be valid JSON.' }, ch); }
    await env.SYNC_KV.put(kvKey, body);
    return _jsonResp(200, { ok: true, ts: Date.now(), bytes: body.length }, ch);
  }
  if (request.method === 'DELETE') {
    await env.SYNC_KV.delete(kvKey);
    return _jsonResp(200, { ok: true }, ch);
  }
  return _jsonResp(405, { error: 'Method not allowed.' }, ch);
}

async function handleDeleteAccount(request, env) {
  const ch = corsHeaders(request);
  const claims = await authMiddleware(request, env);
  if (!claims) return _jsonResp(401, { error: 'Unauthorised.' }, ch);
  await Promise.all([
    env.SYNC_KV?.delete(`auth:user:${claims.sub}`),
    env.SYNC_KV?.delete(`user:data:${claims.sub}`),
  ]);
  return _jsonResp(200, { ok: true }, ch);
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
    const price = item.price ? { value: item.price.value, currency: item.price.currency } : null;
    return new Response(JSON.stringify({ images, title: item.title || '', itemId, price }), {
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

  let { imageUrl, imageB64, mimeType = 'image/jpeg' } = body || {};
  if (!imageUrl && !imageB64) return _jsonResp(400, { error: 'Provide imageUrl or imageB64.' }, ch);
  if (!env.ANTHROPIC_API_KEY) return _jsonResp(503, { error: 'ANTHROPIC_API_KEY not configured in worker secrets.' }, ch);

  // Fetch image server-side and convert to base64 — avoids relying on Claude's API fetching
  // arbitrary CDN URLs which can fail for eBay images or other restricted hosts.
  if (imageUrl && !imageB64) {
    let imgResp;
    try {
      imgResp = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CardGrader/1.0)' },
      });
    } catch (e) {
      return _jsonResp(502, { error: `Could not fetch image: ${e.message}` }, ch);
    }
    if (!imgResp.ok) return _jsonResp(502, { error: `Image fetch failed: HTTP ${imgResp.status}` }, ch);
    mimeType = imgResp.headers.get('Content-Type')?.split(';')[0] || 'image/jpeg';
    const buf = await imgResp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    imageB64 = btoa(binary);
  }

  const imageContent = { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageB64 } };

  const prompt = `You are a PSA trading card grading expert assessing a Pokémon card photo taken by a private seller.

PHOTO CONTEXT: Most seller photos are taken with the card still in a penny sleeve or toploader, and from non-professional angles. This means:
- Sleeve glare, reflection, and plastic texture are NOT card defects — ignore them.
- You may not be able to fully see corner tips or edge detail — if visibility is poor, default to 8 (cautious) rather than assuming 10.
- Holo shimmer, rainbow pattern, and light bounce off foil are NOT surface scratches.

WHAT PSA ACTUALLY GRADES (focus here):

1. CENTERING — the single most objective factor. Compare left/right border widths and top/bottom border widths.
   PSA 10 = ≤55/45 on both axes (borders look visually even)
   PSA 9  = ≤60/40
   PSA 8  = ≤65/35
   PSA 7  = ≤70/30
   Score: 10=clearly centred, 8=slightly off, 6=noticeably off, 4=severely off

2. WHITENING — the #1 reason cards fail PSA 10. Look for white fibre or print showing through on corner tips and along edges, especially on dark-bordered cards. Even faint whitening on one corner caps at PSA 9.
   corners: 10=razor-sharp tips, zero whitening; 8=near-invisible micro-fraying at most; 6=visible whitening or rounding on one or more corners; 4=clear rounding or chipping
   edges: 10=all four edges clean with no white fibre; 8=barely detectable at one point; 6=visible whitening or nicks; 4=heavy damage

3. SURFACE — scratches and print defects only. Not reflections.
   10=no marks; 8=faint genuine scratches only under direct light; 6=clearly visible scratches or print lines; 4=creases, indentations, or staining

Grade conservatively: if you cannot confirm a feature is defect-free due to the photo angle or sleeve, score 8 not 10.

Write one sentence under 20 words identifying the primary grading risk (centering, whitening, or surface).

Reply with ONLY this JSON — no markdown, no extra text:
{"centering":10,"corners":8,"edges":10,"surface":10,"verdict":"Likely PSA 9 — faint corner whitening on top-right is the ceiling."}

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

// ---- AI chat proxy (Anthropic → OpenAI-compatible SSE) ----
async function handleAiChat(request, env) {
  const ch = corsHeaders(request);
  if (!env.ANTHROPIC_API_KEY) return _jsonResp(503, { error: 'ANTHROPIC_API_KEY not configured.' }, ch);

  let body;
  try { body = await request.json(); } catch { return _jsonResp(400, { error: 'Invalid JSON.' }, ch); }

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const systemMsg = msgs.find(m => m.role === 'system');
  const chatMsgs = msgs.filter(m => m.role !== 'system');
  if (!chatMsgs.length) return _jsonResp(400, { error: 'No messages.' }, ch);

  const upResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: Math.min(8192, Math.max(256, body.max_tokens || 1500)),
      stream: true,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: chatMsgs,
    }),
  });

  if (!upResp.ok) {
    const err = await upResp.text().catch(() => '');
    return _jsonResp(upResp.status, { error: `Anthropic error: ${err.slice(0, 200)}` }, ch);
  }

  // Transform Anthropic SSE → OpenAI-compatible SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = upResp.body.getReader();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          try {
            const j = JSON.parse(data);
            if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) {
              const chunk = JSON.stringify({ choices: [{ delta: { content: j.delta.text } }] });
              await writer.write(encoder.encode(`data: ${chunk}\n\n`));
            } else if (j.type === 'message_stop') {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
            }
          } catch {}
        }
      }
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: { ...ch, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
}

// ---- TCGPlayer price API ----
// Uses TCGPlayer's internal marketplace API (mpapi.tcgplayer.com) which returns
// JSON price data per printing type without requiring auth.
async function handleTcgPrice(request, url) {
  const ch = corsHeaders(request);
  const productId = (url.searchParams.get('productId') || '').trim();
  if (!productId || !/^\d+$/.test(productId)) return _jsonResp(400, { error: 'productId required (digits only)' }, ch);

  let data;
  try {
    const r = await fetch(`https://mpapi.tcgplayer.com/v2/product/${productId}/pricepoints`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.tcgplayer.com/',
        'Origin': 'https://www.tcgplayer.com',
      },
      cf: { cacheEverything: true, cacheTtl: 900 },
    });
    if (!r.ok) return _jsonResp(r.status, { error: `TCGPlayer API returned ${r.status}` }, ch);
    data = await r.json();
  } catch (e) {
    return _jsonResp(502, { error: `Fetch failed: ${e.message}` }, ch);
  }

  if (!Array.isArray(data) || data.length === 0) return _jsonResp(404, { error: 'No price data for this product' }, ch);

  // Pick the most relevant printing type; prefer foil/holo variants
  const PREF = ['holofoil', '1st edition holofoil', 'unlimited holofoil', 'foil', 'reverse holofoil', '1st edition normal', 'normal', 'unlimited'];
  const sorted = [...data].sort((a, b) => {
    const ai = PREF.indexOf((a.printingType || '').toLowerCase());
    const bi = PREF.indexOf((b.printingType || '').toLowerCase());
    const aRank = ai === -1 ? 99 : ai;
    const bRank = bi === -1 ? 99 : bi;
    if (aRank !== bRank) return aRank - bRank;
    return (b.marketPrice || 0) - (a.marketPrice || 0);
  });

  const pick = sorted[0];
  const market = pick.marketPrice || 0;
  const mid = pick.listedMedianPrice || 0;

  if (market <= 0 && mid <= 0) return _jsonResp(404, { error: 'All prices are zero for this product' }, ch);

  return _jsonResp(200, {
    market,
    low: 0,
    mid,
    high: 0,
    directLow: 0,
    printingType: pick.printingType,
    allPrices: data.map(p => ({ type: p.printingType, market: p.marketPrice, mid: p.listedMedianPrice })),
    source: 'tcgplayer-mpapi',
  }, ch);
}

// ---- OAuth 2.1 Authorization Server (for Claude.ai MCP integration) ----
// Implements Dynamic Client Registration (RFC 7591) + Authorization Code + PKCE.

function _oauthLoginPage(params, error = '') {
  const qs = new URLSearchParams(params).toString();
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorise — Pokémon Price Predictor</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.box{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:14px;padding:32px 28px;width:100%;max-width:360px}
h1{margin:0 0 4px;font-size:1.15rem;color:#e8b634}
p{margin:0 0 20px;font-size:0.83rem;color:#888;line-height:1.5}
label{font-size:0.78rem;color:#aaa;display:block;margin-bottom:4px;margin-top:12px}
input{width:100%;background:#111;border:1px solid #333;border-radius:8px;color:#eee;padding:10px 12px;font-size:0.95rem;outline:none}
input:focus{border-color:#e8b634}
button{width:100%;margin-top:20px;background:#e8b634;color:#111;border:none;border-radius:8px;padding:12px;font-size:0.95rem;font-weight:600;cursor:pointer}
.err{background:rgba(220,50,50,.15);border:1px solid rgba(220,50,50,.4);border-radius:8px;padding:10px 12px;margin-top:14px;font-size:0.83rem;color:#f88}
</style></head><body>
<div class="box">
  <h1>Pokémon Price Predictor</h1>
  <p>Claude is requesting read access to your collection. Sign in to authorise.</p>
  <form method="POST" action="/oauth/authorize?${qs}">
    <label for="u">Username</label>
    <input id="u" name="username" type="text" autocomplete="username" required autofocus>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Authorise Claude</button>
  </form>
  ${error ? `<div class="err">${error}</div>` : ''}
</div></body></html>`;
}

async function handleOAuthMeta(request, env, url) {
  const base = `${url.protocol}//${url.host}`;
  return new Response(JSON.stringify({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read'],
  }), { headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}

async function handleOAuthRegister(request, env) {
  const ch = corsHeaders(request);
  if (!env.SYNC_KV) return _jsonResp(503, { error: 'storage_error' }, ch);
  let body = {};
  try { body = await request.json(); } catch {}
  const clientId = crypto.randomUUID();
  const client = {
    client_id: clientId,
    redirect_uris: body.redirect_uris || [],
    client_name: body.client_name || '',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
  await env.SYNC_KV.put(`oauth:client:${clientId}`, JSON.stringify(client), { expirationTtl: 365 * 86400 });
  return new Response(JSON.stringify(client), { status: 201, headers: { 'Content-Type': 'application/json', ...ch } });
}

async function handleOAuthAuthorize(request, env, url) {
  if (!env.SYNC_KV) return new Response('Storage not configured', { status: 503 });
  const clientId = url.searchParams.get('client_id') || '';
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const state = url.searchParams.get('state') || '';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';
  const params = { client_id: clientId, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod, response_type: 'code' };

  if (clientId) {
    const clientRaw = await env.SYNC_KV.get(`oauth:client:${clientId}`);
    if (!clientRaw) return new Response('Unknown client_id', { status: 400 });
  }

  if (request.method === 'GET') {
    return new Response(_oauthLoginPage(params), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // POST — form submission
  let username = '', password = '';
  try { const fd = await request.formData(); username = fd.get('username') || ''; password = fd.get('password') || ''; }
  catch { return new Response('Bad request', { status: 400 }); }

  const uKey = `auth:user:${username.toLowerCase()}`;
  const userRaw = await env.SYNC_KV.get(uKey);
  const fail = () => new Response(_oauthLoginPage(params, 'Invalid username or password'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (!userRaw) return fail();
  const user = JSON.parse(userRaw);
  const hash = await pwHash(password, hexToU8(user.salt));
  if (hash !== user.passwordHash) return fail();

  const code = crypto.randomUUID();
  await env.SYNC_KV.put(`oauth:code:${code}`, JSON.stringify({ sub: username.toLowerCase(), clientId, redirectUri, codeChallenge, codeChallengeMethod }), { expirationTtl: 600 });

  const dest = new URL(redirectUri);
  dest.searchParams.set('code', code);
  if (state) dest.searchParams.set('state', state);
  return Response.redirect(dest.toString(), 302);
}

async function handleOAuthToken(request, env) {
  const ch = corsHeaders(request);
  if (!env.SYNC_KV) return _jsonResp(503, { error: 'storage_error' }, ch);
  if (!env.JWT_SECRET) return _jsonResp(503, { error: 'server_error' }, ch);

  let grantType, code, codeVerifier;
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const fd = await request.formData().catch(() => new FormData());
    grantType = fd.get('grant_type'); code = fd.get('code'); codeVerifier = fd.get('code_verifier');
  } else {
    const body = await request.json().catch(() => ({}));
    grantType = body.grant_type; code = body.code; codeVerifier = body.code_verifier;
  }

  if (grantType !== 'authorization_code') return _jsonResp(400, { error: 'unsupported_grant_type' }, ch);
  if (!code) return _jsonResp(400, { error: 'invalid_request', error_description: 'missing code' }, ch);

  const codeDataRaw = await env.SYNC_KV.get(`oauth:code:${code}`);
  if (!codeDataRaw) return _jsonResp(400, { error: 'invalid_grant' }, ch);
  await env.SYNC_KV.delete(`oauth:code:${code}`);
  const codeData = JSON.parse(codeDataRaw);

  if (codeData.codeChallenge) {
    if (!codeVerifier) return _jsonResp(400, { error: 'invalid_grant', error_description: 'code_verifier required' }, ch);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    if (_b64u(digest) !== codeData.codeChallenge) return _jsonResp(400, { error: 'invalid_grant' }, ch);
  }

  const accessToken = await jwtSign({ sub: codeData.sub }, env.JWT_SECRET, 120);
  return _jsonResp(200, { access_token: accessToken, token_type: 'bearer', expires_in: 120 * 86400 }, ch);
}

// ---- AI query parser (natural language → structured card search params) ----
// ── Siri Shortcuts endpoint ────────────────────────────────────────────────
// A speech-shaped wrapper over the same analysis the MCP tools serve, so an
// iOS Shortcut needs only one "Get Contents of URL" step and no JSON parsing.
//
//   GET /siri?q=charizard base set&key=<pair-code>      → plain text to speak
//   GET /siri?intent=collection&key=<pair-code>         → portfolio summary
//   GET /siri?q=...&format=json                         → full analysis JSON
//
// key= is the same pair code used by /sync. It's optional for card lookups
// (public card data) and required for anything touching the collection.
function _siriMoney(gbp) {
  if (gbp == null || !isFinite(gbp)) return null;
  return gbp >= 100 ? `£${Math.round(gbp)}` : `£${gbp.toFixed(2)}`;
}

function _siriSpeakAnalysis(a) {
  if (!a || a.found === false) return `I couldn't find that card. Try including the set name.`;
  const bits = [];
  bits.push(a.set ? `${a.name} from ${a.set}.` : `${a.name}.`);

  const price = _siriMoney(a.price_gbp);
  bits.push(price ? `It's worth about ${price} raw.` : `I don't have a current price for it.`);

  if (a.investment_stars) {
    bits.push(`${a.investment_stars} out of 5 as an investment${a.investment_stars_label ? ` — ${a.investment_stars_label.toLowerCase()}` : ''}.`);
  }
  const maxBuy = _siriMoney(a.ebay && a.ebay.max_buy_for_20pct_roi);
  if (maxBuy) bits.push(`Don't pay more than ${maxBuy} on eBay.`);

  if (a.entry_timing && a.entry_timing.label && a.entry_timing.label !== 'Unknown') {
    bits.push(`Timing: ${a.entry_timing.label.toLowerCase()}.`);
  }

  if (a.grading && a.grading.worth_grading != null) {
    bits.push(a.grading.worth_grading
      ? `Worth grading${a.grading.psa10_estimate_gbp ? ` — a PSA 10 is worth around ${_siriMoney(a.grading.psa10_estimate_gbp)}` : ''}.`
      : `Not worth grading at this price.`);
  }

  if (a.in_collection) bits.push(`You already own this one.`);
  else if (a.in_wishlist) bits.push(`It's on your wishlist.`);

  return bits.join(' ');
}

async function handleSiri(request, env, url) {
  const ch = { ...corsHeaders(request), 'Content-Type': 'text/plain; charset=utf-8' };
  const speak = (text, status) => new Response(text, { status: status || 200, headers: ch });

  const intent = (url.searchParams.get('intent') || 'card').trim().toLowerCase();
  const q      = (url.searchParams.get('q') || '').trim();
  const key    = (url.searchParams.get('key') || '').trim();
  const asJson = (url.searchParams.get('format') || '').toLowerCase() === 'json';
  const kvKey  = key ? `sync:${key}` : null;

  try {
    if (intent === 'collection' || intent === 'portfolio') {
      if (!kvKey) return speak('Add your pair code to the shortcut so I can read your collection.', 400);
      const res = await dispatchTool('get_collection_stats', {}, env, kvKey);
      const text = res && res.content && res.content[0] ? res.content[0].text : '';
      if (res && res.isError) return speak(text || 'I could not read your collection.', 200);
      if (asJson) return _jsonResp(200, JSON.parse(text), corsHeaders(request));
      let s; try { s = JSON.parse(text); } catch { return speak(text); }
      const parts = [];
      if (s.unique_cards != null) {
        parts.push(s.total_quantity && s.total_quantity !== s.unique_cards
          ? `You have ${s.total_quantity} cards across ${s.unique_cards} unique.`
          : `You have ${s.unique_cards} cards.`);
      }
      const spent = _siriMoney(s.total_spent_gbp);
      if (spent && s.total_spent_gbp > 0) parts.push(`You've spent about ${spent}.`);
      if (s.by_grade && (s.by_grade.graded || s.by_grade.raw)) {
        parts.push(`${s.by_grade.graded || 0} graded, ${s.by_grade.raw || 0} raw.`);
      }
      return speak(parts.length ? parts.join(' ') : 'I could not read your collection.');
    }

    // Default: value/insight lookup for one card
    if (!q) return speak('Tell me which card to look up.', 400);
    const res = await dispatchTool('get_card_analysis', { query: q }, env, kvKey);
    const text = res && res.content && res.content[0] ? res.content[0].text : '';
    if (res && res.isError) return speak(text || `I couldn't look that card up.`, 200);
    let a; try { a = JSON.parse(text); } catch { return speak(text); }
    if (asJson) return _jsonResp(200, a, corsHeaders(request));
    return speak(_siriSpeakAnalysis(a));
  } catch (e) {
    return speak(`Something went wrong looking that up. ${e.message}`, 200);
  }
}

async function handleAiQuery(request, env, url) {
  const ch = corsHeaders(request);
  if (!env.ANTHROPIC_API_KEY) return _jsonResp(503, { error: 'ANTHROPIC_API_KEY not configured.' }, ch);

  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return _jsonResp(400, { error: 'Missing ?q= parameter.' }, ch);

  const SYSTEM = `You are a Pokémon TCG card search query parser. Extract search intent from a natural language query and return ONLY a valid JSON object with no prose, no markdown, and no explanation.

Fields:
- vintage: boolean — true for WOTC/classic/pre-2004 era (1999–2003: Base Set, Jungle, Fossil, Gym, Neo, Legendary Collection, etc.)
- modern: boolean — true for post-2004 era (EX, Diamond & Pearl, Black & White, XY, Sun & Moon, Sword & Shield, Scarlet & Violet, etc.)
- grade: number|null — a SINGLE specific PSA grade (10, 9, 8, 7, 6, 5) or null; use null if a range is given
- gradeMin: number|null — lower bound of a PSA grade range (e.g. 7 for "PSA 10-7"); null if not a range query
- gradeMax: number|null — upper bound of a PSA grade range (e.g. 10 for "PSA 10-7"); null if not a range query
- gradeType: "psa"|null — "psa" if PSA grading mentioned at all without a specific single grade, null otherwise
- maxGBP: number|null — max budget in GBP (extract from "under £X", "cheap", "affordable", "budget", "less than £X", bare "£X")
- minGBP: number|null — minimum price in GBP (from "over £X", "at least £X")
- rarity: "holo"|"fullart"|"altart"|"secret"|"rainbow"|null
- pokemon: string|null — specific Pokémon name, capitalised (e.g. "Charizard", "Pikachu", "Mewtwo"); null if not mentioned
- setName: string|null — specific set in English (e.g. "Base Set", "Neo Genesis", "Jungle", "151", "Prismatic Evolutions"); null if not mentioned
- dealsOnly: boolean — true if user wants deals, value, undervalued, cheap finds, or bargains

Examples:
"vintage PSA under £150" → {"vintage":true,"modern":false,"grade":null,"gradeMin":null,"gradeMax":null,"gradeType":"psa","maxGBP":150,"minGBP":null,"rarity":null,"pokemon":null,"setName":null,"dealsOnly":false}
"vintage PSA 10-7 under £150" → {"vintage":true,"modern":false,"grade":null,"gradeMin":7,"gradeMax":10,"gradeType":"psa","maxGBP":150,"minGBP":null,"rarity":null,"pokemon":null,"setName":null,"dealsOnly":false}
"cheap Charizard" → {"vintage":false,"modern":false,"grade":null,"gradeMin":null,"gradeMax":null,"gradeType":null,"maxGBP":null,"minGBP":null,"rarity":null,"pokemon":"Charizard","setName":null,"dealsOnly":true}
"PSA 9 Base Set holos under £500" → {"vintage":true,"modern":false,"grade":9,"gradeMin":null,"gradeMax":null,"gradeType":"psa","maxGBP":500,"minGBP":null,"rarity":"holo","pokemon":null,"setName":"Base Set","dealsOnly":false}
"modern alt art deals under £100" → {"vintage":false,"modern":true,"grade":null,"gradeMin":null,"gradeMax":null,"gradeType":null,"maxGBP":100,"minGBP":null,"rarity":"altart","pokemon":null,"setName":null,"dealsOnly":true}
"affordable Pikachu vintage" → {"vintage":true,"modern":false,"grade":null,"gradeMin":null,"gradeMax":null,"gradeType":null,"maxGBP":50,"minGBP":null,"rarity":null,"pokemon":"Pikachu","setName":null,"dealsOnly":true}
"Neo Genesis rare finds" → {"vintage":true,"modern":false,"grade":null,"gradeMin":null,"gradeMax":null,"gradeType":null,"maxGBP":null,"minGBP":null,"rarity":null,"pokemon":null,"setName":"Neo Genesis","dealsOnly":true}`;

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
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: 'user', content: q }],
      }),
    });
  } catch (e) {
    return _jsonResp(502, { error: `Claude API unreachable: ${e.message}` }, ch);
  }

  if (!claudeResp.ok) {
    const errTxt = await claudeResp.text().catch(() => '');
    return _jsonResp(502, { error: `Claude API error ${claudeResp.status}: ${errTxt.slice(0, 80)}` }, ch);
  }

  const result = await claudeResp.json();
  const raw = (result.content?.[0]?.text || '').trim();

  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch {}
  }
  if (!parsed) return _jsonResp(502, { error: 'Failed to parse AI response.' }, ch);

  return new Response(JSON.stringify(parsed), {
    headers: { ...ch, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

// ---- Main handler ----
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
  if (url.pathname === '/health') return new Response('ok', { headers: corsHeaders(request) });
  if (url.pathname === '/market-intel' || url.pathname === '/vintage-intel') return handleMarketIntel(request, env, ctx);

  if (url.pathname === '/sync') return handleSync(request, env, url);
  if (url.pathname === '/mcp') return handleMcp(request, env, url);
  if (url.pathname === '/img-proxy') return handleImgProxy(request, env, url);
  if (url.pathname === '/grade-card' && request.method === 'POST') return handleGradeCard(request, env);
  if (url.pathname === '/.well-known/oauth-authorization-server') return handleOAuthMeta(request, env, url);
  if (url.pathname === '/oauth/register') return handleOAuthRegister(request, env);
  if (url.pathname === '/oauth/authorize') return handleOAuthAuthorize(request, env, url);
  if (url.pathname === '/oauth/token' && request.method === 'POST') return handleOAuthToken(request, env);
  if (url.pathname === '/auth/register' && request.method === 'POST') return handleAuthRegister(request, env);
  if (url.pathname === '/auth/login' && request.method === 'POST') return handleAuthLogin(request, env);
  if (url.pathname === '/user/sync') return handleUserSync(request, env);
  if (url.pathname === '/auth/account' && request.method === 'DELETE') return handleDeleteAccount(request, env);
  if (url.pathname === '/ai/chat' && request.method === 'POST') return handleAiChat(request, env);
  if (url.pathname === '/ai/query') return handleAiQuery(request, env, url);
  if (url.pathname === '/siri') return handleSiri(request, env, url);
  if (url.pathname === '/tcg-price') return handleTcgPrice(request, url);
  if (url.pathname === '/price-warm') return handlePriceWarm(request, env, url);
  if (url.pathname === '/prices') return handlePricesBatch(request, env, url);
  if (url.pathname === '/pop')   return handlePopQuery(request, env, url);
  if (url.pathname === '/sales') return handleSalesQuery(request, env, url);
  if (url.pathname !== '/search') return new Response('Not found', { status: 404, headers: corsHeaders(request) });

  const q = url.searchParams.get('q') || '';
  const fairValueGBP = parseFloat(url.searchParams.get('max') || '0');
  const fxUsdToGbp = parseFloat(url.searchParams.get('fx') || '0.79');
  const fxEurToGbp = parseFloat(url.searchParams.get('fxEur') || '0.86');
  const grade = url.searchParams.get('grade') || 'raw';
  const ukOnly = url.searchParams.get('source') === 'uk_only';

  if (!q || !fairValueGBP) {
    return new Response(JSON.stringify({ error: 'Missing q or max param' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const maxUSD = fairValueGBP / fxUsdToGbp;
  const maxEUR = fairValueGBP / fxEurToGbp;

  // Fan out to sources in parallel; tolerate per-source failures.
  // When ukOnly is set, skip eBay US and Cardmarket to reduce latency.
  const [ukRes, usRes, cmRes] = await Promise.allSettled([
    searchEbay(env, 'EBAY_GB', q, fairValueGBP, 'GBP'),
    ukOnly ? Promise.resolve({ items: [] }) : searchEbay(env, 'EBAY_US', q, maxUSD, 'USD'),
    ukOnly ? Promise.resolve({ items: [] }) : searchCardmarket(q, maxEUR),
  ]);

  const ukItems = ukRes.status === 'fulfilled' ? (ukRes.value.items || []) : [];
  const usItems = usRes.status === 'fulfilled' ? (usRes.value.items || []) : [];
  const cmItems = cmRes.status === 'fulfilled' ? (cmRes.value.items || []) : [];
  const errors = [];
  if (ukRes.status === 'rejected') errors.push('ebay_uk:' + ukRes.reason?.message);
  else if (ukRes.value.error) errors.push('ebay_uk:' + ukRes.value.error);
  if (!ukOnly) {
    if (usRes.status === 'rejected') errors.push('ebay_us:' + usRes.reason?.message);
    else if (usRes.value.error) errors.push('ebay_us:' + usRes.value.error);
    if (cmRes.status === 'rejected') errors.push('cardmarket:' + cmRes.reason?.message);
    else if (cmRes.value.error) errors.push('cardmarket:' + cmRes.value.error);
  }

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
    name: 'search_card_database',
    description: 'Search the Pokémon TCG card database for any card — not just cards the user owns. Use this when the user asks to find a card, explore what exists in a set, look up Pokémon cards by character name, rarity, or set. Returns card details, current market prices in GBP, and whether the card is already in the user\'s collection or wishlist. Works for EN cards. Examples: "find Charizard SIRs", "what Umbreon cards are in Scarlet & Violet?", "show me Illustration Rares from 151".',
    inputSchema: {
      type: 'object',
      properties: {
        pokemon:  { type: 'string', description: 'Pokémon name to search for (e.g. "Charizard", "Umbreon", "Mew"). Partial names work.' },
        set:      { type: 'string', description: 'Set name or code (e.g. "Obsidian Flames", "sv3", "151", "Scarlet & Violet").' },
        rarity:   { type: 'string', description: 'Rarity type (e.g. "Special Illustration Rare", "Illustration Rare", "Hyper Rare", "Double Rare").' },
        limit:    { type: 'integer', minimum: 1, maximum: 20, description: 'Max results to return. Default: 10.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_card_analysis',
    description: 'Get a full investment analysis for a specific card: current market price (GBP), max buy price (what you should pay on eBay including fee buffer), star rating (1–5), entry timing (is now a good time to buy?), and grading economics (is it worth submitting to PSA?). Use when the user asks "is X card worth buying?", "what should I pay for Y?", "should I grade this?", or wants a full breakdown of a specific card.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'pokemontcg.io card ID (e.g. "sv3-215", "sv3pt5-197"). Use this if you already know it from a search_card_database result.' },
        query:   { type: 'string', description: 'Card name + set to search for if you don\'t have the card ID (e.g. "Charizard ex Obsidian Flames 215").' },
      },
      additionalProperties: false,
    },
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

async function loadSnapshot(env, kvKey) {
  if (!env.SYNC_KV) return { error: 'SYNC_KV not bound. Bind a KV namespace in the worker settings.' };
  const raw = await env.SYNC_KV.get(kvKey);
  if (!raw) return { snap: null, empty: true };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { error: 'Stored snapshot is not valid JSON.' }; }
  return { snap: parsed, empty: false };
}

// Resolves the Bearer token to a KV key — accepts either a JWT (account auth)
// or a legacy pair code. Token may come from the Authorization header or the
// ?token= query param (for Claude.ai integrations that don't support custom headers).
// Returns { kvKey } on success or { error } on failure.
async function resolveMcpAuth(request, env) {
  const url = new URL(request.url);
  const token = extractBearer(request) || url.searchParams.get('token') || '';
  if (!token) return { error: 'Missing auth — pass Authorization: Bearer <token> or ?token= in the URL' };
  if (token.includes('.')) {
    // JWT path (account-based auth)
    if (!env.JWT_SECRET) return { error: 'JWT_SECRET not configured in worker secrets.' };
    const claims = await jwtVerify(token, env.JWT_SECRET);
    if (!claims) return { error: 'Invalid or expired token — sign in to the app again.' };
    return { kvKey: `user:data:${claims.sub}` };
  }
  // Legacy pair code path
  if (!PAIR_CODE_REGEX.test(token)) return { error: 'Pair code must be 16–64 chars of [A-Za-z0-9_-]' };
  return { kvKey: `sync:${token}` };
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

async function dispatchTool(name, args, env, kvKey) {
  const { snap, empty, error } = await loadSnapshot(env, kvKey);
  if (error) return asError(error);
  const SNAPSHOT_FREE_TOOLS = ['search_marketplace_deals', 'search_card_database', 'get_card_analysis'];
  if (empty && !SNAPSHOT_FREE_TOOLS.includes(name)) {
    return asError('No data synced yet. Open the app on any device and tap sync first.');
  }

  switch (name) {
    case 'get_collection': {
      const portfolio = snapKey(snap, 'pkm-portfolio', []);
      const list = Array.isArray(portfolio) ? portfolio : [];
      const limit = args && Number.isInteger(args.limit) ? args.limit : list.length;
      const items = list.slice(0, limit).map(c => _enrichWithStars(c));
      return asTextContent({ count: list.length, items });
    }
    case 'get_wishlist': {
      const wishlist = snapKey(snap, 'pkm-wishlist', []);
      const list = Array.isArray(wishlist) ? wishlist : [];
      return asTextContent({ count: list.length, items: list.map(c => _enrichWithStars(c)) });
    }
    case 'get_watchlist': {
      const watchlist = snapKey(snap, 'pkm-watchlist-v1', []);
      const list = Array.isArray(watchlist) ? watchlist : [];
      return asTextContent({ count: list.length, items: list.map(c => _enrichWithStars(c)) });
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
          if (hay.includes(query)) matches.push({ list: listName, item: _enrichWithStars(item) });
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
    case 'search_card_database': {
      const pokemon  = args && args.pokemon  ? String(args.pokemon).trim()  : '';
      const set      = args && args.set      ? String(args.set).trim()      : '';
      const rarity   = args && args.rarity   ? String(args.rarity).trim()   : '';
      const limit    = (args && Number.isInteger(args.limit) && args.limit > 0) ? Math.min(args.limit, 20) : 10;
      if (!pokemon && !set && !rarity) return asError('Provide at least one of: pokemon, set, rarity.');

      // Build pokemontcg.io query string
      const qParts = [];
      if (pokemon) qParts.push(`name:"${pokemon.replace(/"/g, '')}*"`);
      if (set) {
        // Looks like a set ID (e.g. sv3, swsh9, xy1)?
        const looksLikeId = /^[a-z][a-z0-9_-]{1,10}$/i.test(set) && !set.includes(' ');
        qParts.push(looksLikeId ? `set.id:${set}` : `set.name:"${set.replace(/"/g, '')}"`);
      }
      if (rarity) qParts.push(`rarity:"${rarity.replace(/"/g, '')}"`);

      const tcgUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(qParts.join(' '))}&pageSize=${limit}&orderBy=-set.releaseDate`;
      let tcgResp;
      try {
        tcgResp = await fetch(tcgUrl, { headers: { 'User-Agent': 'PokemonPricePredictor/1.0' } });
      } catch (e) {
        return asError(`Card database fetch failed: ${e.message}`);
      }
      if (!tcgResp.ok) return asError(`Card database returned ${tcgResp.status}.`);
      const tcgData = await tcgResp.json();
      const cards = (tcgData.data || []).slice(0, limit);
      if (!cards.length) return asTextContent({ query: qParts.join(' '), count: 0, cards: [], note: 'No cards matched. Try a broader search.' });

      // Load user's owned / wishlisted card IDs for cross-reference
      const portfolio = !empty ? (snapKey(snap, 'pkm-portfolio', []) || []) : [];
      const wishlist  = !empty ? (snapKey(snap, 'pkm-wishlist',  []) || []) : [];
      const ownedIds  = new Set(portfolio.map(c => (c.id || c.cardId || '').toLowerCase()));
      const wishedIds = new Set(wishlist.map(c  => (c.id || c.cardId || '').toLowerCase()));

      const FX = 0.79;
      const results = cards.map(c => {
        const priceUSD = _bestTcgPrice(c.tcgplayer);
        const priceGBP = priceUSD != null ? +(priceUSD * FX).toFixed(2) : null;
        const cardIdLow = (c.id || '').toLowerCase();
        return {
          id:         c.id,
          name:       c.name,
          set:        c.set?.name,
          set_code:   c.set?.id,
          number:     c.number,
          rarity:     c.rarity,
          release_date: c.set?.releaseDate,
          price_usd:  priceUSD != null ? +priceUSD.toFixed(2) : null,
          price_gbp:  priceGBP,
          image_sm:   c.images?.small,
          investment_stars:       _cardStars(c.name, c.rarity),
          investment_stars_label: _STAR_LABELS[_cardStars(c.name, c.rarity)],
          in_collection: ownedIds.has(cardIdLow),
          in_wishlist:   wishedIds.has(cardIdLow),
        };
      });
      return asTextContent({
        query: qParts.join(' '),
        count: results.length,
        cards: results,
        star_framework: _STAR_FRAMEWORK,
      });
    }

    case 'get_card_analysis': {
      const cardId    = args && args.card_id ? String(args.card_id).trim() : '';
      const queryStr  = args && args.query   ? String(args.query).trim()   : '';
      if (!cardId && !queryStr) return asError('Provide card_id or query.');

      let card;
      try {
        if (cardId) {
          const r = await fetch(`https://api.pokemontcg.io/v2/cards/${encodeURIComponent(cardId)}`, { headers: { 'User-Agent': 'PokemonPricePredictor/1.0' } });
          if (!r.ok) return asError(`Card ${cardId} not found (${r.status}).`);
          card = (await r.json()).data;
        } else {
          const q = encodeURIComponent(`name:"${queryStr.replace(/"/g, '')}"`);
          const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=1&orderBy=-set.releaseDate`, { headers: { 'User-Agent': 'PokemonPricePredictor/1.0' } });
          if (!r.ok) return asError(`Card database returned ${r.status}.`);
          const d = await r.json();
          card = d.data?.[0] ?? null;
          if (!card) return asTextContent({ found: false, query: queryStr, note: 'No card matched. Try a more specific name.' });
        }
      } catch (e) {
        return asError(`Card database fetch failed: ${e.message}`);
      }

      const FX = 0.79;
      const priceUSD = _bestTcgPrice(card.tcgplayer);
      const priceGBP = priceUSD != null ? priceUSD * FX : null;

      // eBay economics
      const EBAY_FEE = 0.129, EBAY_FIXED = 0.30;
      const ebayNetGBP    = priceGBP != null ? +(priceGBP * (1 - EBAY_FEE) - EBAY_FIXED).toFixed(2) : null;
      const maxBuy20pctGBP = ebayNetGBP != null ? +(ebayNetGBP / 1.20).toFixed(2) : null;
      const ebayFairList   = priceGBP  != null ? +((priceGBP + EBAY_FIXED) / (1 - EBAY_FEE)).toFixed(2) : null;

      // Entry timing
      const releaseDate = card.set?.releaseDate;
      const timing = _entryTiming(releaseDate);

      // Grading economics
      const grading = priceGBP != null ? _gradingEconomics(priceGBP) : null;

      // Stars
      const stars      = _cardStars(card.name, card.rarity);
      const starsLabel = _STAR_LABELS[stars];

      // Ownership
      const portfolio = !empty ? (snapKey(snap, 'pkm-portfolio', []) || []) : [];
      const wishlist  = !empty ? (snapKey(snap, 'pkm-wishlist',  []) || []) : [];
      const idLow = (card.id || '').toLowerCase();
      const inCollection = portfolio.some(c => (c.id || c.cardId || '').toLowerCase() === idLow);
      const inWishlist   = wishlist.some(c  => (c.id || c.cardId || '').toLowerCase() === idLow);

      const recommendation = _makeRecommendation(stars, timing, priceGBP, maxBuy20pctGBP, inCollection, inWishlist);

      return asTextContent({
        id:         card.id,
        name:       card.name,
        set:        card.set?.name,
        set_code:   card.set?.id,
        number:     card.number,
        rarity:     card.rarity,
        release_date: releaseDate,
        investment_stars:       stars,
        investment_stars_label: starsLabel,
        recommendation,
        price_usd:  priceUSD != null ? +priceUSD.toFixed(2) : null,
        price_gbp:  priceGBP != null ? +priceGBP.toFixed(2) : null,
        ebay: priceGBP != null ? {
          net_if_sold_now_gbp:    ebayNetGBP,
          max_buy_for_20pct_roi:  maxBuy20pctGBP,
          fair_listing_price_gbp: ebayFairList,
        } : null,
        entry_timing:     timing,
        grading:          grading,
        in_collection:    inCollection,
        in_wishlist:      inWishlist,
        image_sm:  card.images?.small,
        image_lg:  card.images?.large,
        star_framework:   _STAR_FRAMEWORK,
      });
    }

    default:
      return asError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Helper functions for new MCP tools
// ---------------------------------------------------------------------------

function _enrichWithStars(card) {
  const name   = card.name || card.cardName || '';
  const rarity = card.rarity || '';
  const s = _cardStars(name, rarity);
  return { ...card, investment_stars: s, investment_stars_label: _STAR_LABELS[s] };
}

function _makeRecommendation(stars, timing, priceGBP, maxBuyGBP, inCollection, inWishlist) {
  if (inCollection) {
    if (stars >= 4) return `Already in your collection. ${stars === 5 ? '5-star card — hold long-term (3–5+ years).' : '4-star — hold unless you need liquidity.'}`;
    if (stars === 3) return 'Already in your collection. Moderate card — hold if at a profit, otherwise reassign budget to higher-star picks.';
    return 'Already in your collection. Low-star card — consider selling if not personally attached and redirecting to a higher-star opportunity.';
  }

  const priceFair  = (maxBuyGBP != null && priceGBP != null) ? priceGBP <= maxBuyGBP * 1.10 : null;
  const priceCheap = (maxBuyGBP != null && priceGBP != null) ? priceGBP <= maxBuyGBP * 0.90 : null;
  const tLabel = timing?.label ?? '';
  const optimalTiming = tLabel === 'Optimal entry';
  const approachTiming = tLabel === 'Approaching window';
  const tooEarly = tLabel === 'Too early';

  if (stars === 5) {
    if (tooEarly) return '5-star card but set is under 3 months old — prices still inflated. Wait for the 6-month window then buy.';
    if (optimalTiming && priceCheap) return 'Strong buy — 5-star card in the optimal entry window at below-fair price. Buy now.';
    if (optimalTiming) return 'Buy — 5-star card in the optimal entry window. Long-hold investment.';
    if (approachTiming) return 'Watch — 5-star card approaching the buy window. Set a price alert and move in the next 2–3 months.';
    return '5-star card outside the ideal entry window. Still worth buying on a dip; hold 3–5+ years.';
  }
  if (stars === 4) {
    if (tooEarly) return '4-star card but too early — wait for the 6-month window.';
    if ((optimalTiming || approachTiming) && priceFair !== false) return 'Good buy — 4-star card in a solid entry window at fair value.';
    if (optimalTiming || approachTiming) return 'Watch — 4-star card but price is above your 20% ROI threshold. Wait for a dip.';
    return '4-star card. Buy on a significant dip only.';
  }
  if (stars === 3) {
    if (priceCheap && optimalTiming) return 'Moderate pick — 3-star card at a good price in the right window. Acceptable at this level.';
    return '3-star card. Only buy if the price is notably below market (>15% under fair value).';
  }
  if (stars === 2) return '2-star card. Low investment priority — only buy for personal collection reasons, not investment.';
  return '1-star card. Pass from an investment standpoint.';
}

function _bestTcgPrice(tcgplayer) {
  if (!tcgplayer?.prices) return null;
  const ORDER = ['holofoil', '1stEditionHolofoil', 'unlimitedHolofoil', 'reverseHolofoil', 'normal', 'unlimited', '1stEdition'];
  for (const k of ORDER) {
    if (tcgplayer.prices[k]?.market != null) return tcgplayer.prices[k].market;
  }
  for (const k of Object.keys(tcgplayer.prices)) {
    if (tcgplayer.prices[k]?.market != null) return tcgplayer.prices[k].market;
  }
  return null;
}

const _STAR_LABELS = [
  '',
  '1 star — low priority: common character, standard rarity. Hold or pass.',
  '2 stars — average: premium rarity but niche Pokémon, or popular Pokémon in basic rarity. Situational buy.',
  '3 stars — moderate: strong character or premium art. Worth buying at the right price.',
  '4 stars — strong pick: top-tier character with premium art, or S-tier at a basic premium rarity. Buy on the dip.',
  '5 stars — top tier: S-tier Pokémon (Charizard, Umbreon, Mew, Mewtwo, Pikachu, Eevee) in Special Illustration Rare or Hyper Rare. Long-hold investment.',
];

const _STAR_FRAMEWORK = {
  description: 'Investment rating 1–5 based on character desirability and card rarity/art tier.',
  criteria: {
    '5': 'S-tier Pokémon + Ultra Premium rarity (SIR, Hyper Rare, Shiny Super Rare). Highest long-term value.',
    '4': 'S-tier + Premium rarity, OR A-tier + Ultra Premium. Strong investment.',
    '3': 'A-tier + Premium rarity, OR S-tier without premium rarity.',
    '2': 'Premium/high-art rarity but B-tier or unknown Pokémon.',
    '1': 'Common/uncommon rarity or low-demand Pokémon.',
  },
  s_tier_pokemon: ['Charizard','Umbreon','Mew','Mewtwo','Pikachu','Eevee'],
  a_tier_pokemon: ['Gengar','Dragonite','Gyarados','Lugia','Lucario','Gardevoir','Greninja','Sylveon','Snorlax','Blastoise','Venusaur','Togekiss','Garchomp','Infernape','Empoleon'],
  ultra_premium_rarities: ['Special Illustration Rare','Hyper Rare','Shiny Super Rare','Shiny Ultra Rare'],
  premium_rarities: ['Illustration Rare','Double Rare','Ultra Rare','Secret Rare','Rainbow Rare','Gold Rare'],
  note: 'Entry timing and current market conditions also affect buy/hold/sell decisions — see entry_timing and ebay fields.',
};

const _S_CHARS = ['charizard','umbreon','mew','mewtwo','pikachu','eevee'];
const _A_CHARS = ['gengar','dragonite','gyarados','lugia','lucario','gardevoir','greninja','sylveon','snorlax',
                  'blastoise','venusaur','articuno','zapdos','moltres','alakazam','togekiss','garchomp',
                  'infernape','empoleon','espeon','flareon','vaporeon','jolteon','leafeon','glaceon','sylveon'];
const _ULTRA_PREM_RARITIES = new Set(['Special Illustration Rare','Hyper Rare','Shiny Super Rare','Shiny Ultra Rare']);
const _PREM_RARITIES       = new Set(['Illustration Rare','Double Rare','Ultra Rare','Secret Rare','Rainbow Rare','Gold Rare']);

function _cardStars(name, rarity) {
  const n = (name || '').toLowerCase();
  const isS = _S_CHARS.some(c => n.includes(c));
  const isA = _A_CHARS.some(c => n.includes(c));
  const isUltra = _ULTRA_PREM_RARITIES.has(rarity || '');
  const isPrem  = isUltra || _PREM_RARITIES.has(rarity || '');
  if (isS && isUltra) return 5;
  if ((isS && isPrem) || (isA && isUltra)) return 4;
  if ((isA && isPrem) || (isS && !isPrem)) return 3;
  if (isPrem) return 2;
  return 1;
}

function _setAgeDays(releaseDate) {
  if (!releaseDate) return null;
  const rel = new Date(releaseDate.replace(/\//g, '-'));
  if (isNaN(rel.getTime())) return null;
  return Math.floor((Date.now() - rel.getTime()) / 86400000);
}

function _entryTiming(releaseDate) {
  const days = _setAgeDays(releaseDate);
  if (days === null) return { label: 'Unknown', detail: 'Release date not available.' };
  const months = days / 30;
  if (months < 3)  return { label: 'Too early',          months_since_release: +months.toFixed(1), detail: 'Set under 3 months old. Prices inflated post-launch. Wait.' };
  if (months < 6)  return { label: 'Approaching window', months_since_release: +months.toFixed(1), detail: '3–6 months out. Prices cooling. Watch closely but not yet optimal.' };
  if (months < 10) return { label: 'Optimal entry',      months_since_release: +months.toFixed(1), detail: '6–10 months post-launch is the ideal buy window before secondary market recovers.' };
  if (months < 24) return { label: 'Mature market',      months_since_release: +months.toFixed(1), detail: 'Over 10 months old. Fair value established. Buy on dips only.' };
  return            { label: 'Aged set',                  months_since_release: +months.toFixed(1), detail: 'Over 2 years. Value locked in. Premium for nostalgia pieces; hold long-term.' };
}

function _gradingEconomics(marketGBP) {
  const GRADING_COST = 28;   // approx PSA regular (£) after shipping both ways
  const PSA10_MULT   = 3.0;  // conservative: many cards do 3–5×, use 3× floor
  const psa10est = marketGBP * PSA10_MULT;
  const netIfSold = psa10est * (1 - 0.129) - 0.30;
  const breakEven = marketGBP + GRADING_COST;
  const worthIt   = netIfSold > breakEven * 1.30;  // need 30% margin over break-even
  return {
    raw_market_gbp:         +marketGBP.toFixed(2),
    psa10_estimate_gbp:     +psa10est.toFixed(2),
    grading_cost_approx_gbp: GRADING_COST,
    estimated_net_after_grading_and_ebay: +netIfSold.toFixed(2),
    worth_grading: worthIt,
    note: worthIt
      ? `PSA 10 est. £${psa10est.toFixed(0)} → net ~£${netIfSold.toFixed(0)} after fees. Likely worth grading.`
      : `PSA 10 est. £${psa10est.toFixed(0)} → net ~£${netIfSold.toFixed(0)} after fees. Grading at £${GRADING_COST} probably not worth it at this price.`,
  };
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

  const { kvKey, error: authError } = await resolveMcpAuth(request, env);
  if (authError) {
    const base = `${url.protocol}//${url.host}`;
    return new Response(JSON.stringify({ error: authError }), {
      status: 401, headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-authorization-server"`,
        ...cors,
      },
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
            instructions: `Pokémon TCG investment assistant. You have access to the user's synced collection, wishlist, and watchlist, plus live card database search and marketplace deal scanning.

INVESTMENT STAR SYSTEM (1–5, always factor into recommendations):
★★★★★ 5 — S-tier Pokémon (Charizard, Umbreon, Mew, Mewtwo, Pikachu, Eevee) in Special Illustration Rare / Hyper Rare / Shiny Super Rare. Long-hold, highest long-term value. BUY and hold 3–5+ years.
★★★★  4 — S-tier in a Premium rarity (Illustration Rare, Double Rare, Ultra Rare), OR A-tier (Gengar, Dragonite, Gyarados, Lugia, Lucario, Gardevoir, Greninja, Sylveon, Snorlax, Blastoise, Venusaur, Togekiss, Garchomp, Infernape, Empoleon) in SIR/Hyper Rare. Strong investment — buy on dips.
★★★   3 — A-tier in Premium rarity, OR S-tier in standard rarity. Moderate — buy at the right price.
★★    2 — Premium/high-art rarity with B-tier or unknown Pokémon. Situational.
★     1 — Common or low-demand. Low priority; consider alternatives first.

ENTRY TIMING (6–10 months post-launch = optimal window):
- Under 3 months: too early — prices still inflated
- 3–6 months: approaching — prices cooling, watch closely
- 6–10 months: OPTIMAL — best time to buy
- 10–24 months: mature — buy on dips only
- 24+ months: aged — value established, premium for nostalgia pieces

GRADING (PSA): only submit if PSA 10 estimated value > (raw market + grading cost) × 1.3.

Always cite the star rating and entry timing when recommending buy/hold/sell. Be direct and concise — GBP figures, no fluff.`,
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
          const result = await dispatchTool(tname, targs, env, kvKey);
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


// ---- Cron: background price warm-up ----------------------------------------
// Scheduled at 0 3 * * * (3 AM UTC) via Cloudflare → Worker → Triggers →
// Cron Triggers. Fetches PriceCharting prices for every tracked card
// (portfolio + wishlist + watchlist) from all known pair-code snapshots and
// stores the result in KV so the app can hydrate on first load without waiting.
//
// The Worker makes direct server-to-server requests to PriceCharting —
// no CORS proxy needed — so this is more reliable than the browser path.

const PC_WARM_CONCURRENCY  = 10;
const PC_WARM_MAX_PER_USER = 300; // cap so a huge collection doesn't time out
const PC_WARM_KV_TTL       = 25 * 3600; // 25 h — expires before the next cron run

function _warmBuildPCQuery(card) {
  const name    = (card.n || card.name || '').replace(/\s*\(JP\)/, '').replace(/\s*#\d+/, '').trim();
  const setName = (card.s || card.setName || card.set || '').replace(/\s*\(.*?\)/g, '').trim();
  const num     = card.cn || card.cardNumber || '';
  const langTag = (card.lang || '').toUpperCase() === 'JP' ? 'japanese' : '';
  return [setName, name, num, langTag].filter(Boolean).join(' ').trim();
}

function _warmScorePCProduct(product, card) {
  const pName = (product.productName || '').toLowerCase();
  const pCons = (product.consoleName || '').toLowerCase();
  const cName = (card.n || card.name || '').toLowerCase().replace(/\s*\(jp\)/, '').trim();
  const setName = (card.s || card.setName || card.set || '').toLowerCase();
  const isJP = (card.lang || '').toUpperCase() === 'JP';
  let score = 0;
  if (isJP && !pCons.includes('japanese')) score -= 50;
  if (!isJP && pCons.includes('japanese')) score -= 50;
  if (setName && pCons.includes(setName)) score += 40;
  const cTokens = cName.split(/\s+/).filter(t => t.length > 1);
  const pTokens = pName.split(/\s+/).filter(t => t.length > 1);
  for (const t of cTokens) if (pTokens.includes(t)) score += 8;
  for (const dt of ['mega', 'shiny', 'gold', 'reverse', 'shadowless', 'first', 'edition', 'holo']) {
    if (pTokens.includes(dt) && !cTokens.includes(dt)) score -= 12;
  }
  score -= Math.min(pTokens.filter(t => !cTokens.includes(t) && !['pokemon', 'card', 'tcg', 'japanese', '#'].includes(t)).length, 4) * 3;
  if (card.cn || card.cardNumber) {
    const cardNum = String(card.cn || card.cardNumber).replace(/^0+/, '');
    if (new RegExp(`#?0*${cardNum}\\b`).test(pName)) score += 25;
    else score -= 8;
  }
  return score;
}

function _warmParsePC(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0;
}

async function _warmFetchPCCard(card) {
  const q = _warmBuildPCQuery(card);
  if (!q) return null;
  const pcUrl = `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(q)}&format=json`;
  let resp;
  try {
    resp = await fetch(pcUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PokemonPricePredictor/1.0)', Accept: 'application/json' },
    });
  } catch { return null; }
  if (!resp.ok) return null;
  let data;
  try { data = await resp.json(); } catch { return null; }
  const products = data.products || [];
  if (!products.length) return null;
  for (const p of products) p._score = _warmScorePCProduct(p, card);
  products.sort((a, b) => b._score - a._score);
  const best = products[0];
  if (best._score < 10) return null; // too uncertain
  return {
    pcUngraded: _warmParsePC(best.price1),
    pcPsa10:    _warmParsePC(best.price2),
    pcGrade9:   _warmParsePC(best.price3),
    market:     _warmParsePC(best.price1),
    mid:        _warmParsePC(best.price1),
    pcName:     best.productName || '',
    pcConsole:  best.consoleName || '',
    pcId:       best.id || '',
    source:     'pricecharting',
    _ts:        Date.now(),
  };
}

function _warmSnapKey(snap, key) {
  if (!snap?.data?.[key]) return [];
  try { return JSON.parse(snap.data[key]) || []; } catch { return []; }
}

// ── Market intelligence (all card eras) ─────────────────────────────────────────────────────

const MARKET_INTEL_KV_KEY    = 'market-intel-v1';
const MARKET_INTEL_CHECK_KEY = 'market-intel-last-check';
const VINTAGE_BACKFILL_KEY    = 'vintage-backfill-queue';  // [{id, title}] written from local batch
const VINTAGE_SEEN_KEY        = 'vintage-seen-videos';      // Set of processed video IDs (JSON array)
const MARKET_BACKFILL_PER_RUN = 15;                        // videos processed per cron run

// All monitored channels — RSS + backfill queue cover historical + new content
const MARKET_CHANNELS = [
  { id: 'UCsSA2eBWW7qAwSV_COyW8uQ', name: 'PikaPikaPaPa'              },
  { id: 'UCw47gkI_OV46GQyq08jQ-8w', name: 'MasterBalless'             },
  { id: 'UCJrBXKBCYtHrW_PSjZc3amQ', name: 'Sleeve No Card Behind'     }, // was mislabelled Phillips Collectibles
  { id: 'UCEYiwUuZO02Ewqrc5aZlzyQ', name: 'PokeTamer'                 }, // was mislabelled Collectors Corner TCG
  { id: 'UCd0bq0P8Xz9vEJqdnyqHYrg', name: 'PokeData Dad Guy'          },
  { id: 'UCH92NLGznIRpQxErnKm_ZHQ', name: 'Collectors Corner TCG'     }, // was mislabelled Sleeve No Card Behind
  { id: 'UCDFqWkHUKWDMm590DopfCvg', name: 'Phillips Collectibles'     }, // was mislabelled PokeTamer
  { id: 'UCQg9Hzbs5f6A7W1dE46sc2A', name: 'Randolph Pokémon'          },
  { id: 'UCePvxCHy42gdfsFvNDBRQdQ', name: 'It Was Never A Phase Cards' }, // was mislabelled PokeJace
  { id: 'UCfEGPbDglUfd4Shi3ebuZCw', name: 'PokeJace'                  }, // was mislabelled It Was Never a Phase
  { id: 'UCweh8CzIYgMpvgvhniVKNQw', name: 'Snomnom'                   }, // was mislabelled Jordan Collects
  { id: 'UC-mDbPaXMhSCKgHIjyVX2Vw', name: 'Max Does Pokemon'          }, // was mislabelled Snomnomnomnom
  { id: 'UCvq8m0HTf4Mu_tVJO8GFyJg', name: 'Dewgong Don'               },
  { id: 'UCDs1k6MPQJKG5_1oAvLbo1g', name: 'Top 10 Pokemon'            },
  { id: 'UCTHk5ZPd0lv6jWwV5aVt1iA', name: 'PokeAnalyst Ed'            },
];

// User-pinned video IDs — always processed if not yet in intel sources
const MARKET_PINNED_VIDEOS = [
  { videoId: '_cyddOc1SMU', title: 'The Entire History of Shiny Pokémon Cards',                             channelName: 'Sleeve No Card Behind'    },
  { videoId: 'w1HHF9GUiwo', title: 'Top 10 EXPENSIVE Pitch Black Pokemon Cards!',                          channelName: 'Top 10 Pokemon'            },
  { videoId: 'KHxEw59qjCI', title: "I Can't Believe These 8 Pokémon Cards Are Still Under $10!",           channelName: 'Phillips Collectibles'     },
  { videoId: 'mQE8W5gc5Cw', title: "I'm Not Worried About Pokémon Card Prices Dropping Right Now...",      channelName: 'Phillips Collectibles'     },
  { videoId: '5d7tjpVKFOc', title: "Your Pokémon Cards Dropped 42% This Summer — Here's Why That's Good", channelName: 'PokeAnalyst Ed'            },
  { videoId: 'PawseRgrbzw', title: 'MOST EXPENSIVE Card for EVERY Pokemon EVER',                           channelName: 'ThePokePlanet'             },
  { videoId: 'tZtCOYKD5IY', title: 'Is The Summer Slump Even That Bad? Pokemon Market Update',             channelName: 'It Was Never A Phase Cards' },
  { videoId: 'hLvJqNVmbE8', title: 'Why Investing In Japanese Pokemon Cards Is A Smart Decision!',               channelName: 'Phillips Collectibles'     },
  // Batch 3 — budget picks, buy-now signals, JP trends (July 2026)
  { videoId: 'sj2-b1SKiUU', title: '10 Cheap Pokemon Cards That Will Explode In Price! (2026)',                   channelName: 'PokeBim'                   },
  { videoId: 'Y1D0cmSOliY', title: '10 POKEMON CARDS TO BUY NOW!',                                               channelName: 'Jordan Collects'           },
  { videoId: 'WUwy56CCj1Q', title: 'Buy These Pokemon Cards NOW While They Are Still Affordable',                 channelName: 'TyDean Cards'              },
  { videoId: '_rkj-BdSQII', title: "The Japanese Pokemon Crash Just Made You Rich (If You're Smart)",            channelName: "Henry's Poke Corner"       },
  { videoId: '1X3zfYV8oQE', title: '10 POKEMON CARDS TO BUY UNDER $20!!!',                                       channelName: 'Jordan Collects'           },
  { videoId: '3QXPiSXf8to', title: '10 POKEMON CARDS TO BUY NOW!',                                               channelName: 'Jordan Collects'           },
  { videoId: 'gspIRMC8-nQ', title: '10 POKEMON CARDS TO BUY NOW!',                                               channelName: 'Jordan Collects'           },
  { videoId: '2XcOAf8ecSY', title: "5 Cheap Pokemon Cards I'm Buying NOW!",                                      channelName: 'The Card Science'          },
  { videoId: 'hvtmQKv8O3w', title: 'Is Now FINALLY The Time To Buy Ascended Heroes Pokemon Cards?',              channelName: 'Danny Phantump'            },
  { videoId: 'JUeU36q_JUk', title: "How I'd Spend $500 In The Current Pokemon Market!",                          channelName: 'Phillips Collectibles'     },
  // Batch 4 — Japanese card deep-dive series (July 2026)
  { videoId: 'HP0CqeKwkLQ', title: '10 ULTIMATE Japanese Pokémon Cards To Buy!',                                  channelName: 'Phillips Collectibles'     },
  { videoId: 'Sg3tSUGmbKc', title: 'Why You Should Start Buying Japanese Pokémon Cards (The Complete Guide)',     channelName: 'jMac Collects'             },
  { videoId: 'McA4qmms49Q', title: 'Why It Seems Everyone Is Switching To Japanese Pokemon Cards...',             channelName: 'Phillips Collectibles'     },
  { videoId: 'MhKB5tjbfYE', title: 'Something Weird Is Happening With Japanese Pokemon Cards...',                 channelName: 'Phillips Collectibles'     },
  { videoId: 'HYwzO2OOadQ', title: 'If You HOLD Japanese Cards, You Are RICHER Than You Think.',                 channelName: "Collector's Dream TCG"     },
  { videoId: '23wyNg1VMSI', title: 'The Ugly Truth About Japanese Pokemon Card Prices',                           channelName: 'Top Chaserz'               },
  { videoId: 'rcqdvtkqkCo', title: "Japanese Pokemon Cards are WEIRD Right Now (And That's OKAY!)",              channelName: 'Card Penguin Pokemon'      },
  { videoId: 'T_XEDV4gBAE', title: 'My Japanese Pokémon Card Investment a Year Later...',                         channelName: 'Randolph Pokemon'          },
  { videoId: 'OaYY0VbmVzk', title: "The Sad Reality of the Japan's Pokemon Card Market",                         channelName: 'Randolph Pokemon'          },
  // Batch 5
  { videoId: 'xH1hXzSB3Ec', title: "What's Really About To Happen To Pokémon Card Prices?",                      channelName: 'Phillips Collectibles'     },
  { videoId: 'HpKbB3CGmN4', title: 'a broke persons guide to collecting pokemon cards in 2026',                   channelName: 'Snomnom'                   },
  // Batch 6 — July 2026 correction signal
  { videoId: 'iJjZxbMm8-k', title: 'Pokemon Cards Are Officially Coming Down (And Quick!)',                       channelName: 'Phillips Collectibles'     },
];

// Seed data from "Everything's About to Change... And Vintage Pokémon Will Explode"
// by PikaPikaPaPa (Jul 2025). Re-used as fallback when KV is empty or unreachable.
const MARKET_INTEL_SEED = {
  ts: 1752192000000, // 2025-07-11
  framework: {
    era: 'All eras — WOTC, modern SV/SwSh, Japanese, sealed product',
    priority: ['First Edition', 'Unlimited'],
    sweet_spot: 'PSA 9 when PSA 10 has significantly outpaced it (e.g. 3× in 1yr while PSA 9 only +14%). PSA 10 is often out of reach for casual collectors; the PSA 9 captures most of the upside at a fraction of the price.',
    japanese_cards: {
      summary: 'Japanese Pokémon cards offer structural advantages over English equivalents: PSA 10 hit rates 60–89% vs substantially lower for EN, 20–80% price premium for equivalent condition on vintage, and every tracked JP sealed box has appreciated 155–1,838% above retail. Gen 1 & 2 and all shiny sets — prefer JP when price is comparable or lower. Gen 3+ default to EN unless JP is >20% cheaper, EXCEPT shiny sets where JP is always preferred.',
      era_guide: {
        gen1_gen2: 'Prefer JP if JP price ≤ EN price. Base Set JP (1996), Jungle, Fossil, Team Rocket, Gym Heroes/Challenge — distinct thick borders, typically better centering than EN Unlimited. Key species: Charizard, Blastoise, Venusaur, Mewtwo, Alakazam, Gengar, Gyarados, Zapdos, Raichu.',
        neo_era: 'Strong JP preference. Shining cards (Neo Revelation/Destiny JP) are structurally scarcer than EN Shining cards. Shining Gyarados, Shining Charizard, Shining Mewtwo, Shining Celebi — buy JP when available at comparable price.',
        ex_gold_star: 'JP Gold Stars from Offense and Defense of the Furthest Ends (EX Dragon Frontiers EN equiv) and Team Rocket Returns JP. Charizard Gold Star, Rayquaza Gold Star, Umbreon Gold Star — JP versions preferred for condition and print quality.',
        gen3_plus: 'Default EN for Gen 3+. Exception: all shiny sets — always prefer JP regardless of price gap. Exception 2: JP >20% cheaper than EN — take the JP.',
        jp_exclusive_shiny: 'JP-exclusive shiny sets with no EN equivalent: Ultra Shiny GX (2018) — Umbreon GX SR 229/150, Mewtwo GX SR; Shiny Star V (2020) — Charizard VMAX SR, Black Kyurem VMAX SR; Shiny Treasure ex (2023) — Gardevoir ex SAR 348/190, Mew ex SAR 347/190. These represent the highest JP-specific demand.',
        sealed: 'MEGA-era JP booster boxes (~$53/¥8,000) remain accessible with 30th Anniversary upside. Abyss Eye (Pitch Black JP equiv) leads EN pricing by 2–4 weeks — use JP sold prices as EN price forecast.',
      },
      buy_strategy: [
        'Gen 1 & 2: always check JP price first — buy JP if JP price ≤ EN price',
        'Shiny sets (any era): always prefer JP regardless of price comparison — print quality advantage is decisive',
        'Gen 3+ non-shiny: prefer EN unless JP is >20% cheaper',
        'JP market corrects faster than EN on speculation — patience during JP corrections creates structural entry points that do not appear on the EN side',
        'Grade JP selectively: only submit cards with clean centering; PSA 10 hit rate 60–89% makes submission economics work at lower raw price floors than EN',
        'JP-exclusive sets (Ultra Shiny GX, Shiny Star V, Shiny Treasure ex) have no EN equivalent — demand is global but supply is JP-only; collect before Western demand fully discovers them',
      ],
      key_sets: [
        { set: 'Base Set JP (Expansion Pack)', year: 1996, note: 'Foundation vintage; thick borders; Charizard/Blastoise/Venusaur/Mewtwo are definitive JP blue chips' },
        { set: 'Neo Revelation / Neo Destiny JP', year: '2000–2001', note: 'Shining cards; JP versions scarcer than EN; Shining Gyarados is the #1 shiny card' },
        { set: 'Offense & Defense of the Furthest Ends JP', year: 2006, note: 'Gold Star Charizard source (EN: EX Dragon Frontiers); among the most valuable JP sets' },
        { set: 'Ultra Shiny GX', year: 2018, note: 'JP-exclusive; 150-card set; Umbreon GX SR 229/150 and Mewtwo GX SR are headliners' },
        { set: 'Shiny Star V', year: 2020, note: 'JP-exclusive; Charizard VMAX SR is the flagship; strong sustained demand' },
        { set: 'Shiny Treasure ex', year: 2023, note: 'JP-exclusive 190-card set; Gardevoir ex SAR 348/190 and Mew ex SAR 347/190 lead demand' },
        { set: 'Abyss Eye (Pitch Black JP equiv)', year: 2026, note: 'JP prerelease price leads EN by 2–4 weeks; Mega Darkrai ex leads the set' },
      ],
    },
    buy_signals: [
      'PSA 10 pop < 500 — genuinely scarce in top grade',
      'PSA 9 pop < 1 000 — still findable, price gap to PSA 10 represents opportunity',
      'PSA 10 price growing >2× faster than PSA 9 over past year — the market is underpricing PSA 9',
      'Iconic Pokémon: Zapdos, Mewtwo, Charizard, Mew, Dragonite, Venusaur, Gengar',
      'First Edition print — always prefer over Unlimited even at a grade lower',
      'Set rarity: Fossil, Team Rocket, Gym Challenge, Neo, WOTC Black Star Promos',
      'Budget raw WOTC entry under $10: iconic-species commons/uncommons from Jungle, Fossil, Team Rocket remain ≤$10 raw — a single PSA 10 can return 50–200× the card cost; bulk-buy-and-submit is viable even at small scale (Phillips Collectibles 2026)',
      '$100–$300 investor bracket covers both vintage WOTC PSA 9 holos and modern Alternate Art PSA 10s from Evolving Skies — optimal range balancing upside and liquidity for new investors (PokeKingShop 2026)',
      'Japanese vintage cards at correction lows offer structural buy opportunities — the JP market overshoots on panic while collector fundamentals (scarcity, trophy status) remain intact through speculative cycles (Henrys Poke Corner 2026)',
      'Vintage WOTC cards often trade below modern Alternate Art prices despite 25+ years of fixed supply — a pricing paradox that corrects as the nostalgia cohort reaches peak income years (Sleeve No Card Behind 2026)',
      'Corrections in structurally sound Pokémon markets are accumulation windows, not exit signals — experienced collectors increase positions during temporary price dips (Phillips Collectibles 2026)',
      'Crowd-buying behaviour precedes explosive short-term gains — when multiple major channels highlight the same card simultaneously, price acceleration typically follows within weeks (PikaPikaPaPa 2026)',
      'Alternate Art and Special Illustration Rare cards exhibit a recurring spike-reset cycle; each reset establishes a higher structural floor — the right entry is the reset, not the spike (Danny Phantump 2026)',
      'Professional grading is only economically justified when PSA 10 value is at least 5× raw price and the card has a realistic chance at gem mint — most modern bulk fails this threshold (Dewgong Don 2026)',
      'Sealed product from discontinued sets (Evolving Skies ETBs, Brilliant Stars booster boxes) appreciates reliably once out-of-print — fixed supply compounds with growing demand (multiple creators 2026)',
      'Shiny Pokémon cards — Japanese variants command 40–80% price premiums over English equivalents due to lower print runs and superior print quality; JP shiny versions are structurally better value across all eras (Sleeve No Card Behind 2026)',
      'Neo-era Shining cards (Gyarados, Charizard, Mewtwo, Celebi from Neo Revelation/Destiny) are the scarcest vintage shiny prints — PSA 10 pop under 200 for each; Shining Gyarados PSA 10 ~$50k is the #1 most historically significant shiny card (Sleeve No Card Behind 2026)',
      'Gold Star era (EX Dragon Frontiers, EX Deoxys, POP Series 5, Team Rocket Returns) represents peak mid-2000s shiny printing — Charizard Gold Star PSA 10 ~$22k, Rayquaza Gold Star PSA 10 ~$22k, Umbreon Gold Star raw ~$1,800 are the strongest holds (Sleeve No Card Behind 2026)',
      'Modern shiny sets (Ultra Shiny GX, Shiny Treasure ex) offer lower entry points with steady appreciation — Umbreon GX SR 229/150, Gardevoir ex SAR 348/190, Mew ex SAR 347/190 are standout picks; Japanese print quality advantage amplified in modern sets (Sleeve No Card Behind 2026)',
      'Pitch Black (July 2026 release) — wait 3–6 weeks post-launch before buying singles as global pack openings push prices down; Mega Darkrai ex SIR ($440) and MHR ($996) are the set chase cards; Mega Zeraora ex SIR ($184) is best-value SIR at launch with projected settled range $150–$280 (Top 10 Pokemon 2026)',
      'Pitch Black set contains only 6 SIRs out of 120 cards (36 total secret rares) — concentrated collector spend on a small number of cards historically sustains SIR premiums longer than sets with more SIRs (Top 10 Pokemon 2026)',
      'Summer 2026 TCG correction: modern singles down 20–45% from 2025 peaks — the correction is supply/speculation-driven, not demand-driven; experienced collectors treat this as a structured accumulation window ahead of Q4 2026 and the 30th Anniversary catalyst (PokeAnalyst Ed 2026)',
      'Japanese Pokémon card investing advantages: PSA 10 hit rates run 60–89% for Japanese vs substantially lower for English; every tracked Japanese sealed box has appreciated above retail (155%–1,838% range); MEGA-era Japanese boxes (~$53/¥8,000) flagged as accessible 30th Anniversary entry point (Phillips Collectibles 2026)',
      '30th Anniversary (October 2026) is a structural demand catalyst — milestone drives renewed mainstream and collector interest across all eras; Q4 2026 surge expected after summer accumulation window; older SV sets already surging in anticipation (It Was Never A Phase Cards 2026)',
      'Pitch Black post-launch price tracking confirms 3–6 week softening pattern on schedule — singles settling toward floor; older Scarlet & Violet sets surging concurrently as new-release attention widens market participation (It Was Never A Phase Cards 2026)',
      '"Most expensive card for every Pokémon species" reference data: 1st Ed PSA 10 Charizard ~$954,800, 1st Ed PSA 10 Blastoise ~$138,880, PSA 10 Venusaur ~$55,000, Mega Gengar ex SIR ~$960 for modern; use this as ceiling pricing context when evaluating species-level collector demand (ThePokePlanet 2026)',
      'Budget standouts under $20: modern Illustration Rares from 2023–2025 sets at summer 2026 correction lows are prime accumulation targets — strong art of popular Pokémon and trainers with PSA 10 upside of 4–8× raw price (Jordan Collects 2026)',
      'Cheap cards poised to rise: look for Illustration Rares and Special Illustration Rares from popular sets where the reprint risk is low and the Pokémon has broad collector appeal — these are the "future standouts" in the $5–$20 range (PokeBim 2026)',
      '$500 portfolio allocation framework: (1) 40% vintage WOTC PSA 9s from iconic sets, (2) 30% modern SIR/AA PSA 10s from Evolving Skies / high-demand SV sets, (3) 20% JP exclusives at correction lows, (4) 10% sealed ETB from discontinued sets — balanced across conviction tiers (Phillips Collectibles 2026)',
      'Ascended Heroes (2026 set): early correction following launch is creating accumulation window — iconic species in this set have historically recovered from post-launch dips within 6–8 weeks; monitor for stabilisation before committing (Danny Phantump 2026)',
      'JP switching trend (2026): mainstream EN collectors are actively migrating to JP equivalents for the first time — this structural demand shift is still early; JP cards of popular species that EN collectors know well (Charizard, Pikachu, Mewtwo, Umbreon) will see outsized demand pressure (Phillips Collectibles / jMac Collects 2026)',
      'JP cards held long-term outperform EN equivalents on a risk-adjusted basis: JP fixed supply + improving Western familiarity + PSA 10 grade advantage creates compounding tailwind; "holding JP is being richer than you think" — the unrealised gain is structural (Collector\'s Dream TCG 2026)',
      'JP market volatility (2026): Japanese card prices are experiencing unusual short-term moves driven by domestic speculation and ETF-like behaviour — this creates both risks (short-term overpaying) and opportunities (corrections below intrinsic value); focus on vintage and JP-exclusive cards, avoid chasing recent JP hype moves (Randolph Pokemon / Top Chaserz 2026)',
    ],
    macro: 'TPCi leased 1 M+ sq ft in NC for new printing facility → modern card supply will surge, flippers exit, prices temporarily dip then recover stronger. PSA grading volume now >1 M TCG cards/month (4 of last 5 months) — modern card PSA pops will be enormous. Vintage WOTC pops grow only as sealed product is opened (rare). Conclusion: relative scarcity of vintage PSA 10s/9s increases over time.\n\nUK MARKET NOTE (PokeTamer 2025): First Edition and Shadowless Base Set cards were almost entirely released in the US — genuinely rare to find in UK bulk lots. Most UK-sourced vintage cards will be Unlimited or 4th Print. Base Set print run hierarchy by value: 1st Edition > Shadowless > Unlimited > 4th Print. Exception: every Base Set Machamp has a 1st Ed stamp (came with starter deck) — only meaningful value if also Shadowless. Price discovery: TCGPlayer listings are overinflated (US-biased); use eBay sold/completed to find real market value, especially for GBP. Real-world data point: 360-card "well-loved" vintage WOTC binder (Base Set–Gym Challenge) sold on eBay UK for £16,945 in 2025 with £1,585 profit after fees.\n\nBUDGET VINTAGE ENTRY POINTS (Phillips Collectibles 2026): Despite a rising vintage market, mid-tier WOTC sets (Jungle, Fossil, Team Rocket, Neo) still contain cards featuring iconic species available raw under $10. These represent extreme value asymmetry — the PSA 10 of a popular species from any WOTC set typically trades $200–$2,000+. Key strategy: buy in bulk, submit selectively, hold the gems. Eight specific cards identified as severely under-priced at sub-$10 raw.\n\nSUB-$300 INVESTMENT SWEEP (PokeKingShop 2026): The $100–$300 price window is the most accessible entry zone with meaningful upside. It simultaneously covers: (1) vintage WOTC PSA 9 holos from Jungle/Fossil/Base Set; (2) modern Evolving Skies Alternate Arts (Umbreon VMAX, Rayquaza VMAX) in PSA 9–10; (3) sealed ETBs from popular out-of-print sets. As the "nostalgia cohort" (Millennials/Gen Z who grew up with Gen I–III) enters peak income years through 2027–2030, demand for both vintage and iconic modern cards will structurally increase.\n\nJAPANESE MARKET CORRECTION (Henrys Poke Corner 2026): The Japanese Pokémon card market underwent a significant speculative correction. Patient investors who understand JP fundamentals — fixed vintage print runs, genuine scarcity of gem-mint copies, and strong domestic collector demand — treat such corrections as structural entry points. The crash is speculation-driven, not demand-driven; the collector floor for genuinely scarce JP cards remains intact.\n\nVINTAGE vs MODERN PRICING PARADOX (Sleeve No Card Behind 2026): WOTC-era vintage holos with 25+ years of fixed supply sometimes trade below modern Alternate Art and SIR cards printed in the millions. The convergence thesis: as the nostalgia cohort ages into peak income years (2026–2032), vintage supply stays fixed while demand compounds. This pricing gap historically corrects — vintage is structurally undervalued relative to modern prints in the long run.\n\n2026 MARKET BIFURCATION (Phillips Collectibles 2026): Multiple Phillips Collectibles videos document a bifurcated 2026 market — modern JP, new-set promos, and sealed product near all-time highs while vintage WOTC is in a cyclical correction. Core thesis: dips in structurally sound assets are accumulation opportunities, not exits. Framework from 7 Timeless Rules: buy iconic species, buy scarcity, buy grade asymmetry, hold minimum 2 years, avoid hype-driven modern bulk, prioritise 1st Edition, never over-expose to a single card.\n\nALTERNATE ARTS / SIR CYCLICAL PATTERN (Danny Phantump 2026): Alternate Art and Special Illustration Rare cards from Sword & Shield and Scarlet & Violet exhibit a repeating spike-reset cycle where each reset establishes a higher structural floor than the prior one. Evolving Skies (Umbreon VMAX AA, Rayquaza VMAX AA) and top Scarlet & Violet SIRs are the most liquid modern investment vehicles. Ascended Heroes set evaluation: early-set price corrections can be ideal accumulation windows for iconic species in new sets.\n\nGRADING ECONOMICS (Dewgong Don 2026): Professional grading is only economically justified when the card has a realistic shot at PSA 9+ given visible condition, PSA 10 value is at least 5× the raw price, and grading fees are recoverable within the expected hold period. Most modern bulk fails this test at 2026 grading fees. For vintage WOTC, selective submission of well-centred, corner-sharp cards from iconic sets remains viable.\n\nJULY 2026 BROAD CORRECTION (Phillips Collectibles 2026-07-16): An aggressive, broad-based price correction is underway across modern Pokémon cards as of mid-July 2026. Charizard SIR (Pokémon 151) PSA 10 and Mega Charizard X PSA 10 are each down close to $1,000 from recent highs. Blastoise 151, Greninja PSA 10, Mega Greninja SIR, Mega Lucario Mega Hype Rare, and Pokémon 151 ETBs all falling. Critically, Japanese cards — which typically lag English moves — are also dropping, signalling a broader correction rather than an EN-only event. Creator assessment: "this time is different" — the correction has more structural characteristics than prior seasonal dips, driven by overcorrection from recent highs rather than demand collapse. STANDOUT CAUTION: Mega Evolution SIRs (Mega Charizard X, Mega Greninja, Mega Lucario MHR) are taking the heaviest hits — avoid buying into these at current elevated price points. 151 SIRs and ETBs in active correction. Long-term thesis remains intact but short-term pressure is real and accelerating. STRATEGY IMPLICATION: Wait for the correction to stabilise before entering modern SIRs; rotate focus toward vintage WOTC and JP fundamentals in the current climate.',
  },
  featured_picks: [
    { name: 'Shining Gyarados', set: 'Neo Revelation', grade: 'PSA 10', price_usd: 50000, note: 'First-ever shiny card printed (1999); PSA 10 pop ~150; definitive Neo-era shiny blue chip (Sleeve No Card Behind 2026)' },
    { name: 'Umbreon Gold Star', set: 'POP Series 5', grade: 'Raw', price_usd: 1800, note: 'Highest-demand Gold Star after Charizard/Rayquaza; strong Eeveelution collector base; PSA 10 well above raw (Sleeve No Card Behind 2026)' },
    { name: 'Gardevoir ex SAR', set: 'Shiny Treasure ex', grade: 'Raw', price_usd: 120, note: 'Modern shiny standout; rarity and strong demand driving steady appreciation; JP version preferred (Sleeve No Card Behind 2026)' },
    { name: 'Mega Zeraora ex SIR', set: 'Pitch Black', grade: 'Raw', price_usd: 184, note: 'Best-value SIR at July 2026 launch; projected settled price $150–$280; buy after initial wave subsides (Top 10 Pokemon 2026)' },
    { name: 'Mega Darkrai ex SIR', set: 'Pitch Black', grade: 'Raw', price_usd: 440, note: 'Set chase card alongside $996 MHR version; Akira Egawa illustration; best long-hold SIR in the set (Top 10 Pokemon 2026)' },
    { name: '1st Ed Fossil Zapdos', set: 'fossil', grade: 'PSA 9', price_usd: 330, psa10_usd: 3300, psa10_pop: 378, note: 'PSA 10 tripled in 1 yr; PSA 9 only +14% — strong asymmetry' },
    { name: '1st Ed Team Rocket Dark Dragonite', set: 'base3', grade: 'PSA 9', price_usd: 850, psa10_usd: 7700, psa10_pop: 223, note: 'PSA 10 rose from $3k to $7.7k; PSA 9 flat at ~$850 with 2 261 in holders' },
    { name: '1st Ed Gym Challenge Team Rocket\'s Mewtwo', set: 'gym2', grade: 'PSA 9', price_usd: 837, psa10_usd: 6000, psa9_pop: 953, note: 'Creator\'s top pick. PSA 10 from $1.5k to $6k; PSA 9 sub-$900 with sub-1k pop' },
    { name: '1st Ed Gym Challenge Erika\'s Venusaur', set: 'gym2', grade: 'PSA 9', price_usd: 881, psa10_usd: 5500, psa10_pop: 107, note: 'Only 107 PSA 10s ever graded — exceptional scarcity' },
    { name: 'WOTC Black Star Promo Mew', set: 'basep', grade: 'PSA 9', price_usd: 285, psa10_usd: 4525, psa9_pop: 3239, note: 'Mew brand momentum strong. PSA 10 from $1k to $4.5k in 1 yr' },
  ],
  sources: [
    { video_id: '_cyddOc1SMU', channel: 'Sleeve No Card Behind',    title: 'The Entire History of Shiny Pokémon Cards',                             published: '2026-07-14' },
    { video_id: 'w1HHF9GUiwo', channel: 'Top 10 Pokemon',          title: 'Top 10 EXPENSIVE Pitch Black Pokemon Cards!',                          published: '2026-07-14' },
    { video_id: '5d7tjpVKFOc', channel: 'PokeAnalyst Ed',          title: "Your Pokémon Cards Dropped 42% This Summer — Here's Why That's Good", published: '2026-07-14' },
    { video_id: 'PawseRgrbzw', channel: 'ThePokePlanet',           title: 'MOST EXPENSIVE Card for EVERY Pokemon EVER',                          published: '2026-07-14' },
    { video_id: 'tZtCOYKD5IY', channel: 'It Was Never A Phase Cards', title: 'Is The Summer Slump Even That Bad? Pokemon Market Update',          published: '2026-07-14' },
    { video_id: 'hLvJqNVmbE8', channel: 'Phillips Collectibles',   title: 'Why Investing In Japanese Pokemon Cards Is A Smart Decision!',         published: '2026-07-14' },
    { video_id: 'JUeU36q_JUk', channel: 'Phillips Collectibles',   title: "How I'd Spend $500 In The Current Pokemon Market!",                      published: '2026-07-14' },
    { video_id: 'HP0CqeKwkLQ', channel: 'Phillips Collectibles',   title: '10 ULTIMATE Japanese Pokémon Cards To Buy!',                              published: '2026-07-14' },
    { video_id: 'McA4qmms49Q', channel: 'Phillips Collectibles',   title: 'Why It Seems Everyone Is Switching To Japanese Pokemon Cards...',         published: '2026-07-14' },
    { video_id: 'MhKB5tjbfYE', channel: 'Phillips Collectibles',   title: 'Something Weird Is Happening With Japanese Pokemon Cards...',             published: '2026-07-14' },
    { video_id: 'sj2-b1SKiUU', channel: 'PokeBim',                 title: '10 Cheap Pokemon Cards That Will Explode In Price! (2026)',               published: '2026-07-14' },
    { video_id: 'Y1D0cmSOliY', channel: 'Jordan Collects',         title: '10 POKEMON CARDS TO BUY NOW!',                                            published: '2026-07-14' },
    { video_id: '1X3zfYV8oQE', channel: 'Jordan Collects',         title: '10 POKEMON CARDS TO BUY UNDER $20!!!',                                   published: '2026-07-14' },
    { video_id: '3QXPiSXf8to', channel: 'Jordan Collects',         title: '10 POKEMON CARDS TO BUY NOW!',                                            published: '2026-07-14' },
    { video_id: 'gspIRMC8-nQ', channel: 'Jordan Collects',         title: '10 POKEMON CARDS TO BUY NOW!',                                            published: '2026-07-14' },
    { video_id: 'WUwy56CCj1Q', channel: 'TyDean Cards',            title: 'Buy These Pokemon Cards NOW While They Are Still Affordable',             published: '2026-07-14' },
    { video_id: '2XcOAf8ecSY', channel: 'The Card Science',        title: "5 Cheap Pokemon Cards I'm Buying NOW!",                                   published: '2026-07-14' },
    { video_id: 'Sg3tSUGmbKc', channel: 'jMac Collects',           title: 'Why You Should Start Buying Japanese Pokémon Cards (The Complete Guide)', published: '2026-07-14' },
    { video_id: 'HYwzO2OOadQ', channel: "Collector's Dream TCG",   title: 'If You HOLD Japanese Cards, You Are RICHER Than You Think.',              published: '2026-07-14' },
    { video_id: '23wyNg1VMSI', channel: 'Top Chaserz',             title: 'The Ugly Truth About Japanese Pokemon Card Prices',                       published: '2026-07-14' },
    { video_id: 'rcqdvtkqkCo', channel: 'Card Penguin Pokemon',    title: "Japanese Pokemon Cards are WEIRD Right Now (And That's OKAY!)",           published: '2026-07-14' },
    { video_id: 'T_XEDV4gBAE', channel: 'Randolph Pokemon',        title: 'My Japanese Pokémon Card Investment a Year Later...',                      published: '2026-07-14' },
    { video_id: 'OaYY0VbmVzk', channel: 'Randolph Pokemon',        title: "The Sad Reality of the Japan's Pokemon Card Market",                      published: '2026-07-14' },
    { video_id: '1RD5N457AaI', channel: 'PikaPikaPaPa', title: "Everything's About to Change... And Vintage Pokémon Will Explode", published: '2025-07-11' },
    { video_id: 'yCAE55_kkf4', channel: 'PokeTamer', title: 'Vintage Pokémon Cards — What Are They Actually Worth in 2025?', published: '2025-01-01' },
    { video_id: '41uDYckkWGI', channel: 'Dewgong Don', title: "Most Pokemon Cards Aren't Worth Grading. Here's How to Tell.", published: '2026-07-12' },
    { video_id: 'KHxEw59qjCI', channel: 'Phillips Collectibles', title: "I Can't Believe These 8 Pokémon Cards Are Still Under $10!", published: '2026-07-12' },
    { video_id: '_rkj-BdSQII', channel: 'PokeKingShop', title: 'The Best Pokémon Cards To Invest In Under $300', published: '2026-07-12' },
    { video_id: 'ti8YuWTfhTo', channel: "Henry's-Poke-Corner", title: "The Japanese Pokemon Crash Just Made You Rich (If You're Smart)", published: '' },
    { video_id: 'qNgtRA-AFME', channel: 'Danny Phantump', title: 'Why Vintage Pokemon Cards are Being Bought!', published: '' },
    { video_id: 'mQE8W5gc5Cw', channel: 'Phillips Collectibles', title: "I'm Not Worried About Pokémon Card Prices Dropping Right Now...", published: '' },
    { video_id: 'F0peR4qq0gE', channel: 'Phillips Collectibles', title: 'The Vintage Pokemon Card Crash EXPLAINED.', published: '' },
    { video_id: '6-RDG7TqYJk', channel: 'Pack Heads', title: '5 Tips for Collecting Pokemon Cards in 2026 - Casual Collector Edition', published: '' },
    { video_id: '9q4bYI6VWBQ', channel: 'Phillips Collectibles', title: '7 Timeless Pokémon Investing Rules Every Collector Should Know!', published: '' },
    { video_id: '2reTF00uuSA', channel: 'Phillips Collectibles', title: 'The Future of Pokémon Investing No One Is Ready For!', published: '' },
    { video_id: 'JKwX_Dkenr0', channel: 'Sleeve No Card Behind', title: 'Why Vintage Cards Are Cheaper Than Modern', published: '' },
    { video_id: 'zWt4d_2BPyE', channel: 'Phillips Collectibles', title: 'The Real Reason Pokemon Cards Are Still Expensive...', published: '' },
    { video_id: 'YiZjF_vus7M', channel: 'ZyroCards', title: "I Opened Pokémon Boxes with the BEST Hit Rates... Is It True?", published: '' },
    { video_id: 'x8jOk4-AkQ0', channel: 'PikaPikaPaPa', title: 'Some Are EXPLODING... Some Are CRASHING... ALL of Them Are HUGE Opportunities', published: '' },
    { video_id: 'mMcZspyjgf8', channel: 'Danny Phantump', title: 'There Go The Alternate Arts...AGAIN!', published: '' },
    { video_id: 'hvtmQKv8O3w', channel: 'Danny Phantump', title: 'Is Now FINALLY The Time To Buy Ascended Heroes Pokemon Cards?', published: '' },
    { video_id: 'v8mNwFxm2rg', channel: 'PikaPikaPaPa', title: "Top 10 Pokémon Cards Everyone's Buying... STUPID Gains Always Follow", published: '' },
    { video_id: 'WxwPb2J18D4', channel: 'Phillips Collectibles', title: 'How to Collect Pokemon Cards Without Going Broke In This Insane 2026 Market!', published: '' },
    { video_id: 'HpKbB3CGmN4', channel: 'Snomnom', title: 'a broke persons guide to collecting pokemon cards in 2026', published: '' },
    { video_id: 'hYYQy9nmvyA', channel: 'Pokermon', title: 'Absolutely BROKEN Pokemon Investing Strat', published: '' },
    { video_id: 'iJjZxbMm8-k', channel: 'Phillips Collectibles', title: 'Pokemon Cards Are Officially Coming Down (And Quick!)', published: '2026-07-16' },
  ],
};

// GET /market-intel — returns cached Pokémon TCG market intelligence
// POST /market-intel — bypasses rate gate, fires background re-analysis, returns immediately
async function handleMarketIntel(request, env, ctx) {
  if (request.method === 'POST') {
    // Clear the rate gate so the next refreshMarketIntel call actually runs
    if (env.SYNC_KV) {
      try { await env.SYNC_KV.delete(MARKET_INTEL_CHECK_KEY); } catch {}
    }
    ctx.waitUntil(refreshMarketIntel(env));
    return new Response(JSON.stringify({ ok: true, scheduled: true }), {
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
    });
  }
  const ch = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  let intel = MARKET_INTEL_SEED;
  if (env.SYNC_KV) {
    try {
      const raw = await env.SYNC_KV.get(MARKET_INTEL_KV_KEY);
      if (raw) intel = JSON.parse(raw);
    } catch {}
  }
  return new Response(JSON.stringify(intel), { headers: { ...ch, 'Content-Type': 'application/json' } });
}

// Helper: fetch + clean a YouTube VTT transcript → plain text (max maxChars)
async function _fetchTranscript(videoId, maxChars = 12000) {
  try {
    const res = await fetch(
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=vtt`,
      { cf: { cacheTtl: 86400 } },
    );
    if (!res.ok) return '';
    const vtt = await res.text();
    return vtt
      .replace(/WEBVTT[\s\S]*?\n\n/, '')
      .replace(/\d{2}:\d{2}[^\n]*\n/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, maxChars);
  } catch { return ''; }
}

// Helper: call Claude Haiku to extract structured insights from a transcript
async function _extractInsights(transcript, channelName, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `Pokémon TCG market analyst. Extract actionable insights from this ${channelName} transcript as JSON (omit keys you cannot populate). Covers any card era — vintage WOTC, modern, Japanese, sealed product, graded slabs, or set releases.\n{"key_thesis":string,"buy_signals":[string],"featured_picks":[{"name":string,"set":string,"grade":string,"price_usd":number,"note":string}],"macro_notes":string}\n\nTranscript:\n${transcript}`,
      }],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const text = j.content?.[0]?.text || '';
  const m = text.match(/\{[\s\S]+\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Merge extracted insights into the running intel object (mutates intel)
function _mergeInsights(intel, extracted, videoId, channelName, title, published) {
  intel.sources = intel.sources || [];
  if (!intel.sources.find(s => s.video_id === videoId)) {
    intel.sources.unshift({ video_id: videoId, channel: channelName, title, published: published || '' });
  }
  if (extracted.featured_picks?.length) {
    const existingNames = new Set((intel.featured_picks || []).map(p => p.name));
    for (const p of extracted.featured_picks) {
      if (!existingNames.has(p.name)) {
        intel.featured_picks = [p, ...(intel.featured_picks || [])];
        existingNames.add(p.name);
      }
    }
  }
  if (extracted.macro_notes) {
    intel.framework = intel.framework || {};
    intel.framework.macro = (extracted.macro_notes + '\n\n' + (intel.framework.macro || '')).slice(0, 4000);
  }
  intel.ts = Date.now();
}

// Cron task: (1) watch all channels' RSS for new videos, (2) drain backfill queue
async function refreshMarketIntel(env) {
  if (!env.SYNC_KV || !env.ANTHROPIC_API_KEY) return;

  // Rate-gate: once per day (cron runs at 06:00 UTC; gate ensures we don't double-process)
  const lastCheck = await env.SYNC_KV.get(MARKET_INTEL_CHECK_KEY);
  if (lastCheck && Date.now() - Number(lastCheck) < 20 * 3600 * 1000) return;
  await env.SYNC_KV.put(MARKET_INTEL_CHECK_KEY, String(Date.now()), { expirationTtl: 2 * 24 * 3600 });

  // Load existing intel + seen-video set.
  // Always merge with current MARKET_INTEL_SEED so manually-curated fields
  // (buy_signals, japanese_cards, macro) are applied even when KV has an older blob.
  let intel = { ...MARKET_INTEL_SEED };
  try {
    const r = await env.SYNC_KV.get(MARKET_INTEL_KV_KEY);
    if (r) {
      const stored = JSON.parse(r);
      intel = {
        ...stored,
        framework: {
          ...(stored.framework || {}),
          // Seed-curated fields always win — they're updated by code deploys
          buy_signals:    MARKET_INTEL_SEED.framework.buy_signals,
          japanese_cards: MARKET_INTEL_SEED.framework.japanese_cards,
        },
      };
    }
  } catch {}
  let seenIds = new Set((intel.sources || []).map(s => s.video_id));
  try {
    const sv = await env.SYNC_KV.get(VINTAGE_SEEN_KEY);
    if (sv) JSON.parse(sv).forEach(id => seenIds.add(id));
  } catch {}

  let processed = 0;
  const toProcess = []; // {videoId, title, published, channelName}

  // 1. Check each channel RSS for new videos — prepend any new ones to the stored channel list
  for (const { id: channelId, name: channelName } of MARKET_CHANNELS) {
    try {
      const rssRes = await fetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
        { cf: { cacheTtl: 3600 } },
      );
      if (!rssRes.ok) continue;
      const rss = await rssRes.text();
      const entryRx = /<entry>([\s\S]*?)<\/entry>/g;
      const newVids = [];
      let m;
      while ((m = entryRx.exec(rss)) !== null) {
        const e = m[1];
        const vid = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
        const tit = (e.match(/<title>([^<]+)<\/title>/) || [])[1];
        const pub = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
        if (!vid || !tit) continue;
        if (!seenIds.has(vid)) {
          newVids.push({ id: vid, title: tit, published: pub });
          toProcess.push({ videoId: vid, title: tit, published: pub, channelName });
        }
      }
      // Prepend new videos to the stored channel video list in KV
      if (newVids.length > 0) {
        try {
          const kvKey = `channel-videos:${channelId}`;
          const existing = await env.SYNC_KV.get(kvKey);
          const stored = existing ? JSON.parse(existing) : { channelId, name: channelName, videos: [] };
          const existingIds = new Set(stored.videos.map(v => v.id));
          const toAdd = newVids.filter(v => !existingIds.has(v.id));
          if (toAdd.length > 0) {
            stored.videos = [...toAdd, ...stored.videos];
            stored.total = stored.videos.length;
            await env.SYNC_KV.put(kvKey, JSON.stringify(stored), { expirationTtl: 365 * 24 * 3600 });
            // Update channel index
            const idxRaw = await env.SYNC_KV.get('channel-index');
            if (idxRaw) {
              const idx = JSON.parse(idxRaw);
              const entry = idx.find(c => c.channelId === channelId);
              if (entry) { entry.total = stored.total; await env.SYNC_KV.put('channel-index', JSON.stringify(idx)); }
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Drain backfill queue — take enough to fill up to MARKET_BACKFILL_PER_RUN total
  let backfillQueue = [];
  try { const bq = await env.SYNC_KV.get(VINTAGE_BACKFILL_KEY); if (bq) backfillQueue = JSON.parse(bq); } catch {}
  const slotsLeft = MARKET_BACKFILL_PER_RUN - toProcess.length;
  if (slotsLeft > 0 && backfillQueue.length > 0) {
    // Find the channel name for backfill items (use 'Community' as fallback)
    const batch = backfillQueue.splice(0, slotsLeft);
    for (const { id: videoId, title } of batch) {
      if (!seenIds.has(videoId)) toProcess.push({ videoId, title, published: '', channelName: 'Community' });
    }
    // Save the trimmed queue back
    await env.SYNC_KV.put(VINTAGE_BACKFILL_KEY, JSON.stringify(backfillQueue),
      { expirationTtl: 365 * 24 * 3600 });
  }

  // 3. Inject pinned videos that haven't made it into sources yet
  const processedIds = new Set(intel.sources.map(s => s.video_id));
  for (const pinned of MARKET_PINNED_VIDEOS) {
    if (!processedIds.has(pinned.videoId) && !toProcess.some(t => t.videoId === pinned.videoId)) {
      seenIds.delete(pinned.videoId); // allow retry even if previously attempted
      toProcess.unshift(pinned);
    }
  }

  // 4. Process each candidate video
  for (const { videoId, title, published, channelName } of toProcess) {
    if (processed >= MARKET_BACKFILL_PER_RUN) break;
    seenIds.add(videoId); // mark before processing so retries skip it
    const transcript = await _fetchTranscript(videoId);
    if (transcript.length < 200) continue;
    try {
      const extracted = await _extractInsights(transcript, channelName, env.ANTHROPIC_API_KEY);
      if (extracted) _mergeInsights(intel, extracted, videoId, channelName, title, published);
      processed++;
    } catch {}
  }

  // Always write back — advances ts, applies seed merges, even if no transcripts processed
  intel.ts = Date.now();
  await env.SYNC_KV.put(MARKET_INTEL_KV_KEY, JSON.stringify(intel), { expirationTtl: 90 * 24 * 3600 });
  // Always persist the updated seen set
  await env.SYNC_KV.put(VINTAGE_SEEN_KEY, JSON.stringify([...seenIds]),
    { expirationTtl: 365 * 24 * 3600 });
}

// ---- Population & sales data KV helpers ----
// KV keys: pop:<cardId>  /  sales:<cardId>
const POP_KV_TTL   = 7 * 24 * 3600;  // 7 days — PSA pop changes slowly
const SALES_KV_TTL = 24 * 3600;      // 24 hours — sales comps refresh daily

async function _kvGetPop(env, cardId) {
  if (!env.SYNC_KV) return null;
  try {
    const raw = await env.SYNC_KV.get(`pop:${cardId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _kvPutPop(env, cardId, data) {
  if (!env.SYNC_KV) return;
  await env.SYNC_KV.put(`pop:${cardId}`, JSON.stringify(data), { expirationTtl: POP_KV_TTL });
}

async function _kvGetSales(env, cardId) {
  if (!env.SYNC_KV) return null;
  try {
    const raw = await env.SYNC_KV.get(`sales:${cardId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _kvPutSales(env, cardId, data) {
  if (!env.SYNC_KV) return;
  await env.SYNC_KV.put(`sales:${cardId}`, JSON.stringify(data), { expirationTtl: SALES_KV_TTL });
}

// Pikawiz population fetcher stub.
// Pikawiz pages list grade totals per card.  The live fetch logic should be
// completed once the URL structure is confirmed; for now the stub returns null
// so the client degrades gracefully to confidence-badge-free display.
async function _fetchPikawizPop(cardId) {
  // TODO: implement when Pikawiz URL structure is confirmed
  // Typical pattern: https://pikawiz.com/cards/pop-report/<set-slug>
  return null;
}

// Card Ladder sales data fetcher stub.
// Returns {sales:{1..10:{avg,low,high,count,change90}}} or null.
async function _fetchCardLadderSales(cardId) {
  // TODO: implement when Card Ladder per-card page structure is confirmed
  return null;
}

// GET  /pop?cardId=   — returns cached pop data or fetches fresh and caches it
// PUT  /pop?cardId=   — stores caller-supplied pop data (body: JSON {pop:{...}})
async function handlePopQuery(request, env, url) {
  const ch = corsHeaders(request);
  const cardId = url.searchParams.get('cardId');
  if (!cardId) return new Response(JSON.stringify({ error: 'cardId required' }), { status: 400, headers: { ...ch, 'Content-Type': 'application/json' } });

  if (request.method === 'PUT') {
    try {
      const body = await request.json();
      if (!body || !body.pop) return new Response(JSON.stringify({ error: 'body must contain pop' }), { status: 400, headers: { ...ch, 'Content-Type': 'application/json' } });
      await _kvPutPop(env, cardId, { pop: body.pop, ts: Date.now() });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...ch, 'Content-Type': 'application/json' } });
    } catch { return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: { ...ch, 'Content-Type': 'application/json' } }); }
  }

  // GET — serve from KV cache, refresh in background if stale
  let cached = await _kvGetPop(env, cardId);
  if (!cached) {
    const live = await _fetchPikawizPop(cardId);
    if (live) {
      cached = { pop: live, ts: Date.now() };
      await _kvPutPop(env, cardId, cached);
    }
  }
  if (!cached) return new Response(JSON.stringify({ pop: null, ts: 0 }), { headers: { ...ch, 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(cached), { headers: { ...ch, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
}

// GET  /sales?cardId=  — returns cached sales data or fetches fresh and caches it
// PUT  /sales?cardId=  — stores caller-supplied sales data
async function handleSalesQuery(request, env, url) {
  const ch = corsHeaders(request);
  const cardId = url.searchParams.get('cardId');
  if (!cardId) return new Response(JSON.stringify({ error: 'cardId required' }), { status: 400, headers: { ...ch, 'Content-Type': 'application/json' } });

  if (request.method === 'PUT') {
    try {
      const body = await request.json();
      if (!body || !body.sales) return new Response(JSON.stringify({ error: 'body must contain sales' }), { status: 400, headers: { ...ch, 'Content-Type': 'application/json' } });
      await _kvPutSales(env, cardId, { sales: body.sales, ts: Date.now() });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...ch, 'Content-Type': 'application/json' } });
    } catch { return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: { ...ch, 'Content-Type': 'application/json' } }); }
  }

  let cached = await _kvGetSales(env, cardId);
  if (!cached) {
    const live = await _fetchCardLadderSales(cardId);
    if (live) {
      cached = { sales: live, ts: Date.now() };
      await _kvPutSales(env, cardId, cached);
    }
  }
  if (!cached) return new Response(JSON.stringify({ sales: null, ts: 0 }), { headers: { ...ch, 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(cached), { headers: { ...ch, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' } });
}

async function handleCronRefresh(env) {
  if (!env.SYNC_KV) return;
  let listed;
  try { listed = await env.SYNC_KV.list({ prefix: 'sync:' }); } catch { return; }
  for (const { name: kvKey } of (listed.keys || [])) {
    const pairCode = kvKey.slice('sync:'.length);
    if (!PAIR_CODE_REGEX.test(pairCode)) continue;
    let snap;
    try {
      const raw = await env.SYNC_KV.get(kvKey);
      if (!raw) continue;
      snap = JSON.parse(raw);
    } catch { continue; }
    const allCards = [
      ..._warmSnapKey(snap, 'pkm-portfolio'),
      ..._warmSnapKey(snap, 'pkm-wishlist'),
      ..._warmSnapKey(snap, 'pkm-watchlist-v1'),
    ];
    const cardMap = new Map();
    for (const card of allCards) {
      const id = card.i || card.id || card.cardId;
      if (id && !cardMap.has(id)) cardMap.set(id, card);
    }
    const cards = [...cardMap.entries()].slice(0, PC_WARM_MAX_PER_USER);
    if (!cards.length) continue;
    const priceMap = {};
    let ci = 0;
    await Promise.all(Array.from({ length: Math.min(PC_WARM_CONCURRENCY, cards.length) }, async () => {
      while (ci < cards.length) {
        const [cardId, card] = cards[ci++];
        try {
          const price = await _warmFetchPCCard(card);
          if (price && price.pcUngraded > 0) priceMap[cardId] = price;
        } catch {}
      }
    }));
    if (Object.keys(priceMap).length > 0) {
      await env.SYNC_KV.put(
        `price-warm:${pairCode}`,
        JSON.stringify({ ts: Date.now(), prices: priceMap }),
        { expirationTtl: PC_WARM_KV_TTL },
      );
      // Also persist to D1 so /prices can serve them instantly to all users
      if (env.PRICES_DB) await _d1UpsertPrices(env.PRICES_DB, priceMap);
    }
  }
  // Also refresh market intelligence from YouTube channels (all card eras)
  try { await refreshMarketIntel(env); } catch {}
  // Refresh stale D1 entries so the next day's prices are ready at 6AM
  if (env.PRICES_DB) try { await _d1CronRefreshStale(env.PRICES_DB); } catch {}
  // Refresh population data for unique cards across all synced collections
  // Pikawiz fetcher is a stub — runs silently until implemented
  try {
    const allCardIds = new Set();
    for (const { name: kvKey } of (listed?.keys || [])) {
      const pairCode = kvKey.slice('sync:'.length);
      if (!PAIR_CODE_REGEX.test(pairCode)) continue;
      const raw = await env.SYNC_KV.get(kvKey).catch(() => null);
      if (!raw) continue;
      let snap; try { snap = JSON.parse(raw); } catch { continue; }
      for (const key of ['pkm-portfolio', 'pkm-wishlist', 'pkm-watchlist-v1']) {
        for (const card of _warmSnapKey(snap, key)) {
          const id = card.i || card.id || card.cardId;
          if (id) allCardIds.add(id);
        }
      }
    }
    for (const cardId of allCardIds) {
      const existing = await _kvGetPop(env, cardId).catch(() => null);
      if (existing && (Date.now() - existing.ts) < POP_KV_TTL * 1000 * 0.8) continue; // not stale yet
      const fresh = await _fetchPikawizPop(cardId).catch(() => null);
      if (fresh) await _kvPutPop(env, cardId, { pop: fresh, ts: Date.now() }).catch(() => {});
    }
  } catch {}
}

// Refresh the oldest stale entries in D1, capped to keep within Worker time limits.
// Uses the stored pc_name + pc_console to re-query PriceCharting directly —
// no need for the original card metadata since we already know the exact PC product.
const D1_CRON_BATCH = 1000; // cards refreshed per scheduled run
const D1_CRON_CONC  = 10;

async function _d1CronRefreshStale(db) {
  const cutoff = Date.now() - D1_FRESH_MS;
  let rows;
  try {
    const { results } = await db.prepare(
      `SELECT card_id, pc_name, pc_console FROM prices
       WHERE updated_at < ? AND pc_name != ''
       ORDER BY updated_at ASC LIMIT ?`
    ).bind(cutoff, D1_CRON_BATCH).all();
    rows = results;
  } catch { return; }
  if (!rows?.length) return;

  const fresh = {};
  let ci = 0;
  await Promise.all(Array.from({ length: Math.min(D1_CRON_CONC, rows.length) }, async () => {
    while (ci < rows.length) {
      const row = rows[ci++];
      if (!row.pc_name) continue;
      try {
        // Search PC for the exact product we already matched — pc_name is the canonical name.
        const q = `${row.pc_name} ${row.pc_console}`.trim();
        const pcUrl = `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(q)}&format=json`;
        const resp = await fetch(pcUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PokemonPricePredictor/1.0)', Accept: 'application/json' },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const products = data.products || [];
        // Pick the product whose name and console match exactly.
        const match = products.find(p =>
          (p.productName || '') === row.pc_name && (p.consoleName || '') === row.pc_console
        ) || products[0];
        if (!match) continue;
        const price = _warmParsePC(match.price1);
        if (!price) continue;
        fresh[row.card_id] = {
          pcUngraded: price,
          pcPsa10:    _warmParsePC(match.price2),
          pcGrade9:   _warmParsePC(match.price3),
          market:     price,
          mid:        price,
          pcName:     match.productName || row.pc_name,
          pcConsole:  match.consoleName || row.pc_console,
          pcId:       match.id || '',
          source:     'pricecharting',
          _ts:        Date.now(),
        };
      } catch {}
    }
  }));
  if (Object.keys(fresh).length) await _d1UpsertPrices(db, fresh);
}

// ── D1 price database ────────────────────────────────────────────────────────
// prices table: card_id PK, numeric price columns, updated_at epoch ms.
// Prices older than D1_FRESH_MS are treated as stale and re-fetched inline.

const D1_FRESH_MS           = 23 * 3600 * 1000; // fresh window: 23 h
const PRICES_BATCH_MAX      = 100;               // max IDs per /prices request
const PRICES_FETCH_CONC     = 8;                 // PriceCharting concurrency for misses

async function _d1FetchPrices(db, ids) {
  if (!db || !ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  try {
    const { results } = await db.prepare(
      `SELECT card_id,pc_ungraded,pc_psa10,pc_psa9,pc_psa8,pc_psa7,pc_psa6,pc_psa5,
              pc_name,pc_console,pc_id,market,mid,updated_at
         FROM prices WHERE card_id IN (${ph})`
    ).bind(...ids).all();
    const map = {};
    for (const r of results) map[r.card_id] = r;
    return map;
  } catch { return {}; }
}

async function _d1UpsertPrices(db, priceMap) {
  if (!db) return;
  const entries = Object.entries(priceMap);
  if (!entries.length) return;
  const stmts = entries.map(([id, p]) =>
    db.prepare(
      `INSERT INTO prices (card_id,pc_ungraded,pc_psa10,pc_psa9,pc_psa8,pc_psa7,pc_psa6,pc_psa5,
                           pc_name,pc_console,pc_id,market,mid,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(card_id) DO UPDATE SET
         pc_ungraded=excluded.pc_ungraded, pc_psa10=excluded.pc_psa10,
         pc_psa9=excluded.pc_psa9, pc_psa8=excluded.pc_psa8, pc_psa7=excluded.pc_psa7,
         pc_psa6=excluded.pc_psa6, pc_psa5=excluded.pc_psa5,
         pc_name=excluded.pc_name, pc_console=excluded.pc_console, pc_id=excluded.pc_id,
         market=excluded.market, mid=excluded.mid, updated_at=excluded.updated_at`
    ).bind(
      id,
      p.pcUngraded||0, p.pcPsa10||0, p.pcPsa9||p.pcGrade9||0,
      p.pcPsa8||0, p.pcPsa7||0, p.pcPsa6||0, p.pcPsa5||0,
      p.pcName||'', p.pcConsole||'', p.pcId||'',
      p.market||p.pcUngraded||0, p.mid||p.pcUngraded||0,
      p._ts||Date.now()
    )
  );
  for (let i = 0; i < stmts.length; i += 100) {
    try { await db.batch(stmts.slice(i, i + 100)); } catch (e) { console.error('D1 batch error:', e?.message || e); }
  }
}

function _d1RowToPrice(r) {
  if (!r) return null;
  return {
    pcUngraded: r.pc_ungraded||0, pcPsa10: r.pc_psa10||0,
    pcPsa9:     r.pc_psa9||0,     pcPsa8:  r.pc_psa8||0,
    pcPsa7:     r.pc_psa7||0,     pcPsa6:  r.pc_psa6||0,
    pcPsa5:     r.pc_psa5||0,
    pcName:     r.pc_name||'',    pcConsole: r.pc_console||'',
    pcId:       r.pc_id||'',
    market:     r.market||0,      mid:     r.mid||0,
    _ts:        r.updated_at||0,  _src:    'd1',
  };
}

// POST /prices  body: { ids:[...], cards:{ id:{n,s,cn,lang} } }
// GET  /prices?ids=id1,id2,...  (D1 read-only, no PC fallback)
// Returns { id: priceData|null, ... }
async function handlePricesBatch(request, env, url) {
  const ch = corsHeaders(request);
  if (!env.PRICES_DB) return _jsonResp(503, { error: 'Price DB not configured.' }, ch);

  let ids = [], cardMeta = {};
  if (request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return _jsonResp(400, { error: 'Invalid JSON.' }, ch); }
    ids      = (body.ids || []).slice(0, PRICES_BATCH_MAX);
    cardMeta = body.cards || {};
  } else {
    ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, PRICES_BATCH_MAX);
  }
  if (!ids.length) return _jsonResp(400, { error: 'No ids provided.' }, ch);

  const cutoff  = Date.now() - D1_FRESH_MS;
  const d1Rows  = await _d1FetchPrices(env.PRICES_DB, ids);
  const result  = {};
  const misses  = []; // stale or missing, and we have metadata to re-fetch

  for (const id of ids) {
    const row = d1Rows[id];
    if (row && (row.updated_at||0) > cutoff) {
      result[id] = _d1RowToPrice(row);
    } else {
      result[id] = row ? _d1RowToPrice(row) : null; // return stale if we have it
      if (cardMeta[id]) misses.push(id);
    }
  }

  // Fetch misses from PriceCharting inline, store back to D1
  if (misses.length) {
    const fresh = {};
    let ci = 0;
    await Promise.all(Array.from({ length: Math.min(PRICES_FETCH_CONC, misses.length) }, async () => {
      while (ci < misses.length) {
        const id = misses[ci++];
        const m  = cardMeta[id];
        if (!m) continue;
        try {
          const p = await _warmFetchPCCard({ i: id, n: m.n, s: m.s, cn: m.cn, lang: m.lang });
          if (p) { result[id] = { ...p, _src: 'pc' }; fresh[id] = p; }
        } catch {}
      }
    }));
    if (Object.keys(fresh).length) {
      await _d1UpsertPrices(env.PRICES_DB, fresh);
    }
  }

  return _jsonResp(200, result, ch);
}

// GET /price-warm?key=<pairCode> — returns the pre-warmed price map for this user.
async function handlePriceWarm(request, env, url) {
  const ch = corsHeaders(request);
  if (!env.SYNC_KV) return _jsonResp(503, { error: 'Not configured' }, ch);
  const key = (url.searchParams.get('key') || '').trim();
  if (!PAIR_CODE_REGEX.test(key)) return _jsonResp(400, { error: 'Invalid key' }, ch);
  const raw = await env.SYNC_KV.get(`price-warm:${key}`);
  if (!raw) return _jsonResp(200, { prices: {}, ts: 0 }, ch);
  return new Response(raw, { headers: { ...ch, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCronRefresh(env));
  },
};
