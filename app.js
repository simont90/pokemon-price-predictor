/* ========================================
   Pokémon Card Price Predictor v9
   26k+ cards · EN + 6k JP cards
   LIVE market data — auto-updating prices
   PriceCharting primary + pokemontcg.io fallback
   Auto-calibrated desirability · 5-year forecast
   Live GBP conversion · eBay deal checker
   Portfolio tracker · HOLD/BUY/SELL signals
   PriceCharting grading data + ROI
   ======================================== */

// ---- Model Constants ----
const BASE = 12.50;
const PULL_MULT = 1.19;
const DES_MULT = 1.41;
// Character is ~2× more impactful than art alone per market data — weight accordingly.
const WEIGHTS = { char: 0.55, art: 0.35, appeal: 0.10 };

// ---- Pokémon Popularity Tiers ----
// Calibrated against video market analysis: Charizard #1, Umbreon 1.3 avg rank,
// Mew 1.4, Dragonite high-variance A. Gen 4 in active nostalgia cycle (2025-2027).
const CHAR_TIERS = {
  S: { score: 9.5, names: ['charizard','umbreon','mew','mewtwo','pikachu','eevee'] },
  A: { score: 8.2, names: ['gengar','dragonite','gyarados','lugia','rayquaza','gardevoir','lucario','greninja','sylveon','espeon','vaporeon','leafeon','flareon','jolteon','glaceon','magikarp','snorlax','blastoise','venusaur','meowth','togekiss','garchomp','infernape','empoleon','arcanine','zoroark','zorua'] },
  B: { score: 6.5, names: ['ninetales','alakazam','machamp','lapras','tyranitar','celebi','suicune','entei','raikou','ho-oh','latios','latias','deoxys','dialga','palkia','giratina','darkrai','arceus','reshiram','zekrom','kyurem','xerneas','yveltal','zygarde','lunala','solgaleo','necrozma','zacian','zamazenta','calyrex','miraidon','koraidon','terapagos','luxray','roserade','torterra','staraptor','gallade','leafeon'] },
};

const APPEAL_TIERS = {
  S: { score: 9.5, names: ['charizard','pikachu','mewtwo','eevee','mew','umbreon'] },
  A: { score: 7.5, names: ['gengar','snorlax','gyarados','dragonite','gardevoir','lucario','greninja','blastoise','venusaur','magikarp','sylveon','arcanine','togekiss','garchomp','infernape','zoroark'] },
};

// ---- Pack Economics: Fallback Pull Rates ----
// Used when sets-db.js doesn't have rarity pull-rate data.
// Format: average packs needed to pull ANY card of that rarity from a booster.
// Sourced from community-tracked modern set odds (e.g. SV/Twilight Masquerade pull tracker).
const FALLBACK_PACKS_PER_HIT = {
  SIR: 95,    // Special Illustration Rare — ~1 in 95 packs
  SAR: 85,
  IR:  18,    // Illustration Rare — ~1 in 18 packs
  AR:  18,
  HR:  85,    // Hyper Rare (rainbow/gold)
  SHR: 90,    // Shiny Hyper Rare
  MHR: 110,   // Master Hyper Rare
  SHUR: 120,
  UR:  55,    // Ultra Rare
  SR:  30,    // Secret Rare
  RR:  6,     // Double Rare
  R:   3,     // Rare
  DR:  35,    // Dragon/Double Rare classic
  AS:  90,
  PR:  40,    // Promo varies
  CSR: 70,
  CHR: 40,
  U:   1.5,   // Uncommon
  C:   1,     // Common
  '?': 30,    // Unknown rarity — assume mid-tier
};

// Approx number of unique cards in each rarity tier per modern set
const FALLBACK_TIER_SIZE = {
  SIR: 12, SAR: 10, IR: 25, AR: 25,
  HR: 6, SHR: 8, MHR: 4, SHUR: 4,
  UR: 8, SR: 10, RR: 18, R: 30,
  DR: 12, AS: 6, PR: 1, CSR: 6, CHR: 12,
  U: 30, C: 40, '?': 15,
};

// Era-based pack cost (GBP) — used when sets-db doesn't have packCost.
// Reflects current UK market booster prices.
function getDefaultPackCostGBP(setCode, lang) {
  if (!setsData || !setsData[setCode]) return lang === 'JP' ? 3.00 : 4.50;
  const set = setsData[setCode];
  const releaseDate = set.releaseDate || set.released;
  if (!releaseDate) return lang === 'JP' ? 3.00 : 4.50;
  const year = parseInt(releaseDate.slice(0, 4));
  // Japanese packs are ~180 yen retail (~£1) but sealed booster boxes price differently.
  // We use per-pack equivalent including current sealed-product premium.
  if (lang === 'JP') {
    if (year >= 2023) return 3.00;
    if (year >= 2020) return 4.50;
    if (year >= 2015) return 7.00;
    return 14.00;
  }
  if (year >= 2024) return 4.50;
  if (year >= 2022) return 4.75;
  if (year >= 2020) return 6.00;
  if (year >= 2017) return 9.00;
  if (year >= 2011) return 16.00;
  if (year >= 2003) return 30.00;
  return 80.00; // WOTC era
}

// Per-set pack cost overrides — stored as { [setCode]: gbpValue } in pkm-pack-cost-override-v1
function _getPackCostOverrides() {
  try { return JSON.parse(localStorage.getItem('pkm-pack-cost-override-v1') || '{}'); } catch { return {}; }
}
function getPackCostOverride(setCode) { return _getPackCostOverrides()[setCode] || null; }
function setPackCostOverride(setCode, gbp) {
  const ov = _getPackCostOverrides(); ov[setCode] = gbp;
  localStorage.setItem('pkm-pack-cost-override-v1', JSON.stringify(ov));
}
function clearPackCostOverride(setCode) {
  const ov = _getPackCostOverrides(); delete ov[setCode];
  localStorage.setItem('pkm-pack-cost-override-v1', JSON.stringify(ov));
}

// Resolve pack economics for a card — returns { packsPerHit, tierSize, packsNeeded, packCost }.
// Always returns numbers (uses fallbacks if sets-db lacks the data).
function resolvePackEconomics(card) {
  if (!card) return null;
  const set = setsData?.[card.sc];
  let packsPerHit = null;
  let tierSize = null;
  let packCost = null;

  // 1. Try sets-db rarity pullRate first (most accurate when available)
  if (set?.rarities?.[card.rc]?.pullRate > 0) {
    packsPerHit = Math.round(1 / set.rarities[card.rc].pullRate);
    tierSize = set.rarities[card.rc].count || FALLBACK_TIER_SIZE[card.rc] || 10;
  } else {
    // 2. Fallback to rarity-code-based estimates
    packsPerHit = FALLBACK_PACKS_PER_HIT[card.rc] || 30;
    tierSize = FALLBACK_TIER_SIZE[card.rc] || 10;
  }

  // 3. Pack cost — user override takes priority, then sets-db, then era-based fallback
  const _overrideGBP = getPackCostOverride(card.sc);
  if (_overrideGBP > 0) {
    packCost = fxRate > 0 ? _overrideGBP / fxRate : _overrideGBP / 0.79;
  } else if (set?.packCost > 0) {
    packCost = set.packCost; // assumed USD per existing code
  } else {
    const gbp = getDefaultPackCostGBP(card.sc, card.lang);
    packCost = fxRate > 0 ? gbp / fxRate : gbp / 0.79;
  }

  const packsNeeded = Math.round(packsPerHit * tierSize);
  // packCost is in USD for math consistency with getCurrentPrice()
  return { packsPerHit, tierSize, packsNeeded, packCost };
}

// ---- Rarity Appreciation Rates ----
// Base annual appreciation rates calibrated against post-bubble (2022-2026) market data.
// Charizard GX SV49: ~7% CAGR 2019-2026; Moonbreon Alt Art: ~12% CAGR 2021-2026;
// modern SIRs (SV era): 8-12% range; sealed / gameplay cards: effectively 0-4%.
// Character multiplier (getCharacterMultiplier) layers on top for popular Pokémon.
const RARITY_RATES = {
  SIR:  { base: 0.10, label: 'Special Illustration Rare',
           reason: 'SV-era SIRs average 8-12% annually post-bubble; new set supply limits the ceiling vs older alt-arts' },
  SAR:  { base: 0.09, label: 'Special Art Rare',
           reason: 'SWSh-era SARs (e.g. Moonbreon ~12% CAGR 2021-2026) set the benchmark; art quality sustains long-term demand' },
  UR:   { base: 0.08, label: 'Ultra Rare',
           reason: 'Ultra Rares pull more frequently than SIRs, capping appreciation at ~6-10% even for top characters' },
  HR:   { base: 0.07, label: 'Hyper Rare',
           reason: 'Gold/Hyper Rares dropped 40-60% in the 2022 correction; slow ~5-8% recovery rate since' },
  SR:   { base: 0.07, label: 'Secret Rare',
           reason: 'Secret Rares like Charizard GX SV49 averaged ~7% CAGR from 2019-2026 — age and scarcity are the main drivers' },
  RR:   { base: 0.04, label: 'Double Rare',
           reason: 'Double Rares are primarily gameplay cards; collector appreciation is thin at ~3-5% annually' },
  IR:   { base: 0.08, label: 'Illustration Rare',
           reason: 'Illustration Rares track similarly to SARs but print at higher rates; realistic range is 6-10% annually' },
  AR:   { base: 0.06, label: 'Art Rare',
           reason: 'Art Rares sit just above standard; ~4-7% annually with heavy character-demand dependency' },
  CSR:  { base: 0.08, label: 'Character SR',
           reason: 'Character SRs (JP premium tier) track similarly to SARs; character desirability drives most variance' },
  CHR:  { base: 0.05, label: 'Character Rare',
           reason: 'Character Rares have modest collector demand; ~3-6% annually, largely tied to gameplay popularity' },
  SHR:  { base: 0.09, label: 'Shiny Hyper Rare',
           reason: 'Shiny Hyper Rares are among the scarcest pulls; trajectory similar to SIRs at ~8-12% annually' },
  MHR:  { base: 0.11, label: 'Master Hyper Rare',
           reason: 'Master Hyper Rares are extremely scarce — highest base rate but also highest volatility' },
  SHUR: { base: 0.10, label: 'Shiny Ultra Rare',
           reason: 'Shiny Ultra Rares combine shininess scarcity with artwork premium; ~8-12% CAGR range' },
  '':   { base: 0.02, label: 'Standard',
           reason: 'Standard cards rarely beat inflation over 5 years; most value is tied to short-term gameplay rotation' },
};

// ---- Global State ----
let cardData = null;
let setsData = null;
let fxRate = 0.79;
let selectedCard = null;
// Multi-currency display (device-local, not synced)
const DISP_CURRENCY_KEY = 'display-currency';
let _displayCurrency = localStorage.getItem(DISP_CURRENCY_KEY) || 'GBP';
let _currencyRates   = { GBP: 1, USD: 1.27, EUR: 1.17, JPY: 190, AUD: 2.01, CAD: 1.74 };
const _CURRENCY_SYMS = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', AUD: 'A$', CAD: 'C$' };
let _lastLiveData    = null;
let searchIndex = [];
const $ = id => document.getElementById(id);

// Inline transparent placeholder used while a TCGC page-URL is being resolved
// in the background, or when no valid image URL can be constructed.
const CARD_PLACEHOLDER_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 245 342'>`
  + `<rect width='100%' height='100%' rx='12' ry='12' fill='%23eef0f4' stroke='%23cdd2dc' stroke-width='2'/>`
  + `<text x='50%' y='50%' text-anchor='middle' font-family='system-ui,sans-serif' font-size='18' fill='%237b8290'>Loading…</text>`
  + `</svg>`
);
// One-shot in-flight set so we don't re-fetch the same TCGC page URL repeatedly
const _pendingImgResolves = new Set();

// ---- Image URL Helper (reconstructed from card ID to save DB size) ----
function getCardImg(card) {
  // Accept direct image URLs or recognised CDN domains as-is.
  if (card.img && /^(https?:)?\/\//i.test(card.img)) {
    const u = card.img.toLowerCase();
    const looksLikeImage = /\.(webp|jpg|jpeg|png|gif|avif)(\?|#|$)/.test(u)
      || u.includes('static.tcgcollector.com')
      || u.includes('images.pokemontcg.io')
      || u.includes('assets.tcgdex.net');
    if (looksLikeImage) return card.img;
    // Bad legacy override: a TCGC card-page URL was saved before the image
    // fetch completed. Kick off a one-shot resolution that will rewrite it to
    // the real CDN image, then re-render. Show a placeholder meanwhile.
    if (typeof isTCGCollectorCardURL === 'function' && isTCGCollectorCardURL(card.img)) {
      _resolveLegacyTCGCImage(card).catch(() => {});
      return CARD_PLACEHOLDER_IMG;
    }
  }
  if (card.lang === 'JP') {
    // JP cards: tcgdex format — jp-{set}-{num} -> /ja/{era}/{set}/{num}/high.png
    const parts = card.i.replace('jp-', '').split('-');
    const setCode = parts[0];
    const num = parts.slice(1).join('-');
    return `https://assets.tcgdex.net/ja/S/${setCode}/${num}/high.png`;
  }
  // EN cards: pokemontcg.io _hires.png — 734×1024 px, crisp on Retina.
  // The standard .png (245×342 px) looks blurry at the 440 px display height
  // on 2× screens; _hires avoids upscaling artifacts.
  if (!card.sc) return CARD_PLACEHOLDER_IMG;
  return `https://images.pokemontcg.io/${card.sc}/${card.cn || card.ns || ''}_hires.png`;
}

// Upgrade a stored pokemontcg.io standard-res URL to the hi-res variant.
// Used for cards added before this change whose img was saved as .png.
function _hiresUrl(url) {
  if (!url) return url;
  if (/^https?:\/\/images\.pokemontcg\.io\//.test(url) && !/_hires/.test(url)) {
    return url.replace(/\.png(\?|$)/, '_hires.png$1');
  }
  return url;
}

// onerror handler for card <img> elements: if _hires.png 404s, fall back to
// the standard .png before hiding. Called as onerror="_onImgError(this)".
function _onImgError(el) {
  if (el.src && el.src.includes('_hires')) {
    el.src = el.src.replace('_hires.png', '.png');
    el.onerror = function() { el.style.display = 'none'; el.onerror = null; };
  } else {
    el.style.display = 'none';
    el.onerror = null;
  }
}

// Background resolver for legacy bad img values (TCGC card-page URLs).
// Resolves to the real CDN image, persists the new value into both the
// user-cards bucket and the per-card override, then re-renders.
async function _resolveLegacyTCGCImage(card) {
  if (!card || !card.img) return;
  const pageUrl = card.img;
  if (_pendingImgResolves.has(pageUrl)) return;
  _pendingImgResolves.add(pageUrl);
  try {
    if (typeof fetchTCGCollectorCardDetails !== 'function') return;
    const { imgUrl } = await fetchTCGCollectorCardDetails(pageUrl);
    if (!imgUrl) return;
    // Update in-memory copy
    card.img = imgUrl;
    // Persist to user-cards bucket if this is a user-added card
    try {
      if (card._userAdded && typeof loadUserCards === 'function') {
        const userCards = loadUserCards();
        const idx = userCards.findIndex(u => u.i === card.i);
        if (idx >= 0) {
          userCards[idx].img = imgUrl;
          if (typeof saveUserCards === 'function') saveUserCards(userCards);
        }
      }
    } catch {}
    // Persist to override bucket too (so other rendering paths pick it up)
    try {
      if (typeof setCardOverride === 'function') setCardOverride(card.i, { img: imgUrl });
    } catch {}
    // Swap any rendered <img> tags currently pointing at the placeholder
    try {
      document.querySelectorAll('img').forEach(el => {
        if (el.src === CARD_PLACEHOLDER_IMG || (el.dataset && el.dataset.cardId === card.i)) {
          el.src = imgUrl;
        }
      });
      // If this is the currently selected card, re-select to refresh the panel
      if (typeof selectedCard !== 'undefined' && selectedCard && selectedCard.i === card.i
          && typeof selectCard === 'function') {
        selectCard(card.i);
      }
    } catch {}
  } finally {
    _pendingImgResolves.delete(pageUrl);
  }
}

// ---- Live Pricing Cache (localStorage with TTL) ----
// Price is valid until the next 6AM GMT refresh cycle — computed at call time.
function _priceCacheIsValid(ts) {
  const now = Date.now();
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6, 0, 0, 0));
  if (d < t) t.setUTCDate(t.getUTCDate() - 1);
  return (ts || 0) >= t.getTime();
}
const PRICE_CACHE_KEY = 'pkm-live-prices-v5'; // v5: adds ACE/CGC/BGS/TAG/SGC 10 anchors from PC full-grade table
let _priceCache = null; // in-memory mirror; avoids JSON.parse on every getCachedPrice call
// Computation caches — per-card, invalidated when that card's price data changes
const _sigCache = new Map(); // card.i → { v: computeSignal result, ts }
const _hcCache  = new Map(); // card.i → { v: computeHoldCore result, ts }
const _COMP_TTL = 120_000;   // 2-minute TTL (signals don't shift faster than this)

function getPriceCache() {
  if (_priceCache) return _priceCache;
  try { _priceCache = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY) || '{}') || {}; }
  catch { _priceCache = {}; }
  return _priceCache;
}

function setCachedPrice(cardId, data) {
  const cache = getPriceCache();
  cache[cardId] = { ...data, _ts: Date.now() };
  // Prune old entries (keep max 500)
  const keys = Object.keys(cache);
  if (keys.length > 500) {
    const sorted = keys.sort((a, b) => (cache[a]._ts || 0) - (cache[b]._ts || 0));
    sorted.slice(0, keys.length - 500).forEach(k => delete cache[k]);
  }
  try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache)); } catch {}
  // Price changed — signal may shift, so invalidate cached computation for this card
  _sigCache.delete(cardId);
  _hcCache.delete(cardId);
  _recoCached = null; // reco HTML uses pcPsa10 / market from this cache
}

function getCachedPrice(cardId) {
  const cache = getPriceCache();
  const entry = cache[cardId];
  if (!entry) return null;
  if (!_priceCacheIsValid(entry._ts)) return null;
  return entry;
}

// Returns the last-stored cache entry regardless of age (stale-but-usable fallback).
function getLastKnownPrice(cardId) {
  const cache = getPriceCache();
  return cache[cardId] || null;
}

// ---- TCGPlayer URL overrides (per-card manual/auto-enriched link) ----
const TCG_OVERRIDE_KEY = 'pkm-tcg-overrides-v1';
function getTcgOverride(cardId) {
  try { return JSON.parse(localStorage.getItem(TCG_OVERRIDE_KEY) || '{}')[cardId] || null; } catch { return null; }
}
function setTcgOverride(cardId, url) {
  try {
    const map = JSON.parse(localStorage.getItem(TCG_OVERRIDE_KEY) || '{}');
    if (url) map[cardId] = url; else delete map[cardId];
    localStorage.setItem(TCG_OVERRIDE_KEY, JSON.stringify(map));
  } catch {}
}

// ---- Manual TCGPlayer market price overrides (per-card, stored in USD) ----
const TCG_PRICE_OVERRIDE_KEY = 'pkm-tcg-price-overrides-v1';
function getTcgPriceOverride(cardId) {
  try { return parseFloat(JSON.parse(localStorage.getItem(TCG_PRICE_OVERRIDE_KEY) || '{}')[cardId]) || 0; } catch { return 0; }
}
function setTcgPriceOverride(cardId, usd) {
  try {
    const map = JSON.parse(localStorage.getItem(TCG_PRICE_OVERRIDE_KEY) || '{}');
    if (usd > 0) map[cardId] = usd; else delete map[cardId];
    localStorage.setItem(TCG_PRICE_OVERRIDE_KEY, JSON.stringify(map));
  } catch {}
}

// ---- Manual JP PSA 10 price overrides (for EN↔JP scenario comparison) ----
const JP_PSA10_OVERRIDE_KEY = 'pkm-jp-psa10-overrides-v1';
function getJpPsa10Override(cardId) {
  try { return JSON.parse(localStorage.getItem(JP_PSA10_OVERRIDE_KEY) || '{}')[cardId] || null; } catch { return null; }
}
function setJpPsa10Override(cardId, gbp, dateStr) {
  try {
    const map = JSON.parse(localStorage.getItem(JP_PSA10_OVERRIDE_KEY) || '{}');
    if (gbp > 0) map[cardId] = { gbp, date: dateStr };
    else delete map[cardId];
    localStorage.setItem(JP_PSA10_OVERRIDE_KEY, JSON.stringify(map));
  } catch {}
}

// ---- Live Price State ----
let livePrice = null; // Current card's live pricing data
let livePriceFetchId = 0;
let lastModelPriceUSD = 0; // Last result from predictPrice — used by inline deal checks
let _holdWinnerKey = null;  // Winner key from last renderHoldStrategy run — drives owned-card badge
let _holdWinnerDesc = '';   // One-line summary of the winner — shown in signal section

// ---- Portfolio (persisted to localStorage) ----
let portfolio = JSON.parse(localStorage.getItem('pkm-portfolio') || '[]');

// ---- Init ----
async function fetchGzipJson(url) {
  // Try fetching pre-gzipped file and decompress client-side (496KB vs 1.9MB)
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const r = await fetch(url + '.gz');
      if (r.ok) {
        const ds = new DecompressionStream('gzip');
        const decompressed = r.body.pipeThrough(ds);
        const text = await new Response(decompressed).text();
        return JSON.parse(text);
      }
    } catch (e) {
      console.warn('Gzip fetch failed, falling back to raw:', e);
    }
  }
  // Fallback: raw JSON
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchGzipJson(url);
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
}

// Decode compact v2 card format back to objects
function decodeCardDB(raw) {
  if (!raw.v || raw.v < 2) return raw; // legacy format, pass through
  const sets = raw.sets, codes = raw.codes, rars = raw.rars, rcodes = raw.rcodes;
  const cards = new Array(raw.d.length);
  for (let i = 0; i < raw.d.length; i++) {
    const d = raw.d[i];
    const extra = d.length > 9 ? d[9] : null;
    cards[i] = {
      i: d[0], n: d[1], s: sets[d[2]], sc: codes[d[3]],
      r: rars[d[4]], rc: rcodes[d[5]], cn: d[6], ns: d[7], p: d[8],
    };
    if (extra) {
      if (extra.j) cards[i].nj = extra.j;
      if (extra.l) cards[i].lang = extra.l;
      if (extra.t) cards[i].p10 = extra.t;
      if (extra.g) cards[i].g = extra.g;
      if (extra.c) cards[i].ct = extra.c;
    }
  }
  return { count: raw.count, cards };
}

async function init() {
  const loadingText = document.querySelector('#loadingOverlay p');
  try {
    // Card and set data loaded via <script> tags (no fetch needed — works on all browsers)
    if (typeof CARD_DB_RAW !== 'undefined') {
      if (loadingText) loadingText.textContent = 'Decoding card database...';
      cardData = decodeCardDB(CARD_DB_RAW);
    } else {
      // Fallback: fetch if script tags didn't load
      if (loadingText) loadingText.textContent = 'Loading card database...';
      const raw = await fetchWithRetry('data/cards-expanded.json');
      cardData = decodeCardDB(raw);
    }

    if (typeof SETS_DB_RAW !== 'undefined') {
      setsData = SETS_DB_RAW;
    } else {
      setsData = await fetchWithRetry('data/sets-expanded.json');
    }

    // Fetch exchange rate (small, non-blocking)
    try {
      const fxR = await fetch('https://open.er-api.com/v6/latest/GBP').then(r => r.json());
      if (fxR.rates?.USD) {
        _currencyRates = {
          GBP: 1,
          USD: fxR.rates.USD || 1.27,
          EUR: fxR.rates.EUR || 1.17,
          JPY: fxR.rates.JPY || 190,
          AUD: fxR.rates.AUD || 2.01,
          CAD: fxR.rates.CAD || 1.74,
        };
        fxRate = 1 / fxR.rates.USD; // USD→GBP for internal calcs
      }
    } catch (e) { /* use default */ }

    if (loadingText) loadingText.textContent = 'Initialising…';

    $('fxValue').textContent = `£${fxRate.toFixed(4)}`;
    if (cardData) {
      const jpCount = cardData.cards.filter(c => c.lang === 'JP').length;
      const enCount = cardData.count - jpCount;
      $('searchCount').textContent = `${cardData.count.toLocaleString()} cards (${enCount.toLocaleString()} EN + ${jpCount.toLocaleString()} JP)`;
    }
  } catch (e) {
    console.error('Init failed:', e);
    if (loadingText) loadingText.textContent = 'Failed to load — tap to retry';
    document.getElementById('loadingOverlay').onclick = () => { location.reload(); };
    return;
  }
  $('loadingOverlay').classList.add('hidden');

  setupSearch();
  setupInputs();
  setupPortfolio();
  setupWishlist();
  setupFullArtBinder();
  setupCompare();
  setupScreener();
  setupValuePicks();
  initPriceHistoryControls();
  setupQuickLookup();
  setupPCOverride();
  setupCPOverride();
  setupManualAdd();
  setupEditCard();
  setupImageLightbox();
  setupWatchlist();
  setupTop50();
  setupPriceSync();
  setupAcquisition();
  setupCardGrader();
  initForecastInteractivity();
  setupPriceInsight();
  setupAiChat();
  setupTheme();
  setupPageNav();
  setupUnderrated();
  setupPWANav();
  setupCollapsibleSections();
  setupCardLinksToggle();
  setupCardEditToggle();
  setupHeaderMenu();
  // Bring back any cards the user has manually added in past sessions, then
  // rebuild the search index and refresh the displayed total card count.
  injectUserCards();
  if (cardData) {
    buildSearchIndex(cardData.cards);
    if (typeof buildCounterpartIndex === 'function') buildCounterpartIndex(cardData.cards);
    const jpCount = cardData.cards.filter(c => c.lang === 'JP').length;
    const enCount = cardData.count - jpCount;
    const userCount = cardData.cards.filter(c => c._userAdded).length;
    const userSuffix = userCount > 0 ? ` + ${userCount} added` : '';
    $('searchCount').textContent =
      `${cardData.count.toLocaleString()} cards (${enCount.toLocaleString()} EN + ${jpCount.toLocaleString()} JP${userSuffix})`;
  }
  updateAll();
  _setupHomePip();
  // Kick off background price prefetch 800 ms after init — covers all tracked
  // cards (portfolio + wishlist + watchlist + binder + previously cached).
  setTimeout(() => { try { _homeAutoRefresh(); } catch {} }, 800);
  // Pre-fetch all binder prices silently at startup so they're ready before
  // the user opens the binder page. Runs 1.5 s after init to avoid competing
  // with the home refresh; continues in the background even if binder is hidden.
  setTimeout(() => { try { _binderAutoRefresh(); } catch {} }, 1500);
  // Global 6AM GMT refresh: runs 3 s after init, after home refresh is underway.
  setTimeout(() => { try { _globalRefreshIfDue(); } catch {} }, 3000);
}

// Re-check the 7AM boundary whenever the tab regains focus — handles the case
// where a browser tab stays open overnight and crosses the 7AM boundary.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    try { _globalRefreshIfDue(); } catch {}
  }
});

// ---- Currency ----
function usdToGbp(usd) { return usd * fxRate; }
// fmtGBP converts USD → GBP first, then delegates to fmtGBPDirect for display currency conversion
function fmtGBP(usd) { return fmtGBPDirect(usdToGbp(usd)); }
function fmtUSD(usd) { return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

// ---- Character Analysis ----
function extractPokemonName(cardName) {
  let name = cardName.toLowerCase()
    .replace(/\s*\[.*?\]/g, '')
    .replace(/\s*#\d+/g, '')
    .replace(/\s+ex\b/g, '')
    .replace(/\s+gx\b/g, '')
    .replace(/\s+v\b/g, '')
    .replace(/\s+vmax\b/g, '')
    .replace(/\s+vstar\b/g, '')
    .replace(/\bmega\s+/g, '')
    .trim();
  return name;
}

function getCharacterScore(cardName) {
  const name = extractPokemonName(cardName);
  for (const [tier, data] of Object.entries(CHAR_TIERS)) {
    if (data.names.some(n => name.includes(n))) return data.score;
  }
  return 3.5;
}

function getAppealScore(cardName) {
  const name = extractPokemonName(cardName);
  for (const [tier, data] of Object.entries(APPEAL_TIERS)) {
    if (data.names.some(n => name.includes(n))) return data.score;
  }
  return 4.0;
}

function getCharacterMultiplier(cardName) {
  const name = extractPokemonName(cardName);
  for (const [tier, data] of Object.entries(CHAR_TIERS)) {
    if (data.names.some(n => name.includes(n))) {
      if (tier === 'S') return 1.6;
      if (tier === 'A') return 1.3;
      if (tier === 'B') return 1.1;
    }
  }
  return 1.0;
}

// ---- Get Current Price (live or fallback to static) ----
function getCurrentPrice(card) {
  // If we have live price data for the selected card, use it
  if (livePrice && selectedCard && card.i === selectedCard.i) {
    // Midpoint when both PC and TCGPlayer have prices (computed inline so stale cache still benefits)
    if (livePrice.pcUngraded > 0 && livePrice.tcgMarket > 0) return (livePrice.pcUngraded + livePrice.tcgMarket) / 2;
    if (livePrice.pcUngraded > 0) return livePrice.pcUngraded;
    if (livePrice.market > 0) return livePrice.market;
    if (livePrice.mid > 0) return livePrice.mid;
    if (livePrice.avg7 > 0) return livePrice.avg7;
  }
  // Check cache
  const cached = getCachedPrice(card.i);
  if (cached) {
    if (cached.pcUngraded > 0) return cached.pcUngraded;
    if (cached.market > 0) return cached.market;
    if (cached.mid > 0) return cached.mid;
  }
  // Fallback to static
  return card.p;
}

// ---- Art / Hype Base Score by Rarity ----
const ART_BY_RARITY = {
  'SIR': 9.5, 'IR': 8.5, 'SHR': 7.5, 'MHR': 7.5, 'SHUR': 7.0,
  'AR': 7.5, 'UR': 6.5, 'HR': 5.0, 'SR': 6.0,
  'DR': 4.5, 'RR': 4.5, 'AS': 4.0, 'PR': 4.5,
  'R': 3.0, 'U': 2.0, 'C': 1.5,
};

function getArtBaseScore(rc, cardName) {
  let base = ART_BY_RARITY[rc] || 3.0;
  const ln = (cardName || '').toLowerCase();
  // Boost for premium card types that the rarity code alone may not capture
  if (ln.includes('vmax') || ln.includes('vstar')) base = Math.max(base, 7.0);
  else if (/\bv\b/.test(ln) || ln.includes('-gx') || ln.includes(' gx')) base = Math.max(base, 5.5);
  else if (ln.includes(' ex') || ln.includes('-ex')) base = Math.max(base, 5.0);
  else if (ln.includes('legend')) base = Math.max(base, 7.5);
  else if (ln.includes('lv.x') || ln.includes(' lvx')) base = Math.max(base, 6.0);
  else if (ln.includes('break')) base = Math.max(base, 5.5);
  // Shining / Gold Star
  if (ln.includes('shining') || ln.includes('\u2605') || ln.includes('\u2606')) base = Math.max(base, 8.0);
  return Math.min(10, base);
}

// Median-ish expected price per rarity tier for price-premium adjustments
const EXPECTED_PRICE_BY_RARITY = {
  'SIR': 80, 'IR': 20, 'SHR': 30, 'MHR': 40, 'SHUR': 25,
  'AR': 10, 'UR': 20, 'HR': 8, 'SR': 15,
  'DR': 5, 'RR': 3, 'AS': 8, 'PR': 5,
  'R': 2, 'U': 0.5, 'C': 0.25,
};

// ---- Investment Star Rating (1–5) ----
// Derived from the STAR framework (Star power, Title, Art, Rarity) synthesised
// from market analysis: Seafood=5, Sweets=4, Meat=3, Veg=2, Carbs=1.
const PREMIUM_RARITIES  = new Set(['SIR','SHR','MHR','SHUR','SAR','HR']);
const HIGH_ART_RARITIES = new Set(['SIR','IR','SHR','MHR','SHUR','SAR','HR','AR','UR']);

function _inferJPRarityRc(card) {
  // Most JP cards in the DB have no rarity code — infer an effective EN-equivalent
  // code from the static price so scoring isn't always stuck at the lowest tier.
  if (!card || card.lang !== 'JP' || card.rc || !card.p || card.p <= 0) return card?.rc || '';
  const pg = usdToGbp(card.p);
  if (pg >= 150) return 'SIR';
  if (pg >= 80)  return 'IR';
  if (pg >= 40)  return 'HR';
  if (pg >= 15)  return 'RR';
  if (pg >= 5)   return 'R';
  return 'C';
}

function getInvestmentStars(card, desTot) {
  if (!card) return { stars: 0, tier: '', hint: '', color: '' };
  const charScore = getCharacterScore(card.n);
  const rc = card.rc || _inferJPRarityRc(card);
  const des = typeof desTot === 'number' ? desTot : 5;
  const isS   = charScore >= 9.0;
  const isA   = charScore >= 7.5 && !isS;
  const isB   = charScore >= 5.5 && !isS && !isA;
  const isPremiumRarity  = PREMIUM_RARITIES.has(rc);
  const isHighArtRarity  = HIGH_ART_RARITIES.has(rc);

  if (isS && isPremiumRarity && des >= 8.0)
    return { stars: 5, tier: 'Seafood', color: '#e8b634',
      hint: 'Top character · premium rarity · highest collector demand' };
  if ((isS || isA) && isHighArtRarity && des >= 6.5)
    return { stars: 4, tier: 'Sweets', color: '#c084fc',
      hint: 'High demand · strong art · watch for overpay at peak hype' };
  if ((isA || isB) && isHighArtRarity && des >= 5.0)
    return { stars: 3, tier: 'Meat', color: '#60a5fa',
      hint: 'Solid fundamentals · where most collector money should sit' };
  if (des >= 3.0 && (isHighArtRarity || rc === 'SR' || rc === 'RR'))
    return { stars: 2, tier: 'Veg', color: '#4ade80',
      hint: 'Some appeal · buy with a clear thesis, not momentum' };
  return { stars: 1, tier: 'Carbs', color: '#94a3b8',
    hint: 'Negligible growth expected · sub-£20 target zone' };
}

function renderStarRating(card, des) {
  const el      = $('cardStarRating');
  const iconsEl = $('cardStarIcons');
  const tierEl  = $('cardStarTier');
  const hintEl  = $('cardStarHint');
  if (!el || !card) return;
  const desVal = (des && typeof des === 'object') ? (des.total ?? 5) : (des ?? 5);
  const { stars, tier, hint, color } = getInvestmentStars(card, desVal);
  if (!stars) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  iconsEl.innerHTML = `<span style="color:${color}">${'★'.repeat(stars)}</span><span class="star-empty">${'★'.repeat(5 - stars)}</span>`;
  if (tierEl) tierEl.textContent = '';
  hintEl.textContent = hint;
}

// ---- Entry Timing Window ----
function getEntryTiming(setCode) {
  const m = getSetAgeMonths(setCode);
  if (m < 2)  return { label: 'Too early',         cls: 'et-early',    detail: 'Launch premium still in effect — wait 4–6 months for hype to fade before buying singles.' };
  if (m < 6)  return { label: 'Approaching window',cls: 'et-approach',  detail: 'Hype fading. Start watching for the floor to establish — don\'t commit yet.' };
  if (m < 10) return { label: 'Optimal entry',     cls: 'et-optimal',   detail: '6–8 months post-launch: the lowest-risk buy window. Launch hype is gone, floor is set.' };
  if (m < 18) return { label: 'Mature set',         cls: 'et-mature',    detail: 'Floor established. Strong long-term hold, less short-term price upside remaining.' };
  return       { label: 'Aged set',                cls: 'et-aged',      detail: 'Reprint risk now minimal. Long-term appreciation thesis intact — buy and hold.' };
}

// ---- Auto-fill Desirability ----
function autoFillDesirability(card, pullCost) {
  const charScore = getCharacterScore(card.n);
  const appealScore = getAppealScore(card.n);

  // Art/Hype: base from rarity + card type (use price-inferred RC for JP cards with no rc)
  let artScore = getArtBaseScore(card.rc || _inferJPRarityRc(card), card.n);

  // Price-premium adjustment: if card trades above/below expected for its rarity, adjust art.
  // For S/A-tier characters the price premium is already captured by charScore, so upward
  // art boosts are skipped to avoid double-counting. Downward adjustments still apply.
  const price = getCurrentPrice(card);
  const expected = EXPECTED_PRICE_BY_RARITY[card.rc] || 2;
  const isTopChar = charScore >= 7.5; // A-tier or above
  if (price > 0 && expected > 0) {
    const ratio = price / expected;
    if (!isTopChar) {
      if (ratio > 5)        artScore = Math.min(10, artScore + 2.0);
      else if (ratio > 3)   artScore = Math.min(10, artScore + 1.5);
      else if (ratio > 2)   artScore = Math.min(10, artScore + 1.0);
      else if (ratio > 1.5) artScore = Math.min(10, artScore + 0.5);
    }
    if (ratio < 0.2) artScore = Math.max(1, artScore - 1.5);
    else if (ratio < 0.4) artScore = Math.max(1, artScore - 1.0);
    else if (ratio < 0.6) artScore = Math.max(1, artScore - 0.5);
  }
  artScore = Math.round(Math.max(1, Math.min(10, artScore)) * 10) / 10;

  const total = charScore * WEIGHTS.char + artScore * WEIGHTS.art + appealScore * WEIGHTS.appeal;

  return {
    char: charScore,
    art: artScore,
    appeal: appealScore,
    total: Math.max(1, Math.min(10, total)),
  };
}

// ---- Search ----
let _cardMap = null; // Map<id, card> — O(1) lookup replacing O(n) .find() calls

function buildSearchIndex(cards) {
  searchIndex = cards.map(c => ({
    ...c,
    _search: `${c.n} ${c.nj || ''} ${c.s} ${c.cn || ''} ${c.ns || ''} ${c.r || ''} ${c.sr || ''} ${c.lang || ''}`
      .replace(/\s+/g, ' ')
      .toLowerCase(),
  }));
  _cardMap = new Map(cards.map(c => [c.i, c]));
}

// ================================================================
// ---- EN ↔ JP COUNTERPART INDEX ----
// Groups cards by a stable "pokemon + rarity tier" key so we can jump
// from an English card straight to its Japanese equivalent (and back).
// ================================================================
let counterpartIndex = new Map(); // key -> { en:[], jp:[] }
let counterpartByCard = new Map(); // cardId -> key

function counterpartBaseName(n) {
  return (n || '')
    .replace(/\s*\(jp\)\s*$/i, '')
    .replace(/\s+#\d+$/, '')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function counterpartTier(c) {
  const r = (c.r || '').toLowerCase();
  const rc = (c.rc || '').toUpperCase();
  // Special Illustration Rare / Special Art Rare
  if (rc === 'SIR' || /special illustration rare|special art rare/i.test(r)) return 'SIR';
  // Illustration Rare / Art Rare
  if (rc === 'IR' || rc === 'AR' || /illustration rare$|^art rare/i.test(r)) return 'IR';
  // Ultra Rare / Hyper Rare / Shiny Ultra Rare / Secret
  if (rc === 'UR' || rc === 'SHR' || rc === 'SHUR' || /hyper rare|ultra rare|shiny ultra|rare secret|rare rainbow/i.test(r)) return 'UR';
  // Double Rare (ex/V/VSTAR/VMAX main forms) — EN uses 'DR', JP uses 'RR'
  if (rc === 'RR' || rc === 'DR' || /double rare$|rare holo (v|vstar|vmax|gx|ex)|rare ultra$/i.test(r)) return 'RR';
  // Holo
  if (rc === 'HR' || /rare holo$|rare shining/i.test(r)) return 'HR';
  // Promo
  if (rc === 'PR' || /promo/i.test(r)) return 'PR';
  return 'STD';
}

function counterpartEra(sc) {
  if (!sc) return '';
  const u = String(sc).toUpperCase();
  if (u.startsWith('SV')) return 'SV';
  if (u.startsWith('SWSH')) return 'SWSH';
  if (u.startsWith('S') && /^S\d|^SM/.test(u)) return u.startsWith('SM') ? 'SM' : 'SWSH';
  if (u.startsWith('XY')) return 'XY';
  if (u.startsWith('BW')) return 'BW';
  if (u.startsWith('HGSS') || u.startsWith('HS')) return 'HGSS';
  if (u.startsWith('DP') || u.startsWith('PL')) return 'DP';
  if (u.startsWith('EX') || u.startsWith('PCG') || u.startsWith('E')) return 'EX';
  if (u.startsWith('NEO') || u.startsWith('BASE') || u.startsWith('GYM')) return 'BASE';
  return 'OTHER';
}

// Approximate EN<->JP set pairings based on the SV-era release pattern.
// JP set codes typically map cleanly to EN sets but are released first.
const SET_PAIRS = [
  // Scarlet & Violet era
  ['sv1', 'sv1'],            // Scarlet & Violet base
  ['sv2', 'sv2'],            // Paldea Evolved
  ['sv3', 'sv3'],            // Obsidian Flames
  ['sv4', 'sv4'],            // Paradox Rift
  ['sv5', 'sv5'],            // Temporal Forces
  ['sv6', 'sv6'],            // Twilight Masquerade
  ['sv7', 'sv7'],            // Stellar Crown
  ['sv8', 'sv8'],            // Surging Sparks
  // EN-only fusion sets are pairs of JP sets:
  ['sv2', 'sv1v'],           // 151 / Pokemon 151 JP
  ['sv2a', 'sv2a'],          // Pokemon 151
  ['sv3pt5', 'sv2a'],        // 151 EN -> 151 JP
  ['sv4pt5', 'sv4a'],        // Paldean Fates -> Shiny Treasure
  ['sv4pt5', 'sv4'],         // Paldean Fates can also map to Future Flash
  ['sv6pt5', 'sv6a'],        // Shrouded Fable -> Mask of Change
  ['sv7pt5', 'sv7a'],        // Prismatic Evolutions -> Terastal Festival
];
function normSetCode(sc) {
  if (!sc) return '';
  return String(sc).toLowerCase().replace(/^jp-/, '');
}
function counterpartSetMatch(scA, scB) {
  const a = normSetCode(scA), b = normSetCode(scB);
  if (!a || !b) return false;
  if (a === b) return true;
  // Check pairings (both directions)
  for (const [en, jp] of SET_PAIRS) {
    if ((a === en && b === jp) || (a === jp && b === en)) return true;
  }
  return false;
}

function buildCounterpartIndex(cards) {
  counterpartIndex = new Map();
  counterpartByCard = new Map();
  for (const c of cards) {
    // Skip plain commons/uncommons — only chase cards make EN/JP comparison meaningful.
    // We index based on (base name + era) so JP cards (which often lack rarity data)
    // still group with their EN siblings; tier matching is a ranking step in lookup.
    const tier = counterpartTier(c);
    if (c.lang !== 'JP' && (tier === 'STD' || tier === 'PR')) continue; // EN: only chase
    // For JP, exclude obvious commons/uncommons by rarity code if present
    if (c.lang === 'JP' && (c.rc === 'C' || c.rc === 'U')) continue;
    const base = counterpartBaseName(c.n);
    if (!base) continue;
    const era = counterpartEra(c.sc);
    if (!era || era === 'OTHER') continue;
    const key = `${base}|${era}`;
    let bucket = counterpartIndex.get(key);
    if (!bucket) { bucket = { en: [], jp: [] }; counterpartIndex.set(key, bucket); }
    if (c.lang === 'JP') bucket.jp.push(c); else bucket.en.push(c);
    counterpartByCard.set(c.i, key);
  }
}

// Score a counterpart for relevance to the source card.
// Tier match scores highest; price proximity is the tiebreaker.
function scoreCounterpartMatch(source, candidate) {
  let score = 0;
  const sTier = counterpartTier(source);
  const cTier = counterpartTier(candidate);
  if (sTier === cTier) score += 100;
  // Tier compatibility groups (SIR <-> IR; UR <-> RR; etc.)
  const compat = {
    SIR: ['SIR', 'IR', 'UR'],
    IR: ['IR', 'SIR', 'AR'],
    UR: ['UR', 'SIR', 'HR', 'RR'],
    HR: ['HR', 'UR', 'RR'],
    RR: ['RR', 'UR', 'HR'],
  };
  if (sTier !== cTier && compat[sTier] && compat[sTier].includes(cTier)) score += 30;
  // Same set code = strongest signal — use the EN/JP set-pair map.
  if (counterpartSetMatch(source.sc, candidate.sc)) score += 60;
  // Price proximity (in USD): nearer is better, but only meaningful when both > 0
  const sP = source.p || 0, cP = candidate.p || 0;
  if (sP > 0 && cP > 0) {
    const ratio = Math.min(sP, cP) / Math.max(sP, cP);
    score += ratio * 20; // 0..20 bonus
  } else if (cP > 0) {
    // candidate has a price at all
    score += 5;
  }
  // Higher-priced candidates are more likely to be the matching chase printing
  score += Math.min(10, Math.log10(1 + cP));
  // JP chase variants typically have the highest card number in their set.
  // When source is a high-tier EN chase (SIR/IR/UR), prefer JP cards with a
  // large collector number (likely the SAR/SIR printing).
  if (candidate.lang === 'JP' && (sTier === 'SIR' || sTier === 'IR' || sTier === 'UR')) {
    const cn = parseInt(candidate.cn || 0, 10) || 0;
    if (cn > 100) score += Math.min(15, (cn - 100) / 10);
  }
  // Symmetric boost when source is JP with high cn
  if (source.lang === 'JP' && parseInt(source.cn || 0, 10) > 100) {
    // Prefer higher-tier EN counterparts
    if (cTier === 'SIR') score += 20;
    else if (cTier === 'IR' || cTier === 'UR') score += 10;
  }
  return score;
}

// Manual counterpart overrides — user picks the correct EN/JP counterpart
// when our auto-match is wrong. Stored per-card in localStorage.
const CP_OVERRIDE_KEY = 'pkm-counterpart-overrides-v1';
function getCPOverrides() {
  try { return JSON.parse(localStorage.getItem(CP_OVERRIDE_KEY) || '{}'); }
  catch { return {}; }
}
function setCPOverride(cardId, otherId) {
  const all = getCPOverrides();
  all[cardId] = otherId;
  try { localStorage.setItem(CP_OVERRIDE_KEY, JSON.stringify(all)); } catch {}
}
function clearCPOverride(cardId) {
  const all = getCPOverrides();
  delete all[cardId];
  try { localStorage.setItem(CP_OVERRIDE_KEY, JSON.stringify(all)); } catch {}
}
function getCPOverride(cardId) {
  return getCPOverrides()[cardId] || null;
}

// Returns { counterparts:[cards], primary, counterpartLang, isManual }
function findCounterparts(card) {
  if (!card) return null;
  // Manual override wins over auto-detection
  const overrideId = getCPOverride(card.i);
  if (overrideId && cardData) {
    const other = getCardById(overrideId);
    if (other) {
      return {
        counterparts: [other],
        primary: other,
        counterpartLang: other.lang === 'JP' ? 'JP' : 'EN',
        isManual: true,
      };
    }
    // Override points to a card no longer in DB — fall through to auto
  }
  const key = counterpartByCard.get(card.i);
  if (!key) return null;
  const bucket = counterpartIndex.get(key);
  if (!bucket) return null;
  const isJP = card.lang === 'JP';
  const counterparts = isJP ? bucket.en : bucket.jp;
  if (!counterparts || counterparts.length === 0) return null;
  // Rank counterparts by tier-match + price proximity
  const ranked = [...counterparts].sort((a, b) => scoreCounterpartMatch(card, b) - scoreCounterpartMatch(card, a));
  // Quality gate: only return a recommendation if the BEST counterpart has either
  // a matching/compatible tier OR a non-trivial price. Otherwise we'd be matching
  // an EN Special Illustration Rare to a JP base-set common, which would mislead.
  const best = ranked[0];
  const sTier = counterpartTier(card);
  const cTier = counterpartTier(best);
  const tierOk = sTier === cTier ||
    (sTier === 'SIR' && (cTier === 'IR' || cTier === 'UR')) ||
    (sTier === 'IR' && (cTier === 'SIR' || cTier === 'AR')) ||
    (sTier === 'UR' && (cTier === 'SIR' || cTier === 'HR' || cTier === 'RR')) ||
    (sTier === 'RR' && (cTier === 'UR' || cTier === 'HR'));
  // For JP source cards with no rarity data, accept any EN counterpart whose
  // tier is RR or higher (i.e., the user can still find a real chase printing).
  const jpFallback = isJP && (cTier === 'SIR' || cTier === 'IR' || cTier === 'UR' || cTier === 'HR' || cTier === 'RR');
  if (!tierOk && !jpFallback) return null;
  return {
    counterparts: ranked,
    primary: best,
    counterpartLang: isJP ? 'EN' : 'JP',
  };
}

function hasCounterpart(card) {
  const r = findCounterparts(card);
  return !!(r && r.primary);
}

// Build a compact EN-vs-JP recommendation given a card and its counterpart
function buildCounterpartRecommendation(card) {
  const cp = findCounterparts(card);
  if (!cp) return null;
  const other = cp.primary;

  // Pull live/current price in USD for both
  const selfUSD = getCurrentPrice(card);
  const otherUSD = getCurrentPrice(other);
  const selfGBP = usdToGbp(selfUSD);
  const otherGBP = usdToGbp(otherUSD);

  // If we don't have at least one real price, offer the link but no verdict
  if (selfUSD <= 0 || otherUSD <= 0) {
    return {
      other,
      otherLang: cp.counterpartLang,
      selfGBP, otherGBP,
      verdict: 'link-only',
      reason: `We found the ${cp.counterpartLang === 'JP' ? 'Japanese' : 'English'} counterpart but don't have a reliable price for one side yet. Open it to see the live market.`,
    };
  }

  // Both prices available — give a real recommendation
  const cheaper = selfUSD < otherUSD ? card : other;
  const cheaperLang = cheaper.lang === 'JP' ? 'JP' : 'EN';
  const pricier = cheaper === card ? other : card;
  const cheaperUSD = Math.min(selfUSD, otherUSD);
  const pricierUSD = Math.max(selfUSD, otherUSD);
  // Savings as a % of the MORE expensive version (e.g., £207 vs £1 → 99% savings, not 15000%)
  const savingsPct = pricierUSD > 0 ? Math.min(99, ((pricierUSD - cheaperUSD) / pricierUSD) * 100) : 0;
  const savingsGBP = Math.abs(selfGBP - otherGBP);

  // Quality tiebreakers: PSA 10 ceiling & gem rate
  const selfPSA10 = card.p10 || 0, otherPSA10 = other.p10 || 0;
  const psaSame = !selfPSA10 || !otherPSA10;

  let verdict, reason, verdictByRoi = false;
  const cheaperGBPv = usdToGbp(cheaperUSD);
  const pricierGBPv = usdToGbp(pricierUSD);
  if (savingsPct < 8) {
    verdict = 'tie';
    reason = `Prices are within ${savingsPct.toFixed(0)}% of each other (£${selfGBP.toFixed(2)} vs £${otherGBP.toFixed(2)}). Either printing is fine — pick the one you prefer visually.`;
  } else if (savingsPct > 50) {
    verdict = cheaperLang === 'JP' ? 'buy-jp' : 'buy-en';
    reason = `The ${cheaperLang === 'JP' ? 'Japanese' : 'English'} version is dramatically cheaper at <strong>£${cheaperGBPv.toFixed(2)}</strong> vs <strong>£${pricierGBPv.toFixed(2)}</strong> — ${savingsPct.toFixed(0)}% less, saving ~£${savingsGBP.toFixed(2)}. Unless you specifically want the ${cheaperLang === 'JP' ? 'English' : 'Japanese'} art or the higher PSA 10 grading ceiling, grab the ${cheaperLang === 'JP' ? 'JP' : 'EN'} printing.`;
  } else {
    verdict = cheaperLang === 'JP' ? 'buy-jp' : 'buy-en';
    const ceilingNote = psaSame ? '' : ` The English PSA 10 ceiling is typically higher, so if you plan to grade, the EN version may still be worth the premium.`;
    reason = `The ${cheaperLang === 'JP' ? 'Japanese' : 'English'} version is ${savingsPct.toFixed(0)}% cheaper (£${cheaperGBPv.toFixed(2)} vs £${pricierGBPv.toFixed(2)}).${cheaperLang === 'JP' ? ' For raw collecting or sealing in a binder, JP is the value play.' : ' Rare case where the English printing undercuts the Japanese — worth a closer look.'}${cheaperLang === 'JP' && !psaSame ? ceilingNote : ''}`;
  }

  // ── Three buyer-scenario advisories using Hold Strategy model data ───────
  const selfIsEN = card.lang !== 'JP';
  const enCardRef = selfIsEN ? card : other;
  const jpCardRef = selfIsEN ? other : card;
  const enRawGBP  = selfIsEN ? selfGBP : otherGBP;
  const jpRawGBP  = selfIsEN ? otherGBP : selfGBP;

  // Run the same hold model used by the Hold Strategy card for both versions
  const enHold = (typeof computeHoldCore === 'function') ? computeHoldCore(enCardRef) : null;
  const jpHold = (typeof computeHoldCore === 'function') ? computeHoldCore(jpCardRef) : null;
  const getStrat = (hold, key) => (hold && hold.ok ? hold.strategies.find(s => s.key === key) : null);
  const fmtRoi = roi => `<span class="cp-sr ${roi >= 0 ? 'pos' : 'neg'}">${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%</span>`;
  const fmtP = usd => usd > 0 ? `£${usdToGbp(usd).toFixed(0)}` : '—';

  // JP PSA 10 anchor quality — drives whether we trust the grade scenarios
  const jpAnchorSrc = jpHold ? jpHold.anchorSource : null;
  const jpPsa10Real = jpAnchorSrc === 'tracked' || jpAnchorSrc === 'live' || jpAnchorSrc === 'manual-override';
  const jpPsa10Manual = getJpPsa10Override(jpCardRef.i); // user-saved manual entry

  // ── S1: Raw, keep raw ──
  // Winner balances upfront cost saving vs long-term ROI projection.
  // ROI CAN differ between EN and JP because projectGradePrice anchors on each
  // card's PSA10 ceiling — a higher ceiling lifts the 5yr raw projection.
  // Formula: pricier card wins if its ROI advantage > savingsPct × 0.4.
  // At 13% gap that threshold is 5.2pts — a clear EN upside overcomes it.
  // At 25%+ gap the bar rises proportionally so a big saving still wins unless
  // the long-term edge is substantial.
  let s1, s1winner;
  {
    const enS = getStrat(enHold, 'raw');
    const jpS = getStrat(jpHold, 'raw');
    const enLine = enS
      ? `EN £${enRawGBP.toFixed(0)} → 5yr ${fmtP(enS.yr5)} ${fmtRoi(enS.roi)}`
      : `EN £${enRawGBP.toFixed(0)}`;
    const jpLine = jpS
      ? `JP £${jpRawGBP.toFixed(0)} → 5yr ${fmtP(jpS.yr5)} ${fmtRoi(jpS.roi)}`
      : `JP £${jpRawGBP.toFixed(0)}`;

    if (savingsPct < 8) {
      s1winner = 'TIE';
      s1 = `Within 8% — pick the art you prefer. ${enLine} · ${jpLine}.`;
    } else if (!enS || !jpS) {
      // No model data for one side — fall back to cheaper
      s1winner = cheaperLang;
      s1 = `${cheaperLang} is cheaper. ${enLine} · ${jpLine} · saves £${savingsGBP.toFixed(0)}.`;
    } else {
      const cheaperRoi  = cheaperLang === 'EN' ? enS.roi : jpS.roi;
      const pricierLang = cheaperLang === 'EN' ? 'JP' : 'EN';
      const pricierRoi  = pricierLang === 'EN' ? enS.roi : jpS.roi;
      // How much better is the pricier card's long-term ROI?
      const roiAdv = pricierRoi - cheaperRoi;

      if (roiAdv > savingsPct * 0.4) {
        // Pricier card's ROI edge is proportionally large enough to justify the premium
        s1winner = pricierLang;
        s1 = `${pricierLang} has stronger long-term growth (+${roiAdv.toFixed(0)}pt ROI edge) — worth the £${savingsGBP.toFixed(0)} premium. ${enLine} · ${jpLine}.`;
      } else if (roiAdv > 0) {
        // Pricier has slightly better ROI but not enough — cheaper still wins
        s1winner = cheaperLang;
        s1 = `${cheaperLang} is the value play — ${savingsGBP.toFixed(0)}% saving outweighs ${roiAdv.toFixed(0)}pt ROI gap. ${enLine} · ${jpLine}.`;
      } else {
        // Cheaper has equal or better ROI — no contest
        s1winner = cheaperLang;
        s1 = `${cheaperLang} wins on both price and long-term return. ${enLine} · ${jpLine} · saves £${savingsGBP.toFixed(0)}.`;
      }
    }
  }

  // ── S2: Raw to grade ──
  // Uses the full hold model "gamble" strategy (probability-weighted across all grade outcomes).
  let s2, s2winner = 'EN', s2NeedsJpPsa10 = false;
  {
    const enG = getStrat(enHold, 'gamble');
    const jpG = getStrat(jpHold, 'gamble');
    if (enG && jpG && jpPsa10Real) {
      const enCost = fmtP(enG.today); const enYr5 = fmtP(enG.yr5);
      const jpCost = fmtP(jpG.today); const jpYr5 = fmtP(jpG.yr5);
      const diff = enG.riskAdjusted - jpG.riskAdjusted;
      if (Math.abs(diff) < 8) {
        s2winner = 'EN';
        s2 = `Grade EV similar — lean EN for liquidity. EN: ${enCost} in → ${enYr5} ${fmtRoi(enG.roi)} · JP: ${jpCost} → ${jpYr5} ${fmtRoi(jpG.roi)}.`;
      } else if (enG.riskAdjusted > jpG.riskAdjusted) {
        s2winner = 'EN';
        s2 = `EN has stronger grading upside. EN: ${enCost} in → ${enYr5} ${fmtRoi(enG.roi)} · JP: ${jpCost} → ${jpYr5} ${fmtRoi(jpG.roi)}.`;
      } else {
        s2winner = 'JP';
        s2 = `JP edges EN on risk-adjusted grade EV. JP: ${jpCost} in → ${jpYr5} ${fmtRoi(jpG.roi)} · EN: ${enCost} → ${enYr5} ${fmtRoi(enG.roi)} · JP slab market is thinner.`;
      }
    } else if (enG) {
      s2winner = 'EN';
      s2NeedsJpPsa10 = true;
      const src = jpAnchorSrc === 'estimated' ? '(estimated PSA 10)' : '—';
      s2 = `EN: £${fmtP(enG.today)} in → ${fmtP(enG.yr5)} ${fmtRoi(enG.roi)} · JP PSA 10 ${src} — add it below to compare.`;
    } else {
      s2winner = 'EN'; s2NeedsJpPsa10 = true;
      s2 = `EN grades more consistently on modern sets. Add JP PSA 10 price below to run the full comparison.`;
    }
  }

  // ── S3: Buy slabbed PSA 10 ──
  // Uses the hold model "psa10" strategy for each side.
  let s3, s3winner = 'EN', s3NeedsJpPsa10 = false;
  {
    const enP = getStrat(enHold, 'psa10');
    const jpP = getStrat(jpHold, 'psa10');
    if (enP && jpP && jpPsa10Real) {
      const enCost = fmtP(enP.today); const enYr5 = fmtP(enP.yr5);
      const jpCost = fmtP(jpP.today); const jpYr5 = fmtP(jpP.yr5);
      const enScore = enP.riskAdjusted - (typeof capitalOutlayPenalty === 'function' ? capitalOutlayPenalty(usdToGbp(enP.today)) : 0);
      const jpScore = jpP.riskAdjusted - (typeof capitalOutlayPenalty === 'function' ? capitalOutlayPenalty(usdToGbp(jpP.today)) : 0);
      const diff = enScore - jpScore;
      if (Math.abs(diff) < 5) {
        s3winner = 'EN';
        s3 = `Similar upside — lean EN. EN PSA 10: ${enCost} → ${enYr5} ${fmtRoi(enP.roi)} · JP: ${jpCost} → ${jpYr5} ${fmtRoi(jpP.roi)} · deeper EN resale pool.`;
      } else if (enScore > jpScore) {
        s3winner = 'EN';
        s3 = `EN PSA 10: ${enCost} → ${enYr5} ${fmtRoi(enP.roi)} · JP: ${jpCost} → ${jpYr5} ${fmtRoi(jpP.roi)}.`;
      } else {
        s3winner = 'JP';
        s3 = `JP PSA 10: ${jpCost} → ${jpYr5} ${fmtRoi(jpP.roi)} · EN: ${enCost} → ${enYr5} ${fmtRoi(enP.roi)} · JP slabs exit more slowly.`;
      }
    } else if (enP) {
      s3winner = 'EN'; s3NeedsJpPsa10 = true;
      s3 = `EN PSA 10: ${fmtP(enP.today)} → ${fmtP(enP.yr5)} ${fmtRoi(enP.roi)} · Add JP PSA 10 price below to compare.`;
    } else {
      s3winner = 'EN'; s3NeedsJpPsa10 = true;
      s3 = `No PSA 10 data. Add JP PSA 10 price below — EN is generally more liquid if no data exists.`;
    }
  }

  const needsJpPsa10 = s2NeedsJpPsa10 || s3NeedsJpPsa10;

  // ── Reconcile headline verdict with scenario analysis ──────────────────
  // The price-only verdict above picks the cheaper card. If the S1 model
  // analysis says the pricier card has enough ROI advantage to justify the
  // premium, override the headline so it stays consistent with the breakdown.
  if (s1winner && s1winner !== 'TIE' && s1winner !== cheaperLang) {
    const enSRaw = getStrat(enHold, 'raw');
    const jpSRaw = getStrat(jpHold, 'raw');
    if (enSRaw && jpSRaw) {
      const pricierRoi = s1winner === 'EN' ? enSRaw.roi : jpSRaw.roi;
      const cheaperRoi = s1winner === 'EN' ? jpSRaw.roi : enSRaw.roi;
      const roiAdv = Math.max(0, pricierRoi - cheaperRoi);
      verdict = s1winner === 'JP' ? 'buy-jp' : 'buy-en';
      verdictByRoi = true;
      reason = `The ${s1winner} version is <strong>£${savingsGBP.toFixed(2)} more</strong> upfront but the model projects a <strong>+${roiAdv.toFixed(0)}pt ROI edge</strong> over 5 years — the premium is offset by stronger long-term growth. See the scenario breakdown below.`;
    }
  }

  const scenarios = [
    { key: 'raw-keep',    label: 'Raw, keep raw', winner: s1winner, text: s1 },
    { key: 'raw-grade',   label: 'Raw to grade',  winner: s2winner, text: s2 },
    { key: 'buy-slabbed', label: 'Buy slabbed',   winner: s3winner, text: s3 },
  ];

  return {
    other, otherLang: cp.counterpartLang,
    selfUSD, otherUSD, selfGBP, otherGBP,
    cheaper, cheaperLang, pricier, savingsPct, savingsGBP,
    verdict, reason, verdictByRoi,
    totalCounterparts: cp.counterparts.length,
    scenarios,
    needsJpPsa10,
    jpCardRef,
    jpPsa10Manual,
  };
}
function cheaperGBP(a, b, cheaper) { return usdToGbp(cheaper === a ? getCurrentPrice(a) : getCurrentPrice(b)); }
function pricierGBP(a, b, pricier) { return usdToGbp(pricier === a ? getCurrentPrice(a) : getCurrentPrice(b)); }

// Render the EN ↔ JP recommendation panel for the selected card.
function renderCounterpartFlag(card) {
  const wrap = document.getElementById('counterpartFlag');
  if (!wrap) return;
  if (!card) { wrap.style.display = 'none'; return; }

  const rec = buildCounterpartRecommendation(card);
  if (!rec) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'flex';
  wrap.classList.remove('verdict-buy-jp', 'verdict-buy-en', 'verdict-tie', 'verdict-link-only', 'verdict-manual');
  wrap.classList.add('verdict-' + rec.verdict);

  const badge = document.getElementById('cpBadge');
  const headline = document.getElementById('cpHeadline');
  const prices = document.getElementById('cpPrices');
  const reason = document.getElementById('cpReason');
  const openBtn = document.getElementById('cpOpenBtn');
  const compareBtn = document.getElementById('cpCompareBtn');

  // Headline + badge text per verdict
  const isJPSelf = card.lang === 'JP';
  const isManual = !!getCPOverride(card.i);
  if (rec.verdict === 'buy-jp') {
    badge.textContent = rec.verdictByRoi ? 'JP long-term' : 'Get the JP';
    headline.innerHTML = rec.verdictByRoi
      ? `<strong>Japanese version is the smarter long-term buy</strong>`
      : `<strong>Japanese version is the value pick</strong>`;
  } else if (rec.verdict === 'buy-en') {
    badge.textContent = rec.verdictByRoi ? 'EN long-term' : 'Get the EN';
    headline.innerHTML = rec.verdictByRoi
      ? `<strong>English version is the smarter long-term buy</strong>`
      : `<strong>English version is cheaper here</strong>`;
  } else if (rec.verdict === 'tie') {
    badge.textContent = 'Toss-up';
    headline.innerHTML = `<strong>Either version works</strong>`;
  } else {
    badge.textContent = 'Counterpart';
    headline.innerHTML = `${isJPSelf ? 'English' : 'Japanese'} counterpart found`;
  }
  if (isManual) {
    badge.textContent = 'Manual pick';
    wrap.classList.add('verdict-manual');
  } else {
    wrap.classList.remove('verdict-manual');
  }

  // Price cells — self on left, counterpart on right
  const selfLang = isJPSelf ? 'JP' : 'EN';
  const otherLang = rec.otherLang;
  const selfFlag = isJPSelf ? '🇯🇵' : '🇬🇧';
  const otherFlag = otherLang === 'JP' ? '🇯🇵' : '🇬🇧';
  const selfPriceTxt = rec.selfGBP > 0 ? `£${rec.selfGBP.toFixed(2)}` : '—';
  const otherPriceTxt = rec.otherGBP > 0 ? `£${rec.otherGBP.toFixed(2)}` : '—';
  const selfCheaper = rec.cheaper === card;
  const otherCheaper = !selfCheaper && rec.verdict !== 'tie' && rec.verdict !== 'link-only';
  const selfCellCls = (rec.verdict !== 'tie' && rec.verdict !== 'link-only') ? (selfCheaper ? 'is-cheaper' : 'is-pricier') : '';
  const otherCellCls = (rec.verdict !== 'tie' && rec.verdict !== 'link-only') ? (otherCheaper ? 'is-cheaper' : 'is-pricier') : '';

  // Tier labels for transparency — user should see if matching SIR-to-DR
  const tierLabel = (c) => {
    const t = counterpartTier(c);
    const map = { SIR: 'Special Illustration', IR: 'Illustration Rare', UR: 'Ultra Rare', RR: 'Double Rare', HR: 'Hyper Rare', AR: 'Art Rare', PR: 'Promo' };
    return c.r || map[t] || '';
  };
  const selfTier = tierLabel(card);
  const otherTier = tierLabel(rec.other);
  const tierMismatch = counterpartTier(card) !== counterpartTier(rec.other) && selfTier && otherTier;

  prices.innerHTML = `
    <div class="cp-price-cell ${selfCellCls}">
      <span class="cp-price-lang">${selfFlag} ${selfLang} · This card</span>
      <span class="cp-price-amt">${selfPriceTxt}</span>
      <span class="cp-price-name">${esc(card.s || '')}${card.cn ? ' #' + card.cn : ''}${selfTier ? ' · ' + esc(selfTier) : ''}</span>
    </div>
    <div class="cp-price-arrow">↔</div>
    <div class="cp-price-cell ${otherCellCls}">
      <span class="cp-price-lang">${otherFlag} ${otherLang} · Counterpart</span>
      <span class="cp-price-amt">${otherPriceTxt}</span>
      <span class="cp-price-name">${esc(rec.other.s || '')}${rec.other.cn ? ' #' + rec.other.cn : ''}${otherTier ? ' · ' + esc(otherTier) : ''}</span>
    </div>
  `;

  // If tiers don't match, prepend a transparency note so user isn't misled
  let reasonHtml = rec.reason;
  if (tierMismatch && rec.verdict !== 'link-only') {
    reasonHtml = `<em style="color:var(--accent)">Note:</em> the closest match in our database is a different rarity tier (${esc(selfTier)} ↔ ${esc(otherTier)}) — the artwork won't be identical. ${reasonHtml}`;
  }
  reason.innerHTML = reasonHtml;

  // Buyer scenario advisories
  const scenariosEl = document.getElementById('cpScenarios');
  if (scenariosEl) {
    if (rec.scenarios && rec.scenarios.length && rec.verdict !== 'link-only') {
      const winnerChip = (w) => {
        if (!w || w === 'TIE') return '<span class="cp-sw cp-sw-tie">— Either</span>';
        return `<span class="cp-sw cp-sw-${w.toLowerCase()}">★ ${w}</span>`;
      };
      scenariosEl.innerHTML = rec.scenarios.map(s =>
        `<div class="cp-scenario">
          <div class="cp-scenario-head">
            <span class="cp-scenario-label">${s.label}</span>
            ${winnerChip(s.winner)}
          </div>
          <span class="cp-scenario-text">${s.text}</span>
        </div>`
      ).join('');

      // JP PSA 10 manual input — shown when grade scenarios can't compare
      if (rec.needsJpPsa10 && rec.jpCardRef) {
        const jp = rec.jpCardRef;
        const existing = rec.jpPsa10Manual;
        const existingHtml = existing
          ? `<span class="cp-jp10-saved">Saved £${existing.gbp.toFixed(0)} · ${existing.date}</span>`
          : '';
        scenariosEl.innerHTML += `
          <div class="cp-jp10-row" id="cpJp10Row">
            <span class="cp-jp10-label">JP PSA 10 price</span>
            <input id="cpJp10Input" class="cp-jp10-input" type="number" min="0" step="0.01"
              placeholder="£ market price" value="${existing ? existing.gbp : ''}">
            <button id="cpJp10Save" class="cp-jp10-save" type="button" data-cardid="${esc(jp.i)}">Save</button>
            ${existingHtml}
          </div>`;
        const saveBtn = scenariosEl.querySelector('#cpJp10Save');
        if (saveBtn) {
          saveBtn.addEventListener('click', () => {
            const input = scenariosEl.querySelector('#cpJp10Input');
            const gbp = parseFloat(input?.value || '');
            if (!gbp || gbp <= 0) { if (input) input.style.outline = '1px solid var(--red)'; return; }
            const d = new Date();
            const dateStr = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
            setJpPsa10Override(jp.i, gbp, dateStr);
            renderCounterpartFlag(selectedCard);
          });
        }
      }

      scenariosEl.style.display = 'flex';
    } else {
      scenariosEl.style.display = 'none';
    }
  }

  // Wire actions
  openBtn.textContent = `Open ${otherLang} version →`;
  openBtn.onclick = () => selectCard(rec.other.i);
  compareBtn.onclick = () => {
    // Pin both into the compare slots and open the panel
    compareSlots[0] = snapshotCardForCompare(card);
    compareSlots[1] = snapshotCardForCompare(rec.other);
    saveCompare();
    renderCompare();
    updateCompareButton();
    openComparePanel();
  };

  // Background: warm the counterpart's live price so the next paint has live data
  warmCounterpartLivePrice(rec.other);
}

// Fetch counterpart's live price into cache (no UI change), then re-render the flag.
let _counterpartWarmId = null;
async function warmCounterpartLivePrice(other) {
  if (!other || !other.i) return;
  if (_counterpartWarmId === other.i) return; // already warming
  if (getCachedPrice(other.i)) return; // already cached
  _counterpartWarmId = other.i;
  try {
    if (typeof fetchFreshPriceData === 'function') {
      const data = await fetchFreshPriceData(other);
      if (data) {
        if (typeof setCachedPrice === 'function') setCachedPrice(other.i, data);
        // Re-render flag if still on the same card
        if (selectedCard && counterpartByCard.get(selectedCard.i) === counterpartByCard.get(other.i)) {
          renderCounterpartFlag(selectedCard);
        }
      }
    }
  } catch (e) {
    // Silent: counterpart price warm-up is best-effort
  } finally {
    _counterpartWarmId = null;
  }
}

function setupSearch() {
  const input = $('searchInput');
  const clear = $('searchClear');
  let debounce;

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    clear.style.display = input.value ? 'block' : 'none';
    debounce = setTimeout(() => doSearch(input.value), 180);
  });

  input.addEventListener('focus', () => {
    if (input.value.length >= 2) doSearch(input.value);
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.style.display = 'none';
    $('searchResults').classList.remove('open');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-section')) {
      $('searchResults').classList.remove('open');
    }
  });
}

function doSearch(query) {
  const results = $('searchResults');
  query = query.trim().toLowerCase();
  if (query.length < 2) { results.classList.remove('open'); return; }

  // num/total pattern (e.g. "764/742" or "#764/742") — _search doesn't contain
  // the slash form, so filter by card number directly and sort by exact cn+ct match.
  const numSlashMatch = query.match(/^#?(\d+)\/(\d+)$/);
  let matches;
  if (numSlashMatch) {
    const [, num, total] = numSlashMatch;
    matches = searchIndex.filter(c => String(c.cn) === num || c._search.includes(num));
    matches.sort((a, b) => {
      const aExact = (String(a.cn) === num && String(a.ct) === total) ? 2 : String(a.cn) === num ? 1 : 0;
      const bExact = (String(b.cn) === num && String(b.ct) === total) ? 2 : String(b.cn) === num ? 1 : 0;
      return bExact - aExact;
    });
  } else {
    matches = searchIndex.filter(c => c._search.includes(query));
    if (/^\d+$/.test(query) || /^#\d+/.test(query)) {
      const num = query.replace('#', '');
      matches.sort((a, b) => {
        const aExact = String(a.cn) === num ? 1 : 0;
        const bExact = String(b.cn) === num ? 1 : 0;
        return bExact - aExact;
      });
    }
  }

  matches.sort((a, b) => {
    const aName = a.n.toLowerCase().startsWith(query) ? 1 : 0;
    const bName = b.n.toLowerCase().startsWith(query) ? 1 : 0;
    if (aName !== bName) return bName - aName;
    return b.p - a.p;
  });
  matches = matches.slice(0, 30);

  if (!matches.length) {
    results.innerHTML = `
      <div class="search-empty-state">
        <div class="search-empty-text">No cards found — try a different name or card number.</div>
        <button class="search-empty-add" id="searchOpenManualAdd">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          Add card manually (look up on TCG Collector)
        </button>
      </div>`;
    const btn = results.querySelector('#searchOpenManualAdd');
    if (btn) btn.addEventListener('click', () => {
      const seed = $('searchInput').value.trim();
      if (typeof openManualAdd === 'function') openManualAdd(seed);
    });
    results.classList.add('open');
    return;
  }

  results.innerHTML = matches.map(c => {
    const numLabel = c.cn && c.ct ? `#${c.cn}/${c.ct}` : c.cn ? `#${c.cn}` : '';
    const seriesLabel = c.sr && c.sr !== 'Scarlet & Violet' ? `<span class="meta-series">${esc(c.sr)}</span>` : '';
    const isJP = c.lang === 'JP';
    const langBadge = isJP ? '<span class="lang-badge jp">JP</span>' : '';
    const jpNameLabel = isJP && c.nj ? `<span class="jp-name">${esc(c.nj)}</span>` : '';
    const cpFlag = hasCounterpart(c) ? `<span class="search-result-cp-flag" title="${isJP ? 'English' : 'Japanese'} counterpart available">⇄ ${isJP ? 'EN' : 'JP'}</span>` : '';
    // Show cached live price if available, else static
    const cached = getCachedPrice(c.i);
    const displayPrice = cached ? (cached.market || cached.mid || c.p) : c.p;
    const isLive = !!cached;
    const priceLabel = displayPrice > 0 ? `
        <span class="gbp">${fmtGBP(displayPrice)}</span>
        <span class="usd">${fmtUSD(displayPrice)}</span>
        ${isLive ? '<span class="live-dot" title="Live price"></span>' : ''}` : '<span class="no-price">No price data</span>';
    return `
    <div class="search-result-item${isJP ? ' jp-card' : ''}" data-id="${c.i}">
      ${`<img class="search-result-img" src="${getCardImg(c)}" alt="" loading="lazy" onerror="_onImgError(this)">`}
      <div class="search-result-info">
        <div class="search-result-name">${langBadge}${esc(c.n)}${cpFlag}${jpNameLabel}</div>
        <div class="search-result-meta">
          <span>${esc(c.s)}</span>
          ${numLabel ? `<span class="meta-num">${numLabel}</span>` : ''}
          ${c.r ? `<span style="color:var(--accent)">${esc(c.r)}</span>` : ''}
          ${seriesLabel}
        </div>
      </div>
      <div class="search-result-price">${priceLabel}
      </div>
    </div>
  `}).join('');

  results.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => selectCard(el.dataset.id));
    // Prefetch price data after 180 ms hover so it's cached by the time the user clicks.
    let _pt;
    el.addEventListener('mouseenter', () => {
      _pt = setTimeout(() => {
        const c = getCardById(el.dataset.id);
        if (c && !getCachedPrice(c.i)) {
          fetchFreshPriceData(c).then(d => { if (d) setCachedPrice(c.i, d); }).catch(() => {});
        }
      }, 180);
    });
    el.addEventListener('mouseleave', () => clearTimeout(_pt));
  });
  results.classList.add('open');
}

function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// O(1) card lookup via pre-built Map. Replaces all getCardById(id) calls.
function getCardById(id) { return _cardMap ? (_cardMap.get(id) ?? null) : null; }

function _getCachedSignal(card, pull, des) {
  const k = card.i, now = Date.now(), c = _sigCache.get(k);
  if (c && now - c.ts < _COMP_TTL) return c.v;
  const v = computeSignal(card, pull, des);
  _sigCache.set(k, { v, ts: now });
  return v;
}
function _getHoldCoreCached(card) {
  const k = card.i, now = Date.now(), c = _hcCache.get(k);
  if (c && now - c.ts < _COMP_TTL) return c.v;
  const v = computeHoldCore(card);
  _hcCache.set(k, { v, ts: now });
  return v;
}

// In iOS standalone PWA mode, window.open() creates an in-app SFSafariViewController
// which gets intercepted by Universal Links (eBay, etc.) and leaves a blank white page.
// Navigate the current window instead — iOS shows a "Back to app" button in Safari.
function openExternalUrl(url) {
  if (!url) return;
  if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
    window.location.href = url;
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ================================================================
// ---- LIVE PRICING ENGINE ----
// ================================================================

// Fetch live pricing for EN cards from pokemontcg.io (CORS-enabled, no proxy needed)
async function fetchLivePriceEN(cardId) {
  const url = `https://api.pokemontcg.io/v2/cards/${cardId}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`pokemontcg.io ${r.status}`);
  const json = await r.json();
  const d = json.data;
  if (!d) throw new Error('No data');

  const tcg = d.tcgplayer?.prices || {};
  const cm = d.cardmarket?.prices || {};

  // TCGPlayer: pick the best sub-type (holofoil > reverseHolofoil > normal > 1stEditionHolofoil > etc)
  const tcgTypes = ['holofoil', 'reverseHolofoil', 'normal', '1stEditionHolofoil', 'unlimitedHolofoil', '1stEditionNormal', 'unlimited'];
  let tcgPrices = null;
  for (const t of tcgTypes) {
    if (tcg[t]) { tcgPrices = tcg[t]; break; }
  }
  // Fallback: first available
  if (!tcgPrices) {
    const firstKey = Object.keys(tcg)[0];
    if (firstKey) tcgPrices = tcg[firstKey];
  }

  const result = {
    source: 'pokemontcg.io',
    // TCGPlayer prices
    market: tcgPrices?.market || 0,
    low: tcgPrices?.low || 0,
    mid: tcgPrices?.mid || 0,
    high: tcgPrices?.high || 0,
    directLow: tcgPrices?.directLow || 0,
    tcgUpdated: d.tcgplayer?.updatedAt || '',
    tcgUrl: d.tcgplayer?.url || '',
    // Cardmarket prices
    cmTrend: cm.trendPrice || 0,
    cmAvg1: cm.avg1 || 0,
    cmAvg7: cm.avg7 || 0,
    cmAvg30: cm.avg30 || 0,
    cmLow: cm.lowPrice || 0,
    cmSuggested: cm.suggestedPrice || 0,
    cmUpdated: d.cardmarket?.updatedAt || '',
    cmUrl: d.cardmarket?.url || '',
  };

  return result;
}

// Extract TCGPlayer product ID from a saved URL
// e.g. https://www.tcgplayer.com/product/123456/pokemon-... → "123456"
function extractTcgProductId(url) {
  const m = url && String(url).match(/\/product\/(\d+)/);
  return m ? m[1] : null;
}

// Fetch TCGPlayer prices via pokemontcg.io using multiple query strategies.
// `card` is used for set.id + number queries (most reliable approach).
// The TCGPlayer product ID embedded in the saved URL is used as a last-ditch
// fallback in case pokemontcg.io ever indexes that field.
const TCG_PRICE_TYPES = ['holofoil','reverseHolofoil','normal','1stEditionHolofoil','unlimitedHolofoil','1stEditionNormal','unlimited'];

async function fetchTCGPlayerPriceByProductId(productId, card) {
  // Primary: worker reads the TCGPlayer product page directly (bypasses CORS + API lock)
  if (productId) {
    try {
      const workerUrl = getMktWorkerUrl();
      const r = await fetch(`${workerUrl}/tcg-price?productId=${encodeURIComponent(productId)}`);
      if (r.ok) {
        const d = await r.json();
        if (d && (d.market > 0 || d.low > 0)) {
          return { market: d.market || 0, low: d.low || 0, mid: d.mid || 0, high: d.high || 0, directLow: d.directLow || 0, tcgUpdated: '' };
        }
      }
    } catch { /* silent — worker is best-effort */ }
  }

  // Fallback: pokemontcg.io (EN cards only, requires set metadata)
  const _pickPrices = (d) => {
    if (!d) return null;
    const tcg = d.tcgplayer?.prices || {};
    let p = null;
    for (const t of TCG_PRICE_TYPES) { if (tcg[t]) { p = tcg[t]; break; } }
    if (!p) { const k = Object.keys(tcg)[0]; if (k) p = tcg[k]; }
    if (!p?.market) return null;
    return { market: p.market || 0, low: p.low || 0, mid: p.mid || 0, high: p.high || 0, directLow: p.directLow || 0, tcgUpdated: d.tcgplayer?.updatedAt || '' };
  };

  const _query = async (q) => {
    const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=8`);
    if (!r.ok) return null;
    const json = await r.json();
    const cards = json.data || [];
    const match = (card && card.cn) ? (cards.find(c => String(c.number) === String(card.cn)) || cards[0]) : cards[0];
    return _pickPrices(match);
  };

  if (card && card.sc && card.cn) {
    const r1 = await _query(`set.id:${card.sc} number:${card.cn}`).catch(() => null);
    if (r1) return r1;
  }
  if (card && card.n && card.sc) {
    const safeName = card.n.replace(/[":]/g, '').slice(0, 40);
    const r2 = await _query(`name:"${safeName}" set.id:${card.sc}`).catch(() => null);
    if (r2) return r2;
  }

  return null;
}

// ================================================================
// PriceCharting search — primary live-pricing source
// ================================================================
//
// Strategy:
// 1. Build a tight query that includes the set name (so we don't match
//    a same-numbered card from a different set).
// 2. Score every returned product against (set, name, number) and pick the
//    best one. If confidence is low, mark it as 'low' so the UI can prompt
//    the user to override manually.
// 3. If the user has saved a manual override (PriceCharting product ID)
//    for this card, fetch that product directly and bypass search.

const parsePCPrice = (s) => {
  if (!s) return 0;
  return parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0;
};

// localStorage key for per-card PriceCharting overrides
const PC_OVERRIDE_KEY = 'pkm-pc-overrides-v1';
function getPCOverrides() {
  try { return JSON.parse(localStorage.getItem(PC_OVERRIDE_KEY) || '{}'); }
  catch { return {}; }
}
function setPCOverride(cardId, product) {
  const all = getPCOverrides();
  if (product) all[cardId] = product; else delete all[cardId];
  try { localStorage.setItem(PC_OVERRIDE_KEY, JSON.stringify(all)); } catch {}
}
function getPCOverride(cardId) {
  const all = getPCOverrides();
  return all[cardId] || null;
}

// Build the cleanest possible query for PriceCharting.
// Includes set name first (most discriminating), then card name, then number, then JP flag.
function buildPCQuery(card) {
  const name = (card.n || '').replace(/\s*\(JP\)/, '').replace(/\s*#\d+/, '').trim();
  const set = setsData?.[card.sc];
  const setName = set?.name ? set.name.replace(/\s*\(.*?\)/g, '').trim() : '';
  const num = card.cn ? `${card.cn}` : '';
  const langTag = card.lang === 'JP' ? 'japanese' : '';
  // PriceCharting indexes products by full label like:
  //   "Charizard ex #125 - Pokemon Obsidian Flames"
  //   "Charizard ex #066 - Pokemon Japanese Ruler of the Black Flame"
  // Including the set name first dramatically improves match quality.
  return [setName, name, num, langTag].filter(Boolean).join(' ').trim();
}

// Score a PriceCharting product against the card we're looking up.
// Higher = better. Negative = incompatible.
function scorePCProduct(product, card) {
  if (!product) return -100;
  const pName = (product.productName || '').toLowerCase();
  const pCons = (product.consoleName || '').toLowerCase();
  const cName = (card.n || '').toLowerCase().replace(/\s*\(jp\)/, '').trim();
  const setName = (setsData?.[card.sc]?.name || '').toLowerCase();
  const isJP = card.lang === 'JP';
  const consoleIsJP = pCons.includes('japanese');

  let score = 0;

  // Hard language gate — wrong language = disqualify (penalty rather than -Infinity
  // so we still show low-confidence options to the user if nothing better matches)
  if (isJP && !consoleIsJP) score -= 50;
  if (!isJP && consoleIsJP) score -= 50;

  // Set match (most important signal)
  if (setName && pCons.includes(setName)) score += 40;

  // Card name — token overlap rather than substring (handles "Mega Charizard X" vs "Charizard ex")
  const cTokens = cName.split(/\s+/).filter(t => t.length > 1);
  const pTokens = pName.split(/\s+/).filter(t => t.length > 1);
  let nameOverlap = 0;
  for (const t of cTokens) if (pTokens.includes(t)) nameOverlap++;
  // Penalise extra tokens in the product name that aren't in the card name
  // (e.g. "Mega Charizard" when we wanted "Charizard")
  const extraTokens = pTokens.filter(t => !cTokens.includes(t) && !['pokemon', 'card', 'tcg', 'japanese', '#'].includes(t)).length;
  score += nameOverlap * 8;
  // Reject if the product name has extra non-trivial tokens that change the identity
  // (e.g. our card is "Charizard ex" but theirs is "Mega Charizard X ex")
  // Specifically penalise tokens like 'mega' / 'shiny' / 'gold' / 'reverse' if they
  // aren't in our card name.
  const dangerTokens = ['mega', 'shiny', 'gold', 'reverse', 'shadowless', 'first', 'edition', 'holo'];
  for (const dt of dangerTokens) {
    if (pTokens.includes(dt) && !cTokens.includes(dt)) score -= 12;
  }
  score -= Math.min(extraTokens, 4) * 3;

  // Card number match (very strong signal — note PC uses #066 vs raw 66 sometimes)
  if (card.cn) {
    const cardNum = String(card.cn).replace(/^0+/, '');
    const numRe = new RegExp(`#?0*${cardNum}\\b`);
    if (numRe.test(pName)) score += 25;
    else score -= 8;
  }

  return score;
}

// Public CORS proxies rotate in and out of working order constantly. We try a
// chain until one returns valid JSON, then cache the winner in localStorage so
// subsequent calls go straight to it. If a cached proxy starts failing we
// invalidate and re-walk the chain. Users can also paste their own proxy (e.g.
// a Cloudflare Worker) via window.localStorage.pcProxyOverride.
const PC_PROXIES = [
  // {fn}: builds the proxy URL from a target URL. {parse}: extracts the JSON.
  { name: 'codetabs',     fn: u => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`, parse: r => r.json() },
  { name: 'allorigins',   fn: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,        parse: r => r.json() },
  { name: 'corsproxy.io', fn: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,                 parse: r => r.json() },
  { name: 'cors.eu.org',  fn: u => `https://cors.eu.org/${u}`,                                          parse: r => r.json() },
  { name: 'thingproxy',   fn: u => `https://thingproxy.freeboard.io/fetch/${u}`,                         parse: r => r.json() },
];

function pcProxyOverride() {
  // User can paste their own proxy template containing '{URL}' (encoded) or
  // '{RAWURL}' (unencoded). Set via the console:
  //   localStorage.pcProxyOverride = 'https://my-worker.dev/?url={URL}'
  try { return localStorage.getItem('pcProxyOverride') || ''; } catch { return ''; }
}
function cachedPcProxy() {
  try { return localStorage.getItem('pcProxyWinner') || ''; } catch { return ''; }
}
function setCachedPcProxy(name) {
  try { localStorage.setItem('pcProxyWinner', name); } catch {}
}
function clearCachedPcProxy() {
  try { localStorage.removeItem('pcProxyWinner'); } catch {}
}

// Shared proxy-chain walker for PriceCharting requests. Parameterised on the
// response parser + a "is this response usable?" predicate so it can be shared
// by both the JSON search endpoint and the HTML product-page endpoint we hit
// for full-grade prices (ACE 10, CGC 10, BGS 10, TAG 10, SGC 10). Returns
// whatever `parse` returned on the first successful proxy hop.
async function pcFetchViaProxy(pcUrl, opts = {}) {
  const asText = opts.as === 'text';
  const isUsable = opts.isUsable || (data => !!data);

  // Build ordered proxy list — user override first, then last known winner,
  // then the rest of the declared chain. De-duplicated.
  const seen = new Set();
  const chain = [];
  const override = pcProxyOverride();
  if (override) {
    chain.push({
      name: 'override',
      fn: u => override.includes('{RAWURL}')
        ? override.replace('{RAWURL}', u)
        : override.replace('{URL}', encodeURIComponent(u)),
      // Override doesn't know its own response type — respect opts.as.
      parse: r => asText ? r.text() : r.json(),
    });
    seen.add('override');
  }
  const cached = cachedPcProxy();
  if (cached) {
    const p = PC_PROXIES.find(x => x.name === cached);
    if (p && !seen.has(p.name)) { chain.push(p); seen.add(p.name); }
  }
  for (const p of PC_PROXIES) {
    if (!seen.has(p.name)) { chain.push(p); seen.add(p.name); }
  }

  // Per-proxy timeout via AbortController.
  const PROXY_TIMEOUT_MS = 6000;
  const fetchWithTimeout = (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
    return fetch(url, { method: 'GET', signal: ctrl.signal })
      .finally(() => clearTimeout(t));
  };

  const errors = [];
  for (const p of chain) {
    try {
      const r = await fetchWithTimeout(p.fn(pcUrl));
      if (!r.ok) { errors.push(`${p.name} ${r.status}`); continue; }
      // The default parse for JSON proxies is `r.json()`. When we want HTML
      // through those same proxies we override with r.text() — the raw
      // upstream body is what the proxies return either way.
      const data = asText ? await r.text() : await p.parse(r);
      if (isUsable(data)) {
        if (p.name !== cached) setCachedPcProxy(p.name);
        return data;
      }
      errors.push(`${p.name} unusable`);
    } catch (e) {
      errors.push(`${p.name} ${e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'err'}`);
    }
  }
  clearCachedPcProxy();
  const err = new Error('All proxies failed: ' + errors.join('; '));
  err.allProxiesFailed = true;
  throw err;
}

async function pcSearchRaw(query) {
  const pcUrl = `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(query)}&format=json`;

  // Build the ordered list to try — user override first, then cached winner,
  // then the rest in declared order. De-dup.
  const seen = new Set();
  const chain = [];
  const override = pcProxyOverride();
  if (override) {
    chain.push({
      name: 'override',
      fn: u => override.includes('{RAWURL}')
        ? override.replace('{RAWURL}', u)
        : override.replace('{URL}', encodeURIComponent(u)),
      parse: r => r.json(),
    });
    seen.add('override');
  }
  const cached = cachedPcProxy();
  if (cached) {
    const p = PC_PROXIES.find(x => x.name === cached);
    if (p && !seen.has(p.name)) { chain.push(p); seen.add(p.name); }
  }
  for (const p of PC_PROXIES) {
    if (!seen.has(p.name)) { chain.push(p); seen.add(p.name); }
  }

  // Per-proxy timeout via AbortController so a single hanging proxy can't
  // freeze the whole chain. 6s is enough for any healthy proxy to respond.
  const PROXY_TIMEOUT_MS = 6000;
  const fetchWithTimeout = (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
    return fetch(url, { method: 'GET', signal: ctrl.signal })
      .finally(() => clearTimeout(t));
  };

  // Walk the shared proxy chain, expecting JSON with a `products` array.
  try {
    const data = await pcFetchViaProxy(pcUrl, {
      isUsable: d => d && Array.isArray(d.products),
    });
    return data.products;
  } catch (e) {
    throw e;
  }
}

// ---- PriceCharting full-grade fetch (ACE 10, CGC 10, BGS 10, TAG 10, SGC 10)
//
// The public search JSON endpoint only exposes 3 grades (ungraded, PSA 10,
// Grade 9). The individual product page includes a full grade table — we
// fetch it by numeric product ID (PC 302-redirects `/game/{id}` to the
// canonical slug URL) and parse the `#full-prices` table with a regex.
//
// Returns { pcAce10, pcCgc10, pcBgs10, pcTag10, pcSgc10 } in USD (0 when the
// grade has no recorded sales). All fields are always present so callers can
// spread the result safely.
const PC_FULL_GRADE_PARSE_LABELS = {
  'ACE 10':  'pcAce10',
  'ACE 9':   'pcAce9',
  'ACE 8':   'pcAce8',
  'ACE 7':   'pcAce7',
  'CGC 10':  'pcCgc10',
  'BGS 10':  'pcBgs10',
  'TAG 10':  'pcTag10',
  'SGC 10':  'pcSgc10',
  'PSA 7':   'pcPsa7',
  'PSA 8':   'pcPsa8',
  'PSA 9':   'pcPsa9',
};
function _emptyFullGrades() {
  return { pcAce10: 0, pcAce9: 0, pcAce8: 0, pcAce7: 0, pcCgc10: 0, pcBgs10: 0, pcTag10: 0, pcSgc10: 0, pcPsa7: 0, pcPsa8: 0, pcPsa9: 0 };
}
function parsePCFullGrades(html) {
  const out = _emptyFullGrades();
  if (typeof html !== 'string' || html.length === 0) return out;
  // Isolate the `#full-prices` table so we don't accidentally pick up prices
  // from the header or sold-listings sidebar.
  const m = /id="full-prices"([\s\S]*?)<\/table>/.exec(html);
  const section = m ? m[1] : html;
  // Rows look like: <td...>ACE 10</td><td...>$95.82</td>
  // "-" / "N/A" means no recent sale — map to 0.
  const rowRe = /<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*\$?([\d,.]+|-|N\/A)/g;
  let row;
  while ((row = rowRe.exec(section)) !== null) {
    const label = row[1].trim();
    const key = PC_FULL_GRADE_PARSE_LABELS[label];
    if (!key) continue;
    const rawVal = row[2].trim();
    if (rawVal === '-' || rawVal === 'N/A') continue;
    const n = parseFloat(rawVal.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}
async function pcFetchFullGrades(productId) {
  if (!productId) return _emptyFullGrades();
  // `/game/{numericId}` 302-redirects to the canonical slug URL. The proxy
  // chain follows redirects automatically.
  const url = `https://www.pricecharting.com/game/${encodeURIComponent(productId)}`;
  try {
    const html = await pcFetchViaProxy(url, {
      as: 'text',
      // Only accept HTML that actually contains the full-prices table — protects
      // us from proxies that return an error page as 200 OK.
      isUsable: t => typeof t === 'string' && t.indexOf('full-prices') !== -1,
    });
    return parsePCFullGrades(html);
  } catch (e) {
    // Non-fatal: full-grade fetch failing just means we fall back to the raw-based
    // ACE model. Callers still get a valid (all-zero) object.
    console.warn('PriceCharting full-grade fetch failed:', e && e.message || e);
    return _emptyFullGrades();
  }
}

function productToPC(p, fullGrades) {
  if (!p) return null;
  const fg = fullGrades || _emptyFullGrades();
  return {
    pcUngraded: parsePCPrice(p.price1),
    pcPsa10: parsePCPrice(p.price2),
    pcGrade9: parsePCPrice(p.price3),
    // Full-grade table (USD, 0 = missing)
    pcAce10: fg.pcAce10 || 0,
    pcAce9:  fg.pcAce9  || 0,
    pcAce8:  fg.pcAce8  || 0,
    pcAce7:  fg.pcAce7  || 0,
    pcCgc10: fg.pcCgc10 || 0,
    pcBgs10: fg.pcBgs10 || 0,
    pcTag10: fg.pcTag10 || 0,
    pcSgc10: fg.pcSgc10 || 0,
    pcPsa7:  fg.pcPsa7  || 0,
    pcPsa8:  fg.pcPsa8  || 0,
    pcPsa9:  fg.pcPsa9  || 0,
    pcName: p.productName || '',
    pcConsole: p.consoleName || '',
    pcId: p.id || '',
    pcImageUrl: p.imageUri || '',
    pcMatchScore: typeof p._score === 'number' ? p._score : null,
    pcMatchConfidence: typeof p._score === 'number'
      ? (p._score >= 50 ? 'high' : p._score >= 25 ? 'ok' : 'low')
      : null,
  };
}

// Search PriceCharting for candidate products for a card and return them ranked.
// Used by the manual-override modal so the user can pick the right product.
async function searchPCCandidates(card) {
  const q = buildPCQuery(card);
  let products = [];
  try { products = await pcSearchRaw(q); } catch {}
  // Fallback to a looser query if no results — drop the set name.
  if (products.length === 0) {
    const fallback = [card.n, card.cn, card.lang === 'JP' ? 'japanese' : ''].filter(Boolean).join(' ');
    try { products = await pcSearchRaw(fallback); } catch {}
  }
  // Score and sort
  for (const p of products) p._score = scorePCProduct(p, card);
  products.sort((a, b) => b._score - a._score);
  return products;
}

async function fetchPriceChartingData(card) {
  // 1. Manual override wins
  const override = getPCOverride(card.i);
  if (override && override.notAvailable) return null; // user explicitly marked as not on PC
  if (override && override.id) {
    // The override carries the full product blob from when the user picked it.
    // We still re-fetch by ID via search so prices stay fresh.
    try {
      const products = await pcSearchRaw(override.productName || override.id);
      const exact = products.find(p => String(p.id) === String(override.id));
      if (exact) {
        const fg = await pcFetchFullGrades(exact.id);
        return { ...productToPC(exact, fg), pcMatchConfidence: 'override' };
      }
    } catch {}
    // If re-fetch fails, return the cached override blob — still try to grab
    // full grades from the product page (cheap, non-fatal on failure).
    let fgOverride = _emptyFullGrades();
    try { fgOverride = await pcFetchFullGrades(override.id); } catch {}
    return {
      pcUngraded: parsePCPrice(override.price1),
      pcPsa10: parsePCPrice(override.price2),
      pcGrade9: parsePCPrice(override.price3),
      pcAce10: fgOverride.pcAce10 || 0,
      pcAce9:  fgOverride.pcAce9  || 0,
      pcAce8:  fgOverride.pcAce8  || 0,
      pcAce7:  fgOverride.pcAce7  || 0,
      pcCgc10: fgOverride.pcCgc10 || 0,
      pcBgs10: fgOverride.pcBgs10 || 0,
      pcTag10: fgOverride.pcTag10 || 0,
      pcSgc10: fgOverride.pcSgc10 || 0,
      pcPsa7:  fgOverride.pcPsa7  || 0,
      pcPsa8:  fgOverride.pcPsa8  || 0,
      pcPsa9:  fgOverride.pcPsa9  || 0,
      pcName: override.productName || '',
      pcConsole: override.consoleName || '',
      pcId: override.id || '',
      pcImageUrl: override.imageUri || '',
      pcMatchConfidence: 'override',
    };
  }

  // 2. Normal search with the tightened query
  const products = await searchPCCandidates(card);
  if (products.length === 0) return null;
  const best = products[0];
  // Fetch ACE 10 + other grade anchors from the product page.
  // Non-fatal — returns empty grades on any failure so ACE mode can fall back.
  const fg = await pcFetchFullGrades(best.id);
  return productToPC(best, fg);
}

// Fetch live pricing for JP cards — PriceCharting is primary source
async function fetchLivePriceJP(card) {
  // Try PriceCharting first (accurate JP pricing with eBay sales data)
  const pc = await fetchPriceChartingData(card);
  
  const result = {
    source: 'pricecharting',
    market: pc ? pc.pcUngraded : 0,
    low: 0,
    mid: pc ? pc.pcUngraded : 0,
    high: 0,
    directLow: 0,
    tcgUpdated: '',
    tcgUrl: '',
    cmTrend: 0,
    cmAvg1: 0,
    cmAvg7: 0,
    cmAvg30: 0,
    cmLow: 0,
    cmSuggested: 0,
    cmUpdated: '',
    cmUrl: '',
    // PriceCharting specific
    pcUngraded: pc ? pc.pcUngraded : 0,
    pcPsa10: pc ? pc.pcPsa10 : 0,
    pcGrade9: pc ? pc.pcGrade9 : 0,
    pcAce10: pc ? pc.pcAce10 : 0,
    pcAce9:  pc ? pc.pcAce9  : 0,
    pcAce8:  pc ? pc.pcAce8  : 0,
    pcAce7:  pc ? pc.pcAce7  : 0,
    pcPsa7:  pc ? pc.pcPsa7  : 0,
    pcPsa8:  pc ? pc.pcPsa8  : 0,
    pcPsa9:  pc ? pc.pcPsa9  : 0,
    pcName: pc ? pc.pcName : '',
    pcConsole: pc ? pc.pcConsole : '',
    pcId: pc ? pc.pcId : '',
  };

  return result;
}

// Master live price fetcher — PriceCharting is PRIMARY for all cards, TCGPlayer is secondary for EN
// Resolve a Collectrics ID via the live-price flow and trigger market data + price history
function maybeFetchMarketDataFromLive(card, data) {
  const mi = data && data.mi;
  if (!mi) return;
  // Cache mi on the card for subsequent renders
  card.mi = mi;
  // Update collectrics link
  const link = document.getElementById('linkCollectrics');
  if (link) link.href = `https://mycollectrics.com/card.html?id=${mi}`;
  // Show price history loading state
  const phSec = document.getElementById('priceHistSection');
  if (phSec) {
    phSec.style.display = 'block';
    document.getElementById('phLoading').style.display = 'block';
    document.getElementById('phLoading').textContent = 'Loading price history…';
    document.getElementById('phContent').style.display = 'none';
  }
  fetchMarketData(mi);
}

async function fetchLivePrice(card) {
  const thisId = ++livePriceFetchId;
  livePrice = null;

  // Show loading state in live pricing panel
  const panel = $('livePricePanel');
  const loading = $('livePriceLoading');
  const content = $('livePriceContent');
  const status = $('livePriceStatus');

  panel.style.display = 'block';
  loading.style.display = 'flex';
  content.style.display = 'none';

  // Check cache first
  const cached = getCachedPrice(card.i);
  if (cached) {
    if (thisId !== livePriceFetchId) return;
    livePrice = cached;
    renderLivePrice(cached);
    recalcWithLivePrice(card);
    maybeFetchMarketDataFromLive(card, cached);
    return;
  }

  // No cache — fetch fresh (PriceCharting first, then TCGPlayer fallback for EN)
  try {
    const priceData = await fetchFreshPriceData(card);
    if (thisId !== livePriceFetchId) return; // stale
    livePrice = priceData;
    setCachedPrice(card.i, priceData);
    renderLivePrice(priceData);
    recalcWithLivePrice(card);
    maybeFetchMarketDataFromLive(card, priceData);
  } catch (e) {
    if (thisId !== livePriceFetchId) return;
    console.warn('Live price fetch failed:', e);
    loading.style.display = 'none';
    content.style.display = 'none';
    status.textContent = 'Live pricing unavailable — using static data';
    status.style.display = 'block';
  }
}

// Unified fetch: PriceCharting primary, TCGPlayer secondary for EN cards
async function fetchFreshPriceData(card, { skipCollectrics = false } = {}) {
  let priceData = {
    source: 'pricecharting',
    market: 0, low: 0, mid: 0, high: 0, directLow: 0,
    tcgMarket: 0, tcgLow: 0, tcgMid: 0, tcgHigh: 0,
    tcgUpdated: '', tcgUrl: '',
    cmTrend: 0, cmAvg1: 0, cmAvg7: 0, cmAvg30: 0, cmLow: 0, cmSuggested: 0,
    cmUpdated: '', cmUrl: '', cmLang: card.lang || 'EN',
    pcUngraded: 0, pcPsa10: 0, pcGrade9: 0, pcName: '', pcConsole: '', pcId: '',
    pcAce10: 0, pcCgc10: 0, pcBgs10: 0, pcTag10: 0, pcSgc10: 0,
    crRaw: 0, crPsa10: 0, crGemRate: 0, crName: '', crUrl: '', crPsa10VsRaw: 0,
  };

  // 1+2: PriceCharting and TCGPlayer/Cardmarket fire simultaneously — they're
  // independent sources so there's no reason to wait for PC before starting TCG.
  const isJP = card.lang === 'JP';
  const [pcSettled, enSettled] = await Promise.allSettled([
    fetchPriceChartingData(card),
    isJP ? Promise.resolve(null) : fetchLivePriceEN(card.i),
  ]);

  // 1. Apply PriceCharting result
  if (pcSettled.status === 'fulfilled') {
    const pc = pcSettled.value;
    if (pc && pc.pcUngraded > 0) {
      Object.assign(priceData, pc);
      priceData.source = 'pricecharting';
      priceData.market = pc.pcUngraded;
      priceData.mid = pc.pcUngraded;
    }
  } else {
    console.warn('PriceCharting fetch failed:', pcSettled.reason);
  }

  // 2. Apply TCGPlayer/Cardmarket result (EN only)
  if (!isJP) {
    if (enSettled.status === 'fulfilled') {
      const enData = enSettled.value;
      if (enData) {
        priceData.tcgUpdated = enData.tcgUpdated;
        priceData.tcgUrl = enData.tcgUrl;
        priceData.cmTrend = enData.cmTrend;
        priceData.cmAvg1 = enData.cmAvg1;
        priceData.cmAvg7 = enData.cmAvg7;
        priceData.cmAvg30 = enData.cmAvg30;
        priceData.cmLow = enData.cmLow;
        priceData.cmSuggested = enData.cmSuggested;
        priceData.cmUpdated = enData.cmUpdated;
        priceData.cmUrl = enData.cmUrl;
        priceData.tcgMarket = enData.market;
        priceData.tcgLow = enData.low;
        priceData.tcgMid = enData.mid;
        priceData.tcgHigh = enData.high;
        priceData.directLow = enData.directLow;
        if (priceData.pcUngraded > 0 && enData.market > 0) {
          priceData.market = (priceData.pcUngraded + enData.market) / 2;
          priceData.priceIsComposite = true;
        } else if (priceData.pcUngraded <= 0 && enData.market > 0) {
          priceData.source = 'pokemontcg.io';
          priceData.market = enData.market;
          priceData.low = enData.low;
          priceData.mid = enData.mid;
          priceData.high = enData.high;
        }
      }
    } else {
      console.warn('TCGPlayer secondary fetch failed:', enSettled.reason);
      if (priceData.pcUngraded <= 0 && !getTcgOverride(card.i)) throw enSettled.reason;
    }
  }

  // 2b. URL-based TCGPlayer lookup — runs for ALL cards when tcgMarket is still empty
  //     and the user has saved a TCGPlayer product URL. Queries pokemontcg.io by
  //     product ID, which works for EN cards the card-ID lookup missed, and for JP
  //     cards that are sold on TCGPlayer under a separate listing.
  if (priceData.tcgMarket <= 0) {
    const _savedTcgUrl = getTcgOverride(card.i);
    const _productId   = extractTcgProductId(_savedTcgUrl);
    if (_productId) {
      try {
        const _tcgData = await fetchTCGPlayerPriceByProductId(_productId, card);
        if (_tcgData && _tcgData.market > 0) {
          priceData.tcgMarket   = _tcgData.market;
          priceData.tcgLow      = _tcgData.low;
          priceData.tcgMid      = _tcgData.mid;
          priceData.tcgHigh     = _tcgData.high;
          priceData.directLow   = _tcgData.directLow;
          if (_tcgData.tcgUpdated) priceData.tcgUpdated = _tcgData.tcgUpdated;
          if (!priceData.tcgUrl) priceData.tcgUrl = _savedTcgUrl;
          if (priceData.pcUngraded > 0) {
            priceData.market = (priceData.pcUngraded + _tcgData.market) / 2;
            priceData.priceIsComposite = true;
          } else if (priceData.market <= 0) {
            priceData.market = _tcgData.market;
          }
        }
      } catch { /* silent — URL-based lookup is best-effort */ }
    }
  }

  // 3. Collectrics — additional grading data source (skipped in bulk refresh paths)
  if (!skipCollectrics) {
    try {
      const cr = await fetchCollectricsSearchData(card);
      if (cr) Object.assign(priceData, cr);
    } catch (e) {
      // Silent — Collectrics is supplementary
    }
  }

  // 4. Manual TCGPlayer market price override — fills gap when no live data at all
  const _manualTcgUSD = getTcgPriceOverride(card.i);
  if (_manualTcgUSD > 0 && priceData.tcgMarket <= 0) {
    priceData.tcgMarket = _manualTcgUSD;
    priceData.tcgPriceIsManual = true;
    if (priceData.pcUngraded > 0) {
      priceData.market = (priceData.pcUngraded + _manualTcgUSD) / 2;
      priceData.priceIsComposite = true;
    } else if (priceData.market <= 0) {
      priceData.market = _manualTcgUSD;
    }
  }

  // 5. JP card with no data from any source — give up
  if (card.lang === 'JP' && priceData.pcUngraded <= 0 && priceData.tcgMarket <= 0) {
    throw new Error('No pricing data available');
  }

  return priceData;
}

// Fetch Collectrics data via search API
async function fetchCollectricsSearchData(card) {
  const proxyBase = 'https://api.codetabs.com/v1/proxy/?quest=';
  const searchName = card.n.replace(/ \(JP\)$/i, '').trim();
  const q = card.cn ? `${searchName} #${card.cn}` : searchName;
  const apiUrl = `https://mycollectrics.com/api/search/cards?sort=raw_desc&limit=5&offset=0&q=${encodeURIComponent(q)}`;
  const proxyUrl = proxyBase + encodeURIComponent(apiUrl);

  const r = await fetch(proxyUrl);
  if (!r.ok) return null;
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch(e) { return null; }
  if (!d.results || d.results.length === 0) return null;

  // Match: find result that best matches our card
  const nameLower = searchName.toLowerCase().split(' ')[0];
  const match = d.results.find(res => {
    return res['product-name']?.toLowerCase().includes(nameLower);
  }) || d.results[0];
  if (!match) return null;

  const rawPrice = match['raw-price'] || match['collectrics-raw-price'] || 0;
  const psa10Price = match['psa-10-price'] || 0;
  const gemPct = match['psa-gem-pct'] || 0;
  const psa10VsRaw = match['psa-10-vs-raw-pct'] || 0;
  const cardId = match['id'] || '';

  return {
    crRaw: rawPrice,
    crPsa10: psa10Price,
    crGemRate: gemPct,
    crPsa10VsRaw: psa10VsRaw,
    crName: match['product-name'] || '',
    crUrl: cardId ? `https://mycollectrics.com/card.html?id=${cardId}` : '',
    mi: cardId || '',
  };
}

// Background refresh even when cache hit
async function fetchAndCacheFresh(card, originalId) {
  try {
    const priceData = await fetchFreshPriceData(card);
    // If the fresh fetch lost the TCGPlayer price (worker temporarily unreachable)
    // but the existing cache entry still has one, preserve it so the row doesn't vanish.
    if (priceData.tcgMarket <= 0) {
      const existing = getLastKnownPrice(card.i);
      if (existing && existing.tcgMarket > 0) {
        priceData.tcgMarket = existing.tcgMarket;
        priceData.tcgLow    = existing.tcgLow    || 0;
        priceData.tcgMid    = existing.tcgMid    || 0;
        priceData.tcgHigh   = existing.tcgHigh   || 0;
        priceData.tcgUrl    = priceData.tcgUrl   || existing.tcgUrl;
        priceData.tcgUpdated = priceData.tcgUpdated || existing.tcgUpdated;
      }
    }
    setCachedPrice(card.i, priceData);
    // If still on same card, update
    if (originalId === livePriceFetchId && selectedCard && selectedCard.i === card.i) {
      livePrice = priceData;
      renderLivePrice(priceData);
      recalcWithLivePrice(card);
    }
  } catch (e) {
    // Silent — cached data is still shown
  }
}

// Render live pricing panel
function renderLivePrice(data) {
  _lastLiveData = data;
  const loading = $('livePriceLoading');
  const content = $('livePriceContent');
  const status = $('livePriceStatus');

  loading.style.display = 'none';
  status.style.display = 'none';
  content.style.display = 'block';

  const hasMarket = data.market > 0;
  const hasCM = data.cmTrend > 0 || data.cmAvg7 > 0;
  const hasPC = data.pcUngraded > 0;

  // Primary live price — midpoint when both PC and TCGPlayer have prices
  const _pcTcgMid = (data.pcUngraded > 0 && data.tcgMarket > 0)
    ? (data.pcUngraded + data.tcgMarket) / 2
    : 0;
  const isComposite = _pcTcgMid > 0;
  const primaryPrice = isComposite
    ? _pcTcgMid
    : (data.pcUngraded > 0)
      ? data.pcUngraded
      : (data.market || data.mid || data.cmTrend || data.cmAvg7 || 0);
  $('liveMainPrice').textContent = primaryPrice > 0 ? fmtGBP(primaryPrice) : '—';
  $('liveMainUSD').textContent = primaryPrice > 0
    ? fmtUSD(primaryPrice) + (isComposite ? ' · PC & TCG avg' : '')
    : '';

  // Comparison to static price
  if (selectedCard && selectedCard.p > 0 && primaryPrice > 0) {
    const diff = primaryPrice - selectedCard.p;
    const pct = ((diff / selectedCard.p) * 100).toFixed(1);
    const el = $('livePriceDelta');
    if (Math.abs(diff) > selectedCard.p * 0.01) {
      el.textContent = `${diff > 0 ? '+' : ''}${pct}% vs build-time`;
      el.className = `live-price-delta ${diff > 0 ? 'delta-up' : 'delta-down'}`;
      el.style.display = 'inline-block';
    } else {
      el.style.display = 'none';
    }
  } else {
    $('livePriceDelta').style.display = 'none';
  }

  // TCGPlayer row — shown as secondary source when we have TCGPlayer data
  const tcgRow = $('tcgPlayerRow');
  const hasTcg = (data.tcgMarket > 0) || (data.source === 'pokemontcg.io' && data.market > 0);
  if (hasTcg) {
    tcgRow.style.display = '';
    const tm = data.tcgMarket || data.market || 0;
    const tl = data.tcgLow || data.low || 0;
    const tmd = data.tcgMid || data.mid || 0;
    const th = data.tcgHigh || data.high || 0;
    $('tcgMarket').textContent = tm > 0 ? fmtGBP(tm) : '—';
    $('tcgLow').textContent = (!data.tcgPriceIsManual && tl > 0) ? fmtGBP(tl) : '—';
    $('tcgMid').textContent = (!data.tcgPriceIsManual && tmd > 0) ? fmtGBP(tmd) : '—';
    $('tcgHigh').textContent = (!data.tcgPriceIsManual && th > 0) ? fmtGBP(th) : '—';
    const updatedEl = $('tcgUpdated');
    if (data.tcgPriceIsManual) {
      updatedEl.textContent = 'manual override';
    } else if (data.tcgUpdated) {
      const d = new Date(data.tcgUpdated);
      updatedEl.textContent = `Updated ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    } else {
      updatedEl.textContent = '';
    }
    // TCGPlayer link
    const tcgLink = $('tcgPlayerLink');
    const tcgOverrideUrl = selectedCard ? getTcgOverride(selectedCard.i) : null;
    const tcgFinalUrl = tcgOverrideUrl || data.tcgUrl;
    if (tcgFinalUrl) {
      tcgLink.href = tcgFinalUrl;
      tcgLink.style.display = '';
    } else {
      tcgLink.style.display = 'none';
    }
  } else {
    tcgRow.style.display = 'none';
  }

  // Cardmarket row
  const cmRow = $('cardmarketRow');
  if (hasCM) {
    cmRow.style.display = '';
    $('cmTrend').textContent = data.cmTrend > 0 ? fmtGBP(data.cmTrend) : '—';
    $('cmAvg7').textContent = data.cmAvg7 > 0 ? fmtGBP(data.cmAvg7) : '—';
    $('cmAvg30').textContent = data.cmAvg30 > 0 ? fmtGBP(data.cmAvg30) : '—';
    $('cmLow').textContent = data.cmLow > 0 ? fmtGBP(data.cmLow) : '—';
    const updatedEl = $('cmUpdated');
    if (data.cmUpdated) {
      const d = new Date(data.cmUpdated);
      updatedEl.textContent = `Updated ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    } else {
      updatedEl.textContent = '';
    }
    const cmLink = $('cardmarketLink');
    if (data.cmUrl) {
      // Append language filter — 1 = English, 10 = Japanese
      const langId = data.cmLang === 'JP' ? 10 : 1;
      const sep = data.cmUrl.includes('?') ? '&' : '?';
      cmLink.href = data.cmUrl + sep + 'language=' + langId;
      cmLink.style.display = '';
    } else {
      cmLink.style.display = 'none';
    }
    // Language tag
    const cmLangTag = $('cmLangTag');
    if (cmLangTag) cmLangTag.textContent = data.cmLang === 'JP' ? 'JP' : 'EN';
  } else {
    cmRow.style.display = 'none';
  }

  // PriceCharting row
  const pcRow = $('priceChartingRow');
  if (hasPC) {
    pcRow.style.display = '';
    $('pcUngraded').textContent = fmtGBP(data.pcUngraded);
    $('pcPsa10').textContent = data.pcPsa10 > 0 ? fmtGBP(data.pcPsa10) : '—';
    $('pcGrade9').textContent = data.pcGrade9 > 0 ? fmtGBP(data.pcGrade9) : '—';
    $('pcAce10').textContent = data.pcAce10 > 0 ? fmtGBP(data.pcAce10) : '—';
    $('pcAce9').textContent  = data.pcAce9  > 0 ? fmtGBP(data.pcAce9)  : '—';
    // Grading ROI: (PSA10 price - Ungraded - ~£20 grading cost) / Ungraded
    if (data.pcPsa10 > 0 && data.pcUngraded > 0) {
      const gradingCostUSD = 25; // ~£20 grading cost in USD
      const roi = ((data.pcPsa10 - data.pcUngraded - gradingCostUSD) / data.pcUngraded * 100).toFixed(0);
      const roiEl = $('pcGradingRoi');
      roiEl.textContent = `${roi > 0 ? '+' : ''}${roi}%`;
      roiEl.className = `lp-val pc-grading-roi ${roi > 50 ? 'roi-good' : roi > 0 ? 'roi-ok' : 'roi-bad'}`;
    } else {
      $('pcGradingRoi').textContent = '—';
      $('pcGradingRoi').className = 'lp-val pc-grading-roi';
    }
    // Match name shown as subtitle
    const matchEl = $('pcMatchName');
    if (data.pcName) {
      matchEl.textContent = data.pcName;
      matchEl.style.display = '';
    } else {
      matchEl.style.display = 'none';
    }
    // Confidence badge — helps the user notice when the auto-match might be wrong
    const confEl = $('pcMatchConfidence');
    if (confEl) {
      const c = data.pcMatchConfidence;
      confEl.className = 'pc-match-confidence';
      if (c === 'override') {
        confEl.textContent = 'Manual match';
        confEl.classList.add('conf-override');
      } else if (c === 'high') {
        confEl.textContent = 'High confidence';
        confEl.classList.add('conf-high');
      } else if (c === 'ok') {
        confEl.textContent = 'OK match — verify';
        confEl.classList.add('conf-ok');
      } else if (c === 'low') {
        confEl.textContent = 'Low confidence — likely wrong';
        confEl.classList.add('conf-low');
      } else {
        confEl.textContent = '';
      }
    }
    // Always show the override button so the user can correct any match
    const ovBtn = $('pcOverrideBtn');
    if (ovBtn) ovBtn.style.display = selectedCard ? '' : 'none';
    // Link to PriceCharting product page — use the actual console slug returned by PC
    const pcLink = $('priceChartingLink');
    if (data.pcId) {
      const consoleSlug = (data.pcConsole || 'cards').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      pcLink.href = `https://www.pricecharting.com/game/${consoleSlug}/${data.pcId}`;
      pcLink.style.display = '';
    } else {
      pcLink.style.display = 'none';
    }
  } else {
    pcRow.style.display = 'none';
  }

  // Collectrics row
  const crRow = $('collectricsRow');
  const hasCR = data.crRaw > 0 || data.crPsa10 > 0;
  if (hasCR) {
    crRow.style.display = '';
    $('crRaw').textContent = data.crRaw > 0 ? fmtGBP(data.crRaw) : '—';
    $('crPsa10').textContent = data.crPsa10 > 0 ? fmtGBP(data.crPsa10) : '—';
    $('crGemRate').textContent = data.crGemRate > 0 ? data.crGemRate.toFixed(1) + '%' : '—';
    // Grading ROI from Collectrics data
    if (data.crPsa10 > 0 && data.crRaw > 0) {
      const gradingCostUSD = 25;
      const crROI = ((data.crPsa10 - data.crRaw - gradingCostUSD) / data.crRaw * 100).toFixed(0);
      const crROIel = $('crGradingRoi');
      crROIel.textContent = `${crROI > 0 ? '+' : ''}${crROI}%`;
      crROIel.className = `lp-val collectrics-grading-roi ${crROI > 50 ? 'roi-good' : crROI > 0 ? 'roi-ok' : 'roi-bad'}`;
    } else {
      $('crGradingRoi').textContent = '—';
      $('crGradingRoi').className = 'lp-val collectrics-grading-roi';
    }
    // Match name
    const crMatchEl = $('collectricsMatchName');
    if (data.crName) {
      crMatchEl.textContent = data.crName;
      crMatchEl.style.display = '';
    } else {
      crMatchEl.style.display = 'none';
    }
    // Link
    const crLink = $('collectricsLink');
    if (data.crUrl) {
      crLink.href = data.crUrl;
      crLink.style.display = '';
    } else {
      crLink.style.display = 'none';
    }
  } else {
    crRow.style.display = 'none';
  }

  // Cache timestamp — show "as of [date] [time]" so the user knows exactly
  // when this price was fetched (7AM auto-refresh vs manual refresh).
  const cacheTs = $('livePriceCache');
  if (data._ts) {
    const d   = new Date(data._ts);
    const now = new Date();
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const sameDay = d.toDateString() === now.toDateString();
    const prevDay = new Date(now - 86400000).toDateString() === d.toDateString();
    const dateLabel = sameDay  ? 'today'
                    : prevDay  ? 'yesterday'
                    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    cacheTs.textContent = `as of ${dateLabel} ${timeStr}`;
    cacheTs.style.display = '';
  } else {
    cacheTs.textContent = 'as of just now';
    cacheTs.style.display = '';
  }
}

// Recalculate model with live price
function recalcWithLivePrice(card) {
  if (!card || !livePrice) return;
  // Pick best live price — midpoint when both PC and TCGPlayer have prices
  const lp = (livePrice.pcUngraded > 0 && livePrice.tcgMarket > 0)
    ? (livePrice.pcUngraded + livePrice.tcgMarket) / 2
    : (livePrice.pcUngraded > 0)
      ? livePrice.pcUngraded
      : (livePrice.market || livePrice.mid || livePrice.cmTrend || 0);
  if (lp <= 0) return;

  // Update displayed market prices to live
  $('marketRawUSD').textContent = fmtUSD(lp);
  $('marketRawGBP').textContent = fmtGBP(lp);

  // Update PSA 10 from PriceCharting if available and static data is missing
  if (livePrice.pcPsa10 > 0 && (!card.p10 || card.p10 <= 0)) {
    $('psa10USD').textContent = fmtUSD(livePrice.pcPsa10);
    $('psa10GBP').textContent = fmtGBP(livePrice.pcPsa10);
  }

  // Re-calculate pull cost
  let pullCost = 7.65;
  if (setsData && setsData[card.sc]) {
    const set = setsData[card.sc];
    const rarity = set.rarities?.[card.rc];
    if (rarity && rarity.pullRate > 0) {
      const packsPerHit = Math.round(1 / rarity.pullRate);
      const totalPacks = packsPerHit * rarity.count;
      pullCost = totalPacks / 100;
    }
  }

  // Re-calibrate desirability from live price
  const des = autoFillDesirability(card, pullCost);
  $('characterPremium').value = des.char;
  $('artworkHype').value = des.art;
  $('universalAppeal').value = des.appeal;

  // Update all calculations
  updateAll();

  // Re-render grading ROI with PriceCharting PSA 10 data
  if (livePrice.pcPsa10 > 0) {
    renderGradingROI(null);
    // If the marketplace section was hidden (no anchor when card was first selected),
    // now that we have a live PSA 10 price from PriceCharting, re-trigger the scan.
    const _mktSec = $('marketplaceSection');
    if (_mktSec && _mktSec.style.display === 'none') {
      const { pullCost: _pc } = calcPullCost();
      renderMarketplaceScan(card, _pc, calcDesirability());
    }
  }

  // Refresh EN ↔ JP recommendation with live price data
  renderCounterpartFlag(card);

  // Re-render Acquisition + Grader sections so ROI uses the live raw + PSA 10 prices
  if (typeof renderAcquisition === 'function') renderAcquisition();
  if (typeof renderCardGrader === 'function') renderCardGrader();
  // Re-render ACE section so PC grade prices populate now that livePrice is set
  if (typeof renderAceGradingSection === 'function') renderAceGradingSection();
  // Re-render Hold Strategy so it uses the live raw price instead of the
  // static / cached price it had at initial card-select time.
  if (typeof renderHoldStrategy === 'function') {
    try { renderHoldStrategy(card); } catch {}
  }
  // Redraw portfolio growth chart so the current card's live price is reflected
  try { drawPortfolioGrowthChart(); } catch {}
}

// ================================================================
// ---- Card Selection ----
// ================================================================
// Synthesise a minimal card object from portfolio/wishlist/watchlist data when
// a card ID is no longer in the static DB (e.g. tcgc-* or usr-* entries that
// haven't been re-injected from pkm-user-cards-v1 yet after a sync).
function _synthCardFromCollections(id) {
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const keys = ['pkm-portfolio', 'pkm-wishlist'];
  for (const key of keys) {
    try {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      const item = list.find(x => (x.id || x.i) === id);
      if (!item) continue;
      return {
        i: id,
        n: item.name || id,
        s: item.set || '',
        sc: '',
        rc: '',
        cn: '',
        r: '',
        p: item.addedPriceGBP > 0 ? item.addedPriceGBP / fx : (item.price || 0),
        p10: 0,
        img: item.img || '',
        lang: id.includes('-jp-') ? 'JP' : 'EN',
        _userAdded: true,
        _fromPortfolioFallback: true,
      };
    } catch {}
  }
  return null;
}

function selectCard(id) {
  if (!cardData) return;
  const card = getCardById(id) || _synthCardFromCollections(id);
  if (!card) return;
  selectedCard = card;
  _holdWinnerKey = null;  // reset until renderHoldStrategy runs for this card
  _holdWinnerDesc = '';

  // Refresh Price Sync stats so "Refresh selected card" button enables
  if (typeof psUpdateStats === 'function') psUpdateStats();
  // Refresh Acquisition + Grader section for the new card
  if (typeof renderAcquisition === 'function') renderAcquisition();
  if (typeof renderCardGrader === 'function') renderCardGrader();

  // Reset stale data immediately
  marketData = null;
  marketFetchId++;
  livePrice = null;
  livePriceFetchId++;

  $('searchResults').classList.remove('open');
  $('searchInput').value = card.n;

  const section = $('selectedCardSection');
  section.style.display = 'block';
  const isJP = card.lang === 'JP';

  // Card images — click to open the full-resolution lightbox
  if (isJP) {
    const jpImg = $('cardImageJp');
    jpImg.onerror = function() { _onImgError(this); };
    jpImg.src = getCardImg(card);
    jpImg.style.display = 'block';
    jpImg.title = 'Click to view full resolution';
    jpImg.style.cursor = 'zoom-in';
    jpImg.onclick = () => openImageLightbox(getCardImg(card), card.n + ' (Japanese)');
    $('cardImage').style.display = 'none';
  } else {
    const enImg = $('cardImage');
    enImg.onerror = function() { _onImgError(this); };
    enImg.src = getCardImg(card);
    enImg.style.display = 'block';
    enImg.title = 'Click to view full resolution';
    enImg.style.cursor = 'zoom-in';
    enImg.onclick = () => openImageLightbox(getCardImg(card), card.n);
    $('cardImageJp').style.display = 'none';
  }
  const _heroBg = $('cardHeroBg');
  if (_heroBg) _heroBg.src = getCardImg(card);

  // Update page title and URL so each card has a bookmarkable address
  document.title = `${card.n}${card.s ? ' · ' + card.s : ''} — Pokémon Price Predictor`;
  try { history.replaceState({ cardId: id }, '', '#' + id); } catch(e) {}

  // Card name
  $('cardName').textContent = card.n;
  const jpSub = $('cardNameJp');
  if (jpSub) {
    if (isJP && card.nj) {
      jpSub.textContent = card.nj;
      jpSub.style.display = 'block';
    } else {
      jpSub.style.display = 'none';
    }
  }
  $('cardSet').textContent = card.s;
  $('cardNumber').textContent = card.cn && card.ct ? `#${card.cn}/${card.ct}` : card.cn ? `#${card.cn}` : '';
  $('cardNumber').style.display = card.cn ? '' : 'none';
  $('cardRarity').textContent = card.r || 'Unknown';
  if (card.sr) {
    $('cardSeries').textContent = card.sr;
    $('cardSeries').style.display = '';
  } else {
    $('cardSeries').style.display = 'none';
  }

  // Links
  if (card.mi) {
    $('linkCollectrics').href = `https://mycollectrics.com/card.html?id=${card.mi}`;
  } else {
    $('linkCollectrics').href = `https://mycollectrics.com/search.html?q=${encodeURIComponent(card.n)}`;
  }
  $('linkCollectrics').style.display = '';

  const tcgName = card.n.replace(/#\d+/, '').replace(/\s+/g, ' ').trim();
  const tcgParams = new URLSearchParams({ cardName: tcgName });
  if (card.cn) tcgParams.set('displayNumber', String(card.cn));
  $('linkTcgCollector').href = `https://www.tcgcollector.com/cards/intl?${tcgParams.toString()}`;
  const jpParams = new URLSearchParams({ cardName: tcgName });
  if (card.cn) jpParams.set('displayNumber', String(card.cn));
  $('linkTcgJp').href = `https://www.tcgcollector.com/cards/jp?${jpParams.toString()}`;
  const pcQuery = card.cn ? `${card.n} ${card.cn}` : card.n;
  $('linkPriceCharting').href = `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(pcQuery)}`;

  // Reset enrich UI for each new card selection
  const enrichStatus = $('linkEnrichStatus');
  const manualWrap = $('linkTcgManualWrap');
  const manualInput = $('linkTcgManualInput');
  if (enrichStatus) { enrichStatus.style.display = 'none'; enrichStatus.textContent = ''; }
  // Pre-fill TCGPlayer URL input with the saved URL so the user can see it's stored
  if (manualInput) manualInput.value = (card ? getTcgOverride(card.i) : null) || '';
  // Pre-fill manual TCGPlayer price input with any existing override
  const _tcgPriceInput = $('linkTcgPriceInput');
  if (_tcgPriceInput) {
    const _existingPrice = card ? getTcgPriceOverride(card.i) : 0;
    _tcgPriceInput.value = _existingPrice > 0 ? _existingPrice : '';
  }

  // Static prices (will be overwritten by live)
  $('marketRawUSD').textContent = fmtUSD(card.p);
  $('marketRawGBP').textContent = fmtGBP(card.p);
  $('psa10USD').textContent = card.p10 > 0 ? fmtUSD(card.p10) : '—';
  $('psa10GBP').textContent = card.p10 > 0 ? fmtGBP(card.p10) : '—';
  $('gemPct').textContent = card.g ? `${(card.g * 100).toFixed(1)}%` : '—';

  // Auto-fill pull cost from set data
  let pullCost = 7.65;
  let pullCostFound = false;
  if (setsData && setsData[card.sc]) {
    const set = setsData[card.sc];
    const rarity = set.rarities?.[card.rc];
    if (rarity && rarity.pullRate > 0) {
      const packsPerHit = Math.round(1 / rarity.pullRate);
      $('packRate').value = packsPerHit;
      $('cardsInTier').value = rarity.count;
      const totalPacks = packsPerHit * rarity.count;
      pullCost = totalPacks / 100;
      $('autoPullCost').textContent = pullCost.toFixed(2);
      $('autoPullPacks').textContent = `≈ ${totalPacks.toLocaleString()} packs`;
      pullCostFound = true;
    }
  }
  if (!pullCostFound) {
    // Reset to rarity-based fallback so stale values from a previous card don't distort the model price.
    const fallbackPacks = FALLBACK_PACKS_PER_HIT[card.rc] || 30;
    const fallbackTier  = FALLBACK_TIER_SIZE[card.rc] || 10;
    $('packRate').value     = fallbackPacks;
    $('cardsInTier').value  = fallbackTier;
    pullCost = (fallbackPacks * fallbackTier) / 100;
    $('autoPullCost').textContent = '—';
    $('autoPullPacks').textContent = `Estimated (no pull data — using ${fallbackPacks}× ${fallbackTier} fallback)`;
  }

  // Auto-fill desirability from static price initially
  const des = autoFillDesirability(card, pullCost);
  $('characterPremium').value = des.char;
  $('artworkHype').value = des.art;
  $('universalAppeal').value = des.appeal;

  updateAll();

  $('forecastSection').style.display = 'block';
  renderForecast(card, pullCost, des.total);
  renderStarRating(card, des);
  updateRipOrBuy(card, pullCost);
  updateSignal(card, pullCost, des.total);
  updatePortfolioButton();
  updateWishlistButton();
  updateFullArtBinderButton();
  updateCompareButton();
  renderCounterpartFlag(card);
  renderPsaGradeRange(card, pullCost, des.total);
  renderAceGradingSection();
  updateWatchButton();
  renderMarketplaceScan(card, pullCost, des.total);
  renderHoldStrategy(card);

  // Reset market dynamics section
  $('marketSection').style.display = 'none';
  $('marketContent').style.display = 'none';
  $('marketLoading').style.display = 'block';
  $('marketLoading').textContent = 'Loading market data...';
  $('marketTrend').textContent = '';
  $('marketTrend').className = 'market-trend-badge';
  $('gradeSection').style.display = 'none';
  // PSA range section is recomputed in renderPsaGradeRange()
  // aceGradeSection visibility is managed by renderAceGradingSection() above

  // Reset price history section
  if (card.mi) {
    $('priceHistSection').style.display = 'block';
    $('phLoading').style.display = 'block';
    $('phLoading').textContent = 'Loading price history…';
    $('phContent').style.display = 'none';
    $('phVerdict').textContent = '';
    $('phVerdict').className = 'ph-verdict';
  } else {
    $('priceHistSection').style.display = 'none';
  }

  // Reset live price panel
  $('livePricePanel').style.display = 'none';
  $('livePriceStatus').style.display = 'none';

  // Fetch LIVE pricing (this is the new v8 feature)
  fetchLivePrice(card);

  // Fetch market dynamics from collectrics API (EN cards with mycollectrics ID)
  if (card.mi) {
    fetchMarketData(card.mi);
  }

  // Show snapshot button and predict tab bar; apply current tab state
  const _snapBtn = document.getElementById('predictSnapshotBtn');
  if (_snapBtn) _snapBtn.style.display = '';
  const _ptb = document.getElementById('predictTabBar');
  if (_ptb) {
    _ptb.style.display = '';
    if (typeof _predictTabActivate === 'function') _predictTabActivate();
  }

  if (window.innerWidth < 820) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Japanese Card Image ----
// Used when the selected card is EN — we surface the JP counterpart image too
// in the side-by-side view. Click opens the full-resolution lightbox.
function loadJapaneseImage(card) {
  const jpImg = $('cardImageJp');
  jpImg.src = getCardImg(card);
  jpImg.style.display = 'block';
  jpImg.title = 'Click to view full resolution';
  jpImg.style.cursor = 'zoom-in';
  jpImg.onclick = () => openImageLightbox(getCardImg(card), card.n + ' (Japanese)');
}

// ---- Image Lightbox (full-resolution viewer) ----
function openImageLightbox(src, caption) {
  if (!src) return;
  const overlay = $('imgLightboxOverlay');
  const lb = $('imgLightbox');
  const img = $('imgLightboxImg');
  const cap = $('imgLightboxCaption');
  if (!overlay || !lb || !img) return;
  // Upgrade pokemontcg.io thumbnails to hi-res by swapping the path:
  // /sv3/125.png → /sv3/125_hires.png. Other CDNs serve a single full-res asset.
  let hires = src;
  try {
    if (/images\.pokemontcg\.io\/[^\/]+\/[^\/]+\.png(\?|$)/.test(src) && !/_hires/.test(src)) {
      hires = src.replace(/\.png(\?|$)/, '_hires.png$1');
    }
  } catch {}
  img.src = hires;
  img.alt = caption || '';
  // If the hi-res variant 404s, fall back to the original src once.
  img.onerror = () => {
    if (img.src !== src) img.src = src;
    img.onerror = null;
  };
  if (cap) cap.textContent = caption || '';
  overlay.style.display = 'block';
  overlay.setAttribute('aria-hidden', 'false');
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeImageLightbox() {
  const overlay = $('imgLightboxOverlay');
  const lb = $('imgLightbox');
  const img = $('imgLightboxImg');
  if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
  if (lb) lb.style.display = 'none';
  if (img) img.src = '';
  document.body.style.overflow = '';
}

function setupImageLightbox() {
  $('imgLightboxClose')?.addEventListener('click', closeImageLightbox);
  $('imgLightboxOverlay')?.addEventListener('click', closeImageLightbox);
  $('imgLightbox')?.addEventListener('click', (e) => {
    // Click on the backdrop (anywhere outside the <img> and <button>) closes
    if (e.target.id === 'imgLightbox' || e.target.id === 'imgLightboxCaption') closeImageLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('imgLightbox') && $('imgLightbox').style.display !== 'none') closeImageLightbox();
  });
}

// ---- HOLD / BUY / SELL Signal ----
function computeSignal(card, pullCost, desirability) {
  if (!card) return null;

  const { priceUSD } = predictPrice(pullCost, desirability);
  const marketPrice = getCurrentPrice(card);
  const modelPrice = priceUSD;

  const modelVsMarket = modelPrice / marketPrice;
  const fc = forecast(card, pullCost, desirability);
  const yr1Expected = fc.scenarios.expected[0]?.priceUSD || marketPrice;
  const yr1Growth = (yr1Expected - marketPrice) / marketPrice;
  const yr3Expected = fc.scenarios.expected[2]?.priceUSD || marketPrice;
  const yr3Growth = (yr3Expected - marketPrice) / marketPrice;

  const momentum = getMarketMomentum();
  const isHeating = momentum.mult > 1.1;
  const isCooling = momentum.mult < 0.8;

  const rarityRate = (RARITY_RATES[card.rc] || RARITY_RATES['']).base;
  const isHighRarity = rarityRate >= 0.15;

  const charMult = getCharacterMultiplier(card.n);
  const isChaseChar = charMult >= 1.3;

  let score = 0;
  let reasons = [];

  if (modelVsMarket > 1.15) { score += 2; reasons.push('Model sees upside'); }
  else if (modelVsMarket > 1.05) { score += 1; reasons.push('Slightly undervalued'); }
  else if (modelVsMarket < 0.85) { score -= 2; reasons.push('Overvalued vs model'); }
  else if (modelVsMarket < 0.95) { score -= 1; reasons.push('Slightly overvalued'); }

  if (yr1Growth > 0.20) { score += 1; reasons.push(`+${(yr1Growth*100).toFixed(0)}% expected yr 1`); }
  else if (yr1Growth < 0.05) { score -= 1; reasons.push('Weak near-term growth'); }

  if (yr3Growth > 0.50) { score += 1; reasons.push('Strong 3yr outlook'); }

  if (isHeating) { score += 1; reasons.push('Market heating'); }
  if (isCooling) { score -= 1; reasons.push('Market cooling'); }

  if (isHighRarity && isChaseChar) { score += 1; reasons.push('Chase card premium'); }

  const ageMonths = getSetAgeMonths(card.sc);
  if (ageMonths < 3)       { score -= 2; reasons.push('Very new — price typically dips first 3 months'); }
  else if (ageMonths < 6)  { score -= 1; reasons.push('New set — price may still drop'); }
  else if (ageMonths < 24) { /* neutral — active market, no age adjustment */ }
  else if (ageMonths < 48) { score += 1; reasons.push('Proven set — demand well established'); }
  else                     { score += 2; reasons.push('Vintage scarcity premium'); }

  // Gem-rate signal: hard-to-grade cards command extra PSA 10 scarcity premium
  const gemRate = card.g != null ? card.g : null;
  if (gemRate !== null) {
    if (gemRate < 0.05)      { score += 1; reasons.push(`${(gemRate*100).toFixed(1)}% gem rate — very hard to grade`); }
    else if (gemRate >= 0.30) { score -= 1; reasons.push(`${(gemRate*100).toFixed(1)}% gem rate — easy to grade, many PSA 10s`); }
  }

  let signal, cls;
  if (score >= 3) { signal = 'STRONG BUY'; cls = 'signal-strong-buy'; }
  else if (score >= 1) { signal = 'BUY'; cls = 'signal-buy'; }
  else if (score <= -2) { signal = 'SELL'; cls = 'signal-sell'; }
  else { signal = 'HOLD'; cls = 'signal-hold'; }

  return { signal, cls, reasons: reasons.slice(0, 3), score };
}

function signalSentence(signal, reasons, owned) {
  if (owned && reasons.length) return reasons[0];
  const r = reasons.join(', ').toLowerCase();
  if (signal === 'STRONG BUY') return `Strong entry point right now — ${r}.`;
  if (signal === 'BUY') return `Worth picking up — ${r}.`;
  if (signal === 'SELL') return `Consider selling — ${r}.`;
  return r ? `Hold for now — ${r}.` : 'Price looks fair at current levels.';
}

function updateSignal(card, pullCost, desirability) {
  const wrap = $('signalWrap');
  const result = computeSignal(card, pullCost, desirability);
  if (!result) { wrap.style.display = 'none'; return; }

  const owned = portfolio.some(p => p.id === card.i);
  let { signal, cls, reasons } = result;

  if (owned) {
    // Derive badge solely from the Hold Strategy winner (_holdWinnerKey).
    // null  = renderHoldStrategy hasn't run yet for this card → safe default HOLD.
    // 'none'= Hold Strategy ran but no strategy is ROI-positive → SELL.
    if (_holdWinnerKey === null) {
      signal = 'HOLD'; cls = 'signal-hold';
      reasons = result.reasons;
    } else if (_holdWinnerKey === 'none') {
      signal = 'HOLD'; cls = 'signal-hold';
      reasons = ['Appreciation too low to beat opportunity cost — hold, don\'t add'];
    } else if (_holdWinnerKey === 'gamble') {
      signal = 'GRADE'; cls = 'signal-grade';
      reasons = ['Grading beats holding raw or buying a slab'];
    } else if (_holdWinnerKey === 'raw') {
      signal = 'HOLD'; cls = 'signal-hold';
      reasons = ['Holding raw is the best risk-adjusted play'];
    } else {
      // psa10 / psa9 / psa8 / psa7 — graded tier beats raw
      signal = 'SELL'; cls = 'signal-sell';
      reasons = ['Slab outperforms raw long-term — consider upgrading'];
    }
  }

  wrap.style.display = 'flex';
  wrap.classList.remove('is-expanded'); // reset tap-expanded state on card change
  $('signalBadge').textContent = signal;
  $('signalBadge').className = `signal-badge ${cls}`;
  $('signalReason').textContent = signalSentence(signal, reasons, owned);

  const holdDescEl = $('signalHoldDesc');
  const jumpBtnEl  = $('signalJumpHold');
  if (holdDescEl && jumpBtnEl) {
    if (_holdWinnerDesc) {
      holdDescEl.textContent = _holdWinnerDesc;
      holdDescEl.style.display = '';
      jumpBtnEl.style.display  = '';
    } else {
      holdDescEl.style.display = 'none';
      jumpBtnEl.style.display  = 'none';
    }
  }
}

// ---- Calculations ----
function calcPullCost() {
  const p = parseFloat($('packRate').value) || 1;
  const c = parseFloat($('cardsInTier').value) || 1;
  const raw = p * c;
  return { pullCost: raw / 100, rawPacks: raw };
}

function calcDesirability() {
  const ch = parseFloat($('characterPremium').value);
  const ar = parseFloat($('artworkHype').value);
  const ap = parseFloat($('universalAppeal').value);
  return (ch * WEIGHTS.char) + (ar * WEIGHTS.art) + (ap * WEIGHTS.appeal);
}

function predictPrice(pullCost, des) {
  const sf = Math.pow(PULL_MULT, pullCost);
  const df = Math.pow(DES_MULT, des);
  return { priceUSD: BASE * sf * df, sf, df };
}

// ---- Forecasting ----
function getSetAgeMonths(setCode) {
  if (!setsData || !setsData[setCode]) return 12;
  const released = setsData[setCode].releaseDate || setsData[setCode].released;
  if (!released) return 12;
  const releaseDate = new Date(released);
  const now = new Date();
  return Math.max(0, (now - releaseDate) / (1000 * 60 * 60 * 24 * 30.44));
}

function getAgeMultiplier(monthsOld, yearsForward) {
  const futureMonths = monthsOld + (yearsForward * 12);
  if (futureMonths < 6) return 0.6;
  if (futureMonths < 12) return 0.85;
  if (futureMonths < 24) return 1.0;
  if (futureMonths < 36) return 1.05;
  if (futureMonths < 48) return 1.1;
  return 1.15;
}

function forecast(card, pullCost, desirability) {
  const rarityRate = (RARITY_RATES[card.rc] || RARITY_RATES['']).base;
  const charMult = getCharacterMultiplier(card.n);
  const ageMonths = getSetAgeMonths(card.sc);

  const currentPriceUSD = getCurrentPrice(card);
  const years = [1, 2, 3, 4, 5];

  const scenarios = {
    conservative: [],
    expected: [],
    optimistic: [],
  };

  const momentum = getMarketMomentum();

  years.forEach(y => {
    const ageMult = getAgeMultiplier(ageMonths, y);
    const annualRate = rarityRate * charMult * ageMult;

    const momFade = y === 1 ? momentum.mult : y === 2 ? (1 + (momentum.mult - 1) * 0.5) : 1.0;
    const adjRate = annualRate * momFade;

    scenarios.conservative.push({
      year: y,
      priceUSD: currentPriceUSD * Math.pow(1 + adjRate * 0.5, y),
      rate: adjRate * 0.5,
    });
    scenarios.expected.push({
      year: y,
      priceUSD: currentPriceUSD * Math.pow(1 + adjRate, y),
      rate: adjRate,
    });
    scenarios.optimistic.push({
      year: y,
      priceUSD: currentPriceUSD * Math.pow(1 + adjRate * 1.3, y),
      rate: adjRate * 1.3,
    });
  });

  return { currentPriceUSD, scenarios, rarityRate, charMult, ageMonths, momentum };
}

function renderForecast(card, pullCost, desirability) {
  const fc = forecast(card, pullCost, desirability);
  const table = $('forecastTable');
  const canvas = $('forecastChart');

  let html = '';
  for (let i = 0; i < 5; i++) {
    const con = fc.scenarios.conservative[i];
    const exp = fc.scenarios.expected[i];
    const opt = fc.scenarios.optimistic[i];
    const expGBP = usdToGbp(exp.priceUSD);
    const conGBP = usdToGbp(con.priceUSD);
    const optGBP = usdToGbp(opt.priceUSD);
    const gain = ((exp.priceUSD - fc.currentPriceUSD) / fc.currentPriceUSD * 100).toFixed(0);

    html += `<tr>
      <td class="fc-year">Year ${con.year}</td>
      <td class="fc-con">£${conGBP.toFixed(0)}</td>
      <td class="fc-exp">£${expGBP.toFixed(0)}<span class="fc-gain">+${gain}%</span></td>
      <td class="fc-opt">£${optGBP.toFixed(0)}</td>
    </tr>`;
  }
  table.querySelector('tbody').innerHTML = html;

  const rarityInfo = RARITY_RATES[card.rc] || RARITY_RATES[''];
  const rateLabel = rarityInfo.label;
  const rarityReason = rarityInfo.reason || '';
  const charMult = fc.charMult;
  const annualPct = (fc.scenarios.expected[0].rate * 100).toFixed(1);
  const momLabel = fc.momentum?.label || '';
  const priceSource = livePrice ? 'Live price' : 'Static price';
  const charContext = charMult >= 1.6
    ? `S-tier character demand (×${charMult.toFixed(1)}) lifts this to ${annualPct}% expected annually.`
    : charMult >= 1.3
      ? `A-tier character demand (×${charMult.toFixed(1)}) lifts this to ${annualPct}% expected annually.`
      : charMult >= 1.1
        ? `Above-average character demand (×${charMult.toFixed(1)}) lifts this to ${annualPct}% expected annually.`
        : `No significant character premium; ${annualPct}% from rarity baseline alone.`;
  $('forecastInfo').innerHTML = `
    <div style="margin-bottom:5px">
      <span>${rateLabel} base rate</span> ·
      <span>${charMult > 1 ? charMult.toFixed(1) + '× character premium' : 'Standard character'}</span> ·
      <span>${annualPct}% expected annual growth</span>
      ${momLabel ? `· <span style="color:${fc.momentum.mult > 1 ? 'var(--green)' : fc.momentum.mult < 1 ? 'var(--red)' : 'var(--text-muted)'}">${momLabel}</span>` : ''}
      · <span style="color:var(--text-faint);font-size:11px">${priceSource}</span>
    </div>
    <div class="fc-reason">${rarityReason} — ${charContext}</div>
  `;

  drawForecastChart(canvas, fc);
}

let _fcState = null;

function drawForecastChart(canvas, fc, hoverYear = null) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  ctx.clearRect(0, 0, W, H);

  const current = usdToGbp(fc.currentPriceUSD);
  const allPrices = [current, ...fc.scenarios.optimistic.map(s => usdToGbp(s.priceUSD))];
  const maxP = Math.max(...allPrices) * 1.1;
  const minP = Math.min(current * 0.9, ...fc.scenarios.conservative.map(s => usdToGbp(s.priceUSD))) * 0.9;

  const pad = { l: 60, r: 20, t: 20, b: 36 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  function x(year) { return pad.l + (year / 5) * cw; }
  function y(price) { return pad.t + ch - ((price - minP) / (maxP - minP)) * ch; }

  // Store state for interactive hover
  _fcState = { fc, W, H, pad, cw, current, minP, maxP, x, y };

  ctx.strokeStyle = '#2a2d3a';
  ctx.lineWidth = 1;
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const gp = minP + (maxP - minP) * (i / gridCount);
    const gy = y(gp);
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    ctx.fillStyle = '#555768';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`£${Math.round(gp).toLocaleString()}`, pad.l - 8, gy + 4);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#555768';
  ctx.font = '11px Space Grotesk, sans-serif';
  for (let yr = 0; yr <= 5; yr++) {
    ctx.fillText(yr === 0 ? 'Now' : `${yr}yr`, x(yr), H - 8);
  }

  ctx.fillStyle = 'rgba(232, 182, 52, 0.06)';
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  for (let i = 0; i < 5; i++) ctx.lineTo(x(i + 1), y(usdToGbp(fc.scenarios.optimistic[i].priceUSD)));
  for (let i = 4; i >= 0; i--) ctx.lineTo(x(i + 1), y(usdToGbp(fc.scenarios.conservative[i].priceUSD)));
  ctx.lineTo(x(0), y(current));
  ctx.fill();

  ctx.strokeStyle = 'rgba(138, 138, 138, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  fc.scenarios.conservative.forEach((s, i) => ctx.lineTo(x(i + 1), y(usdToGbp(s.priceUSD))));
  ctx.stroke();

  ctx.strokeStyle = 'rgba(232, 182, 52, 0.35)';
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  fc.scenarios.optimistic.forEach((s, i) => ctx.lineTo(x(i + 1), y(usdToGbp(s.priceUSD))));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = '#e8b634';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  fc.scenarios.expected.forEach((s, i) => ctx.lineTo(x(i + 1), y(usdToGbp(s.priceUSD))));
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(x(0), y(current), 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e8b634';
  ctx.beginPath(); ctx.arc(x(0), y(current), 3, 0, Math.PI * 2); ctx.fill();

  const finalGBP = usdToGbp(fc.scenarios.expected[4].priceUSD);
  ctx.fillStyle = '#e8b634';
  ctx.beginPath(); ctx.arc(x(5), y(finalGBP), 5, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 13px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`£${Math.round(finalGBP).toLocaleString()}`, x(5) - 10, y(finalGBP) - 10);

  // Hover crosshair
  if (hoverYear !== null) {
    const hx = x(hoverYear);
    ctx.strokeStyle = 'rgba(232, 182, 52, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    const pts = [
      { price: hoverYear === 0 ? current : usdToGbp(fc.scenarios.conservative[hoverYear - 1].priceUSD), col: 'rgba(138,138,138,0.8)' },
      { price: hoverYear === 0 ? current : usdToGbp(fc.scenarios.expected[hoverYear - 1].priceUSD), col: '#e8b634' },
      { price: hoverYear === 0 ? current : usdToGbp(fc.scenarios.optimistic[hoverYear - 1].priceUSD), col: 'rgba(232,182,52,0.5)' },
    ];
    pts.forEach(p => {
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(hx, y(p.price), 5, 0, Math.PI * 2); ctx.fill();
    });
  }
}

function setupForecastHover(canvas) {
  const tooltip = document.getElementById('fcTooltip');
  if (!tooltip) return;

  function getHoverYear(e) {
    if (!_fcState) return null;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const relX = clientX - rect.left;
    const { pad, cw } = _fcState;
    const raw = (relX - pad.l) / cw * 5;
    return Math.max(0, Math.min(5, Math.round(raw)));
  }

  function showTooltip(yr, e) {
    if (!_fcState) return;
    const { fc, current } = _fcState;
    const label = yr === 0 ? 'Now' : `Year ${yr}`;
    const con = yr === 0 ? current : usdToGbp(fc.scenarios.conservative[yr - 1].priceUSD);
    const exp = yr === 0 ? current : usdToGbp(fc.scenarios.expected[yr - 1].priceUSD);
    const opt = yr === 0 ? current : usdToGbp(fc.scenarios.optimistic[yr - 1].priceUSD);
    const fmt = v => `£${Math.round(v).toLocaleString()}`;
    tooltip.innerHTML = `
      <div class="fc-tt-year">${label}</div>
      <div class="fc-tt-row"><span class="fc-tt-dot fc-tt-opt"></span><span class="fc-tt-lbl">Optimistic</span><span class="fc-tt-val">${fmt(opt)}</span></div>
      <div class="fc-tt-row"><span class="fc-tt-dot fc-tt-exp"></span><span class="fc-tt-lbl">Expected</span><span class="fc-tt-val">${fmt(exp)}</span></div>
      <div class="fc-tt-row"><span class="fc-tt-dot fc-tt-con"></span><span class="fc-tt-lbl">Conservative</span><span class="fc-tt-val">${fmt(con)}</span></div>
    `;
    tooltip.style.display = 'block';
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const relX = clientX - rect.left;
    const tipW = 170;
    const left = relX + tipW + 12 > rect.width ? relX - tipW - 8 : relX + 12;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '10px';
    drawForecastChart(canvas, fc, yr);
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
    if (_fcState) drawForecastChart(canvas, _fcState.fc, null);
  }

  canvas.addEventListener('mousemove', e => { const yr = getHoverYear(e); if (yr !== null) showTooltip(yr, e); });
  canvas.addEventListener('mouseleave', hideTooltip);
  canvas.addEventListener('touchstart', e => { e.preventDefault(); const yr = getHoverYear(e); if (yr !== null) showTooltip(yr, e); }, { passive: false });
  canvas.addEventListener('touchmove', e => { e.preventDefault(); const yr = getHoverYear(e); if (yr !== null) showTooltip(yr, e); }, { passive: false });
  canvas.addEventListener('touchend', hideTooltip);
}

function initForecastInteractivity() {
  const canvas = document.getElementById('forecastChart');
  if (canvas) setupForecastHover(canvas);
}

// ---- UI Update ----
function updateAll() {
  const { pullCost, rawPacks } = calcPullCost();
  $('pullCostDisplay').textContent = pullCost.toFixed(2);
  $('packsNeeded').textContent = `≈ ${Math.round(rawPacks).toLocaleString()} packs for this specific card`;

  const des = calcDesirability();
  $('desirabilityDisplay').textContent = des.toFixed(1);
  $('desirabilityBar').style.width = `${(des / 10) * 100}%`;
  $('characterPremiumValue').textContent = parseFloat($('characterPremium').value).toFixed(1);
  $('artworkHypeValue').textContent = parseFloat($('artworkHype').value).toFixed(1);
  $('universalAppealValue').textContent = parseFloat($('universalAppeal').value).toFixed(1);

  // Pack cost — same calculation as Rip or Buy so both sections are consistent
  const econDisp = selectedCard ? resolvePackEconomics(selectedCard) : null;
  const marketUSD = selectedCard ? getCurrentPrice(selectedCard) : 0;
  let packTotalUSD = 0;
  if (econDisp) {
    const evPerPack = setsData?.[selectedCard.sc]?.evPerPack || 0;
    packTotalUSD = Math.max(0, (econDisp.packsNeeded * econDisp.packCost) - (econDisp.packsNeeded * evPerPack));
  }
  lastModelPriceUSD = packTotalUSD;
  const packTotalGBP = usdToGbp(packTotalUSD);
  $('predictedPriceGBP').textContent = packTotalGBP > 0 ? fmtGBPDirect(packTotalGBP) : '—';

  // Rationale line beneath the pack cost
  const rationaleEl = document.getElementById('ppModelRationale');
  if (rationaleEl && econDisp) {
    const pppc = fmtGBPDirect(usdToGbp(econDisp.packCost));
    const overrideNote = selectedCard && getPackCostOverride(selectedCard.sc) ? ' · overridden' : '';
    rationaleEl.textContent = `${econDisp.packsNeeded.toLocaleString()} packs × ${pppc}/pack${overrideNote}`;
  } else if (rationaleEl) {
    rationaleEl.textContent = '';
  }

  updateMaxPrice(marketUSD);
  updateDealCheck(marketUSD);

  if (selectedCard) {
    renderForecast(selectedCard, pullCost, des);
    updateRipOrBuy(selectedCard, pullCost);
    updateSignal(selectedCard, pullCost, des);
  }
}

// ebayFairListing: the listing price at which a seller nets exactly `marketGBP`
// after eBay's 12.9% FVF + £0.30 fixed fee. This is the ceiling you should pay
// on eBay for fair value — the same formula used in Deal Check.
function _ebayFair(marketGBP) {
  return (marketGBP + EBAY_FIXED_FEE) / (1 - EBAY_FEE_UK);
}

function updateMaxPrice(modelPriceUSD) {
  const ppMaxbuy = document.getElementById('ppMaxbuy');
  const ppDivider = document.getElementById('ppDivider');
  const inPortfolio = selectedCard ? portfolio.some(p => p.id === selectedCard.i) : false;
  if (ppMaxbuy) ppMaxbuy.style.display = inPortfolio ? 'none' : '';
  if (ppDivider) ppDivider.style.display = inPortfolio ? 'none' : '';

  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const gradeKey = $('maxBuyGrade')?.value || 'raw';
  const gradeNum = gradeKey !== 'raw' ? parseInt(gradeKey, 10) : 0;

  let maxGBP, logic;
  if (selectedCard) {
    const mkt = getCurrentPrice(selectedCard);
    const mktGBP = usdToGbp(mkt);
    const isLive = livePrice && (livePrice.market > 0 || livePrice.mid > 0);
    const priceTag = isLive ? 'live market' : 'market';

    if (gradeNum > 0) {
      // PSA grade: derive market value from PSA 10 anchor × grade ratio,
      // then apply eBay fee buffer so the result is the fair listing price.
      const anchor = getPsa10Anchor(selectedCard);
      const psa10USD = anchor && anchor.usd > 0 ? anchor.usd : 0;
      if (psa10USD > 0) {
        const gradeMarketGBP = usdToGbp(psa10USD * (PSA_RATIOS[gradeNum] || 1));
        maxGBP = _ebayFair(gradeMarketGBP);
        const anchorNote = anchor.source === 'estimated' ? ' est.' : '';
        const ratioPct = Math.round((PSA_RATIOS[gradeNum] || 1) * 100);
        logic = `PSA ${gradeNum} market ${fmtGBPDirect(gradeMarketGBP)} · PSA 10 ${fmtGBP(psa10USD)}${anchorNote} × ${ratioPct}% · seller nets ${fmtGBPDirect(gradeMarketGBP)} after fees`;
      } else {
        maxGBP = 0;
        logic = 'No PSA 10 anchor — refresh live prices for this card first';
      }
    } else {
      // Raw: market price is the reference — max you should pay on eBay
      const refGBP = mktGBP;
      maxGBP = _ebayFair(refGBP);
      const hc = (typeof computeHoldCore === 'function') ? computeHoldCore(selectedCard) : { ok: false };
      let holdNote = '';
      if (hc.ok && hc.bestLongTermPick) {
        const roi = Math.round(hc.bestLongTermPick.roi);
        holdNote = ` · ${hc.bestLongTermPick.label} hold ROI +${roi}%`;
      }
      logic = `${priceTag.charAt(0).toUpperCase() + priceTag.slice(1)} ${fmtGBPDirect(mktGBP)} · seller nets ${fmtGBPDirect(refGBP)} after fees${holdNote}`;
    }
  } else {
    maxGBP = 0;
    logic = 'Select a card to calculate max buy price';
  }
  $('maxPriceGBP').textContent = maxGBP > 0
    ? `£${maxGBP.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
  $('maxPriceLogic').textContent = logic;
}

function updateDealCheck(modelPriceUSD) {
  const ebayGBP = parseFloat($('ebayPrice').value);
  if (!ebayGBP || ebayGBP <= 0) {
    $('dealResult').innerHTML = '<div class="deal-placeholder">Enter an eBay price to check</div>';
    $('dealResult').className = 'deal-result';
    return;
  }
  const gradeKey = ($('dealGrade') && $('dealGrade').value) || 'raw';
  const shippingGBP = parseFloat($('dealShipping')?.value) || 0;
  const totalSpendGBP = ebayGBP + shippingGBP;
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;

  // Raw market reference (PriceCharting / pokemontcg.io) — NOT eBay-adjusted.
  let refUSD;
  if (gradeKey !== 'raw' && selectedCard) {
    const anchor = getPsa10Anchor(selectedCard);
    const psa10USD = anchor && anchor.usd > 0 ? anchor.usd : 0;
    if (psa10USD > 0) {
      const gradeNum = parseInt(gradeKey.replace('psa', ''), 10) || 10;
      refUSD = psa10USD * (PSA_RATIOS[gradeNum] || 1);
    } else {
      refUSD = getCurrentPrice(selectedCard);
    }
  } else {
    refUSD = selectedCard ? getCurrentPrice(selectedCard) : 0;
  }
  const marketGBP = usdToGbp(refUSD); // raw market reference

  // Exact eBay-adjusted fair price: the listing price at which a seller nets
  // exactly market value after eBay's 12.9% FVF + £0.30 fixed fee.
  // fair_listing = (market + fixed_fee) / (1 - pct_fee)
  const ebayFairCardGBP  = marketGBP > 0 ? (marketGBP + EBAY_FIXED_FEE) / (1 - EBAY_FEE_UK) : 0;
  const ebayFairTotalGBP = ebayFairCardGBP + shippingGBP;

  // What eBay actually takes on this specific listing, and what seller nets.
  const ebayFeesGBP       = ebayGBP * EBAY_FEE_UK + EBAY_FIXED_FEE;
  const sellerNetsGBP     = ebayGBP - ebayFeesGBP;
  const sellerVsMarketGBP = sellerNetsGBP - marketGBP; // +ve = seller profits above market

  // Absolute difference vs the eBay-adjusted fair value.
  const diff = ebayFairTotalGBP - totalSpendGBP;
  const pct  = ebayFairTotalGBP > 0 ? Math.abs((diff / ebayFairTotalGBP) * 100).toFixed(0) : 0;

  // Hold strategy ROI at this specific entry price.
  let holdLine = '';
  if (selectedCard && typeof computeHoldCore === 'function') {
    const hc = computeHoldCore(selectedCard);
    if (hc.ok && hc.bestLongTermPick) {
      // bestLongTermPick.yr5 is the 5yr projected net exit price in USD.
      const yr5GBP = hc.bestLongTermPick.yr5 * fx;
      const entryROI = totalSpendGBP > 0 ? ((yr5GBP - totalSpendGBP) / totalSpendGBP * 100) : 0;
      const roiSign = entryROI >= 0 ? '+' : '';
      const roiCls  = entryROI >= MIN_HOLD_ROI * 100 ? 'deal-roi-good'
                    : entryROI >= 0                  ? 'deal-roi-ok'
                    : 'deal-roi-bad';
      holdLine = `<div class="deal-hold-roi ${roiCls}">${hc.bestLongTermPick.label}: ${roiSign}${entryROI.toFixed(0)}% hold ROI at this entry · 5yr target ${fmtGBPDirect(yr5GBP)}</div>`;
    }
  }

  // Fee breakdown row — what eBay takes, what seller pockets, fair price for both.
  let feeBreakdown = '';
  if (marketGBP > 0) {
    const absVsMarket = Math.abs(sellerVsMarketGBP);
    const direction   = sellerVsMarketGBP >= 0 ? 'above' : 'below';
    const pctVsMkt    = marketGBP > 0 ? (absVsMarket / marketGBP * 100).toFixed(0) : 0;
    feeBreakdown = `<div class="deal-fee-breakdown">eBay takes ~${fmtGBPDirect(ebayFeesGBP)} · seller nets ~${fmtGBPDirect(sellerNetsGBP)} (${pctVsMkt}% ${direction} market) · fair for both ~${fmtGBPDirect(ebayFairCardGBP)}</div>`;
  }

  let cls, verdict, note;
  if (diff > ebayFairTotalGBP * 0.08) {
    // >8% below eBay fair price — genuinely cheap for eBay
    cls = 'good-deal'; verdict = 'Good eBay Deal';
    note = `${pct}% below fair listing (${fmtGBPDirect(ebayFairCardGBP)}) · market ~${fmtGBPDirect(marketGBP)}`;
  } else if (diff < -ebayFairTotalGBP * 0.10) {
    // >10% above eBay fair price — overpriced even for eBay
    cls = 'bad-deal'; verdict = 'Overpriced';
    note = `${pct}% above fair listing (${fmtGBPDirect(ebayFairCardGBP)}) · market ~${fmtGBPDirect(marketGBP)}`;
  } else {
    cls = 'ok-deal'; verdict = 'Fair for eBay';
    note = `Within range of fair listing (~${fmtGBPDirect(ebayFairCardGBP)}) · market ~${fmtGBPDirect(marketGBP)}`;
  }

  $('dealResult').className = `deal-result ${cls}`;
  $('dealResult').innerHTML = `<div class="deal-active">
    <div class="deal-verdict">${verdict}</div>
    <div class="deal-saving">${diff > 0 ? `Save ~£${Math.abs(diff).toFixed(2)} vs fair listing` : `~£${Math.abs(diff).toFixed(2)} above fair listing`}</div>
    <div class="deal-note">${note}</div>
    ${feeBreakdown}
    ${holdLine}
  </div>`;

  const saveBtn = $('dealSaveHold');
  if (saveBtn) {
    if (selectedCard && selectedCard.i) {
      saveBtn.style.display = 'block';
      saveBtn.onclick = () => {
        const gradeKey = $('dealGrade') ? $('dealGrade').value : 'raw';
        const savedShip = parseFloat($('dealShipping')?.value) || 0;
        const allInGBP = ebayGBP + savedShip; // total cost including shipping
        setHoldOverride(selectedCard.i, gradeKey, allInGBP);
        try { renderHoldOverridePanel(selectedCard); } catch {}
        try { renderHoldStrategy(selectedCard); } catch {}
        saveBtn.textContent = 'Saved';
        setTimeout(() => { saveBtn.textContent = 'Save to Hold Strategy'; }, 1800);
      };
    } else {
      saveBtn.style.display = 'none';
    }
  }
}

// ---- Rip or Buy ----
function updateRipOrBuy(card, pullCost) {
  const section = $('ripSection');
  if (!card) { section.style.display = 'none'; return; }

  const inPortfolio = portfolio.some(p => p.id === card.i);
  if (inPortfolio) { section.style.display = 'none'; return; }

  const econ = resolvePackEconomics(card);
  if (!econ) { section.style.display = 'none'; return; }

  section.style.display = 'block';

  const { packsPerHit, tierSize, packsNeeded, packCost } = econ;
  // EV per pack — only use sets-db value if available, otherwise 0 (conservative)
  const set = setsData?.[card.sc];
  const evPerPack = set?.evPerPack || 0;

  const totalRipCost = packsNeeded * packCost;
  const evRecovered = packsNeeded * evPerPack;
  const netRipCost = totalRipCost - evRecovered;
  const singleCost = getCurrentPrice(card);

  // Source label — transparency about where numbers come from
  const usingFallbackRate = !(set?.rarities?.[card.rc]?.pullRate > 0);
  const overrideGBP = getPackCostOverride(card.sc);
  const usingOverrideCost = overrideGBP > 0;
  const usingFallbackCost = !usingOverrideCost && !(set?.packCost > 0);
  const sourceLabel = usingFallbackRate || usingFallbackCost
    ? 'Estimated from rarity & set era'
    : usingOverrideCost
      ? 'Tracked pull-rate data · Pack price overridden'
      : 'Tracked pull-rate data';

  // ---- Packs Needed callout (always shown) ----
  $('ripPacksNeeded').textContent = packsNeeded.toLocaleString();

  // Per-pack odds for THIS specific card
  const perPackProb = 1 / packsNeeded;
  const perPackPct = perPackProb * 100;
  const oddsPctText = perPackPct >= 1
    ? perPackPct.toFixed(2) + '%'
    : perPackPct >= 0.01
      ? perPackPct.toFixed(3) + '%'
      : perPackPct.toExponential(2) + '%';

  $('ripPerPackOdds').innerHTML =
    `Per-pack odds: <strong>1 in ${packsNeeded.toLocaleString()}</strong> ` +
    `<span class="rpn-pct">(${oddsPctText})</span>`;

  $('ripPacksOdds').innerHTML =
    `≈1 in <strong>${packsPerHit.toLocaleString()}</strong> packs hits this rarity · ` +
    `<strong>${tierSize}</strong> different cards in tier`;
  $('ripPacksSource').textContent = sourceLabel;

  // ---- Comparison ----
  $('ripPackCost').textContent = fmtGBP(netRipCost);
  $('ripPackDetail').textContent = `${packsNeeded.toLocaleString()} packs × ${fmtGBP(packCost)}/pack`;
  $('ripPackSub').textContent = evPerPack > 0
    ? `Net after selling pulls (EV ${fmtGBP(evPerPack)}/pack)`
    : 'Worst case: no value recovered from other pulls';

  $('ripSingleCost').textContent = singleCost > 0 ? fmtGBP(singleCost) : '—';
  $('ripSingleDetail').textContent = singleCost > 0
    ? (livePrice ? 'Live market price' : 'Current market price')
    : 'No market price data';

  // ---- Verdict ----
  const badge = $('ripVerdict');
  if (singleCost > 0) {
    const ripMultiple = netRipCost / singleCost;
    const savings = netRipCost - singleCost;
    const savingsGBP = usdToGbp(Math.abs(savings));

    if (ripMultiple > 1.2) {
      badge.textContent = 'BUY SINGLE'; badge.className = 'rip-verdict-badge rip-buy';
    } else if (ripMultiple < 0.8) {
      badge.textContent = 'RIP PACKS'; badge.className = 'rip-verdict-badge rip-rip';
    } else {
      badge.textContent = 'CLOSE CALL'; badge.className = 'rip-verdict-badge rip-close';
    }

    if (savings > 0) {
      $('ripSavings').innerHTML = `<span class="rip-save-good">Buying the single saves you £${savingsGBP.toFixed(0)}</span> <span class="rip-save-mult">(ripping costs ${ripMultiple.toFixed(1)}× more)</span>`;
    } else {
      $('ripSavings').innerHTML = `<span class="rip-save-rip">Ripping saves you £${savingsGBP.toFixed(0)}</span> vs buying — but variance is high`;
    }
  } else {
    badge.textContent = 'BUY SINGLE'; badge.className = 'rip-verdict-badge rip-buy';
    $('ripSavings').innerHTML = `<span class="rip-save-mult">No live single price — ripping for chase usually loses against buying once a price is set</span>`;
  }

  // ---- Luck percentiles (geometric distribution) ----
  const prob = 1 / packsNeeded;
  const luckyPacks = Math.max(1, Math.ceil(Math.log(0.75) / Math.log(1 - prob)));
  const unluckyPacks = Math.ceil(Math.log(0.25) / Math.log(1 - prob));
  const medianPacks = Math.ceil(Math.log(0.5) / Math.log(1 - prob));

  const luckyNet = (luckyPacks * packCost) - (luckyPacks * evPerPack);
  const medianNet = (medianPacks * packCost) - (medianPacks * evPerPack);
  const unluckyNet = (unluckyPacks * packCost) - (unluckyPacks * evPerPack);
  $('ripLuck').innerHTML = `
    <div class="rip-luck-row"><span class="rip-luck-label">Lucky (25th pct)</span><span>${luckyPacks.toLocaleString()} packs → net ${fmtGBP(luckyNet)}</span></div>
    <div class="rip-luck-row"><span class="rip-luck-label">Median (50%)</span><span>${medianPacks.toLocaleString()} packs → net ${fmtGBP(medianNet)}</span></div>
    <div class="rip-luck-row"><span class="rip-luck-label">Unlucky (75th pct)</span><span>${unluckyPacks.toLocaleString()} packs → net ${fmtGBP(unluckyNet)}</span></div>
  `;

  // ---- Pack cost override UI ----
  const packCostGBPVal = usdToGbp(packCost);
  const overrideCurrentCostEl = $('ripOverrideCurrentCost');
  const overrideFormEl = $('ripOverrideForm');
  const overrideToggleBtn = $('ripOverrideToggle');
  const overrideInputEl = $('ripOverrideInput');
  const overrideSaveBtn = $('ripOverrideSaveBtn');
  const overrideClearBtn = $('ripOverrideClearBtn');

  if (overrideCurrentCostEl) {
    if (usingOverrideCost) {
      overrideCurrentCostEl.innerHTML = `<span class="rip-override-active">${fmtGBPDirect(overrideGBP)}/pack (overridden)</span>`;
    } else {
      overrideCurrentCostEl.textContent = `${fmtGBPDirect(packCostGBPVal)}/pack`;
    }
  }
  if (overrideInputEl) overrideInputEl.value = (overrideGBP || packCostGBPVal).toFixed(2);
  if (overrideFormEl) overrideFormEl.style.display = 'none';
  if (overrideToggleBtn) {
    overrideToggleBtn.textContent = usingOverrideCost ? 'Edit' : 'Override';
    overrideToggleBtn.className = `rip-override-toggle-btn${usingOverrideCost ? ' active' : ''}`;
    overrideToggleBtn.onclick = () => {
      if (overrideFormEl) overrideFormEl.style.display = overrideFormEl.style.display === 'none' ? 'flex' : 'none';
    };
  }
  if (overrideSaveBtn) {
    overrideSaveBtn.onclick = () => {
      const val = parseFloat(overrideInputEl?.value);
      if (val > 0) { setPackCostOverride(card.sc, val); updateRipOrBuy(card, pullCost); }
    };
  }
  if (overrideClearBtn) {
    overrideClearBtn.onclick = () => { clearPackCostOverride(card.sc); updateRipOrBuy(card, pullCost); };
  }
}

// ---- Market Dynamics (live from collectrics API) ----
let marketData = null;
let marketFetchId = 0;

async function fetchMarketData(cardId) {
  const thisId = ++marketFetchId;
  $('marketSection').style.display = 'block';
  $('marketLoading').style.display = 'block';
  $('marketLoading').textContent = 'Loading market data...';
  $('marketContent').style.display = 'none';
  $('marketTrend').textContent = '';
  $('marketTrend').className = 'market-trend-badge';
  marketData = null;

  try {
    const apiUrl = `https://mycollectrics.com/api/card/${cardId}?include=ebay`;
    const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(apiUrl)}`;
    const r = await fetch(proxyUrl);
    if (!r.ok) throw new Error('API error');
    const d = await r.json();
    if (thisId !== marketFetchId) return;
    marketData = d;

    const mp = d.collectrics?.['market-pressure'];
    const ebayHist = d['history-ebay-market'] || [];
    const priceHist = d.history || [];

    // Always try to render the price history chart (independent of market-pressure)
    renderPriceHistory(priceHist);

    if (!mp || ebayHist.length < 3) {
      $('marketLoading').textContent = 'No market data available for this card';
      return;
    }

    $('marketLoading').style.display = 'none';
    $('marketContent').style.display = 'block';
    renderMarketDynamics(mp, ebayHist);
    renderGradingROI(d);

    if (selectedCard) {
      const { pullCost } = calcPullCost();
      const des = calcDesirability();
      renderForecast(selectedCard, pullCost, des);
      updateSignal(selectedCard, pullCost, des);
    }
  } catch (e) {
    if (thisId !== marketFetchId) return;
    $('marketLoading').textContent = 'Market data unavailable';
    $('priceHistSection').style.display = 'none';
    console.warn('Market fetch failed:', e);
  }
}

function renderMarketDynamics(mp, ebayHist) {
  const est = mp.estimated || mp.observed;
  const obs = mp.observed;
  const d7 = est['7d'];
  const d30 = est['30d'];
  const baseline = est['baseline-comparison'] || obs?.['baseline-comparison'];

  if (!d7 || !d30) return;

  const dp = (d7.metrics['demand-pressure-est'] || d7.metrics['demand-pressure'] || 0) * 100;
  const dpPct = Math.min(100, (dp / 15) * 100);
  $('gaugeDemand').style.width = `${dpPct}%`;
  $('demandValue').textContent = `${dp.toFixed(1)}%`;

  const ssi = baseline?.['supply-saturation-index'] ?? 1.0;
  const ssiPct = Math.min(100, Math.max(0, (ssi / 2) * 100));
  $('gaugeSupply').style.width = `${ssiPct}%`;
  $('supplyValue').textContent = ssi.toFixed(2);
  const ssiLabel = baseline?.['supply-saturation-label'] || (ssi < 0.8 ? 'tightening' : ssi > 1.2 ? 'loosening' : 'normal');
  $('supplyDesc').textContent = ssiLabel === 'normal' ? 'Balanced vs 30d' : ssiLabel === 'tightening' ? 'Supply tightening' : 'Supply loosening';

  const trend = baseline?.trend || 'stable';
  const badge = $('marketTrend');
  const trendLabels = {
    'heating': 'Heating Up', 'cooling': 'Cooling Off', 'stable': 'Stable',
    'strongly_heating': 'Hot', 'strongly_cooling': 'Cold',
    'tightening': 'Tightening', 'loosening': 'Loosening',
    'strongly loosening': 'Loosening', 'strongly tightening': 'Tightening',
  };
  badge.textContent = trendLabels[trend] || trend.replace(/_/g, ' ');
  if (trend.includes('heat') || trend.includes('hot') || trend.includes('tighten')) badge.className = 'market-trend-badge trend-heating';
  else if (trend.includes('cool') || trend.includes('cold') || trend.includes('loosen')) badge.className = 'market-trend-badge trend-cooling';
  else badge.className = 'market-trend-badge trend-stable';

  const raw7 = d7.raw || {};
  const raw30 = d30.raw || {};
  const activeDelta = baseline?.['active-listings-delta-pct'] ?? 0;
  const demandDelta = baseline?.['demand-delta-pct'] ?? 0;

  function fmtDelta(pct) {
    const p = (pct * 100).toFixed(0);
    if (Math.abs(pct) < 0.01) return '<span class="mstat-delta flat">—</span>';
    return pct > 0 ? `<span class="mstat-delta up">+${p}%</span>` : `<span class="mstat-delta down">${p}%</span>`;
  }

  $('marketStats').innerHTML = `
    <div class="mstat"><div class="mstat-label">Active Listings</div><div class="mstat-value">${(raw7['avg-active'] || 0).toFixed(0)}</div>${fmtDelta(activeDelta)}</div>
    <div class="mstat"><div class="mstat-label">Sold Est/Day</div><div class="mstat-value">${(raw7['avg-sold-est'] || raw7['avg-ended'] || 0).toFixed(1)}</div>${fmtDelta(demandDelta)}</div>
    <div class="mstat"><div class="mstat-label">New/Day</div><div class="mstat-value">${(raw7['avg-new'] || 0).toFixed(1)}</div>${fmtDelta(baseline?.['supply-delta-pct'] ?? 0)}</div>
  `;

  drawListingChart($('listingChart'), ebayHist);
}

// =============================================================
// Price History (raw daily prices over the last ~3 months)
// =============================================================
let priceHistoryData = null;     // full history array (most recent last)
let priceHistoryRange = 30;       // current selected range in days, or 'all'

function hidePriceHistory() {
  $('priceHistSection').style.display = 'none';
  priceHistoryData = null;
}

function renderPriceHistory(history) {
  const section = $('priceHistSection');
  if (!Array.isArray(history) || history.length < 3) {
    section.style.display = 'none';
    return;
  }
  // Filter to entries that have a usable raw-price > 0
  const cleaned = history
    .filter(h => h && h.date && (h['raw-price'] || h['psa-9-price']))
    .map(h => ({
      date: h.date,
      raw: h['raw-price'] || 0,
      psa9: h['psa-9-price'] || 0,
      psa10: h['psa-10-price'] || 0,
      vol: h['sales-volume'] || 0,
    }))
    .filter(h => h.raw > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (cleaned.length < 3) { section.style.display = 'none'; return; }

  priceHistoryData = cleaned;
  section.style.display = 'block';
  $('phLoading').style.display = 'none';
  $('phContent').style.display = 'block';

  // Reset to default 30d when a new card loads
  priceHistoryRange = 30;
  document.querySelectorAll('.phr-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === '30');
  });

  drawAndAnnotatePriceHistory();
}

function drawAndAnnotatePriceHistory() {
  if (!priceHistoryData) return;
  const all = priceHistoryData;
  const range = priceHistoryRange === 'all' ? all.length : parseInt(priceHistoryRange);
  const data = all.slice(-range);

  // ---- Headline metrics ----
  const last = all[all.length - 1].raw;
  const lastUSD = last; // already USD

  function priceAt(daysAgo) {
    const idx = all.length - 1 - daysAgo;
    if (idx < 0) return null;
    return all[idx].raw;
  }
  function pctChange(daysAgo) {
    const past = priceAt(daysAgo);
    if (!past || past <= 0) return null;
    return ((last - past) / past) * 100;
  }

  const d7 = pctChange(7);
  const d30 = pctChange(30);
  const d90 = pctChange(90);

  $('phCurrent').textContent = fmtGBP(lastUSD);

  function renderDelta(label, pct) {
    if (pct === null) return `<div class="ph-delta"><div class="ph-delta-label">${label}</div><div class="ph-delta-value flat">—</div></div>`;
    const cls = Math.abs(pct) < 1 ? 'flat' : pct > 0 ? 'up' : 'down';
    const sign = pct > 0 ? '+' : '';
    return `<div class="ph-delta"><div class="ph-delta-label">${label}</div><div class="ph-delta-value ${cls}">${sign}${pct.toFixed(1)}%</div></div>`;
  }
  $('phDeltas').innerHTML = renderDelta('7 day', d7) + renderDelta('30 day', d30) + renderDelta('90 day', d90);

  // ---- Range stats ----
  const prices = data.map(d => d.raw);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const avgP = prices.reduce((a, b) => a + b, 0) / prices.length;
  const fromLow = ((last - minP) / minP) * 100;
  const fromHigh = ((last - maxP) / maxP) * 100;

  $('phStats').innerHTML = `
    <div class="ph-stat"><div class="ph-stat-label">Range Low</div><div class="ph-stat-value">${fmtGBP(minP)}</div></div>
    <div class="ph-stat"><div class="ph-stat-label">Range Avg</div><div class="ph-stat-value">${fmtGBP(avgP)}</div></div>
    <div class="ph-stat"><div class="ph-stat-label">Range High</div><div class="ph-stat-value">${fmtGBP(maxP)}</div></div>
  `;

  // ---- Verdict + summary ----
  const verdict = computePriceVerdict({ d7, d30, d90, last, minP, maxP, avgP, fromLow, fromHigh });
  const badge = $('phVerdict');
  badge.textContent = verdict.label;
  badge.className = 'ph-verdict ' + verdict.cls;

  $('phSummary').innerHTML = verdict.summary;

  // ---- Draw chart ----
  drawPriceChart($('priceHistChart'), data);
}

function computePriceVerdict({ d7, d30, d90, last, minP, maxP, avgP, fromLow, fromHigh }) {
  const d7v = d7 ?? 0, d30v = d30 ?? 0, d90v = d90 ?? d30v;

  // CRASH: huge recent drop
  if (d30v < -25 || (d7v < -15 && d30v < -10)) {
    return {
      label: 'CRASH — RISKY',
      cls: 'ph-crash',
      summary: `Price has crashed <strong>${d30v.toFixed(1)}%</strong> over 30 days (7d: ${(d7v).toFixed(1)}%). May still be falling — wait for stabilisation before buying.`
    };
  }

  // BUY THE DIP: meaningful recent drop, near range low, longer-term up or flat
  if (d7v < -3 && fromHigh < -10 && fromLow < 15) {
    return {
      label: 'BUY THE DIP',
      cls: 'ph-buy-dip',
      summary: `Down <strong>${d7v.toFixed(1)}%</strong> in 7 days, sitting <strong>${fromHigh.toFixed(1)}%</strong> below the recent high — looks like a pullback rather than a trend reversal. Good entry if you like the card long-term.`
    };
  }

  // SPIKE: sharp recent rise — expensive
  if (d7v > 15 || (d7v > 8 && d30v > 20)) {
    return {
      label: 'SPIKE — OVERHEATED',
      cls: 'ph-spike',
      summary: `Up <strong>+${d7v.toFixed(1)}%</strong> in just 7 days. Often retraces 5–10% after a vertical move — consider waiting a week unless you must own it now.`
    };
  }

  // RIDING UP: steady uptrend
  if (d30v > 5 && d7v > -3) {
    return {
      label: 'RIDING UP',
      cls: 'ph-riding',
      summary: `Steady uptrend: <strong>+${d30v.toFixed(1)}%</strong> in 30 days. Momentum is in your favour but you're paying for it — fine to buy at market if conviction is high.`
    };
  }

  // COOLING: gentle drift down
  if (d30v < -5 && d7v < 0) {
    return {
      label: 'COOLING',
      cls: 'ph-cooling',
      summary: `Drifting down: <strong>${d30v.toFixed(1)}%</strong> over 30 days. No panic, but no rush — patient buyers may catch a better price.`
    };
  }

  // FLAT: no real movement
  return {
    label: 'FLAT',
    cls: 'ph-flat',
    summary: `Sideways action: ${d30v >= 0 ? '+' : ''}${d30v.toFixed(1)}% over 30 days. Market is balanced — you're paying close to fair value either way.`
  };
}

function drawPriceChart(canvas, data) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);
  if (data.length < 2) return;

  const pad = { l: 56, r: 18, t: 16, b: 26 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  // Convert raw USD prices to GBP for display
  const rates = data.map(d => d.raw * fxRate);
  const minP = Math.min(...rates);
  const maxP = Math.max(...rates);
  const span = Math.max(maxP - minP, 0.01);
  const yMin = minP - span * 0.10;
  const yMax = maxP + span * 0.10;

  function x(i) { return pad.l + (i / (data.length - 1)) * cw; }
  function y(v) { return pad.t + ch - ((v - yMin) / (yMax - yMin)) * ch; }

  // Gridlines + y-axis labels (4 horizontal divisions)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#777a8a';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const gy = pad.t + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    const val = yMax - ((yMax - yMin) / 4) * i;
    ctx.fillText('£' + val.toFixed(val < 10 ? 2 : 0), pad.l - 6, gy + 3);
  }

  // Filled area under curve (gradient)
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
  grad.addColorStop(0, 'rgba(232,182,52,0.25)');
  grad.addColorStop(1, 'rgba(232,182,52,0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x(0), pad.t + ch);
  data.forEach((d, i) => ctx.lineTo(x(i), y(d.raw * fxRate)));
  ctx.lineTo(x(data.length - 1), pad.t + ch);
  ctx.closePath();
  ctx.fill();

  // Price line
  ctx.strokeStyle = '#e8b634';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i), py = y(d.raw * fxRate);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Latest point marker
  const lastIdx = data.length - 1;
  const lx = x(lastIdx), ly = y(data[lastIdx].raw * fxRate);
  ctx.fillStyle = '#e8b634';
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(232,182,52,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(lx, ly, 8, 0, Math.PI * 2); ctx.stroke();

  // X-axis date labels (start, mid, end)
  ctx.fillStyle = '#777a8a';
  ctx.font = '10px Space Grotesk, sans-serif';
  ctx.textAlign = 'center';
  const labelIdx = [0, Math.floor(data.length / 2), data.length - 1];
  labelIdx.forEach(i => {
    if (data[i]) {
      const d = new Date(data[i].date);
      const label = d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
      ctx.fillText(label, x(i), H - 6);
    }
  });
}

// Range button handler (bound once on init)
function initPriceHistoryControls() {
  const ctr = $('phRange');
  if (!ctr || ctr.dataset.bound) return;
  ctr.dataset.bound = '1';
  ctr.addEventListener('click', (e) => {
    const btn = e.target.closest('.phr-btn');
    if (!btn) return;
    document.querySelectorAll('.phr-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    priceHistoryRange = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range);
    drawAndAnnotatePriceHistory();
  });
}

function drawListingChart(canvas, history) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const data = history.slice(-30);
  if (data.length < 2) return;

  const pad = { l: 36, r: 12, t: 10, b: 22 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  const active = data.map(d => d['active-to'] || 0);
  const soldEst = data.map(d => d['sold-est'] || 0);
  const newL = data.map(d => d['new'] || 0);
  const maxVal = Math.max(...active, 1) * 1.15;

  function x(i) { return pad.l + (i / (data.length - 1)) * cw; }
  function yLine(v) { return pad.t + ch - (v / maxVal) * ch; }

  ctx.strokeStyle = '#1e2030';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const gy = pad.t + (ch / 3) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
  }

  ctx.fillStyle = '#555768';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const val = maxVal * (1 - i / 3);
    ctx.fillText(Math.round(val).toString(), pad.l - 4, pad.t + (ch / 3) * i + 3);
  }

  const bw = Math.max(2, (cw / data.length) * 0.3);

  ctx.fillStyle = 'rgba(61, 214, 140, 0.5)';
  data.forEach((d, i) => {
    const v = d['sold-est'] || 0;
    const h = (v / maxVal) * ch;
    ctx.fillRect(x(i) - bw - 1, pad.t + ch - h, bw, h);
  });

  ctx.fillStyle = 'rgba(85, 87, 104, 0.5)';
  data.forEach((d, i) => {
    const v = d['new'] || 0;
    const h = (v / maxVal) * ch;
    ctx.fillRect(x(i) + 1, pad.t + ch - h, bw, h);
  });

  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  active.forEach((v, i) => {
    const px = x(i), py = yLine(v);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = '#555768';
  ctx.font = '9px Space Grotesk, sans-serif';
  ctx.textAlign = 'center';
  [0, Math.floor(data.length / 2), data.length - 1].forEach(i => {
    if (data[i]) {
      const d = data[i].date || '';
      const short = d.slice(5);
      ctx.fillText(short, x(i), H - 4);
    }
  });
}

// ---- Grading ROI ----
function renderGradingROI(apiData) {
  const section = $('gradeSection');
  const card = selectedCard;
  // Use PriceCharting PSA 10 data as fallback for JP cards (or any card with PC data)
  const pcPsa10 = livePrice && livePrice.pcPsa10 > 0 ? livePrice.pcPsa10 : 0;
  const staticPsa10 = card ? card.p10 : 0;
  const hasPsa10 = (staticPsa10 && staticPsa10 > 0) || pcPsa10 > 0;
  if (!card || !hasPsa10) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  const rawPrice = getCurrentPrice(card);
  const psa10Price = (staticPsa10 && staticPsa10 > 0) ? staticPsa10 : pcPsa10;
  const _eBayFx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const gradingFee = getUkGradingFeeGBP(psa10Price) / _eBayFx;

  // Use scan expected grade if available — no sight-unseen penalty for cards in hand
  const scanAcq = (typeof getAcq === 'function') ? getAcq(card.i) : null;
  const expectedGrade = scanAcq?.expectedGrade ?? null;
  const baseGemRate = (typeof card.g === 'number' && card.g > 0) ? card.g : DEFAULT_GEM_RATE;
  const gemPct = expectedGrade ? baseGemRate : (card.g || null);
  const gemRateDisplay = gemPct !== null ? (gemPct * 100).toFixed(1) : null;

  const valueGain = psa10Price - rawPrice;
  const roi = ((valueGain - gradingFee) / (rawPrice + gradingFee)) * 100;
  const netProfit = valueGain - gradingFee;
  const multiplier = psa10Price / rawPrice;

  // Grade-9 downside: what the card returns if it misses the gem. Negative
  // means a 9 is worth less than keeping it raw once fees are in.
  const pcPsa9 = livePrice && livePrice.pcPsa9 > 0 ? livePrice.pcPsa9 : 0;
  const psa9Price = pcPsa9 || estimateGradePrice(card, 9, psa10Price);
  const net9 = psa9Price > 0 ? psa9Price - rawPrice - gradingFee : null;
  const nineCaveat = net9 === null ? '' : net9 < 0
    ? ` · a 9 loses ${fmtGBP(-net9)} — raw keeps more value unless it gems`
    : ` · even a 9 clears +${fmtGBP(net9)}`;

  // If scan gives an expected grade, compute that grade's realistic EV
  let scanRow = '';
  if (expectedGrade) {
    const scanTargetPrice = psa10Price * (PSA_RATIOS[expectedGrade] || 1);
    const scanGain = scanTargetPrice - rawPrice - gradingFee;
    const scanRoi = ((scanTargetPrice - rawPrice - gradingFee) / (rawPrice + gradingFee) * 100).toFixed(0);
    const scanCls = scanGain >= 0 ? 'grade-gain' : 'grade-loss';
    const scanGradeLabel = PSA_GRADE_LABELS?.[expectedGrade] || '';
    scanRow = `<div class="grade-row grade-row-scan"><span class="grade-label">Scan target (PSA ${expectedGrade} · ${scanGradeLabel})</span><span class="grade-val ${scanCls}">${scanGain >= 0 ? '+' : ''}${fmtGBP(scanGain)} (${scanRoi}% ROI)</span></div>`;
  }

  // EV across outcomes using gem rate
  let evNote = '';
  if (gemPct !== null) {
    const evGrade = (gemPct * (psa10Price - gradingFee)) + ((1 - gemPct) * (rawPrice * 0.85 - gradingFee));
    const evRoi = ((evGrade - rawPrice) / rawPrice * 100).toFixed(0);
    evNote = `<div class="grade-row"><span class="grade-label">EV across outcomes</span><span class="grade-val">${fmtGBP(evGrade)} (${evRoi > 0 ? '+' : ''}${evRoi}% ROI at ${gemRateDisplay}% gem rate)</span></div>`;
  }

  let verdictClass, verdictTitle, verdictDetail;
  if (roi > 100 && (gemPct === null || gemPct > 0.3)) {
    verdictClass = 'grade-worth';
    verdictTitle = 'Worth Grading';
    verdictDetail = `${multiplier.toFixed(1)}× raw-to-PSA 10 multiplier${netProfit > 0 ? ` · ${fmtGBP(netProfit)} potential profit` : ''}${nineCaveat}`;
  } else if (roi > 30 && net9 !== null && net9 < 0) {
    verdictClass = 'grade-maybe';
    verdictTitle = 'Gem-or-Bust — Raw Holds Value';
    verdictDetail = `Pays only at a PSA 10 — a 9 loses ${fmtGBP(-net9)}, so keeping it raw is the better option unless the card is flawless`;
  } else if (roi > 30) {
    verdictClass = 'grade-maybe';
    verdictTitle = 'Consider Grading';
    verdictDetail = (gemRateDisplay ? `${gemRateDisplay}% gem rate — profitable if it hits PSA 10` : `${multiplier.toFixed(1)}× multiplier — check gem rate first`) + nineCaveat;
  } else {
    verdictClass = 'grade-skip';
    verdictTitle = 'Skip Grading';
    verdictDetail = `Only ${multiplier.toFixed(1)}× multiplier — not enough margin after fees`;
  }

  const nineRow = net9 === null ? '' :
    `<div class="grade-row"><span class="grade-label">Net profit (if PSA 9)</span><span class="grade-val ${net9 > 0 ? 'grade-gain' : 'grade-loss'}">${net9 > 0 ? '+' : ''}${fmtGBP(net9)}</span></div>`;

  $('gradeContent').innerHTML = `
    <div class="grade-row"><span class="grade-label">Raw price</span><span class="grade-val">${fmtGBP(rawPrice)}</span></div>
    <div class="grade-row"><span class="grade-label">PSA 10 price</span><span class="grade-val grade-gain">${fmtGBP(psa10Price)}</span></div>
    <div class="grade-row"><span class="grade-label">Net profit (if PSA 10)</span><span class="grade-val ${netProfit > 0 ? 'grade-gain' : 'grade-loss'}">${netProfit > 0 ? '+' : ''}${fmtGBP(netProfit)} (${multiplier.toFixed(1)}×)</span></div>
    ${nineRow}
    ${scanRow}
    ${evNote}
    <div class="grade-verdict ${verdictClass}">
      <div class="grade-verdict-title">${verdictTitle}</div>
      <div class="grade-verdict-detail">${verdictDetail}</div>
    </div>
  `;
}

// ---- ACE Grading ----
const ACE_FEE_STANDARD_GBP = 18;
const ACE_FEE_EXPRESS_GBP  = 35;
const ACE_FEE_SHIPPING_GBP = 7.99;
const ACE_FEE_LABEL_GBP    = 3;
const ACE_PRICES_KEY = 'pkm-ace-prices-v1';

function _getAceStore() {
  try { return JSON.parse(localStorage.getItem(ACE_PRICES_KEY) || '{}'); } catch { return {}; }
}
function getAcePrices(cardId) { return _getAceStore()[cardId] || {}; }
function saveAcePrice(cardId, grade, gbp) {
  const store = _getAceStore();
  if (!store[cardId]) store[cardId] = {};
  if (gbp > 0) store[cardId][grade] = gbp; else delete store[cardId][grade];
  localStorage.setItem(ACE_PRICES_KEY, JSON.stringify(store));
}

function renderAceGradingSection() {
  const section = $('aceGradeSection');
  const card = selectedCard;
  if (!card) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const rawGBP = usdToGbp(getCurrentPrice(card));
  // Total ACE cost basis: grading + outbound shipping + premium label
  const aceFeeTotal = ACE_FEE_STANDARD_GBP + ACE_FEE_SHIPPING_GBP + ACE_FEE_LABEL_GBP;
  const psaFeeGBP   = 65;  // PSA standard UK (incl. transatlantic shipping estimate)
  const saved = getAcePrices(card.i);

  // PC-sourced prices for each ACE grade (GBP). pcAce9/8/7 are often 0 — we
  // estimate them from PSA grade ratios if the specific ACE grade is missing.
  const lp = livePrice || {};
  const pcAce  = [10, 9, 8, 7].map(g => {
    const field = `pcAce${g}`;
    const usd = lp[field] || 0;
    if (usd > 0) return usdToGbp(usd);
    // Fallback: derive from PSA peer grade if available
    const psaField = g === 10 ? 'pcPsa10' : `pcPsa${g}`;
    const psaUsd = lp[psaField] || (g === 9 ? lp.pcGrade9 : 0) || 0;
    // ACE typically trades at ~75–85% of equivalent PSA for popular cards
    return psaUsd > 0 ? usdToGbp(psaUsd * 0.80) : 0;
  });
  // [idx0=grade10, idx1=grade9, idx2=grade8, idx3=grade7]
  const pcAceByGrade = { 10: pcAce[0], 9: pcAce[1], 8: pcAce[2], 7: pcAce[3] };

  // PSA PC prices for comparison column
  const psaByGrade = {
    10: usdToGbp(lp.pcPsa10  || 0),
    9:  usdToGbp(lp.pcPsa9   || lp.pcGrade9 || 0),
    8:  usdToGbp(lp.pcPsa8   || 0),
    7:  usdToGbp(lp.pcPsa7   || 0),
  };
  const hasPcData = pcAce[0] > 0;

  // Live ACE 10 market price strip (shown when PC data available)
  const liveStripEl = $('aceLiveStrip');
  if (liveStripEl) {
    if (pcAceByGrade[10] > 0 || psaByGrade[10] > 0) {
      const ace10disp = pcAceByGrade[10] > 0
        ? `<span class="ace-live-v">${fmtGBPDirect(pcAceByGrade[10])}</span>`
        : `<span class="ace-live-v" style="color:var(--text-muted);font-size:12px">—</span>`;
      const psa10disp = psaByGrade[10] > 0
        ? `<div class="ace-live-item"><span class="ace-live-k">PSA 10 (PC)</span><span class="ace-live-v" style="color:var(--text-muted);font-size:12px">${fmtGBPDirect(psaByGrade[10])}</span></div><span class="ace-live-sep">·</span>` : '';
      liveStripEl.style.display = '';
      liveStripEl.innerHTML =
        `<div class="ace-live-item"><span class="ace-live-k">ACE 10 (PC live)</span>${ace10disp}</div>` +
        `<span class="ace-live-sep">·</span>` +
        psa10disp +
        `<div class="ace-live-item"><span class="ace-live-k">Raw market</span><span class="ace-live-v ace-live-raw">${fmtGBPDirect(rawGBP)}</span></div>`;
    } else {
      liveStripEl.style.display = 'none';
    }
  }

  // Batch shipping note
  const batchNoteEl = $('aceBatchNote');
  if (batchNoteEl) {
    batchNoteEl.innerHTML = `£${ACE_FEE_SHIPPING_GBP.toFixed(2)} shipping covers your entire submission regardless of how many cards — the more you batch, the lower the cost per card (e.g. 5 cards = £${(ACE_FEE_SHIPPING_GBP / 5).toFixed(2)}/card).`;
  }

  // Fee strip
  $('aceFeeStrip').innerHTML =
    `<span class="ace-fee-item"><span class="ace-fee-k">Standard</span><span class="ace-fee-v">£${ACE_FEE_STANDARD_GBP}</span></span>` +
    `<span class="ace-fee-sep">·</span>` +
    `<span class="ace-fee-item"><span class="ace-fee-k">Express</span><span class="ace-fee-v">£${ACE_FEE_EXPRESS_GBP}</span></span>` +
    `<span class="ace-fee-sep">·</span>` +
    `<span class="ace-fee-item"><span class="ace-fee-k">Shipping</span><span class="ace-fee-v">£${ACE_FEE_SHIPPING_GBP.toFixed(2)}</span></span>` +
    `<span class="ace-fee-sep">·</span>` +
    `<span class="ace-fee-item"><span class="ace-fee-k">Premium label</span><span class="ace-fee-v">£${ACE_FEE_LABEL_GBP}</span></span>` +
    `<span class="ace-fee-sep">·</span>` +
    `<span class="ace-fee-item"><span class="ace-fee-k">Return</span><span class="ace-fee-v ace-domestic">Free (UK domestic)</span></span>`;

  // Per-grade rows — value comes from saved > PC suggestion > blank
  const grades = [10, 9, 8, 7];
  const pcSourceLabel = hasPcData
    ? `<span class="ace-pc-badge" title="Price from PriceCharting recent sales">PC</span>`
    : '';
  const rows = grades.map(g => {
    const manualPrice  = saved[g] || 0;
    const pcSuggested  = pcAceByGrade[g] || 0;
    // Use manual saved value if present, else PC suggestion
    const displayPrice = manualPrice > 0 ? manualPrice : pcSuggested;
    const isFromPC     = manualPrice <= 0 && pcSuggested > 0;
    const isEstimated  = isFromPC && !(lp[`pcAce${g}`] > 0);  // derived, not direct
    const cardName = card.n.replace(/[™®]/g, '').trim();
    const cardNum  = card.num ? ' ' + card.num : '';
    const q = `${cardName}${cardNum} ACE ${g}`;
    const ebayUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&LH_TitleDesc=0&_sacat=2536`;

    const effectivePrice = manualPrice > 0 ? manualPrice : pcSuggested;
    const profit = effectivePrice > 0 ? effectivePrice - rawGBP - aceFeeTotal : null;
    const roi    = profit !== null ? Math.round(profit / (rawGBP + aceFeeTotal) * 100) : null;
    const profitCls = profit === null ? '' : profit >= 0 ? 'ace-pos' : 'ace-neg';
    const profitStr = profit === null
      ? '<span class="ace-profit-empty">enter price →</span>'
      : `<span class="${profitCls}">${profit >= 0 ? '+' : ''}${fmtGBPDirect(profit)}</span><span class="ace-roi ${profitCls}">${roi > 0 ? '+' : ''}${roi}%</span>`;

    const inputVal = displayPrice > 0 ? displayPrice.toFixed(2) : '';
    const pcBadge  = isFromPC ? `<span class="ace-pc-tag" title="${isEstimated ? 'Estimated from PSA data' : 'From PriceCharting'}">${isEstimated ? '~PC' : 'PC'}</span>` : '';
    return `<div class="ace-row" data-grade="${g}">
      <span class="ace-grade-lbl">ACE ${g}</span>
      <div class="ace-input-wrap">${pcBadge}<span class="ace-sym">£</span><input type="number" class="ace-input" data-grade="${g}" min="0" step="0.01" placeholder="—" value="${inputVal}" ${isFromPC ? 'data-pc-suggested="1"' : ''}></div>
      <a class="ace-ebay" href="${ebayUrl}" target="_blank" rel="noopener noreferrer">eBay ↗</a>
      <div class="ace-profit-wrap">${profitStr}</div>
    </div>`;
  }).join('');

  $('aceTable').innerHTML =
    `<div class="ace-table-hd"><span>Grade</span><span>Market price${hasPcData ? ' <span class="ace-pc-hd-badge">PC</span>' : ''}</span><span></span><span>Profit · ROI (std fee)</span></div>` +
    rows;

  // Wire inputs — on change, persist and re-render
  $('aceTable').querySelectorAll('.ace-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const g   = parseInt(inp.dataset.grade);
      const val = parseFloat(inp.value) || 0;
      saveAcePrice(card.i, g, val);
      renderAceGradingSection();
    });
  });

  // ── 3-way comparison: RAW vs ACE vs PSA ──────────────────────────────────
  const verdictEl = $('aceVerdict');

  // Effective ACE 10 price: manual first, then PC
  const ace10 = saved[10] > 0 ? saved[10] : pcAceByGrade[10];
  // PSA 10 from PC
  const psa10 = psaByGrade[10];

  if (ace10 <= 0 && psa10 <= 0) { verdictEl.style.display = 'none'; return; }

  const aceProfit  = ace10 > 0 ? ace10 - rawGBP - aceFeeTotal : null;
  const aceRoi     = aceProfit !== null ? Math.round(aceProfit / (rawGBP + aceFeeTotal) * 100) : null;
  const psaProfit  = psa10 > 0 ? psa10 - rawGBP - psaFeeGBP  : null;
  const psaRoi     = psaProfit !== null ? Math.round(psaProfit / (rawGBP + psaFeeGBP)  * 100) : null;

  // Pick winner
  const options = [];
  if (aceProfit !== null) options.push({ name: 'ACE', profit: aceProfit, roi: aceRoi });
  if (psaProfit !== null) options.push({ name: 'PSA', profit: psaProfit, roi: psaRoi });
  // RAW hold is always valid: profit = 0, roi = 0 (baseline)
  options.push({ name: 'RAW', profit: 0, roi: 0 });
  options.sort((a, b) => b.profit - a.profit);
  const winner = options[0];

  // Comparison rows
  const fmtOption = (label, price, profit, roi, isWinner) => {
    if (price === null || price <= 0) return '';
    const cls   = profit >= 0 ? 'ace-pos' : 'ace-neg';
    const roiStr = roi !== null ? `${roi > 0 ? '+' : ''}${roi}%` : '';
    const winBadge = isWinner ? ' <span class="ace-win-badge">best</span>' : '';
    return `<div class="ace-vs-row ${isWinner ? 'ace-vs-winner' : ''}">
      <span class="ace-vs-label">${label}${winBadge}</span>
      <span class="ace-vs-price">${fmtGBPDirect(price)}</span>
      <span class="ace-vs-profit ${cls}">${profit >= 0 ? '+' : ''}${fmtGBPDirect(profit)}</span>
      <span class="ace-vs-roi ${cls}">${roiStr}</span>
    </div>`;
  };

  const rawRow = `<div class="ace-vs-row ${winner.name === 'RAW' ? 'ace-vs-winner' : ''}">
    <span class="ace-vs-label">RAW${winner.name === 'RAW' ? ' <span class="ace-win-badge">best</span>' : ''}</span>
    <span class="ace-vs-price">${fmtGBPDirect(rawGBP)}</span>
    <span class="ace-vs-profit">—</span>
    <span class="ace-vs-roi" style="color:var(--text-muted)">hold</span>
  </div>`;

  const aceRow = ace10 > 0
    ? fmtOption('ACE 10', ace10, aceProfit, aceRoi, winner.name === 'ACE')
    : '';
  const psaRow = psa10 > 0
    ? fmtOption('PSA 10', psa10, psaProfit, psaRoi, winner.name === 'PSA')
    : '';

  // Grade-9 downside per service: if a 9 comes back under the raw value plus
  // fees, the winning service only pays at a 10 — raw keeps more value.
  const ace9val    = saved[9] > 0 ? saved[9] : (pcAceByGrade[9] || 0);
  const psa9val    = psaByGrade[9] || 0;
  const ace9Profit = ace9val > 0 ? ace9val - rawGBP - aceFeeTotal : null;
  const psa9Profit = psa9val > 0 ? psa9val - rawGBP - psaFeeGBP  : null;
  const nine3Note = p => p === null ? '' : p < 0
    ? ` · but a 9 loses ${fmtGBPDirect(-p)} — keep raw unless confident of a 10`
    : ` · even a 9 clears +${fmtGBPDirect(p)}`;

  // Overall verdict
  let verdict3cls, verdict3title, verdict3detail;
  if (winner.name === 'ACE' && aceProfit >= 0) {
    const gemOnly = ace9Profit !== null && ace9Profit < 0;
    verdict3cls   = gemOnly ? 'ace-maybe' : 'ace-worth';
    verdict3title = gemOnly ? 'ACE pays only at a 10 — raw holds value' : 'Grade with ACE';
    verdict3detail = `ACE 10 is the best exit: +${fmtGBPDirect(aceProfit)} (${aceRoi}% ROI) · Total fees £${aceFeeTotal.toFixed(2)} · PSA would need £${(rawGBP + psaFeeGBP).toFixed(0)} to break even${nine3Note(ace9Profit)}`;
  } else if (winner.name === 'PSA' && psaProfit >= 0) {
    const gemOnly = psa9Profit !== null && psa9Profit < 0;
    verdict3cls   = gemOnly ? 'ace-maybe' : 'ace-worth';
    verdict3title = gemOnly ? 'PSA pays only at a 10 — raw holds value' : 'Grade with PSA';
    verdict3detail = `PSA 10 outperforms ACE on this card: +${fmtGBPDirect(psaProfit)} (${psaRoi}% ROI) · Worth the higher £${psaFeeGBP} fee${nine3Note(psa9Profit)}`;
  } else if ((aceProfit !== null && aceProfit > 0) || (psaProfit !== null && psaProfit > 0)) {
    verdict3cls   = 'ace-maybe';
    verdict3title = 'Marginal — grade only if mint';
    verdict3detail = `Grading is barely profitable — only worthwhile if the card is likely to gem`;
  } else {
    verdict3cls   = 'ace-skip';
    verdict3title = 'Hold raw';
    verdict3detail = `Neither ACE nor PSA grading covers fees at current market prices — raw hold is the best option`;
  }

  const pcNote = hasPcData
    ? `<div class="ace-pc-note">Prices from PriceCharting recent sales · ACE 9/8/7 estimated where no direct PC data</div>`
    : `<div class="ace-pc-note">Enter ACE sold prices from eBay above to enable the comparison</div>`;

  verdictEl.style.display = '';
  verdictEl.innerHTML = `
    <div class="ace-vs-table">
      <div class="ace-vs-hd"><span>Option</span><span>Grade value</span><span>Profit</span><span>ROI</span></div>
      ${aceRow}${psaRow}${rawRow}
    </div>
    <div class="ace-verdict-inner ${verdict3cls}" style="margin-top:10px">
      <div class="ace-verdict-title">${verdict3title}</div>
      <div class="ace-verdict-detail">${verdict3detail}</div>
    </div>
    ${pcNote}`;

  // ── Bundle recommendation ──────────────────────────────────────────────────
  // Scan portfolio for other cards that also pass the ACE profitability bar,
  // so the user knows whether to send this card alone or batch it.
  const bundleEl = $('aceBundleNote');
  if (bundleEl && portfolio.length > 0) {
    const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
    const bundlePicks = portfolio.map(p => {
      if (p.id === card.i) return null;
      const dbC = getCardById(p.id);
      if (!dbC) return null;
      const cached = getCachedPrice(p.id);
      let ace10GBP = 0;
      if (cached?.pcAce10 > 0) {
        ace10GBP = cached.pcAce10 * fx;
      } else {
        const psa10USD = cached?.pcPsa10 || dbC.p10 || 0;
        if (psa10USD > 0) ace10GBP = psa10USD * fx * 0.80;
      }
      if (ace10GBP <= 0) return null;
      const rawC = (cached?.pcUngraded > 0 ? cached.pcUngraded * fx : 0)
                || p.addedPriceGBP
                || (p.price ? p.price * fx : 0);
      if (rawC <= 0) return null;
      const profit = ace10GBP - rawC - ACE_FEE_STANDARD_GBP - ACE_FEE_LABEL_GBP - ACE_FEE_SHIPPING_GBP;
      if (profit <= 0) return null;
      return { name: dbC.n, set: dbC.s };
    }).filter(Boolean);

    if (bundlePicks.length > 0) {
      const total = bundlePicks.length + 1;  // include current card
      const perCard = (ACE_FEE_SHIPPING_GBP / total).toFixed(2);
      const names = bundlePicks.map(p => `<span class="ace-bundle-card">${p.name}</span>`).join(', ');
      bundleEl.style.display = '';
      bundleEl.innerHTML =
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>` +
        `<span><strong>Bundle opportunity:</strong> ${bundlePicks.length} other card${bundlePicks.length > 1 ? 's' : ''} in your collection ${bundlePicks.length > 1 ? 'are' : 'is'} also worth ACE grading — ` +
        `send all ${total} together to reduce shipping to <strong>~£${perCard}/card</strong>: ${names}</span>`;
    } else {
      bundleEl.style.display = '';
      bundleEl.innerHTML =
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` +
        `<span>No other cards in your collection currently pass the ACE profit bar — send this alone or wait to batch with future picks to share the £${ACE_FEE_SHIPPING_GBP.toFixed(2)} shipping.</span>`;
    }
  } else if (bundleEl) {
    bundleEl.style.display = 'none';
  }
}

// ---- Market-Adjusted Forecast ----
function getMarketMomentum() {
  if (!marketData) return { mult: 1.0, label: '' };
  const mp = marketData.collectrics?.['market-pressure'];
  if (!mp) return { mult: 1.0, label: '' };

  const est = mp.estimated || mp.observed;
  const baseline = est?.['baseline-comparison'];
  if (!baseline) return { mult: 1.0, label: '' };

  const trend = baseline.trend || 'stable';
  const ssi = baseline['supply-saturation-index'] ?? 1.0;
  const dpDelta = baseline['demand-delta-pct'] ?? 0;

  let mult = 1.0;
  let label = '';

  if (trend.includes('heat') || trend.includes('hot') || trend.includes('tighten') || (ssi < 0.8 && dpDelta > 0.1)) {
    mult = 1.25; label = 'Market heating — boosted near-term';
  } else if (trend.includes('cool') || trend.includes('cold') || (ssi > 1.3 && dpDelta < -0.1)) {
    mult = 0.7; label = 'Market cooling — dampened near-term';
  } else if (trend.includes('loosen') || ssi > 1.15) {
    mult = 0.85; label = 'Supply loosening — slightly dampened';
  } else if (ssi < 0.9) {
    mult = 1.1; label = 'Supply tightening slightly';
  }

  return { mult, label };
}

// ---- Portfolio ----
function setupPortfolio() {
  $('portfolioToggle').addEventListener('click', togglePortfolio);
  $('portfolioClose').addEventListener('click', () => { $('portfolioPanel').style.display = 'none'; });
  $('addPortfolioBtn').addEventListener('click', toggleCardInPortfolio);

  const refreshBtn = $('portfolioRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const ids = portfolio.map(p => p.id).filter(Boolean);
      if (!ids.length || _psState.running) return;
      refreshBtn.disabled = true;
      const orig = refreshBtn.innerHTML;
      refreshBtn.textContent = '⟳ Refreshing…';
      try {
        await psBatchRefresh(ids, 'Refresh collection prices');
        renderPortfolio();
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = orig;
      }
    });
  }

  // Delegated listeners — wired once so renderPortfolio() can skip re-attaching.
  const list = $('portfolioList');
  if (list) {
    list.addEventListener('click', e => {
      if (e.target.closest('.pi-toggle')) return;
      const removeBtn = e.target.closest('.portfolio-item-remove');
      if (removeBtn) {
        e.stopPropagation();
        portfolio = portfolio.filter(p => p.id !== removeBtn.dataset.id);
        savePortfolio(); renderPortfolio(); updatePortfolioButton();
        return;
      }
      const item = e.target.closest('.portfolio-item');
      if (item) selectCard(item.dataset.id);
    });
  }

  renderPortfolio();
}

function togglePortfolio() {
  const panel = $('portfolioPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function toggleCardInPortfolio() {
  if (!selectedCard) return;
  const btn = $('addPortfolioBtn');
  // Guard: a second tap within 700ms would toggle the card right back off.
  // Users tap again thinking the first tap didn't register because
  // updatePortfolioButton() used to run after the slow renderPortfolio() call.
  if (btn) {
    if (btn._toggling) return;
    btn._toggling = true;
    setTimeout(() => { if (btn) btn._toggling = false; }, 700);
  }
  const idx = portfolio.findIndex(p => p.id === selectedCard.i);
  if (idx >= 0) {
    portfolio.splice(idx, 1);
  } else {
    portfolio.push({
      id: selectedCard.i,
      name: selectedCard.n,
      set: selectedCard.s,
      img: getCardImg(selectedCard),
      price: getCurrentPrice(selectedCard),
      addedDate: new Date().toISOString(),
      addedPriceGBP: usdToGbp(getCurrentPrice(selectedCard)),
    });
  }
  try { savePortfolio(); } catch (e) { console.warn('[portfolio] save failed', e); }
  updatePortfolioButton(); // immediate visual feedback — runs before the slow render
  requestAnimationFrame(() => {
    try { renderPortfolio(); } catch (e) { console.warn('[portfolio] render failed', e); }
  });
}

function updatePortfolioButton() {
  const btn = $('addPortfolioBtn');
  if (!selectedCard) return;
  const inPortfolio = portfolio.some(p => p.id === selectedCard.i);
  btn.classList.toggle('in-portfolio', inPortfolio);
  btn.title = inPortfolio ? 'Remove from collection' : 'Add to collection';
}

function savePortfolio() {
  try { localStorage.setItem('pkm-portfolio', JSON.stringify(portfolio)); } catch (e) { console.warn('[portfolio] localStorage write failed', e); }
  _recoCached = null;
}

// ---- Layout drag-resize ----
const LAYOUT_KEY      = 'pkm-layout-v1';       // device-local, NOT in SYNC_KEYS
const DUPE_DISMISS_KEY = 'pkm-dupe-dismissed-v1'; // dismissed duplicate/counterpart pairs

function initLayoutResizer() {
  const main = document.querySelector('.main');
  const colResizer = document.getElementById('colResizer');
  if (!main) return;
  const isDesktop = window.innerWidth >= 1024;

  // ── Restore or auto-fit ──────────────────────────────────────────────
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch { return null; } })();

  if (saved) {
    // Column split is intentionally NOT restored — it resets to 50/50 (CSS default)
    // on every load so a narrow column saved on one device/session never breaks
    // the layout on another. Users can still drag-to-resize within a session.
    if (saved.tiles) {
      Object.entries(saved.tiles).forEach(([key, h]) => {
        const el = document.getElementById(key) || document.querySelector(`[data-layout-id="${key}"]`);
        if (!el) return;
        if (h.startsWith('clamp:')) {
          el.style.maxHeight = h.slice(6);
          el.style.overflow = 'hidden';
          el.classList.add('is-clamped');
        } else {
          el.style.minHeight = h;
        }
      });
    }
  }
  // Auto-label sections without IDs
  let auto = 0;
  document.querySelectorAll('.inputs-column > .card, .output-column > .card').forEach(c => {
    if (!c.id && !c.dataset.layoutId) c.dataset.layoutId = `lt${auto++}`;
  });

  // ── Column resizer (desktop only) ────────────────────────────────────
  function applyColSplit(pct, save = true) {
    const clamped = Math.min(0.78, Math.max(0.22, pct));
    const l = clamped * 2, r = (1 - clamped) * 2;
    main.style.gridTemplateColumns = `minmax(0, ${l}fr) 20px minmax(0, ${r}fr)`;
    // Position the resizer bar at the visual boundary between columns
    requestAnimationFrame(() => {
      const inCol = document.querySelector('.inputs-column');
      if (!inCol) return;
      const mRect = main.getBoundingClientRect();
      const cRect = inCol.getBoundingClientRect();
      const xPos = (cRect.right - mRect.left) + (cRect.right < mRect.right ? 10 : 0);
      colResizer.style.left = xPos + 'px';
    });
    if (save) saveLayout();
  }

  // Position handle on init / window resize
  function positionColResizer() {
    if (!colResizer) return;
    const inCol = document.querySelector('.inputs-column');
    if (!inCol) return;
    const mRect = main.getBoundingClientRect();
    const cRect = inCol.getBoundingClientRect();
    colResizer.style.left = (cRect.right - mRect.left + 10) + 'px';
  }
  if (isDesktop && colResizer) {
    requestAnimationFrame(positionColResizer);
    window.addEventListener('resize', positionColResizer, { passive: true });
  }

  let colDragStartX = 0, colDragStartPct = 0.5;

  function getColPct() {
    const cols = getComputedStyle(main).gridTemplateColumns.split(' ');
    const leftW = parseFloat(cols[0]) || 0;
    const rightW = parseFloat(cols[2]) || 0;
    return (leftW + rightW) > 0 ? leftW / (leftW + rightW) : 0.5;
  }

  if (colResizer) colResizer.addEventListener('mousedown', e => {
    e.preventDefault();
    colDragStartX = e.clientX;
    colDragStartPct = getColPct();
    const mainW = main.getBoundingClientRect().width; // cache once per drag
    colResizer.classList.add('is-dragging');
    document.body.classList.add('layout-resizing');
    const onMove = (e) => {
      const dx = e.clientX - colDragStartX;
      applyColSplit(colDragStartPct + dx / mainW);
    };
    const onUp = () => {
      colResizer.classList.remove('is-dragging');
      document.body.classList.remove('layout-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayout();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Touch support for column resizer
  if (colResizer) colResizer.addEventListener('touchstart', e => {
    e.preventDefault();
    colDragStartX = e.touches[0].clientX;
    colDragStartPct = getColPct();
    const mainW = main.getBoundingClientRect().width; // cache once per drag
    colResizer.classList.add('is-dragging');
    document.body.classList.add('layout-resizing');
    const onMove = (e) => {
      const dx = e.touches[0].clientX - colDragStartX;
      applyColSplit(colDragStartPct + dx / mainW);
    };
    const onEnd = () => {
      colResizer.classList.remove('is-dragging');
      document.body.classList.remove('layout-resizing');
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      saveLayout();
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }, { passive: false });

  // Double-click col-resizer: reset to 50/50
  if (isDesktop && colResizer) colResizer.addEventListener('dblclick', () => {
    main.style.gridTemplateColumns = '';
    saveLayout();
    requestAnimationFrame(positionColResizer);
  });

  // ── Tile resizers (all screen sizes) ─────────────────────────────────
  function resetTileClamp(card) {
    card.style.maxHeight = '';
    card.style.overflow = '';
    card.style.minHeight = '';
    card.classList.remove('is-clamped');
  }

  function updateShowMore(card) {
    const btn = card._showMoreBtn;
    if (!btn) return;
    const isClipped = card.classList.contains('is-clamped') && card.scrollHeight > card.clientHeight + 4;
    btn.style.display = isClipped ? '' : 'none';
  }

  function addTileHandles() {
    document.querySelectorAll('.inputs-column > .card, .output-column > .card').forEach(card => {
      if (card.querySelector('.tile-resizer')) return; // already added

      // Show-more button sits after the card as a flex sibling
      if (!card._showMoreBtn) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tile-show-more';
        btn.textContent = '↓ Show more';
        btn.style.display = 'none';
        card.insertAdjacentElement('afterend', btn);
        card._showMoreBtn = btn;
        btn.addEventListener('click', () => {
          resetTileClamp(card);
          updateShowMore(card);
          saveLayout();
        });
      }
      // Check initial clamped state (restored from saved layout)
      requestAnimationFrame(() => updateShowMore(card));

      const handle = document.createElement('div');
      handle.className = 'tile-resizer';
      handle.title = 'Drag to resize · Double-click to reset';
      card.appendChild(handle);

      let startY = 0, startH = 0, naturalH = 0;

      function startDrag(clientY) {
        startY = clientY;
        startH = card.getBoundingClientRect().height;
        // Measure natural (unclamped) content height
        const prevMax = card.style.maxHeight, prevOv = card.style.overflow;
        card.style.maxHeight = 'none'; card.style.overflow = 'visible';
        naturalH = card.scrollHeight;
        card.style.maxHeight = prevMax; card.style.overflow = prevOv;
        handle.classList.add('is-dragging');
        document.body.classList.add('layout-resizing', 'tile-resizing');
      }
      function onMove(clientY) {
        const newH = Math.max(60, startH + (clientY - startY));
        if (newH < naturalH - 8) {
          card.style.maxHeight = newH + 'px';
          card.style.minHeight = '';
          card.style.overflow = 'hidden';
          card.classList.add('is-clamped');
        } else {
          card.style.minHeight = newH + 'px';
          card.style.maxHeight = '';
          card.style.overflow = '';
          card.classList.remove('is-clamped');
        }
      }
      function endDrag() {
        handle.classList.remove('is-dragging');
        document.body.classList.remove('layout-resizing', 'tile-resizing');
        updateShowMore(card);
        saveLayout();
      }

      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        startDrag(e.clientY);
        const onMoveDoc = e => onMove(e.clientY);
        const onUp = () => { endDrag(); document.removeEventListener('mousemove', onMoveDoc); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMoveDoc);
        document.addEventListener('mouseup', onUp);
      });
      handle.addEventListener('touchstart', e => {
        e.preventDefault();
        startDrag(e.touches[0].clientY);
        const onMoveDoc = e => onMove(e.touches[0].clientY);
        const onEnd = () => { endDrag(); document.removeEventListener('touchmove', onMoveDoc); document.removeEventListener('touchend', onEnd); };
        document.addEventListener('touchmove', onMoveDoc, { passive: false });
        document.addEventListener('touchend', onEnd);
      }, { passive: false });
      handle.addEventListener('dblclick', () => {
        resetTileClamp(card);
        updateShowMore(card);
        saveLayout();
      });
    });
  }
  addTileHandles();

  // Re-run when new sections become visible (e.g. card selection shows selectedCardSection)
  const tileObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'style') addTileHandles();
    }
  });
  document.querySelectorAll('.inputs-column > .card, .output-column > .card').forEach(c => {
    tileObserver.observe(c, { attributes: true, attributeFilter: ['style'] });
  });

  // ── Save / restore helpers ───────────────────────────────────────────
  function saveLayout() {
    const tiles = {};
    document.querySelectorAll('.inputs-column > .card, .output-column > .card').forEach(c => {
      const key = c.id || c.dataset.layoutId;
      if (!key) return;
      if (c.style.maxHeight) tiles[key] = `clamp:${c.style.maxHeight}`;
      else if (c.style.minHeight) tiles[key] = c.style.minHeight;
    });
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tiles })); } catch {}
  }

  // Expose applyColSplit so re-renders can call positionColResizer
  window._layoutResizer = { reposition: positionColResizer };
}

// ---- Collection ROI chart ----
function renderRoiChart() {
  const section = document.getElementById('portfolioRoiSection');
  const summaryRow = document.getElementById('roiSummaryRow');
  const canvas = document.getElementById('roiCanvas');
  const legendEl = document.getElementById('roiLegend');
  if (!section || !summaryRow || !canvas) return;

  // Build per-card data
  const rows = [];
  for (const p of portfolio) {
    const cost = getAcqCostBasisGBP(p.id);
    if (!cost) continue;
    const acq = getAcq(p.id);
    const card = getCardById(p.id);
    if (!card) continue;

    // Model value: derive pull cost from card rarity, use autoFill desirability
    const pull = (function () {
      try {
        if (setsData && setsData[card.sc]) {
          const set = setsData[card.sc];
          const rarity = set.rarities?.[card.rc];
          if (rarity && rarity.pullRate > 0) return (Math.round(1 / rarity.pullRate) * rarity.count) / 100;
        }
      } catch {}
      return 7.65;
    })();
    const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pull).total : 50;
    const { priceUSD } = predictPrice(pull, des);
    const modelGBP = usdToGbp(priceUSD);
    const roi = ((modelGBP - cost) / cost) * 100;

    rows.push({
      name: card.n,
      source: acq?.source || 'single',
      ts: acq?.ts || (p.addedDate ? new Date(p.addedDate).getTime() : 0),
      cost,
      modelGBP,
      roi,
    });
  }

  if (rows.length === 0) {
    summaryRow.innerHTML = '<p class="roi-empty">No acquisition data yet — log how you obtained cards via the Acquisition section.</p>';
    canvas.style.display = 'none';
    if (legendEl) legendEl.innerHTML = '';
    return;
  }

  rows.sort((a, b) => a.ts - b.ts);

  const singles = rows.filter(r => r.source === 'single');
  const packs   = rows.filter(r => r.source === 'pack');

  function groupStats(arr) {
    const invested = arr.reduce((s, r) => s + r.cost, 0);
    const value    = arr.reduce((s, r) => s + r.modelGBP, 0);
    const roi      = invested > 0 ? ((value - invested) / invested) * 100 : null;
    return { count: arr.length, invested, value, roi };
  }
  const ss = groupStats(singles);
  const ps = groupStats(packs);
  const all = groupStats(rows);

  function statCard(label, s, dotColor) {
    const roiStr = s.roi !== null
      ? `<span class="roi-stat-roi ${s.roi >= 0 ? 'pos' : 'neg'}">${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(1)}% ROI</span>`
      : '';
    return `<div class="roi-stat-card">
      <div class="roi-stat-label">${dotColor ? `<span class="roi-legend-dot" style="background:${dotColor}"></span>` : ''}${label}</div>
      <div class="roi-stat-value">${fmtGBP(s.value)}</div>
      <div class="roi-stat-sub">from ${fmtGBP(s.invested)} · ${s.count} card${s.count !== 1 ? 's' : ''}</div>
      ${roiStr}
    </div>`;
  }
  summaryRow.innerHTML =
    (singles.length ? statCard('Singles', ss, '#e8b634') : '') +
    (packs.length   ? statCard('Pack rips', ps, '#34d399') : '') +
    statCard('Total', all, '');

  // Draw bar chart
  canvas.style.display = 'block';
  const DPR = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 500;
  const H = 220;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  const PAD = { top: 24, right: 16, bottom: 32, left: 48 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Y-axis: ROI% range
  const allRoi = rows.map(r => r.roi);
  const minRoi = Math.min(0, ...allRoi);
  const maxRoi = Math.max(0, ...allRoi);
  const roiSpan = maxRoi - minRoi || 1;

  function toY(roi) {
    return PAD.top + chartH - ((roi - minRoi) / roiSpan) * chartH;
  }
  const zeroY = toY(0);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let pct = Math.ceil(minRoi / 25) * 25; pct <= maxRoi + 1; pct += 25) {
    const y = toY(pct);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + chartW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText((pct >= 0 ? '+' : '') + pct + '%', PAD.left - 4, y + 3);
  }

  // Zero line
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.left, zeroY); ctx.lineTo(PAD.left + chartW, zeroY); ctx.stroke();

  // Bars
  const barW = Math.max(4, Math.min(28, (chartW / rows.length) - 3));
  rows.forEach((r, i) => {
    const x = PAD.left + (i / rows.length) * chartW + (chartW / rows.length - barW) / 2;
    const barTop = toY(Math.max(0, r.roi));
    const barBot = toY(Math.min(0, r.roi));
    const barH = Math.max(2, Math.abs(barBot - barTop));
    ctx.fillStyle = r.source === 'pack' ? 'rgba(52,211,153,0.8)' : 'rgba(232,182,52,0.85)';
    ctx.beginPath();
    ctx.roundRect(x, barTop, barW, barH, 3);
    ctx.fill();
  });

  // Legend
  if (legendEl) {
    const parts = [];
    if (singles.length) parts.push(`<span><span class="roi-legend-dot" style="background:#e8b634"></span>Singles (${singles.length})</span>`);
    if (packs.length)   parts.push(`<span><span class="roi-legend-dot" style="background:#34d399"></span>Pack rips (${packs.length})</span>`);
    parts.push(`<span style="color:var(--text-faint);margin-left:auto">Each bar = one card · model estimate</span>`);
    legendEl.innerHTML = parts.join('');
  }
}

function renderPortfolio() {
  const list = $('portfolioList');
  const countEl = $('portfolioCount');
  const totalEl = $('portfolioTotal');

  if (portfolio.length === 0) {
    list.innerHTML = '<div class="portfolio-empty">No cards yet. Search and add cards to track your collection.</div>';
    countEl.style.display = 'none';
    totalEl.textContent = 'Total: £0';
    return;
  }

  countEl.textContent = portfolio.length;
  countEl.style.display = 'flex';

  let totalGBP = 0;
  let totalCostGBP = 0;
  let hasAnyAcq = false;
  const items = portfolio.map(p => {
    const currentCard = getCardById(p.id);
    const cached = getCachedPrice(p.id);           // fresh (<1 h)
    const stale = !cached ? getLastKnownPrice(p.id) : null; // stale fallback
    const priceData = cached || stale;
    const currentPrice = priceData
      ? (priceData.market || priceData.mid || (currentCard ? currentCard.p : p.price))
      : (currentCard ? currentCard.p : p.price);
    const currentGBP = usdToGbp(currentPrice);
    const isLive = !!cached;
    const isStale = !cached && !!stale;
    totalGBP += currentGBP;

    let signal = null;
    if (currentCard) {
      let pullCost = 7.65;
      if (setsData && setsData[currentCard.sc]) {
        const set = setsData[currentCard.sc];
        const rarity = set.rarities?.[currentCard.rc];
        if (rarity && rarity.pullRate > 0) {
          const totalPacks = Math.round(1 / rarity.pullRate) * rarity.count;
          pullCost = totalPacks / 100;
        }
      }
      const des = autoFillDesirability(currentCard, pullCost);
      signal = _getCachedSignal(currentCard, pullCost, des.total);
    }

    const addedGBP = p.addedPriceGBP || 0;
    const change = addedGBP > 0 ? ((currentGBP - addedGBP) / addedGBP * 100).toFixed(1) : null;

    // Acquisition info — source badge + cost basis ROI
    const acq = (typeof getAcq === 'function') ? getAcq(p.id) : null;
    const acqCost = (typeof getAcqCostBasisGBP === 'function') ? getAcqCostBasisGBP(p.id) : null;
    let acqBadge = '';
    let acqLine = '';
    if (acq && acq.source) {
      hasAnyAcq = true;
      const ico = acq.source === 'pack' ? '🎁' : '🛒';
      const lbl = acq.source === 'pack' ? 'Pulled' : 'Bought';
      acqBadge = `<span class="portfolio-acq-badge portfolio-acq-${acq.source}" title="${lbl}">${ico} ${lbl}</span>`;
    }
    if (Number.isFinite(acqCost) && acqCost > 0) {
      totalCostGBP += acqCost;
      const pnlPct = ((currentGBP - acqCost) / acqCost) * 100;
      const pnlGBP = currentGBP - acqCost;
      const pos = pnlPct >= 0;
      acqLine = `<div class="portfolio-acq-line">Cost £${acqCost.toFixed(2)} · <span class="portfolio-acq-pnl ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}£${pnlGBP.toFixed(2)} (${pos ? '+' : ''}${pnlPct.toFixed(1)}%)</span></div>`;
    } else if (acq && acq.source) {
      acqLine = `<div class="portfolio-acq-line portfolio-acq-line-empty">Add cost to track ROI</div>`;
    }

    return `
      <div class="portfolio-item-card" data-id="${p.id}">
        <div class="portfolio-item" data-id="${p.id}">
          ${p.img ? `<img class="portfolio-item-img" src="${_hiresUrl(p.img)}" alt="" loading="lazy" decoding="async" onerror="_onImgError(this)">` : '<div class="portfolio-item-img"></div>'}
          <div class="portfolio-item-info">
            <div class="portfolio-item-name">${esc(p.name)} ${acqBadge}</div>
            <div class="portfolio-item-meta">${esc(p.set)}${change !== null ? ` · <span style="color:${parseFloat(change) >= 0 ? 'var(--green)' : 'var(--red)'}"> ${parseFloat(change) >= 0 ? '+' : ''}${change}%</span>` : ''}${isLive ? ' · <span class="live-dot-inline" title="Live price"></span>' : ''}${isStale ? ' · <span class="stale-price-tag" title="Cached price (>1h old) — tap Refresh prices to update">cached</span>' : ''}</div>
            ${acqLine}
          </div>
          <div class="portfolio-item-right">
            <div class="portfolio-item-price">£${currentGBP.toFixed(2)}</div>
            ${signal ? `<span class="portfolio-item-signal sig-${signal.signal.toLowerCase().replace('strong ', '')}"> ${signal.signal}</span>` : ''}
            ${piRenderButton(p.id, currentPrice)}
          </div>
          <button class="portfolio-item-remove" data-id="${p.id}" title="Remove">✕</button>
        </div>
        ${piRenderPanel(p.id)}
      </div>
    `;
  });

  list.innerHTML = items.join('');
  if (hasAnyAcq && totalCostGBP > 0) {
    const pnl = totalGBP - totalCostGBP;
    const pnlPct = (pnl / totalCostGBP) * 100;
    const pos = pnl >= 0;
    totalEl.innerHTML = `Value <strong>£${totalGBP.toFixed(2)}</strong> · Cost £${totalCostGBP.toFixed(2)} · <span class="${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}£${pnl.toFixed(2)} (${pos ? '+' : ''}${pnlPct.toFixed(1)}%)</span>`;
  } else {
    totalEl.textContent = `Total: £${totalGBP.toFixed(2)}`;
  }

  piWireToggles(list);
  requestAnimationFrame(() => drawPortfolioGrowthChart());
}

function drawPortfolioGrowthChart() {
  const section = document.getElementById('portfolioGrowthSection');
  const canvas  = document.getElementById('portfolioGrowthCanvas');
  if (!section || !canvas) return;

  if (portfolio.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  // Aggregate data across all cards
  let costBasisGBP  = 0;
  let hasCostBasis  = false;
  let currentGBP    = 0;
  const con = [0,0,0,0,0], exp = [0,0,0,0,0], opt = [0,0,0,0,0];

  for (const p of portfolio) {
    const card = getCardById(p.id);
    if (!card) continue;

    const priceData = getCachedPrice(p.id) || getLastKnownPrice(p.id);
    const mid = (priceData && priceData.pcUngraded > 0 && priceData.tcgMarket > 0)
      ? (priceData.pcUngraded + priceData.tcgMarket) / 2 : 0;
    const priceUSD = mid || (priceData ? (priceData.pcUngraded || priceData.market || priceData.mid || card.p) : card.p);
    currentGBP += usdToGbp(priceUSD);

    // Pull cost for forecast model
    let pullCost = 7.65;
    try {
      if (setsData && setsData[card.sc]) {
        const set = setsData[card.sc];
        const rar = set.rarities?.[card.rc];
        if (rar && rar.pullRate > 0) pullCost = (Math.round(1 / rar.pullRate) * rar.count) / 100;
      }
    } catch {}

    const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pullCost).total : 50;
    const fc  = forecast(card, pullCost, des);
    for (let i = 0; i < 5; i++) {
      con[i] += usdToGbp(fc.scenarios.conservative[i].priceUSD);
      exp[i] += usdToGbp(fc.scenarios.expected[i].priceUSD);
      opt[i] += usdToGbp(fc.scenarios.optimistic[i].priceUSD);
    }

    const acqCost = (typeof getAcqCostBasisGBP === 'function') ? getAcqCostBasisGBP(p.id) : null;
    if (acqCost && acqCost > 0) { costBasisGBP += acqCost; hasCostBasis = true; }
  }

  // Canvas setup
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 340;
  const H = 185;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const allVals = [currentGBP, ...opt, ...(hasCostBasis ? [costBasisGBP] : [])];
  const maxP = Math.max(...allVals) * 1.18;
  const rawMin = Math.min(hasCostBasis ? costBasisGBP : currentGBP, ...con);
  const minP = rawMin * 0.88;

  const pad = { l: 62, r: 22, t: 22, b: 34 };
  const cw  = W - pad.l - pad.r;
  const ch  = H - pad.t - pad.b;
  const xAt = yr => pad.l + (yr / 5) * cw;
  const yAt = v  => pad.t + ch - ((v - minP) / (maxP - minP)) * ch;

  // Grid lines + Y labels
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gv = minP + (maxP - minP) * (i / 4);
    const gy = yAt(gv);
    ctx.strokeStyle = '#25283a';
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    ctx.fillStyle = '#555768';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    const lbl = gv >= 1000 ? `£${(gv / 1000).toFixed(1)}k` : `£${Math.round(gv)}`;
    ctx.fillText(lbl, pad.l - 5, gy + 4);
  }

  // X labels
  ctx.font = '10px Space Grotesk, sans-serif';
  ctx.fillStyle = '#555768';
  ctx.textAlign = 'center';
  for (let yr = 0; yr <= 5; yr++) {
    ctx.fillText(yr === 0 ? 'Now' : `${yr}yr`, xAt(yr), H - 7);
  }

  // Cost-basis reference line
  if (hasCostBasis && costBasisGBP > 0) {
    const cy = yAt(costBasisGBP);
    ctx.strokeStyle = 'rgba(90,200,90,0.45)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(xAt(0), cy); ctx.lineTo(W - pad.r, cy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(90,200,90,0.65)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    const costLbl = costBasisGBP >= 1000 ? `cost £${(costBasisGBP/1000).toFixed(1)}k` : `cost £${Math.round(costBasisGBP)}`;
    ctx.fillText(costLbl, xAt(0) + 6, cy - 4);
  }

  // Con–opt band fill
  ctx.fillStyle = 'rgba(232,182,52,0.07)';
  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(currentGBP));
  for (let i = 0; i < 5; i++) ctx.lineTo(xAt(i + 1), yAt(opt[i]));
  for (let i = 4; i >= 0; i--) ctx.lineTo(xAt(i + 1), yAt(con[i]));
  ctx.lineTo(xAt(0), yAt(currentGBP));
  ctx.fill();

  // Conservative dashed line
  ctx.strokeStyle = 'rgba(138,138,138,0.35)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(xAt(0), yAt(currentGBP));
  con.forEach((v, i) => ctx.lineTo(xAt(i + 1), yAt(v)));
  ctx.stroke();

  // Optimistic dashed line
  ctx.strokeStyle = 'rgba(232,182,52,0.3)';
  ctx.beginPath(); ctx.moveTo(xAt(0), yAt(currentGBP));
  opt.forEach((v, i) => ctx.lineTo(xAt(i + 1), yAt(v)));
  ctx.stroke();
  ctx.setLineDash([]);

  // Expected line
  ctx.strokeStyle = '#e8b634';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(xAt(0), yAt(currentGBP));
  exp.forEach((v, i) => ctx.lineTo(xAt(i + 1), yAt(v)));
  ctx.stroke();

  // Current-value dot
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(xAt(0), yAt(currentGBP), 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e8b634';
  ctx.beginPath(); ctx.arc(xAt(0), yAt(currentGBP), 3, 0, Math.PI * 2); ctx.fill();

  // Yr-5 expected dot + label
  const yr5 = exp[4];
  ctx.fillStyle = '#e8b634';
  ctx.beginPath(); ctx.arc(xAt(5), yAt(yr5), 5, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 12px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  const yr5lbl = yr5 >= 1000 ? `£${(yr5/1000).toFixed(1)}k` : `£${Math.round(yr5)}`;
  ctx.fillText(yr5lbl, xAt(5) - 8, yAt(yr5) - 10);

  // ROI annotation (top-left)
  const roiPct = ((yr5 - currentGBP) / currentGBP * 100).toFixed(0);
  ctx.fillStyle = 'rgba(232,182,52,0.75)';
  ctx.font = '11px Space Grotesk, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`+${roiPct}% expected over 5 yrs`, pad.l + 4, pad.t + 13);

  // Current value label near the Now dot
  ctx.fillStyle = '#aaa';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  const nowLbl = currentGBP >= 1000 ? `£${(currentGBP/1000).toFixed(1)}k` : `£${Math.round(currentGBP)}`;
  ctx.fillText(nowLbl, xAt(0) + 8, yAt(currentGBP) + 4);
}

// =============================================================
// Wishlist (cards you want to buy at a target price)
// =============================================================
let wishlist = JSON.parse(localStorage.getItem('pkm-wishlist') || '[]');

let fullArtBinder = JSON.parse(localStorage.getItem('pkm-fullart-binder-v1') || '[]');
// Per-card species overrides — keyed by card ID, value is the override species string.
// Synced (pkm- prefix), so corrections carry across devices.
let binderSpeciesOverrides = JSON.parse(localStorage.getItem('pkm-binder-species-overrides-v1') || '{}');

// Pokédex grid detail panel state
let _binderBodyCache = {};       // species → { bodyHtml, inlineActions, dexNum, tier, haveInGroup, total, hasEN, hasJP }
let _binderDetailSpecies = null; // currently-open species in the detail panel

// Generation filter (0 = All, 1–9 = specific gen)
let _binderGenFilter = 0;
const BINDER_GEN_RANGES = [
  [0, Infinity],  // 0 = All
  [1,   151],     // Gen 1
  [152, 251],     // Gen 2
  [252, 386],     // Gen 3
  [387, 493],     // Gen 4
  [494, 649],     // Gen 5
  [650, 721],     // Gen 6
  [722, 809],     // Gen 7
  [810, 905],     // Gen 8
  [906, 1025],    // Gen 9
];

function saveBinderSpeciesOverrides() {
  localStorage.setItem('pkm-binder-species-overrides-v1', JSON.stringify(binderSpeciesOverrides));
}

function _showBinderRenameModal(currentSpecies, ids) {
  const modal = $('binderRenameModal');
  const input = $('binderRenameInput');
  if (!modal || !input) return;

  input.value = currentSpecies;
  modal.style.display = '';
  input.focus();
  input.select();

  function _apply() {
    const trimmed = input.value.trim();
    _closeBinderRenameModal();
    if (trimmed === '') {
      ids.forEach(id => delete binderSpeciesOverrides[id]);
    } else if (trimmed !== currentSpecies) {
      ids.forEach(id => { binderSpeciesOverrides[id] = trimmed; });
    }
    saveBinderSpeciesOverrides();
    renderBinderPage();
    // If detail panel is open, refresh it with the new species name
    if (_binderDetailSpecies === currentSpecies && trimmed && trimmed !== currentSpecies) {
      _binderDetailSpecies = trimmed;
    }
    if (_binderDetailSpecies && $('binderDetailPanel')?.classList.contains('open')) {
      _openBinderDetailRender(_binderDetailSpecies);
    }
  }

  function _onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); _apply(); }
    if (e.key === 'Escape') { e.preventDefault(); _closeBinderRenameModal(); }
  }

  $('binderRenameConfirm').onclick = _apply;
  $('binderRenameCancel').onclick  = _closeBinderRenameModal;
  modal.addEventListener('keydown', _onKey, { once: true });
  modal.addEventListener('click', e => { if (e.target === modal) _closeBinderRenameModal(); }, { once: true });
}

function _closeBinderRenameModal() {
  const modal = $('binderRenameModal');
  if (modal) modal.style.display = 'none';
}

// Manual EN/JP pairings within a binder group — keyed by card ID, value is its paired card ID.
// Both directions are stored: { idA: idB, idB: idA }.
let binderPairings = JSON.parse(localStorage.getItem('pkm-binder-pairings-v1') || '{}');

function saveBinderPairings() {
  localStorage.setItem('pkm-binder-pairings-v1', JSON.stringify(binderPairings));
}
function setBinderPairing(idA, idB) {
  // Dissolve any existing pairings for either card before creating the new one
  const oldA = binderPairings[idA], oldB = binderPairings[idB];
  if (oldA) delete binderPairings[oldA];
  if (oldB) delete binderPairings[oldB];
  binderPairings[idA] = idB;
  binderPairings[idB] = idA;
  saveBinderPairings();
}
function clearBinderPairing(id) {
  const partner = binderPairings[id];
  if (partner) delete binderPairings[partner];
  delete binderPairings[id];
  saveBinderPairings();
}

// Reorganise mode — multi-select cards to move them into a different species group.
let _binderReorgMode = false;
const _binderReorgSelected = new Set();

function _binderReorgGroups() {
  const groups = {};
  for (const b of fullArtBinder) {
    const sp = binderSpeciesOverrides[b.id] || speciesOf(b.name);
    if (!groups[sp]) groups[sp] = true;
  }
  return Object.keys(groups).sort((a, b) => a.localeCompare(b));
}

function _moveSelectedToGroup(targetGroup) {
  if (!targetGroup || !_binderReorgSelected.size) return;
  for (const id of _binderReorgSelected) {
    binderSpeciesOverrides[id] = targetGroup;
  }
  saveBinderSpeciesOverrides();
  _binderReorgSelected.clear();
  _binderReorgMode = false;
  renderBinderPage();
}

function _renderReorgBar() { /* no-op — actions now inline in group headers */ }

function setupWishlist() {
  $('wishlistToggle').addEventListener('click', () => toggleSidePanel('wishlistPanel'));
  $('wishlistClose').addEventListener('click', () => { $('wishlistPanel').style.display = 'none'; });
  $('addWishlistBtn').addEventListener('click', () => toggleCardInWishlist());

  // Delegated listeners — wired once so renderWishlist() can skip re-attaching.
  const list = $('wishlistList');
  if (list) {
    list.addEventListener('click', e => {
      if (e.target.closest('.wishlist-target-input') || e.target.closest('.pi-toggle')) return;
      const removeBtn = e.target.closest('.wishlist-remove');
      if (removeBtn) {
        e.stopPropagation();
        wishlist = wishlist.filter(w => w.id !== removeBtn.dataset.id);
        saveWishlist(); renderWishlist(); updateWishlistButton();
        return;
      }
      const item = e.target.closest('.wishlist-item');
      if (item) selectCard(item.dataset.id);
    });
    list.addEventListener('click', e => {
      const input = e.target.closest('.wishlist-target-input');
      if (input) e.stopPropagation();
    });
    list.addEventListener('change', e => {
      const input = e.target.closest('.wishlist-target-input');
      if (!input) return;
      const w = wishlist.find(x => x.id === input.dataset.id);
      if (w) {
        w.targetGBP = +parseFloat(input.value || '0').toFixed(2);
        saveWishlist(); // no full re-render — just persist the new target
        _homeWishHash = ''; // force home wishlist to recompute alert state on next nav
      }
    });
  }

  renderWishlist();
}

function toggleSidePanel(id) {
  if (id === 'comparePanel') { openComparePanel(); return; }
  ['portfolioPanel', 'wishlistPanel', 'alertsPanel', 'binderPanel'].forEach(p => {
    const el = document.getElementById(p);
    if (!el) return;
    el.style.display = p === id ? (el.style.display === 'none' ? 'block' : 'none') : 'none';
  });
}

function setupFullArtBinder() {
  // Header icon → go to dedicated binder page
  $('binderToggle').addEventListener('click', () => go('binder'));
  $('binderClose').addEventListener('click', () => { $('binderPanel').style.display = 'none'; });
  $('addBinderBtn').addEventListener('click', () => toggleCardInFullArtBinder());

  // "Find a card" button on binder page → jump to Predict search
  $('binderPageAddBtn')?.addEventListener('click', () => go('predict'));

  // Background price refresh for all binder cards
  $('binderRefreshPricesBtn')?.addEventListener('click', function() { binderFetchAllPrices(this); });

  // Sort order selector (Pokédex number vs A–Z), synced across devices
  $('binderSortSel')?.addEventListener('change', function() {
    localStorage.setItem(BINDER_SORT_KEY, this.value);
    renderBinderPage();
  });

  // Generation filter buttons
  $('binderGenFilter')?.addEventListener('click', e => {
    const btn = e.target.closest('.bgf-btn[data-gen]');
    if (!btn) return;
    _binderGenFilter = parseInt(btn.dataset.gen, 10);
    document.querySelectorAll('#binderGenFilter .bgf-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    renderBinderPage();
  });

  // Side panel list interactions
  const list = $('binderList');
  if (list) {
    list.addEventListener('click', e => {
      if (e.target.closest('.binder-remove')) {
        e.stopPropagation();
        const id = e.target.closest('.binder-remove').dataset.id;
        fullArtBinder = fullArtBinder.filter(b => b.id !== id);
        saveFullArtBinder(); renderFullArtBinder(); renderBinderPage(); updateFullArtBinderButton();
        return;
      }
      if (e.target.closest('.binder-owned-toggle')) {
        e.stopPropagation();
        const id = e.target.closest('.binder-owned-toggle').dataset.id;
        const item = fullArtBinder.find(b => b.id === id);
        if (item) { binderCycleStatus(item); saveFullArtBinder(); renderFullArtBinder(); renderBinderPage(); }
        return;
      }
      const item = e.target.closest('.binder-item');
      if (item) selectCard(item.dataset.id);
    });
  }

  // Binder page event delegation (set up once)
  // Shared handler used by both the page grid and the detail panel.
  function _handleBinderClick(e) {
    // Dex cell or flat-list row — open the detail panel
    const dexCell = e.target.closest('.binder-dex-cell[data-species], .binder-flat-row[data-species]');
    if (dexCell) {
      openBinderDetail(dexCell.dataset.species);
      return;
    }

    const viewBtn = e.target.closest('.bdl-view-btn[data-id]');
    if (viewBtn) {
      const id = viewBtn.dataset.id;
      closeBinderDetail();
      go('predict');
      setTimeout(() => { try { selectCard(id); } catch(err) {} }, 80);
      return;
    }

    const completeBtn = e.target.closest('.binder-pg-complete');
    if (completeBtn) {
      e.stopPropagation();
      const id = completeBtn.dataset.id;
      fullArtBinder = fullArtBinder.filter(b => b.id !== id);
      saveFullArtBinder(); renderBinderPage(); renderFullArtBinder(); updateFullArtBinderButton();
      return;
    }
    const ownedBtn = e.target.closest('.binder-pg-owned');
    if (ownedBtn) {
      e.stopPropagation();
      const id = ownedBtn.dataset.id;
      const it = fullArtBinder.find(b => b.id === id);
      if (it) { binderCycleStatus(it); saveFullArtBinder(); renderBinderPage(); renderFullArtBinder(); }
      return;
    }
    const removeBtn = e.target.closest('.binder-pg-remove');
    if (removeBtn) {
      e.stopPropagation();
      const id = removeBtn.dataset.id;
      fullArtBinder = fullArtBinder.filter(b => b.id !== id);
      saveFullArtBinder(); renderBinderPage(); renderFullArtBinder(); updateFullArtBinderButton();
      return;
    }
    const statusBtn = e.target.closest('.binder-group-status-btn');
    if (statusBtn) {
      e.stopPropagation();
      const sp = statusBtn.dataset.species;
      const groupCards = fullArtBinder.filter(b =>
        (binderSpeciesOverrides[b.id] || speciesOf(b.name)) === sp
      );
      const allHave = groupCards.every(b => b.owned || b.upgrade);
      groupCards.forEach(b => { b.owned = !allHave; b.upgrade = false; });
      saveFullArtBinder();
      renderBinderPage();
      renderFullArtBinder();
      return;
    }

    const editBtn = e.target.closest('.binder-species-edit');
    if (editBtn) {
      e.stopPropagation();
      const currentSpecies = editBtn.dataset.species;
      const ids = fullArtBinder
        .filter(b => (binderSpeciesOverrides[b.id] || speciesOf(b.name)) === currentSpecies)
        .map(b => b.id);
      _showBinderRenameModal(currentSpecies, ids);
      return;
    }

    // Checkbox — select card for move/link actions
    const reorgCb = e.target.closest('.breorg-cb');
    if (reorgCb) {
      e.stopPropagation();
      const id = reorgCb.dataset.id;
      if (_binderReorgSelected.has(id)) _binderReorgSelected.delete(id);
      else _binderReorgSelected.add(id);
      renderBinderPage();
      return;
    }

    // Inline Move button — move selected cards from this group to chosen group
    const inlineMoveBtn = e.target.closest('.breorg-inline-move');
    if (inlineMoveBtn) {
      e.stopPropagation();
      const species = inlineMoveBtn.dataset.species;
      // Works both in the old details element (now removed) and in the detail panel
      const detailsEl = inlineMoveBtn.closest('.binder-species-group')
        || document.getElementById('binderDetailActions');
      const sel = detailsEl?.querySelector('.breorg-inline-select');
      let target = sel?.value;
      if (!target) return;
      if (target === '__new__') {
        target = prompt('New group name:')?.trim();
        if (!target) return;
      }
      for (const id of [..._binderReorgSelected]) {
        const b = fullArtBinder.find(x => x.id === id);
        if (!b) continue;
        const bSp = binderSpeciesOverrides[b.id] || speciesOf(b.name);
        if (bSp === species) { binderSpeciesOverrides[id] = target; _binderReorgSelected.delete(id); }
      }
      saveBinderSpeciesOverrides();
      renderBinderPage();
      return;
    }

    // Inline Link button — force-pair exactly 2 selected cards
    const inlineLinkBtn = e.target.closest('.breorg-inline-link');
    if (inlineLinkBtn) {
      e.stopPropagation();
      const ids = [..._binderReorgSelected];
      if (ids.length !== 2) return;
      _binderReorgSelected.clear();
      _triggerBinderPair(ids[0], ids[1]);
      return;
    }

    // Inline Clear button — deselect all
    const inlineClearBtn = e.target.closest('.breorg-inline-clear');
    if (inlineClearBtn) {
      e.stopPropagation();
      _binderReorgSelected.clear();
      renderBinderPage();
      return;
    }

    const unpairBtn = e.target.closest('.binder-pg-unpair');
    if (unpairBtn) {
      e.stopPropagation();
      clearBinderPairing(unpairBtn.dataset.idA);
      renderBinderPage();
      return;
    }

    const card = e.target.closest('.binder-pg-card[data-id]');
    if (card && !e.target.closest('button')) {
      const id = card.dataset.id;
      go('predict');
      setTimeout(() => { try { selectCard(id); } catch(err) {} }, 80);
    }
  }

  const pageContent = $('binderPageContent');
  if (pageContent && !pageContent._listenerAdded) {
    pageContent._listenerAdded = true;
    pageContent.addEventListener('click', _handleBinderClick);

    // ── Desktop drag-to-compare (HTML5 drag API) ────────────────────────
    // Works on Mac. iOS/iPadOS does not fire these events — see touch section below.
    let _binderDragId = null;
    pageContent.addEventListener('dragstart', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (!card) return;
      _binderDragId = card.dataset.id;
      e.dataTransfer.effectAllowed = 'link';
      card.classList.add('binder-pg-dragging');
    });
    pageContent.addEventListener('dragend', () => {
      _binderDragId = null;
      pageContent.querySelectorAll('.binder-pg-dragging, .binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-dragging', 'binder-pg-drop-target'));
    });
    pageContent.addEventListener('dragover', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (!card || !_binderDragId || card.dataset.id === _binderDragId) return;
      if (card.dataset.id === _binderDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
      pageContent.querySelectorAll('.binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-drop-target'));
      card.classList.add('binder-pg-drop-target');
    });
    pageContent.addEventListener('dragleave', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (card) card.classList.remove('binder-pg-drop-target');
    });
    pageContent.addEventListener('drop', e => {
      const dropCard = e.target.closest('.binder-pg-card[data-id]');
      if (!dropCard || !_binderDragId || dropCard.dataset.id === _binderDragId) return;
      e.preventDefault();
      const dragId = _binderDragId;
      _binderDragId = null;
      pageContent.querySelectorAll('.binder-pg-dragging, .binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-dragging', 'binder-pg-drop-target'));
      _triggerBinderPair(dragId, dropCard.dataset.id);
    });

    // ── Touch drag-to-pair (iOS/iPadOS) ──────────────────────────────
    // HTML5 drag events don't fire on iOS — this reimplements the same
    // behaviour using touchstart/touchmove/touchend + elementFromPoint.
    let _tDragId = null, _tGhost = null, _tStarted = false;
    let _tStartX = 0, _tStartY = 0;
    const DRAG_THRESHOLD = 10; // px movement before drag is confirmed

    function _binderLang(id) {
      return (fullArtBinder.find(b => b.id === id)?.lang || 'EN');
    }
    function _sameGroup(idA, idB) {
      const bA = fullArtBinder.find(b => b.id === idA);
      const bB = fullArtBinder.find(b => b.id === idB);
      if (!bA || !bB) return false;
      return (binderSpeciesOverrides[idA] || speciesOf(bA.name)) ===
             (binderSpeciesOverrides[idB] || speciesOf(bB.name));
    }
    function _triggerBinderPair(idA, idB) {
      setBinderPairing(idA, idB);
      renderBinderPage();
    }
    function _cleanupTouchDrag() {
      if (_tGhost) { _tGhost.remove(); _tGhost = null; }
      pageContent.querySelectorAll('.binder-pg-dragging, .binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-dragging', 'binder-pg-drop-target'));
      _tDragId = null; _tStarted = false;
    }

    pageContent.addEventListener('touchstart', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (!card || e.target.closest('button')) return;
      _tDragId = card.dataset.id;
      _tStarted = false;
      _tStartX = e.touches[0].clientX;
      _tStartY = e.touches[0].clientY;
    }, { passive: true });

    pageContent.addEventListener('touchmove', e => {
      if (!_tDragId) return;
      const t = e.touches[0];
      const dx = t.clientX - _tStartX, dy = t.clientY - _tStartY;

      if (!_tStarted) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        _tStarted = true;
        const src = pageContent.querySelector(`.binder-pg-card[data-id="${CSS.escape(_tDragId)}"]`);
        if (src) {
          src.classList.add('binder-pg-dragging');
          // Build a scaled-down ghost that follows the finger
          _tGhost = src.cloneNode(true);
          const rect = src.getBoundingClientRect();
          _tGhost.style.cssText = `position:fixed;z-index:9999;pointer-events:none;`
            + `width:${rect.width}px;border-radius:8px;`
            + `box-shadow:0 8px 24px rgba(0,0,0,0.5);opacity:0.88;`
            + `transform:scale(1.04) rotate(-1.5deg);transition:none;`;
          document.body.appendChild(_tGhost);
        }
      }

      e.preventDefault(); // suppress scroll only once drag confirmed

      if (_tGhost) {
        _tGhost.style.left = (t.clientX - (_tGhost.offsetWidth / 2)) + 'px';
        _tGhost.style.top  = (t.clientY - 40) + 'px';
      }

      // Find the card under the finger (hide ghost first so it doesn't intercept)
      if (_tGhost) _tGhost.style.visibility = 'hidden';
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (_tGhost) _tGhost.style.visibility = '';

      const dropCard = el?.closest('.binder-pg-card[data-id]');
      pageContent.querySelectorAll('.binder-pg-drop-target')
        .forEach(x => x.classList.remove('binder-pg-drop-target'));
      if (dropCard && dropCard.dataset.id !== _tDragId) {
        dropCard.classList.add('binder-pg-drop-target');
      }
    }, { passive: false });

    const _onTouchEnd = e => {
      if (!_tDragId || !_tStarted) { _tDragId = null; return; }
      const dragId = _tDragId; // capture before _cleanupTouchDrag nulls it
      const t = e.changedTouches[0];
      if (_tGhost) _tGhost.style.visibility = 'hidden';
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const dropId = el?.closest('.binder-pg-card[data-id]')?.dataset.id;
      _cleanupTouchDrag();
      if (dropId && dropId !== dragId) _triggerBinderPair(dragId, dropId);
    };
    pageContent.addEventListener('touchend',    _onTouchEnd);
    pageContent.addEventListener('touchcancel', _cleanupTouchDrag);
  }

  // ── Detail panel listeners (set up once) ─────────────────────────────
  const detailPanel = $('binderDetailPanel');
  if (detailPanel && !detailPanel._listenerAdded) {
    detailPanel._listenerAdded = true;

    // All card action buttons inside the detail panel use the same handler
    detailPanel.addEventListener('click', _handleBinderClick);

    // Swipe down on the header to dismiss (mobile bottom sheet)
    {
      const hdr = detailPanel.querySelector('.binder-detail-header');
      let sy = 0, dy = 0, dragging = false;
      if (hdr) {
        hdr.addEventListener('touchstart', e => {
          sy = e.touches[0].clientY; dy = 0; dragging = true;
          detailPanel.style.transition = 'none';
        }, { passive: true });
        hdr.addEventListener('touchmove', e => {
          if (!dragging) return;
          dy = Math.max(0, e.touches[0].clientY - sy);
          detailPanel.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
        }, { passive: true });
        const end = () => {
          if (!dragging) return;
          dragging = false;
          detailPanel.style.transition = '';
          detailPanel.style.transform = '';
          if (dy > 90) closeBinderDetail();
        };
        hdr.addEventListener('touchend', end);
        hdr.addEventListener('touchcancel', end);
      }
    }

    // Desktop drag-to-pair inside the detail panel
    let _detailDragId = null;
    detailPanel.addEventListener('dragstart', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (!card) return;
      _detailDragId = card.dataset.id;
      e.dataTransfer.effectAllowed = 'link';
      card.classList.add('binder-pg-dragging');
    });
    detailPanel.addEventListener('dragend', () => {
      _detailDragId = null;
      detailPanel.querySelectorAll('.binder-pg-dragging, .binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-dragging', 'binder-pg-drop-target'));
    });
    detailPanel.addEventListener('dragover', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (!card || !_detailDragId || card.dataset.id === _detailDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
      detailPanel.querySelectorAll('.binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-drop-target'));
      card.classList.add('binder-pg-drop-target');
    });
    detailPanel.addEventListener('dragleave', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (card) card.classList.remove('binder-pg-drop-target');
    });
    detailPanel.addEventListener('drop', e => {
      const dropCard = e.target.closest('.binder-pg-card[data-id]');
      if (!dropCard || !_detailDragId || dropCard.dataset.id === _detailDragId) return;
      e.preventDefault();
      const dragId = _detailDragId;
      _detailDragId = null;
      detailPanel.querySelectorAll('.binder-pg-dragging, .binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-dragging', 'binder-pg-drop-target'));
      _triggerBinderPair(dragId, dropCard.dataset.id);
    });

    // Touch drag-to-pair inside the detail panel (iOS/iPadOS)
    let _dtDragId = null, _dtGhost = null, _dtStarted = false;
    let _dtStartX = 0, _dtStartY = 0;
    const DETAIL_DRAG_THRESHOLD = 10;
    const detailBody = $('binderDetailBody');

    function _cleanupDetailTouchDrag() {
      if (_dtGhost) { _dtGhost.remove(); _dtGhost = null; }
      detailPanel.querySelectorAll('.binder-pg-dragging, .binder-pg-drop-target')
        .forEach(el => el.classList.remove('binder-pg-dragging', 'binder-pg-drop-target'));
      _dtDragId = null; _dtStarted = false;
    }

    detailPanel.addEventListener('touchstart', e => {
      const card = e.target.closest('.binder-pg-card[data-id]');
      if (!card || e.target.closest('button')) return;
      _dtDragId = card.dataset.id;
      _dtStarted = false;
      _dtStartX = e.touches[0].clientX;
      _dtStartY = e.touches[0].clientY;
    }, { passive: true });

    detailPanel.addEventListener('touchmove', e => {
      if (!_dtDragId) return;
      const t = e.touches[0];
      const dx = t.clientX - _dtStartX, dy = t.clientY - _dtStartY;
      if (!_dtStarted) {
        if (Math.abs(dx) < DETAIL_DRAG_THRESHOLD && Math.abs(dy) < DETAIL_DRAG_THRESHOLD) return;
        _dtStarted = true;
        const src = detailPanel.querySelector(`.binder-pg-card[data-id="${CSS.escape(_dtDragId)}"]`);
        if (src) {
          src.classList.add('binder-pg-dragging');
          _dtGhost = src.cloneNode(true);
          const rect = src.getBoundingClientRect();
          _dtGhost.style.cssText = `position:fixed;z-index:9999;pointer-events:none;`
            + `width:${rect.width}px;border-radius:8px;`
            + `box-shadow:0 8px 24px rgba(0,0,0,0.5);opacity:0.88;`
            + `transform:scale(1.04) rotate(-1.5deg);transition:none;`;
          document.body.appendChild(_dtGhost);
        }
      }
      e.preventDefault();
      if (_dtGhost) {
        _dtGhost.style.left = (t.clientX - (_dtGhost.offsetWidth / 2)) + 'px';
        _dtGhost.style.top  = (t.clientY - 40) + 'px';
      }
      if (_dtGhost) _dtGhost.style.visibility = 'hidden';
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (_dtGhost) _dtGhost.style.visibility = '';
      const dropCard = el?.closest('.binder-pg-card[data-id]');
      detailPanel.querySelectorAll('.binder-pg-drop-target')
        .forEach(x => x.classList.remove('binder-pg-drop-target'));
      if (dropCard && dropCard.dataset.id !== _dtDragId) {
        dropCard.classList.add('binder-pg-drop-target');
      }
    }, { passive: false });

    const _onDetailTouchEnd = e => {
      if (!_dtDragId || !_dtStarted) { _dtDragId = null; return; }
      const dragId = _dtDragId;
      const t = e.changedTouches[0];
      if (_dtGhost) _dtGhost.style.visibility = 'hidden';
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const dropId = el?.closest('.binder-pg-card[data-id]')?.dataset.id;
      _cleanupDetailTouchDrag();
      if (dropId && dropId !== dragId) _triggerBinderPair(dragId, dropId);
    };
    detailPanel.addEventListener('touchend',    _onDetailTouchEnd);
    detailPanel.addEventListener('touchcancel', _cleanupDetailTouchDrag);
  }

  // Close button and overlay
  $('binderDetailClose')?.addEventListener('click', closeBinderDetail);
  $('binderDetailOverlay')?.addEventListener('click', closeBinderDetail);

  // Escape key closes the panel
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('binderDetailPanel')?.classList.contains('open')) {
      closeBinderDetail();
    }
  });

  renderFullArtBinder();
}

function toggleCardInFullArtBinder(id) {
  const card = id ? getCardById(id) : selectedCard;
  if (!card) return;
  const idx = fullArtBinder.findIndex(b => b.id === card.i);
  if (idx >= 0) {
    fullArtBinder.splice(idx, 1);
  } else {
    const currentUSD = getCurrentPrice(card);
    const currentGBP = usdToGbp(currentUSD);
    fullArtBinder.push({
      id: card.i,
      name: card.n,
      set: card.s,
      lang: card.lang || 'EN',
      img: getCardImg(card),
      addedDate: new Date().toISOString(),
      addedPriceGBP: currentGBP,
      owned: false,
    });
  }
  saveFullArtBinder();
  renderFullArtBinder();
  renderBinderPage();
  updateFullArtBinderButton();
}

function updateFullArtBinderButton() {
  const btn = $('addBinderBtn');
  if (!btn || !selectedCard) return;
  const inList = fullArtBinder.some(b => b.id === selectedCard.i);
  btn.classList.toggle('in-binder', inList);
  btn.title = inList ? 'Remove from Full Art Binder Project' : 'Add to Full Art Binder Project Wishlist';
}

function saveFullArtBinder() {
  localStorage.setItem('pkm-fullart-binder-v1', JSON.stringify(fullArtBinder));
}

// ── Binder slot status ─────────────────────────────────────────────────
// Each slot is one of three states, cycled by the Got it / Need it button:
//   'need'    — empty slot, no copy at all (highest priority)
//   'upgrade' — holds a placeholder copy, hunting a better one (lower priority)
//   'owned'   — final copy in the slot, done
// Stored as two booleans so older clients that only read `owned` degrade
// gracefully (an upgrade slot just shows as Need it there).
function binderStatusOf(b) {
  // Merge the old 'owned' and 'upgrade' states — both mean "have an existing
  // copy, targeting this listed card as the upgrade." 'need' means no copy yet.
  return (b.owned || b.upgrade) ? 'have' : 'need';
}
function binderCycleStatus(b) {
  const has = b.owned || b.upgrade;
  b.owned = !has;
  b.upgrade = false;
}
function binderStatusBtn(b, extraCls) {
  const has = binderStatusOf(b) === 'have';
  const label = has ? 'Have one' : 'Need it';
  return `<button class="${extraCls} binder-owned-toggle binder-st-${has ? 'have' : 'need'}" data-id="${b.id}"
    title="${has ? 'I have an existing copy — targeting this for upgrade' : 'Not yet acquired — tap to mark as owned'}">${label}</button>`;
}

// ── Binder sort order (Pokédex number / priority / A–Z) ────────────────
const BINDER_SORT_KEY = 'pkm-binder-sort-v1';
function binderGetSort() {
  try {
    const v = localStorage.getItem(BINDER_SORT_KEY);
    if (v === 'az' || v === 'prio' || v === 'price' || v === 'all-asc' || v === 'all-desc') return v;
  } catch (e) {}
  return 'dex';
}

// Normalise a species name for POKEDEX_NUM lookup. Must stay identical to
// the normaliser used to generate data/pokedex-db.js.
function pkdxNorm(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
    .toLowerCase().replace(/[.'’ʻ`: -]/g, '');
}

const _dexNumCache = new Map();
// National Pokédex number for a card name ("Erika's Venusaur ex" → 3), or
// null if no species matches. Slides a 1–3 word window across the name so
// owner/regional prefixes ("Galarian", "Erika's", "Dark") don't block the
// species match, preferring the longest match at the earliest position.
function dexNumOf(cardName) {
  if (typeof POKEDEX_NUM === 'undefined' || !cardName) return null;
  if (_dexNumCache.has(cardName)) return _dexNumCache.get(cardName);
  function scan(words) {
    for (let start = 0; start < words.length; start++) {
      for (let len = Math.min(3, words.length - start); len >= 1; len--) {
        const n = POKEDEX_NUM[pkdxNorm(words.slice(start, start + len).join(' '))];
        if (n) return n;
      }
    }
    return null;
  }
  const base = cardName.replace(/\(JP\)/gi, ' ');
  // Hyphenated species (Ho-Oh, Porygon-Z) match whole in the first pass;
  // the hyphen-split retry only runs for stuck suffixes like "Charizard-EX".
  const num = scan(base.split(/\s+/).filter(Boolean))
           ?? scan(base.split(/[\s-]+/).filter(Boolean));
  _dexNumCache.set(cardName, num);
  return num;
}

function renderFullArtBinder() {
  const list = $('binderList');
  const countEl = $('binderCount');
  const totalEl = $('binderTotal');
  if (!list) return;

  if (fullArtBinder.length === 0) {
    list.innerHTML = '<div class="portfolio-empty">No cards yet. Open a card and tap the binder icon to add it.</div>';
    if (countEl) countEl.style.display = 'none';
    if (totalEl) totalEl.textContent = '0 cards';
    return;
  }

  const haveOneCount = fullArtBinder.filter(b => b.owned || b.upgrade).length;
  if (countEl) { countEl.textContent = fullArtBinder.length; countEl.style.display = 'flex'; }
  if (totalEl) totalEl.textContent = `${haveOneCount}/${fullArtBinder.length} have one`;

  const items = fullArtBinder.map(b => {
    const currentCard = getCardById(b.id);
    const cached = getCachedPrice(b.id);
    const currentUSD = cached
      ? (cached.pcUngraded || cached.market || cached.mid || (currentCard ? currentCard.p : 0))
      : (currentCard ? currentCard.p : 0);
    const currentGBP = usdToGbp(currentUSD);
    return `
      <div class="binder-item ${b.owned ? 'binder-owned' : ''}" data-id="${b.id}">
        ${b.img ? `<img class="wishlist-item-img" src="${_hiresUrl(b.img)}" alt="" loading="lazy" decoding="async" onerror="_onImgError(this)">` : '<div class="wishlist-item-img"></div>'}
        <div class="wishlist-item-info">
          <div class="wishlist-item-name">${esc(b.name)}</div>
          <div class="wishlist-item-meta"><span>${esc(b.set)}</span> <span class="lang-pill">${b.lang === 'JP' ? '\u{1F1EF}\u{1F1F5} JP' : '\u{1F1EC}\u{1F1E7} EN'}</span></div>
        </div>
        <div class="binder-right">
          <div class="wishlist-current">£${currentGBP.toFixed(2)}</div>
          ${binderStatusBtn(b, '')}
        </div>
        <button class="wishlist-remove binder-remove" data-id="${b.id}" title="Remove">✕</button>
      </div>
    `;
  });
  list.innerHTML = items.join('');
}

// Extract the species name from a card name (Gen 1/2 edge cases handled).
// Lives at module level so it can be called from event handlers as well as renderBinderPage.
function speciesOf(name) {
  if (!name) return 'Unknown';
  if (/^mr\.?\s*mime/i.test(name)) return 'Mr. Mime';
  if (/^farfetch.d/i.test(name)) return "Farfetch'd";
  if (/^ho.oh/i.test(name)) return 'Ho-Oh';
  if (/^nidoran[♀♂]/i.test(name)) return 'Nidoran';
  if (/^mime\s+jr/i.test(name)) return 'Mime Jr.';
  return name.trim().split(/\s+/)[0];
}

// ── Module-level binder helpers (used by both renderBinderPage and detail panel) ──

function _binderItemGBP(b) {
  const card = getCardById(b.id);
  const cached = getCachedPrice(b.id) || getLastKnownPrice(b.id);
  const usd = cached
    ? (cached.pcUngraded || cached.market || cached.mid || (card ? card.p : 0))
    : (card ? card.p : 0);
  return usdToGbp(usd || 0);
}

function _binderPairItems(items) {
  const pairs = [];
  const used = new Set();
  for (const a of items) {
    if (used.has(a.id)) continue;
    const manualId = binderPairings[a.id];
    if (!manualId) continue;
    const b = items.find(x => x.id === manualId && !used.has(x.id));
    if (!b) continue;
    const aIsEN = (a.lang || 'EN') !== 'JP';
    pairs.push({ en: aIsEN ? a : b, jp: aIsEN ? b : a, manual: true });
    used.add(a.id); used.add(b.id);
  }
  const enItems = items.filter(b => !used.has(b.id) && (b.lang || 'EN') !== 'JP');
  const jpItems = items.filter(b => !used.has(b.id) && b.lang === 'JP');
  const usedEN = new Set(), usedJP = new Set();
  for (const en of enItems) {
    const enKey = counterpartByCard.get(en.id);
    let jp = null;
    if (enKey) {
      for (const j of jpItems) {
        if (usedJP.has(j.id)) continue;
        if (counterpartByCard.get(j.id) === enKey) { jp = j; usedJP.add(j.id); break; }
      }
    }
    if (!jp && jpItems.length === 1 && !usedJP.has(jpItems[0].id) && enItems.length === 1) {
      jp = jpItems[0]; usedJP.add(jpItems[0].id);
    }
    pairs.push({ en, jp });
    usedEN.add(en.id);
  }
  for (const j of jpItems) {
    if (!usedJP.has(j.id)) pairs.push({ en: null, jp: j });
  }
  return pairs;
}

// Build the simple list-view body HTML shown inside the detail panel.
// One <details> per pair/solo, with EN and JP as labeled rows.
function _buildBinderPanelBody(items, setBuckets) {
  const pairs = _binderPairItems(items);
  let html = '';

  for (const pair of pairs) {
    const enB = pair.en, jpB = pair.jp;
    const enGBP = enB ? _binderItemGBP(enB) : 0;
    const jpGBP = jpB ? _binderItemGBP(jpB) : 0;

    // Summary label: card name + set (from first card)
    const first = enB || jpB;
    const setLabel = esc(first.set);
    const cardLabel = esc(first.name.split(' ').slice(0, 3).join(' '));

    // EN/JP price labels in the summary
    const enPriceStr = enGBP > 0 ? `£${enGBP.toFixed(2)}` : '—';
    const jpPriceStr = jpGBP > 0 ? `£${jpGBP.toFixed(2)}` : '—';
    const sumPrices = (enB ? `<span class="bdl-sp en">EN ${enPriceStr}</span>` : '') +
                      (jpB ? `<span class="bdl-sp jp">JP ${jpPriceStr}</span>` : '');

    // Verdict
    let verdictHtml = '';
    if (enB && jpB && enGBP > 0 && jpGBP > 0) {
      const diff = ((jpGBP - enGBP) / enGBP) * 100;
      const abs = Math.abs(diff).toFixed(0);
      let msg, cls;
      if (diff < -25)       { msg = `JP is ${abs}% cheaper — strong case for Japanese`; cls = 'verdict-jp-strong'; }
      else if (diff < -10)  { msg = `JP is ${abs}% cheaper — worth considering`; cls = 'verdict-jp-mild'; }
      else if (diff > 25)   { msg = `EN is ${abs}% cheaper — considerably better value`; cls = 'verdict-en-strong'; }
      else if (diff > 10)   { msg = `EN is ${abs}% cheaper — slight advantage`; cls = 'verdict-en-mild'; }
      else                  { msg = `Within ${abs}% of each other`; cls = 'verdict-neutral'; }
      verdictHtml = `<div class="binder-verdict ${cls} bdl-verdict"><span class="binder-verdict-dot"></span>${msg}</div>`;
    }

    // Unlink button
    const unpairBtn = (pair.manual && enB && jpB)
      ? `<button class="binder-pg-unpair bdl-unpair" data-id-a="${esc(enB.id)}" data-id-b="${esc(jpB.id)}">⛓ Unlink</button>`
      : '';

    // Multi-buy hint
    let multiBuyHtml = '';
    const checkedSets = new Set();
    for (const b of [enB, jpB].filter(Boolean)) {
      if (checkedSets.has(b.set)) continue;
      checkedSets.add(b.set);
      const bucket = (setBuckets || {})[b.set] || [];
      const others = bucket.filter(id => id !== b.id && id !== (b === enB ? jpB?.id : enB?.id));
      if (others.length >= 1) {
        multiBuyHtml = `<div class="binder-multibuy bdl-multibuy">📦 ${others.length + 1} cards from <strong>${esc(b.set)}</strong> — ask for multi-buy discount</div>`;
        break;
      }
    }

    // Card rows
    function cardRow(b, gbp, lang) {
      if (!b) return '';
      const liveCard = cardData?.cards?.find(c => c.i === b.id);
      const imgSrc = liveCard ? _hiresUrl(getCardImg(liveCard)) : (b.img ? _hiresUrl(b.img) : null);
      const priceStr = gbp > 0 ? `£${gbp.toFixed(2)}` : '—';
      const st = binderStatusOf(b);
      const completeBtn = st === 'have'
        ? `<button class="binder-pg-complete bdl-complete-btn" data-id="${b.id}" title="Got the upgrade — remove from binder">✓ Got the upgrade</button>` : '';
      return `
        <div class="bdl-row bdl-row-${lang}" data-id="${b.id}">
          <span class="bdl-lang ${lang}">${lang.toUpperCase()}</span>
          ${imgSrc ? `<img class="bdl-thumb" src="${imgSrc}" alt="" loading="lazy" onerror="_onImgError(this)">` : '<div class="bdl-thumb bdl-thumb-ph"></div>'}
          <div class="bdl-info">
            <div class="bdl-name">${esc(b.name)}</div>
            <div class="bdl-set">${esc(b.set)}</div>
          </div>
          <div class="bdl-price-col">
            <div class="bdl-price">${priceStr}</div>
          </div>
          <div class="bdl-acts">
            ${binderStatusBtn(b, 'binder-pg-owned bdl-status-btn')}
            <button class="binder-pg-remove bdl-remove-btn" data-id="${b.id}" title="Remove from binder">✕</button>
            <button class="bdl-view-btn" data-id="${b.id}" title="View card analysis">↗</button>
          </div>
          ${completeBtn}
        </div>`;
    }

    html += `
      <details class="bdl-pair" open>
        <summary class="bdl-sum">
          <svg class="bdl-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          <span class="bdl-sum-label">${cardLabel} · ${setLabel}</span>
          <div class="bdl-sum-prices">${sumPrices}</div>
        </summary>
        <div class="bdl-body">
          ${cardRow(enB, enGBP, 'en')}
          ${cardRow(jpB, jpGBP, 'jp')}
          ${verdictHtml}${unpairBtn}${multiBuyHtml}
        </div>
      </details>`;
  }

  return html || '<p class="bdl-empty">No cards in this group.</p>';
}

function renderBinderPage() {
  const container = $('binderPageContent');
  if (!container) return;

  // Update owned count in header
  const haveCount = fullArtBinder.filter(b => b.owned || b.upgrade).length;
  const pageOwnedEl = $('binderPageOwned');
  if (pageOwnedEl) pageOwnedEl.textContent = `${haveCount}/${fullArtBinder.length} have one`;

  const sortMode = binderGetSort();
  const sortSel = $('binderSortSel');
  if (sortSel) sortSel.value = sortMode;

  if (fullArtBinder.length === 0) {
    container.innerHTML = `<div class="binder-page-empty"><p>Nothing in the binder yet.</p><p class="binder-page-empty-sub">Open any card in Predict and tap "Add to Full Art Binder" to start your Gen 1 &amp; Gen 2 project.</p></div>`;
    return;
  }

  // Group by species (override wins over auto-detect)
  const groups = {};
  for (const b of fullArtBinder) {
    const sp = binderSpeciesOverrides[b.id] || speciesOf(b.name);
    if (!groups[sp]) groups[sp] = [];
    groups[sp].push(b);
  }

  // Pull cross-group manual pairs into the same group (move the partner card, not the whole group)
  const _movedByPair = new Set();
  for (const [idA, idB] of Object.entries(binderPairings)) {
    if (_movedByPair.has(idA) || _movedByPair.has(idB)) continue;
    const grpA = Object.keys(groups).find(sp => groups[sp].some(b => b.id === idA));
    const grpB = Object.keys(groups).find(sp => groups[sp].some(b => b.id === idB));
    if (!grpA || !grpB || grpA === grpB) continue;
    const bItem = groups[grpB].find(b => b.id === idB);
    if (bItem) {
      groups[grpB] = groups[grpB].filter(b => b.id !== idB);
      if (groups[grpB].length === 0) delete groups[grpB];
      groups[grpA].push(bItem);
      _movedByPair.add(idA); _movedByPair.add(idB);
    }
  }

  // Set-level multi-buy detection: how many binder cards per set
  const setBuckets = {};
  for (const b of fullArtBinder) {
    if (!setBuckets[b.set]) setBuckets[b.set] = [];
    setBuckets[b.set].push(b.id);
  }

  // Render a single card tile (used only for the grid detail cache — not shown in panel anymore)
  function cardTile(b, gbp) {
    // Live-resolve image so artwork overrides applied after the card was added
    // to the binder are immediately visible (b.img is snapshot-at-add-time).
    const liveCard = cardData?.cards?.find(c => c.i === b.id);
    const imgSrc = liveCard ? _hiresUrl(getCardImg(liveCard)) : (b.img ? _hiresUrl(b.img) : null);
    const priceStr = gbp > 0 ? `£${gbp.toFixed(2)}` : '—';
    const langPill = b.lang === 'JP'
      ? '<span class="binder-pg-lang jp">JP</span>'
      : '<span class="binder-pg-lang en">EN</span>';
    const st = binderStatusOf(b);
    const upgradeTag = st === 'have'
      ? '<div class="binder-pg-upgrade-tag">Have one — targeting this for upgrade</div>' : '';
    const completeBtn = st === 'have'
      ? `<button class="binder-pg-complete" data-id="${b.id}" title="Got the upgrade — remove from binder project">✓ Got the upgrade</button>` : '';
    const isSelected = _binderReorgSelected.has(b.id);
    const reorgCb = `<span class="breorg-cb${isSelected ? ' checked' : ''}" data-id="${b.id}" title="Select card"></span>`;
    return `
      <div class="binder-pg-card${(b.owned || b.upgrade) ? ' binder-pg-owned-card' : ''}${isSelected ? ' breorg-selected' : ''}" data-id="${b.id}" draggable="true">
        <div class="binder-pg-img-wrap">
          ${imgSrc ? `<img class="binder-pg-img" src="${imgSrc}" alt="" loading="lazy" onerror="_onImgError(this)">` : '<div class="binder-pg-img binder-pg-img-ph"></div>'}
          ${langPill}${reorgCb}
        </div>
        <div class="binder-pg-card-info">
          <div class="binder-pg-card-name">${esc(b.name)}</div>
          <div class="binder-pg-card-set">${esc(b.set)}</div>
          <div class="binder-pg-card-price">${priceStr}</div>
          ${upgradeTag}
          <div class="binder-pg-card-actions">
            ${binderStatusBtn(b, 'binder-pg-owned')}
            <button class="binder-pg-remove" data-id="${b.id}" title="Remove from binder">✕</button>
          </div>
          ${completeBtn}
        </div>
      </div>`;
  }

  let html = '';

  // Lowest dex number among a group's cards decides its Pokédex position;
  // groups with no species match (trainers etc.) sort after, A–Z.
  const groupDex = {};
  for (const sp of Object.keys(groups)) {
    let min = Infinity;
    for (const b of groups[sp]) {
      const d = dexNumOf(b.name);
      if (d && d < min) min = d;
    }
    groupDex[sp] = min;
  }
  // Priority tier per group: 0 = at least one card not yet owned (highest priority),
  // 1 = all cards have an existing copy (lower priority — hunting upgrades).
  const groupTier = {};
  for (const sp of Object.keys(groups)) {
    const hasNeed = groups[sp].some(b => binderStatusOf(b) === 'need');
    groupTier[sp] = hasNeed ? 0 : 1;
  }
  // Pre-compute pairs once per group — reused for price sort and rendering.
  const groupPairs = {};
  for (const sp of Object.keys(groups)) groupPairs[sp] = _binderPairItems(groups[sp]);

  // Price per group: smart-pick card price (cheaper side of EN/JP pair, or solo).
  // Used for "price" sort — groups with no cached price go to the end.
  const groupPrice = {};
  for (const sp of Object.keys(groups)) {
    const pairs = groupPairs[sp];
    let best = Infinity;
    for (const { en, jp } of pairs) {
      const enGBP = en ? _binderItemGBP(en) : 0;
      const jpGBP = jp ? _binderItemGBP(jp) : 0;
      let pick = 0;
      if (en && jp && enGBP > 0 && jpGBP > 0) {
        // Mirror the verdict logic: JP cheaper by >10% → use JP price, else EN
        const diff = ((jpGBP - enGBP) / enGBP) * 100;
        pick = diff < -10 ? jpGBP : diff > 10 ? enGBP : Math.min(enGBP, jpGBP);
      } else {
        pick = (en && enGBP > 0) ? enGBP : (jp && jpGBP > 0) ? jpGBP : 0;
      }
      if (pick > 0) best = Math.min(best, pick);
    }
    groupPrice[sp] = isFinite(best) ? best : Infinity;
  }

  const byDex = (a, b) => (groupDex[a] - groupDex[b]) || a.localeCompare(b);
  let sortedSpecies = Object.keys(groups).sort((a, b) =>
    sortMode === 'az'    ? a.localeCompare(b) :
    sortMode === 'prio'  ? (groupTier[a] - groupTier[b]) || byDex(a, b) :
    sortMode === 'price' ? (groupPrice[a] - groupPrice[b]) || byDex(a, b) :
                           byDex(a, b));

  // Apply generation filter
  if (_binderGenFilter > 0) {
    const [genMin, genMax] = BINDER_GEN_RANGES[_binderGenFilter];
    sortedSpecies = sortedSpecies.filter(sp => {
      const d = groupDex[sp];
      return isFinite(d) && d >= genMin && d <= genMax;
    });
  }

  for (const species of sortedSpecies) {
    const items = groups[species];
    const haveInGroup = items.filter(b => b.owned || b.upgrade).length;
    const pairs = groupPairs[species];
    const hasEN = items.some(b => (b.lang || 'EN') !== 'JP');
    const hasJP = items.some(b => b.lang === 'JP');
    let bodyHtml = '';

    for (const pair of pairs) {
      const enB = pair.en, jpB = pair.jp;
      const enGBP = enB ? _binderItemGBP(enB) : 0;
      const jpGBP = jpB ? _binderItemGBP(jpB) : 0;

      // Build comparison verdict + identify the smarter buy
      let verdictHtml = '', smartSide = null;
      if (enB && jpB && enGBP > 0 && jpGBP > 0) {
        // diff > 0 → JP costs more than EN; diff < 0 → JP cheaper
        const diff = ((jpGBP - enGBP) / enGBP) * 100;
        const abs = Math.abs(diff).toFixed(0);
        let msg, cls;
        if (diff < -25) {
          msg = `JP is ${abs}% cheaper — strong case for the Japanese version`;
          cls = 'verdict-jp-strong';
        } else if (diff < -10) {
          msg = `JP is ${abs}% cheaper — worth considering over EN`;
          cls = 'verdict-jp-mild';
        } else if (diff > 25) {
          msg = `EN is ${abs}% cheaper — English is considerably better value`;
          cls = 'verdict-en-strong';
        } else if (diff > 10) {
          msg = `EN is ${abs}% cheaper — slight advantage to English`;
          cls = 'verdict-en-mild';
        } else {
          msg = `Within ${abs}% of each other — get whichever you prefer`;
          cls = 'verdict-neutral';
        }
        verdictHtml = `<div class="binder-verdict ${cls}"><span class="binder-verdict-dot"></span>${msg}</div>`;
        smartSide = cls.includes('-jp') ? 'jp' : cls.includes('-en') ? 'en' : null;
      }

      // Multi-buy hint: does this card's set contain other binder cards?
      let multiBuyHtml = '';
      const checkedSets = new Set();
      for (const b of [enB, jpB].filter(Boolean)) {
        if (checkedSets.has(b.set)) continue;
        checkedSets.add(b.set);
        const bucket = setBuckets[b.set] || [];
        const others = bucket.filter(id => id !== b.id && id !== (b === enB ? jpB?.id : enB?.id));
        if (others.length >= 1) {
          multiBuyHtml = `<div class="binder-multibuy">📦 ${others.length + 1} cards from <strong>${esc(b.set)}</strong> in binder — ask for a multi-buy discount</div>`;
          break;
        }
      }

      if (enB && jpB) {
        const unpairBtn = pair.manual
          ? `<button class="binder-pg-unpair" data-id-a="${esc(enB.id)}" data-id-b="${esc(jpB.id)}" title="Remove manual pairing — revert to auto-match">⛓ Unlink</button>`
          : '';
        bodyHtml += `
          <div class="binder-pair">
            <div class="binder-pair-cards">
              <div class="binder-pair-side${smartSide === 'en' ? ' binder-smart-pick' : ''}">${cardTile(enB, enGBP)}</div>
              <div class="binder-pair-divider">${unpairBtn}<span class="binder-pair-vs">vs</span></div>
              <div class="binder-pair-side${smartSide === 'jp' ? ' binder-smart-pick' : ''}">${cardTile(jpB, jpGBP)}</div>
            </div>
            ${verdictHtml}${multiBuyHtml}
          </div>`;
      } else {
        const solo = enB || jpB;
        const soloGBP = enB ? enGBP : jpGBP;
        bodyHtml += `<div class="binder-pair binder-pair-solo">${cardTile(solo, soloGBP)}${multiBuyHtml}</div>`;
      }
    }

    const tier = groupTier[species];
    const hasOverride = items.some(b => binderSpeciesOverrides[b.id]);

    // Inline selection actions — appear in the detail panel header when cards are selected
    const groupSelectedIds = items.map(b => b.id).filter(id => _binderReorgSelected.has(id));
    const totalSelected = _binderReorgSelected.size;
    let inlineActions = '';
    if (groupSelectedIds.length > 0) {
      const otherGroups = _binderReorgGroups().filter(g => g !== species);
      const showLink = totalSelected === 2;
      inlineActions = `
        <span class="binder-inline-sel">
          <span class="breorg-sel-count">${groupSelectedIds.length} selected</span>
          <select class="breorg-inline-select">
            <option value="">Move to…</option>
            ${otherGroups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
            <option value="__new__">+ New group</option>
          </select>
          <button class="breorg-inline-move" data-species="${esc(species)}">Move</button>
          ${showLink ? `<button class="breorg-inline-link">Link</button>` : ''}
          <button class="breorg-inline-clear">✕</button>
        </span>`;
    }

    // Cache per-species data for the detail panel
    _binderBodyCache[species] = { bodyHtml, inlineActions, dexNum: groupDex[species], tier, haveInGroup, total: items.length, hasEN, hasJP, hasOverride, items, setBuckets };

    const spriteUrl = isFinite(groupDex[species])
      ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${groupDex[species]}.png`
      : null;

    html += `<div class="binder-dex-cell${tier === 0 ? ' binder-dex-need' : ' binder-dex-have'}"
         data-species="${esc(species)}" role="button" tabindex="0">
      <span class="binder-dex-num">${isFinite(groupDex[species]) ? '#' + String(groupDex[species]).padStart(4, '0') : '—'}</span>
      ${spriteUrl ? `<img class="binder-dex-sprite" src="${spriteUrl}" alt="${esc(species)}" loading="lazy">` : '<div class="binder-dex-sprite binder-dex-sprite-ph"></div>'}
      <span class="binder-dex-name">${esc(species)}${hasOverride ? '<span class="binder-dex-override" title="Name overridden">·</span>' : ''}</span>
      <div class="binder-dex-langs">
        ${hasEN ? '<span class="binder-dex-lang en">EN</span>' : ''}
        ${hasJP ? '<span class="binder-dex-lang jp">JP</span>' : ''}
      </div>
      <span class="binder-dex-status ${tier === 0 ? 'need' : 'have'}">${tier === 0 ? 'Need' : 'Have one'}</span>
    </div>`;
  }

  // Flat all-cards view: all EN/JP pairs across all species, sorted by price.
  // Reuses bdl-pair/bdl-row CSS so pairs display identically to the detail panel.
  if (sortMode === 'all-asc' || sortMode === 'all-desc') {
    // Collect pairs from every species in the filtered+sorted species list
    const allPairs = [];
    for (const species of sortedSpecies) {
      for (const pair of groupPairs[species]) {
        const enGBP = pair.en ? _binderItemGBP(pair.en) : 0;
        const jpGBP = pair.jp ? _binderItemGBP(pair.jp) : 0;
        // Representative sort price: min of EN/JP if both present, else whichever exists
        let price = 0;
        if (enGBP > 0 && jpGBP > 0) price = Math.min(enGBP, jpGBP);
        else price = enGBP || jpGBP;
        allPairs.push({ pair, species, price, enGBP, jpGBP });
      }
    }
    allPairs.sort((a, b) => {
      if ((a.price > 0) !== (b.price > 0)) return a.price > 0 ? -1 : 1; // unpriced last
      return sortMode === 'all-asc' ? a.price - b.price : b.price - a.price;
    });

    function flatCardRow(b, gbp, lang) {
      if (!b) return '';
      const liveCard = cardData?.cards?.find(c => c.i === b.id);
      const imgSrc = liveCard ? _hiresUrl(getCardImg(liveCard)) : (b.img ? _hiresUrl(b.img) : null);
      const priceStr = gbp > 0 ? `£${gbp.toFixed(2)}` : '—';
      const st = binderStatusOf(b);
      const completeBtn = st === 'have'
        ? `<button class="binder-pg-complete bdl-complete-btn" data-id="${b.id}" title="Got the upgrade — remove from binder">✓ Got the upgrade</button>` : '';
      return `
        <div class="bdl-row bdl-row-${lang}" data-id="${b.id}">
          <span class="bdl-lang ${lang}">${lang.toUpperCase()}</span>
          ${imgSrc ? `<img class="bdl-thumb" src="${imgSrc}" alt="" loading="lazy" onerror="_onImgError(this)">` : '<div class="bdl-thumb bdl-thumb-ph"></div>'}
          <div class="bdl-info">
            <div class="bdl-name">${esc(b.name)}</div>
            <div class="bdl-set">${esc(b.set)}</div>
          </div>
          <div class="bdl-price-col">
            <div class="bdl-price">${priceStr}</div>
          </div>
          <div class="bdl-acts">
            ${binderStatusBtn(b, 'binder-pg-owned bdl-status-btn')}
            <button class="binder-pg-remove bdl-remove-btn" data-id="${b.id}" title="Remove from binder">✕</button>
            <button class="bdl-view-btn" data-id="${b.id}" title="View card analysis">↗</button>
          </div>
          ${completeBtn}
        </div>`;
    }

    const flatHtml = allPairs.map(({ pair, species, enGBP, jpGBP }) => {
      const { en: enB, jp: jpB } = pair;
      const enPriceStr = enGBP > 0 ? `£${enGBP.toFixed(2)}` : '—';
      const jpPriceStr = jpGBP > 0 ? `£${jpGBP.toFixed(2)}` : '—';
      const sumPrices = (enB ? `<span class="bdl-sp en">${enPriceStr}</span>` : '') +
                        (jpB ? `<span class="bdl-sp jp">${jpPriceStr}</span>` : '');
      return `
        <details class="bdl-pair" open data-species="${esc(species)}">
          <summary class="bdl-sum">
            <svg class="bdl-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            <span class="bdl-sum-label">${esc(species)}</span>
            <div class="bdl-sum-prices">${sumPrices}</div>
          </summary>
          <div class="bdl-body">
            ${flatCardRow(enB, enGBP, 'en')}
            ${flatCardRow(jpB, jpGBP, 'jp')}
          </div>
        </details>`;
    }).join('');
    container.innerHTML = '<div class="binder-flat-list">' +
      (flatHtml || '<p class="bdl-empty" style="text-align:center;padding:24px">No cards match this filter.</p>') + '</div>';
  } else {
    container.innerHTML = '<div class="binder-dex-grid">' + html + '</div>';
  }
  _renderReorgBar();

  // If the detail panel is open, refresh it with the latest rendered data
  if (_binderDetailSpecies && $('binderDetailPanel')?.classList.contains('open')) {
    _openBinderDetailRender(_binderDetailSpecies);
  }
}

// ── Binder detail panel ───────────────────────────────────────────────────

function openBinderDetail(species) {
  _binderDetailSpecies = species;
  if (!_binderBodyCache[species]) renderBinderPage();
  _openBinderDetailRender(species);
  const panel = $('binderDetailPanel');
  const overlay = $('binderDetailOverlay');
  if (panel) panel.classList.add('open');
  if (overlay) overlay.classList.add('open');
  if (panel) {
    panel.scrollTop = 0;
    const body = panel.querySelector('.binder-detail-body');
    if (body) body.scrollTop = 0;
  }
  document.body.style.overflow = 'hidden'; // lock background scroll (iOS)
}

function _openBinderDetailRender(species) {
  const c = _binderBodyCache[species];
  if (!c) return;
  const { dexNum, tier, haveInGroup, total, bodyHtml, inlineActions, hasOverride } = c;
  const numStr = isFinite(dexNum) ? '#' + String(dexNum).padStart(4, '0') : '';
  const el = id => document.getElementById(id);
  if (el('binderDetailNum'))    el('binderDetailNum').textContent    = numStr;
  if (el('binderDetailName'))   el('binderDetailName').textContent   = species;
  if (el('binderDetailSub'))    el('binderDetailSub').textContent    = `${total} card${total !== 1 ? 's' : ''} · ${haveInGroup}/${total} have one`;
  const statusEl = el('binderDetailStatus');
  if (statusEl) {
    statusEl.className   = `binder-detail-status ${tier === 0 ? 'need' : 'have'}`;
    statusEl.textContent = tier === 0 ? 'Need' : 'Have one';
  }
  const sprite = el('binderDetailSprite');
  if (sprite) {
    sprite.onerror = () => { sprite.style.display = 'none'; };
    if (isFinite(dexNum)) {
      sprite.style.display = '';
      sprite.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${dexNum}.png`;
    } else {
      sprite.style.display = 'none';
    }
  }
  if (el('binderDetailActions')) el('binderDetailActions').innerHTML = inlineActions || '';
  if (el('binderDetailBody'))    el('binderDetailBody').innerHTML    = _buildBinderPanelBody(c.items || [], c.setBuckets);
  // Keep rename button's data-species in sync so _handleBinderClick finds it
  const renameBtn = el('binderDetailRename');
  if (renameBtn) renameBtn.dataset.species = species;
}

function closeBinderDetail() {
  _binderDetailSpecies = null;
  $('binderDetailPanel')?.classList.remove('open');
  $('binderDetailOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}

// ── Fetches fresh market prices for all binder cards using 3 concurrent workers.
// Price cells update in-place as each card arrives; full re-render fires at the end.
// Collectrics (grading data) is skipped — only PC + TCGPlayer needed for binder prices.
async function binderFetchAllPrices(btn, { silent = false } = {}) {
  if (btn.dataset.running === 'true') return;
  const ids = [...new Set(fullArtBinder.map(b => b.id))];
  const cards = ids.map(id => getCardById(id)).filter(Boolean);
  if (!cards.length) return;

  btn.dataset.running = 'true';
  if (!silent) btn.disabled = true;
  const total = cards.length;
  let done = 0;
  const queue = [...cards];
  const binderEl = document.getElementById('pageBinder');

  function applyPrice(card, data) {
    if (!data) return;
    setCachedPrice(card.i, data);
    const usd = data.pcUngraded || data.market || data.mid || card.p || 0;
    const gbp = usdToGbp(usd);
    const priceStr = gbp > 0 ? `£${gbp.toFixed(2)}` : '—';
    // Grid detail view
    document.querySelectorAll(`.binder-pg-card[data-id="${CSS.escape(card.i)}"] .binder-pg-card-price`)
      .forEach(el => { el.textContent = priceStr; });
    // Flat paired view
    document.querySelectorAll(`.bdl-row[data-id="${CSS.escape(card.i)}"] .bdl-price`)
      .forEach(el => { el.textContent = priceStr; });
  }

  async function worker() {
    while (queue.length > 0) {
      // Silent pre-fetch continues regardless of which page is shown.
      // Manual (non-silent) refresh stops if the user navigates away.
      if (!silent && binderEl?.style.display === 'none') break;
      const card = queue.shift();
      if (!card) break;
      if (!silent) btn.textContent = `${done}/${total} fetched…`;
      try {
        const data = await fetchFreshPriceData(card, { skipCollectrics: true });
        applyPrice(card, data);
      } catch (_) {}
      done++;
    }
  }

  // 6 concurrent workers — PC+TCGPlayer now fire in parallel per card so
  // individual latency is lower; more workers keeps the pipeline full.
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);

  if (!silent) {
    btn.textContent = 'Refresh prices';
    btn.disabled = false;
  }
  delete btn.dataset.running;
  localStorage.setItem(BINDER_REFRESH_KEY, String(Date.now()));
  renderBinderPage();
}

const BINDER_REFRESH_KEY = 'pkm-binder-refresh-ts'; // device-local, not synced

// Returns the timestamp (ms) for 6AM UTC today (= 6AM GMT).
function _last6AMGMT() {
  const now = new Date();
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0, 0));
  if (now < t) t.setUTCDate(t.getUTCDate() - 1);
  return t.getTime();
}

// ── Global 7AM price refresh ───────────────────────────────────────────────
// Every morning at 7AM the entire price cache is re-fetched in the background.
// This means every card price site-wide reflects the live 7AM market price.
// If the user opens an individual card and refreshes manually, that card's
// timestamp updates immediately and is shown on the live price panel.

const GLOBAL_REFRESH_KEY = 'pkm-global-refresh-ts'; // device-local, not synced

function _shouldGlobalRefresh() {
  const last = parseInt(localStorage.getItem(GLOBAL_REFRESH_KEY) || '0', 10);
  return last < _last6AMGMT();
}

function _markGlobalRefreshed() {
  localStorage.setItem(GLOBAL_REFRESH_KEY, String(Date.now()));
}

// All card IDs worth refreshing: tracked (portfolio/wishlist/watchlist) + binder + anything
// already in the price cache so previously-browsed cards stay current too.
function _allRefreshIds() {
  const ids = new Set();
  try { (portfolio  || []).forEach(p => p && p.id && ids.add(p.id)); } catch {}
  try { (wishlist   || []).forEach(w => w && w.id && ids.add(w.id)); } catch {}
  try { (watchlist  || []).forEach(w => w && w.id && ids.add(w.id)); } catch {}
  try { (fullArtBinder || []).forEach(b => b && b.id && ids.add(b.id)); } catch {}
  try { Object.keys(getPriceCache()).forEach(id => ids.add(id)); } catch {}
  return [...ids].filter(Boolean);
}

let _globalRefreshRunning = false;

async function _globalSilentRefresh() {
  if (_globalRefreshRunning || !cardData) return;
  const ids = _allRefreshIds();
  if (!ids.length) return;
  _globalRefreshRunning = true;
  const queue = [...ids];
  const CONCURRENCY = 4;
  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      try { await psRefreshOne(id); } catch {}
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  _globalRefreshRunning = false;
}

// Auto-trigger if 7AM boundary has passed since last global refresh.
// Called once at app start; also triggered on page focus so an open tab
// that crosses 7AM picks it up on next interaction.
function _globalRefreshIfDue() {
  if (!_shouldGlobalRefresh()) return;
  _markGlobalRefreshed();
  _globalSilentRefresh();
}

// ── Binder background pre-fetch ────────────────────────────────────────────
// Runs at app startup and when the binder page opens. Fetches all binder
// card prices silently if they haven't been refreshed since today's 6AM GMT.
// Silent runs continue in the background even when the binder page is hidden.
function _binderAutoRefresh() {
  const btn = $('binderRefreshPricesBtn');
  if (!btn || btn.dataset.running === 'true') return;
  if (!fullArtBinder.length) return;
  const lastRefresh = parseInt(localStorage.getItem(BINDER_REFRESH_KEY) || '0', 10);
  const stale = lastRefresh < _last6AMGMT();
  const hasUncached = fullArtBinder.some(b => !getLastKnownPrice(b.id));
  if (!stale && !hasUncached) return;
  binderFetchAllPrices(btn, { silent: true });
}

function toggleCardInWishlist(id) {
  const card = id ? (getCardById(id)) : selectedCard;
  if (!card) return;
  const idx = wishlist.findIndex(w => w.id === card.i);
  if (idx >= 0) {
    wishlist.splice(idx, 1);
  } else {
    const currentUSD = getCurrentPrice(card);
    const currentGBP = usdToGbp(currentUSD);
    // Default target: 15% below current price
    const targetGBP = +(currentGBP * 0.85).toFixed(2);
    wishlist.push({
      id: card.i,
      name: card.n,
      set: card.s,
      lang: card.lang || 'EN',
      img: getCardImg(card),
      addedDate: new Date().toISOString(),
      addedPriceGBP: currentGBP,
      targetGBP: targetGBP,
    });
  }
  saveWishlist();
  renderWishlist();
  updateWishlistButton();
}

function updateWishlistButton() {
  const btn = $('addWishlistBtn');
  if (!btn || !selectedCard) return;
  const inList = wishlist.some(w => w.id === selectedCard.i);
  btn.classList.toggle('in-wishlist', inList);
  btn.title = inList ? 'Remove from wishlist' : 'Add to wishlist';
}

function saveWishlist() {
  localStorage.setItem('pkm-wishlist', JSON.stringify(wishlist));
  _recoCached = null;
}

function renderWishlist() {
  const list = $('wishlistList');
  const countEl = $('wishlistCount');
  const totalEl = $('wishlistTotal');
  if (!list) return;

  if (wishlist.length === 0) {
    list.innerHTML = '<div class="portfolio-empty">No wishlisted cards yet. Open a card and tap the heart icon to add it. Set a target price to get a BUY alert when the market drops below it.</div>';
    countEl.style.display = 'none';
    totalEl.textContent = '0 cards · £0';
    return;
  }

  countEl.textContent = wishlist.length;
  countEl.style.display = 'flex';

  let totalCurrent = 0;
  let alertCount = 0;
  const items = wishlist.map(w => {
    const currentCard = getCardById(w.id);
    const cached = getCachedPrice(w.id);
    const currentUSD = cached
      ? (cached.pcUngraded || cached.market || cached.mid || (currentCard ? currentCard.p : 0))
      : (currentCard ? currentCard.p : 0);
    const currentGBP = usdToGbp(currentUSD);
    totalCurrent += currentGBP;
    const target = w.targetGBP || 0;
    let alertClass = 'alert-far', alertLabel = 'Watching';
    let rowClass = '';
    if (target > 0) {
      if (currentGBP <= target) {
        alertClass = 'alert-buy';
        alertLabel = 'BUY NOW';
        alertCount++;
        rowClass = 'alert-buy';
      } else if (currentGBP <= target * 1.10) {
        alertClass = 'alert-watch';
        alertLabel = 'Close';
      }
    }
    return `
      <div class="wishlist-item-card ${rowClass}" data-id="${w.id}">
        <div class="wishlist-item ${rowClass}" data-id="${w.id}">
          ${w.img ? `<img class="wishlist-item-img" src="${_hiresUrl(w.img)}" alt="" loading="lazy" decoding="async" onerror="_onImgError(this)">` : '<div class="wishlist-item-img"></div>'}
          <div class="wishlist-item-info">
            <div class="wishlist-item-name">${esc(w.name)}</div>
            <div class="wishlist-item-meta">
              <span>${esc(w.set)}</span>
              <span class="lang-pill">${w.lang === 'JP' ? '🇯🇵 JP' : '🇬🇧 EN'}</span>
              <span class="wishlist-alert ${alertClass}">${alertLabel}</span>
              ${piRenderButton(w.id, currentUSD)}
            </div>
          </div>
          <div class="wishlist-target">
            <div class="wishlist-current">£${currentGBP.toFixed(2)}</div>
            <input class="wishlist-target-input" type="number" step="0.01" min="0" value="${target.toFixed(2)}" data-id="${w.id}" title="Target price (GBP)">
            <div class="wishlist-target-label">Target £</div>
          </div>
          <button class="wishlist-remove" data-id="${w.id}" title="Remove">✕</button>
        </div>
        ${piRenderPanel(w.id)}
      </div>
    `;
  });
  list.innerHTML = items.join('');
  totalEl.textContent = `${wishlist.length} cards · £${totalCurrent.toFixed(2)}` + (alertCount > 0 ? ` · ${alertCount} BUY` : '');

  piWireToggles(list);
}

// =============================================================
// Compare (English vs Japanese, or any two cards)
// =============================================================
let compareSlots = JSON.parse(localStorage.getItem('pkm-compare') || '[null, null]');
if (!Array.isArray(compareSlots) || compareSlots.length !== 2) compareSlots = [null, null];

function openComparePanel() {
  const panel = $('comparePanel'), overlay = $('compareOverlay');
  if (panel) { panel.style.display = 'flex'; panel.setAttribute('aria-hidden', 'false'); }
  if (overlay) { overlay.style.display = 'block'; overlay.setAttribute('aria-hidden', 'false'); }
  document.body.style.overflow = 'hidden';
}
function closeComparePanel() {
  const panel = $('comparePanel'), overlay = $('compareOverlay');
  if (panel) { panel.style.display = 'none'; panel.setAttribute('aria-hidden', 'true'); }
  if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
  document.body.style.overflow = '';
}

function setupCompare() {
  $('compareToggle').addEventListener('click', () => {
    $('comparePanel')?.style.display !== 'none' ? closeComparePanel() : openComparePanel();
  });
  $('compareClose')?.addEventListener('click', closeComparePanel);
  $('compareOverlay')?.addEventListener('click', closeComparePanel);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('comparePanel')?.style.display !== 'none') closeComparePanel();
  });
  $('addCompareBtn').addEventListener('click', toggleCardInCompare);
  renderCompare();
}

function toggleCardInCompare() {
  if (!selectedCard) return;
  const id = selectedCard.i;
  // If already pinned, remove it
  const slot = compareSlots.findIndex(s => s && s.id === id);
  if (slot >= 0) {
    compareSlots[slot] = null;
  } else {
    // Fill first empty slot, otherwise replace slot B
    const empty = compareSlots.findIndex(s => !s);
    const targetSlot = empty >= 0 ? empty : 1;
    compareSlots[targetSlot] = snapshotCardForCompare(selectedCard);
  }
  saveCompare();
  renderCompare();
  updateCompareButton();
  // Auto-open when 2 cards are pinned
  if (compareSlots[0] && compareSlots[1]) openComparePanel();
}

function snapshotCardForCompare(card) {
  const currentUSD = getCurrentPrice(card);
  const cached = getCachedPrice(card.i);
  // Pull cost
  let pullCost = 7.65;
  let packsNeeded = 0;
  if (setsData && setsData[card.sc]) {
    const set = setsData[card.sc];
    const rarity = set.rarities?.[card.rc];
    if (rarity && rarity.pullRate > 0) {
      const packsPerHit = Math.round(1 / rarity.pullRate);
      packsNeeded = packsPerHit * (rarity.count || 1);
      pullCost = packsNeeded / 100;
    }
  }
  const des = autoFillDesirability(card, pullCost);
  const signal = computeSignal(card, pullCost, des.total);
  return {
    id: card.i,
    name: card.n,
    set: card.s,
    sc: card.sc,
    lang: card.lang || 'EN',
    rc: card.rc,
    cn: card.cn,
    img: getCardImg(card),
    priceUSD: currentUSD,
    psa10: cached?.pcPsa10 || card.p10 || 0,
    gemPct: cached?.crGemRate || card.g || 0,
    pullCost: pullCost,
    packsNeeded: packsNeeded,
    desirability: des.total,
    charScore: des.char,
    artScore: des.art,
    appealScore: des.appeal,
    signal: signal?.signal || '',
  };
}

function updateCompareButton() {
  const btn = $('addCompareBtn');
  const countEl = $('compareCount');
  const filled = compareSlots.filter(Boolean).length;
  if (countEl) {
    countEl.textContent = filled;
    countEl.style.display = filled > 0 ? 'flex' : 'none';
  }
  if (!btn || !selectedCard) return;
  const slot = compareSlots.findIndex(s => s && s.id === selectedCard.i);
  btn.classList.toggle('in-compare', slot >= 0);
  if (slot >= 0) {
    btn.dataset.slot = slot === 0 ? 'A' : 'B';
    btn.title = `Pinned as Slot ${slot === 0 ? 'A' : 'B'} — tap to unpin`;
  } else {
    btn.removeAttribute('data-slot');
    const empty = compareSlots.findIndex(s => !s);
    btn.title = empty >= 0
      ? `Pin as Slot ${empty === 0 ? 'A' : 'B'}`
      : 'Replace Slot B';
  }
}

function saveCompare() {
  localStorage.setItem('pkm-compare', JSON.stringify(compareSlots));
}

function renderCompare() {
  const body = $('compareBody');
  if (!body) return;
  const filled = compareSlots.filter(Boolean).length;
  if (filled === 0) {
    body.innerHTML = '<div class="compare-empty">Open a card and tap the compare icon to add it as Slot A. Repeat for Slot B — you\'ll see a side-by-side breakdown with a winner verdict.</div>';
    return;
  }

  // Compute winner per metric (only when both slots filled)
  const both = filled === 2;
  const a = compareSlots[0], b = compareSlots[1];

  // Compute verdict
  let verdict = null;
  if (both) verdict = computeCompareVerdict(a, b);

  body.innerHTML = `
    <div class="compare-grid">
      ${renderCompareSlot(0, a, b, verdict)}
      ${renderCompareSlot(1, b, a, verdict)}
    </div>
    ${verdict ? `
      <div class="compare-verdict">
        <span class="compare-verdict-badge ${verdict.badgeClass}">${verdict.badge}</span>
        <div>${verdict.summary}</div>
      </div>
    ` : ''}
  `;

  body.querySelectorAll('.compare-slot[data-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.compare-slot-remove')) return;
      selectCard(el.dataset.id);
    });
  });
  body.querySelectorAll('.compare-slot-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      compareSlots[parseInt(btn.dataset.slot)] = null;
      saveCompare();
      renderCompare();
      updateCompareButton();
    });
  });
}

function renderCompareSlot(idx, slot, other, verdict) {
  const slotLabel = idx === 0 ? 'A' : 'B';
  if (!slot) {
    return `<div class="compare-slot empty"><div class="compare-slot-label">Slot ${slotLabel}</div><div>Open a card and tap the compare icon to fill this slot.</div></div>`;
  }

  const isWinner = verdict && verdict.winner === slotLabel.toLowerCase();
  const priceGBP = usdToGbp(slot.priceUSD);

  // Compute stat winners (lower price/pull-cost wins; higher gem% wins; higher desirability wins)
  function statRowCls(metric, lower) {
    if (!other) return '';
    const v1 = slot[metric] || 0, v2 = other[metric] || 0;
    if (v1 === v2) return '';
    if (lower) return v1 < v2 ? 'winner' : '';
    return v1 > v2 ? 'winner' : '';
  }
  function statRowClsCustom(predicate) {
    if (!other) return '';
    return predicate(slot, other) ? 'winner' : '';
  }

  return `
    <div class="compare-slot ${isWinner ? 'is-winner' : ''}" data-id="${slot.id}">
      <button class="compare-slot-remove" data-slot="${idx}" title="Remove">✕</button>
      <div class="compare-slot-label">Slot ${slotLabel} · ${slot.lang === 'JP' ? '🇯🇵 Japanese' : '🇬🇧 English'}</div>
      <div class="compare-card-row">
        ${slot.img ? `<img class="compare-card-img" src="${_hiresUrl(slot.img)}" alt="" loading="lazy" decoding="async" onerror="_onImgError(this)">` : '<div class="compare-card-img"></div>'}
        <div class="compare-card-info">
          <div class="compare-card-name">${esc(slot.name)}</div>
          <div class="compare-card-meta">${esc(slot.set)}${slot.cn ? ` · #${slot.cn}` : ''}${slot.rc ? ` · ${slot.rc}` : ''}</div>
        </div>
      </div>
      <div class="compare-stats">
        <div class="compare-stat-row ${statRowClsCustom((s, o) => s.priceUSD > 0 && (o.priceUSD === 0 || s.priceUSD < o.priceUSD))}">
          <span class="compare-stat-label">Market price</span>
          <span class="compare-stat-value">£${priceGBP.toFixed(2)}</span>
        </div>
        <div class="compare-stat-row ${statRowClsCustom((s, o) => s.psa10 > 0 && (o.psa10 === 0 || s.psa10 > o.psa10))}">
          <span class="compare-stat-label">PSA 10 ceiling</span>
          <span class="compare-stat-value">${slot.psa10 > 0 ? `£${usdToGbp(slot.psa10).toFixed(2)}` : '—'}</span>
        </div>
        <div class="compare-stat-row ${statRowClsCustom((s, o) => s.gemPct > 0 && (o.gemPct === 0 || s.gemPct > o.gemPct))}">
          <span class="compare-stat-label">Gem rate</span>
          <span class="compare-stat-value">${slot.gemPct > 0 ? `${(slot.gemPct * 100).toFixed(1)}%` : '—'}</span>
        </div>
        <div class="compare-stat-row ${statRowClsCustom((s, o) => s.psa10 > s.priceUSD && o.psa10 > 0 && (s.psa10 / Math.max(s.priceUSD, 1)) > (o.psa10 / Math.max(o.priceUSD, 1)))}">
          <span class="compare-stat-label">PSA 10 multiplier</span>
          <span class="compare-stat-value">${slot.priceUSD > 0 && slot.psa10 > 0 ? `${(slot.psa10 / slot.priceUSD).toFixed(2)}×` : '—'}</span>
        </div>
        <div class="compare-stat-row ${statRowClsCustom((s, o) => s.packsNeeded > 0 && (o.packsNeeded === 0 || s.packsNeeded < o.packsNeeded))}">
          <span class="compare-stat-label">Packs to pull</span>
          <span class="compare-stat-value">${slot.packsNeeded > 0 ? slot.packsNeeded.toLocaleString() : '—'}</span>
        </div>
        <div class="compare-stat-row ${statRowClsCustom((s, o) => s.desirability > o.desirability)}">
          <span class="compare-stat-label">Desirability</span>
          <span class="compare-stat-value">${slot.desirability ? slot.desirability.toFixed(1) : '—'}</span>
        </div>
        ${slot.signal ? `
        <div class="compare-stat-row">
          <span class="compare-stat-label">Signal</span>
          <span class="compare-stat-value">${slot.signal}</span>
        </div>` : ''}
      </div>
    </div>
  `;
}

function computeCompareVerdict(a, b) {
  // Score model: cheaper price + higher gem rate + higher PSA10 multiplier + higher desirability = better value
  const priceA = a.priceUSD || 0, priceB = b.priceUSD || 0;
  const multA = priceA > 0 && a.psa10 > 0 ? a.psa10 / priceA : 0;
  const multB = priceB > 0 && b.psa10 > 0 ? b.psa10 / priceB : 0;
  const gemA = a.gemPct || 0, gemB = b.gemPct || 0;
  const desA = a.desirability || 0, desB = b.desirability || 0;

  let scoreA = 0, scoreB = 0;
  // Cheaper market price = +1
  if (priceA > 0 && priceB > 0) { if (priceA < priceB) scoreA += 1; else scoreB += 1; }
  // Higher PSA 10 multiplier = +2 (most important for value)
  if (multA > 0 || multB > 0) { if (multA > multB) scoreA += 2; else scoreB += 2; }
  // Higher gem rate = +1
  if (gemA > 0 || gemB > 0) { if (gemA > gemB) scoreA += 1; else scoreB += 1; }
  // Higher desirability = +1
  if (desA > desB) scoreA += 1; else scoreB += 1;
  // Fewer packs to pull = +1
  if (a.packsNeeded > 0 && b.packsNeeded > 0) { if (a.packsNeeded < b.packsNeeded) scoreA += 1; else scoreB += 1; }

  let winner = 'tie', badge = 'TIE', badgeClass = 'cv-tie', summary = '';
  if (scoreA === scoreB) {
    summary = `Both cards score evenly on value, gem rate, and desirability. Pick the one you'd rather own — collector preference matters more than the spreadsheet here.`;
  } else {
    winner = scoreA > scoreB ? 'a' : 'b';
    const W = winner === 'a' ? a : b, L = winner === 'a' ? b : a;
    badge = winner === 'a' ? 'SLOT A WINS' : 'SLOT B WINS';
    badgeClass = (W.lang === 'EN') ? 'cv-en' : 'cv-jp';

    // Build summary based on what made it win
    const reasons = [];
    const wPrice = usdToGbp(W.priceUSD), lPrice = usdToGbp(L.priceUSD);
    if (W.priceUSD > 0 && L.priceUSD > 0 && W.priceUSD < L.priceUSD) {
      const pct = ((L.priceUSD - W.priceUSD) / L.priceUSD * 100).toFixed(0);
      reasons.push(`<strong>${pct}% cheaper</strong> at £${wPrice.toFixed(2)} vs £${lPrice.toFixed(2)}`);
    }
    const wMult = W.priceUSD > 0 && W.psa10 > 0 ? W.psa10 / W.priceUSD : 0;
    const lMult = L.priceUSD > 0 && L.psa10 > 0 ? L.psa10 / L.priceUSD : 0;
    if (wMult > 0 && lMult > 0 && wMult > lMult) {
      reasons.push(`stronger PSA 10 ceiling (${wMult.toFixed(2)}× vs ${lMult.toFixed(2)}×)`);
    }
    if (W.gemPct > L.gemPct && W.gemPct > 0) {
      reasons.push(`higher gem rate (${(W.gemPct * 100).toFixed(1)}% vs ${(L.gemPct * 100).toFixed(1)}%)`);
    }
    if (W.packsNeeded > 0 && L.packsNeeded > 0 && W.packsNeeded < L.packsNeeded) {
      reasons.push(`fewer packs to pull (${W.packsNeeded.toLocaleString()} vs ${L.packsNeeded.toLocaleString()})`);
    }
    const langName = W.lang === 'JP' ? 'Japanese' : 'English';
    const otherLang = L.lang === 'JP' ? 'Japanese' : 'English';
    const head = (a.lang !== b.lang)
      ? `The <strong>${langName}</strong> version edges it.`
      : `<strong>${esc(W.name)}</strong> takes it.`;
    summary = `${head} ${reasons.length > 0 ? 'Wins on ' + reasons.slice(0, 3).join(', ') + '.' : 'Marginal advantage on the combined value model.'}`;
    if (a.lang !== b.lang) {
      summary += ` If you collect for art and prefer ${otherLang} aesthetic, the gap may be worth paying for — but on pure numbers, ${langName} wins.`;
    }
  }
  return { winner, badge, badgeClass, summary };
}

// ---- Events ----
function setupInputs() {
  ['packRate','cardsInTier','characterPremium','artworkHype','universalAppeal','ebayPrice','dealShipping']
    .forEach(id => $(id)?.addEventListener('input', updateAll));
  const dealGradeEl = $('dealGrade');
  if (dealGradeEl) dealGradeEl.addEventListener('change', updateAll);
  const maxBuyGradeEl = $('maxBuyGrade');
  if (maxBuyGradeEl) maxBuyGradeEl.addEventListener('change', updateAll);
}

// ================================================================
// ---- Card Screener ----
// ================================================================
let screenerData = [];  // last scan results
let screenerSort = { col: 'model', dir: 'desc' };
let screenerLang = 'all';

function computeCardRow(c) {
  // Pull cost
  let pullCost = 7.65;
  if (setsData && setsData[c.sc]) {
    const set = setsData[c.sc];
    const rarity = set.rarities?.[c.rc];
    if (rarity && rarity.pullRate > 0) {
      const packsPerHit = Math.round(1 / rarity.pullRate);
      pullCost = (packsPerHit * rarity.count) / 100;
    }
  }
  // Desirability
  const des = autoFillDesirability(c, pullCost);
  // Model prediction
  const { priceUSD } = predictPrice(pullCost, des.total);
  // Market raw
  const raw = getCurrentPrice(c);
  // PSA 10
  const psa10 = c.p10 || 0;
  // Max buy = model price in USD
  const maxBuy = priceUSD;
  // Signal
  const sig = computeSignal(c, pullCost, des.total);
  return {
    id: c.i, name: c.n, set: c.s, cn: c.cn, lang: c.lang || 'EN',
    char: des.char, art: des.art, appeal: des.appeal,
    pull: pullCost, model: priceUSD, maxBuy, raw, psa10,
    signal: sig?.signal || 'HOLD', score: sig?.score || 0
  };
}

function runScreener() {
  if (!cardData || !cardData.cards) return;
  const btn = $('sfScanBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  $('screenerStatus').textContent = 'Scanning 26k+ cards...';
  $('screenerResults').style.display = 'none';

  // Helper: read slider range (returns null if at default extreme)
  function sliderVal(id) {
    const el = $(id);
    const v = parseFloat(el.value);
    const isLo = el.classList.contains('sf-thumb-lo');
    if (isLo && v <= parseFloat(el.min)) return null;
    if (!isLo && v >= parseFloat(el.max)) return null;
    return v;
  }
  // Helper: parse price dropdown "lo,hi" value
  function priceRange(id) {
    const v = $(id).value;
    if (!v) return { min: null, max: null };
    const parts = v.split(',');
    return { min: parts[0] ? parseFloat(parts[0]) : null, max: parts[1] ? parseFloat(parts[1]) : null };
  }
  const modelP = priceRange('sfModelRange');
  const buyP = priceRange('sfBuyRange');
  const rawP = priceRange('sfRawRange');
  const psa10P = priceRange('sfPsa10Range');

  // Read filters
  const f = {
    charMin: sliderVal('sfCharMin'), charMax: sliderVal('sfCharMax'),
    artMin: sliderVal('sfArtMin'), artMax: sliderVal('sfArtMax'),
    appealMin: sliderVal('sfAppealMin'), appealMax: sliderVal('sfAppealMax'),
    pullMin: sliderVal('sfPullMin'), pullMax: sliderVal('sfPullMax'),
    modelMin: modelP.min, modelMax: modelP.max,
    buyMin: buyP.min, buyMax: buyP.max,
    rawMin: rawP.min, rawMax: rawP.max,
    psa10Min: psa10P.min, psa10Max: psa10P.max,
    signal: $('sfSignal').value || null,
    rarity: $('sfRarity').value || null,
    lang: screenerLang,
  };

  // Check if at least one filter is set
  const hasFilter = Object.entries(f).some(([k, v]) => {
    if (k === 'lang' && v === 'all') return false;
    return v !== null && v !== '';
  });
  if (!hasFilter) {
    btn.disabled = false;
    btn.textContent = 'Scan Cards';
    $('screenerStatus').textContent = 'Set at least one filter to scan.';
    return;
  }

  // Use setTimeout so the UI updates before the heavy loop
  setTimeout(() => {
    const results = [];
    const cards = cardData.cards;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      // Language filter
      const cLang = c.lang || 'EN';
      if (f.lang !== 'all' && cLang !== f.lang) continue;

      // Rarity filter (before expensive computeCardRow)
      if (f.rarity) {
        const allowed = f.rarity.split(',');
        if (!allowed.includes(c.rc)) continue;
      }

      const row = computeCardRow(c);

      // Apply filters
      if (f.charMin != null && row.char < f.charMin) continue;
      if (f.charMax != null && row.char > f.charMax) continue;
      if (f.artMin != null && row.art < f.artMin) continue;
      if (f.artMax != null && row.art > f.artMax) continue;
      if (f.appealMin != null && row.appeal < f.appealMin) continue;
      if (f.appealMax != null && row.appeal > f.appealMax) continue;
      if (f.pullMin != null && row.pull < f.pullMin) continue;
      if (f.pullMax != null && row.pull > f.pullMax) continue;
      if (f.modelMin != null && row.model < f.modelMin) continue;
      if (f.modelMax != null && row.model > f.modelMax) continue;
      if (f.buyMin != null && row.maxBuy < f.buyMin) continue;
      if (f.buyMax != null && row.maxBuy > f.buyMax) continue;
      if (f.rawMin != null && row.raw < f.rawMin) continue;
      if (f.rawMax != null && row.raw > f.rawMax) continue;
      if (f.psa10Min != null && row.psa10 < f.psa10Min) continue;
      if (f.psa10Max != null && row.psa10 > f.psa10Max) continue;
      if (f.signal && row.signal !== f.signal) continue;

      results.push(row);
    }

    screenerData = results;
    sortScreenerData();
    renderScreenerTable();

    btn.disabled = false;
    btn.textContent = 'Scan Cards';
    $('screenerStatus').textContent = `${results.length.toLocaleString()} cards found`;
    $('screenerResults').style.display = results.length > 0 ? '' : 'none';
  }, 50);
}

function sortScreenerData() {
  const { col, dir } = screenerSort;
  const mult = dir === 'asc' ? 1 : -1;
  screenerData.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === 'string') return mult * va.localeCompare(vb);
    return mult * ((va || 0) - (vb || 0));
  });
}

function renderScreenerTable() {
  const tbody = $('screenerTableBody');
  // Cap at 200 rows for performance
  const rows = screenerData.slice(0, 200);
  const fmtD = v => v?.toFixed(1) ?? '—';
  const fmtP = v => v > 0 ? '$' + v.toFixed(0) : '—';

  tbody.innerHTML = rows.map(r => {
    const sigCls = r.signal === 'STRONG BUY' ? 'st-strong-buy'
      : r.signal === 'BUY' ? 'st-buy'
      : r.signal === 'SELL' ? 'st-sell' : 'st-hold';
    const langBadge = r.lang === 'JP' ? '<span style="color:var(--text-faint);font-size:9px"> JP</span>' : '';
    return `<tr data-id="${r.id}">
      <td class="st-name-cell">${r.name}${langBadge}<br><span class="st-name-sub">${r.set} #${r.cn || '?'}</span></td>
      <td class="st-num">${fmtD(r.char)}</td>
      <td class="st-num">${fmtD(r.art)}</td>
      <td class="st-num">${fmtD(r.appeal)}</td>
      <td class="st-num">${r.pull.toFixed(2)}</td>
      <td class="st-num">${fmtP(r.model)}</td>
      <td class="st-num">${fmtP(r.maxBuy)}</td>
      <td class="st-num">${fmtP(r.raw)}</td>
      <td class="st-num">${fmtP(r.psa10)}</td>
      <td><span class="st-signal ${sigCls}">${r.signal}</span></td>
    </tr>`;
  }).join('');

  if (screenerData.length > 200) {
    $('screenerStatus').textContent += ` (showing first 200)`;
  }

  // Row click → select card + close panel
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      closeScreener();
      selectCard(tr.dataset.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function openScreener() {
  $('screenerPanel').classList.add('open');
  $('screenerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeScreener() {
  $('screenerPanel').classList.remove('open');
  $('screenerOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function setupScreener() {
  // Open/close panel
  $('filterFab').addEventListener('click', openScreener);
  $('spClose').addEventListener('click', closeScreener);
  $('screenerOverlay').addEventListener('click', closeScreener);

  // Escape key closes panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('screenerPanel').classList.contains('open')) closeScreener();
  });

  // Scan button
  $('sfScanBtn').addEventListener('click', runScreener);

  // --- Dual-range slider init ---
  function initDualRange(group) {
    const lo = group.querySelector('.sf-thumb-lo');
    const hi = group.querySelector('.sf-thumb-hi');
    const fill = group.querySelector('.sf-fill');
    const valsEl = group.querySelector('.sf-slider-vals');
    function update() {
      const min = parseFloat(lo.min), max = parseFloat(lo.max);
      let loV = parseFloat(lo.value), hiV = parseFloat(hi.value);
      if (loV > hiV) { // clamp
        if (document.activeElement === lo) { lo.value = hiV; loV = hiV; }
        else { hi.value = loV; hiV = loV; }
      }
      const loPct = ((loV - min) / (max - min)) * 100;
      const hiPct = ((hiV - min) / (max - min)) * 100;
      fill.style.left = loPct + '%';
      fill.style.width = (hiPct - loPct) + '%';
      const isDefault = loV <= min && hiV >= max;
      if (valsEl) {
        valsEl.textContent = isDefault ? 'Any' : loV.toFixed(1) + ' – ' + hiV.toFixed(1);
        valsEl.classList.toggle('sf-active', !isDefault);
      }
    }
    lo.addEventListener('input', update);
    hi.addEventListener('input', update);
    update();
  }
  document.querySelectorAll('.sf-slider-group').forEach(initDualRange);

  // Clear button
  $('sfClearBtn').addEventListener('click', () => {
    // Reset sliders to defaults
    document.querySelectorAll('.sf-thumb').forEach(el => {
      el.value = el.classList.contains('sf-thumb-lo') ? el.min : el.max;
    });
    // Re-run slider visuals
    document.querySelectorAll('.sf-slider-group').forEach(g => {
      const fill = g.querySelector('.sf-fill');
      fill.style.left = '0%'; fill.style.width = '100%';
      const vals = g.querySelector('.sf-slider-vals');
      if (vals) { vals.textContent = 'Any'; vals.classList.remove('sf-active'); }
    });
    // Reset dropdowns
    ['sfModelRange','sfBuyRange','sfRawRange','sfPsa10Range','sfSignal','sfRarity'].forEach(id => $(id).value = '');
    screenerData = [];
    $('screenerResults').style.display = 'none';
    $('screenerStatus').textContent = '';
  });

  // Language filter buttons
  document.querySelectorAll('.sf-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sf-lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      screenerLang = btn.dataset.lang;
    });
  });

  // Sortable column headers
  document.querySelectorAll('.st-sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (screenerSort.col === col) {
        screenerSort.dir = screenerSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        screenerSort.col = col;
        screenerSort.dir = 'desc';
      }
      document.querySelectorAll('.st-sortable').forEach(h => {
        h.classList.remove('st-sorted-asc', 'st-sorted-desc');
      });
      th.classList.add(screenerSort.dir === 'asc' ? 'st-sorted-asc' : 'st-sorted-desc');
      sortScreenerData();
      renderScreenerTable();
    });
  });

  // Enter key triggers scan
  $('screenerFilters').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runScreener();
  });
}

// ---- Value Picks ----
let vpFilter = 'all';

function scanValuePicks(filter) {
  if (!cardData || !cardData.cards) return [];

  const cards = cardData.cards;
  const GRADING_COST_USD = 30; // ~£25 PSA grading cost

  const scored = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (c.p < 5) continue; // only cards with meaningful market value
    if (filter === 'EN' && c.lang === 'JP') continue;
    if (filter === 'JP' && c.lang !== 'JP') continue;

    const charMult = getCharacterMultiplier(c.n);
    if (charMult < 1.1) continue;

    const rarityInfo = RARITY_RATES[c.rc] || RARITY_RATES[''];
    const rarityRate = rarityInfo.base;
    if (rarityRate < 0.10) continue;

    const marketPrice = c.p;

    // ---- Grading arbitrage (primary value signal) ----
    const psa10 = (c.p10 && c.p10 > 0) ? c.p10 : 0;
    const gradingRatio = psa10 > 0 ? psa10 / marketPrice : 0;
    const gradingProfit = psa10 > 0 ? psa10 - marketPrice - GRADING_COST_USD : 0;
    const gradingROI = psa10 > 0 ? gradingProfit / (marketPrice + GRADING_COST_USD) : 0;

    // Need either good grading potential OR strong character at reasonable price
    if (gradingROI < 0.3 && charMult < 1.3) continue;

    // ---- Pull cost (supply) ----
    let pullCost = 7.65;
    if (setsData && setsData[c.sc]) {
      const set = setsData[c.sc];
      const rarity = set.rarities && set.rarities[c.rc];
      if (rarity && rarity.pullRate > 0) {
        const packsPerHit = Math.round(1 / rarity.pullRate);
        const totalPacks = packsPerHit * rarity.count;
        pullCost = totalPacks / 100;
      }
    }

    // ---- Model price (character premium on top of market) ----
    const sf = Math.pow(PULL_MULT, pullCost);
    const impliedDes = Math.log(marketPrice / (BASE * sf)) / Math.log(DES_MULT);
    if (impliedDes < 1) continue; // market must show this is above bulk
    const charBoost = Math.min(0.8, (charMult - 1) * 1.2);
    const modelDes = Math.min(10, impliedDes + charBoost);
    const { priceUSD: modelPrice } = predictPrice(pullCost, modelDes);

    // ---- Set age (supply tightening) ----
    const ageMonths = getSetAgeMonths(c.sc);
    const ageFactor = ageMonths > 48 ? 1.35 : ageMonths > 24 ? 1.15 : ageMonths < 6 ? 0.8 : 1.0;

    // ---- Composite value score ----
    const gradingScore = gradingROI > 0 ? (1 + Math.min(gradingROI, 3)) : 1;
    const valueScore = gradingScore * charMult * ageFactor * (1 + rarityRate) * (modelPrice / marketPrice);

    // ---- Reasons ----
    const reasons = [];
    if (charMult >= 1.4) reasons.push('Fan favourite');
    else if (charMult >= 1.2) reasons.push('Popular character');
    if (gradingROI > 0.5) reasons.push('PSA 10: ' + gradingRatio.toFixed(1) + '× raw');
    if (ageMonths > 36) reasons.push('Proven set');
    if (rarityRate >= 0.20) reasons.push('Chase pull');

    // Target price: best realistic outcome (model or PSA 10)
    const targetPrice = psa10 > modelPrice ? psa10 : modelPrice;
    const upside = ((targetPrice / marketPrice - 1) * 100).toFixed(0);

    scored.push({
      card: c,
      marketPrice,
      modelPrice,
      targetPrice,
      psa10,
      ratio: targetPrice / marketPrice,
      upside,
      rarity: rarityInfo.label,
      pullCost,
      des: modelDes,
      valueScore,
      reasons: reasons.join(' · ') || 'Character premium',
      signal: targetPrice / marketPrice > 2 ? 'STRONG BUY' : 'BUY',
      signalCls: targetPrice / marketPrice > 2 ? 'signal-strong-buy' : 'signal-buy',
    });
  }

  scored.sort((a, b) => b.valueScore - a.valueScore);
  // Diversify: max 2 cards per character name
  const result = [];
  const charCount = {};
  for (const pick of scored) {
    const baseName = pick.card.n.replace(/ ex$/i, '').replace(/ V$/i, '').replace(/ VMAX$/i, '').replace(/ VSTAR$/i, '').replace(/ GX$/i, '').replace(/ EX$/i, '').replace(/ \(JP\)$/i, '').trim();
    charCount[baseName] = (charCount[baseName] || 0) + 1;
    if (charCount[baseName] <= 2) result.push(pick);
    if (result.length >= 10) break;
  }
  return result;
}

function renderValuePicks(filter) {
  const list = $('valuePicksList');
  const picks = scanValuePicks(filter || vpFilter);

  if (picks.length === 0) {
    list.innerHTML = '<div class="vp-loading">No standout value picks found for this filter</div>';
    return;
  }

  list.innerHTML = picks.map((p, i) => {
    const c = p.card;
    const isJP = c.lang === 'JP';
    const langBadge = isJP
      ? '<span class="vp-lang vp-jp">🇯🇵</span> '
      : '<span class="vp-lang vp-en">EN</span> ';
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const upsideClass = p.ratio > 1.5 ? 'big-upside' : 'med-upside';

    return `
      <div class="vp-item" data-id="${c.i}">
        <div class="vp-rank ${rankClass}">${i + 1}</div>
        <img class="vp-img" src="${getCardImg(c)}" alt="" loading="lazy" onerror="_onImgError(this)">
        <div class="vp-info">
          <div class="vp-name">${esc(c.n)}${hasCounterpart(c) ? `<span class="search-result-cp-flag" title="${isJP ? 'English' : 'Japanese'} counterpart available">⇄ ${isJP ? 'EN' : 'JP'}</span>` : ''}</div>
          <div class="vp-meta">${langBadge}${esc(c.s)} · ${p.rarity}</div>
        </div>
        <div class="vp-values">
          <div class="vp-market">Raw: ${fmtGBP(p.marketPrice)}</div>
          ${p.psa10 > 0 ? `<div class="vp-psa10">PSA 10: ${fmtGBP(p.psa10)}</div>` : `<div class="vp-model">Model: ${fmtGBP(p.modelPrice)}</div>`}
          <div class="vp-upside ${upsideClass}">↑${p.upside}%</div>
          <div class="vp-reasons">${p.reasons}</div>
          <span class="vp-signal ${p.signalCls}">${p.signal}</span>
        </div>
      </div>`;
  }).join('');

  // Click handler — select the card
  list.querySelectorAll('.vp-item').forEach(el => {
    el.addEventListener('click', () => {
      const cardId = el.dataset.id;
      if (cardId) {
        selectCard(cardId);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  // Enrich with live Collectrics data
  enrichValuePicksFromCollectrics(picks);
}

// ---- Live Collectrics enrichment for value picks ----
async function enrichValuePicksFromCollectrics(picks) {
  const proxyBase = 'https://api.codetabs.com/v1/proxy/?quest=';
  const items = document.querySelectorAll('.vp-item');

  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const c = p.card;
    const el = items[i];
    if (!el) continue;

    try {
      // Build search query: card name + card number if available
      const searchName = c.n.replace(/ \(JP\)$/i, '').trim();
      const q = c.cn ? `${searchName} #${c.cn}` : searchName;
      const apiUrl = `https://mycollectrics.com/api/search/cards?sort=raw_desc&limit=5&offset=0&q=${encodeURIComponent(q)}`;
      const proxyUrl = proxyBase + encodeURIComponent(apiUrl);

      const r = await fetch(proxyUrl);
      if (!r.ok) continue;
      const text = await r.text();
      let d;
      try { d = JSON.parse(text); } catch(pe) { continue; }
      
      if (!d.results || d.results.length === 0) continue;

      // Match: find the result that best matches our card
      const match = d.results.find(res => {
        const nameMatch = res['product-name']?.toLowerCase().includes(searchName.toLowerCase().split(' ')[0]);
        return nameMatch;
      }) || d.results[0];

      if (!match) continue;

      // Extract live data
      const liveRaw = match['raw-price'] || match['collectrics-raw-price'];
      const livePsa10 = match['psa-10-price'];
      const gemPct = match['psa-gem-pct'];
      const liveRatio = livePsa10 > 0 && liveRaw > 0 ? livePsa10 / liveRaw : 0;

      // Update the DOM with live Collectrics data
      const valuesDiv = el.querySelector('.vp-values');
      if (!valuesDiv) continue;

      // Update raw price
      const marketEl = valuesDiv.querySelector('.vp-market');
      if (marketEl && liveRaw > 0) {
        marketEl.innerHTML = `Raw: ${fmtGBP(liveRaw)} <span class="vp-live-tag">LIVE</span>`;
      }

      // Update PSA 10 price
      const psa10El = valuesDiv.querySelector('.vp-psa10') || valuesDiv.querySelector('.vp-model');
      if (psa10El && livePsa10 > 0) {
        psa10El.className = 'vp-psa10';
        psa10El.textContent = `PSA 10: ${fmtGBP(livePsa10)}`;
      }

      // Update upside %
      const upsideEl = valuesDiv.querySelector('.vp-upside');
      if (upsideEl && liveRatio > 1) {
        const liveUpside = ((liveRatio - 1) * 100).toFixed(0);
        upsideEl.textContent = `\u2191${liveUpside}%`;
        upsideEl.className = 'vp-upside ' + (liveRatio > 2 ? 'big-upside' : 'med-upside');
      }

      // Add gem rate if available
      if (gemPct && gemPct > 0) {
        const reasonsEl = valuesDiv.querySelector('.vp-reasons');
        if (reasonsEl) {
          const gemStr = `Gem rate ${(gemPct * 100).toFixed(0)}%`;
          const existing = reasonsEl.textContent;
          if (!existing.includes('Gem rate')) {
            reasonsEl.textContent = existing ? existing + ' \u00b7 ' + gemStr : gemStr;
          }
        }
      }

      // Update signal based on live ratio
      const signalEl = valuesDiv.querySelector('.vp-signal');
      if (signalEl && liveRatio > 0) {
        if (liveRatio > 2) {
          signalEl.textContent = 'STRONG BUY';
          signalEl.className = 'vp-signal signal-strong-buy';
        } else if (liveRatio > 1.3) {
          signalEl.textContent = 'BUY';
          signalEl.className = 'vp-signal signal-buy';
        }
      }

    } catch (e) {
      // Silently skip on error — static data remains
      console.warn('Collectrics enrichment failed for', c.n, e.message);
    }

    // Small delay between requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 350));
  }
}

function setupValuePicks() {
  // Filter buttons
  document.querySelectorAll('.vp-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.vp-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      vpFilter = btn.dataset.filter;
      renderValuePicks(vpFilter);
    });
  });

  // Refresh button
  $('vpRefreshBtn').addEventListener('click', () => {
    const btn = $('vpRefreshBtn');
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 600);
    renderValuePicks(vpFilter);
  });

  // Initial render (deferred so it doesn't block page load)
  setTimeout(() => renderValuePicks(vpFilter), 500);
}

// ================================================================
// Quick Lookup — search PriceCharting on the fly for any card
// ================================================================
function openQuickLookup() {
  $('qlOverlay').style.display = '';
  $('qlModal').style.display = '';
  // Pre-render the external search links so the user can jump to TCG Collector
  // / eBay / Cardmarket without having to run the inline PriceCharting search
  // first — important because the PC proxies are flaky.
  const input = $('qlInput');
  const isJP = $('qlJP') && $('qlJP').checked;
  const seed = (input && input.value.trim()) || '';
  if (seed) {
    $('qlResults').innerHTML = renderExternalLinks(seed, isJP, {
      heading: 'Jump to a marketplace, or hit Search for PriceCharting prices:',
    });
  } else {
    $('qlResults').innerHTML = `
      <div class="ql-ext-panel">
        <div class="ql-ext-head">
          <span class="ql-ext-title">Type a card name above</span>
          <span class="ql-ext-sub">Press Search for live PriceCharting prices, or use the marketplace links that appear here once you start typing.</span>
        </div>
      </div>`;
  }
  // Focus the input on next tick so the keyboard pops on iOS
  setTimeout(() => $('qlInput').focus(), 50);
}
function closeQuickLookup() {
  $('qlOverlay').style.display = 'none';
  $('qlModal').style.display = 'none';
}

// Build deep-links to external card-search sites so the user can fall back to
// manual searching whenever the inline pricing fetch breaks (CORS proxies are
// flaky). These open in a new tab.
function buildExternalSearchLinks(query, isJP) {
  const q = encodeURIComponent(query);
  const qPlus = encodeURIComponent(query).replace(/%20/g, '+');
  // TCG Collector — single-card search, switches to JP catalog when needed.
  const tcgcUrl = isJP
    ? `https://www.tcgcollector.com/cards/jp?cardName=${q}`
    : `https://www.tcgcollector.com/cards/intl?cardName=${q}`;
  return [
    { label: 'TCG Collector',  href: tcgcUrl,                                                                  hint: 'card data + market price' },
    { label: 'PriceCharting',  href: `https://www.pricecharting.com/search-products?type=prices&q=${qPlus}`,    hint: 'PSA 9/10 history' },
    { label: 'eBay UK',        href: `https://www.ebay.co.uk/sch/i.html?_nkw=${qPlus}&_sacat=183454`,           hint: 'live UK listings' },
    { label: 'eBay US',        href: `https://www.ebay.com/sch/i.html?_nkw=${qPlus}&_sacat=183454`,             hint: 'live US listings' },
    { label: 'Cardmarket',     href: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${q}`, hint: 'EU singles' },
  ];
}

function renderExternalLinks(query, isJP, opts) {
  const links = buildExternalSearchLinks(query, isJP);
  const heading = (opts && opts.heading) || 'Search this card on:';
  const subline = (opts && opts.subline) || '';
  return `
    <div class="ql-ext-panel ${opts && opts.fallback ? 'ql-ext-panel-fallback' : ''}">
      <div class="ql-ext-head">
        <span class="ql-ext-title">${escapeHtml(heading)}</span>
        ${subline ? `<span class="ql-ext-sub">${escapeHtml(subline)}</span>` : ''}
      </div>
      <div class="ql-ext-links">
        ${links.map(l => `
          <a class="ql-ext-link" href="${l.href}" target="_blank" rel="noopener">
            <span class="ql-ext-link-label">${escapeHtml(l.label)}</span>
            <span class="ql-ext-link-hint">${escapeHtml(l.hint)}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>
          </a>`).join('')}
      </div>
    </div>`;
}

async function runQuickLookup() {
  const raw = $('qlInput').value.trim();
  if (!raw) {
    $('qlStatus').textContent = 'Type a card name (e.g. "Charizard ex 125 obsidian flames")';
    $('qlResults').innerHTML = '';
    return;
  }
  const isJP = $('qlJP').checked;
  const query = isJP && !/japanese/i.test(raw) ? `${raw} japanese` : raw;
  $('qlStatus').textContent = 'Searching PriceCharting…';
  $('qlResults').innerHTML = '';
  try {
    const products = await pcSearchRaw(query);
    if (!products || products.length === 0) {
      $('qlStatus').textContent = 'No matches on PriceCharting — try a different name, or use the links below';
      $('qlResults').innerHTML = renderExternalLinks(raw, isJP, {
        heading: 'No PriceCharting matches — try one of these instead:',
        subline: 'TCG Collector is best for hard-to-match modern English cards',
        fallback: true,
      });
      return;
    }
    $('qlStatus').textContent = `${products.length} match${products.length === 1 ? '' : 'es'}`;
    // Always render external search links at the top so the user can jump out
    // to TCG Collector / eBay / Cardmarket even when PC returned results.
    $('qlResults').innerHTML =
      renderExternalLinks(raw, isJP, { heading: 'Also search on:' }) +
      products.slice(0, 50).map(p => renderQLCard(p)).join('');
  } catch (e) {
    console.warn('Quick Lookup error:', e);
    const failedAll = e && e.allProxiesFailed;
    $('qlStatus').textContent = failedAll
      ? 'Live PriceCharting fetch is down (CORS proxies all rate-limited). Use the links below to search directly.'
      : 'Search failed — try again in a moment, or use the links below.';
    $('qlResults').innerHTML = renderExternalLinks(raw, isJP, {
      heading: failedAll ? 'PriceCharting proxy is down — search directly here:' : 'Or search this card here:',
      subline: 'TCG Collector handles hard-to-match modern cards best. eBay sold listings give you live UK/US comps.',
      fallback: true,
    });
  }
}

function renderQLCard(p) {
  const ungraded = parsePCPrice(p.price1);
  const psa10 = parsePCPrice(p.price2);
  const grade9 = parsePCPrice(p.price3);
  const consoleSlug = (p.consoleName || 'cards').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const pcUrl = p.id ? `https://www.pricecharting.com/game/${consoleSlug}/${p.id}` : '#';
  const isJP = (p.consoleName || '').toLowerCase().includes('japanese');
  return `
    <div class="ql-card">
      <div class="ql-card-head">
        <div class="ql-card-title">
          <span class="ql-card-name">${escapeHtml(p.productName || 'Unknown')}</span>
          <span class="ql-card-set ${isJP ? 'lang-jp' : 'lang-en'}">${escapeHtml(p.consoleName || '')}</span>
        </div>
        <a class="ql-card-link" href="${pcUrl}" target="_blank" rel="noopener">
          PriceCharting <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>
        </a>
      </div>
      <div class="ql-card-prices">
        <div class="ql-price"><span class="ql-price-label">Ungraded</span><span class="ql-price-val">${ungraded > 0 ? fmtGBP(ungraded) : '—'}</span><span class="ql-price-usd">${ungraded > 0 ? fmtUSD(ungraded) : ''}</span></div>
        <div class="ql-price"><span class="ql-price-label">PSA 10</span><span class="ql-price-val">${psa10 > 0 ? fmtGBP(psa10) : '—'}</span><span class="ql-price-usd">${psa10 > 0 ? fmtUSD(psa10) : ''}</span></div>
        <div class="ql-price"><span class="ql-price-label">Grade 9</span><span class="ql-price-val">${grade9 > 0 ? fmtGBP(grade9) : '—'}</span><span class="ql-price-usd">${grade9 > 0 ? fmtUSD(grade9) : ''}</span></div>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setupQuickLookup() {
  const toggle = $('quickLookupToggle');
  if (toggle) toggle.addEventListener('click', openQuickLookup);
  const close = $('qlClose');
  if (close) close.addEventListener('click', closeQuickLookup);
  const overlay = $('qlOverlay');
  if (overlay) overlay.addEventListener('click', closeQuickLookup);
  const btn = $('qlSearchBtn');
  if (btn) btn.addEventListener('click', runQuickLookup);
  const input = $('qlInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runQuickLookup(); }
    });
    // Live-update the external-search-links panel as the user types, but only
    // when the result area currently shows the pre-search seed panel (no PC
    // results yet). Otherwise typing would clobber the search results.
    input.addEventListener('input', () => {
      const results = $('qlResults');
      if (!results) return;
      // Only refresh if the only child is the ext panel (no .ql-card results below).
      const hasResults = results.querySelector('.ql-card');
      if (hasResults) return;
      const isJP = $('qlJP') && $('qlJP').checked;
      const seed = input.value.trim();
      if (seed) {
        results.innerHTML = renderExternalLinks(seed, isJP, {
          heading: 'Jump to a marketplace, or hit Search for PriceCharting prices:',
        });
      }
    });
  }
  const jp = $('qlJP');
  if (jp) jp.addEventListener('change', () => {
    const results = $('qlResults');
    if (!results || results.querySelector('.ql-card')) return;
    const seed = input && input.value.trim();
    if (seed) {
      results.innerHTML = renderExternalLinks(seed, jp.checked, {
        heading: 'Jump to a marketplace, or hit Search for PriceCharting prices:',
      });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('qlModal').style.display !== 'none') closeQuickLookup();
  });
}

// ================================================================
// PriceCharting manual override modal
// ================================================================
let pcovCard = null; // card currently being overridden

function openPCOverride() {
  if (!selectedCard) return;
  pcovCard = selectedCard;
  $('pcovOverlay').style.display = '';
  $('pcovModal').style.display = '';
  // Pre-fill the search box with our auto-built query so the user can tweak it
  $('pcovInput').value = buildPCQuery(pcovCard);
  // Show what's currently active
  const _pcov = getPCOverride(pcovCard.i);
  const _isNA = !!(  _pcov && _pcov.notAvailable);
  const cur = _isNA
    ? 'Marked as <strong>Not on PriceCharting</strong> — PC lookup is skipped for this card.'
    : (livePrice && livePrice.pcName
      ? `Currently using: <strong>${escapeHtml(livePrice.pcName)}</strong> (${escapeHtml(livePrice.pcConsole || '')})`
      : 'No PriceCharting match yet for this card.');
  $('pcovCurrent').innerHTML = cur;
  // Show "Search again" only when N/A is set; hide "Not on PriceCharting" when already set
  const _naBtn = $('pcovNaBtn');
  const _scanBtn = $('pcovScanBtn');
  if (_naBtn) _naBtn.style.display = _isNA ? 'none' : '';
  if (_scanBtn) _scanBtn.style.display = _isNA ? '' : 'none';
  $('pcovSub').textContent = `Card: ${pcovCard.n}${pcovCard.cn ? ' #' + pcovCard.cn : ''} · ${setsData?.[pcovCard.sc]?.name || ''} · ${pcovCard.lang || 'EN'}`;
  setTimeout(() => $('pcovInput').focus(), 50);
  // Auto-run a search
  runPCOverrideSearch();
}
function closePCOverride() {
  $('pcovOverlay').style.display = 'none';
  $('pcovModal').style.display = 'none';
  pcovCard = null;
}

async function runPCOverrideSearch() {
  const q = $('pcovInput').value.trim() || (pcovCard ? buildPCQuery(pcovCard) : '');
  if (!q) return;
  $('pcovStatus').textContent = 'Searching PriceCharting…';
  $('pcovResults').innerHTML = '';
  try {
    const products = await pcSearchRaw(q);
    if (!products || products.length === 0) {
      $('pcovStatus').textContent = 'No matches — try refining your search above';
      return;
    }
    // Score against the card to bring better matches to the top
    if (pcovCard) {
      for (const p of products) p._score = scorePCProduct(p, pcovCard);
      products.sort((a, b) => b._score - a._score);
    }
    $('pcovStatus').textContent = `${products.length} match${products.length === 1 ? '' : 'es'} — click "Use this match" on the right one`;
    $('pcovResults').innerHTML = products.slice(0, 50).map((p, i) => renderPCOverrideCard(p, i)).join('');
    // Wire "Use this match" buttons
    document.querySelectorAll('#pcovResults .pcov-pick-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => applyPCOverride(products[i]));
    });
  } catch (e) {
    $('pcovStatus').textContent = 'Search failed — try again in a moment';
    console.warn('Override search error:', e);
  }
}

function renderPCOverrideCard(p, idx) {
  const ungraded = parsePCPrice(p.price1);
  const psa10 = parsePCPrice(p.price2);
  const grade9 = parsePCPrice(p.price3);
  const consoleSlug = (p.consoleName || 'cards').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const pcUrl = p.id ? `https://www.pricecharting.com/game/${consoleSlug}/${p.id}` : '#';
  const isJP = (p.consoleName || '').toLowerCase().includes('japanese');
  // Score badge
  let badge = '';
  if (typeof p._score === 'number') {
    const cls = p._score >= 50 ? 'conf-high' : p._score >= 25 ? 'conf-ok' : 'conf-low';
    const label = p._score >= 50 ? 'Top match' : p._score >= 25 ? 'Possible' : 'Unlikely';
    badge = `<span class="pc-match-confidence ${cls}">${label}</span>`;
  }
  return `
    <div class="ql-card">
      <div class="ql-card-head">
        <div class="ql-card-title">
          <span class="ql-card-name">${escapeHtml(p.productName || 'Unknown')}</span>
          <span class="ql-card-meta">
            <span class="ql-card-set ${isJP ? 'lang-jp' : 'lang-en'}">${escapeHtml(p.consoleName || '')}</span>
            ${badge}
          </span>
        </div>
        <div class="ql-card-actions">
          <a class="ql-card-link" href="${pcUrl}" target="_blank" rel="noopener">View on PC</a>
          <button class="pcov-pick-btn" data-idx="${idx}">Use this match</button>
        </div>
      </div>
      <div class="ql-card-prices">
        <div class="ql-price"><span class="ql-price-label">Ungraded</span><span class="ql-price-val">${ungraded > 0 ? fmtGBP(ungraded) : '—'}</span></div>
        <div class="ql-price"><span class="ql-price-label">PSA 10</span><span class="ql-price-val">${psa10 > 0 ? fmtGBP(psa10) : '—'}</span></div>
        <div class="ql-price"><span class="ql-price-label">Grade 9</span><span class="ql-price-val">${grade9 > 0 ? fmtGBP(grade9) : '—'}</span></div>
      </div>
    </div>`;
}

function applyPCOverride(product) {
  if (!pcovCard || !product) return;
  const cardId = pcovCard.i;
  setPCOverride(cardId, {
    id: product.id,
    productName: product.productName,
    consoleName: product.consoleName,
    price1: product.price1,
    price2: product.price2,
    price3: product.price3,
    imageUri: product.imageUri,
  });
  try {
    const cache = getPriceCache();
    delete cache[cardId];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  closePCOverride();
  if (selectedCard && selectedCard.i === cardId) fetchLivePrice(selectedCard);
}

function markPCNotAvailable() {
  if (!pcovCard) return;
  const cardId = pcovCard.i;
  setPCOverride(cardId, { notAvailable: true });
  try {
    const cache = getPriceCache();
    delete cache[cardId];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  closePCOverride();
  if (selectedCard && selectedCard.i === cardId) fetchLivePrice(selectedCard);
}

function clearPCOverride() {
  if (!pcovCard) return;
  const cardId = pcovCard.i;
  setPCOverride(cardId, null);
  try {
    const cache = getPriceCache();
    delete cache[cardId];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  closePCOverride();
  if (selectedCard && selectedCard.i === cardId) fetchLivePrice(selectedCard);
}

function setupPCOverride() {
  const btn = $('pcOverrideBtn');
  if (btn) btn.addEventListener('click', openPCOverride);
  const close = $('pcovClose');
  if (close) close.addEventListener('click', closePCOverride);
  const overlay = $('pcovOverlay');
  if (overlay) overlay.addEventListener('click', closePCOverride);
  const search = $('pcovSearchBtn');
  if (search) search.addEventListener('click', runPCOverrideSearch);
  const clear = $('pcovClearBtn');
  if (clear) clear.addEventListener('click', clearPCOverride);
  const na = $('pcovNaBtn');
  if (na) na.addEventListener('click', markPCNotAvailable);
  const scan = $('pcovScanBtn');
  if (scan) scan.addEventListener('click', () => {
    if (!pcovCard) return;
    setPCOverride(pcovCard.i, null);
    $('pcovNaBtn').style.display = '';
    $('pcovScanBtn').style.display = 'none';
    $('pcovCurrent').innerHTML = 'No PriceCharting match yet for this card.';
    runPCOverrideSearch();
  });
  const input = $('pcovInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runPCOverrideSearch(); }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('pcovModal').style.display !== 'none') closePCOverride();
  });
}

// ================================================================
// Manual Counterpart Override — lets the user pick the correct EN/JP
// counterpart when our auto-detection picks the wrong card. Search covers
// the FULL indexed DB (filtered to opposite language), not just the bucket.
// ================================================================
let _cpovCard = null;

function openCPOverride(card) {
  if (!card) return;
  _cpovCard = card;
  $('cpovOverlay').style.display = '';
  $('cpovOverlay').setAttribute('aria-hidden', 'false');
  $('cpovModal').style.display = 'flex';

  const wantLang = card.lang === 'JP' ? 'EN' : 'JP';
  $('cpovSub').innerHTML = `Find the right <strong>${wantLang}</strong> counterpart for <em>${esc(card.n)}</em>${card.cn ? ` #${esc(card.cn)}` : ''} · ${esc(card.s || '')}.`;

  // Render current state
  renderCPOverrideCurrent();

  // Pre-fill with just the Pokémon name (most lenient default)
  const nameInput = $('cpovInput');
  const numInput = $('cpovNumInput');
  if (nameInput) nameInput.value = card.n || '';
  if (numInput) numInput.value = ''; // start with no number filter so we don't return 0
  $('cpovStatus').textContent = '';
  setTimeout(() => { if (nameInput) { nameInput.focus(); nameInput.select(); } }, 50);
  runCPOverrideSearch();
}

function closeCPOverride() {
  $('cpovOverlay').style.display = 'none';
  $('cpovOverlay').setAttribute('aria-hidden', 'true');
  $('cpovModal').style.display = 'none';
  _cpovCard = null;
}

function renderCPOverrideCurrent() {
  if (!_cpovCard) return;
  const cur = $('cpovCurrent');
  const overrideId = getCPOverride(_cpovCard.i);
  const auto = findCounterparts(_cpovCard);
  if (overrideId && cardData) {
    const o = getCardById(overrideId);
    if (o) {
      cur.innerHTML = `<strong>Manual override active:</strong> ${esc(o.n)} · ${esc(o.s || '')}${o.cn ? ' #' + esc(o.cn) : ''} <span class="lang-${o.lang === 'JP' ? 'jp' : 'en'}">${o.lang === 'JP' ? 'JP' : 'EN'}</span>`;
      $('cpovClearBtn').disabled = false;
      return;
    }
  }
  if (auto && auto.primary) {
    const o = auto.primary;
    cur.innerHTML = `Currently auto-matched to: <strong>${esc(o.n)}</strong> · ${esc(o.s || '')}${o.cn ? ' #' + esc(o.cn) : ''} <span class="lang-${o.lang === 'JP' ? 'jp' : 'en'}">${o.lang === 'JP' ? 'JP' : 'EN'}</span>`;
  } else {
    cur.innerHTML = `<span class="pcov-current-empty">No auto-match found. Pick the right counterpart from the search below.</span>`;
  }
  $('cpovClearBtn').disabled = !overrideId;
}

function runCPOverrideSearch() {
  if (!_cpovCard || !searchIndex) return;
  const q = $('cpovInput').value.trim().toLowerCase();
  const num = ($('cpovNumInput')?.value || '').trim().toLowerCase();
  const wantLang = _cpovCard.lang === 'JP' ? 'EN' : 'JP';
  const status = $('cpovStatus');

  // Filter searchIndex to opposite language only, exclude self
  let pool = searchIndex.filter(c => {
    if (c.i === _cpovCard.i) return false;
    const isJP = c.lang === 'JP';
    return wantLang === 'JP' ? isJP : !isJP;
  });

  if (q) {
    // Token-AND match for name/set: every space-separated token must appear
    const tokens = q.split(/\s+/).filter(Boolean);
    pool = pool.filter(c => tokens.every(t => c._search.includes(t)));
  }

  if (num) {
    // Match card number flexibly: "125" matches "125", "125/197", "125a", but
    // not "1125". Strip leading zeros from both sides for tolerance (066 ↔ 66).
    const stripped = num.replace(/^0+/, '') || '0';
    pool = pool.filter(c => {
      const cn = (c.cn || '').toString().toLowerCase();
      const cnStripped = cn.replace(/^0+/, '') || cn;
      return cn === num || cnStripped === stripped || cn.startsWith(num + '/') || cnStripped.startsWith(stripped + '/');
    });
  }

  // Boost cards in the same auto-bucket (likely correct family)
  const myKey = counterpartByCard.get(_cpovCard.i);
  pool.sort((a, b) => {
    const ak = counterpartByCard.get(a.i) === myKey ? 1 : 0;
    const bk = counterpartByCard.get(b.i) === myKey ? 1 : 0;
    if (ak !== bk) return bk - ak;
    // Then by name match closeness
    const an = a.n === _cpovCard.n ? 1 : 0;
    const bn = b.n === _cpovCard.n ? 1 : 0;
    if (an !== bn) return bn - an;
    return 0;
  });

  pool = pool.slice(0, 30);
  if (!pool.length) {
    status.className = 'ql-status error';
    status.textContent = `No ${wantLang} cards match "${q}". Try a different query.`;
    $('cpovResults').innerHTML = '';
    return;
  }
  status.className = 'ql-status';
  status.textContent = `Showing ${pool.length} ${wantLang} candidate${pool.length === 1 ? '' : 's'}. Pick the right one.`;
  $('cpovResults').innerHTML = pool.map(renderCPOverrideCard).join('');
  $('cpovResults').querySelectorAll('.cpov-pick').forEach(b => {
    b.addEventListener('click', () => applyCPOverride(b.dataset.id));
  });
}

function renderCPOverrideCard(c) {
  const lang = c.lang === 'JP' ? 'JP' : 'EN';
  const langBadge = lang === 'JP' ? '<span class="lang-jp">JP</span>' : '<span class="lang-en">EN</span>';
  const num = c.cn ? (c.ct ? `${c.cn}/${c.ct}` : c.cn) : '';
  return `
    <div class="ql-card">
      <div class="ql-card-head">
        <div class="ql-card-title">
          <div class="ql-card-name">${esc(c.n)}</div>
          <div class="ql-card-set">${esc(c.s || '')}${num ? ' · #' + esc(num) : ''}${c.r ? ' · ' + esc(c.r) : ''}</div>
          <div class="ql-card-meta">${langBadge}</div>
        </div>
        <div class="ql-card-actions">
          <button class="pcov-pick-btn cpov-pick" data-id="${esc(c.i)}">Use this match</button>
        </div>
      </div>
    </div>`;
}

function applyCPOverride(otherId) {
  if (!_cpovCard) return;
  setCPOverride(_cpovCard.i, otherId);
  // Bust counterpart's live-price cache so we re-fetch fresh data on next render
  try {
    const cache = getPriceCache();
    delete cache[otherId];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  closeCPOverride();
  // Re-render the counterpart flag so the new pick shows immediately
  renderCounterpartFlag(_cpovCard || selectedCard);
  if (typeof selectedCard !== 'undefined' && selectedCard) renderCounterpartFlag(selectedCard);
}

function clearCPOverrideForCurrent() {
  if (!_cpovCard) return;
  clearCPOverride(_cpovCard.i);
  renderCPOverrideCurrent();
  if (typeof selectedCard !== 'undefined' && selectedCard) renderCounterpartFlag(selectedCard);
}

function setupCPOverride() {
  $('cpovClose')?.addEventListener('click', closeCPOverride);
  $('cpovOverlay')?.addEventListener('click', closeCPOverride);
  // Single input — live search as the user types
  const debounced = cpovDebounce(runCPOverrideSearch, 180);
  $('cpovInput')?.addEventListener('input', debounced);
  // Enter key + explicit Search button
  const onEnter = (e) => { if (e.key === 'Enter') runCPOverrideSearch(); };
  $('cpovInput')?.addEventListener('keydown', onEnter);
  $('cpovSearchBtn')?.addEventListener('click', runCPOverrideSearch);
  $('cpovClearBtn')?.addEventListener('click', clearCPOverrideForCurrent);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('cpovModal') && $('cpovModal').style.display !== 'none') closeCPOverride();
  });
  // Wire the buttons that open this modal
  $('cpOverrideBtn')?.addEventListener('click', () => {
    if (selectedCard) openCPOverride(selectedCard);
    else alert('Select a card first.');
  });
  $('linkFindCounterpart')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (selectedCard) openCPOverride(selectedCard);
    else alert('Select a card first.');
  });
}

// Tiny local debounce so we don't depend on outer scope
function cpovDebounce(fn, ms) {
  let t;
  return function(...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}

// ================================================================
// Manual Add Card — look up on TCG Collector and inject a synthetic card
// when the indexed database doesn't have it (rare promos, regional, new sets).
// ================================================================
const USER_CARDS_KEY = 'pkm-user-cards-v1';

function loadUserCards() {
  try { return JSON.parse(localStorage.getItem(USER_CARDS_KEY) || '[]'); }
  catch { return []; }
}
function saveUserCards(arr) {
  try { localStorage.setItem(USER_CARDS_KEY, JSON.stringify(arr)); } catch {}
}

// ================================================================
// Card-detail OVERRIDES — lets the user fix wrong information on any
// card (indexed or user-added). Persisted to localStorage and re-applied
// every time the card DB is loaded.
//   shape: { [cardId]: { n?, s?, cn?, ct?, r?, sr?, lang?, img?, nj? } }
// ================================================================
const CARD_OVERRIDES_KEY = 'pkm-card-overrides-v1';
function loadCardOverrides() {
  try { return JSON.parse(localStorage.getItem(CARD_OVERRIDES_KEY) || '{}'); }
  catch { return {}; }
}
function saveCardOverrides(o) {
  try { localStorage.setItem(CARD_OVERRIDES_KEY, JSON.stringify(o)); } catch {}
}
function setCardOverride(id, fields) {
  const all = loadCardOverrides();
  all[id] = { ...(all[id] || {}), ...fields };
  saveCardOverrides(all);
}
function clearCardOverride(id) {
  const all = loadCardOverrides();
  delete all[id];
  saveCardOverrides(all);
}
// Mutate a card object in place with any override that exists for it.
// Stash the original snapshot in `_orig` so 'Reset to original' works
// even after the override has been applied multiple times.
function applyCardOverride(card, override) {
  if (!override) return false;
  if (!card._orig) {
    card._orig = {
      n: card.n, s: card.s, cn: card.cn, ct: card.ct,
      r: card.r, sr: card.sr, lang: card.lang, img: card.img, nj: card.nj,
    };
  }
  let changed = false;
  for (const k of ['n','s','cn','ct','r','sr','lang','img','nj']) {
    if (override[k] !== undefined && card[k] !== override[k]) {
      card[k] = override[k];
      changed = true;
    }
  }
  card._edited = true;
  return changed;
}

// Re-inject any user-added cards on init so they survive reloads.
// Also re-apply any field overrides on indexed cards so corrections persist.
function injectUserCards() {
  if (!cardData || !Array.isArray(cardData.cards)) return;
  const userCards = loadUserCards();
  const existing = new Set(cardData.cards.map(c => c.i));
  for (const uc of userCards) {
    if (!existing.has(uc.i)) cardData.cards.push(uc);
  }
  cardData.count = cardData.cards.length;
  // Apply per-card overrides AFTER user cards are injected so edits to
  // user-added cards also take effect.
  const overrides = loadCardOverrides();
  if (Object.keys(overrides).length) {
    for (const c of cardData.cards) {
      if (overrides[c.i]) applyCardOverride(c, overrides[c.i]);
    }
  }
}

function openManualAdd(seed) {
  $('maOverlay').style.display = '';
  $('maOverlay').setAttribute('aria-hidden', 'false');
  $('maModal').style.display = 'flex';
  const input = $('maInput');
  if (typeof seed === 'string' && seed) input.value = seed;
  $('maResults').innerHTML = '';
  $('maStatus').className = 'ql-status';
  $('maStatus').innerHTML = 'Tip: include the set name for the best results (e.g. <em>Charizard 125 Obsidian Flames</em>).';
  setTimeout(() => input.focus(), 50);
  if (input.value.trim().length >= 2) runManualAddSearch();
}
function closeManualAdd() {
  $('maOverlay').style.display = 'none';
  $('maOverlay').setAttribute('aria-hidden', 'true');
  $('maModal').style.display = 'none';
}

// TCG Collector returns Cloudflare-protected HTML to bots, but r.jina.ai
// renders it server-side and returns a Markdown-friendly version we can parse.
async function fetchTCGCollectorMarkdown(query) {
  const url = `https://www.tcgcollector.com/cards?cardSearch=${encodeURIComponent(query)}&cardsPerPage=20`;
  const resp = await fetch(`https://r.jina.ai/${url}`, { headers: { 'Accept': 'text/plain' } });
  if (!resp.ok) throw new Error(`TCG Collector lookup failed (${resp.status})`);
  return resp.text();
}

// Each card row in the markdown is a multi-image link, e.g.:
//   [![Image 8: ...](url1) ![Image 9: ...](url2) 125/094 ![...](url3)]
//     (https://www.tcgcollector.com/cards/51583/slug "Charizard ex (Obsidian Flames 125/197)")
// We anchor on the title link and look backward for the first card-art image.
function parseTCGCollectorMarkdown(md) {
  const out = [];
  const seen = new Set();
  // Match the closing of any tcgcollector card link with title attribute.
  const re = /\]\((https:\/\/www\.tcgcollector\.com\/cards\/(\d+)\/[^\s")]+)\s+"([^"]+)"\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const detailUrl = m[1];
    const tcgcId = m[2];
    const title = m[3];
    if (seen.has(tcgcId)) continue;
    seen.add(tcgcId);
    // Skip non-card links (Random, navigation)
    if (!/\(.*\d/.test(title)) continue;
    // Look at the ~1500 chars preceding this match for the first card-art image.
    const start = Math.max(0, m.index - 1500);
    const slice = md.slice(start, m.index);
    // The first .webp/.jpg/.png in the slice is the card art
    const imgM = slice.match(/(https:\/\/static\.tcgcollector\.com\/content\/images\/[^\s)"]+\.(?:webp|jpg|jpeg|png))/i);
    const imgUrl = imgM ? imgM[1] : null;
    // Parse title: "Charizard ex (Obsidian Flames 125/197)" or "... (Set Name 0101/07)"
    // Be tolerant: name may include parentheses (e.g. set names with brackets)
    const tM = title.match(/^(.+?)\s+\(([^()]+?)\s+(\d+[A-Za-z]?)(?:\/(\d+[A-Za-z]?))?\)\s*$/);
    if (!tM) continue;
    const name = tM[1].trim();
    const setName = tM[2].trim();
    const cn = tM[3];
    const ct = tM[4] || '';
    out.push({ tcgcId, detailUrl, name, setName, cn, ct, imgUrl, title });
    if (out.length >= 25) break;
  }
  return out;
}

async function runManualAddSearch() {
  const q = $('maInput').value.trim();
  if (!q) { $('maStatus').textContent = 'Type a card name and/or number first.'; $('maStatus').className = 'ql-status error'; return; }
  $('maStatus').className = 'ql-status';
  $('maStatus').textContent = 'Searching TCG Collector…';
  $('maResults').innerHTML = '';
  const btn = $('maSearchBtn'); btn.disabled = true;
  try {
    const md = await fetchTCGCollectorMarkdown(q);
    let rows = parseTCGCollectorMarkdown(md);
    // When JP checkbox is on, sort JP-named sets first but don't hide EN results —
    // many JP sets on TCG Collector use English names without "japanese" in the text,
    // so filtering would silently drop all results.
    const jpChecked = $('maJP').checked;
    if (jpChecked) {
      rows.sort((a, b) => {
        const aJP = /japan/i.test(a.setName) || /\b(jp|japanese)\b/i.test(a.setName) ? 0 : 1;
        const bJP = /japan/i.test(b.setName) || /\b(jp|japanese)\b/i.test(b.setName) ? 0 : 1;
        return aJP - bJP;
      });
    }
    if (!rows.length) {
      $('maStatus').className = 'ql-status error';
      $('maStatus').textContent = 'No cards on TCG Collector for that query. Try just the Pokémon name + number.';
      return;
    }
    $('maStatus').className = 'ql-status success';
    $('maStatus').textContent = `Found ${rows.length} card${rows.length === 1 ? '' : 's'}. Pick the right one.`;
    $('maResults').innerHTML = rows.map(renderManualAddCard).join('');
    // Read checkbox at click time so the user can toggle JP after searching
    $('maResults').querySelectorAll('.ma-add-btn').forEach(b => {
      b.addEventListener('click', () => addManualCardFromTCGC(JSON.parse(b.dataset.card), $('maJP').checked));
    });
  } catch (e) {
    console.error(e);
    $('maStatus').className = 'ql-status error';
    $('maStatus').textContent = `Couldn't reach TCG Collector right now. ${e.message || ''}`;
  } finally {
    btn.disabled = false;
  }
}

function renderManualAddCard(r) {
  const numLabel = r.cn && r.ct ? `${r.cn}/${r.ct}` : r.cn || '';
  const langGuess = /\b(japan|japanese)\b/i.test(r.setName) ? 'JP' : 'EN';
  const langBadge = langGuess === 'JP' ? '<span class="lang-jp">JP</span>' : '<span class="lang-en">EN</span>';
  const safe = JSON.stringify(r).replace(/'/g, '&#39;');
  const img = r.imgUrl ? `<img class="ma-thumb" src="${escapeHtml(r.imgUrl)}" alt="" loading="lazy" onerror="_onImgError(this)">` : '';
  return `
    <div class="ql-card ma-card">
      <div class="ql-card-head">
        ${img}
        <div class="ql-card-title">
          <div class="ql-card-name">${escapeHtml(r.name)}</div>
          <div class="ql-card-set">${escapeHtml(r.setName)}</div>
          <div class="ql-card-meta">
            ${langBadge}
            ${numLabel ? `<span style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">#${escapeHtml(numLabel)}</span>` : ''}
            <a class="ql-card-link" href="${escapeHtml(r.detailUrl)}" target="_blank" rel="noopener">tcgcollector ↗</a>
          </div>
        </div>
        <div class="ql-card-actions">
          <button class="pcov-pick-btn ma-add-btn" data-card='${safe}'>Add to my cards</button>
        </div>
      </div>
    </div>`;
}

function addManualCardFromTCGC(r, isJPHint) {
  if (!cardData) return;
  const langGuess = /\b(japan|japanese)\b/i.test(r.setName) ? 'JP' : (isJPHint ? 'JP' : 'EN');
  // Build a synthetic card ID that won't collide with the indexed DB.
  // tcgc-{lang}-{tcgcId} keeps it stable across reloads.
  const id = `tcgc-${langGuess.toLowerCase()}-${r.tcgcId}`;
  // If already added, just select it.
  if (getCardById(id)) {
    closeManualAdd();
    selectCard(id);
    return;
  }
  const card = {
    i: id,
    n: r.name,
    s: r.setName,
    sc: '',                 // no canonical set code
    cn: r.cn || '',
    ct: r.ct || '',
    r: '',                  // unknown rarity
    sr: '',                 // unknown series
    p: 0,                   // no static price; live lookup will fill
    lang: langGuess,
    img: r.imgUrl || '',    // direct image URL from TCG Collector
    nj: '',
    _userAdded: true,
    _tcgcId: r.tcgcId,
    _tcgcUrl: r.detailUrl,
  };
  // Persist + inject into in-memory DB + rebuild search index
  const userCards = loadUserCards();
  userCards.push(card);
  saveUserCards(userCards);
  cardData.cards.push(card);
  cardData.count = cardData.cards.length;
  buildSearchIndex(cardData.cards);
  if (typeof buildCounterpartIndex === 'function') buildCounterpartIndex(cardData.cards);
  // Refresh the search-count display to reflect the new total
  try {
    const jpCount = cardData.cards.filter(c => c.lang === 'JP').length;
    const enCount = cardData.count - jpCount;
    const userCount = cardData.cards.filter(c => c._userAdded).length;
    const userSuffix = userCount > 0 ? ` + ${userCount} added` : '';
    $('searchCount').textContent =
      `${cardData.count.toLocaleString()} cards (${enCount.toLocaleString()} EN + ${jpCount.toLocaleString()} JP${userSuffix})`;
  } catch {}
  closeManualAdd();
  // Bust price cache for this id (just in case) and select it.
  try {
    const cache = getPriceCache();
    delete cache[id];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  selectCard(id);
}

// ----------------------------------------------------------------
// TCG Collector URL → card-art helper
// Lets the user paste a tcgcollector.com/cards/... link and we extract
// the card image from the rendered page (via r.jina.ai). Used by both
// the 'Add from scratch' and 'Edit details' image fields.
// ----------------------------------------------------------------
function isTCGCollectorCardURL(s) {
  return /^https?:\/\/(www\.)?tcgcollector\.com\/cards\/\d+\b/i.test((s || '').trim());
}

// Fetch a TCGC card detail page through r.jina.ai and pull out the first
// real card-art image URL. Returns { imgUrl, name, setLabel, num } where
// any field may be empty if not parseable.
async function fetchTCGCollectorCardDetails(url) {
  const clean = url.trim().replace(/[#?].*$/, '');
  const resp = await fetch(`https://r.jina.ai/${clean}`, { headers: { 'Accept': 'text/plain' } });
  if (!resp.ok) throw new Error(`TCG Collector lookup failed (${resp.status})`);
  const md = await resp.text();
  // First static.tcgcollector.com card-art image is the front of the card.
  const imgM = md.match(/(https:\/\/static\.tcgcollector\.com\/content\/images\/[^\s)"]+\.(?:webp|jpg|jpeg|png))/i);
  const imgUrl = imgM ? imgM[1] : '';
  // The detail page often opens with a header like "# Charizard ex\n\n...Obsidian Flames 125/197".
  // Be lenient — just look for a recognisable "Set Name 125/197" pattern.
  let name = '';
  let setLabel = '';
  let num = '';
  const titleM = md.match(/^#\s+(.+?)\s*$/m);
  if (titleM) name = titleM[1].trim();
  const setM = md.match(/([A-Za-z][^\n]{2,80}?)\s+(\d+[a-zA-Z]?)\s*\/\s*(\d+[a-zA-Z]?)/);
  if (setM) { setLabel = setM[1].trim(); num = setM[2]; }
  return { imgUrl, name, setLabel, num };
}

// Wire a (input, status, optional name/set/num inputs) trio so that pasting a
// TCGC URL fetches the image and — if the corresponding text fields are empty
// — also pre-fills name/set/number. Auto-fires on input + paste, debounced.
function wireTCGCImageInput(imgInputId, statusId, opts = {}) {
  const input = $(imgInputId);
  const status = $(statusId);
  if (!input || !status) return;
  let token = 0;
  async function maybeFetch() {
    const v = input.value.trim();
    status.className = 'ma-img-status';
    if (!v) { status.textContent = ''; return; }
    if (!isTCGCollectorCardURL(v)) {
      // Plain image URL or anything else: leave it alone.
      if (/\.(webp|jpg|jpeg|png)(\?|$)/i.test(v)) status.textContent = 'Image URL detected.';
      else status.textContent = '';
      return;
    }
    const my = ++token;
    status.className = 'ma-img-status loading';
    status.textContent = 'Fetching artwork from TCG Collector…';
    try {
      const { imgUrl, name, setLabel, num } = await fetchTCGCollectorCardDetails(v);
      if (my !== token) return; // stale
      if (!imgUrl) {
        status.className = 'ma-img-status error';
        status.textContent = "Couldn't find card art on that page — paste a different link or a direct image URL.";
        return;
      }
      input.value = imgUrl;
      status.className = 'ma-img-status success';
      status.textContent = '✓ Got the artwork.';
      // Helpfully pre-fill linked text fields when they're empty.
      if (opts.nameId && name) {
        const el = $(opts.nameId);
        if (el && !el.value.trim()) el.value = name;
      }
      if (opts.setId && setLabel) {
        const el = $(opts.setId);
        if (el && !el.value.trim()) el.value = setLabel;
      }
      if (opts.numId && num) {
        const el = $(opts.numId);
        if (el && !el.value.trim()) el.value = num;
      }
    } catch (e) {
      if (my !== token) return;
      status.className = 'ma-img-status error';
      status.textContent = `Couldn't reach TCG Collector. ${e.message || ''}`;
    }
  }
  // Debounce keyboard input; fire immediately on paste/blur.
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(maybeFetch, 350); });
  input.addEventListener('paste', () => { clearTimeout(t); setTimeout(maybeFetch, 50); });
  input.addEventListener('blur', () => { clearTimeout(t); maybeFetch(); });
}

// ----------------------------------------------------------------
// Tab switcher inside the Manual Add modal (Search vs Add from scratch)
// ----------------------------------------------------------------
function switchManualAddTab(which) {
  const search = which === 'search';
  $('maTabSearch')?.classList.toggle('ma-tab-active', search);
  $('maTabCustom')?.classList.toggle('ma-tab-active', !search);
  $('maTabSearch')?.setAttribute('aria-selected', String(search));
  $('maTabCustom')?.setAttribute('aria-selected', String(!search));
  $('maPaneSearch').style.display = search ? '' : 'none';
  $('maPaneCustom').style.display = search ? 'none' : '';
}

// ----------------------------------------------------------------
// Add-from-scratch: validate the form, build a synthetic card and persist.
// ----------------------------------------------------------------
// If the field still contains a TCGC card-page URL when Save is pressed,
// resolve it to an image URL synchronously here so the saved card actually
// shows the artwork (not a broken-image "?" icon).
async function resolveImageInputIfTCGC(imgInputId, statusId) {
  const el = $(imgInputId);
  if (!el) return '';
  const v = el.value.trim();
  if (!v) return '';
  if (!isTCGCollectorCardURL(v)) return v;
  const status = $(statusId);
  if (status) {
    status.className = 'ma-img-status loading';
    status.textContent = 'Fetching artwork from TCG Collector…';
  }
  try {
    const { imgUrl } = await fetchTCGCollectorCardDetails(v);
    if (imgUrl) {
      el.value = imgUrl;
      if (status) {
        status.className = 'ma-img-status success';
        status.textContent = '✓ Got the artwork.';
      }
      return imgUrl;
    }
  } catch {}
  if (status) {
    status.className = 'ma-img-status error';
    status.textContent = "Couldn't resolve that link to an image. Card was saved without artwork.";
  }
  // Don't save the bad page URL as an image — fall back to no override.
  el.value = '';
  return '';
}

async function saveCustomCard() {
  if (!cardData) return;
  const name = $('mcName').value.trim();
  const set = $('mcSet').value.trim();
  const cn = $('mcNum').value.trim();
  const ct = $('mcTotal').value.trim();
  const lang = $('mcLang').value === 'JP' ? 'JP' : 'EN';
  const r = $('mcRarity').value.trim();
  const sr = $('mcSeries').value.trim();
  const status = $('mcStatus');
  status.className = 'ql-status';
  // Resolve TCGC link → image URL before persisting
  const saveBtn = $('mcSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  const img = await resolveImageInputIfTCGC('mcImg', 'mcImgStatus');
  if (saveBtn) saveBtn.disabled = false;
  if (!name || !set || !cn) {
    status.className = 'ql-status error';
    status.textContent = 'Please fill in name, set, and card number.';
    return;
  }
  // Build a stable id for the custom card. Use a content hash so re-adding
  // the same card later still maps to the same entry.
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'');
  const id = `usr-${lang.toLowerCase()}-${slug(set)}-${slug(name)}-${slug(cn)}`;
  if (getCardById(id)) {
    status.className = 'ql-status error';
    status.textContent = 'A card with these details already exists. Open it from search instead.';
    return;
  }
  const card = {
    i: id, n: name, s: set, sc: '', cn, ct, r: r || '', sr: sr || '',
    p: 0, lang, img: img || '', nj: '',
    _userAdded: true, _custom: true,
  };
  const userCards = loadUserCards();
  userCards.push(card);
  saveUserCards(userCards);
  cardData.cards.push(card);
  cardData.count = cardData.cards.length;
  buildSearchIndex(cardData.cards);
  if (typeof buildCounterpartIndex === 'function') buildCounterpartIndex(cardData.cards);
  // Refresh search-count display
  try {
    const jpCount = cardData.cards.filter(c => c.lang === 'JP').length;
    const enCount = cardData.count - jpCount;
    const userCount = cardData.cards.filter(c => c._userAdded).length;
    const userSuffix = userCount > 0 ? ` + ${userCount} added` : '';
    $('searchCount').textContent =
      `${cardData.count.toLocaleString()} cards (${enCount.toLocaleString()} EN + ${jpCount.toLocaleString()} JP${userSuffix})`;
  } catch {}
  status.className = 'ql-status success';
  status.textContent = 'Card saved. Opening it now…';
  closeManualAdd();
  selectCard(id);
}

function clearCustomCardForm() {
  ['mcName','mcSet','mcNum','mcTotal','mcRarity','mcSeries','mcImg'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('mcLang').value = 'EN';
  $('mcStatus').textContent = '';
  $('mcStatus').className = 'ql-status';
  $('mcName').focus();
}

function setupManualAdd() {
  const open = () => openManualAdd($('searchInput').value.trim());
  const closeBtn = $('maClose');
  const overlay = $('maOverlay');
  if (closeBtn) closeBtn.addEventListener('click', closeManualAdd);
  if (overlay) overlay.addEventListener('click', closeManualAdd);
  const searchBtn = $('maSearchBtn');
  if (searchBtn) searchBtn.addEventListener('click', runManualAddSearch);
  const input = $('maInput');
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runManualAddSearch(); });
  // Tabs
  $('maTabSearch')?.addEventListener('click', () => switchManualAddTab('search'));
  $('maTabCustom')?.addEventListener('click', () => switchManualAddTab('custom'));
  // Custom-card form
  $('mcSaveBtn')?.addEventListener('click', saveCustomCard);
  $('mcClearBtn')?.addEventListener('click', clearCustomCardForm);
  // TCGC URL → image extractor for the custom-add form
  wireTCGCImageInput('mcImg', 'mcImgStatus', { nameId: 'mcName', setId: 'mcSet', numId: 'mcNum' });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('maModal') && $('maModal').style.display !== 'none') closeManualAdd();
  });
  // Make openManualAdd globally reachable for the empty-state button
  window.openManualAdd = openManualAdd;
}

// ================================================================
// Edit Card modal — override details on any card (indexed or user-added)
// ================================================================
function openEditCard() {
  if (!selectedCard) { alert('Select a card first.'); return; }
  const c = selectedCard;
  const orig = c._orig || c; // _orig has untouched values if overrides exist
  $('ecName').value = c.n || '';
  $('ecSet').value = c.s || '';
  $('ecNum').value = c.cn || '';
  $('ecTotal').value = c.ct || '';
  $('ecLang').value = c.lang === 'JP' ? 'JP' : 'EN';
  $('ecRarity').value = c.r || '';
  $('ecSeries').value = c.sr || '';
  $('ecImg').value = c.img || '';
  const sub = $('ecSub');
  const hasOverride = !!loadCardOverrides()[c.i];
  sub.innerHTML = hasOverride
    ? `Editing <code>${escapeHtml(orig.n)}</code> — <strong>currently overridden</strong>. Synced across devices.`
    : `Editing <code>${escapeHtml(c.n)}</code>. Changes sync across devices.`;
  $('ecStatus').textContent = '';
  $('ecStatus').className = 'ql-status';
  $('ecOverlay').style.display = '';
  $('ecOverlay').setAttribute('aria-hidden', 'false');
  $('ecModal').style.display = 'flex';
  setTimeout(() => $('ecName').focus(), 50);
}
function closeEditCard() {
  $('ecOverlay').style.display = 'none';
  $('ecOverlay').setAttribute('aria-hidden', 'true');
  $('ecModal').style.display = 'none';
}
async function saveEditCard() {
  if (!selectedCard) return;
  const c = selectedCard;
  const orig = c._orig || {
    n: c.n, s: c.s, cn: c.cn, ct: c.ct,
    r: c.r, sr: c.sr, lang: c.lang, img: c.img, nj: c.nj,
  };
  // Resolve TCGC link → image URL before reading values
  const saveBtn = $('ecSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  const resolvedImg = await resolveImageInputIfTCGC('ecImg', 'ecImgStatus');
  if (saveBtn) saveBtn.disabled = false;
  const next = {
    n: $('ecName').value.trim(),
    s: $('ecSet').value.trim(),
    cn: $('ecNum').value.trim(),
    ct: $('ecTotal').value.trim(),
    lang: $('ecLang').value === 'JP' ? 'JP' : 'EN',
    r: $('ecRarity').value.trim(),
    sr: $('ecSeries').value.trim(),
    img: resolvedImg,
  };
  const status = $('ecStatus');
  if (!next.n || !next.s || !next.cn) {
    status.className = 'ql-status error';
    status.textContent = "Name, set and card number can't be empty.";
    return;
  }
  // Only persist fields that differ from the original — keeps overrides minimal.
  // Coerce both sides to strings so a numeric `cn=125` matches input `'125'`.
  // For `lang`, treat missing/empty as the implicit default 'EN' (the indexed DB
  // omits the field on English cards), so unchanged language doesn't get saved.
  const diff = {};
  for (const k of Object.keys(next)) {
    let o = orig[k];
    if (k === 'lang' && (o === undefined || o === null || o === '')) o = 'EN';
    o = (o === undefined || o === null) ? '' : String(o);
    if (next[k] !== o) diff[k] = next[k];
  }
  if (!Object.keys(diff).length) {
    clearCardOverride(c.i);
  } else {
    setCardOverride(c.i, diff);
  }
  // Apply immediately to the in-memory card
  if (!c._orig) c._orig = { ...orig };
  for (const k of Object.keys(next)) c[k] = next[k];
  c._edited = Object.keys(diff).length > 0;
  // If this is a user-added card, persist the new shape into the user-cards bucket too
  if (c._userAdded) {
    const userCards = loadUserCards();
    const idx = userCards.findIndex(u => u.i === c.i);
    if (idx >= 0) {
      Object.assign(userCards[idx], next);
      saveUserCards(userCards);
    }
  }
  // Rebuild search/counterpart index because name/set/number affect them
  buildSearchIndex(cardData.cards);
  if (typeof buildCounterpartIndex === 'function') buildCounterpartIndex(cardData.cards);
  // Bust price cache for this card so it re-fetches with the corrected name
  try {
    const cache = getPriceCache();
    delete cache[c.i];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  status.className = 'ql-status success';
  status.textContent = 'Saved. Re-loading the card…';
  closeEditCard();
  selectCard(c.i);
}
function resetEditCard() {
  if (!selectedCard) return;
  const c = selectedCard;
  if (!c._orig && !loadCardOverrides()[c.i]) {
    $('ecStatus').className = 'ql-status';
    $('ecStatus').textContent = 'Nothing to reset — this card has no overrides.';
    return;
  }
  const orig = c._orig;
  clearCardOverride(c.i);
  if (orig) {
    Object.assign(c, orig);
    delete c._orig;
    delete c._edited;
  }
  // For user-added cards we don't have a sensible "original" — keep the
  // current saved values; clearing the override is enough.
  buildSearchIndex(cardData.cards);
  if (typeof buildCounterpartIndex === 'function') buildCounterpartIndex(cardData.cards);
  try {
    const cache = getPriceCache();
    delete cache[c.i];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  closeEditCard();
  selectCard(c.i);
}
function setupEditCard() {
  $('ecClose')?.addEventListener('click', closeEditCard);
  $('ecOverlay')?.addEventListener('click', closeEditCard);
  $('ecSaveBtn')?.addEventListener('click', saveEditCard);
  $('ecResetBtn')?.addEventListener('click', resetEditCard);
  $('linkEditCard')?.addEventListener('click', openEditCard);
  $('linkRefreshImg')?.addEventListener('click', refreshCardImage);
  // TCGC URL → image extractor (don't auto-fill name/set/number when editing
  // an existing card — the user usually keeps those, just refreshing the art).
  wireTCGCImageInput('ecImg', 'ecImgStatus');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('ecModal') && $('ecModal').style.display !== 'none') closeEditCard();
  });

  // Auto-enrich TCGPlayer URL
  $('linkEnrichTcg')?.addEventListener('click', async () => {
    if (!selectedCard) return;
    const card = selectedCard;
    const btn = $('linkEnrichTcg');
    const status = $('linkEnrichStatus');
    const manualWrap = $('linkTcgManualWrap');
    btn.disabled = true;
    status.style.display = 'block';
    status.textContent = 'Collecting TCGPlayer data…';

    // Always bust the price cache so fetchLivePrice re-fetches fresh from pokemontcg.io
    const _enrichCache = getPriceCache();
    delete _enrichCache[card.i];
    try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(_enrichCache)); } catch {}
    // Also clear the in-memory pokemontcg.io link cache so we always get a fresh URL
    pokemonTcgIoCache.delete(card.i);

    try {
      const result = await fetchPokemonTcgIoLinks(card.i);
      if (result && result.tcgplayerUrl) {
        setTcgOverride(card.i, result.tcgplayerUrl);
        // Save card image if the API returned one and the card has no usable image yet
        if (result.imageUrl) {
          const currentImg = card.img || '';
          const hasGoodImg = currentImg && /\.(webp|jpg|jpeg|png|gif|avif)(\?|#|$)/i.test(currentImg);
          if (!hasGoodImg) {
            card.img = result.imageUrl;
            if (typeof setCardOverride === 'function') setCardOverride(card.i, { img: result.imageUrl });
            try {
              const el = document.getElementById('cardImage');
              if (el) el.src = result.imageUrl;
            } catch {}
          }
        }
        status.textContent = 'TCGPlayer link found — fetching live prices…';
      } else {
        status.textContent = 'No TCGPlayer listing found for this card.';
      }
    } catch {
      status.textContent = 'Lookup failed — trying price fetch anyway…';
    } finally {
      btn.disabled = false;
    }

    // Force a fresh live price fetch regardless of URL result — this hits
    // pokemontcg.io for TCGPlayer + Cardmarket prices and updates the panel.
    if (selectedCard && selectedCard.i === card.i) {
      fetchLivePrice(card).then(() => {
        if (selectedCard && selectedCard.i === card.i) {
          const hasTcg = livePrice && livePrice.tcgMarket > 0;
          const s = $('linkEnrichStatus');
          if (s && s.style.display !== 'none') {
            s.textContent = hasTcg
              ? 'TCGPlayer prices loaded.'
              : 'No TCGPlayer prices available for this card — use manual entry below.';
          }
        }
      }).catch(() => {});
    }
  });

  $('linkTcgManualSave')?.addEventListener('click', () => {
    if (!selectedCard) return;
    const card = selectedCard;
    const input = $('linkTcgManualInput');
    const status = $('linkEnrichStatus');
    const url = (input?.value || '').trim();
    if (!url || !url.startsWith('http')) {
      if (status) { status.style.display = 'block'; status.textContent = 'Paste a valid https:// URL.'; }
      return;
    }
    setTcgOverride(card.i, url);
    if (input) input.value = '';

    // If the URL contains a TCGPlayer product ID, bust the price cache and re-fetch
    // so the product-ID lookup fires immediately and populates live prices.
    const productId = extractTcgProductId(url);
    if (productId) {
      if (status) { status.style.display = 'block'; status.textContent = 'URL saved — fetching live prices…'; }
      const _cache = getPriceCache();
      delete _cache[card.i];
      try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(_cache)); } catch {}
      fetchLivePrice(card).then(() => {
        if (selectedCard && selectedCard.i === card.i && status) {
          const hasTcg = livePrice && livePrice.tcgMarket > 0;
          status.textContent = hasTcg
            ? 'TCGPlayer prices loaded.'
            : 'URL saved — no live prices found for this product ID.';
        }
      }).catch(() => {});
    } else {
      if (status) { status.style.display = 'block'; status.textContent = 'URL saved (no product ID found — prices unchanged).'; }
    }
  });

  // Manual TCGPlayer market price — save
  $('linkTcgPriceSave')?.addEventListener('click', () => {
    if (!selectedCard) return;
    const input = $('linkTcgPriceInput');
    const status = $('linkTcgPriceStatus');
    const usd = parseFloat(input?.value);
    if (!usd || usd <= 0) {
      if (status) { status.style.display = 'block'; status.textContent = 'Enter a price in USD greater than 0.'; }
      return;
    }
    setTcgPriceOverride(selectedCard.i, usd);
    // Bust price cache so re-fetch picks up the manual price
    const _cache = getPriceCache();
    delete _cache[selectedCard.i];
    try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(_cache)); } catch {}
    if (status) { status.style.display = 'block'; status.textContent = `Saved $${usd.toFixed(2)} — refreshing…`; }
    fetchLivePrice(selectedCard);
  });

  // Manual TCGPlayer market price — clear
  $('linkTcgPriceClear')?.addEventListener('click', () => {
    if (!selectedCard) return;
    setTcgPriceOverride(selectedCard.i, 0);
    const input = $('linkTcgPriceInput');
    const status = $('linkTcgPriceStatus');
    if (input) input.value = '';
    if (status) { status.style.display = 'block'; status.textContent = 'Cleared — refreshing…'; }
    const _cache = getPriceCache();
    delete _cache[selectedCard.i];
    try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(_cache)); } catch {}
    fetchLivePrice(selectedCard);
  });
}

// Refresh the artwork for the currently selected card. Use this when a CDN URL
// has gone stale or broken and you want to force a fresh fetch / fall back to
// the canonical CDN reconstruction. Clears any saved `img` override and the
// `img` field on a user-added card, then re-renders. Adds a cache-bust query
// to the rendered <img> src so the browser doesn't serve a stale 404.
function refreshCardImage() {
  const c = selectedCard;
  if (!c) return;
  const btn = $('linkRefreshImg');
  if (btn) {
    btn.disabled = true;
    btn.dataset._origLabel = btn.dataset._origLabel || btn.innerHTML;
    btn.innerHTML = btn.dataset._origLabel.replace('Refresh image', 'Refreshing…');
  }
  try {
    // 1) Clear `img` from the per-card override bucket
    try {
      const map = JSON.parse(localStorage.getItem('pkm-card-overrides-v1') || '{}');
      if (map && map[c.i] && 'img' in map[c.i]) {
        delete map[c.i].img;
        if (!Object.keys(map[c.i]).length) delete map[c.i];
        localStorage.setItem('pkm-card-overrides-v1', JSON.stringify(map));
      }
    } catch {}
    // 2) Clear `img` from the user-cards bucket (for user-added cards)
    try {
      if (c._userAdded && typeof loadUserCards === 'function') {
        const userCards = loadUserCards();
        const idx = userCards.findIndex(u => u.i === c.i);
        if (idx >= 0) {
          userCards[idx].img = '';
          if (typeof saveUserCards === 'function') saveUserCards(userCards);
        }
      }
    } catch {}
    // 3) Clear in-memory copy so getCardImg falls through to canonical CDN
    c.img = '';
    // 4) Re-render with a cache-bust suffix so the browser doesn't reuse a
    //    cached 404 response.
    const ts = Date.now();
    const bust = (url) => {
      if (!url || url.startsWith('data:')) return url;
      return url + (url.includes('?') ? '&' : '?') + '_=' + ts;
    };
    const fresh = getCardImg(c);
    const en = $('cardImage'), jp = $('cardImageJp');
    if (en && en.style.display !== 'none') en.src = bust(fresh);
    if (jp && jp.style.display !== 'none') jp.src = bust(fresh);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = btn.dataset._origLabel || btn.innerHTML;
    }
  }
}

// ================================================================
// PWA navigation bar — only visible when running as installed app
// ================================================================
// History stack of selected card IDs so back/forward feel native to the app,
// since the PWA shell doesn't have system browser chrome to use those buttons.
const pwaHistory = { stack: [], idx: -1, suppress: false };

function pwaPushCard(cardId) {
  if (pwaHistory.suppress) return;
  // If we're not at the top, drop forward entries
  if (pwaHistory.idx < pwaHistory.stack.length - 1) {
    pwaHistory.stack = pwaHistory.stack.slice(0, pwaHistory.idx + 1);
  }
  // Avoid duplicate consecutive entries
  if (pwaHistory.stack[pwaHistory.idx] === cardId) return;
  pwaHistory.stack.push(cardId);
  pwaHistory.idx = pwaHistory.stack.length - 1;
  updatePWANavButtons();
}
function pwaBack() {
  // If AI panel is open, close it first rather than navigating cards.
  const aiPanel = document.getElementById('aiChatPanel');
  if (aiPanel && aiPanel.classList.contains('open')) { aiClosePanel(true); return; }
  if (pwaHistory.idx <= 0) return;
  pwaHistory.idx--;
  pwaHistory.suppress = true;
  selectCard(pwaHistory.stack[pwaHistory.idx]);
  pwaHistory.suppress = false;
  updatePWANavButtons();
}
function pwaForward() {
  if (pwaHistory.idx >= pwaHistory.stack.length - 1) return;
  pwaHistory.idx++;
  pwaHistory.suppress = true;
  selectCard(pwaHistory.stack[pwaHistory.idx]);
  pwaHistory.suppress = false;
  updatePWANavButtons();
}
function updatePWANavButtons() {
  const back = $('pwaBack');
  const fwd = $('pwaForward');
  if (back) back.disabled = pwaHistory.idx <= 0;
  if (fwd) fwd.disabled = pwaHistory.idx >= pwaHistory.stack.length - 1;
}

function setupPWANav() {
  // Show the nav bar when we're running standalone (installed PWA)
  // or when the URL has ?pwa=1 (so we can force-test it in regular browsers)
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
    || /[?&]pwa=1\b/.test(window.location.search);
  const nav = $('pwaNav');
  if (!nav) return;
  if (standalone) {
    nav.classList.add('visible');
    document.body.classList.add('pwa-standalone');
  } else {
    nav.classList.remove('visible');
  }

  $('pwaBack').addEventListener('click', pwaBack);
  $('pwaForward').addEventListener('click', pwaForward);
  $('pwaRefresh').addEventListener('click', () => {
    // If a card is selected, just re-fetch its live price; otherwise reload the page
    if (selectedCard) {
      try {
        // Bust the price cache for this card
        const cache = getPriceCache();
        delete cache[selectedCard.i];
        localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
      } catch {}
      fetchLivePrice(selectedCard);
    } else {
      window.location.reload();
    }
  });

  // Also wire native browser back/forward (where available) so they feel consistent
  window.addEventListener('popstate', (e) => {
    // Back gesture while AI panel is open → close the panel, don't navigate.
    const aiPanel = document.getElementById('aiChatPanel');
    if (aiPanel && aiPanel.classList.contains('open')) {
      aiClosePanel(true); // true = called from popstate, skip history.back()
      return;
    }
    if (e.state && e.state.cardId) {
      pwaHistory.suppress = true;
      selectCard(e.state.cardId);
      pwaHistory.suppress = false;
    }
  });

  // Hook into selectCard to push history
  const origSelectCard = window.selectCard;
  if (typeof origSelectCard === 'function') {
    window.selectCard = function(id) {
      const before = selectedCard?.i;
      origSelectCard.apply(this, arguments);
      if (selectedCard && selectedCard.i !== before) {
        pwaPushCard(selectedCard.i);
        try { history.pushState({ cardId: selectedCard.i }, '', '#' + selectedCard.i); } catch {}
      }
    };
  }

  updatePWANavButtons();
}

// ---- Boot ----
init();

// =============================================================
// PREDICT TAB BAR
// Market | Strategy | Grade tabs for the right-column sections
// =============================================================

function _predictTabActivate(tab) {
  const saved = tab || localStorage.getItem('predict-active-tab') || 'market';
  if (tab) localStorage.setItem('predict-active-tab', saved);
  const tabBar = document.getElementById('predictTabBar');
  if (!tabBar) return;
  tabBar.querySelectorAll('.ptab').forEach(btn => {
    const isActive = btn.dataset.ptab === saved;
    btn.classList.toggle('ptab-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('[data-tab-group]').forEach(el => {
    el.classList.toggle('ptab-hidden', el.dataset.tabGroup !== saved);
  });
}

function _initPredictTabs() {
  const tabBar = document.getElementById('predictTabBar');
  if (!tabBar || tabBar._wired) return;
  tabBar._wired = true;
  tabBar.querySelectorAll('.ptab').forEach(btn => {
    btn.addEventListener('click', () => _predictTabActivate(btn.dataset.ptab));
  });
  _predictTabActivate();
}

// =============================================================
// SNAPSHOT MODAL
// Screenshot-ready card summary for sharing
// =============================================================

function _openSnapshot() {
  if (!selectedCard) return;
  const card = selectedCard;
  const modal = document.getElementById('snapshotModal');
  const content = document.getElementById('snapshotContent');
  if (!modal || !content) return;

  const imgUrl = getCardImg(card);
  const marketPrice = document.getElementById('liveMainPrice')?.textContent.trim() || fmtGBP(card.p);
  const psa10Price  = document.getElementById('psa10GBP')?.textContent.trim() || (card.p10 > 0 ? fmtGBP(card.p10) : '—');
  const maxBuy      = document.getElementById('maxPriceGBP')?.textContent.trim() || '—';
  const signalEl    = document.getElementById('signalBadge');
  const signalText  = signalEl?.textContent.trim() || '';
  const signalCls   = signalEl?.className.replace('signal-badge', '').trim() || '';

  let holdLabel = '—', yr5 = '—', roiPct = '';
  try {
    const hc = computeHoldCore(card);
    if (hc && hc.bestLongTermPick) {
      const p = hc.bestLongTermPick;
      holdLabel = p.label || '—';
      const _fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
      if (p.yr5 > 0) yr5 = fmtGBPDirect(p.yr5 * _fx);
      if (p.roi > 0)  roiPct = `+${p.roi.toFixed(0)}%`;
    }
  } catch(e) {}

  const today = new Date().toLocaleDateString('en-GB');
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  content.innerHTML = `
    <div class="snapshot-card-layout">
      <div class="snapshot-img-wrap">
        <img src="${esc(imgUrl)}" alt="" class="snapshot-img" loading="lazy" onerror="_onImgError(this)">
      </div>
      <div class="snapshot-details">
        <div class="snapshot-card-name">${esc(card.n)}</div>
        <div class="snapshot-card-set">${esc(card.s)}${card.cn ? ' · #' + esc(card.cn) : ''}${card.r ? ' · ' + esc(card.r) : ''}</div>
        ${signalText ? `<div class="snapshot-signal-badge ${esc(signalCls)}">${esc(signalText)}</div>` : ''}
        <div class="snapshot-stats-grid">
          <div class="snapshot-stat"><span class="ss-label">Market</span><span class="ss-val">${esc(marketPrice)}</span></div>
          <div class="snapshot-stat"><span class="ss-label">PSA 10</span><span class="ss-val">${esc(psa10Price)}</span></div>
          <div class="snapshot-stat"><span class="ss-label">Max buy</span><span class="ss-val">${esc(maxBuy)}</span></div>
          <div class="snapshot-stat"><span class="ss-label">5yr target</span><span class="ss-val">${esc(yr5)}${roiPct ? ' <small style="font-size:10px;opacity:0.7">' + esc(roiPct) + '</small>' : ''}</span></div>
        </div>
        <div class="snapshot-hold-verdict">${esc(holdLabel)}</div>
        <div class="snapshot-meta"><span>${esc(today)}</span><span>pokémon price predictor</span></div>
      </div>
    </div>
  `;

  modal.style.display = 'flex';
}

// Wire snapshot button and modal close
(function _wireSnapshot() {
  document.getElementById('predictSnapshotBtn')?.addEventListener('click', _openSnapshot);
  function _closeSnapshot() {
    const m = document.getElementById('snapshotModal');
    if (m) m.style.display = 'none';
  }
  document.getElementById('snapshotClose')?.addEventListener('click', _closeSnapshot);
  document.getElementById('snapshotBackdrop')?.addEventListener('click', _closeSnapshot);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeSnapshot(); });
})();

// Initialise predict tabs once the DOM is ready
_initPredictTabs();

// =============================================================
// Homepage tab groups (Watchlist/Wishlist · Recommendations · Buy)
// =============================================================

function _homeTabActivate(groupId, tab) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.ptab').forEach(btn => {
    const active = btn.dataset.htab === tab;
    btn.classList.toggle('ptab-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  group.querySelectorAll('.home-htab-panel').forEach(panel => {
    panel.style.display = panel.dataset.htabPanel === tab ? '' : 'none';
  });
  try { localStorage.setItem('home-tab-' + groupId, tab); } catch {}
}

function _initHomeTabs() {
  ['hTabColl', 'hTabWW', 'hTabReco', 'hTabBuy'].forEach(groupId => {
    const group = document.getElementById(groupId);
    if (!group || group._wired) return;
    group._wired = true;
    group.querySelectorAll('.ptab').forEach(btn => {
      btn.addEventListener('click', () => {
        _homeTabActivate(groupId, btn.dataset.htab);
        if ((groupId === 'hTabColl' && btn.dataset.htab === 'coll-grading') ||
            (groupId === 'hTabWW'  && btn.dataset.htab === 'grading')) {
          _homeGradingHash = '';
          try { _renderHomeConsiderGrading(); } catch {}
        }
      });
    });
    const saved = (() => { try { return localStorage.getItem('home-tab-' + groupId); } catch { return null; } })();
    const first = group.querySelector('.ptab')?.dataset?.htab;
    _homeTabActivate(groupId, saved || first);
  });
}

_initHomeTabs();

// =============================================================
// PSA 1-10 Grade Range · Forecast across grades
// =============================================================
//
// What this does
// ---------------
// For the currently-selected card, estimates a market price for each PSA
// grade (1 through 10) AND projects each one 1/3/5 years forward using the
// same forecasting model that powers the headline 5yr forecast (rarity rate
// × character premium × age multiplier × market momentum). Lower grades
// appreciate slightly slower than gem mint copies — historical PSA data
// supports a small "grade growth premium" for PSA 9/10 vs lower grades, so we
// scale the annual growth rate by GRADE_GROWTH_PREMIUM[g].
//
// The price ratio of each PSA grade vs PSA 10 is calibrated from typical
// modern-era market data (PSA 10 = 1.0×). PSA 9 is roughly 30-40% of PSA 10;
// PSA 8 about 15-20%; lower grades drop off quickly. These are reasonable
// defaults — for any individual card the ratio varies, but they're good
// enough to drive a "should I buy a PSA 7 instead?" decision.

const PSA_COLORS = {
  10: '#e8b634', 9: '#3dd68c', 8: '#4a9eff', 7: '#a78bfa',
  6: '#fb923c',  5: '#f472b6', 4: '#94a3b8', 3: '#708090',
  2: '#9ca3af',  1: '#c4c9d4',
};

// Price ratio of each grade vs PSA 10 (PSA 10 = 1.0).
const PSA_RATIOS = {
  10: 1.00,
  9:  0.35,
  8:  0.18,
  7:  0.11,
  6:  0.07,
  5:  0.055,
  4:  0.045,
  3:  0.035,
  2:  0.028,
  1:  0.022,
};

// Annual growth premium per grade. PSA 10s appreciate faster than ungraded;
// low grades appreciate slower (less collector demand, more supply churn).
const GRADE_GROWTH_PREMIUM = {
  10: 1.15,
  9:  1.05,
  8:  0.95,
  7:  0.85,
  6:  0.78,
  5:  0.72,
  4:  0.68,
  3:  0.65,
  2:  0.62,
  1:  0.60,
};

// Returns an adjusted PSA 9/8 ratio based on gem rate.
// Low gem rate = scarce PSA 10s = wider premium gap vs lower grades.
// High gem rate = many PSA 10s = grades 8/9 relatively closer.
function _gemRateGradeRatio(card, grade) {
  const base = PSA_RATIOS[grade] || 0;
  if (grade !== 9 && grade !== 8) return base;
  const g = card && card.g != null ? card.g : null;
  if (g === null) return base;
  if (g < 0.05) return base * (grade === 9 ? 0.68 : 0.72); // very hard — 10s command steep premium
  if (g < 0.15) return base * (grade === 9 ? 0.85 : 0.88); // moderately hard
  if (g >= 0.30) return base * (grade === 9 ? 1.20 : 1.15); // easy grade — 9s worth more relative
  return base; // normal range — no adjustment
}

// Compute estimated price for a single PSA grade.
function estimateGradePrice(card, grade, psa10Price) {
  if (!psa10Price || psa10Price <= 0) return 0;
  return psa10Price * _gemRateGradeRatio(card, grade);
}

// Project a grade's price forward `years`, using the same base rate the
// 5yr forecast uses, scaled by the grade-growth premium.
function projectGradePrice(card, grade, currentGradePrice, years) {
  if (!currentGradePrice) return 0;
  const rarityRate = (RARITY_RATES[card.rc] || RARITY_RATES['']).base;
  const charMult = getCharacterMultiplier(card.n);
  const ageMonths = getSetAgeMonths(card.sc);
  const ageMult = getAgeMultiplier(ageMonths, years);
  const annualRate = rarityRate * charMult * ageMult * (GRADE_GROWTH_PREMIUM[grade] || 1);
  const momentum = getMarketMomentum();
  // Momentum fade: full impact yr1, half yr2, neutral yr3+
  const momFade = years === 1 ? momentum.mult : years === 2 ? (1 + (momentum.mult - 1) * 0.5) : 1.0;
  const adjRate = annualRate * momFade;
  return currentGradePrice * Math.pow(1 + adjRate, years);
}

let _psaActiveGrades = new Set([10, 9, 8, 7]);
let _psaChartRows    = [];
let _psaHoverYear    = null;
let _psaChartState   = null;

// Render the PSA 1-10 grade range chart on the selected card.
function renderPsaGradeRange(card, pullCost, desirability) {
  const section = $('psaRangeSection');
  if (!section || !card) return;
  const anchor = getPsa10Anchor(card);
  const psa10Price = anchor.usd;
  const isJP = card.lang === 'JP';
  // Show manual anchor input for JP cards OR any user-added card that lacks a
  // tracked/live PSA 10 (i.e. not in the static DB and no PC live data yet).
  const needsManual = (isJP || card._userAdded) && anchor.source !== 'tracked' && anchor.source !== 'live';
  const jpManualRow = $('psaJpManualRow');
  const jpManualInput = $('psaJpManualInput');
  const jpManualSave = $('psaJpManualSave');
  const jpManualSaved = $('psaJpManualSaved');
  const jpManualLabel = $('psaJpManualLabel');

  function wireManualRow() {
    if (!jpManualRow) return;
    jpManualRow.style.display = 'flex';
    if (jpManualLabel) jpManualLabel.textContent = isJP ? 'JP PSA 10 anchor price' : 'PSA 10 anchor price';
    const existing = getJpPsa10Override(card.i);
    if (jpManualInput) jpManualInput.value = existing ? existing.gbp : '';
    if (jpManualSaved) jpManualSaved.textContent = existing ? `Saved ${existing.date || ''}` : '';
    if (jpManualSave) {
      jpManualSave.onclick = () => {
        const val = parseFloat(jpManualInput?.value);
        if (!val || val <= 0) return;
        const dateStr = new Date().toISOString().slice(0, 10);
        setJpPsa10Override(card.i, val, dateStr);
        if (jpManualSaved) jpManualSaved.textContent = `Saved ${dateStr}`;
        renderPsaGradeRange(card, pullCost, desirability);
      };
    }
  }

  // No anchor and card needs manual input: show section with just the input row
  if (needsManual && (!psa10Price || psa10Price <= 0)) {
    section.style.display = 'block';
    wireManualRow();
    ['psaAnchorBadge', 'psaGradeToggles', 'psaRangeChart', 'psaRangeFootnote'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'none';
    });
    return;
  }

  if (!psa10Price || psa10Price <= 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  // Restore chart element visibility
  ['psaGradeToggles', 'psaRangeChart', 'psaRangeFootnote'].forEach(id => {
    const el = $(id); if (el) el.style.display = ''; });
  // Show manual row alongside the chart for JP/user-added cards with estimated anchor
  if (jpManualRow) {
    if (needsManual) wireManualRow();
    else jpManualRow.style.display = 'none';
  }
  const psaAnchorBadge = $('psaAnchorBadge');
  if (psaAnchorBadge) {
    if (anchor.source === 'estimated') {
      psaAnchorBadge.style.display = 'inline-flex';
      psaAnchorBadge.title = `PSA 10 anchor estimated as raw × ${anchor.multiplier || 2}. Accuracy ±30%.`;
      psaAnchorBadge.textContent = 'EST. PSA 10';
    } else {
      psaAnchorBadge.style.display = 'none';
    }
  }

  const rawPriceUSD = getCurrentPrice(card);
  const grades = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  // Compute all years 0-5 for each grade
  _psaChartRows = grades.map(g => {
    const todayUSD = estimateGradePrice(card, g, psa10Price);
    const prices = [0,1,2,3,4,5].map(yr => yr === 0 ? todayUSD : projectGradePrice(card, g, todayUSD, yr));
    const roi5 = todayUSD > 0 ? ((prices[5] - todayUSD) / todayUSD) * 100 : 0;
    let verdict;
    if (roi5 >= 50) verdict = 'Strong pick';
    else if (roi5 >= 25) verdict = 'Worth a look';
    else if (roi5 >= 10) verdict = 'Fair';
    else verdict = 'Skip';
    return { g, prices, roi5, verdict };
  });

  const bestRow = _psaChartRows.reduce((b, r) => r.roi5 > b.roi5 ? r : b);

  // Grade toggle pills
  const togglesEl = $('psaGradeToggles');
  if (togglesEl) {
    togglesEl.innerHTML = grades.map(g => {
      const active = _psaActiveGrades.has(g);
      const isBest = g === bestRow.g;
      return `<button class="psa-grade-btn${active ? ' is-active' : ''}" data-grade="${g}"
        style="--gc:${PSA_COLORS[g]}" title="${isBest ? 'Best 5yr ROI · ' : ''}${_psaChartRows.find(r=>r.g===g).verdict}">
        PSA ${g}${isBest ? ' ★' : ''}
      </button>`;
    }).join('');
    togglesEl.querySelectorAll('.psa-grade-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const g = parseInt(btn.dataset.grade, 10);
        if (_psaActiveGrades.has(g)) {
          if (_psaActiveGrades.size <= 1) return;
          _psaActiveGrades.delete(g);
        } else {
          _psaActiveGrades.add(g);
        }
        btn.classList.toggle('is-active', _psaActiveGrades.has(g));
        drawPsaChart();
      });
    });
  }

  // Footnote
  const rateLabel = (RARITY_RATES[card.rc] || RARITY_RATES['']).label;
  const annualPctAt10 = (((_psaChartRows[0].prices[1] / _psaChartRows[0].prices[0]) - 1) * 100).toFixed(1);
  const rawPart = (rawPriceUSD && rawPriceUSD > 0) ? ` · raw ≈ ${fmtGBP(rawPriceUSD)}` : '';
  $('psaRangeFootnote').innerHTML = `
    Anchored on PSA 10 = ${fmtGBP(psa10Price)}${rawPart} · ${rateLabel} · ${annualPctAt10}% annual growth at PSA 10.
    Model suggests <strong>PSA ${bestRow.g}</strong> offers the strongest 5yr ROI (${bestRow.roi5 >= 0 ? '+' : ''}${bestRow.roi5.toFixed(0)}%).
    Toggle grades above to compare. Ratios are typical-modern; individual cards can deviate ±30%.
  `;

  // Draw immediately if visible, otherwise wait for section expand or column resize
  requestAnimationFrame(() => {
    const canvas = $('psaRangeChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 10) {
      drawPsaChart(null);
      setupPsaChartHover();
    } else {
      // Section is collapsed — redraw when it becomes visible
      const ro = new ResizeObserver(() => {
        const r = canvas.getBoundingClientRect();
        if (r.width > 10) { ro.disconnect(); drawPsaChart(null); setupPsaChartHover(); }
      });
      ro.observe(canvas);
    }
  });
}

function drawPsaChart(hoverYr) {
  const canvas = $('psaRangeChart');
  if (!canvas || !_psaChartRows.length) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const gridCol  = isLight ? 'rgba(0,0,0,0.08)'  : 'rgba(255,255,255,0.07)';
  const labelCol = isLight ? '#6b7280' : '#555768';

  const activeRows = _psaChartRows.filter(r => _psaActiveGrades.has(r.g));
  if (!activeRows.length) return;

  const allGBP = activeRows.flatMap(r => r.prices.map(p => usdToGbp(p)));
  const maxP = Math.max(...allGBP) * 1.18;

  const pad = { l: 56, r: 52, t: 16, b: 32 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  function xv(yr) { return pad.l + (yr / 5) * cw; }
  function yv(p)  { return maxP > 0 ? pad.t + ch * (1 - p / maxP) : pad.t + ch; }

  _psaChartState = { pad, cw, maxP, xv, yv, W, H };

  ctx.clearRect(0, 0, W, H);

  // Grid + Y labels
  for (let i = 0; i <= 4; i++) {
    const gp = (maxP / 4) * i;
    const gy = yv(gp);
    ctx.strokeStyle = gridCol; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    ctx.fillStyle = labelCol;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`£${Math.round(gp).toLocaleString()}`, pad.l - 6, gy + 4);
  }

  // X labels
  ctx.textAlign = 'center';
  ctx.fillStyle = labelCol;
  ctx.font = '11px Space Grotesk, sans-serif';
  for (let yr = 0; yr <= 5; yr++) {
    ctx.fillText(yr === 0 ? 'Now' : `${yr}yr`, xv(yr), H - 8);
  }

  // Draw grade lines (lower grades first so PSA 10 renders on top)
  [...activeRows].reverse().forEach(row => {
    const col = PSA_COLORS[row.g];
    const gbp  = row.prices.map(p => usdToGbp(p));

    // Subtle area fill
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(xv(0), yv(gbp[0]));
    for (let yr = 1; yr <= 5; yr++) ctx.lineTo(xv(yr), yv(gbp[yr]));
    ctx.lineTo(xv(5), yv(0)); ctx.lineTo(xv(0), yv(0)); ctx.fill();
    ctx.globalAlpha = 1;

    // Smooth bezier line
    ctx.strokeStyle = col;
    ctx.lineWidth = row.g === 10 ? 2.5 : 1.8;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(xv(0), yv(gbp[0]));
    for (let yr = 1; yr <= 5; yr++) {
      const cx = (xv(yr - 1) + xv(yr)) / 2;
      ctx.bezierCurveTo(cx, yv(gbp[yr-1]), cx, yv(gbp[yr]), xv(yr), yv(gbp[yr]));
    }
    ctx.stroke();

    // End label (grade number)
    const endGBP = gbp[5];
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(xv(5), yv(endGBP), 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${row.g === 10 ? 'bold ' : ''}10px JetBrains Mono, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(String(row.g), xv(5) + 7, yv(endGBP) + 4);
  });

  // Start dots
  activeRows.forEach(row => {
    ctx.fillStyle = PSA_COLORS[row.g];
    ctx.beginPath(); ctx.arc(xv(0), yv(usdToGbp(row.prices[0])), 3, 0, Math.PI * 2); ctx.fill();
  });

  // Hover crosshair + highlight dots
  if (hoverYr != null) {
    const hx = xv(hoverYr);
    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    activeRows.forEach(row => {
      const col = PSA_COLORS[row.g];
      const hy = yv(usdToGbp(row.prices[hoverYr]));
      ctx.fillStyle = isLight ? '#fff' : '#0a0b12';
      ctx.beginPath(); ctx.arc(hx, hy, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2); ctx.fill();
    });
  }
}

function setupPsaChartHover() {
  const canvas = $('psaRangeChart');
  const tooltip = $('psaChartTooltip');
  if (!canvas || !tooltip) return;
  // Remove old listeners by cloning
  const fresh = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(fresh, canvas);
  const c = $('psaRangeChart');

  function getYr(e) {
    if (!_psaChartState) return null;
    const r = c.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const rel = (cx - r.left - _psaChartState.pad.l) / _psaChartState.cw * 5;
    return Math.max(0, Math.min(5, Math.round(rel)));
  }

  function showTip(yr, e) {
    _psaHoverYear = yr;
    drawPsaChart(yr);
    const activeRows = _psaChartRows.filter(r => _psaActiveGrades.has(r.g));
    const label = yr === 0 ? 'Today' : `Year ${yr}`;
    const rows = activeRows.map(row => {
      const gbp = usdToGbp(row.prices[yr]);
      const roi = yr === 0 ? '' : `+${(((row.prices[yr] - row.prices[0]) / row.prices[0]) * 100).toFixed(0)}%`;
      return `<div class="psa-tip-row">
        <span class="psa-tip-dot" style="background:${PSA_COLORS[row.g]}"></span>
        <span class="psa-tip-grade">PSA ${row.g}</span>
        <span class="psa-tip-price">${fmtGBP(gbp)}</span>
        ${yr > 0 ? `<span class="psa-tip-roi">${roi}</span>` : ''}
      </div>`;
    }).join('');
    tooltip.innerHTML = `<div class="psa-tip-head">${label}</div>${rows}`;
    tooltip.style.display = 'block';
  }

  function hideTip() {
    _psaHoverYear = null;
    tooltip.style.display = 'none';
    drawPsaChart(null);
  }

  c.addEventListener('mousemove', e => { const yr = getYr(e); if (yr !== null) showTip(yr, e); });
  c.addEventListener('mouseleave', hideTip);
  c.addEventListener('touchstart', e => { e.preventDefault(); const yr = getYr(e); if (yr !== null) showTip(yr, e); }, { passive: false });
  c.addEventListener('touchmove',  e => { e.preventDefault(); const yr = getYr(e); if (yr !== null) showTip(yr, e); }, { passive: false });
  c.addEventListener('touchend', hideTip);

  // Redraw on column resize
  new ResizeObserver(() => { if (_psaChartRows.length) drawPsaChart(_psaHoverYear); }).observe(c);
}

// =============================================================
// Watchlist (memory: cards you're keeping an eye on)
// =============================================================
//
// Distinct from Wishlist (which tracks a target buy price). The Watchlist is
// signal-driven: you save a card and we tell you the moment the model flips
// it to BUY or STRONG BUY. We also remember the signal state at the time you
// added it, so we can detect *transitions* (HOLD → BUY) rather than just
// listing all currently-BUY cards (which would be noise).
//
// Schema (localStorage `pkm-watchlist-v1`):
//   { id, name, set, lang, img, addedAt, addedSignal, addedScore,
//     lastNotifiedSignal, lastNotifiedAt, addedPriceUSD }

const WATCHLIST_KEY = 'pkm-watchlist-v1';
const WATCHLIST_ALERT_DISMISS_KEY = 'pkm-watchlist-dismissed-v1';
const SEEN_DEALS_KEY    = 'pkm-seen-deal-ids';    // device-local, NOT synced
const DEAL_HISTORY_KEY  = 'pkm-deal-history-v1';  // device-local, NOT synced

// ---- eBay deal polling + toast ----
let _seenDealIds = new Set();
try { _seenDealIds = new Set(JSON.parse(localStorage.getItem(SEEN_DEALS_KEY) || '[]')); } catch {}

let _dealHistory = [];
try { _dealHistory = JSON.parse(localStorage.getItem(DEAL_HISTORY_KEY) || '[]'); } catch {}

let _dealToastUrl  = null;
let _dealToastCard = null; // card object for the currently visible toast
let _toastHideTimer = null;

function _timeAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function hideDealToast() {
  const el = document.getElementById('dealToast');
  if (el) el.style.display = 'none';
  clearTimeout(_toastHideTimer);
}

function showDealToast(card, deal, fairValueGBP) {
  _dealToastUrl  = deal.url || null;
  _dealToastCard = card;
  const el   = document.getElementById('dealToast');
  const body = document.getElementById('dealToastBody');
  if (!el || !body) return;

  const priceStr = deal.priceGBP ? `£${deal.priceGBP.toFixed(2)}` : '';
  const savePct  = deal.spreadPct > 0 ? ` — ${deal.spreadPct.toFixed(0)}% below fair value` : '';
  body.innerHTML = `<strong>${card.n}</strong><br>${deal.signal}: ${priceStr}${savePct}`;
  el.style.display = 'block';
  clearTimeout(_toastHideTimer);
  _toastHideTimer = setTimeout(hideDealToast, 14000);

  // Persist to deal history
  const entry = {
    id: deal.url || deal.title || `${card.i}-${Date.now()}`,
    cardId: card.i,
    cardName: card.n,
    cardImg: (typeof getCardImg === 'function') ? getCardImg(card) : '',
    signal: deal.signal || '',
    priceGBP: deal.priceGBP || 0,
    fairValueGBP: fairValueGBP || 0,
    spreadPct: deal.spreadPct || 0,
    url: deal.url || '',
    ts: Date.now()
  };
  _dealHistory.unshift(entry);
  if (_dealHistory.length > 50) _dealHistory = _dealHistory.slice(0, 50);
  localStorage.setItem(DEAL_HISTORY_KEY, JSON.stringify(_dealHistory));
  _updateDealHistoryBadge();
}

function _updateDealHistoryBadge() {
  const badge = document.getElementById('dealHistoryCount');
  if (!badge) return;
  if (_dealHistory.length > 0) {
    badge.textContent = _dealHistory.length > 9 ? '9+' : String(_dealHistory.length);
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function renderDealHistory() {
  const list = $('alertsList');
  if (!list) return;
  if (_dealHistory.length === 0) {
    list.innerHTML = `<div class="portfolio-empty">No deal alerts yet. Deals appear here when a watched card shows strong eBay value — you'll get a notification automatically.</div>`;
    return;
  }
  const now = Date.now();
  list.innerHTML = _dealHistory.map((entry, idx) => {
    const age = _timeAgo(now - entry.ts);
    const sigClass = (entry.signal || '').includes('STRONG') ? 'sig-strong' : 'sig-buy';
    const savingStr = entry.spreadPct > 0 ? `${entry.spreadPct.toFixed(0)}% below fair` : '';
    const priceStr = entry.priceGBP ? `£${entry.priceGBP.toFixed(2)}` : '';
    const fairStr  = entry.fairValueGBP ? `£${entry.fairValueGBP.toFixed(2)}` : '';
    return `
      <div class="deal-history-item">
        ${entry.cardImg ? `<img class="alert-item-img" src="${esc(entry.cardImg)}" alt="" loading="lazy" decoding="async" onerror="_onImgError(this)">` : '<div class="alert-item-img"></div>'}
        <div class="deal-history-info">
          <div class="deal-history-name">${esc(entry.cardName)}</div>
          <div class="deal-history-price">
            <span class="alert-item-signal ${sigClass}">${esc(entry.signal)}</span>
            ${priceStr ? `<span class="deal-history-gbp">${priceStr}</span>` : ''}
            ${savingStr ? `<span class="deal-history-saving">${savingStr}</span>` : ''}
            ${fairStr ? `<span class="deal-history-fair">fair ${fairStr}</span>` : ''}
          </div>
          <div class="deal-history-time">${age}</div>
        </div>
        <div class="deal-history-actions">
          <button class="deal-open-card-btn" data-idx="${idx}" type="button">Open card</button>
          ${entry.url ? `<a class="deal-ebay-link" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">eBay ↗</a>` : ''}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.deal-open-card-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = _dealHistory[parseInt(btn.dataset.idx, 10)];
      if (!entry) return;
      $('alertsPanel').style.display = 'none';
      selectCard(entry.cardId);
      document.querySelector('.page-nav-btn[data-page="predict"]')?.click();
    });
  });
}

async function pollWatchlistDeals() {
  if (!cardData || !watchlist.length || document.visibilityState !== 'visible') return;
  const workerUrl = (typeof getMktWorkerUrl === 'function') ? getMktWorkerUrl() : '';
  if (!workerUrl) return;
  const fx = fxRate || 0.79;
  const fxEur = _currencyRates.EUR > 0 ? 1 / _currencyRates.EUR : 0.86; // EUR→GBP from live rate

  // Rotate through watchlist cards to spread load — 3 per poll cycle
  const slice = watchlist.slice(0, 3);
  for (const w of slice) {
    const card = getCardById(w.id);
    if (!card) continue;
    const pull = (function () {
      try {
        if (setsData && setsData[card.sc]) {
          const set = setsData[card.sc];
          const rarity = set.rarities?.[card.rc];
          if (rarity && rarity.pullRate > 0) return (Math.round(1 / rarity.pullRate) * rarity.count) / 100;
        }
      } catch {}
      return 7.65;
    })();
    const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pull).total : 50;
    const { priceUSD } = predictPrice(pull, des);
    const fairGBP = usdToGbp(priceUSD);
    if (!fairGBP || fairGBP <= 0) continue;
    const q = (typeof buildSearchQuery === 'function') ? buildSearchQuery(card, 'raw') : card.n;
    const url = `${workerUrl}/search?q=${encodeURIComponent(q)}&max=${fairGBP.toFixed(2)}&grade=raw&fx=${fx}&fxEur=${fxEur}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const d of (data.deals || [])) {
        const sc = (typeof mktScoreDeal === 'function') ? mktScoreDeal(d, card, 'raw', fairGBP, fx) : null;
        if (!sc || sc.spreadPct < 15) continue; // only STRONG VALUE (>=25) or VALUE (>=8, capped at 15 here)
        const key = d.url || d.title;
        if (!key || _seenDealIds.has(key)) continue;
        _seenDealIds.add(key);
        if (_seenDealIds.size > 500) {
          const [oldest] = _seenDealIds;
          _seenDealIds.delete(oldest);
        }
        localStorage.setItem(SEEN_DEALS_KEY, JSON.stringify([..._seenDealIds]));
        showDealToast(card, { ...d, ...sc }, fairGBP);
        return; // one toast at a time
      }
    } catch {}
  }
}

let _dealPollTimer = null;
let _dealPollInFlight = false;
function _pollGuarded() {
  if (_dealPollInFlight) return;
  _dealPollInFlight = true;
  Promise.resolve(pollWatchlistDeals()).finally(() => { _dealPollInFlight = false; });
}
function startDealPolling() {
  if (_dealPollTimer) return; // already running
  _dealPollTimer = setInterval(_pollGuarded, 5 * 60 * 1000); // every 5 min
  setTimeout(_pollGuarded, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _pollGuarded();
  });
}
let watchlist = [];
try { watchlist = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]'); } catch { watchlist = []; }
// Active alerts the user has dismissed (cardId -> signal they dismissed for).
// If the signal flips back and then to BUY again we re-alert.
let dismissedAlerts = {};
try { dismissedAlerts = JSON.parse(localStorage.getItem(WATCHLIST_ALERT_DISMISS_KEY) || '{}'); } catch { dismissedAlerts = {}; }

function saveWatchlist() { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist)); _recoCached = null; }
function saveDismissed() { localStorage.setItem(WATCHLIST_ALERT_DISMISS_KEY, JSON.stringify(dismissedAlerts)); }

function isWatched(cardId) { return watchlist.some(w => w.id === cardId); }

function toggleCardInWatchlist(id) {
  const card = id ? (getCardById(id)) : selectedCard;
  if (!card) return;
  const cardId = card.i;
  const idx = watchlist.findIndex(w => w.id === cardId);
  if (idx >= 0) {
    watchlist.splice(idx, 1);
    delete dismissedAlerts[cardId];
    saveDismissed();
  } else {
    const pull = (function () {
      try { return calcPullCost().pullCost; } catch { return 7.65; }
    })();
    const des = autoFillDesirability(card, pull).total;
    const sig = computeSignal(card, pull, des);
    watchlist.push({
      id: cardId,
      name: card.n,
      set: card.s,
      lang: card.lang || 'EN',
      img: getCardImg(card),
      addedAt: new Date().toISOString(),
      addedSignal: sig?.signal || 'HOLD',
      addedScore: sig?.score || 0,
      addedPriceUSD: getCurrentPrice(card),
      lastNotifiedSignal: sig?.signal || 'HOLD',
      lastNotifiedAt: new Date().toISOString(),
    });
  }
  saveWatchlist();
  updateWatchButton();
  refreshAlerts();
}

function updateWatchButton() {
  const btn = $('watchBtn');
  if (!btn) return;
  if (!selectedCard) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  const watched = isWatched(selectedCard.i);
  btn.classList.toggle('is-watching', watched);
  const label = $('watchBtnLabel');
  if (label) label.textContent = watched ? 'Watching · tap to stop' : 'Watch this card';
}

// Recompute current signal for every watched card and surface those that have
// transitioned into BUY / STRONG BUY territory since they were last seen.
function computeActiveAlerts() {
  if (!cardData) return [];
  const out = [];
  for (const w of watchlist) {
    const card = getCardById(w.id);
    if (!card) continue;
    const pull = (function () {
      try {
        if (setsData && setsData[card.sc]) {
          const set = setsData[card.sc];
          const rarity = set.rarities?.[card.rc];
          if (rarity && rarity.pullRate > 0) {
            const packsPerHit = Math.round(1 / rarity.pullRate);
            return (packsPerHit * rarity.count) / 100;
          }
        }
      } catch {}
      return 7.65;
    })();
    const des = autoFillDesirability(card, pull).total;
    const sig = computeSignal(card, pull, des);
    if (!sig) continue;
    const currentPriceUSD = getCurrentPrice(card);
    const isPositive = sig.signal === 'BUY' || sig.signal === 'STRONG BUY';
    const wasPositive = w.addedSignal === 'BUY' || w.addedSignal === 'STRONG BUY';
    // "Makes financial sense" = signal is BUY/STRONG BUY now AND the user
    // wasn't already seeing that when they added it (so it's a real change).
    // Also flag if the price has dropped 10%+ from added price even at HOLD.
    const transitioned = isPositive && !wasPositive;
    const priceDropPct = w.addedPriceUSD > 0 ? ((w.addedPriceUSD - currentPriceUSD) / w.addedPriceUSD) * 100 : 0;
    const bigDrop = priceDropPct >= 10;
    const triggered = transitioned || bigDrop;
    out.push({
      ...w,
      card,
      signal: sig.signal,
      score: sig.score,
      reasons: sig.reasons || [],
      currentPriceUSD,
      currentPriceGBP: usdToGbp(currentPriceUSD),
      priceDropPct,
      triggered,
      transitioned,
      bigDrop,
      dismissedFor: dismissedAlerts[w.id] || null,
    });
  }
  return out;
}

function setupWatchlist() {
  $('watchBtn')?.addEventListener('click', () => toggleCardInWatchlist());
  $('alertsToggle')?.addEventListener('click', () => {
    toggleSidePanel('alertsPanel');
    if ($('alertsPanel').style.display === 'block') refreshAlerts();
  });
  $('alertsClose')?.addEventListener('click', () => { $('alertsPanel').style.display = 'none'; });
  $('alertsTabActive')?.addEventListener('click', () => switchAlertsTab('active'));
  $('alertsTabWatching')?.addEventListener('click', () => switchAlertsTab('watching'));
  $('alertsTabDeals')?.addEventListener('click', () => switchAlertsTab('deals'));
  // Recompute the badge count every time the panel re-opens, and once at boot
  // so users see notifications immediately if a card has moved while they
  // were away.
  refreshAlerts();
}

let _alertsTab = 'active';
function switchAlertsTab(tab) {
  _alertsTab = tab;
  $('alertsTabActive')?.classList.toggle('is-active', tab === 'active');
  $('alertsTabWatching')?.classList.toggle('is-active', tab === 'watching');
  $('alertsTabDeals')?.classList.toggle('is-active', tab === 'deals');
  if (tab === 'deals') { renderDealHistory(); return; }
  renderAlertsList();
}

function refreshAlerts() {
  renderAlertsList();
  updateAlertsBadge();
}

function updateAlertsBadge() {
  const alerts = computeActiveAlerts().filter(a => a.triggered && a.dismissedFor !== a.signal);
  const badge = $('alertsCount');
  if (!badge) return;
  if (alerts.length === 0) {
    badge.style.display = 'none';
  } else {
    badge.style.display = 'flex';
    badge.textContent = String(alerts.length);
  }
  const total = $('alertsTotal');
  if (total) total.textContent = `${alerts.length} active`;
}

function renderAlertsList() {
  const list = $('alertsList');
  if (!list) return;
  if (watchlist.length === 0) {
    list.innerHTML = `<div class="portfolio-empty">Nothing on your watchlist yet. Open a card and tap "Watch this card" to start tracking it. You'll see a notification here the moment the model flips it to BUY or STRONG BUY.</div>`;
    return;
  }
  const alerts = computeActiveAlerts();
  let shown = alerts;
  if (_alertsTab === 'active') shown = alerts.filter(a => a.triggered && a.dismissedFor !== a.signal);
  if (shown.length === 0) {
    list.innerHTML = _alertsTab === 'active'
      ? `<div class="portfolio-empty">No new alerts. You're watching ${watchlist.length} card${watchlist.length === 1 ? '' : 's'} — switch to "All watched" to review them.</div>`
      : `<div class="portfolio-empty">Watchlist is empty.</div>`;
    return;
  }
  // Sort active alerts by signal score desc (STRONG BUY first), then price drop
  shown.sort((a, b) => (b.score - a.score) || (b.priceDropPct - a.priceDropPct));

  list.innerHTML = shown.map(a => {
    const sigClass = a.signal === 'STRONG BUY' ? 'sig-strong' : a.signal === 'BUY' ? 'sig-buy' : a.signal === 'SELL' ? 'sig-sell' : 'sig-hold';
    const dropStr = a.priceDropPct > 0 ? `<span class="alert-drop">↓${a.priceDropPct.toFixed(1)}% from added</span>` : '';
    const trigBits = [];
    if (a.transitioned) trigBits.push(`Signal flipped <strong>${a.addedSignal}</strong> → <strong>${a.signal}</strong>`);
    if (a.bigDrop) trigBits.push(`Price down <strong>${a.priceDropPct.toFixed(1)}%</strong>`);
    if (!trigBits.length) trigBits.push(`Signal: <strong>${a.signal}</strong>`);
    const reasons = a.reasons.length ? `<div class="alert-reasons">${a.reasons.map(r => `<span>${esc(r)}</span>`).join(' · ')}</div>` : '';
    return `
      <div class="alert-item" data-id="${a.id}">
        ${a.img ? `<img class="alert-item-img" src="${_hiresUrl(a.img)}" alt="" loading="lazy" decoding="async" onerror="_onImgError(this)">` : '<div class="alert-item-img"></div>'}
        <div class="alert-item-info">
          <div class="alert-item-name">${esc(a.name)} ${a.lang === 'JP' ? '<span class="lang-pill">🇯🇵 JP</span>' : ''}</div>
          <div class="alert-item-meta"><span>${esc(a.set)}</span> ${dropStr}</div>
          <div class="alert-trigger">${trigBits.join(' · ')}</div>
          ${reasons}
        </div>
        <div class="alert-item-actions">
          <div class="alert-prices">
            <div class="alert-current">£${a.currentPriceGBP.toFixed(2)}</div>
            <div class="alert-added">added @ £${usdToGbp(a.addedPriceUSD).toFixed(2)}</div>
          </div>
          <div class="alert-signal-badge ${sigClass}">${a.signal}</div>
          <div class="alert-btns">
            <button class="alert-mini-btn alert-open" data-id="${a.id}" title="Open card">Open</button>
            <button class="alert-mini-btn alert-dismiss" data-id="${a.id}" data-signal="${a.signal}" title="Dismiss this alert until the signal changes again">Dismiss</button>
          </div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.alert-open').forEach(b => b.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.id;
    selectCard(id);
    $('alertsPanel').style.display = 'none';
  }));
  list.querySelectorAll('.alert-dismiss').forEach(b => b.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.id;
    const signal = e.currentTarget.dataset.signal;
    dismissedAlerts[id] = signal;
    saveDismissed();
    refreshAlerts();
  }));
}

// =============================================================
// Top 50 Ranker · cards-by-grade best 5yr ROI
// =============================================================
//
// Scans the full card DB, considers grades 6-10 for each card with a known
// PSA 10 price, projects each combo 5 years forward, filters down to cards
// where the model considers them fair or undervalued (score >= 0), and
// returns the top 50 by 5yr ROI.

function setupTop50() {
  $('top50Refresh')?.addEventListener('click', runTop50);
  $('top50Sort')?.addEventListener('change', () => { if (_lastTop50) renderTop50(_lastTop50); });
  $('top50Lang')?.addEventListener('change', () => { if (_lastTop50) renderTop50(_lastTop50); });
}

let _lastTop50 = null;

function runTop50() {
  if (!cardData || !cardData.cards) return;
  const btn = $('top50Refresh');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  $('top50Status').textContent = `Scanning ${cardData.cards.length.toLocaleString()} cards across PSA grades…`;

  // Defer to next frame so the status text actually paints.
  requestAnimationFrame(() => {
    const candidates = [];
    const grades = [6, 7, 8, 9, 10];
    for (const c of cardData.cards) {
      const psa10 = c.p10 || 0;
      if (psa10 <= 0) continue; // need a PSA 10 anchor
      // Pull cost
      let pullCost = 7.65;
      if (setsData && setsData[c.sc]) {
        const set = setsData[c.sc];
        const rarity = set.rarities?.[c.rc];
        if (rarity && rarity.pullRate > 0) {
          const packsPerHit = Math.round(1 / rarity.pullRate);
          pullCost = (packsPerHit * rarity.count) / 100;
        }
      }
      const des = autoFillDesirability(c, pullCost).total;
      const sig = computeSignal(c, pullCost, des);
      // Filter out clear SELL / overpriced cards
      if (!sig || sig.score < 0) continue;

      let best = null;
      for (const g of grades) {
        const todayUSD = estimateGradePrice(c, g, psa10);
        if (todayUSD < 5) continue; // skip noise / micro-entries
        const yr5USD = projectGradePrice(c, g, todayUSD, 5);
        const roi5 = ((yr5USD - todayUSD) / todayUSD) * 100;
        const upsideUSD = yr5USD - todayUSD;
        if (!best || roi5 > best.roi5) best = { g, todayUSD, yr5USD, roi5, upsideUSD };
      }
      if (!best || best.roi5 < 20) continue; // require non-trivial upside

      candidates.push({
        card: c,
        bestGrade: best.g,
        todayUSD: best.todayUSD,
        yr5USD: best.yr5USD,
        roi5: best.roi5,
        upsideUSD: best.upsideUSD,
        signal: sig.signal,
        score: sig.score,
      });
    }
    _lastTop50 = candidates;
    renderTop50(candidates);
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg> Run scan`; }
  });
}

function renderTop50(candidates) {
  const sortBy = $('top50Sort')?.value || 'roi';
  const lang = $('top50Lang')?.value || 'all';
  let rows = candidates.slice();
  if (lang !== 'all') rows = rows.filter(r => (r.card.lang || 'EN') === lang);
  if (sortBy === 'roi') rows.sort((a, b) => b.roi5 - a.roi5);
  else if (sortBy === 'upside') rows.sort((a, b) => b.upsideUSD - a.upsideUSD);
  else if (sortBy === 'signal') rows.sort((a, b) => (b.score - a.score) || (b.roi5 - a.roi5));
  else if (sortBy === 'value') rows.sort((a, b) => a.todayUSD - b.todayUSD);
  rows = rows.slice(0, 50);

  $('top50Status').textContent = candidates.length === 0
    ? 'No candidates found. Try after live prices load — the ranker needs PSA 10 anchors.'
    : `Scanned ${candidates.length.toLocaleString()} eligible cards. Showing top ${rows.length} sorted by ${sortBy === 'roi' ? '5yr ROI' : sortBy === 'upside' ? 'absolute upside' : sortBy === 'signal' ? 'signal score' : 'lowest entry price'}.`;
  const wrap = $('top50Results');
  if (!wrap) return;
  if (rows.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  $('top50TableBody').innerHTML = rows.map((r, i) => {
    const sigClass = r.signal === 'STRONG BUY' ? 'sig-strong' : r.signal === 'BUY' ? 'sig-buy' : 'sig-hold';
    return `<tr data-id="${r.card.i}" class="top50-row">
      <td class="t50-rank">${i + 1}</td>
      <td class="t50-name">${esc(r.card.n)} ${(r.card.lang || 'EN') === 'JP' ? '<span class="lang-pill">🇯🇵</span>' : ''}</td>
      <td class="t50-set">${esc(r.card.s || '—')}</td>
      <td class="t50-grade">PSA ${r.bestGrade}</td>
      <td class="t50-money">${fmtGBP(r.todayUSD)}</td>
      <td class="t50-money t50-yr5">${fmtGBP(r.yr5USD)}</td>
      <td class="t50-roi">+${r.roi5.toFixed(0)}%</td>
      <td><span class="alert-signal-badge ${sigClass}">${r.signal}</span></td>
      <td><button class="t50-open" data-id="${r.card.i}">Open</button></td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#top50TableBody .t50-open').forEach(b => b.addEventListener('click', (e) => {
    selectCard(e.currentTarget.dataset.id);
    document.getElementById('selectedCardSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// =============================================================
// Marketplace Scan · eBay UK + eBay US + Cardmarket deep-links
// =============================================================
//
// For every PSA grade (plus Raw) we know our model's fair value. We build
// pre-filtered search URLs to all three marketplaces so the user clicks
// through and only sees listings priced AT OR BELOW our fair value.
//
//   * eBay UK / US : LH_BIN=1 (Buy It Now), _udhi=<maxGBP|maxUSD>, _sop=15 (newly listed)
//   * Cardmarket   : maxPrice (EUR) parameter on /Search
//
// A "deal score" is computed per grade based on how liquid that grade typically
// is and how big the upside is — it's a hint for where to look first.
//
// In Stage B we'll add LIVE listings via the Cloudflare Worker (see
// marketplace-worker/). For now this is a fast, no-backend deep-link UI.

// Approximate FX rates (live FX is fetched elsewhere via fxRate for USD).
// Cardmarket prices in EUR; eBay UK in GBP; eBay US in USD.
function gbpFromUSD(usd) { return usd * (typeof fxRate === 'number' ? fxRate : 0.79); }
function eurFromUSD(usd) { return usd * 0.92; }

function buildEbayUrl(domain, query, maxPriceLocal) {
  const base = domain === 'uk' ? 'https://www.ebay.co.uk/sch/i.html' : 'https://www.ebay.com/sch/i.html';
  const params = new URLSearchParams({
    _nkw: query,
    LH_BIN: '1',         // Buy It Now only (skip auction-only noise)
    _sop: '15',          // Sort: newly listed (best chance of mispriced)
    _udhi: maxPriceLocal.toFixed(2), // max price filter — anything shown is below model
  });
  return `${base}?${params.toString()}`;
}

function buildCardmarketUrl(query, maxPriceEUR) {
  const params = new URLSearchParams({
    searchString: query,
    'idCategory': '6',        // Singles
    'idGame': '6',            // Pokémon
    'maxPrice': Math.round(maxPriceEUR).toString(),
  });
  return `https://www.cardmarket.com/en/Pokemon/Products/Search?${params.toString()}`;
}

// =============================================================
// pokemontcg.io direct-link resolver
// =============================================================
// pokemontcg.io is free, has open CORS, and returns per-card Cardmarket
// and TCGplayer URLs that redirect to the exact product page (no Worker
// needed). We cache results per card id so reselecting the same card is
// instant. Japanese cards (id prefix "jp-") aren't in pokemontcg.io, so we
// fall back to the search URLs.
const pokemonTcgIoCache = new Map(); // cardId -> {cardmarketUrl, tcgplayerUrl, prices} | null
const pokemonTcgIoInflight = new Map(); // cardId -> Promise

async function fetchPokemonTcgIoLinks(cardId) {
  if (!cardId || cardId.startsWith('jp-') || cardId.startsWith('mc-')) return null;
  if (pokemonTcgIoCache.has(cardId)) return pokemonTcgIoCache.get(cardId);
  if (pokemonTcgIoInflight.has(cardId)) return pokemonTcgIoInflight.get(cardId);
  const url = `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(cardId)}`;
  const p = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) { pokemonTcgIoCache.set(cardId, null); return null; }
      const json = await res.json();
      const d = json && json.data ? json.data : {};
      const result = {
        // The /cardmarket/<id> and /tcgplayer/<id> URLs are 302 redirects
        // that bounce to the actual product page on each retailer. Browsers
        // follow these transparently when the user clicks the link.
        cardmarketUrl: (d.cardmarket && d.cardmarket.url) || null,
        tcgplayerUrl: (d.tcgplayer && d.tcgplayer.url) || null,
        cmPrices: (d.cardmarket && d.cardmarket.prices) || null,
        imageUrl: (d.images && (d.images.large || d.images.small)) || null,
      };
      pokemonTcgIoCache.set(cardId, result);
      return result;
    } catch (e) {
      pokemonTcgIoCache.set(cardId, null);
      return null;
    } finally {
      pokemonTcgIoInflight.delete(cardId);
    }
  })();
  pokemonTcgIoInflight.set(cardId, p);
  return p;
}

// Build a TCGplayer search URL as a fallback for cards pokemontcg.io doesn't
// resolve (Japanese, McDonald's promos, very new sets).
function buildTcgplayerUrl(query, maxPriceUSD) {
  const params = new URLSearchParams({
    q: query,
    productLineName: 'pokemon',
    view: 'grid',
  });
  // TCGplayer's max-price filter uses MinPrice/MaxPrice query params.
  if (maxPriceUSD && isFinite(maxPriceUSD)) {
    params.set('MaxPrice', Math.round(maxPriceUSD).toString());
  }
  return `https://www.tcgplayer.com/search/pokemon/product?${params.toString()}`;
}

// Build a search query that's tight enough to find the right card but
// permissive enough to actually return results. Card name + set, no grade
// term (we handle grade with the eBay search filter "PSA 10" appended).
function buildSearchQuery(card, gradeLabel) {
  const name = (card.n || '').replace(/[^a-zA-Z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim();
  const langTerm = (card.lang === 'JP') ? 'japanese' : '';
  const gradeTerm = gradeLabel === 'Raw' ? '' : gradeLabel;
  // Card number (e.g. "223 197") beats set name as a search term — eBay titles almost
  // always include "223/197" but rarely say "Obsidian Flames", so the set name kills recall.
  const numTerm = card.cn && card.ct ? `${card.cn} ${card.ct}` : (card.cn ? String(card.cn) : '');
  return [name, numTerm, langTerm, gradeTerm].filter(Boolean).join(' ');
}

// Deal score 0-100: how attractive scanning this grade is. Combines three
// factors so grades meaningfully differentiate (raw vs psa10 should NOT tie):
//   * Liquidity (35%) — thicker markets mean more listings to find deals in
//   * Capped ROI (30%) — anything past 200% 5yr ROI tops out
//   * Absolute £ upside (35%) — a £1000 upside beats a £50 upside even at same %
function gradeDealScore(grade, todayGBP, fiveYearGBP) {
  const upsideGBP = Math.max(0, fiveYearGBP - todayGBP);
  const roi = todayGBP > 0 ? upsideGBP / todayGBP : 0;
  const liquidity = grade === 10 ? 1.00
                  : grade === 9  ? 0.90
                  : grade === 8  ? 0.70
                  : grade === 7  ? 0.55
                  : grade === 'Raw' ? 0.80
                  : 0.45;
  const roiFactor = Math.min(1, roi / 2.0);          // 200% ROI = max
  const upsideFactor = Math.min(1, upsideGBP / 800); // £800 upside = max
  return Math.round(liquidity * 35 + roiFactor * 30 + upsideFactor * 35);
}

function dealClass(score) {
  if (score >= 70) return 'mkt-strong';
  if (score >= 45) return 'mkt-fair';
  return 'mkt-weak';
}

// Render (or remove) the quick-switch chip inside the Marketplace Scan header.
// When `card` has a linked JP/EN counterpart (via findCounterparts), a single
// pill is shown that switches the whole page to that counterpart on click.
function renderMarketplaceCpChip(card, section) {
  if (!section) return;
  // Always wipe the previous chip so a card without a counterpart leaves no trace.
  const prev = section.querySelector('#mktCpSwitchChip');
  if (prev) prev.remove();
  if (typeof findCounterparts !== 'function') return;
  const cp = findCounterparts(card);
  if (!cp || !cp.primary) return;
  const other = cp.primary;
  const lang = cp.counterpartLang === 'JP' ? 'Japanese' : 'English';
  const langBadge = cp.counterpartLang === 'JP' ? 'JP' : 'EN';
  const setName = other.s || '';
  const num = other.cn || '';
  const tail = [setName, num ? '#' + num : ''].filter(Boolean).join(' \u00b7 ');
  const chip = document.createElement('button');
  chip.id = 'mktCpSwitchChip';
  chip.type = 'button';
  chip.className = 'mkt-cp-switch-chip';
  chip.title = `Switch this Marketplace Scan to the ${lang} counterpart`;
  chip.innerHTML = `
    <span class="mkt-cp-icon" aria-hidden="true">\u21c4</span>
    <span class="mkt-cp-lead">Scan the ${langBadge} counterpart</span>
    <span class="mkt-cp-target">
      <span class="mkt-cp-name">${esc(other.n || 'counterpart')}</span>
      ${tail ? `<span class="mkt-cp-sub">${esc(tail)}</span>` : ''}
    </span>
    <span class="mkt-cp-go" aria-hidden="true">\u2192</span>
  `;
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof selectCard === 'function') selectCard(other.i);
  });
  const header = section.querySelector('.mkt-header');
  if (header && header.parentNode) {
    header.parentNode.insertBefore(chip, header.nextSibling);
  } else {
    section.insertBefore(chip, section.firstChild);
  }
}

function renderMarketplaceScan(card, pullCost, desirability) {
  const section = $('marketplaceSection');
  if (!section || !card) return;
  // Use getPsa10Anchor() so estimated anchors (raw × rarity multiplier) also unlock the scan.
  const anchor = getPsa10Anchor(card);
  const psa10Price = anchor.usd;
  if (!psa10Price || psa10Price <= 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  // Show/hide estimated-anchor notice
  let estNote = section.querySelector('.mkt-estimated-note');
  if (anchor.source === 'estimated') {
    if (!estNote) {
      estNote = document.createElement('div');
      estNote.className = 'mkt-estimated-note';
      section.insertBefore(estNote, section.firstChild);
    }
    estNote.textContent = `PSA 10 anchor estimated from raw × ${anchor.multiplier}× (no tracked price) — prices are approximate.`;
  } else if (estNote) {
    estNote.remove();
  }

  // Quick-switch chip: if this card has a linked JP/EN counterpart, surface a
  // one-click chip at the top of the section that swaps the whole page to that
  // counterpart card. This lets the user re-run the Marketplace Scan against
  // the other-language version of the same card without leaving the section.
  renderMarketplaceCpChip(card, section);

  const rawPriceUSD = getCurrentPrice(card);
  const grades = [
    { label: 'Raw',    g: 'raw', todayUSD: rawPriceUSD || (psa10Price * 0.10) },
    { label: 'PSA 7',  g: 7,     todayUSD: estimateGradePrice(card, 7, psa10Price) },
    { label: 'PSA 8',  g: 8,     todayUSD: estimateGradePrice(card, 8, psa10Price) },
    { label: 'PSA 9',  g: 9,     todayUSD: estimateGradePrice(card, 9, psa10Price) },
    { label: 'PSA 10', g: 10,    todayUSD: estimateGradePrice(card, 10, psa10Price) },
  ];

  const rows = grades.map(row => {
    const todayUSD = row.todayUSD;
    const todayGBP = gbpFromUSD(todayUSD);
    const todayEUR = eurFromUSD(todayUSD);
    // 5-year target for the grade — Raw uses PSA-as-9 growth as a proxy.
    const projGrade = row.g === 'raw' ? 9 : row.g;
    const yr5USD = projectGradePrice(card, projGrade, todayUSD, 5);
    const yr5GBP = gbpFromUSD(yr5USD);
    const score = gradeDealScore(row.g === 'raw' ? 'Raw' : row.g, todayGBP, yr5GBP);
    const query = buildSearchQuery(card, row.label);
    const ebayUk = buildEbayUrl('uk', query, todayGBP);
    const ebayUs = buildEbayUrl('us', query, todayUSD);
    const cardmarket = buildCardmarketUrl(query, todayEUR);
    const tcgplayer = buildTcgplayerUrl(query, todayUSD);
    return { ...row, todayGBP, todayEUR, yr5USD, yr5GBP, score, ebayUk, ebayUs, cardmarket, tcgplayer };
  });

  // Sort by grade descending: PSA 10 → PSA 9 → PSA 8 → PSA 7 → Raw
  rows.sort((a, b) => {
    const ag = a.g === 'raw' ? -1 : a.g;
    const bg = b.g === 'raw' ? -1 : b.g;
    return bg - ag;
  });

  // Render one stacked panel per grade. Each panel groups the fair-value
  // metrics on the left with the four marketplace search buttons on the right,
  // so users can scan a grade and jump to the right marketplace in one motion.
  const grid = $('marketplaceGrades');
  if (grid) {
    grid.innerHTML = rows.map((r, idx) => `
      <div class="mkt-grade-card" data-mkt-row="${idx}" data-grade="${r.label}">
        <div class="mkt-grade-summary">
          <div class="mkt-grade-head">
            <span class="mkt-grade-label">${r.label}</span>
            <span class="mkt-pill ${dealClass(r.score)}" title="Deal score \u2014 higher means more attractive hunting ground">${r.score}/100</span>
          </div>
          <div class="mkt-grade-metrics">
            <div class="mkt-grade-metric">
              <span class="mkt-grade-metric-label">Fair value</span>
              <span class="mkt-money">${fmtGBP(r.todayUSD)}</span>
            </div>
            <div class="mkt-grade-metric">
              <span class="mkt-grade-metric-label">5yr target</span>
              <span class="mkt-money mkt-yr5">${fmtGBP(r.yr5USD)}</span>
            </div>
          </div>
        </div>
        <div class="mkt-grade-links">
          <a class="mkt-link mkt-uk"  href="${esc(r.ebayUk)}"     target="_blank" rel="noopener"><span class="mkt-link-src src-uk">eBay UK</span><span class="mkt-link-go">Search \u2192</span></a>
          <a class="mkt-link mkt-us"  href="${esc(r.ebayUs)}"     target="_blank" rel="noopener"><span class="mkt-link-src src-us">eBay US</span><span class="mkt-link-go">Search \u2192</span></a>
          <a class="mkt-link mkt-cm  mkt-cm-cell"  href="${esc(r.cardmarket)}" target="_blank" rel="noopener"><span class="mkt-link-src src-cm">Cardmarket</span><span class="mkt-link-go">Search \u2192</span></a>
          <a class="mkt-link mkt-tcg mkt-tcg-cell" href="${esc(r.tcgplayer)}"  target="_blank" rel="noopener"><span class="mkt-link-src src-tcg">TCGplayer</span><span class="mkt-link-go">Search \u2192</span></a>
        </div>
      </div>
    `).join('');
  }

  const topRow = rows[0];
  $('marketplaceFootnote').innerHTML = `
    Best place to hunt right now: <strong>${topRow.label}</strong> at ${fmtGBP(topRow.todayUSD)} (deal score ${topRow.score}/100).
    Each search link is pre-filtered to <strong>max price = model fair value</strong>, so any listing you see is at or below the model.
    Cardmarket prices in EUR; UK eBay in GBP. Direct Cardmarket + TCGplayer product links resolve in the background via pokemontcg.io.
  `;

  // Fire-and-forget: resolve direct product page URLs from pokemontcg.io and
  // swap the Cardmarket + TCGplayer search links for product-page links. Also
  // inject Cardmarket trend / low prices as a small chip under the row.
  upgradeMarketplaceLinks(card, rows);

  // If a live-scan Worker URL is configured, also fan out a fetch for live
  // listings. Otherwise hide the live-wrap so only deep-links show.
  if (typeof getMktWorkerUrl === 'function' && getMktWorkerUrl()) {
    fetchLiveDeals(card);
  } else if ($('mktLiveWrap')) {
    $('mktLiveWrap').style.display = 'none';
  }
}

// =============================================================
// Upgrade Cardmarket + TCGplayer cells with direct product-page URLs
// =============================================================
// Called after renderMarketplaceScan. Looks up the card on pokemontcg.io
// and swaps the generic search links for the per-card product page URLs
// (e.g. /Pokemon/Products/Singles/Obsidian-Flames/Charizard-ex-V1-OBF125).
// Also adds a small "Cardmarket: low €X.XX · trend €Y.YY" line under the
// section header when prices are available. Safe to call repeatedly — the
// result is cached per card id.
async function upgradeMarketplaceLinks(card, rows) {
  if (!card || !card.i) return;
  const cardIdForFetch = card.i;
  const data = await fetchPokemonTcgIoLinks(cardIdForFetch);
  // Guard: card may have changed while we were fetching.
  if (!selectedCard || selectedCard.i !== cardIdForFetch) return;
  if (!data) return;

  // Both selectors live inside the grade-cards grid now. Selectors retain the
  // same .mkt-cm-cell / .mkt-tcg-cell hooks so this stays a CSS-only refactor.
  const root = $('marketplaceGrades');
  if (!root) return;

  if (data.cardmarketUrl) {
    root.querySelectorAll('.mkt-cm-cell').forEach(a => {
      a.setAttribute('href', data.cardmarketUrl);
      a.classList.add('mkt-direct');
      a.title = 'Direct product page on Cardmarket';
      const go = a.querySelector('.mkt-link-go');
      if (go) go.textContent = 'Product page \u2192';
    });
  }
  if (data.tcgplayerUrl) {
    root.querySelectorAll('.mkt-tcg-cell').forEach(a => {
      a.setAttribute('href', data.tcgplayerUrl);
      a.classList.add('mkt-direct');
      a.title = 'Direct product page on TCGplayer';
      const go = a.querySelector('.mkt-link-go');
      if (go) go.textContent = 'Product page \u2192';
    });
  }

  // Inject a small Cardmarket-prices chip into the section header so the
  // user can sanity-check the model's USD-derived numbers against Cardmarket's
  // own EUR low / trend / 30-day average for this exact card.
  const cm = data.cmPrices || {};
  const chipParts = [];
  if (cm.lowPrice)   chipParts.push(`Low \u20ac${cm.lowPrice.toFixed(2)}`);
  if (cm.trendPrice) chipParts.push(`Trend \u20ac${cm.trendPrice.toFixed(2)}`);
  if (cm.avg30)      chipParts.push(`30d avg \u20ac${cm.avg30.toFixed(2)}`);
  if (chipParts.length) {
    let chip = document.getElementById('mktCmChip');
    if (!chip) {
      const header = document.querySelector('#marketplaceSection .mkt-header > div');
      if (header) {
        chip = document.createElement('div');
        chip.id = 'mktCmChip';
        chip.className = 'mkt-cm-chip';
        header.appendChild(chip);
      }
    }
    if (chip) chip.innerHTML = `<span class="mkt-cm-chip-label">Cardmarket (raw, EUR):</span> ${chipParts.join(' \u00b7 ')}`;
  } else {
    const chip = document.getElementById('mktCmChip');
    if (chip) chip.remove();
  }
}

// =============================================================
// Marketplace Live Scan · Cloudflare Worker integration
// =============================================================
//
// When a worker URL is saved in localStorage (`pkm-mkt-worker-url`), every
// card selection also fans out a /search request to fetch live listings
// from eBay UK, eBay US, and Cardmarket — merged + ranked by spread vs
// the model's fair value for the currently-selected grade (default PSA 10
// because that's the anchor; user could change later).

const MKT_WORKER_KEY = 'pkm-mkt-worker-url';
// Default worker URL — deployed against Simon's eBay developer keyset. Users
// who fork the site can override via the Connect-live-scan button.
const MKT_WORKER_DEFAULT = 'https://pokemon-marketplace.simontariq.workers.dev';

function getMktWorkerUrl() { return localStorage.getItem(MKT_WORKER_KEY) || MKT_WORKER_DEFAULT; }
function setMktWorkerUrl(url) {
  if (!url) { localStorage.removeItem(MKT_WORKER_KEY); }
  else { localStorage.setItem(MKT_WORKER_KEY, url.replace(/\/+$/, '')); }
  updateMktSettingsLabel();
}
function updateMktSettingsLabel() {
  const lbl = $('mktSettingsLabel');
  if (!lbl) return;
  const url = getMktWorkerUrl();
  const isDefault = url === MKT_WORKER_DEFAULT;
  lbl.textContent = url ? (isDefault ? 'Live scan: ON' : 'Live scan: ON (custom)') : 'Connect live scan';
  $('mktSettingsBtn')?.classList.toggle('is-active', !!url);
}

// ---- Reassignment modal ----
let _mktReassignPayload = null;     // { url, title, ..., fromCardId, fromGrade }
let _mktReassignPickedCard = null;  // chosen target card
let _mktReassignPickedGrade = null; // chosen target grade key ('raw' | '7' | ...)
let _mktBulkPayloads = [];          // when bulk-moving: all selected payloads

function openReassignModal(payload) {
  if (!payload) return;
  _mktReassignPayload = payload;
  _mktReassignPickedCard = null;
  _mktReassignPickedGrade = payload.fromGrade || 'raw';
  const overlay = $('mraOverlay');
  const modal = $('mraModal');
  if (!overlay || !modal) return;
  overlay.style.display = '';
  overlay.setAttribute('aria-hidden', 'false');
  modal.style.display = 'flex';
  // Listing preview
  const prev = $('mraPreview');
  if (prev) {
    const img = payload.image
      ? `<img src="${esc(payload.image)}" alt="" onerror="_onImgError(this)">`
      : '<div class="mra-prev-img-empty"></div>';
    prev.innerHTML = `
      ${img}
      <div class="mra-prev-body">
        <div class="mra-prev-title">${esc(payload.title || '')}</div>
        <div class="mra-prev-meta">${esc(payload.source || '')}${payload.condition ? ' · ' + esc(payload.condition) : ''} · £${(payload.priceGBP || 0).toFixed(2)}</div>
      </div>`;
  }
  // Reset input + results
  const input = $('mraInput');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
  const results = $('mraResults');
  if (results) {
    results.innerHTML = '';
    // If the origin card has a linked JP/EN counterpart, surface it as a
    // one-tap suggestion at the very top — most JP-leaks-into-EN moves go
    // exactly there, so this saves a search step.
    renderReassignSuggestions(payload.fromCardId);
  }
  // Pre-select current grade in the grade picker
  const gradeKey = payload.fromGrade || 'raw';
  document.querySelectorAll('#mraGrades .mra-grade').forEach(b => {
    b.classList.toggle('is-active', b.dataset.grade === gradeKey);
  });
  // Reset target indicator + Save button
  const tgt = $('mraTarget');
  if (tgt) tgt.innerHTML = '<span class="mra-target-empty">No card picked yet — search above.</span>';
  const save = $('mraSaveBtn');
  if (save) save.disabled = true;
}

function closeReassignModal() {
  const overlay = $('mraOverlay');
  const modal = $('mraModal');
  if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
  if (modal) modal.style.display = 'none';
  _mktReassignPayload = null;
  _mktReassignPickedCard = null;
  _mktReassignPickedGrade = null;
  _mktBulkPayloads = [];
  _hideMraHover();
}

// Floating full-res card image preview on hover in the reassign picker
let _mraHoverEl = null;
function _getMraHoverEl() {
  if (!_mraHoverEl) {
    _mraHoverEl = document.createElement('div');
    _mraHoverEl.id = 'mraImgHover';
    _mraHoverEl.className = 'mra-img-hover';
    _mraHoverEl.innerHTML = '<img class="mra-img-hover-img" alt="">';
    _mraHoverEl.style.display = 'none';
    document.body.appendChild(_mraHoverEl);
  }
  return _mraHoverEl;
}
function _showMraHover(imgSrc, x, y) {
  if (!imgSrc) return;
  const el = _getMraHoverEl();
  const img = el.querySelector('img');
  if (img.src !== imgSrc) img.src = imgSrc;
  // Position: prefer right of cursor, flip left if too close to viewport edge
  const W = window.innerWidth, H = window.innerHeight;
  const PW = 220, PH = 308, GAP = 18;
  let left = x + GAP, top = y - PH / 2;
  if (left + PW > W - 8) left = x - PW - GAP;
  if (top < 8) top = 8;
  if (top + PH > H - 8) top = H - PH - 8;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.display = 'block';
}
function _hideMraHover() {
  const el = _mraHoverEl;
  if (el) el.style.display = 'none';
}
function _attachMraHoverHandlers(container) {
  container.querySelectorAll('.mra-result').forEach(btn => {
    const id = btn.dataset.cardId;
    if (!id || !searchIndex) return;
    const card = searchIndex.find(c => String(c.i) === String(id));
    const imgSrc = card && typeof getCardImg === 'function' ? getCardImg(card) : '';
    if (!imgSrc) return;
    btn.addEventListener('mouseenter', e => _showMraHover(imgSrc, e.clientX, e.clientY));
    btn.addEventListener('mousemove', e => _showMraHover(imgSrc, e.clientX, e.clientY));
    btn.addEventListener('mouseleave', _hideMraHover);
  });
}

// Render the suggested-counterpart row inside #mraResults. Called by
// openReassignModal and cleared whenever the user starts typing.
function renderReassignSuggestions(fromCardId) {
  const results = $('mraResults');
  if (!results || !fromCardId || !searchIndex) return;
  // Resolve the origin card (use cardData first — has all fields — fall back
  // to searchIndex).
  let originCard = null;
  if (typeof cardData !== 'undefined' && cardData && cardData.cards) {
    originCard = cardData.cards.find(c => String(c.i) === String(fromCardId)) || null;
  }
  if (!originCard) originCard = searchIndex.find(c => String(c.i) === String(fromCardId)) || null;
  if (!originCard || typeof findCounterparts !== 'function') return;
  const cp = findCounterparts(originCard);
  if (!cp || !cp.counterparts || !cp.counterparts.length) return;
  // Cap to 3 to keep the suggested band tight — if the user wants more they
  // can type a search.
  const picks = cp.counterparts.slice(0, 3);
  const otherLang = originCard.lang === 'JP' ? 'EN' : 'JP';
  const labelText = picks.length === 1
    ? `Suggested — the linked ${otherLang} counterpart`
    : `Suggested — linked ${otherLang} counterparts`;
  const cardsHtml = picks.map(c => {
    const numLabel = c.cn && c.ct ? `#${esc(c.cn)}/${esc(c.ct)}` : c.cn ? `#${esc(c.cn)}` : '';
    const langBadge = c.lang === 'JP' ? '<span class="mra-lang jp">JP</span>'
                   : c.lang === 'CN' ? '<span class="mra-lang cn">CN</span>'
                   : '<span class="mra-lang en">EN</span>';
    const imgSrc = typeof getCardImg === 'function' ? getCardImg(c) : '';
    return `
      <button type="button" class="mra-result mra-suggested" data-card-id="${esc(c.i)}">
        ${imgSrc ? `<img class="mra-result-img" src="${imgSrc}" alt="" loading="lazy" onerror="_onImgError(this)">` : ''}
        <div class="mra-result-main">
          <div class="mra-result-name">${esc(c.n)} ${langBadge}<span class="mra-suggest-pill">★ Suggested</span></div>
          <div class="mra-result-sub">${esc(c.s || '')} · ${numLabel}${c.r ? ' · ' + esc(c.r) : ''}</div>
        </div>
      </button>`;
  }).join('');
  results.innerHTML = `
    <div class="mra-suggest-band">
      <div class="mra-suggest-label">${labelText}</div>
      ${cardsHtml}
    </div>
  `;
  // Wire picks for the suggested band (same handler as the search results).
  results.querySelectorAll('.mra-suggested').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cardId;
      const card = searchIndex.find(c => String(c.i) === String(id));
      if (!card) return;
      _mktReassignPickedCard = card;
      // Clear other picked highlights
      results.querySelectorAll('.mra-result').forEach(b => b.classList.toggle('is-picked', b === btn));
      const tgt = $('mraTarget');
      const numLabel = card.cn && card.ct ? `#${esc(card.cn)}/${esc(card.ct)}` : card.cn ? `#${esc(card.cn)}` : '';
      const langBadge = card.lang === 'JP' ? '<span class="mra-lang jp">JP</span>'
                     : card.lang === 'CN' ? '<span class="mra-lang cn">CN</span>'
                     : '<span class="mra-lang en">EN</span>';
      if (tgt) tgt.innerHTML = `Will move to: <strong>${esc(card.n)}</strong> ${langBadge} <span class="mra-target-sub">${esc(card.s || '')} · ${numLabel}</span>`;
      const save = $('mraSaveBtn');
      if (save) save.disabled = false;
    });
  });
  _attachMraHoverHandlers(results);
}

function runReassignSearch() {
  const input = $('mraInput');
  const results = $('mraResults');
  if (!input || !results || !searchIndex) return;
  const q = input.value.trim().toLowerCase();
  if (q.length < 2) { results.innerHTML = ''; return; }
  let matches = searchIndex.filter(c => c._search.includes(q));
  const numSlashMatch = q.match(/^#?(\d+)\/(\d+)$/);
  if (numSlashMatch) {
    const [, num, total] = numSlashMatch;
    matches.sort((a, b) => {
      const aExact = (String(a.cn) === num && String(a.ct) === total) ? 2 : String(a.cn) === num ? 1 : 0;
      const bExact = (String(b.cn) === num && String(b.ct) === total) ? 2 : String(b.cn) === num ? 1 : 0;
      return bExact - aExact;
    });
  } else if (/^\d+$/.test(q) || /^#\d+/.test(q)) {
    const num = q.replace('#', '');
    matches.sort((a, b) => {
      const aExact = String(a.cn) === num ? 1 : 0;
      const bExact = String(b.cn) === num ? 1 : 0;
      return bExact - aExact;
    });
  }
  matches.sort((a, b) => {
    const aName = a.n.toLowerCase().startsWith(q) ? 1 : 0;
    const bName = b.n.toLowerCase().startsWith(q) ? 1 : 0;
    if (aName !== bName) return bName - aName;
    return (b.p || 0) - (a.p || 0);
  });
  matches = matches.slice(0, 15);
  if (!matches.length) {
    results.innerHTML = '<div class="mra-empty">No cards match — try another name or number.</div>';
    return;
  }
  results.innerHTML = matches.map(c => {
    const numLabel = c.cn && c.ct ? `#${esc(c.cn)}/${esc(c.ct)}` : c.cn ? `#${esc(c.cn)}` : '';
    const langBadge = c.lang === 'JP' ? '<span class="mra-lang jp">JP</span>'
                   : c.lang === 'CN' ? '<span class="mra-lang cn">CN</span>'
                   : '<span class="mra-lang en">EN</span>';
    const imgSrc = typeof getCardImg === 'function' ? getCardImg(c) : '';
    return `
      <button type="button" class="mra-result" data-card-id="${esc(c.i)}">
        ${imgSrc ? `<img class="mra-result-img" src="${imgSrc}" alt="" loading="lazy" onerror="_onImgError(this)">` : ''}
        <div class="mra-result-main">
          <div class="mra-result-name">${esc(c.n)} ${langBadge}</div>
          <div class="mra-result-sub">${esc(c.s || '')} · ${numLabel}${c.r ? ' · ' + esc(c.r) : ''}</div>
        </div>
      </button>`;
  }).join('');
  results.querySelectorAll('.mra-result').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cardId;
      const card = searchIndex.find(c => String(c.i) === String(id));
      if (!card) return;
      _mktReassignPickedCard = card;
      results.querySelectorAll('.mra-result').forEach(b => b.classList.toggle('is-picked', b === btn));
      const tgt = $('mraTarget');
      const numLabel = card.cn && card.ct ? `#${esc(card.cn)}/${esc(card.ct)}` : card.cn ? `#${esc(card.cn)}` : '';
      const langBadge = card.lang === 'JP' ? '<span class="mra-lang jp">JP</span>'
                     : card.lang === 'CN' ? '<span class="mra-lang cn">CN</span>'
                     : '<span class="mra-lang en">EN</span>';
      if (tgt) tgt.innerHTML = `Will move to: <strong>${esc(card.n)}</strong> ${langBadge} <span class="mra-target-sub">${esc(card.s || '')} · ${numLabel}</span>`;
      const save = $('mraSaveBtn');
      if (save) save.disabled = false;
    });
  });
  _attachMraHoverHandlers(results);
  _hideMraHover();
}

function updateBulkBar() {
  const checked = document.querySelectorAll('.mkt-deal-select:checked');
  const bar = $('mktBulkBar');
  if (!bar) return;
  if (!checked.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const countEl = $('mktBulkCount');
  if (countEl) countEl.textContent = `${checked.length} selected`;
}

function setupReassignModal() {
  $('mraClose')?.addEventListener('click', closeReassignModal);
  $('mraOverlay')?.addEventListener('click', closeReassignModal);
  $('mraCancelBtn')?.addEventListener('click', closeReassignModal);
  const input = $('mraInput');
  if (input) {
    let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(runReassignSearch, 160); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runReassignSearch(); });
  }
  document.querySelectorAll('#mraGrades .mra-grade').forEach(btn => {
    btn.addEventListener('click', () => {
      _mktReassignPickedGrade = btn.dataset.grade;
      document.querySelectorAll('#mraGrades .mra-grade').forEach(b => b.classList.toggle('is-active', b === btn));
    });
  });
  // "Just hide" — record a from-only reassignment so the listing disappears
  // from the origin card without surfacing anywhere else.
  $('mraHideBtn')?.addEventListener('click', () => {
    if (!_mktReassignPayload) return;
    const p = _mktReassignPayload;
    addReassignment({
      url: p.url, title: p.title, image: p.image, source: p.source,
      condition: p.condition, seller: p.seller, priceGBP: p.priceGBP,
      spreadPct: p.spreadPct, signal: p.signal,
      fromCardId: p.fromCardId, fromGrade: p.fromGrade,
      toCardId: null, toGrade: null,
    });
    closeReassignModal();
    if (typeof selectedCard !== 'undefined' && selectedCard) fetchLiveDeals(selectedCard);
  });
  $('mraSaveBtn')?.addEventListener('click', () => {
    if (!_mktReassignPayload || !_mktReassignPickedCard) return;
    const payloads = _mktBulkPayloads.length > 0 ? _mktBulkPayloads : [_mktReassignPayload];
    const target = _mktReassignPickedCard;
    const grade = _mktReassignPickedGrade || 'raw';
    payloads.forEach(p => {
      addReassignment({
        url: p.url, title: p.title, image: p.image, source: p.source,
        condition: p.condition, seller: p.seller, priceGBP: p.priceGBP,
        spreadPct: p.spreadPct, signal: p.signal,
        fromCardId: p.fromCardId, fromGrade: p.fromGrade,
        toCardId: target.i, toGrade: grade,
      });
    });
    document.querySelectorAll('.mkt-deal-select').forEach(cb => { cb.checked = false; });
    closeReassignModal();
    updateBulkBar();
    if (typeof selectedCard !== 'undefined' && selectedCard) fetchLiveDeals(selectedCard);
  });
  // Bulk bar — "Move selected" and "Clear"
  $('mktBulkMoveBtn')?.addEventListener('click', () => {
    const checked = [...document.querySelectorAll('.mkt-deal-select:checked')];
    if (!checked.length) return;
    _mktBulkPayloads = checked.map(cb => {
      try { return JSON.parse(decodeURIComponent(escape(atob(cb.dataset.payload || '')))); }
      catch (e) { return null; }
    }).filter(Boolean);
    if (_mktBulkPayloads.length) openReassignModal(_mktBulkPayloads[0]);
  });
  $('mktBulkClearBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.mkt-deal-select').forEach(cb => { cb.checked = false; });
    _mktBulkPayloads = [];
    updateBulkBar();
  });
  // Checkbox selection change
  document.addEventListener('change', e => {
    if (e.target.closest('.mkt-deal-select')) updateBulkBar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('mraModal') && $('mraModal').style.display !== 'none') closeReassignModal();
  });
  // "Open" button — explicit eBay navigation so tapping Move/Hide never
  // accidentally opens the listing first.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.mkt-deal-open');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const url = btn.dataset.url;
    if (url) openExternalUrl(url);
  }, true);

  // Event delegation — catch reassign-button clicks. The buttons are now
  // siblings of .mkt-deal-main (not children of it) so the link can't fire.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.mkt-deal-reassign');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    let payload = null;
    try {
      const enc = btn.dataset.payload || '';
      payload = JSON.parse(decodeURIComponent(escape(atob(enc))));
    } catch (err) { return; }
    openReassignModal(payload);
  }, true);
  // Dismiss button — record a dismissal for this listing on the current
  // card + grade, then refresh live deals so the row disappears immediately.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.mkt-deal-dismiss');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    let payload = null;
    try {
      const enc = btn.dataset.payload || '';
      payload = JSON.parse(decodeURIComponent(escape(atob(enc))));
    } catch (err) { return; }
    addDismissal({
      url: payload.url,
      title: payload.title,
      fromCardId: payload.fromCardId,
      fromGrade: payload.fromGrade,
    });
    if (typeof selectedCard !== 'undefined' && selectedCard) fetchLiveDeals(selectedCard);
  }, true);
  // "Restore dismissed" link inside a grade-status line — clears all
  // dismissals for the current card + grade, then re-fetches deals.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.mkt-restore-dismissed');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const cardId = link.dataset.cardId || '';
    const gradeKey = link.dataset.grade || '';
    if (!cardId) return;
    clearDismissalsForCard(cardId, gradeKey);
    if (typeof selectedCard !== 'undefined' && selectedCard) fetchLiveDeals(selectedCard);
  }, true);
}

function setupMarketplaceWorker() {
  updateMktSettingsLabel();
  setupReassignModal();
  $('mktSettingsBtn')?.addEventListener('click', () => {
    const current = getMktWorkerUrl();
    const input = prompt(
      'Paste your Cloudflare Worker URL to enable live eBay + Cardmarket scanning.\n\n' +
      'Looks like: https://pokemon-marketplace.<your>.workers.dev\n\n' +
      'Leave empty and press OK to disconnect.',
      current
    );
    if (input === null) return; // cancelled
    setMktWorkerUrl(input.trim());
    if (selectedCard && getMktWorkerUrl()) {
      fetchLiveDeals(selectedCard);
    } else {
      $('mktLiveWrap').style.display = 'none';
    }
  });
}

// =============================================================
// Listing Reassignment · move a wrong-card listing to the right card
// =============================================================
//
// The eBay/Cardmarket queries occasionally surface Japanese or Chinese
// listings under an English card (or vice-versa, or a #125 under a #223
// scan). The reassignment system lets the user say "this listing is
// actually the JP version of card X at PSA 9" — it disappears from the
// origin card's grade and reappears on the target card's grade. All state
// lives in localStorage so it survives reloads and works offline.

const MKT_REASSIGN_KEY = 'pkm-mkt-reassignments';

function getReassignments() {
  try {
    const raw = localStorage.getItem(MKT_REASSIGN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveReassignments(arr) {
  try { localStorage.setItem(MKT_REASSIGN_KEY, JSON.stringify(arr || [])); }
  catch (e) { /* quota — silent */ }
}
function addReassignment(rec) {
  if (!rec || !rec.url) return;
  const arr = getReassignments().filter(r => r.url !== rec.url);
  arr.unshift({ ...rec, ts: Date.now() });
  saveReassignments(arr);
}
function removeReassignment(url) {
  if (!url) return;
  saveReassignments(getReassignments().filter(r => r.url !== url));
}
// URLs to HIDE from the origin card's grade panel.
function reassignmentsFromCard(cardId, gradeKey) {
  const out = new Set();
  for (const r of getReassignments()) {
    if (r.fromCardId === cardId && (!gradeKey || r.fromGrade === gradeKey || !r.fromGrade)) {
      out.add(r.url);
    }
  }
  return out;
}
// Listings CLAIMED by the receiving card at this grade.
function reassignmentsToCard(cardId, gradeKey) {
  return getReassignments().filter(r => r.toCardId === cardId && r.toGrade === gradeKey);
}

// =============================================================
// Listing Dismissals · hide irrelevant listings without reassigning
// =============================================================
//
// Companion to the reassignment system. When a listing is clearly noise
// (wrong product, scammy seller, duplicate, etc.) but isn't a JP/EN or
// wrong-card mismatch worth re-homing, the user just wants it gone. We
// store dismissals per card + grade so the same URL can still appear on
// other cards/grades if relevant. State lives in localStorage and the
// refresh-after-dismiss path re-fetches the grade so the dismissed URL
// disappears immediately.

const MKT_DISMISS_KEY = 'pkm-mkt-dismissals';

function getDismissals() {
  try {
    const raw = localStorage.getItem(MKT_DISMISS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveDismissals(arr) {
  try { localStorage.setItem(MKT_DISMISS_KEY, JSON.stringify(arr || [])); }
  catch (e) { /* quota — silent */ }
}
function addDismissal(rec) {
  if (!rec || !rec.url) return;
  const key = (rec.fromCardId || '') + '\u0001' + (rec.fromGrade || '') + '\u0001' + rec.url;
  const arr = getDismissals().filter(r => ((r.fromCardId || '') + '\u0001' + (r.fromGrade || '') + '\u0001' + r.url) !== key);
  arr.unshift({
    url: rec.url,
    title: rec.title || '',
    fromCardId: rec.fromCardId || '',
    fromGrade: rec.fromGrade || '',
    ts: Date.now(),
  });
  saveDismissals(arr);
}
function removeDismissal(url, cardId, gradeKey) {
  if (!url) return;
  saveDismissals(getDismissals().filter(r => !(
    r.url === url &&
    (cardId == null || r.fromCardId === cardId) &&
    (gradeKey == null || r.fromGrade === gradeKey)
  )));
}
// URLs to hide for this card + grade because the user dismissed them.
function dismissalsForCard(cardId, gradeKey) {
  const out = new Set();
  for (const r of getDismissals()) {
    if (r.fromCardId === cardId && (!gradeKey || r.fromGrade === gradeKey || !r.fromGrade)) {
      out.add(r.url);
    }
  }
  return out;
}
// Clear all dismissals for a card + grade combo (used by "Restore" link in status).
function clearDismissalsForCard(cardId, gradeKey) {
  saveDismissals(getDismissals().filter(r => !(
    r.fromCardId === cardId &&
    (!gradeKey || r.fromGrade === gradeKey || !r.fromGrade)
  )));
}

// Words that almost always indicate junk listings — bulk lots, mystery packs,
// pick-a-card grab bags, Battle Academy / League / online-code cards, etc.
// Strip these out before scoring.
const MKT_JUNK_KEYWORDS = [
  // Bulk + pick-a-card listings
  'choose your card', 'choose your', 'choose card', 'pick your card', 'pick your',
  'mystery', 'grab bag', 'random', 'build your', 'starter deck', 'theme deck',
  'booster pack', 'booster box', 'booster bundle', 'pack of ', 'packs of', 'sealed pack',
  'elite trainer', 'etb ', ' etb', 'collection box', 'bulk', 'lot of', 'card lot',
  ' lot ', 'x100', 'x 100', '100 cards', '50 cards', '25 cards', '10 cards', '5 cards',
  'job lot', 'wholesale', 'binder', 'sleeves', 'card sleeves', 'playmat', 'deck box',
  ' proxy', 'reverse holo bundle', 'common &', '· common', 'commons & uncommons',
  'common and uncommon', 'commons only', 'commons ',
  // Online code cards
  'code card', 'code cards', 'online code', 'online codes', 'tcg online', 'tcgo ',
  ' tcgo', 'ptcgo', 'ptcgl', 'email code', 'message code', 'unused code',
  // Battle Academy / League / promo-deck items where the character name is
  // decoration rather than the actual card being sold
  'battle academy', 'pokemon academy', 'league promo', 'league deck',
  'symbol)', 'symbol stamped', 'stamped promo', 'reverse holos -',
  'damage counter', 'energy card lot', 'condition unspecified codes',
  'divider', 'gx marker', 'ace spec marker',
  // Sealed products / accessories
  'collector chest', 'premium collection', 'mini tin', 'gift set', 'gift box',
  'figure', 'plush', 'keychain', 'sticker', 'sticker book', 'coin only', 'coin set'
];

// Words the listing title MUST contain (case-insensitive) given the card type.
// e.g. a "Charizard ex" listing must mention "ex" — otherwise it's just any Charizard.
function mktRequiredTokens(card) {
  const name = (card.n || '').toLowerCase();
  const out = [];
  // The primary character/word is mandatory — strip ex/v/vmax/gx/etc. tags first
  // and use the leading word(s).
  const base = name
    .replace(/\b(ex|v|vmax|vstar|gx|tag team|prime|legend|break|delta|prism star|radiant)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  if (base) out.push(base.split(' ')[0]); // first word, usually the character
  // Tag tokens that must be present if the card has them
  if (/\bvmax\b/.test(name)) out.push('vmax');
  else if (/\bvstar\b/.test(name)) out.push('vstar');
  else if (/\bv\b/.test(name) && !/\bex\b/.test(name)) out.push('v');
  else if (/\bex\b/.test(name)) out.push('ex');
  else if (/\bgx\b/.test(name)) out.push('gx');
  return out;
}

// If the title contains ANY card-number reference — either "NN/NN" or "#NN" —
// require the right one to appear. Catches:
//   - "Hop - 165/202 - Battle Academy (Pikachu Symbol 13)" misread as Pikachu
//   - "Charizard EX #125 PSA 10" surfacing when scanning the #223 SIR variant
// We do NOT match bare \b\d+\b runs (eBay item IDs, seller catalogue numbers,
// years, etc.) — only the explicit "#NN" and "NN/NN" forms collectors actually
// use to identify cards. If the title has neither form we let it through —
// many sellers simply omit the number.
function mktNumberMismatch(title, card) {
  if (!card || !card.cn) return false;
  const expectedNum = String(card.cn).replace(/^0+/, '');
  const slashMatches = title.match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g) || [];
  const hashMatches  = title.match(/#\s*(\d{1,4})\b/g) || [];
  const refs = [
    ...slashMatches.map(m => m.split('/')[0].trim().replace(/^0+/, '')),
    ...hashMatches.map(m => m.replace(/[#\s]/g, '').replace(/^0+/, '')),
  ];
  if (refs.length === 0) return false;
  return !refs.includes(expectedNum);
}

// Grade-aware filter. For 'raw' tab: reject titles mentioning any PSA/CGC/BGS
// grade. For graded tabs ('7'..'10'): require the title to mention that exact
// PSA grade. Also apply a min-price floor — sub-£3 or sub-8%-of-fair listings
// are virtually always junk regardless of how the title reads.
function mktIsJunk(deal, card, requiredTokens, gradeFilter, fairValueGBP) {
  const title = deal && deal.title ? deal.title : '';
  if (!title) return true;
  const t = ` ${title.toLowerCase()} `;
  // Static junk keywords
  for (const kw of MKT_JUNK_KEYWORDS) {
    if (t.includes(kw)) return true;
  }
  // Required name + tag tokens — use \b word boundaries so "Charizard-ex" and
  // "Charizard-V" also match (hyphen counts as a word boundary).
  for (const tok of requiredTokens) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\b${esc}\\b`, 'i').test(t)) return true;
  }
  // Card-number mismatch
  if (mktNumberMismatch(title, card)) return true;
  // Grade-aware
  const anyGradeRe = /\b(psa|cgc|bgs|ace|sgc)\s*-?\s*\d{1,2}\b|gem mint|gem[- ]mt/i;
  if (gradeFilter === 'raw') {
    if (anyGradeRe.test(title)) return true;
  } else {
    const re = new RegExp(`\\bpsa\\s*-?\\s*${gradeFilter}\\b`, 'i');
    if (!re.test(title)) return true;
  }
  // Price filter — tight window for raw (user-specified ±£15), loose floor for graded
  if (typeof deal.priceGBP === 'number' && fairValueGBP > 0) {
    if (gradeFilter === 'raw') {
      const floor = Math.max(1, fairValueGBP - 15);
      const ceil  = fairValueGBP + 15;
      if (deal.priceGBP < floor || deal.priceGBP > ceil) return true;
    } else {
      const floor = Math.max(3, fairValueGBP * 0.08);
      if (deal.priceGBP < floor) return true;
    }
  }
  return false;
}

// Text-based grade estimate from listing title / condition field.
// Returns { label, range } or null if nothing useful found.
// Skips listings already identified as graded (PSA/CGC/etc.) — caller is responsible.
function mktEstimateGradeFromText(title, condition) {
  const text = `${title || ''} ${condition || ''}`;
  const t = ` ${text.toLowerCase()} `;
  const check = re => re.test(t);
  // Order matters — match most specific first
  // Ranges are deliberately conservative — eBay sellers routinely over-describe
  // condition by 1-2 PSA points, so we shift estimates down to match reality.
  if (check(/\b(pack fresh|unplayed|sealed)\b/))          return { label: 'Pack Fresh',   range: '9–10' };
  if (check(/\b(near mint|nm-mt|nm\/mt)\b/))              return { label: 'Near Mint',    range: '7–9'  };
  // "mint" without "near" — avoid matching "near mint"
  if (check(/(?<![a-z])mint(?!-[a-z]|\s+condition\s+not\s+near)/) && !check(/\bnear\s+mint\b/)) return { label: 'Mint', range: '8–10' };
  if (check(/\b(lightly played|lp)\b/))                   return { label: 'Lightly Played', range: '6–7' };
  if (check(/\b(excellent|ex)\b/))                        return { label: 'Excellent',    range: '6–7'  };
  if (check(/\b(very good|vg)\b/))                        return { label: 'Very Good',    range: '5–6'  };
  if (check(/\b(moderately played|mp)\b/))                return { label: 'Mod. Played',  range: '4–5'  };
  if (check(/\b(heavily played|hp)\b/))                   return { label: 'Hvy. Played',  range: '2–3'  };
  // "good" without VG prefix already consumed above
  if (check(/\b(good|gd)\b/))                             return { label: 'Good',         range: '4–5'  };
  // Generic "played" only if LP/MP/HP not already matched
  if (check(/\bplayed\b/))                                return { label: 'Played',       range: '3–5'  };
  if (check(/\b(poor|damaged|dmg)\b/))                    return { label: 'Damaged',      range: '1–2'  };
  return null;
}

// Marketplace scan: we no longer cap eBay/Cardmarket queries by price — every
// listing comes back regardless of how over market it is, and we let the risk
// band call out the crazy overpriced ones. The worker still requires a `max`
// param, so we pass an effectively-infinite ceiling.
const MKT_SCAN_NO_CAP_GBP = 99999;        // effectively uncapped — risk band rates over-market listings
const MKT_RISK_OVER_LOW_PCT    = 10;      // ≤ 10% over fair = low (with hold premium)
const MKT_RISK_OVER_MED_PCT    = 40;      // ≤ 40% over fair = medium (still defensible)
const MKT_RISK_LOW_ROI_FLOOR   = 50;      // 5yr ROI ≥ 50% can rescue a slight overpay to low
const MKT_RISK_MED_ROI_FLOOR   = 0;       // 5yr ROI must at least break even for medium

// Score a listing client-side using the true fair value (so we can include
// above-market listings the worker would otherwise tag as junk premiums).
// Returns updated spread + signal + 5yr projection + risk band.
function mktScoreDeal(deal, card, gradeKey, fairValueGBP, fxUsdToGbp) {
  const priceGBP = (typeof deal.priceGBP === 'number') ? deal.priceGBP : 0;
  const fair = fairValueGBP > 0 ? fairValueGBP : 0;

  // eBay listings inherently include the seller's fee recovery (~13% UK FVF) plus
  // a typical profit margin — so an eBay price at "market + 15%" is normal, not a
  // premium. Adjust the reference fair value upward for eBay sources so the signal
  // labels reflect realistic eBay economics rather than raw PriceCharting values.
  const isEbay = (deal.source || '').toLowerCase().includes('ebay');
  const adjustedFair = (isEbay && fair > 0) ? fair * (1 + EBAY_LISTING_PREMIUM) : fair;

  // Spread sign convention: positive = below adjusted fair (good deal).
  const spreadPct = (priceGBP > 0 && adjustedFair > 0)
    ? ((adjustedFair - priceGBP) / adjustedFair) * 100
    : 0;
  const overPct = (priceGBP > 0 && adjustedFair > 0 && priceGBP > adjustedFair)
    ? ((priceGBP - adjustedFair) / adjustedFair) * 100
    : 0;

  // Re-derive the VALUE / STRONG VALUE / FAIR / PREMIUM signal so
  // colour-coding stays consistent now that we're surfacing over-market deals.
  let signal;
  if (spreadPct >= 25)      signal = 'STRONG VALUE';
  else if (spreadPct >= 8)  signal = 'VALUE';
  else if (spreadPct >= -5) signal = 'FAIR';
  else                      signal = 'PREMIUM';

  // 5yr ROI projection using the listing price as the entry point. Mirrors
  // computeHoldCore's raw / graded math but anchored on the actual listing.
  let roi5 = null, profitGBP = null, sellGBP = null;
  if (priceGBP > 0 && typeof projectGradePrice === 'function' && fxUsdToGbp > 0) {
    const priceUSD = priceGBP / fxUsdToGbp;
    let yr5USD = 0;
    if (gradeKey === 'raw') {
      const premium = (typeof GRADE_GROWTH_PREMIUM !== 'undefined' && GRADE_GROWTH_PREMIUM[9]) || 1;
      yr5USD = projectGradePrice(card, 9, priceUSD, 5) / premium;
    } else {
      const g = parseInt(gradeKey, 10);
      if (g >= 7 && g <= 10) yr5USD = projectGradePrice(card, g, priceUSD, 5);
    }
    if (yr5USD > 0) {
      const friction = (typeof BUY_SELL_FRICTION === 'number') ? BUY_SELL_FRICTION : 0.10;
      const sellUSD = yr5USD * (1 - friction);
      sellGBP = sellUSD * fxUsdToGbp;
      profitGBP = sellGBP - priceGBP;
      roi5 = (profitGBP / priceGBP) * 100;
    }
  }

  // Risk band: at/below fair is always low. Slight overpay is rescued by a
  // strong 5yr ROI. Beyond ~40% over fair, OR if the 5yr hold doesn't even
  // recoup the entry, we call it high risk — "crazy overpriced".
  let risk;
  if (overPct <= 0) {
    risk = 'low';
  } else if (overPct <= MKT_RISK_OVER_LOW_PCT && roi5 !== null && roi5 >= MKT_RISK_LOW_ROI_FLOOR) {
    risk = 'low';
  } else if (overPct <= MKT_RISK_OVER_MED_PCT && roi5 !== null && roi5 > MKT_RISK_MED_ROI_FLOOR) {
    risk = 'medium';
  } else {
    risk = 'high';
  }

  return { spreadPct, overPct, signal, roi5, profitGBP, sellGBP, risk };
}

// Build the HTML for a single deal card. Shared by every grade panel.
// `meta` carries the origin-card context (fromCardId, fromGrade) plus an
// optional `claimed` flag for listings that were reassigned IN to this card.
// Detect non-English card language from a listing title.
// Returns 'Japanese', 'Korean', 'Chinese', or null.
// Japanese hiragana/katakana are unique; CJK alone is ambiguous (shared with JP kanji).
function mktDetectListingLang(title) {
  if (!title) return null;
  // Korean: hangul block or keyword
  if (/\bkorean\b/i.test(title) || /[가-힯]/.test(title)) return 'Korean';
  // Chinese: keyword (avoid false-positive from CJK characters alone since JP kanji overlaps)
  if (/\b(chinese|china|simplified|traditional chinese)\b/i.test(title)) return 'Chinese';
  // Japanese: explicit keyword or hiragana/katakana characters (unique to Japanese)
  if (/\bjapanese\b/i.test(title) || /[぀-ヿ]/.test(title)) return 'Japanese';
  return null;
}

function mktRenderDealCard(d, meta) {
  meta = meta || {};
  const sigCls = d.signal === 'STRONG VALUE' ? 'mkt-strong'
               : d.signal === 'VALUE'        ? 'mkt-fair'
               : d.signal === 'PREMIUM'      ? 'mkt-weak' : 'mkt-fair';
  const sourceCls = (d.source || '').includes('UK') ? 'src-uk'
                  : (d.source || '').includes('US') ? 'src-us' : 'src-cm';
  const img = d.image
    ? `<img class="mkt-deal-img" src="${esc(d.image)}" alt="" onerror="_onImgError(this)">`
    : '<div class="mkt-deal-img"></div>';
  const claimedChip = meta.claimed
    ? `<span class="mkt-claimed-chip" title="Reassigned to this card">⇄ Reassigned here</span>`
    : '';
  // Cheap, URL-safe payload for the reassign modal. Avoid quoting headaches
  // by base64-encoding the JSON — the click handler decodes it back.
  const payload = {
    url: d.url, title: d.title, image: d.image || '',
    source: d.source, condition: d.condition || '', seller: d.seller || '',
    priceGBP: d.priceGBP, spreadPct: d.spreadPct, signal: d.signal,
    fromCardId: meta.fromCardId || '', fromGrade: meta.fromGrade || '',
  };
  const enc = (typeof btoa === 'function')
    ? btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    : '';
  const isAlertedDeal = _mktAlertTriggered && (d.signal === 'STRONG VALUE' || d.signal === 'VALUE');
  const alertedBadge = isAlertedDeal ? `<span class="mkt-deal-alert-badge">Alert match</span>` : '';

  // Language detection — flag non-English listings
  const _scanCard = (typeof selectedCard !== 'undefined' && selectedCard) ? selectedCard : null;
  const _scanIsJP = _scanCard && _scanCard.lang === 'JP';
  const _listingLang = mktDetectListingLang(d.title);
  // Japanese is only unexpected when scanning an EN card
  const _langFlag = (!_listingLang || (_listingLang === 'Japanese' && _scanIsJP)) ? null : _listingLang;
  const _isWrongLang = _langFlag === 'Korean' || _langFlag === 'Chinese';
  const _isJpOnEnScan = _langFlag === 'Japanese';

  let langBannerHtml = '';
  if (_isWrongLang) {
    const flag = _langFlag === 'Korean' ? '🇰🇷' : '🇨🇳';
    langBannerHtml = `<div class="mkt-lang-banner mkt-lang-wrong">${flag} Appears to be a <strong>${_langFlag}</strong> card — likely wrong listing.</div>`;
  } else if (_isJpOnEnScan) {
    // Find JP counterpart for a "Scan JP version" shortcut
    const _cp = (typeof findCounterparts === 'function' && _scanCard) ? findCounterparts(_scanCard) : null;
    const _cpId = _cp?.primary?.i || '';
    const cpBtn = _cpId
      ? `<button type="button" class="mkt-lang-cp-btn" onclick="showPage('predict');selectCard('${esc(_cpId)}')" title="Switch scan to JP counterpart">Scan JP version ↗</button>`
      : '';
    langBannerHtml = `<div class="mkt-lang-banner mkt-lang-jp">🇯🇵 Appears to be a <strong>Japanese</strong> listing.${cpBtn ? ' ' + cpBtn : ''}</div>`;
  }

  const anyGradeRe = /\b(psa|cgc|bgs|ace|sgc)\s*-?\s*\d{1,2}\b|gem mint|gem[- ]mt/i;
  const isAlreadyGraded = anyGradeRe.test(d.title || '');

  // Tier 1: instant text estimate badge (raw listings only)
  let gradeEstimateHtml = '';
  if (!isAlreadyGraded) {
    const est = mktEstimateGradeFromText(d.title, d.condition);
    if (est) {
      gradeEstimateHtml = `<div class="mkt-grade-estimate">
          <span class="mkt-grade-label">~PSA ${esc(est.range)}</span>
          <span class="mkt-grade-condition">${esc(est.label)}</span>
        </div>`;
    }
  }

  // Tier 2: AI Grade button (raw listings with an image only)
  const aiGradeBtn = (!isAlreadyGraded && d.image)
    ? `<button type="button" class="mkt-ai-grade-btn" data-url="${esc(d.image)}" onclick="mktAIGrade(this)">🔍 AI Grade</button>`
    : '';

  return `
    <div class="mkt-deal ${meta.claimed ? 'is-claimed' : ''}${isAlertedDeal ? ' mkt-deal-alerted' : ''}${_isWrongLang ? ' mkt-deal-wrong-lang' : ''}${_isJpOnEnScan ? ' mkt-deal-jp-flag' : ''}">
      ${langBannerHtml}
      <a class="mkt-deal-main" href="${esc(d.url)}" target="_blank" rel="noopener">
        ${img}
        <div class="mkt-deal-body">
          <div class="mkt-deal-title">${esc(d.title)}${alertedBadge}</div>
          ${gradeEstimateHtml}
          <div class="mkt-deal-meta">
            <span class="mkt-src ${sourceCls}">${esc(d.source)}</span>
            ${d.condition ? `<span>${esc(d.condition)}</span>` : ''}
            ${d.seller ? `<span>· ${esc(d.seller)}</span>` : ''}
            ${claimedChip}
          </div>
        </div>
        <div class="mkt-deal-right">
          <div class="mkt-deal-price">£${d.priceGBP.toFixed(2)}</div>
          <div class="mkt-deal-spread ${d.spreadPct >= 0 ? 'pos' : 'neg'}">${d.spreadPct >= 0 ? '↓' : '↑'} ${Math.abs(d.spreadPct).toFixed(0)}% vs fair</div>
          ${typeof d.roi5 === 'number' ? `<div class="mkt-deal-roi5 ${d.roi5 >= 0 ? 'pos' : 'neg'}" title="Projected 5-year ROI at this entry price">5yr ${d.roi5 >= 0 ? '+' : ''}${d.roi5.toFixed(0)}%</div>` : ''}
          <span class="mkt-pill ${sigCls}">${esc(d.signal)}</span>
          ${d.risk ? `<span class="mkt-risk mkt-risk-${d.risk}" title="Capital risk band based on % over fair value and 5-year hold ROI">${d.risk.toUpperCase()} RISK</span>` : ''}
        </div>
      </a>
      <div class="mkt-deal-actions">
        <label class="mkt-deal-check-wrap" title="Select for bulk move"><input type="checkbox" class="mkt-deal-select" data-payload="${enc}"></label>
        <button type="button" class="mkt-deal-open" data-url="${esc(d.url)}" title="Open listing on eBay">Open ↗</button>
        <button type="button" class="mkt-deal-reassign" data-payload="${enc}" title="Wrong card? Move this listing" aria-label="Move this listing to a different card">⇄ Move</button>
        <button type="button" class="mkt-deal-dismiss" data-payload="${enc}" title="Not relevant — hide this listing" aria-label="Dismiss this listing">✕ Hide</button>
        ${aiGradeBtn}
      </div>
    </div>
  `;
}

// AI-powered grade button handler. Called from onclick in mktRenderDealCard.
async function mktAIGrade(btn) {
  const imageUrl = btn.dataset.url;
  if (!imageUrl) return;
  btn.textContent = 'Grading…';
  btn.disabled = true;

  const deal = btn.closest('.mkt-deal');
  const body = deal && deal.querySelector('.mkt-deal-body');

  // Find or create result container — insert after .mkt-grade-estimate if present
  let resultEl = body && body.querySelector('.mkt-grade-ai-result');
  if (!resultEl && body) {
    resultEl = document.createElement('div');
    resultEl.className = 'mkt-grade-ai-result';
    const after = body.querySelector('.mkt-grade-estimate') || body.querySelector('.mkt-deal-title');
    if (after && after.nextSibling) {
      body.insertBefore(resultEl, after.nextSibling);
    } else if (after) {
      body.appendChild(resultEl);
    }
  }

  try {
    const resp = await fetch(`${getMktWorkerUrl()}/grade-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      let msg = txt; try { msg = JSON.parse(txt).error || txt; } catch {}
      throw new Error(msg || `Worker ${resp.status}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    // Compute PSA + ACE grades using same logic as _cgCalcGrade / _cgCalcAceGrade
    const scores = [data.centering, data.corners, data.edges, data.surface].filter(v => v != null);
    let grade = null, aceGrade = null;
    if (scores.length === 4) {
      const min = Math.min(...scores);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (min >= 10) { grade = 10; aceGrade = 10; }
      else if (min >= 8 && avg >= 9.5) { grade = 10; aceGrade = 10; }
      else if (min >= 8 && avg >= 9.0) { grade = 9;  aceGrade = 9.5; }
      else if (min >= 8 && avg >= 8.5) { grade = 9;  aceGrade = 9; }
      else if (min >= 8)               { grade = 8;  aceGrade = 8.5; }
      else if (min >= 6 && avg >= 7.5) { grade = 7;  aceGrade = 8; }
      else if (min >= 6)               { grade = 6;  aceGrade = 7; }
      else if (min >= 4 && avg >= 6)   { grade = 5;  aceGrade = 6; }
      else                             { grade = 4;  aceGrade = 5; }
    }

    if (grade != null) {
      const cardId = (typeof selectedCard !== 'undefined' && selectedCard) ? selectedCard.i : null;
      const cardName = (typeof selectedCard !== 'undefined' && selectedCard) ? selectedCard.n : '';
      if (cardId) {
        // Extract listing details from the surrounding deal card
        const dealEl   = btn.closest('.mkt-deal');
        const mainA    = dealEl?.querySelector('.mkt-deal-main');
        const listingUrl = mainA?.href || '';
        const priceEl  = dealEl?.querySelector('.mkt-deal-price');
        const priceGBP = priceEl ? parseFloat(priceEl.textContent.replace('£', '')) || 0 : 0;
        const breakdown = { centering: data.centering, corners: data.corners, edges: data.edges, surface: data.surface, verdict: data.verdict || '' };

        // Store every AI-graded deal at listing level (not card level)
        const gradeDeals = JSON.parse(localStorage.getItem('pkm-ai-grade-deals-v1') || '[]');
        const idx = gradeDeals.findIndex(d => d.listingUrl === listingUrl);
        const rec = { cardId, cardName, listingUrl, listingImg: imageUrl, priceGBP, aiGrade: grade, breakdown, ts: Date.now() };
        if (idx >= 0) gradeDeals[idx] = rec; else gradeDeals.unshift(rec);
        localStorage.setItem('pkm-ai-grade-deals-v1', JSON.stringify(gradeDeals.slice(0, 100)));

        // Remove from candidates once graded
        const cands = JSON.parse(localStorage.getItem('pkm-grade-candidates-v1') || '[]');
        localStorage.setItem('pkm-grade-candidates-v1', JSON.stringify(cands.filter(c => c.listingUrl !== listingUrl)));

        try { _renderHomeAiGrades(); _renderHomeGradeCandidates(); _renderHomeAcePicks(); } catch {}
      }
    }
    if (resultEl) {
      resultEl.className = 'mkt-grade-ai-result';
      resultEl.innerHTML = grade != null
        ? `<span class="mkt-grade-label">AI: PSA ~${grade} · ACE ~${aceGrade}</span>` +
          `<span class="mkt-grade-breakdown">C:${data.centering} Co:${data.corners} E:${data.edges} S:${data.surface}</span>` +
          (data.verdict ? `<span class="mkt-grade-verdict">${esc(data.verdict)}</span>` : '')
        : `<span class="mkt-grade-err">Grade unavailable</span>`;
    }
  } catch (e) {
    if (resultEl) {
      resultEl.className = 'mkt-grade-ai-result';
      resultEl.innerHTML = `<span class="mkt-grade-err">Grade unavailable</span>`;
    }
  } finally {
    btn.textContent = '🔍 Re-grade';
    btn.disabled = false;
  }
}

// Fetch + render deals for one grade tab. Called in parallel by fetchLiveDeals.
async function fetchGradeDeals(card, g, workerUrl, required, fxUsdToGbp, fxEurToGbp, scanToken, forceFresh) {
  const status = $(`mktStatus-${g.key}`);
  const list = $(`mktList-${g.key}`);
  const badge = $(`mktBadge-${g.key}`);
  // Stale-scan guard: a new card selection invalidates older fetches.
  const isStale = () => scanToken !== mktScanToken;
  if (!g.fairUSD || g.fairUSD <= 0) {
    if (status) status.textContent = 'No fair-value anchor for this grade.';
    if (list) list.innerHTML = '';
    if (badge) badge.textContent = '0';
    return 0;
  }
  const fairValueGBP = gbpFromUSD(g.fairUSD);
  // Uncapped scan — we want above-market listings to come back too, so the
  // risk band can flag them. The worker requires `max` to be present, so we
  // pass an effectively-infinite ceiling.
  const scanCapGBP = MKT_SCAN_NO_CAP_GBP;
  const query = buildSearchQuery(card, g.queryGrade);
  // forceFresh appends a cache-bust param so the Cloudflare edge + browser
  // cache (worker sends Cache-Control max-age=300) are bypassed when the user
  // explicitly hits Refresh.
  const cacheBust = forceFresh ? `&_t=${Date.now()}` : '';
  const ukOnlyParam = mktIsUkOnly() ? '&source=uk_only' : '';
  const url = `${workerUrl}/search?q=${encodeURIComponent(query)}&max=${scanCapGBP.toFixed(2)}&grade=${g.workerGrade}&fx=${fxUsdToGbp}&fxEur=${fxEurToGbp}${ukOnlyParam}${cacheBust}`;
  try {
    const t0 = performance.now();
    const res = await fetch(url);
    if (isStale()) return 0;
    if (!res.ok) throw new Error(`Worker ${res.status}`);
    const data = await res.json();
    if (isStale()) return 0;
    const took = Math.round(performance.now() - t0);
    const rawDeals = data.deals || [];
    // Client-side safety filter: if UK-only is active, strip any eBay US / Cardmarket
    // items that may have slipped through (e.g. stale CDN cache served a non-uk_only
    // response for the same URL).
    const _ukOnlyNow = mktIsUkOnly();
    let deals = rawDeals
      .filter(d => _ukOnlyNow ? !((d.source || '').includes('US') || (d.source || '') === 'Cardmarket') : true)
      .filter(d => !mktIsJunk(d, card, required, g.workerGrade, fairValueGBP));
    // Auto-save raw deals with PSA 9-10 text estimate as grade candidates
    if (g.workerGrade === 'raw') {
      const newCands = deals
        .filter(d => { const e = mktEstimateGradeFromText(d.title, d.condition); return d.image && e && (e.range === '9–10' || e.range === '8–10'); })
        .map(d => ({ cardId: card.i, cardName: card.n, listingUrl: d.url, listingImg: d.image || '', priceGBP: d.priceGBP, ts: Date.now() }));
      if (newCands.length) {
        const existing = JSON.parse(localStorage.getItem('pkm-grade-candidates-v1') || '[]');
        const graded   = new Set((JSON.parse(localStorage.getItem('pkm-ai-grade-deals-v1') || '[]')).map(r => r.listingUrl));
        const seen     = new Set(existing.map(c => c.listingUrl));
        const fresh    = newCands.filter(c => !seen.has(c.listingUrl) && !graded.has(c.listingUrl));
        if (fresh.length) {
          localStorage.setItem('pkm-grade-candidates-v1', JSON.stringify([...fresh, ...existing].slice(0, 60)));
          try { _renderHomeGradeCandidates(); } catch {}
        }
      }
    }
    // Re-score each deal against the true fair value (the worker's spread/signal
    // was relative to the inflated scan cap). Adds 5yr ROI projection and
    // low/medium/high risk band based on % over fair + hold economics.
    deals = deals.map(d => {
      const sc = mktScoreDeal(d, card, g.workerGrade, fairValueGBP, fxUsdToGbp);
      return { ...d, spreadPct: sc.spreadPct, signal: sc.signal, overPct: sc.overPct, roi5: sc.roi5, risk: sc.risk };
    });
    // Sort by spread — best value deals first, then mediums, then high-risk
    // premiums at the bottom so the user always sees the best buys up top.
    deals.sort((a, b) => (b.spreadPct ?? -999) - (a.spreadPct ?? -999));
    // Apply user reassignments: hide URLs the user has moved AWAY from this
    // card+grade, and surface URLs they've moved TO this card+grade.
    const hiddenUrls = reassignmentsFromCard(card.i, g.workerGrade);
    const visibleAfterHide = deals.filter(d => !hiddenUrls.has(d.url));
    const hiddenCount = deals.length - visibleAfterHide.length;
    deals = visibleAfterHide;
    // Apply user dismissals: hide URLs the user has marked as not relevant
    // for this specific card+grade. Dismissals are scoped narrowly so the
    // same URL can still appear under other cards or grades.
    const dismissedUrls = dismissalsForCard(card.i, g.workerGrade);
    const visibleAfterDismiss = deals.filter(d => !dismissedUrls.has(d.url));
    const dismissedCount = deals.length - visibleAfterDismiss.length;
    deals = visibleAfterDismiss;
    let claimed = reassignmentsToCard(card.i, g.workerGrade);
    // Re-score claimed listings against this card's fair value too, so the
    // 5yr ROI + risk pill render consistently across moved-in and native deals.
    claimed = claimed.map(rec => {
      const sc = mktScoreDeal(rec, card, g.workerGrade, fairValueGBP, fxUsdToGbp);
      return { ...rec, spreadPct: sc.spreadPct, signal: sc.signal, overPct: sc.overPct, roi5: sc.roi5, risk: sc.risk };
    });
    // Deduplicate — in the rare case the worker also returned a claimed URL,
    // the claim record wins (it has the user-edited context).
    const claimedUrls = new Set(claimed.map(c => c.url));
    deals = deals.filter(d => !claimedUrls.has(d.url));
    const filteredCount = rawDeals.length - (deals.length + claimed.length + hiddenCount + dismissedCount);
    const c = data.counts || {};
    const errStr = (data.errors && data.errors.length) ? ` · errors: ${data.errors.join(', ')}` : '';
    const parts = [];
    if (filteredCount > 0) parts.push(`${filteredCount} junk`);
    if (hiddenCount > 0)   parts.push(`${hiddenCount} moved out`);
    if (claimed.length)    parts.push(`${claimed.length} moved in`);
    // Dismissed count is rendered with a Restore link so the user can undo.
    const dismissedPill = dismissedCount > 0
      ? `<span class="mkt-dismissed-chip">${dismissedCount} dismissed · <a href="#" class="mkt-restore-dismissed" data-card-id="${esc(card.i)}" data-grade="${esc(g.workerGrade)}">Restore</a></span>`
      : '';
    const filterStr = parts.length ? ` · ${parts.join(' / ')}` : '';
    const totalShown = deals.length + claimed.length;
    if (badge) badge.textContent = String(totalShown);
    // Count how many of the visible deals are above market (for status hint).
    const overCount = deals.filter(d => (d.overPct || 0) > 0).length;
    const overStr = overCount > 0 ? ` · ${overCount} above market` : '';
    const srcStr = _ukOnlyNow
      ? `UK ${c.ebay_uk || 0}`
      : `UK ${c.ebay_uk || 0} · US ${c.ebay_us || 0} · CM ${c.cardmarket || 0}`;
    if (status) status.innerHTML = `${totalShown} clean · £${fairValueGBP.toFixed(0)} fair value${overStr} · ${srcStr} · ${took}ms${filterStr}${errStr}${dismissedPill ? ' · ' + dismissedPill : ''}`;
    if (list) {
      if (totalShown === 0) {
        list.innerHTML = `<div class="mkt-empty">No clean ${g.label} listings on the wire right now (fair value £${fairValueGBP.toFixed(0)}${filteredCount > 0 ? `, ${filteredCount} junk filtered` : ''}). Try the deep-link buttons below.</div>`;
      } else {
        const meta = { fromCardId: card.i, fromGrade: g.workerGrade };
        const claimedHtml = claimed.map(rec => mktRenderDealCard(rec, { ...meta, claimed: true })).join('');
        const dealsHtml = deals.map(d => mktRenderDealCard(d, meta)).join('');
        list.innerHTML = claimedHtml + dealsHtml;
      }
    }
    return totalShown;
  } catch (e) {
    if (isStale()) return 0;
    if (status) status.textContent = `Worker error: ${e.message}.`;
    if (list) list.innerHTML = '';
    if (badge) badge.textContent = '!';
    return 0;
  }
}

// Stale-scan guard: each call to fetchLiveDeals increments this token. Any
// in-flight fetch whose token no longer matches discards its result.
let mktScanToken = 0;
let _mktAlertTriggered = false; // true when current card has an active watchlist alert

// Wire up grade-tab clicks once. Idempotent.
function setupMktGradeTabs() {
  const tabs = document.querySelectorAll('#mktGradeTabs .mkt-grade-tab');
  if (!tabs.length || tabs[0].dataset.tabsBound) return;
  tabs.forEach(tab => {
    tab.dataset.tabsBound = '1';
    tab.addEventListener('click', () => {
      const g = tab.dataset.grade;
      document.querySelectorAll('#mktGradeTabs .mkt-grade-tab').forEach(t => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.mkt-grade-panel').forEach(p => p.classList.toggle('is-active', p.dataset.grade === g));
    });
  });
}

async function fetchLiveDeals(card, opts) {
  const forceFresh = !!(opts && opts.forceFresh);
  const workerUrl = getMktWorkerUrl();
  const wrap = $('mktLiveWrap');
  const topStatus = $('mktLiveStatus');
  if (!workerUrl || !card) { if (wrap) wrap.style.display = 'none'; return; }

  const rawPriceUSD = getCurrentPrice(card);
  // Use getPsa10Anchor() for rarity-aware estimation when no tracked/live price exists.
  const psa10Price = getPsa10Anchor(card).usd;
  wrap.style.display = 'block';
  setupMktGradeTabs();
  if (topStatus) topStatus.textContent = mktIsUkOnly()
    ? `Scanning 5 grades · eBay UK only…`
    : `Scanning 5 grades · eBay UK + US + Cardmarket…`;

  // Check for a triggered watchlist alert on this card and surface a banner.
  const _cardAlerts = typeof computeActiveAlerts === 'function' ? computeActiveAlerts() : [];
  const _cardAlert = _cardAlerts.find(a => a.id === card.i && a.triggered && a.dismissedFor !== a.signal);
  _mktAlertTriggered = !!_cardAlert;
  const alertBanner = $('mktAlertBanner');
  if (alertBanner) {
    if (_cardAlert) {
      const sigClass = _cardAlert.signal === 'STRONG BUY' ? 'sig-strong' : _cardAlert.signal === 'BUY' ? 'sig-buy' : 'sig-hold';
      const trigBits = [];
      if (_cardAlert.transitioned) trigBits.push(`Signal flipped <strong>${_cardAlert.addedSignal}</strong> → <strong>${_cardAlert.signal}</strong>`);
      if (_cardAlert.bigDrop) trigBits.push(`Price down <strong>${_cardAlert.priceDropPct.toFixed(1)}%</strong> since added`);
      if (!trigBits.length) trigBits.push(`Signal: <strong>${_cardAlert.signal}</strong>`);
      alertBanner.innerHTML = `
        <span class="alert-signal-badge ${sigClass}">${_cardAlert.signal}</span>
        <span class="mkt-alert-banner-trigger">${trigBits.join(' · ')} — value listings highlighted below</span>
      `;
      alertBanner.style.display = 'flex';
    } else {
      alertBanner.style.display = 'none';
    }
  }

  const fxUsdToGbp = (typeof fxRate === 'number' ? fxRate : 0.79);
  const fxEurToGbp = _currencyRates.EUR > 0 ? 1 / _currencyRates.EUR : 0.86;
  const required = mktRequiredTokens(card);

  // Define each grade tab with its fair-value anchor.
  const grades = [
    { key: 'raw',   label: 'Raw',    queryGrade: 'Raw',    workerGrade: 'raw', fairUSD: rawPriceUSD || (psa10Price * (PSA_RATIOS[1] || 0.022) * 5) },
    { key: 'psa7',  label: 'PSA 7',  queryGrade: 'PSA 7',  workerGrade: '7',   fairUSD: psa10Price * (PSA_RATIOS[7]  || 0.11) },
    { key: 'psa8',  label: 'PSA 8',  queryGrade: 'PSA 8',  workerGrade: '8',   fairUSD: psa10Price * (PSA_RATIOS[8]  || 0.18) },
    { key: 'psa9',  label: 'PSA 9',  queryGrade: 'PSA 9',  workerGrade: '9',   fairUSD: psa10Price * (PSA_RATIOS[9]  || 0.35) },
    { key: 'psa10', label: 'PSA 10', queryGrade: 'PSA 10', workerGrade: '10',  fairUSD: psa10Price },
  ];

  // Reset placeholders
  grades.forEach(g => {
    const st = $(`mktStatus-${g.key}`);
    const li = $(`mktList-${g.key}`);
    const bd = $(`mktBadge-${g.key}`);
    if (st) st.textContent = 'Scanning…';
    if (li) li.innerHTML = '';
    if (bd) bd.textContent = '…';
  });

  const scanToken = ++mktScanToken;
  const t0 = performance.now();
  const results = await Promise.allSettled(
    grades.map(g => fetchGradeDeals(card, g, workerUrl, required, fxUsdToGbp, fxEurToGbp, scanToken, forceFresh))
  );
  if (scanToken !== mktScanToken) return; // newer scan in-flight
  const total = results.reduce((acc, r) => acc + (r.status === 'fulfilled' ? (r.value || 0) : 0), 0);
  const took = Math.round(performance.now() - t0);
  if (topStatus) topStatus.textContent = `${total} total clean listings across all grades · ${took}ms`;
}

// Hook live-scan into card selection (no-op if URL not set).
// Track the most recently scanned card so the Refresh button can re-run it.
let mktLastScannedCard = null;
const _originalRenderMarketplaceScan = renderMarketplaceScan;
renderMarketplaceScan = function(card, pullCost, des) {
  mktLastScannedCard = card || null;
  _originalRenderMarketplaceScan(card, pullCost, des);
  // Note: _originalRenderMarketplaceScan already calls fetchLiveDeals internally;
  // do NOT call it again here or every card navigation triggers two parallel scans.
};

const MKT_UK_ONLY_KEY = 'mkt-uk-only';
function mktIsUkOnly() { return localStorage.getItem(MKT_UK_ONLY_KEY) === '1'; }
function mktSetUkOnly(on) {
  if (on) localStorage.setItem(MKT_UK_ONLY_KEY, '1');
  else localStorage.removeItem(MKT_UK_ONLY_KEY);
  const tog = $('mktUkToggle');
  if (tog) {
    tog.classList.toggle('is-active', on);
    tog.setAttribute('aria-pressed', String(on));
  }
}

// Wire the Refresh button. Re-runs fetchLiveDeals for the currently selected
// card. Adds a spinning state on the icon while the scan is in-flight.
function setupMktRefreshBtn() {
  const btn = $('mktRefreshBtn');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    const card = mktLastScannedCard || (typeof selectedCard !== 'undefined' ? selectedCard : null);
    if (!card || !getMktWorkerUrl()) return;
    btn.classList.add('is-spinning');
    btn.disabled = true;
    try {
      // Refresh button always bypasses CDN + browser cache so the user gets
      // a guaranteed-fresh scan, not a stale 5-minute-cached response.
      await fetchLiveDeals(card, { forceFresh: true });
    } finally {
      btn.classList.remove('is-spinning');
      btn.disabled = false;
    }
  });

  const tog = $('mktUkToggle');
  if (tog && !tog.dataset.bound) {
    tog.dataset.bound = '1';
    // Restore persisted state.
    mktSetUkOnly(mktIsUkOnly());
    tog.addEventListener('click', async () => {
      mktSetUkOnly(!mktIsUkOnly());
      const card = mktLastScannedCard || (typeof selectedCard !== 'undefined' ? selectedCard : null);
      if (card && getMktWorkerUrl()) await fetchLiveDeals(card, { forceFresh: true });
    });
  }
}
queueMicrotask(setupMktRefreshBtn);

// Boot the settings button once the DOM is ready (init() runs synchronously
// near the top of this file; we attach in microtask so dependencies exist).
queueMicrotask(setupMarketplaceWorker);

// =============================================================
// Hold Strategy · Raw vs Graded comparison
// =============================================================
//
// Given the selected card, build a side-by-side comparison of six holding
// strategies and pick the long-term winner:
//
//   1. Buy Raw — hold ungraded — cheapest entry, modest ceiling
//   2. Buy Raw + Grade — EV across the PSA grade distribution
//   3. Buy PSA 7 — graded floor entry
//   4. Buy PSA 8 — mid-grade
//   5. Buy PSA 9 — near-mint entry
//   6. Buy PSA 10 — gem mint, highest ceiling and lowest variance
//
// For each, we compute: today's all-in cost, projected 5yr value, expected
// profit £, ROI %, and a qualitative risk band. The strategy with the highest
// risk-adjusted ROI gets a "Best long-term pick" highlight.
//
// All money displayed in GBP via fmtGBP (which converts USD -> GBP internally).

// Grading economics — UK reality, June 2026
// -----------------------------------------
// PSA does NOT currently operate a UK drop-off. To grade from the UK you
// either ship direct to the US (slow + customs hassle on return) or use a
// domestic intermediary like Ludkins Collectables / GetGraded, who bulk-ship
// to PSA on your behalf. Either route the all-in cost lands around £40 per
// PSA UK pricing (June 2026) — Value tier removed, now two tiers by final graded value:
//   ≤ $1500 PSA 10 value : £65/card, 30–40 business days (~6–8 wk)
//   $1501–$2500           : £135/card, 20–30 business days (~4–6 wk)
// Submitted via UK intermediary (Ludkins / GetGraded) — fee is PSA charge only;
// intermediary handling + insured round-trip shipping adds ~£15–20 on top but
// is modest vs the tier fee so we include it in the tier figures as a buffer.
const UK_GRADING_FEE_STD_GBP    = 65;   // ≤ $1500 final value tier
const UK_GRADING_FEE_PREM_GBP   = 135;  // $1501–$2500 final value tier
const UK_PENNY_SLEEVE_GBP        = 0.03; // per-card submission material
const UK_TOPLOADER_GBP           = 0.25; // per-card submission material
const UK_GRADING_VALUE_THRESHOLD_USD = 1500;
const UK_GRADING_WAIT_STD_MONTHS  = 1.75;  // 30–40 business days ≈ 7 wk
const UK_GRADING_WAIT_PREM_MONTHS = 1.25;  // 20–30 business days ≈ 5 wk
// Legacy alias — use getUkGradingFeeGBP() / getUkGradingWaitMonths() where psa10USD is known
const UK_GRADING_ALL_IN_GBP  = UK_GRADING_FEE_STD_GBP;
const UK_GRADING_WAIT_MONTHS = UK_GRADING_WAIT_STD_MONTHS;
function getUkGradingFeeGBP(psa10USD) {
  return (psa10USD && psa10USD > UK_GRADING_VALUE_THRESHOLD_USD)
    ? UK_GRADING_FEE_PREM_GBP : UK_GRADING_FEE_STD_GBP;
}
function getUkGradingWaitMonths(psa10USD) {
  return (psa10USD && psa10USD > UK_GRADING_VALUE_THRESHOLD_USD)
    ? UK_GRADING_WAIT_PREM_MONTHS : UK_GRADING_WAIT_STD_MONTHS;
}
function getUkGradingWaitDisplay(psa10USD) {
  return (psa10USD && psa10USD > UK_GRADING_VALUE_THRESHOLD_USD) ? '4–6 wk' : '6–8 wk';
}

// ---- ACE Grading (UK service) ----
// Alternative to PSA. Fixed per-tier pricing (no value-tier threshold). Faster
// turnaround at every tier. Different mental model: ACE-graded cards do NOT
// currently command a resale premium over raw. Users choose ACE when the goal
// is to protect a personal-collection card and lock in its condition on record,
// not to unlock a graded-market uplift. Prices in GBP, wait in days.
const ACE_TIERS = {
  basic:    { label: 'Basic',    feeGBP: 18,  waitDays: 45, availability: 'Final Spaces' },
  standard: { label: 'Standard', feeGBP: 25,  waitDays: 25, availability: 'Limited' },
  premier:  { label: 'Premier',  feeGBP: 32,  waitDays: 10, availability: 'Good' },
  ultra:    { label: 'Ultra',    feeGBP: 60,  waitDays: 5,  availability: 'Limited' },
  luxury:   { label: 'Luxury',   feeGBP: 120, waitDays: 2,  availability: 'Final Spaces' },
};
const ACE_TIER_ORDER = ['basic', 'standard', 'premier', 'ultra', 'luxury'];
// Suggested tier by raw card value in GBP — keeps fee in a sensible proportion
// while respecting the reality that higher-value cards deserve faster turnaround.
function recommendAceTier(rawGBP) {
  if (!rawGBP || rawGBP < 40)  return 'basic';
  if (rawGBP < 150)  return 'standard';
  if (rawGBP < 400)  return 'premier';
  if (rawGBP < 1000) return 'ultra';
  return 'luxury';
}
function getAceFeeGBP(tier) {
  return (ACE_TIERS[tier] || ACE_TIERS.standard).feeGBP;
}
function getAceWaitDays(tier) {
  return (ACE_TIERS[tier] || ACE_TIERS.standard).waitDays;
}
function getAceWaitDisplay(tier) {
  const d = getAceWaitDays(tier);
  return d >= 30 ? `${Math.round(d/7)} wk` : `${d} days`;
}
function getAceWaitMonths(tier) {
  return getAceWaitDays(tier) / 30;
}

// ---- Grading service preference (global, per-user, synced) ----
// User picks between PSA (grade for resale premium) and ACE (slab for
// protection). Selection drives which cost/wait/EV model the Hold Strategy uses.
const GRADING_SERVICE_KEY = 'pkm-grading-service-v1';
const ACE_TIER_PREF_KEY   = 'pkm-ace-tier-v1';
function getGradingService() {
  const v = localStorage.getItem(GRADING_SERVICE_KEY);
  return v === 'ACE' ? 'ACE' : 'PSA';
}
function setGradingService(v) {
  const norm = v === 'ACE' ? 'ACE' : 'PSA';
  try { localStorage.setItem(GRADING_SERVICE_KEY, norm); } catch {}
}
function getAceTier() {
  const v = localStorage.getItem(ACE_TIER_PREF_KEY);
  return ACE_TIERS[v] ? v : 'standard';
}
function setAceTier(v) {
  const norm = ACE_TIERS[v] ? v : 'standard';
  try { localStorage.setItem(ACE_TIER_PREF_KEY, norm); } catch {}
}
// Service-aware grading fee/wait — used by Hold Strategy only. Other places
// (eBay Deal Check, PSA ROI, etc.) still call getUkGradingFeeGBP directly
// because they're inherently about PSA resale.
function getGradingFeeGBP(psa10USD, service, tier) {
  return service === 'ACE' ? getAceFeeGBP(tier) : getUkGradingFeeGBP(psa10USD);
}
function getGradingWaitMonths(psa10USD, service, tier) {
  return service === 'ACE' ? getAceWaitMonths(tier) : getUkGradingWaitMonths(psa10USD);
}
function getGradingWaitDisplay(psa10USD, service, tier) {
  return service === 'ACE' ? getAceWaitDisplay(tier) : getUkGradingWaitDisplay(psa10USD);
}

// ---- Grading service + ACE tier picker (Hold Strategy UI) ----
// Idempotent: wires listeners exactly once, then updates the visible state on
// every call so it reflects the current ACE tier pref + suggested tier for the card.
// The PSA/ACE toggle has been removed — both services are always shown.
let _holdSvcPickerReady = false;
function initHoldStrategyServicePicker(card) {
  const tierHost = $('aceTierBtns');
  const tierPanel = $('aceTierPicker');
  const tierHint = $('aceTierHint');
  if (!tierHost || !tierPanel) return;

  const currentTier = getAceTier();

  if (!_holdSvcPickerReady) {
    tierHost.innerHTML = ACE_TIER_ORDER.map(k => {
      const info = ACE_TIERS[k];
      return `<button class="ace-tier-btn" data-tier="${k}" role="radio" aria-checked="false" type="button"
        title="ACE ${info.label} \u2014 \u00a3${info.feeGBP}, ~${info.waitDays} day turnaround (${info.availability})">
        <span class="ace-tier-btn-name">${info.label}</span>
        <span class="ace-tier-btn-fee">\u00a3${info.feeGBP}</span>
        <span class="ace-tier-btn-wait">${info.waitDays}d</span>
      </button>`;
    }).join('');

    tierHost.querySelectorAll('.ace-tier-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tier;
        if (!ACE_TIERS[t]) return;
        if (getAceTier() === t) return;
        setAceTier(t);
        if (typeof syncSchedulePush === 'function') syncSchedulePush();
        if (typeof renderHoldStrategy === 'function' && selectedCard) {
          try { renderHoldStrategy(selectedCard); } catch {}
        }
      });
    });

    _holdSvcPickerReady = true;
  }

  // ACE tier picker is always visible.
  tierPanel.style.display = '';

  tierHost.querySelectorAll('.ace-tier-btn').forEach(btn => {
    const active = btn.dataset.tier === currentTier;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    btn.classList.remove('is-suggested');
  });

  if (tierHint) {
    let rawGBP = 0;
    if (card && typeof getCurrentPrice === 'function') {
      const rawUSD = getCurrentPrice(card);
      const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
      if (rawUSD > 0) rawGBP = rawUSD * fx;
    }
    if (rawGBP > 0) {
      const suggested = recommendAceTier(rawGBP);
      const suggBtn = tierHost.querySelector(`.ace-tier-btn[data-tier="${suggested}"]`);
      if (suggBtn) suggBtn.classList.add('is-suggested');
      const info = ACE_TIERS[suggested];
      tierHint.textContent = suggested === currentTier
        ? `Suggested for ${fmtGBPDirect(rawGBP)} card \u2713`
        : `Suggested for ${fmtGBPDirect(rawGBP)} card: ${info.label} (\u00a3${info.feeGBP})`;
    } else {
      tierHint.textContent = '';
    }
  }
}
// Submission materials cost (penny sleeve + toploader).
// For owned cards: deducts items already present per acquisition data.
// For non-owned cards (cardId null/undefined): assumes both are needed.
function getGradingMaterialsCostGBP(cardId) {
  const acq = (cardId && typeof getAcq === 'function') ? (getAcq(cardId) || {}) : {};
  return (acq.hasPennySleeve ? 0 : UK_PENNY_SLEEVE_GBP) + (acq.hasToploader ? 0 : UK_TOPLOADER_GBP);
}
// UK raw card shipping: mostly UK domestic sellers, £3–8 range, £5 midpoint.
const UK_RAW_SHIPPING_GBP = 5;
// UK slab shipping: PSA slabs are almost exclusively US/EU origin, so tracked
// international shipping is a real cost. ~20% of value for cheap slabs where
// shipping is proportionally large; flat tiered rates above that.
function estimateUkSlabShipping(slabValueGBP) {
  if (!slabValueGBP || slabValueGBP <= 0) return 0;
  if (slabValueGBP < 40)  return Math.max(8,  slabValueGBP * 0.20);
  if (slabValueGBP < 100) return 15;
  if (slabValueGBP < 250) return 18;
  if (slabValueGBP < 600) return 22;
  return 25;
}
const OPPORTUNITY_COST_ANNUAL = 0.06; // pre-tax return you could earn elsewhere while capital is locked
// eBay UK final value fee for Trading Cards (inc. managed payments).
const EBAY_FEE_UK = 0.129;
// Sell-side friction used by the hold strategy — eBay UK FVF since that's the
// primary exit venue. Previously 10%; updated to match actual eBay rate so
// 5yr exit values and ROI projections are realistic for eBay sellers.
const BUY_SELL_FRICTION = EBAY_FEE_UK;
const EBAY_FIXED_FEE = 0.30;        // £0.30 per-transaction eBay UK charge
// Expected premium of eBay listing prices over raw market (PriceCharting / CM).
// Sellers price up to recover the ~13% fee and earn a small margin — 15% is a
// conservative midpoint estimate based on observed UK single-card listings.
const EBAY_LISTING_PREMIUM = 0.15;
// Minimum 5-year hold ROI the user would accept on an eBay purchase. Drives the
// hold-strategy max buy price: anything above this returns a "don't pay" signal.
const MIN_HOLD_ROI = 0.30;

// When you grade a raw card and it ISN'T a PSA 10, the result is spread across
// PSA 7/8/9 (and a small tail at <=6 that effectively trades like raw). These
// conditional weights sum to 1 and are typical for modern English-language
// singles in collector-grade condition.
const SUBGEM_DISTRIBUTION = {
  9: 0.55,                            // PSA 9 — majority of non-gem outcomes
  8: 0.30,                            // PSA 8
  7: 0.10,                            // PSA 7
  rawLike: 0.05,                      // PSA ≤6 — effectively trades at raw value
};

// Default gem rate to assume when the card has no card.g data. Conservative
// 18% reflects the long-run PSA 10 hit rate for modern hand-picked cards.
const DEFAULT_GEM_RATE = 0.18;

// Buying raw online is sight-unseen — you can't check centering/whitening/surface
// the way you can in-hand at a shop or show. PSA 10 hit rates on online-bought
// raw modern English cards typically run ~50-65% of the hand-picked rate, so a
// 0.6 multiplier is a fair central estimate. This is applied to gemRate inside
// renderHoldStrategy so the EV math reflects the user's actual buying channel.
const ONLINE_BUY_GEM_PENALTY = 0.6;

// When grade comes back below PSA 10, two tactical options exist:
//   - Flip the slabbed card at current market for that grade (immediate liquidity)
//   - Crack it out of the slab, resubmit (another £40 + ~9mo wait), hope for an upgrade
// PSA grades are sticky on resub — the grader saw the flaw once and will likely
// see it again. These transition probabilities are conservative central estimates
// for modern English singles; upgrades are the exception, not the rule.
const CRACK_RESUB_TRANSITIONS = {
  // PSA 9 → 10 review rates published in collector data sit around 8-12% for
  // modern English singles. We use 10% — the grader already saw the flaw.
  9: { 10: 0.10, 9: 0.80, 8: 0.08, 7: 0.02, 6: 0.00 },
  // PSA 8 → 9+ resub upgrade is real but uncommon (~15%) and downgrades to
  // PSA 7 / surface damage occur. Stays-at-PSA-8 dominates.
  8: { 10: 0.02, 9: 0.13, 8: 0.70, 7: 0.10, 6: 0.05 },
  // PSA 7 is a hard floor — a 7 means PSA saw a clear flaw. Resub upgrades
  // to 8 happen but the modal outcome is still 7.
  7: { 10: 0.01, 9: 0.06, 8: 0.18, 7: 0.65, 6: 0.10 },
};
// Probability that cracking the slab damages the card (crease, whitening on a
// corner) such that the resub comes back materially worse than the model expects.
// Modelled as a flat % haircut on the crack EV — keeps the math readable.
// 8% reflects real-world handling risk on holo / textured modern cards.
const CRACK_DAMAGE_RISK = 0.08;

// -------------------------------------------------------------
// computeHoldCore — pure scoring helper for the Hold Strategy
// algorithm. Returns the same winner / best-raw / best-graded /
// overall risk-adjusted score that the full renderer computes,
// but without touching the DOM. Used to score the EN ↔ JP
// counterpart so we can put them side-by-side and recommend the
// smarter version of the same card.
// -------------------------------------------------------------
function computeHoldCore(card) {
  if (!card) return { ok: false };
  const anchor = getPsa10Anchor(card);
  const psa10Price = anchor && anchor.usd;
  const rawUSD = getCurrentPrice(card);
  if (!psa10Price || psa10Price <= 0 || !rawUSD || rawUSD <= 0) return { ok: false };

  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const gradingFeeUSD = getUkGradingFeeGBP(psa10Price) / fx;
  const gradingMaterialsUSD = getGradingMaterialsCostGBP(card?.i) / fx;
  const waitYears = getUkGradingWaitMonths(psa10Price) / 12;
  const waitDiscount = 1 / (1 + OPPORTUNITY_COST_ANNUAL * waitYears);
  const baseGemRate = (typeof card.g === 'number' && card.g > 0) ? card.g : DEFAULT_GEM_RATE;
  const gemRate = baseGemRate * ONLINE_BUY_GEM_PENALTY;

  // Strategy 1 — Buy Raw, hold ungraded
  const rawYr5USD = projectGradePrice(card, 9, rawUSD, 5) / GRADE_GROWTH_PREMIUM[9] * 1.0;
  const rawSell5USD = rawYr5USD * (1 - BUY_SELL_FRICTION);
  const rawShipUSD_hc = UK_RAW_SHIPPING_GBP / fx;
  const rawEntryUSD_hc = rawUSD + rawShipUSD_hc;
  const rawProfitUSD = rawSell5USD - rawEntryUSD_hc;
  const rawRoi = rawEntryUSD_hc > 0 ? (rawProfitUSD / rawEntryUSD_hc) * 100 : 0;

  // Strategy 2 — Buy Raw + Grade (EV across grade outcomes)
  const psa7Yr5  = projectGradePrice(card, 7,  estimateGradePrice(card, 7,  psa10Price), 5);
  const psa8Yr5  = projectGradePrice(card, 8,  estimateGradePrice(card, 8,  psa10Price), 5);
  const psa9Yr5  = projectGradePrice(card, 9,  estimateGradePrice(card, 9,  psa10Price), 5);
  const psa10Yr5 = projectGradePrice(card, 10, psa10Price, 5);
  const subgemEV =
      SUBGEM_DISTRIBUTION[9]      * psa9Yr5
    + SUBGEM_DISTRIBUTION[8]      * psa8Yr5
    + SUBGEM_DISTRIBUTION[7]      * psa7Yr5
    + SUBGEM_DISTRIBUTION.rawLike * rawYr5USD;
  const gradeYr5EV = (gemRate * psa10Yr5 + (1 - gemRate) * subgemEV) * waitDiscount;
  const gradeSell5EV = gradeYr5EV * (1 - BUY_SELL_FRICTION);
  const gradeCost = rawEntryUSD_hc + gradingFeeUSD + gradingMaterialsUSD;
  const gradeProfit = gradeSell5EV - gradeCost;
  const gradeRoi = gradeCost > 0 ? (gradeProfit / gradeCost) * 100 : 0;

  // Strategies 3-12 — Buy graded at each PSA tier (1–10)
  const gradedStrategies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(g => {
    const baseUSD = estimateGradePrice(card, g, psa10Price);
    const slabShipUSD = estimateUkSlabShipping(baseUSD * fx) / fx;
    const today = baseUSD + slabShipUSD;
    const yr5 = projectGradePrice(card, g, baseUSD, 5);
    const sell = yr5 * (1 - BUY_SELL_FRICTION);
    const profit = sell - today;
    const roi = today > 0 ? (profit / today) * 100 : 0;
    return { label: `Buy PSA ${g}`, key: `psa${g}`, grade: g, today, yr5: sell, profit, roi };
  });

  const strategies = [
    { label: 'Buy Raw',         key: 'raw',    today: rawEntryUSD_hc, yr5: rawSell5USD, profit: rawProfitUSD, roi: rawRoi,   variance: 0.20, risk: 'low' },
    { label: 'Buy Raw + Grade', key: 'gamble', today: gradeCost, yr5: gradeSell5EV, profit: gradeProfit, roi: gradeRoi, variance: 0.85, risk: 'high' },
    ...gradedStrategies.map(s => ({
      ...s,
      variance: s.grade === 10 ? 0.15 : s.grade === 9 ? 0.22 : s.grade === 8 ? 0.28 : s.grade === 7 ? 0.32 : s.grade === 6 ? 0.38 : s.grade === 5 ? 0.42 : s.grade === 4 ? 0.45 : s.grade === 3 ? 0.48 : s.grade === 2 ? 0.50 : 0.52,
      risk: s.grade === 10 ? 'low' : 'med',
    })),
  ];
  // Apply any user-entered eBay market overrides so the EN vs JP verdict
  // reflects the real-world price the user is seeing on listings.
  if (typeof applyHoldOverrides === 'function') applyHoldOverrides(card, strategies, fx, gradingFeeUSD);
  // Identical risk-adjustment formula to renderHoldStrategy so EN vs JP
  // verdict numbers line up exactly with the strategy grid.
  strategies.forEach(s => {
    const upsideGBP = Math.max(0, gbpFromUSD(s.profit));
    const upsideBonus = Math.min(15, upsideGBP / 50);
    s.riskAdjusted = s.roi - (s.variance * 100 * 0.35) + upsideBonus;
  });

  // Cheap-entry normalisation: when raw trades at < 18% of PSA10, the raw ROI%
  // is amplified by a tiny denominator (e.g. 300% on a £5 card = only £15 profit).
  // Blend in a normalised-return metric (absolute £ profit / PSA10 GBP value × 100)
  // so grading strategies that deliver substantially more actual money can win.
  // Guard: only activates when grade absolute profit > 2.5× raw AND > £25 floor.
  const rawGBP_hc   = rawUSD * fx;
  const psa10GBP_hc = psa10Price * fx;
  const underwaterAtEntry = (rawEntryUSD_hc + gradingFeeUSD) > psa10Price;
  if (rawGBP_hc > 0 && rawGBP_hc < psa10GBP_hc * 0.18) {
    const rawProfGBP_hc  = Math.max(0, rawProfitUSD * fx);
    const gradePlan_hc   = strategies.find(s => s.key === 'gamble');
    const gradeAbsGBP_hc = gradePlan_hc ? Math.max(0, gradePlan_hc.profit * fx) : 0;
    if (gradeAbsGBP_hc > rawProfGBP_hc * 2.5 && gradeAbsGBP_hc > 25) {
      const blendW = Math.min(0.75, 0.50 + (gradeAbsGBP_hc - rawProfGBP_hc * 2.5) / 200);
      strategies.forEach(s => {
        const normRet = Math.max(0, s.profit * fx) / psa10GBP_hc * 100;
        s.riskAdjusted = s.riskAdjusted * (1 - blendW) + normRet * blendW;
      });
    }
  }

  const positives = strategies.filter(s => !s.na && s.roi > 0);
  const winner = positives.length
    ? positives.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a)
    : null;
  const rawSide = strategies.filter(s => !s.na && (s.key === 'raw' || s.key === 'gamble') && s.roi > 0);
  const gradedSide = strategies.filter(s => !s.na && s.key.startsWith('psa') && s.roi > 0);
  const bestRaw = rawSide.length ? rawSide.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;
  const bestGraded = gradedSide.length ? gradedSide.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;

  // BEST LONG-TERM PICK: never high-risk (gamble), ROI must beat a basic
  // opportunity cost (≥35% over 5 yrs ≈ 6.2% annual — roughly savings/bond rate).
  // Threshold lowered from 80% to match recalibrated post-bubble growth rates.
  const ltpCandidates = strategies.filter(s => !s.na && s.key !== 'gamble' && s.roi >= 35);
  const bestLongTermPick = _pickBestLTP(ltpCandidates);

  // Capital outlay penalty: a £640 PSA 10 ties up real funds and carries a
  // funding/concentration risk that a £59 alternative doesn't. We only apply
  // this to the cross-card overallScore (EN ↔ JP smarter-buy verdict) — the
  // per-strategy riskAdjusted stays clean for the in-card strategy grid where
  // every option already targets the same card.
  const winnerOutlayGBP = winner ? gbpFromUSD(winner.today) : 0;
  const outlayPenalty = capitalOutlayPenalty(winnerOutlayGBP);

  return {
    ok: true,
    card,
    rawUSD,
    psa10USD: psa10Price,
    strategies,
    winner,
    bestLongTermPick,
    bestRaw,
    bestGraded,
    winnerOutlayGBP,
    outlayPenalty,
    overallScore: winner ? (winner.riskAdjusted - outlayPenalty) : -Infinity,
    anchorSource: anchor && anchor.source,
    gemRate,
    underwaterAtEntry,
  };
}

// Tiered capital-outlay penalty (in risk-adjusted-score points).
// Tying up large amounts of cash on a single card is a genuine funding risk
// for a collector building a wide collection — this lets the EN ↔ JP verdict
// prefer a £59 JP copy over a £640 EN copy when ROI is similar.
function capitalOutlayPenalty(outlayGBP) {
  if (!(outlayGBP > 0)) return 0;
  if (outlayGBP < 50)   return 0;
  if (outlayGBP < 100)  return 5;
  if (outlayGBP < 250)  return 15;
  if (outlayGBP < 500)  return 30;
  if (outlayGBP < 1000) return 50;
  return 70;
}

// Capital penalty used exclusively for BEST LONG-TERM PICK selection.
// Aggressive enough that a cheaper strong-hold option beats an expensive one
// when the ROI advantage doesn't justify the extra capital outlay.
// E.g. Raw at £418 (+398% ROI) beats PSA 10 at £1044 (+494% ROI) because
// spending an extra £626 for 96 more ROI points is poor capital efficiency.
function ltpCapitalPenalty(outlayGBP) {
  if (outlayGBP > getMaxBudgetGBP()) return 99999;
  if (!(outlayGBP > 0)) return 0;
  if (outlayGBP < 50)   return 0;
  if (outlayGBP < 100)  return 10;
  if (outlayGBP < 200)  return 30;
  if (outlayGBP < 350)  return 55;
  if (outlayGBP < 500)  return 85;
  if (outlayGBP < 800)  return 130;
  if (outlayGBP < 1200) return 200;
  if (outlayGBP < 2000) return 280;
  return 370;
}

// Read the user's max-spend-per-card budget (device-local pref, not synced).
const BUDGET_KEY = 'pkm-budget-max-gbp';
const BUDGET_DEFAULT = 99999; // true no-limit sentinel
function getMaxBudgetGBP() {
  const v = parseFloat(localStorage.getItem(BUDGET_KEY));
  return isFinite(v) && v > 0 ? v : BUDGET_DEFAULT;
}

// Pick the Best Long-Term Pick from a filtered candidate list.
// Priority: (1) in-budget over over-budget, (2) Low Risk over Med/High Risk,
// (3) within same risk tier: highest (riskAdjusted - ltpCapitalPenalty).
const _LTP_RISK_ORD = { low: 0, med: 1, high: 2 };
function _pickBestLTP(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => {
    const pa = ltpCapitalPenalty(gbpFromUSD(a.today));
    const pb = ltpCapitalPenalty(gbpFromUSD(b.today));
    const aOut = pa >= 99999, bOut = pb >= 99999;
    if (aOut !== bOut) return bOut ? a : b; // in-budget always beats over-budget
    const rA = _LTP_RISK_ORD[a.risk ?? 'med'] ?? 1;
    const rB = _LTP_RISK_ORD[b.risk ?? 'med'] ?? 1;
    if (rA !== rB) return rA < rB ? a : b;  // lower risk always wins within same budget tier
    return (b.riskAdjusted - pb) > (a.riskAdjusted - pa) ? b : a;
  });
}

// Render the EN ↔ JP side-by-side comparison inside the Hold Strategy card.
// Shows the winning strategy + key economics for each language and lets the
// algorithm pick the smarter version of the same card. No-op when there is
// no counterpart or one side has no usable price data.
function renderHoldCounterpartCompare(card) {
  const host = $('holdCounterpartCompare');
  if (!host) return;
  host.style.display = 'none';
  host.innerHTML = '';
  if (!card) return;

  const cp = findCounterparts(card);
  if (!cp || !cp.primary) return;

  const selfCore = computeHoldCore(card);
  const otherCore = computeHoldCore(cp.primary);
  // Need at least one priced side to be useful. If only the selected card has
  // data we just hide the panel — the strategy grid already covers it.
  if (!selfCore.ok && !otherCore.ok) return;

  const selfLang = card.lang === 'JP' ? 'JP' : 'EN';
  const otherLang = cp.counterpartLang;

  // Decide the winning side. Margin threshold mirrors the in-card verdict
  // (30 points = wide, < 30 = close call).
  let verdictPill = '';
  let verdictBody = '';
  if (selfCore.ok && otherCore.ok) {
    const margin = selfCore.overallScore - otherCore.overallScore;
    const winLang = margin > 0 ? selfLang : otherLang;
    const winCore = margin > 0 ? selfCore : otherCore;
    const loseLang = margin > 0 ? otherLang : selfLang;
    const loseCore = margin > 0 ? otherCore : selfCore;
    const absMargin = Math.abs(margin);
    // Capital outlay delta between the two winning plays — highlight when
    // the winner is also the cheaper upfront buy.
    const winOutlay = winCore.winnerOutlayGBP || 0;
    const loseOutlay = loseCore.winnerOutlayGBP || 0;
    const outlaySavingGBP = loseOutlay - winOutlay;
    const cheaperLine = outlaySavingGBP >= 25
      ? ` <strong>${winLang}</strong> also saves <strong>${fmtGBPDirect(outlaySavingGBP)}</strong> upfront vs ${loseLang} — less capital tied up per card.`
      : '';
    if (absMargin < 30) {
      verdictPill = 'Close call';
      verdictBody = `<strong>${selfLang} and ${otherLang}</strong> score within ${absMargin.toFixed(0)} points on risk-adjusted return after factoring upfront outlay. Pick the language you already have access to — the algorithm doesn't see a meaningful edge either way.${cheaperLine}`;
    } else {
      const winnerStrat = winCore.winner;
      verdictPill = `Buy ${winLang}`;
      verdictBody = `The <strong>${winLang}</strong> version is the smarter buy on this card — <strong>${winnerStrat.label}</strong> projects +${winnerStrat.roi.toFixed(0)}% ROI vs the ${loseLang} copy's best play. Risk-adjusted edge after capital outlay: +${absMargin.toFixed(0)} pts.${cheaperLine}`;
    }
  } else if (selfCore.ok) {
    verdictPill = `Buy ${selfLang}`;
    verdictBody = `Only the <strong>${selfLang}</strong> version has usable price data right now. The ${otherLang} counterpart needs live prices before the algorithm can score it head-to-head.`;
  } else {
    verdictPill = `Buy ${otherLang}`;
    verdictBody = `Only the <strong>${otherLang}</strong> counterpart has usable price data — the ${selfLang} side is missing either a raw price or a PSA 10 anchor.`;
  }

  // Render a column for each side. If a side has no data, we show a muted
  // placeholder column so the layout stays symmetrical.
  function renderCol(core, cardObj, lang, isSelected) {
    const langTag = lang === 'JP' ? 'Japanese' : 'English';
    const headBadge = `<span class="hold-cp-lang hold-cp-lang-${lang.toLowerCase()}">${langTag}</span>${isSelected ? '<span class="hold-cp-selected">Selected</span>' : '<span class="hold-cp-link" data-cp-id="' + cardObj.i + '">Switch →</span>'}`;
    const titleLine = `${cardObj.n}${cardObj.cn ? ' #' + cardObj.cn : ''}`;
    const setLine = cardObj.s ? `<div class="hold-cp-set">${cardObj.s}</div>` : '';
    if (!core.ok) {
      return `
        <div class="hold-cp-col hold-cp-col-empty">
          <div class="hold-cp-col-head">${headBadge}</div>
          <div class="hold-cp-col-title">${titleLine}</div>
          ${setLine}
          <div class="hold-cp-empty">No price data — needs a raw price and a PSA 10 anchor to score.</div>
        </div>
      `;
    }
    const w = core.winner;
    const scoreClass = core.overallScore >= 30 ? 'hold-cp-score-strong'
                     : core.overallScore >= 0  ? 'hold-cp-score-fair'
                     :                           'hold-cp-score-skip';
    return `
      <div class="hold-cp-col">
        <div class="hold-cp-col-head">${headBadge}</div>
        <div class="hold-cp-col-title">${titleLine}</div>
        ${setLine}
        ${w ? `
        <div class="hold-cp-win">
          <div class="hold-cp-win-label">Best play</div>
          <div class="hold-cp-win-name">${w.label}</div>
        </div>
        <div class="hold-cp-stats">
          <div class="hold-cp-stat"><span class="hold-cp-stat-k">Today</span><span class="hold-cp-stat-v">${fmtGBP(w.today)}</span></div>
          <div class="hold-cp-stat"><span class="hold-cp-stat-k">5yr target</span><span class="hold-cp-stat-v">${fmtGBP(w.yr5)}</span></div>
          <div class="hold-cp-stat"><span class="hold-cp-stat-k">Profit</span><span class="hold-cp-stat-v ${w.profit >= 0 ? 'hold-pos' : 'hold-neg'}">${w.profit >= 0 ? '+' : '−'}${fmtGBP(Math.abs(w.profit))}</span></div>
          <div class="hold-cp-stat"><span class="hold-cp-stat-k">ROI</span><span class="hold-cp-stat-v ${w.roi >= 0 ? 'hold-pos' : 'hold-neg'}">${w.roi >= 0 ? '+' : ''}${w.roi.toFixed(0)}%</span></div>
        </div>
        <div class="hold-cp-score ${scoreClass}">Risk-adjusted score · ${core.overallScore.toFixed(0)}${core.outlayPenalty > 0 ? `<span class="hold-cp-score-sub"> · Outlay −${core.outlayPenalty} pts</span>` : ''}</div>
        ` : `
        <div class="hold-cp-empty">No positive 5yr ROI projected on this side — skip it.</div>
        `}
      </div>
    `;
  }

  const winsSelf = selfCore.ok && (!otherCore.ok || selfCore.overallScore >= otherCore.overallScore);
  const winsOther = otherCore.ok && (!selfCore.ok || otherCore.overallScore > selfCore.overallScore);
  // Mark winning column with a class so CSS can tint it.
  const selfCol = renderCol(selfCore, card, selfLang, true);
  const otherCol = renderCol(otherCore, cp.primary, otherLang, false);

  host.style.display = 'block';
  host.innerHTML = `
    <div class="hold-cp-head">
      <span class="hold-cp-eyebrow">EN ↔ JP comparison</span>
      <span class="hold-cp-pill">${verdictPill}</span>
    </div>
    <div class="hold-cp-body">${verdictBody}</div>
    <div class="hold-cp-grid">
      <div class="${winsSelf ? 'hold-cp-winner' : ''}">${selfCol}</div>
      <div class="${winsOther ? 'hold-cp-winner' : ''}">${otherCol}</div>
    </div>
  `;

  // Wire the "Switch →" link on the counterpart column.
  host.querySelectorAll('[data-cp-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.getAttribute('data-cp-id');
      if (id && typeof selectCard === 'function') selectCard(id);
    });
  });
}

function renderHoldStrategy(card) {
  const section = $('holdStrategySection');
  if (!section || !card) return;
  const anchor = getPsa10Anchor(card);
  const psa10Price = anchor.usd;
  const rawUSD = getCurrentPrice(card);

  // Need both a raw and a PSA 10 anchor to do the comparison.
  if (!psa10Price || psa10Price <= 0 || !rawUSD || rawUSD <= 0) {
    section.style.display = 'none';
    const cpHost = $('holdCounterpartCompare');
    if (cpHost) { cpHost.style.display = 'none'; cpHost.innerHTML = ''; }
    return;
  }
  section.style.display = 'block';

  // Ensure the service picker (PSA/ACE) + ACE tier picker is initialised and
  // its UI state reflects the current localStorage prefs. Cheap to call every
  // render — it wires event listeners exactly once via a flag.
  if (typeof initHoldStrategyServicePicker === 'function') initHoldStrategyServicePicker(card);

  const titleEl = $('holdHeadingTitle');
  const descEl  = $('holdHeadingDesc');
  if (titleEl) {
    const badgeHtml = '<span class="anchor-badge" id="holdAnchorBadge" style="display:none" title="PSA 10 anchor estimated from raw market">EST. PSA 10</span>';
    titleEl.innerHTML = 'Hold Strategy \u00b7 All Options ' + badgeHtml;
  }
  if (descEl) {
    descEl.textContent = 'Which version of this card is the best 5-year hold? Compares raw hold, PSA grading, ACE slabbing, and buying already-graded PSA 1\u201310 \u2014 one recommendation across all options.';
  }

  // EN ↔ JP side-by-side: only rendered if the selected card has a
  // counterpart. Drawn above the strategy grid so the language verdict is
  // the first thing a collector sees after the headline recommendation.
  renderHoldCounterpartCompare(card);

  // Surface a small disclosure pill in the section header when the PSA 10
  // anchor was estimated (rarity-based) rather than tracked or live.
  const anchorBadge = $('holdAnchorBadge');
  if (anchorBadge) {
    if (anchor.source === 'estimated') {
      anchorBadge.style.display = 'inline-flex';
      anchorBadge.title = `PSA 10 anchor estimated as raw × ${anchor.multiplier || 2}. Accuracy ±30%.`;
      anchorBadge.textContent = 'EST. PSA 10';
    } else {
      anchorBadge.style.display = 'none';
    }
  }

  // Grading service pref — PSA (grade for resale premium) vs ACE (slab for
  // Both PSA and ACE are always computed and shown. The ACE tier picker
  // controls which ACE tier's tile appears. No service toggle needed.
  const tier = getAceTier();
  const aceInfo_r = ACE_TIERS[tier] || ACE_TIERS.standard;

  // Convert UK all-in grading cost back to USD for internal arithmetic so the
  // rest of the math (which works in USD) stays consistent. fxRate is GBP/USD
  // — so USD = GBP / fxRate.
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  // PSA (always computed)
  const gradingFeeGBP    = getUkGradingFeeGBP(psa10Price);
  const gradingWaitMonths = getUkGradingWaitMonths(psa10Price);
  const gradingWaitDisplay = getUkGradingWaitDisplay(psa10Price);
  const gradingFeeUSD    = gradingFeeGBP / fx;
  // ACE (always computed, for selected tier)
  const aceFeeGBP_r      = getAceFeeGBP(tier);
  const aceWaitMonths_r  = getAceWaitMonths(tier);
  const aceWaitDisplay_r = getAceWaitDisplay(tier);
  const aceFeeUSD_r      = aceFeeGBP_r / fx;
  const aceWaitDiscount_r = 1 / (1 + OPPORTUNITY_COST_ANNUAL * aceWaitMonths_r / 12);

  const gradingMaterialsGBP = getGradingMaterialsCostGBP(card.i);
  const gradingMaterialsUSD = gradingMaterialsGBP / fx;
  const waitYears = gradingWaitMonths / 12;
  // Opportunity-cost discount applied to the post-grade 5yr value: while the
  // card sits at PSA for a few weeks your capital is locked. We pretend that
  // money could have earned ~6% p.a. elsewhere and discount the eventual
  // value accordingly. Small but it matters for close calls.
  const waitDiscount = 1 / (1 + OPPORTUNITY_COST_ANNUAL * waitYears);
  const baseGemRate = (typeof card.g === 'number' && card.g > 0) ? card.g : DEFAULT_GEM_RATE;
  const gemRateSource = (typeof card.g === 'number' && card.g > 0) ? 'tracked' : 'estimated';
  // Apply the online sight-unseen penalty — default assumption is the user is
  // buying raw online (eBay/TCGplayer), not hand-picking from a binder.
  // If the user scanned their card and got an expected grade, remove the penalty
  // (they've inspected the card, so it's not sight-unseen).
  const acqForCard = getAcq(card.i);
  const expectedGrade = acqForCard?.expectedGrade ?? null;
  const ownedCard = portfolio.some(p => p.id === card.i);
  const gemRate = expectedGrade
    ? baseGemRate  // no sight-unseen penalty when card condition is known
    : baseGemRate * ONLINE_BUY_GEM_PENALTY;

  // Slab acquisition: cost basis applies to the specific PSA grade tile, not raw.
  const slabAcq = getAcqSlabInfo(card.i);
  // If acquisition cost is recorded (pack/single), use it as raw cost basis.
  // Slab acquisitions are handled per-grade in gradedStrategies, not here.
  const acqCostGBP = (!slabAcq) ? getAcqCostBasisGBP(card.i) : null;
  const acqCostUSD = (acqCostGBP && acqCostGBP > 0) ? acqCostGBP / fx : null;
  // rawCostUSD = what the user paid (or current market if no acquisition logged)
  const rawCostUSD = acqCostUSD ?? rawUSD;
  const usingAcqCost = acqCostUSD != null;
  // UK raw shipping: domestic sellers, £3-8 range; zero when already owned or using recorded acq cost.
  const rawShipGBP = (!ownedCard && !usingAcqCost) ? UK_RAW_SHIPPING_GBP : 0;
  const rawShipUSD = rawShipGBP / fx;
  const rawEntryUSD = rawCostUSD + rawShipUSD;

  // ----- Strategy 1: Buy Raw, hold ungraded -----
  const rawYr5USD = projectGradePrice(card, 9, rawUSD, 5) / GRADE_GROWTH_PREMIUM[9] * 1.0;
  // ^ Projections anchor to current market price, not acq cost. ROI uses acq cost.
  const rawSell5USD = rawYr5USD * (1 - BUY_SELL_FRICTION);
  const rawProfitUSD = rawSell5USD - rawEntryUSD;
  const rawRoi = rawEntryUSD > 0 ? (rawProfitUSD / rawEntryUSD) * 100 : 0;

  // ----- Strategy 2: Buy Raw + Grade (EV across grades) -----
  const psa7Yr5  = projectGradePrice(card, 7,  estimateGradePrice(card, 7,  psa10Price), 5);
  const psa8Yr5  = projectGradePrice(card, 8,  estimateGradePrice(card, 8,  psa10Price), 5);
  const psa9Yr5  = projectGradePrice(card, 9,  estimateGradePrice(card, 9,  psa10Price), 5);
  const psa10Yr5 = projectGradePrice(card, 10, psa10Price, 5);
  const subgemEV =
      SUBGEM_DISTRIBUTION[9]       * psa9Yr5
    + SUBGEM_DISTRIBUTION[8]       * psa8Yr5
    + SUBGEM_DISTRIBUTION[7]       * psa7Yr5
    + SUBGEM_DISTRIBUTION.rawLike  * rawYr5USD;
  // ACE 10 anchor: always fetched regardless of preferred service, so the
  // ACE tile is always data-driven when PriceCharting comps exist.
  const aceAnchor = getAce10Anchor(card);
  const ace10USD = aceAnchor.usd;
  const hasAceAnchor = ace10USD > 0;
  const ace10Yr5 = hasAceAnchor ? projectGradePrice(card, 10, ace10USD, 5) : 0;
  const aceVsPsaPct = (hasAceAnchor && psa10Price > 0) ? (ace10USD / psa10Price) * 100 : 0;
  const aceSubgemEV = rawYr5USD; // ACE 7/8/9 slabs trade near raw — no active subgem-ACE resale market
  const aceGradeYr5EV = hasAceAnchor
    ? gemRate * ace10Yr5 + (1 - gemRate) * aceSubgemEV
    : rawYr5USD;
  // PSA EV: gem-rate-weighted mix of PSA 10 and subgem outcomes.
  const gradeYr5EVRaw = gemRate * psa10Yr5 + (1 - gemRate) * subgemEV;
  const gradeYr5EV = gradeYr5EVRaw * waitDiscount;
  const gradeSell5EV = gradeYr5EV * (1 - BUY_SELL_FRICTION);
  // PSA cost/profit/roi
  const gradeCost = rawEntryUSD + gradingFeeUSD + gradingMaterialsUSD;
  const gradeProfit = gradeSell5EV - gradeCost;
  const gradeRoi = gradeCost > 0 ? (gradeProfit / gradeCost) * 100 : 0;
  // ACE cost/profit/roi (always computed for selected tier)
  const aceGradeYr5EV_final = aceGradeYr5EV * aceWaitDiscount_r;
  const aceSell5EV_r = aceGradeYr5EV_final * (1 - BUY_SELL_FRICTION);
  const aceCost_r   = rawEntryUSD + aceFeeUSD_r + gradingMaterialsUSD;
  const aceProfit_r = aceSell5EV_r - aceCost_r;
  const aceRoi_r    = aceCost_r > 0 ? (aceProfit_r / aceCost_r) * 100 : 0;

  // Per-outcome P&L for the gamble — used both to expose the loss case in the
  // tile and to render the "What you actually get" probability breakdown.
  const gradeOutcomes = [
    { label: 'PSA 10', grade: 10, prob: gemRate,                                yr5: psa10Yr5 },
    { label: 'PSA 9',  grade: 9,  prob: (1 - gemRate) * SUBGEM_DISTRIBUTION[9],  yr5: psa9Yr5  },
    { label: 'PSA 8',  grade: 8,  prob: (1 - gemRate) * SUBGEM_DISTRIBUTION[8],  yr5: psa8Yr5  },
    { label: 'PSA 7',  grade: 7,  prob: (1 - gemRate) * SUBGEM_DISTRIBUTION[7],  yr5: psa7Yr5  },
    { label: '\u2264PSA 6', grade: 6, prob: (1 - gemRate) * SUBGEM_DISTRIBUTION.rawLike, yr5: rawYr5USD },
  ];
  gradeOutcomes.forEach(o => {
    const sell = o.yr5 * waitDiscount * (1 - BUY_SELL_FRICTION);
    o.profitUSD = sell - gradeCost;
    o.roi = gradeCost > 0 ? (o.profitUSD / gradeCost) * 100 : 0;
  });
  // Cumulative probability of a loss-making outcome — "odds the gamble doesn't pay".
  const lossOutcomes = gradeOutcomes.filter(o => o.profitUSD < 0);
  const lossProb = lossOutcomes.reduce((s, o) => s + o.prob, 0);
  const lossEV = lossProb > 0
    ? lossOutcomes.reduce((s, o) => s + o.profitUSD * o.prob, 0) / lossProb
    : 0;
  // Cumulative probability of hitting PSA 9 OR 10 — the "good outcome" the user asked about.
  const goodOutcomeProb = gemRate + (1 - gemRate) * SUBGEM_DISTRIBUTION[9];

  // ----- Per-outcome Flip vs Crack tactical decision -----
  // For each non-PSA-10 outcome, compare:
  //   (a) Flip the slab now at current market for that grade, net of friction
  //   (b) Crack out + resubmit — EV across CRACK_RESUB_TRANSITIONS, less another
  //       grading fee, less crack-damage haircut, discounted for another wait.
  // We compare these at current prices (not 5yr) because this is a tactical
  // decision the user makes at the moment grades come back — not a 5yr hold.
  gradeOutcomes.forEach(o => {
    if (o.grade < 10 && o.grade >= 7) {
      const transitions = CRACK_RESUB_TRANSITIONS[o.grade];
      // Today's slabbed price for THIS grade — what flipping it would realise.
      const flipTodayUSD = estimateGradePrice(card, o.grade, psa10Price);
      const flipNetUSD = flipTodayUSD * (1 - BUY_SELL_FRICTION);
      // EV of cracking: sum P(newGrade) * todayPrice(newGrade)
      let crackGrossUSD = 0;
      Object.entries(transitions).forEach(([newGStr, p]) => {
        const newG = +newGStr;
        const priceUSD = newG <= 6
          ? rawUSD                                              // ≤PSA 6 trades like raw
          : estimateGradePrice(card, newG, psa10Price);
        crackGrossUSD += p * priceUSD;
      });
      // Net out: friction, another grading fee, crack-damage haircut, wait discount.
      const crackNetUSD =
        (crackGrossUSD * (1 - BUY_SELL_FRICTION) - gradingFeeUSD - CRACK_DAMAGE_RISK * flipTodayUSD)
        * waitDiscount;
      o.flipNetUSD = flipNetUSD;
      o.crackNetUSD = crackNetUSD;
      // Require crack EV to beat flip by at least 5% to overcome risk preference
      // (cracking is a real, irreversible action with execution risk).
      o.nextMove = crackNetUSD > flipNetUSD * 1.05 ? 'crack' : 'flip';
      o.nextMoveEdgeUSD = Math.abs(crackNetUSD - flipNetUSD);
      // Upside if crack pays off (P(≥10) at resub) — useful for messaging.
      o.crackUpgradeProb = (transitions[10] || 0) + (o.grade < 9 ? (transitions[9] || 0) : 0);
    }
  });

  // ----- Strategies 3-6: Buy (or Keep) graded at each PSA tier -----
  // Always computed — PSA 1–10 tiles appear alongside ACE and raw.
  const gradedStrategies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(g => {
    const isOwnedSlab = slabAcq && slabAcq.grade === g;
    const baseUSD = estimateGradePrice(card, g, psa10Price);
    const slabShipGBP = isOwnedSlab ? 0 : estimateUkSlabShipping(baseUSD * fx);
    // For owned slabs: cost basis is what was paid; projections still anchor to current market.
    const today = isOwnedSlab ? slabAcq.costGBP / fx : baseUSD + slabShipGBP / fx;
    const yr5 = projectGradePrice(card, g, baseUSD, 5);
    const sell = yr5 * (1 - BUY_SELL_FRICTION);
    const profit = sell - today;
    const roi = today > 0 ? (profit / today) * 100 : 0;
    const label = isOwnedSlab ? `Keep PSA ${g}` : `Buy PSA ${g}`;
    const slabMarketGBP = isOwnedSlab ? usdToGbp(baseUSD) : null;
    const slabGainGBP = isOwnedSlab ? (slabMarketGBP - slabAcq.costGBP) : null;
    return { label, key: `psa${g}`, grade: g, today, slabShipGBP, yr5, profit, roi, isOwnedSlab, slabMarketGBP, slabGainGBP };
  });

  // Labels and descs for each strategy tile
  const rawDesc = usingAcqCost
    ? `Cost basis: ${fmtGBPDirect(acqCostGBP)} paid \u2014 holding ungraded 5 yrs`
    : rawShipGBP > 0
      ? `Hold ungraded for 5 yrs \u2014 incl. ~\u00a3${rawShipGBP} UK shipping`
      : 'Hold ungraded for 5 yrs';
  const _gemPct = (gemRate * 100).toFixed(0);
  const _gemNote = gemRate < 0.12
    ? `low gem rate (${_gemPct}%) \u2014 buying pre-graded likely better`
    : gemRate < 0.22
    ? `${_gemPct}% gem rate \u2014 most copies grade PSA 7\u20139`
    : `${(goodOutcomeProb*100).toFixed(0)}% chance PSA 9 or 10`;
  const gambleDesc = usingAcqCost
    ? `Cost basis: ${fmtGBPDirect(acqCostGBP)} + \u00a3${gradingFeeGBP} PSA grading \u2014 ${_gemNote}`
    : `EV across PSA outcomes \u2014 ${_gemNote}`;
  const gambleLabel = usingAcqCost ? 'Grade My Card (PSA)' : 'Buy Raw + Grade (PSA)';

  const aceDesc_r = usingAcqCost
    ? `Cost basis: ${fmtGBPDirect(acqCostGBP)} + \u00a3${aceFeeGBP_r} ACE ${aceInfo_r.label} \u2014 ${hasAceAnchor ? 'ACE 10 comp tracked' : 'protection, no resale uplift'}`
    : `ACE ${aceInfo_r.label} slab (\u00a3${aceFeeGBP_r}, ~${aceWaitDisplay_r}) \u2014 ${hasAceAnchor ? `ACE 10 comp: ${fmtGBPDirect(ace10USD * fx)}` : 'protection, no resale uplift'}`;
  const aceLabel_r  = usingAcqCost ? `Slab My Card (ACE ${aceInfo_r.label})` : `Buy Raw + Slab (ACE ${aceInfo_r.label})`;
  const aceRisk_r   = hasAceAnchor ? 'med' : 'low';
  const aceVariance_r = hasAceAnchor ? 0.45 : 0.20;

  const strategies = [
    { label: ownedCard ? 'Keep Raw' : 'Buy Raw', key: 'raw',    desc: rawDesc,    today: rawEntryUSD, yr5: rawSell5USD,  profit: rawProfitUSD, roi: rawRoi,    risk: 'low',      variance: 0.20,       acqCost: usingAcqCost },
    { label: gambleLabel,  key: 'gamble', desc: gambleDesc, today: gradeCost,  yr5: gradeSell5EV, profit: gradeProfit, roi: gradeRoi, risk: 'high', variance: 0.85, waitMonths: gradingWaitMonths, waitDisplay: gradingWaitDisplay, lossProb, lossEV, acqCost: usingAcqCost },
    { label: aceLabel_r,   key: 'ace',    desc: aceDesc_r,  today: aceCost_r,  yr5: aceSell5EV_r, profit: aceProfit_r, roi: aceRoi_r, risk: aceRisk_r, variance: aceVariance_r, waitMonths: aceWaitMonths_r, waitDisplay: aceWaitDisplay_r, lossProb: 0, lossEV: 0, acqCost: usingAcqCost, aceMode: true },
    ...gradedStrategies.map(s => ({
      ...s,
      desc: s.grade === 10 ? 'Gem mint — best ceiling'
          : s.grade === 9  ? 'Near-mint graded copy'
          : s.grade === 8  ? 'Mid-grade graded copy'
          : s.grade === 7  ? 'Graded floor entry'
          : s.grade === 6  ? 'Light play — visible wear'
          : s.grade === 5  ? 'Played condition'
          : s.grade === 4  ? 'Heavily played'
          : 'Poor — completion only',
      risk: s.grade === 10 ? 'low' : 'med',
      variance: s.grade === 10 ? 0.15 : s.grade === 9 ? 0.22 : s.grade === 8 ? 0.28 : s.grade === 7 ? 0.32 : s.grade === 6 ? 0.38 : s.grade === 5 ? 0.42 : s.grade === 4 ? 0.45 : s.grade === 3 ? 0.48 : s.grade === 2 ? 0.50 : 0.52,
    })),
  ];

  // Apply any user-entered eBay market overrides. We override the "today" buy
  // price for the matching strategy row(s) but leave 5yr targets on the model's
  // projection — that way ROI honestly reflects "I paid £X, here's what the
  // model says it'll be worth."
  if (typeof applyHoldOverrides === 'function') applyHoldOverrides(card, strategies, fx, gradingFeeUSD);

  // When an acquisition cost is recorded but no manual override is set, surface
  // the live/current market price as "Market now" on the raw tile so the user
  // can see how much the card has grown since purchase — same display as the
  // manual-override path, but driven by the live price feed automatically.
  if (usingAcqCost && rawUSD > 0 && acqCostUSD != null) {
    const _rawStrat = strategies.find(s => s.key === 'raw');
    if (_rawStrat && _rawStrat.marketNowGBP == null) {
      const _mktGBP  = rawUSD * fx;
      const _paidGBP = acqCostUSD * fx;
      if (_mktGBP > 0 && Math.abs(_mktGBP - _paidGBP) > 0.01) {
        _rawStrat.marketNowGBP    = _mktGBP;
        _rawStrat.currentGrowthGBP = _mktGBP - _paidGBP;
        _rawStrat.currentGrowthPct = _paidGBP > 0 ? (_mktGBP - _paidGBP) / _paidGBP * 100 : 0;
      }
    }
  }

  // Refresh the override editor panel so the placeholders show current fair
  // values and the inputs reflect any persisted overrides for this card.
  if (typeof renderHoldOverridePanel === 'function') renderHoldOverridePanel(card);

  // Risk-adjusted score: ROI minus a variance discount, then a small bonus
  // for absolute upside so a £500 profit beats a £50 profit at the same ROI.
  // This is how we pick the "long-term winner" — it punishes the high-variance
  // "raw + grade" gamble unless it has a meaningfully higher ROI.
  strategies.forEach(s => {
    const upsideGBP = Math.max(0, gbpFromUSD(s.profit));
    const upsideBonus = Math.min(15, upsideGBP / 50); // up to +15 for big absolute profit
    s.riskAdjusted = s.roi - (s.variance * 100 * 0.35) + upsideBonus;
  });

  // Cheap-entry normalisation: mirrors the same logic in computeHoldCore.
  // When raw trades at < 18% of PSA10, % ROI is dominated by a tiny denominator
  // (300% on a £5 card = only £15 profit). Blend in normalised-return scoring
  // so grading can win when it delivers far more actual money.
  const rawMktGBP   = rawUSD * fx;
  const psa10GBP_h  = psa10Price * fx;
  const gradeCostGBP_h   = rawEntryUSD * fx + gradingFeeGBP;
  const underwaterAtEntry = gradeCostGBP_h > psa10GBP_h;
  const underwaterGBP     = Math.max(0, gradeCostGBP_h - psa10GBP_h);
  if (rawMktGBP > 0 && rawMktGBP < psa10GBP_h * 0.18) {
    const rawProfGBP_h  = Math.max(0, rawProfitUSD * fx);
    const gradePlan_h   = strategies.find(s => s.key === 'gamble');
    const gradeAbsGBP_h = gradePlan_h ? Math.max(0, gradePlan_h.profit * fx) : 0;
    if (gradeAbsGBP_h > rawProfGBP_h * 2.5 && gradeAbsGBP_h > 25) {
      const blendW_h = Math.min(0.75, 0.50 + (gradeAbsGBP_h - rawProfGBP_h * 2.5) / 200);
      strategies.forEach(s => {
        const normRet = Math.max(0, s.profit * fx) / psa10GBP_h * 100;
        s.riskAdjusted = s.riskAdjusted * (1 - blendW_h) + normRet * blendW_h;
      });
    }
  }

  // Pick winners. Two separate questions per the user's ask:
  //   1. Raw vs Graded — which broad approach wins? Compare best raw-side
  //      option (Raw, Raw+Grade) vs best already-graded option (PSA 7-10).
  //   2. Which graded tier (PSA 7/8/9/10) is the best long-term hold?
  const positives = strategies.filter(s => !s.na && s.roi > 0);
  const overallWinner = positives.length
    ? positives.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a)
    : null;

  const rawSide = strategies.filter(s => !s.na && (s.key === 'raw' || s.key === 'gamble' || s.key === 'ace') && s.roi > 0);
  const gradedSide = strategies.filter(s => !s.na && s.key.startsWith('psa') && s.roi > 0);
  const allGradedSide = strategies.filter(s => !s.na && s.key.startsWith('psa'));
  const bestRaw = rawSide.length ? rawSide.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;
  // Always pick a slab recommendation — fall back to best by riskAdjusted even if ROI is negative
  const _bgPool = gradedSide.length ? gradedSide : allGradedSide;
  const bestGraded = _bgPool.length ? _bgPool.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;

  // BEST LONG-TERM PICK badge: never high-risk (gamble), ROI must beat opportunity
  // cost (≥35% over 5 yrs ≈ 6.2% annual). Threshold recalibrated for post-bubble rates.
  const ltpCandidates = strategies.filter(s => !s.na && s.key !== 'gamble' && s.roi >= 35);
  const bestLongTermPick = _pickBestLTP(ltpCandidates);

  const winner = overallWinner; // used for recommendation copy below
  // Store winner key so updateSignal can stay in sync regardless of call order.
  // 'none' = Hold Strategy ran but no strategy qualifies as BEST LONG-TERM PICK.
  // null   = Hold Strategy hasn't run yet for this card.
  _holdWinnerKey = bestLongTermPick ? bestLongTermPick.key : 'none';
  if (bestLongTermPick) {
    const _wProfGBP = bestLongTermPick.profit * fx;
    const _wROI = Math.round(bestLongTermPick.roi);
    if (bestLongTermPick.key === 'raw') {
      _holdWinnerDesc = `Hold raw · ${_wROI}% projected ROI · ${fmtGBPDirect(_wProfGBP)} profit over 5 yrs`;
    } else if (bestLongTermPick.key === 'ace') {
      _holdWinnerDesc = `Slab with ACE ${aceInfo_r.label} · ${_wROI}% projected ROI · ${fmtGBPDirect(_wProfGBP)} profit over 5 yrs`;
    } else {
      _holdWinnerDesc = `Buy ${bestLongTermPick.key.replace('psa', 'PSA ')} slab · ${_wROI}% projected ROI · ${fmtGBPDirect(_wProfGBP)} profit over 5 yrs`;
    }
  } else {
    _holdWinnerDesc = '';
  }

  // Unified "Smart move" recommendation across all strategies (PSA + ACE + raw + graded).
  const recEl = $('holdRecommendation');
  const psaStrat  = strategies.find(s => s.key === 'gamble');
  const aceStrat  = strategies.find(s => s.key === 'ace');
  const rawStrat  = strategies.find(s => s.key === 'raw');

  if (!winner) {
    recEl.innerHTML = `
      <div class="hold-rec-pill hold-rec-skip">Skip this card</div>
      <div class="hold-rec-body">
        No version of this card projects positive 5-year ROI after buy/sell friction and grading fees.
        Park your capital somewhere with a better expected return.
      </div>
    `;
  } else {
    // PSA grading friction warning (used in verdict line when PSA grade is smart move)
    let gambleCaveat = '';
    if (bestRaw && bestRaw.key === 'gamble') {
      if (lossProb > 0.01) {
        gambleCaveat = ` — ${(lossProb*100).toFixed(0)}% loss case (avg −${fmtGBP(Math.abs(gbpFromUSD(lossEV)))}) · ~${gradingWaitDisplay} UK wait with capital locked.`;
      } else {
        gambleCaveat = ` — ~${gradingWaitDisplay} UK wait with capital locked (every PSA outcome turns a profit on this card).`;
      }
      if (underwaterAtEntry) {
        const psa10Proj5GBP = psa10Yr5 * (1 - BUY_SELL_FRICTION) * fx;
        gambleCaveat += ` PSA 10 today (${fmtGBPDirect(psa10GBP_h)}) is £${underwaterGBP.toFixed(0)} below all-in cost — grading recommended on 5yr projection (${fmtGBPDirect(psa10Proj5GBP)}), not current slab pricing.`;
      }
    }

    // Smart move primary verdict line
    let verdictLine;
    if (expectedGrade && expectedGrade < 9) {
      const gradeLbl = PSA_GRADE_LABELS?.[expectedGrade] || '';
      verdictLine = bestGraded
        ? `Scan expects <strong>PSA ${expectedGrade} (${gradeLbl})</strong>. See card-scan advice below. Best PSA tier to buy slabbed: <strong>${bestGraded.label}</strong>.`
        : `Scan expects <strong>PSA ${expectedGrade} (${gradeLbl})</strong>. See card-scan advice below.`;
    } else {
      const sm = overallWinner;
      if (sm.key === 'raw') {
        const verb = ownedCard ? 'Hold raw' : 'Buy and hold raw';
        verdictLine = `<strong>${verb}</strong> — ${fmtGBP(sm.today)} in → ${fmtGBP(sm.yr5)} in 5yrs (+${sm.roi.toFixed(0)}% ROI, low risk). Grading fees don’t justify the uplift at current prices.`;
      } else if (sm.key === 'gamble') {
        verdictLine = `<strong>${ownedCard ? 'Grade with PSA' : 'Buy raw + grade (PSA)'}</strong> — EV ${fmtGBP(sm.today)} in → ${fmtGBP(sm.yr5)} in 5yrs (+${sm.roi.toFixed(0)}% ROI)${gambleCaveat}`;
      } else if (sm.key === 'ace') {
        const aceRoiDelta = rawStrat ? aceStrat.roi - rawStrat.roi : 0;
        const aceNote = hasAceAnchor
          ? ` Live ACE 10 comp: ${fmtGBP(ace10USD)}${aceVsPsaPct > 0 ? ` (${aceVsPsaPct.toFixed(0)}% of PSA 10)` : ''} — beats raw by ${aceRoiDelta.toFixed(0)} ROI pts.`
          : ` No ACE 10 comp — fee is ${(aceFeeGBP_r / (rawUSD * fx) * 100).toFixed(0)}% of card value, protection play.`;
        verdictLine = `<strong>${ownedCard ? `Slab with ACE ${aceInfo_r.label}` : `Buy raw + slab (ACE ${aceInfo_r.label})`}</strong> — ${fmtGBP(sm.today)} in → ${fmtGBP(sm.yr5)} in 5yrs (+${sm.roi.toFixed(0)}% ROI, ~${aceWaitDisplay_r} turnaround).${aceNote}`;
      } else {
        const g = sm.key.replace('psa', 'PSA ');
        const verb = ownedCard ? sm.label : `Buy ${g} slab`;
        verdictLine = `<strong>${verb}</strong> — ${fmtGBP(sm.today)} in → ${fmtGBP(sm.yr5)} in 5yrs (+${sm.roi.toFixed(0)}% ROI, ${sm.risk}-risk). Skip the grading queue.`;
      }
    }

    // ACE vs PSA grading comparison (always shown to make the trade-off explicit)
    let gradingCompLine = '';
    if (psaStrat && aceStrat) {
      const psaR = psaStrat.roi, aceR = aceStrat.roi;
      const diff = Math.abs(psaR - aceR);
      if (diff < 5) {
        gradingCompLine = `PSA grade (+${psaR.toFixed(0)}%, £${gradingFeeGBP}, ~${gradingWaitDisplay}) and ACE ${aceInfo_r.label} slab (+${aceR.toFixed(0)}%, £${aceFeeGBP_r}, ~${aceWaitDisplay_r}) are within ${diff.toFixed(0)} ROI pts — ACE is faster, PSA has deeper resale liquidity.`;
      } else if (psaR > aceR) {
        gradingCompLine = `If grading: <strong>PSA</strong> (+${psaR.toFixed(0)}% ROI, £${gradingFeeGBP}, ~${gradingWaitDisplay}) outperforms ACE ${aceInfo_r.label} (+${aceR.toFixed(0)}%) by ${diff.toFixed(0)} pts — deeper PSA resale market justifies the wait.`;
      } else {
        gradingCompLine = `If grading: <strong>ACE ${aceInfo_r.label}</strong> (+${aceR.toFixed(0)}% ROI, £${aceFeeGBP_r}, ~${aceWaitDisplay_r}) beats PSA (+${psaR.toFixed(0)}%) by ${diff.toFixed(0)} pts${hasAceAnchor ? ' — live ACE 10 comp tracked' : ' — lower fee advantage'}.`;
      }
    }

    // Best PSA tier to buy pre-graded — always shown, even if ROI is below threshold
    const _bgRoiNote = bestGraded && bestGraded.roi < 0
      ? `${bestGraded.roi.toFixed(0)}% ROI — not profitable at current prices`
      : bestGraded ? `+${bestGraded.roi.toFixed(0)}% ROI, ${bestGraded.risk === 'low' ? 'low' : 'medium'} risk` : '';
    const gradedLine = bestGraded
      ? `Best PSA slab to buy: <strong>PSA ${bestGraded.grade}</strong> · ${fmtGBP(bestGraded.today)} → ${fmtGBP(bestGraded.yr5)} in 5yrs (${_bgRoiNote}).`
      : `No PSA graded data available for this card.`;

    // Card scan advice specific to this copy's condition
    let scanLine = '';
    if (expectedGrade) {
      const gradeLbl = PSA_GRADE_LABELS?.[expectedGrade] || '';
      const hasCard = acqForCard != null;
      const gradeStrat = strategies.find(s => s.key === 'gamble');
      const gradeClearsFee = gradeStrat && gradeStrat.roi > 0;
      const gradeBeatsGraded = gradeStrat && bestGraded && gradeStrat.yr5 >= bestGraded.yr5;
      let action = '';
      if (expectedGrade >= 9) {
        action = hasCard
          ? `Your scan predicts <strong>PSA ${expectedGrade} (${gradeLbl})</strong> — grade it. At that level the fee is comfortably earned back.`
          : `Buying raw is viable here: a <strong>PSA ${expectedGrade}</strong> result is realistic and the grading fee is justified. <em>Buy Raw + Grade</em> is the play.`;
      } else if (expectedGrade === 8) {
        if (gradeClearsFee && gradeBeatsGraded) {
          action = hasCard
            ? `Expected <strong>PSA 8 (${gradeLbl})</strong> still clears the grading fee on this card — worth submitting.`
            : `Expected <strong>PSA 8</strong> makes grading worthwhile here. Buy raw and grade rather than hunting an already-graded copy.`;
        } else {
          const altGrade = bestGraded ? `PSA ${bestGraded.grade}` : 'PSA 8';
          action = hasCard
            ? `At expected <strong>PSA 8 (${gradeLbl})</strong>, buying an already-graded copy edges out submitting this one after fees. Consider selling raw and buying a <strong>${altGrade}</strong> instead.`
            : `At expected <strong>PSA 8</strong>, an already-graded copy is the cleaner entry — grading fees eat too much of the upside. Look for a <strong>${altGrade}</strong>.`;
        }
      } else if (expectedGrade === 7) {
        action = hasCard
          ? `Expected <strong>PSA 7 (${gradeLbl})</strong> won’t clear grading fees. Hold raw long-term, or find a sharper copy to submit instead.`
          : `This copy grades at <strong>PSA 7</strong> — not enough margin after fees. Either buy raw and hold, or find a cleaner copy.`;
      } else {
        const altGrade = bestGraded ? `PSA ${bestGraded.grade}` : 'a graded copy';
        action = hasCard
          ? `At expected <strong>PSA ${expectedGrade} (${gradeLbl})</strong> this copy is too worn to grade economically. Hold raw or replace it with a better copy before submitting.`
          : `This copy grades at <strong>PSA ${expectedGrade}</strong> — too worn to recover grading costs. Pass on it, or buy <strong>${altGrade}</strong> directly.`;
      }
      scanLine = `<div class="hold-rec-line hold-rec-scan">${action}</div>`;
    }
    const _rawStrat = strategies.find(s => s.key === 'raw');
    const _mktNow = _rawStrat?.marketNowGBP ?? null;
    const _growthNote = (_mktNow && acqCostGBP)
      ? ` · market now ${fmtGBPDirect(_mktNow)} (${(_rawStrat.currentGrowthPct >= 0 ? '+' : '') + _rawStrat.currentGrowthPct.toFixed(0)}% already gained)`
      : '';
    const acqLine = usingAcqCost
      ? `<div class="hold-rec-line hold-rec-acq">ROI based on your actual cost (${fmtGBPDirect(acqCostGBP)})${_growthNote}.</div>`
      : '';

    recEl.innerHTML = `
      <div class="hold-rec-pill">Smart move</div>
      <div class="hold-rec-body">
        <div class="hold-rec-line">${verdictLine}</div>
        ${gradingCompLine ? `<div class="hold-rec-line hold-rec-line-sub">${gradingCompLine}</div>` : ''}
        <div class="hold-rec-line hold-rec-line-sub">${gradedLine}</div>
        ${scanLine}${acqLine}
      </div>
    `;
  }
  // Render the comparison grid.
  const grid = $('holdGrid');
  const _maxBudgetGBP = getMaxBudgetGBP();
  // Collapse PSA grades below the recommended grade to keep the grid clean.
  // If bestLongTermPick is PSA N, hide PSA 1…N-1. Otherwise hide PSA 1–6 (show 7–10).
  const _ltpGradeNum = (bestLongTermPick && bestLongTermPick.key.startsWith('psa'))
    ? parseInt(bestLongTermPick.key.replace('psa', ''))
    : 7;
  const _hiddenGradeNums = new Set([1, 2, 3, 4, 5, 6].filter(g => g < _ltpGradeNum));

  grid.innerHTML = strategies.filter(s => !s.na).map(s => {
    const todayGBP_tile = s.today * fx;
    const isOverBudget = _maxBudgetGBP < BUDGET_DEFAULT && todayGBP_tile > _maxBudgetGBP;
    const isWinner = bestLongTermPick && s.key === bestLongTermPick.key && !isOverBudget;
    const gradeNum = s.key.startsWith('psa') ? parseInt(s.key.replace('psa', '')) : null;
    const isCollapsed = gradeNum !== null && _hiddenGradeNums.has(gradeNum);
    const verdict = s.roi >= 80 ? { c: 'hold-v-strong', t: 'Strong hold' }
                  : s.roi >= 40 ? { c: 'hold-v-good',   t: 'Worth holding' }
                  : s.roi >= 15 ? { c: 'hold-v-fair',   t: 'Fair' }
                  : s.roi >= 0  ? { c: 'hold-v-flat',   t: 'Flat' }
                  :               { c: 'hold-v-skip',   t: 'Skip' };
    const riskLabel = s.risk === 'low' ? 'Low risk' : s.risk === 'med' ? 'Medium risk' : 'High risk';
    const profitSign = s.profit >= 0 ? '+' : '−';
    return `
      <div class="hold-tile ${isWinner ? 'hold-winner' : ''} ${isOverBudget ? 'hold-tile-over-budget' : ''} ${verdict.c} ${s.overridden ? 'hold-tile-overridden' : ''} ${isCollapsed ? 'hold-tile-collapsed' : ''}"${isCollapsed ? ' style="display:none"' : ''}>
        ${isOverBudget ? '<div class="hold-over-budget-tag">Above budget</div>' : (isWinner ? '<div class="hold-winner-tag">\u2605 Best long-term pick</div>' : '')}
        ${s.overridden ? `<div class="hold-tile-override-tag" title="${s.marketOverrideGBP != null ? 'Current market price — ROI uses your acquisition cost' : 'Using your manual market price'}">${s.marketOverrideGBP != null ? 'Mkt' : 'Override'} £${(+s.overrideGBP).toFixed(2)}</div>` : ''}
        <div class="hold-tile-head">
          <div class="hold-tile-title">${s.label}</div>
          <div class="hold-tile-desc">${s.desc}</div>
        </div>
        <div class="hold-tile-row">
          <span class="hold-tile-k">${(s.isOwnedSlab || s.marketNowGBP != null) ? 'Your cost (paid)' : `Today${s.overridden ? ' <span class="hold-tile-ov">(override)</span>' : ''}`}</span>
          <span class="hold-tile-v">${fmtGBP(s.today)}</span>
        </div>
        ${s.marketNowGBP != null ? `
        <div class="hold-tile-row hold-tile-sub">
          <span class="hold-tile-k">· Market now</span>
          <span class="hold-tile-v">${fmtGBPDirect(s.marketNowGBP)} <span class="${s.currentGrowthGBP >= 0 ? 'hold-pos' : 'hold-neg'}" style="font-size:10px">${s.currentGrowthPct >= 0 ? '+' : ''}${s.currentGrowthPct.toFixed(0)}% already</span></span>
        </div>` : ''}
        ${s.isOwnedSlab && s.slabMarketGBP != null ? `
        <div class="hold-tile-row hold-tile-sub">
          <span class="hold-tile-k">· Market now</span>
          <span class="hold-tile-v">${fmtGBPDirect(s.slabMarketGBP)} <span class="${s.slabGainGBP >= 0 ? 'hold-pos' : 'hold-neg'}" style="font-size:10px">${s.slabGainGBP >= 0 ? '+' : ''}${fmtGBPDirect(Math.abs(s.slabGainGBP))}</span></span>
        </div>` : ''}
        ${s.slabShipGBP > 0 ? `
        <div class="hold-tile-row hold-tile-sub">
          <span class="hold-tile-k">· Card price</span>
          <span class="hold-tile-v">${fmtGBP(s.today - s.slabShipGBP / fx)}</span>
        </div>
        <div class="hold-tile-row hold-tile-sub">
          <span class="hold-tile-k">· Est. UK shipping</span>
          <span class="hold-tile-v">+£${Math.abs(s.slabShipGBP).toFixed(0)}</span>
        </div>` : ''}
        <div class="hold-tile-row">
          <span class="hold-tile-k">5yr target</span>
          <span class="hold-tile-v hold-tile-target">${fmtGBP(s.yr5)}</span>
        </div>
        <div class="hold-tile-row">
          <span class="hold-tile-k">Profit (net of fees)</span>
          <span class="hold-tile-v ${s.profit >= 0 ? 'hold-pos' : 'hold-neg'}">${profitSign}${fmtGBP(Math.abs(s.profit))}</span>
        </div>
        <div class="hold-tile-row">
          <span class="hold-tile-k">ROI</span>
          <span class="hold-tile-v ${s.roi >= 0 ? 'hold-pos' : 'hold-neg'}">${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(0)}%</span>
        </div>
        ${s.waitMonths ? `
        <div class="hold-tile-row hold-tile-warn">
          <span class="hold-tile-k">Wait</span>
          <span class="hold-tile-v">~${s.waitDisplay || s.waitMonths.toFixed(1) + ' mo'} locked</span>
        </div>` : ''}
        ${s.lossProb !== undefined && s.lossProb > 0 ? `
        <div class="hold-tile-row hold-tile-warn">
          <span class="hold-tile-k">Loss case</span>
          <span class="hold-tile-v hold-neg">${(s.lossProb*100).toFixed(0)}% chance · −${fmtGBP(Math.abs(s.lossEV))}</span>
        </div>` : ''}
        <div class="hold-tile-foot">
          <span class="hold-risk hold-risk-${s.risk}">${riskLabel}</span>
          <span class="hold-verdict ${verdict.c}">${verdict.t}</span>
        </div>
      </div>
    `;
  }).join('') + (_hiddenGradeNums.size > 0
    ? `<button class="hold-grade-toggle-btn" id="holdGradeToggleBtn" data-ltp="${_ltpGradeNum}" data-expanded="0">Show PSA 1–${_ltpGradeNum - 1} ▾</button>`
    : '');

  const _toggleBtn = document.getElementById('holdGradeToggleBtn');
  if (_toggleBtn) {
    _toggleBtn.addEventListener('click', () => {
      const expanded = _toggleBtn.dataset.expanded === '1';
      grid.querySelectorAll('.hold-tile-collapsed').forEach(el => { el.style.display = expanded ? 'none' : ''; });
      const ltp = parseInt(_toggleBtn.dataset.ltp);
      _toggleBtn.textContent = expanded ? `Show PSA 1–${ltp - 1} ▾` : `Hide PSA 1–${ltp - 1} ▴`;
      _toggleBtn.dataset.expanded = expanded ? '0' : '1';
    });
  }

  // ---------- PSA grading outcome distribution ----------
  // Probability bar + P&L for each PSA grade outcome — always shown since
  // PSA grading is always one of the strategy options.
  const outcomeHost = $('holdOutcomes');
  if (outcomeHost) {
    outcomeHost.style.display = '';
    const bestProfit = Math.max(...gradeOutcomes.map(o => o.profitUSD));
    const rows = gradeOutcomes.map(o => {
      const profitGBP = gbpFromUSD(o.profitUSD);
      const sign = profitGBP >= 0 ? '+' : '−';
      const cls = profitGBP >= 0 ? 'hold-pos' : 'hold-neg';
      const pct = (o.prob * 100).toFixed(0);
      const isHero = o.profitUSD === bestProfit && o.profitUSD > 0;
      // Build the tactical "flip vs crack" sub-line for non-PSA-10 outcomes.
      // NB: fmtGBP() takes USD and converts internally — do NOT pre-convert.
      let moveBlock = '';
      if (o.nextMove) {
        const moveCls = o.nextMove === 'crack' ? 'hold-move-crack' : 'hold-move-flip';
        let moveLabel, otherLine;
        if (o.nextMove === 'crack') {
          moveLabel = `Crack &amp; resub (EV ${fmtGBP(o.crackNetUSD)})`;
          otherLine = `Flip alt: ${fmtGBP(o.flipNetUSD)}\u00a0\u00b7\u00a0crack adds +${fmtGBP(o.nextMoveEdgeUSD)} EV (${(o.crackUpgradeProb*100).toFixed(0)}% upgrade chance)`;
        } else {
          moveLabel = `Flip the slab (${fmtGBP(o.flipNetUSD)})`;
          if (o.crackNetUSD >= o.flipNetUSD) {
            // Crack EV is technically higher but within the 5% risk-buffer.
            otherLine = `Crack alt: ${fmtGBP(o.crackNetUSD)} EV\u00a0\u00b7\u00a0only +${fmtGBP(o.nextMoveEdgeUSD)} edge \u2014 not worth another \u00a3${gradingFeeGBP} + ${gradingWaitDisplay} wait + ${(CRACK_DAMAGE_RISK*100).toFixed(0)}% damage risk`;
          } else {
            otherLine = `Crack alt: ${fmtGBP(o.crackNetUSD)} EV\u00a0\u00b7\u00a0\u2212${fmtGBP(o.nextMoveEdgeUSD)} after \u00a3${gradingFeeGBP} resub fee + ${(CRACK_DAMAGE_RISK*100).toFixed(0)}% damage risk`;
          }
        }
        moveBlock = `
          <div class="hold-out-move">
            <span class="hold-out-move-label">If this happens:</span>
            <span class="hold-out-move-pill ${moveCls}">${moveLabel}</span>
            <span class="hold-out-move-alt">${otherLine}</span>
          </div>
        `;
      }
      return `
        <div class="hold-out-row ${isHero ? 'hold-out-hero' : ''}">
          <div class="hold-out-grade">${o.label}</div>
          <div class="hold-out-prob">
            <div class="hold-out-bar"><div class="hold-out-bar-fill" style="width:${Math.max(2, o.prob*100)}%"></div></div>
            <div class="hold-out-prob-num">${pct}%</div>
          </div>
          <div class="hold-out-pl ${cls}">${sign}${fmtGBP(Math.abs(profitGBP))}</div>
          <div class="hold-out-roi ${cls}">${o.roi >= 0 ? '+' : ''}${o.roi.toFixed(0)}%</div>
          ${moveBlock}
        </div>
      `;
    }).join('');
    const goodPct = (goodOutcomeProb*100).toFixed(0);
    const lossPct = (lossProb*100).toFixed(0);
    const goodChipLabel = expectedGrade
      ? `Expected PSA ${expectedGrade}`
      : `${goodPct}% PSA 9 or 10`;
    outcomeHost.innerHTML = `
      <div class="hold-out-head">
        <div class="hold-out-summary">
          <span class="hold-out-chip hold-out-chip-good">${goodChipLabel}</span>
          <span class="hold-out-chip hold-out-chip-bad">${lossPct}% loss case</span>
          <span class="hold-out-chip hold-out-chip-wait">${gradingWaitDisplay} wait (UK)</span>
        </div>
      </div>
      <div class="hold-out-grid-head">
        <span>Outcome</span><span>Probability</span><span>5yr P&amp;L</span><span>ROI</span>
      </div>
      ${rows}
    `;
  }

  // Footnote with assumptions.
  const gemPctStr = (gemRate * 100).toFixed(0);
  const baseGemPctStr = (baseGemRate * 100).toFixed(0);
  // Reset footnote to hidden on each card change
  $('holdFootnote').style.display = 'none';
  $('holdFootnoteToggle').classList.remove('is-open');
  $('holdFootnoteToggle').onclick = () => {
    const fn = $('holdFootnote');
    const btn = $('holdFootnoteToggle');
    const nowOpen = fn.style.display === 'none';
    fn.style.display = nowOpen ? 'block' : 'none';
    btn.classList.toggle('is-open', nowOpen);
  };

  const aceAnchorFootnote = hasAceAnchor
    ? `<strong>ACE 10 anchor (live):</strong> ${fmtGBP(ace10USD)}${aceVsPsaPct > 0 ? ` (\u2248 ${aceVsPsaPct.toFixed(0)}% of PSA 10)` : ''} from PriceCharting. 5yr ACE slab EV = gem-rate-weighted ACE 10 (${(gemRate*100).toFixed(0)}%) + raw-equivalent for subgem outcomes (${((1-gemRate)*100).toFixed(0)}%) \u2014 ACE 7/8/9 slabs modelled near raw (no active subgem-ACE resale market).`
    : 'No ACE 10 comp on PriceCharting for this card \u2014 ACE 5yr projection defaults to the raw price curve (fee treated as pure protection cost).';
  $('holdFootnote').innerHTML = `
    <strong>PSA grading:</strong> \u00a3${gradingFeeGBP} fee + \u00a30.28 materials per card
    (${psa10Price > UK_GRADING_VALUE_THRESHOLD_USD ? '$1,501\u2013$2,500 tier, 20\u201330 business day turnaround' : '\u2264$1,500 tier, 30\u201340 business day turnaround'};
    submitted via Ludkins / GetGraded). Gem rate effective ${gemPctStr}% (base ${baseGemPctStr}% ${gemRateSource}, \u00d7${(ONLINE_BUY_GEM_PENALTY*100).toFixed(0)}% online sight-unseen penalty). Wait discount: ${(OPPORTUNITY_COST_ANNUAL*100).toFixed(0)}% p.a. opportunity cost.<br>
    <strong>ACE grading (${aceInfo_r.label} tier):</strong> \u00a3${aceFeeGBP_r} fee + \u00a30.28 materials, ~${aceWaitDisplay_r} turnaround (${aceInfo_r.availability}). ${aceAnchorFootnote}<br>
    <strong>ACE tier ladder:</strong> Basic \u00a318 / 45d \u00b7 Standard \u00a325 / 25d \u00b7 Premier \u00a332 / 10d \u00b7 Ultra \u00a360 / 5d \u00b7 Luxury \u00a3120 / 2d. Higher tiers buy faster turnaround only.<br>
    <strong>Flip vs Crack (PSA non-10 outcomes):</strong> flip vs crack EV compared for each PSA 7/8/9 result. Upgrade rates: 9\u219210 = 10%, 8\u21929+ = 15%, 7\u21928+ = 25%. ${(CRACK_DAMAGE_RISK*100).toFixed(0)}% crack-damage haircut applied. Another \u00a3${gradingFeeGBP} resub fee + wait discount included.<br>
    Risk-adjusted ranking: ROI minus variance discount (${(0.35*100).toFixed(0)}% of variance \u00d7 100 pts) + upside bonus. High-variance PSA grade gamble needs meaningfully higher ROI to beat a steadier graded copy.
  `;

  // ---- Market context block: entry timing + grading economics + hold timeframe ----
  const ctxEl = $('holdMarketContext');
  if (ctxEl) {
    const timing   = getEntryTiming(card.sc);
    const rawGBP   = rawUSD * fx;
    const psa10GBP_ctx = psa10Price * fx;
    const gradeFeeGBP_ctx = getUkGradingFeeGBP(psa10Price);
    const spreadGBP    = psa10GBP_ctx - rawGBP;
    const gradingJustified = spreadGBP > (rawGBP * 0.5 + gradeFeeGBP_ctx);
    const popSize  = typeof card.popPsa10 === 'number' ? card.popPsa10 : null;
    const popNote  = popSize != null
      ? (popSize < 1000 ? `PSA 10 pop ${popSize.toLocaleString()} — genuinely scarce in graded form.`
       : popSize < 10000 ? `PSA 10 pop ${popSize.toLocaleString()} — moderate supply, graded copies are findable.`
       : `PSA 10 pop ${popSize.toLocaleString()} — well-supplied in graded form; premium is limited.`)
      : '';

    // Era-based minimum hold recommendation
    const setYear = (() => {
      const s = setsData?.[card.sc];
      const d = s?.releaseDate || s?.released || '';
      return d ? parseInt(d.slice(0, 4)) : 2023;
    })();
    const minHold = setYear >= 2023 ? '6–12 months (SV era)'
                  : setYear >= 2019 ? '12–18 months (SW&S era)'
                  : setYear >= 2016 ? '2+ years (Sun & Moon / XY era)'
                  : '3+ years (pre-2016 — established collector market)';

    const gradeEconomics = gradingJustified
      ? `Grading justified — PSA 10 spread (${fmtGBPDirect(spreadGBP)}) covers raw price + ${fmtGBPDirect(gradeFeeGBP_ctx)} fee.`
      : `Grading marginal — spread (${fmtGBPDirect(spreadGBP)}) vs fee (${fmtGBPDirect(gradeFeeGBP_ctx)}) is tight. Buy graded instead.`;

    ctxEl.innerHTML = `
      <div class="hold-ctx-row">
        <span class="hold-ctx-pill ${timing.cls}">${timing.label}</span>
        <span class="hold-ctx-detail">${timing.detail}</span>
      </div>
      <div class="hold-ctx-row">
        <span class="hold-ctx-pill hold-ctx-hold">Min hold</span>
        <span class="hold-ctx-detail">${minHold}</span>
      </div>
      <div class="hold-ctx-row">
        <span class="hold-ctx-pill ${gradingJustified ? 'hold-ctx-grade-ok' : 'hold-ctx-grade-no'}">${gradingJustified ? 'Grade ✓' : 'Grade ✗'}</span>
        <span class="hold-ctx-detail">${gradeEconomics}${popNote ? ' ' + popNote : ''}</span>
      </div>
      <div class="hold-ctx-row">
        <span class="hold-ctx-pill hold-ctx-sell">Sell signal</span>
        <span class="hold-ctx-detail">Watch eBay active listings — if new listings outpace sold volume for 5+ days, the distribution peak is forming. A 2–3 week price floor with steady sales = confirmed support.</span>
      </div>`;
    ctxEl.style.display = 'block';
  }

  // _holdWinnerKey is now set above — updateSignal will read it next time it's called.
  // Re-call updateSignal immediately so the badge reflects this card's Hold Strategy
  // result without waiting for the next user interaction.
  if (ownedCard && selectedCard) {
    const { pullCost } = calcPullCost();
    const des = calcDesirability();
    updateSignal(selectedCard, pullCost, des);
  }
}

// =============================================================
// Price Sync · refresh cached prices on demand
// =============================================================
//
// Three scopes:
//   1. Single card  — selected card OR manual ID/name input
//   2. Tracked      — every card in portfolio ∪ wishlist ∪ watchlist
//   3. Cached/Stale — every entry currently in the local price cache
//
// Each refresh bypasses the 1-hour cache TTL by calling fetchFreshPriceData
// directly and overwriting the cache entry with a new timestamp. Batched
// refreshes run with a small concurrency limit so we don't hammer
// PriceCharting / pokemontcg.io.

const PRICE_SYNC_CONCURRENCY = 8;
const PRICE_SYNC_LAST_KEY = 'pkm-price-sync-last-v1';
let _psState = { running: false, cancel: false, done: 0, total: 0 };

function psSetLastSync(ts) {
  try { localStorage.setItem(PRICE_SYNC_LAST_KEY, String(ts)); } catch {}
}
function psGetLastSync() {
  const v = Number(localStorage.getItem(PRICE_SYNC_LAST_KEY) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function psFormatAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function psTrackedIds() {
  const set = new Set();
  (portfolio || []).forEach(p => p && p.id && set.add(p.id));
  (wishlist || []).forEach(w => w && w.id && set.add(w.id));
  (watchlist || []).forEach(w => w && w.id && set.add(w.id));
  return Array.from(set);
}

function psCacheIds(opts = {}) {
  const cache = getPriceCache();
  const now = Date.now();
  return Object.keys(cache).filter(id => {
    const entry = cache[id];
    if (!entry) return false;
    if (opts.staleOnly) {
      return (now - (entry._ts || 0)) > PRICE_CACHE_TTL;
    }
    return true;
  });
}

function psCacheStats() {
  const cache = getPriceCache();
  const now = Date.now();
  let fresh = 0, stale = 0;
  Object.values(cache).forEach(e => {
    if (!e) return;
    if (now - (e._ts || 0) <= PRICE_CACHE_TTL) fresh++; else stale++;
  });
  return { total: fresh + stale, fresh, stale };
}

function psUpdateStats() {
  if (!document.getElementById('psStatCached')) return;
  const stats = psCacheStats();
  document.getElementById('psStatCached').textContent = stats.total.toLocaleString();
  document.getElementById('psStatFresh').textContent = stats.fresh.toLocaleString();
  document.getElementById('psStatStale').textContent = stats.stale.toLocaleString();
  document.getElementById('psStatTracked').textContent = psTrackedIds().length.toLocaleString();
  document.getElementById('psStatLast').textContent = psFormatAgo(psGetLastSync());

  // Selected hint + enable state
  const selBtn = document.getElementById('psRefreshSelected');
  const selHint = document.getElementById('psSelectedHint');
  if (selBtn && selHint) {
    if (selectedCard) {
      selBtn.disabled = false;
      selHint.textContent = selectedCard.n + (selectedCard.cn ? ` #${selectedCard.cn}` : '');
    } else {
      selBtn.disabled = true;
      selHint.textContent = 'Pick a card from search first';
    }
  }

  // Other hints
  const trackedCount = psTrackedIds().length;
  const tHint = document.getElementById('psTrackedHint');
  if (tHint) tHint.textContent = trackedCount
    ? `${trackedCount} card${trackedCount === 1 ? '' : 's'} · Portfolio · Wishlist · Watchlist`
    : 'No tracked cards yet';

  const staleHint = document.getElementById('psStaleHint');
  if (staleHint) staleHint.textContent = stats.stale
    ? `${stats.stale} stale entr${stats.stale === 1 ? 'y' : 'ies'} to refresh`
    : 'Nothing stale right now';

  const allHint = document.getElementById('psAllHint');
  if (allHint) allHint.textContent = stats.total
    ? `Re-pulls all ${stats.total} cached card${stats.total === 1 ? '' : 's'}`
    : 'Cache is empty';
}

function psLog(line, kind) {
  const log = document.getElementById('psLog');
  if (!log) return;
  log.style.display = 'block';
  const row = document.createElement('div');
  row.className = 'ps-log-row' + (kind ? ' ps-log-' + kind : '');
  row.textContent = line;
  log.appendChild(row);
  // Keep log to last 50 rows
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
function psClearLog() {
  const log = document.getElementById('psLog');
  if (log) { log.innerHTML = ''; log.style.display = 'none'; }
}

function psShowProgress(label, total) {
  const wrap = document.getElementById('psProgress');
  if (!wrap) return;
  wrap.style.display = 'block';
  document.getElementById('psProgressLabel').textContent = label;
  document.getElementById('psProgressCounter').textContent = `0 / ${total}`;
  document.getElementById('psProgressFill').style.width = '0%';
  document.getElementById('psProgressCurrent').textContent = '';
}
function psUpdateProgress(done, total, currentLabel) {
  const wrap = document.getElementById('psProgress');
  if (!wrap) return;
  document.getElementById('psProgressCounter').textContent = `${done} / ${total}`;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('psProgressFill').style.width = pct + '%';
  if (currentLabel != null) document.getElementById('psProgressCurrent').textContent = currentLabel;
}
function psHideProgress() {
  const wrap = document.getElementById('psProgress');
  if (wrap) wrap.style.display = 'none';
}

function psSetButtonsDisabled(disabled) {
  ['psRefreshSelected', 'psRefreshTracked', 'psRefreshStale', 'psRefreshAll', 'psClearCache', 'psManualGo', 'livePriceRefresh']
    .forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (disabled) {
        el.dataset._wasDisabled = el.disabled ? '1' : '0';
        el.disabled = true;
      } else {
        // Selected button retains its real state (depends on selectedCard)
        if (id === 'psRefreshSelected') {
          el.disabled = !selectedCard;
        } else {
          el.disabled = el.dataset._wasDisabled === '1';
        }
        delete el.dataset._wasDisabled;
      }
    });
}

// Refresh a single card by id — returns {ok, error, data}
async function psRefreshOne(id) {
  if (!cardData) return { ok: false, error: 'Catalog not loaded' };
  const card = getCardById(id);
  if (!card) return { ok: false, error: `Card not in catalog: ${id}` };
  try {
    const data = await fetchFreshPriceData(card);
    if (data.tcgMarket <= 0) {
      const existing = getLastKnownPrice(card.i);
      if (existing && existing.tcgMarket > 0) {
        data.tcgMarket  = existing.tcgMarket;
        data.tcgLow     = existing.tcgLow    || 0;
        data.tcgMid     = existing.tcgMid    || 0;
        data.tcgHigh    = existing.tcgHigh   || 0;
        data.tcgUrl     = data.tcgUrl        || existing.tcgUrl;
        data.tcgUpdated = data.tcgUpdated    || existing.tcgUpdated;
      }
    }
    setCachedPrice(card.i, data);
    // If this is the currently selected card, update the live panel immediately
    if (selectedCard && selectedCard.i === card.i) {
      livePrice = data;
      if (typeof renderLivePrice === 'function') renderLivePrice(data);
      if (typeof recalcWithLivePrice === 'function') recalcWithLivePrice(card);
    }
    return { ok: true, card, data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), card };
  }
}

// Batch refresh with concurrency control
async function psBatchRefresh(ids, label) {
  if (_psState.running) {
    psLog('Already running — wait for it to finish or cancel.', 'warn');
    return;
  }
  if (!ids.length) {
    psLog(`Nothing to refresh for "${label}".`, 'warn');
    return;
  }
  _psState = { running: true, cancel: false, done: 0, total: ids.length };
  psSetButtonsDisabled(true);
  psClearLog();
  psShowProgress(label, ids.length);
  psLog(`Starting ${label} · ${ids.length} card${ids.length === 1 ? '' : 's'}`, 'info');

  let okCount = 0, errCount = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PRICE_SYNC_CONCURRENCY, ids.length) }, async () => {
    while (cursor < ids.length && !_psState.cancel) {
      const myIdx = cursor++;
      const id = ids[myIdx];
      const card = getCardById(id);
      const labelText = card ? `${card.n}${card.cn ? ' #' + card.cn : ''} (${card.s || id})` : id;
      psUpdateProgress(_psState.done, _psState.total, `→ ${labelText}`);
      const result = await psRefreshOne(id);
      _psState.done++;
      if (result.ok) {
        okCount++;
        const px = result.data?.pcUngraded || result.data?.market || result.data?.cmTrend || 0;
        psLog(`✓ ${labelText} · ${px > 0 ? fmtGBP(px) : 'no price'}`, 'ok');
      } else {
        errCount++;
        psLog(`✗ ${labelText} · ${result.error}`, 'err');
      }
      psUpdateProgress(_psState.done, _psState.total, '');
    }
  });
  await Promise.all(workers);

  psSetLastSync(Date.now());
  psUpdateStats();
  psHideProgress();
  psSetButtonsDisabled(false);
  _psState.running = false;

  const finishMsg = _psState.cancel
    ? `Cancelled · ${okCount} refreshed · ${errCount} failed`
    : `Done · ${okCount} refreshed · ${errCount} failed`;
  psLog(finishMsg, errCount ? 'warn' : 'ok');

  // Re-render any panels that depend on prices
  try { if (typeof renderPortfolio === 'function') renderPortfolio(); } catch {}
  try { if (typeof renderWishlist === 'function') renderWishlist(); } catch {}
  try { if (typeof renderWatchlist === 'function') renderWatchlist(); } catch {}
  try { if (typeof rebuildAlerts === 'function') rebuildAlerts(); } catch {}
  try { if (typeof renderHomeDashboard === 'function') renderHomeDashboard(); } catch {}
}

// Manual lookup — accepts a cardId ("sv8pt5-161") OR a free-text query
function psResolveManual(query) {
  if (!query || !cardData) return null;
  const q = query.trim();
  // Direct id match
  const byId = cardData.cards.find(c => c.i.toLowerCase() === q.toLowerCase());
  if (byId) return byId;
  // Try "set num" or "name num"
  const parts = q.split(/\s+/);
  const numTok = parts.find(p => /^\d{1,4}[a-z]?$/i.test(p));
  const nameTok = parts.filter(p => p !== numTok).join(' ').toLowerCase();
  const matches = cardData.cards.filter(c => {
    const name = (c.n || '').toLowerCase();
    const setName = (c.s || '').toLowerCase();
    const num = String(c.cn || c.ns || '').toLowerCase();
    const numOk = numTok ? num === numTok.toLowerCase() : true;
    const nameOk = nameTok ? (name.includes(nameTok) || setName.includes(nameTok)) : true;
    return numOk && nameOk;
  });
  // Prefer EN over JP, then highest p10 (likely the chase card)
  matches.sort((a, b) => {
    if ((a.lang || 'EN') !== (b.lang || 'EN')) return a.lang === 'JP' ? 1 : -1;
    return (b.p10 || 0) - (a.p10 || 0);
  });
  return matches[0] || null;
}

async function psManualRefresh() {
  const input = document.getElementById('psManualInput');
  const q = (input?.value || '').trim();
  if (!q) { psLog('Type a card ID or "set num" first.', 'warn'); return; }
  const card = psResolveManual(q);
  if (!card) { psLog(`No match for "${q}".`, 'err'); return; }
  await psBatchRefresh([card.i], `Refresh "${card.n}"`);
}

function setupPriceSync() {
  const sel = id => document.getElementById(id);
  if (!sel('priceSyncSection')) return;

  sel('psRefreshSelected')?.addEventListener('click', () => {
    if (!selectedCard) return;
    psBatchRefresh([selectedCard.i], `Refresh "${selectedCard.n}"`);
  });
  sel('psRefreshTracked')?.addEventListener('click', () => {
    psBatchRefresh(psTrackedIds(), 'Refresh tracked cards');
  });
  sel('psRefreshStale')?.addEventListener('click', () => {
    psBatchRefresh(psCacheIds({ staleOnly: true }), 'Refresh stale cached cards');
  });
  sel('psRefreshAll')?.addEventListener('click', () => {
    psBatchRefresh(psCacheIds(), 'Refresh every cached card');
  });
  sel('psClearCache')?.addEventListener('click', () => {
    if (_psState.running) return;
    try { localStorage.removeItem(PRICE_CACHE_KEY); } catch {}
    psSetLastSync(0);
    psUpdateStats();
    psLog('Price cache cleared.', 'info');
    const log = document.getElementById('psLog');
    if (log) log.style.display = 'block';
  });
  sel('psCancel')?.addEventListener('click', () => {
    if (!_psState.running) return;
    _psState.cancel = true;
    psLog('Cancelling after current batch finishes…', 'warn');
  });
  sel('psManualGo')?.addEventListener('click', psManualRefresh);
  sel('psManualInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); psManualRefresh(); }
  });

  // Per-selected-card refresh in the Live Market Price panel
  sel('livePriceRefresh')?.addEventListener('click', () => {
    if (!selectedCard || _psState.running) return;
    psBatchRefresh([selectedCard.i], `Refresh "${selectedCard.n}"`);
  });

  // Refresh button on the Model Prediction card — same as the Live panel
  // refresh: bypasses the 1-hour cache, re-pulls live prices and reruns the
  // model for the currently selected card. Mirrors enabled-state from the
  // selected card; spins the icon while a refresh is in flight.
  sel('modelRefreshBtn')?.addEventListener('click', async () => {
    if (!selectedCard || _psState.running) return;
    const btn = sel('modelRefreshBtn');
    if (btn) { btn.classList.add('is-loading'); btn.disabled = true; }
    try {
      await psBatchRefresh([selectedCard.i], `Refresh "${selectedCard.n}"`);
    } finally {
      if (btn) {
        btn.classList.remove('is-loading');
        btn.disabled = !selectedCard;
      }
    }
  });

  psUpdateStats();
  // Keep stats / "last sync" label live
  setInterval(psUpdateStats, 30 * 1000);
}

// =============================================================
// Acquisition tracker · realised + max ROI by cost basis
// =============================================================
//
// Each card can record:
//   { source: 'pack' | 'single',
//     packName, packCostGBP, packHits,
//     singlePriceGBP, singleDate, singleWhere,
//     ts }
// Stored in localStorage as a map keyed by cardId.

const ACQ_KEY = 'pkm-acquisitions-v1';
let acquisitions = {};
try { acquisitions = JSON.parse(localStorage.getItem(ACQ_KEY) || '{}'); } catch { acquisitions = {}; }

function saveAcquisitions() {
  try { localStorage.setItem(ACQ_KEY, JSON.stringify(acquisitions)); } catch {}
}

function getAcq(cardId) {
  return cardId && acquisitions[cardId] ? acquisitions[cardId] : null;
}

// Returns cost basis in GBP for a card, or null if not enough info
function getAcqCostBasisGBP(cardId) {
  const a = getAcq(cardId);
  if (!a) return null;
  if (a.source === 'pack') {
    const cost = parseFloat(a.packCostGBP);
    const hits = Math.max(1, parseInt(a.packHits || 1, 10));
    if (!Number.isFinite(cost) || cost <= 0) return null;
    return cost / hits;
  }
  if (a.source === 'single') {
    const p = parseFloat(a.singlePriceGBP);
    if (!Number.isFinite(p) || p <= 0) return null;
    return p;
  }
  if (a.source === 'slab') {
    const info = getAcqSlabInfo(cardId);
    return info ? info.costGBP : null;
  }
  return null;
}

// Returns slab acquisition info or null when source isn't 'slab' / data is incomplete.
function getAcqSlabInfo(cardId) {
  const a = getAcq(cardId);
  if (!a || a.source !== 'slab') return null;
  const grade = parseInt(a.slabGrade, 10);
  const costGBP = parseFloat(a.slabPriceGBP);
  if (![7, 8, 9, 10].includes(grade) || !Number.isFinite(costGBP) || costGBP <= 0) return null;
  return { grade, costGBP, date: a.slabDate || null, where: a.slabWhere || null };
}

function fmtPct(v, signed) {
  if (!Number.isFinite(v)) return '—';
  const s = (signed && v > 0 ? '+' : '') + v.toFixed(1) + '%';
  return s;
}
function fmtGBPDirect(gbp) {
  if (!Number.isFinite(gbp)) return '—';
  const rate = _currencyRates[_displayCurrency] ?? 1;
  const val  = gbp * rate;
  const sym  = _CURRENCY_SYMS[_displayCurrency] || '';
  if (_displayCurrency === 'JPY') return sym + Math.round(val).toLocaleString('en-GB');
  return sym + val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderAcquisition() {
  const sec = document.getElementById('acqSection');
  if (!sec) return;
  if (!selectedCard) { sec.style.display = 'none'; return; }
  const inPortfolio = portfolio.some(p => p.id === selectedCard.i);
  if (!inPortfolio) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';

  const card = selectedCard;
  const acq = getAcq(card.i) || {};

  // Toggle button state
  document.querySelectorAll('.acq-src-btn').forEach(b => {
    const src = b.dataset.src;
    if (src === 'clear') return;
    const on = acq.source === src;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  document.querySelector('.acq-src-clear').style.display = acq.source ? 'inline-flex' : 'none';
  const saveBtnEl = document.getElementById('acqSaveBtn');
  if (saveBtnEl && !saveBtnEl.classList.contains('is-saving') && !saveBtnEl.classList.contains('is-saved')) {
    saveBtnEl.style.display = acq.source ? 'flex' : 'none';
  }

  // Show the right fields
  const packFields = document.getElementById('acqFieldsPack');
  const singleFields = document.getElementById('acqFieldsSingle');
  const slabFields = document.getElementById('acqFieldsSlab');
  const empty = document.getElementById('acqEmpty');
  const roi = document.getElementById('acqRoi');
  packFields.style.display = acq.source === 'pack' ? 'grid' : 'none';
  singleFields.style.display = acq.source === 'single' ? 'grid' : 'none';
  if (slabFields) slabFields.style.display = acq.source === 'slab' ? 'grid' : 'none';
  empty.style.display = acq.source ? 'none' : 'block';

  // Populate fields without clobbering user-active focus
  const setIfNotFocused = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (document.activeElement === el) return;
    el.value = val == null ? '' : val;
  };
  setIfNotFocused('acqPackName', acq.packName);
  setIfNotFocused('acqPackCost', acq.packCostGBP);
  setIfNotFocused('acqPackHits', acq.packHits);
  setIfNotFocused('acqSinglePrice', acq.singlePriceGBP);
  setIfNotFocused('acqSingleDate', acq.singleDate);
  setIfNotFocused('acqSingleSrc', acq.singleWhere);
  setIfNotFocused('acqSlabGrade', acq.slabGrade);
  setIfNotFocused('acqSlabPrice', acq.slabPriceGBP);
  setIfNotFocused('acqSlabDate', acq.slabDate);
  setIfNotFocused('acqSlabWhere', acq.slabWhere);

  // Compute ROI readout
  const costGBP = getAcqCostBasisGBP(card.i);
  if (!acq.source || !Number.isFinite(costGBP) || costGBP <= 0) {
    roi.style.display = 'none';
    const flipEl = document.getElementById('acqSlabFlip');
    if (flipEl) flipEl.style.display = 'none';
    // Reset dynamic labels to defaults
    const mLbl = document.getElementById('acqMarketLbl'); if (mLbl) mLbl.textContent = 'Market now (raw)';
    const rLbl = document.getElementById('acqRoiNowLbl'); if (rLbl) rLbl.textContent = 'Realised ROI';
    const xLbl = document.getElementById('acqRoiMaxLbl'); if (xLbl) xLbl.textContent = 'Max ROI · PSA 10 in 5 years';
    const pLbl = document.getElementById('acqProfitLbl'); if (pLbl) pLbl.textContent = 'Profit if PSA 10';
    return;
  }
  roi.style.display = 'block';

  // ---- Slab acquisition ROI ----
  if (acq.source === 'slab') {
    const slabInfo = getAcqSlabInfo(card.i);
    const flipEl = document.getElementById('acqSlabFlip');
    const ladderEl = document.getElementById('acqLadder');
    if (!slabInfo) { roi.style.display = 'none'; if (flipEl) flipEl.style.display = 'none'; return; }
    const { grade, costGBP: slabCost } = slabInfo;
    const gradeLbl = PSA_GRADE_LABELS?.[grade] || '';
    const psa10USD_s = getPsa10Anchor(card)?.usd || (card.p10 || 0) || (livePrice?.pcPsa10 > 0 ? livePrice.pcPsa10 : 0);
    const fx_s = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
    const slabMarketUSD = psa10USD_s > 0 ? estimateGradePrice(card, grade, psa10USD_s) : 0;
    const slabMarketGBP = usdToGbp(slabMarketUSD);
    const FRICTION = 0.10;
    const delta = slabMarketGBP - slabCost;
    const realisedNet = slabMarketGBP * (1 - FRICTION);
    const realisedROI = slabCost > 0 ? ((realisedNet - slabCost) / slabCost) * 100 : null;
    const yr5USD_s = psa10USD_s > 0 ? projectGradePrice(card, grade, slabMarketUSD, 5) : 0;
    const yr5GBP_s = usdToGbp(yr5USD_s);
    const yr5Net_s = yr5GBP_s * (1 - FRICTION);
    const yr5ROI_s = slabCost > 0 ? ((yr5Net_s - slabCost) / slabCost) * 100 : null;
    const yr5Profit_s = yr5Net_s - slabCost;
    // Update labels
    const mLbl = document.getElementById('acqMarketLbl'); if (mLbl) mLbl.textContent = `Market now (PSA ${grade})`;
    const rLbl = document.getElementById('acqRoiNowLbl'); if (rLbl) rLbl.textContent = 'ROI if sold today';
    const xLbl = document.getElementById('acqRoiMaxLbl'); if (xLbl) xLbl.textContent = `5yr hold · PSA ${grade} — ${new Date().getFullYear() + 5}`;
    const pLbl = document.getElementById('acqProfitLbl'); if (pLbl) pLbl.textContent = `5yr profit (PSA ${grade})`;
    // Populate cells
    document.getElementById('acqCost').textContent = fmtGBPDirect(slabCost);
    const bits = [slabInfo.date, slabInfo.where].filter(Boolean);
    document.getElementById('acqCostSub').textContent = bits.length ? bits.join(' · ') : `PSA ${grade} ${gradeLbl}`;
    document.getElementById('acqMarket').textContent = slabMarketGBP > 0 ? fmtGBPDirect(slabMarketGBP) : '—';
    const deltaEl = document.getElementById('acqMarketDelta');
    if (slabMarketGBP > 0) {
      deltaEl.textContent = (delta >= 0 ? '+' : '') + fmtGBPDirect(Math.abs(delta)) + ' vs cost';
      deltaEl.className = 'acq-roi-sub acq-roi-delta ' + (delta >= 0 ? 'acq-pos' : 'acq-neg');
    } else { deltaEl.textContent = ''; }
    const roiEl = document.getElementById('acqRoiNow');
    if (Number.isFinite(realisedROI)) {
      roiEl.textContent = fmtPct(realisedROI, true);
      roiEl.className = 'acq-roi-val acq-roi-roi ' + (realisedROI >= 0 ? 'acq-pos' : 'acq-neg');
    } else { roiEl.textContent = '—'; roiEl.className = 'acq-roi-val acq-roi-roi'; }
    document.getElementById('acqRoiNowSub').textContent = `net of ${(FRICTION*100).toFixed(0)}% sell fees`;
    const maxEl = document.getElementById('acqRoiMax');
    if (Number.isFinite(yr5ROI_s)) {
      maxEl.textContent = fmtPct(yr5ROI_s, true);
      maxEl.className = 'acq-roi-val acq-roi-val-max ' + (yr5ROI_s >= 0 ? 'acq-pos' : 'acq-neg');
    } else { maxEl.textContent = '—'; maxEl.className = 'acq-roi-val acq-roi-val-max'; }
    document.getElementById('acqRoiMaxSub').textContent = yr5GBP_s > 0 ? `projected ${fmtGBPDirect(yr5GBP_s)} by ${new Date().getFullYear() + 5}` : '';
    const profEl = document.getElementById('acqProfitMax');
    profEl.textContent = Number.isFinite(yr5Profit_s) ? (yr5Profit_s >= 0 ? '+' : '') + fmtGBPDirect(Math.abs(yr5Profit_s)) : '—';
    profEl.className = 'acq-roi-val ' + (yr5Profit_s >= 0 ? 'acq-pos' : 'acq-neg');
    document.getElementById('acqProfitMaxSub').textContent = `after ${(FRICTION*100).toFixed(0)}% sell fees`;
    // Storage
    const storageDiv = document.getElementById('acqStorage'); if (storageDiv) storageDiv.style.display = 'none';
    // Ladder: hide (replaced by flip analysis)
    if (ladderEl) ladderEl.style.display = 'none';
    // Flip analysis
    if (flipEl && psa10USD_s > 0) {
      flipEl.style.display = 'block';
      const sellProceeds = slabMarketGBP * (1 - FRICTION);
      const flipOptions = [
        { g: grade, label: `Keep PSA ${grade}`, isCurrent: true },
        ...([10, 9, 8, 7].filter(g => g !== grade)).map(g => ({ g, label: `Sell → Buy PSA ${g}`, isCurrent: false })),
        { g: 0, label: 'Sell → Go raw', isCurrent: false },
      ];
      const flipRows = flipOptions.map(opt => {
        if (opt.isCurrent) {
          return { label: opt.label, totalOut: slabCost, yr5: yr5GBP_s, roi: yr5ROI_s, profit: yr5Profit_s, netChg: null, isCurrent: true };
        }
        if (opt.g === 0) {
          // Sell slab, buy raw
          const rawUSD_f = getCurrentPrice(card);
          const rawGBP_f = usdToGbp(rawUSD_f || 0) + UK_RAW_SHIPPING_GBP;
          const netChg = rawGBP_f - sellProceeds; // how much extra you pay (or get back)
          const totalOut = slabCost + netChg;
          const rawYr5 = rawUSD_f > 0 ? usdToGbp(projectGradePrice(card, 9, rawUSD_f, 5) / GRADE_GROWTH_PREMIUM[9]) : 0;
          const rawYr5Net = rawYr5 * (1 - FRICTION);
          const roi_f = totalOut > 0 ? ((rawYr5Net - totalOut) / totalOut) * 100 : null;
          return { label: opt.label, totalOut, yr5: rawYr5, roi: roi_f, profit: rawYr5Net - totalOut, netChg, isCurrent: false };
        }
        const buyUSD_f = estimateGradePrice(card, opt.g, psa10USD_s);
        const buyGBP_f = usdToGbp(buyUSD_f) + estimateUkSlabShipping(buyUSD_f * fx_s);
        const netChg = buyGBP_f - sellProceeds;
        const totalOut = slabCost + netChg;
        const yr5_f = usdToGbp(projectGradePrice(card, opt.g, buyUSD_f, 5));
        const yr5Net_f = yr5_f * (1 - FRICTION);
        const roi_f = totalOut > 0 ? ((yr5Net_f - totalOut) / totalOut) * 100 : null;
        return { label: opt.label, totalOut, yr5: yr5_f, roi: roi_f, profit: yr5Net_f - totalOut, netChg, isCurrent: false };
      });
      const validRows = flipRows.filter(r => Number.isFinite(r.roi));
      const bestROI = validRows.length ? Math.max(...validRows.map(r => r.roi)) : null;
      flipEl.innerHTML = `
        <div class="acq-flip-head">Hold or flip?</div>
        <div class="acq-flip-table">
          <div class="acq-flip-th"><span>Option</span><span>Total outlay</span><span>5yr target</span><span>5yr ROI</span></div>
          ${flipRows.map(r => {
            const isBest = Number.isFinite(r.roi) && r.roi === bestROI;
            const chgTxt = r.netChg !== null ? `<span class="acq-flip-chg ${r.netChg >= 0 ? 'acq-neg' : 'acq-pos'}">${r.netChg >= 0 ? '+' : ''}${fmtGBPDirect(Math.abs(r.netChg))} ${r.netChg >= 0 ? 'extra' : 'back'}</span>` : '';
            return `<div class="acq-flip-row ${r.isCurrent ? 'acq-flip-current' : ''} ${isBest ? 'acq-flip-best' : ''}">
              <span class="acq-flip-label">${r.label}${isBest && !r.isCurrent ? ' <span class="acq-flip-best-tag">best</span>' : ''}</span>
              <span class="acq-flip-num">${Number.isFinite(r.totalOut) ? fmtGBPDirect(r.totalOut) : '—'}${chgTxt}</span>
              <span class="acq-flip-num">${Number.isFinite(r.yr5) && r.yr5 > 0 ? fmtGBPDirect(r.yr5) : '—'}</span>
              <span class="acq-flip-num ${Number.isFinite(r.roi) ? (r.roi >= 0 ? 'acq-pos' : 'acq-neg') : ''}">${Number.isFinite(r.roi) ? fmtPct(r.roi, true) : '—'}</span>
            </div>`;
          }).join('')}
        </div>
      `;
    } else if (flipEl) { flipEl.style.display = 'none'; }
    // Meta
    const meta = document.getElementById('acqMeta');
    const acqDate = acq.ts ? new Date(acq.ts) : null;
    meta.innerHTML = [
      acqDate ? `Logged ${acqDate.toLocaleDateString('en-GB')}` : '',
      portfolio.some(p => p.id === card.i) ? '<span class="acq-pill">In collection</span>' : '<span class="acq-pill acq-pill-muted">Not in collection</span>',
    ].filter(Boolean).join(' · ');
    return;
  }

  // ---- Non-slab ROI (pack / single) ----
  // Reset dynamic labels
  const mLbl_n = document.getElementById('acqMarketLbl'); if (mLbl_n) mLbl_n.textContent = 'Market now (raw)';
  const rLbl_n = document.getElementById('acqRoiNowLbl'); if (rLbl_n) rLbl_n.textContent = 'Realised ROI';
  const xLbl_n = document.getElementById('acqRoiMaxLbl'); if (xLbl_n) xLbl_n.textContent = 'Max ROI · PSA 10 in 5 years';
  const pLbl_n = document.getElementById('acqProfitLbl'); if (pLbl_n) pLbl_n.textContent = 'Profit if PSA 10';
  const flipEl_n = document.getElementById('acqSlabFlip'); if (flipEl_n) flipEl_n.style.display = 'none';

  const rawUSD = getCurrentPrice(card);
  const marketGBP = usdToGbp(rawUSD || 0);
  const psa10USD = (card.p10 || 0) || (livePrice && livePrice.pcPsa10 > 0 ? livePrice.pcPsa10 : 0);

  // Realised ROI: market value now (raw) vs cost basis, net of eBay sell fee
  const FRICTION = BUY_SELL_FRICTION;
  const realisedNetGBP = marketGBP * (1 - FRICTION);
  const realisedROI = costGBP > 0 ? ((realisedNetGBP - costGBP) / costGBP) * 100 : null;

  // Max ROI scenario: PSA 10 in 5 years
  let maxROI = null, maxProfit = null, maxValueGBP = null, maxGradingFeeGBP = 0;
  if (psa10USD > 0) {
    const psa10NowUSD = estimateGradePrice(card, 10, psa10USD);
    const psa10In5USD = projectGradePrice(card, 10, psa10NowUSD, 5);
    const psa10In5GBP = usdToGbp(psa10In5USD);
    const gradingFeeGBP = getUkGradingFeeGBP(psa10USD);
    const materialsCostGBP = getGradingMaterialsCostGBP(card.i);
    const netGBP = psa10In5GBP * (1 - FRICTION) - gradingFeeGBP - materialsCostGBP;
    maxGradingFeeGBP = gradingFeeGBP + materialsCostGBP;
    maxValueGBP = psa10In5GBP;
    maxROI = costGBP > 0 ? ((netGBP - costGBP) / costGBP) * 100 : null;
    maxProfit = netGBP - costGBP;
  }

  // Storage materials: show checkboxes and reflect current acquisition state
  const storageDiv = document.getElementById('acqStorage');
  if (storageDiv) {
    storageDiv.style.display = 'flex';
    const sleeveCheck = document.getElementById('acqHasSleeve');
    const toploaderCheck = document.getElementById('acqHasToploader');
    if (sleeveCheck) sleeveCheck.checked = !!acq.hasPennySleeve;
    if (toploaderCheck) toploaderCheck.checked = !!acq.hasToploader;
  }

  // Cost basis card
  const costEl = document.getElementById('acqCost');
  const costSub = document.getElementById('acqCostSub');
  costEl.textContent = fmtGBPDirect(costGBP);
  if (acq.source === 'pack') {
    const hits = Math.max(1, parseInt(acq.packHits || 1, 10));
    const pack = parseFloat(acq.packCostGBP);
    costSub.textContent = `${fmtGBPDirect(pack)} pack ÷ ${hits} hit${hits === 1 ? '' : 's'}`;
  } else {
    const bits = [];
    if (acq.singleDate) bits.push(acq.singleDate);
    if (acq.singleWhere) bits.push(acq.singleWhere);
    costSub.textContent = bits.join(' · ');
  }

  // Market now
  document.getElementById('acqMarket').textContent = fmtGBPDirect(marketGBP);
  const delta = marketGBP - costGBP;
  const deltaEl = document.getElementById('acqMarketDelta');
  if (Number.isFinite(delta)) {
    deltaEl.textContent = (delta >= 0 ? '+' : '') + fmtGBPDirect(delta) + ' vs cost';
    deltaEl.classList.toggle('acq-pos', delta >= 0);
    deltaEl.classList.toggle('acq-neg', delta < 0);
  }

  // Realised ROI now
  const roiEl = document.getElementById('acqRoiNow');
  if (Number.isFinite(realisedROI)) {
    roiEl.textContent = fmtPct(realisedROI, true);
    roiEl.classList.toggle('acq-pos', realisedROI >= 0);
    roiEl.classList.toggle('acq-neg', realisedROI < 0);
  } else { roiEl.textContent = '—'; }
  document.getElementById('acqRoiNowSub').textContent = `flip raw today · ${(FRICTION * 100).toFixed(0)}% fees`;

  // Max ROI
  const maxEl = document.getElementById('acqRoiMax');
  const maxSub = document.getElementById('acqRoiMaxSub');
  const profEl = document.getElementById('acqProfitMax');
  const profSub = document.getElementById('acqProfitMaxSub');
  if (Number.isFinite(maxROI) && maxValueGBP) {
    maxEl.textContent = fmtPct(maxROI, true);
    maxEl.classList.toggle('acq-pos', maxROI >= 0);
    maxEl.classList.toggle('acq-neg', maxROI < 0);
    maxSub.textContent = `if it grades PSA 10 · projected ${fmtGBPDirect(maxValueGBP)} in 5 years`;
    profEl.textContent = (maxProfit >= 0 ? '+' : '') + fmtGBPDirect(maxProfit);
    profEl.classList.toggle('acq-pos', maxProfit >= 0);
    profEl.classList.toggle('acq-neg', maxProfit < 0);
    profSub.textContent = `after ${fmtGBPDirect(maxGradingFeeGBP)} grading + materials + 10% sell fees`;
  } else {
    maxEl.textContent = '—';
    maxSub.textContent = 'PSA 10 anchor unavailable for this card';
    profEl.textContent = '—';
    profSub.textContent = '';
  }

  // ROI ladder: PSA 7-10 ROIs for context
  const ladder = document.getElementById('acqLadder');
  if (psa10USD > 0) {
    const grades = [10, 9, 8, 7];
    const ladderMaterialsGBP = getGradingMaterialsCostGBP(card.i);
    const rows = grades.map(g => {
      const todayUSD = estimateGradePrice(card, g, psa10USD);
      const yr5USD = projectGradePrice(card, g, todayUSD, 5);
      const yr5GBP = usdToGbp(yr5USD);
      const gradingFee = getUkGradingFeeGBP(psa10USD) + ladderMaterialsGBP;
      const net = yr5GBP * (1 - FRICTION) - gradingFee;
      const r = costGBP > 0 ? ((net - costGBP) / costGBP) * 100 : null;
      const cls = r >= 200 ? 'acq-pos' : r < 0 ? 'acq-neg' : '';
      return `<div class="acq-rung ${cls}">
        <span class="acq-rung-g">PSA ${g}</span>
        <span class="acq-rung-val">${fmtGBPDirect(yr5GBP)}</span>
        <span class="acq-rung-roi">${fmtPct(r, true)}</span>
      </div>`;
    }).join('');
    ladder.innerHTML = `<div class="acq-ladder-head">If you grade this card and it lands at…</div>${rows}`;
    ladder.style.display = 'block';
  } else {
    ladder.style.display = 'none';
  }

  // Meta line
  const meta = document.getElementById('acqMeta');
  const acqDate = acq.ts ? new Date(acq.ts) : null;
  const acqLabel = acqDate ? `Logged ${acqDate.toLocaleDateString('en-GB')}` : '';
  const cardInPortfolio = (portfolio || []).some(p => p.id === card.i);
  meta.innerHTML = [
    acqLabel,
    cardInPortfolio ? '<span class="acq-pill">In collection</span>' : '<span class="acq-pill acq-pill-muted">Not in collection</span>'
  ].filter(Boolean).join(' · ');
}

function updateAcq(patch) {
  if (!selectedCard) return;
  const id = selectedCard.i;
  const current = acquisitions[id] || {};
  acquisitions[id] = { ...current, ...patch, ts: current.ts || Date.now() };
  saveAcquisitions();
  renderAcquisition();
  // Refresh portfolio rendering if this card is in it
  try { if (typeof renderPortfolio === 'function') renderPortfolio(); } catch {}
}

function clearAcq() {
  if (!selectedCard) return;
  delete acquisitions[selectedCard.i];
  saveAcquisitions();
  renderAcquisition();
  try { if (typeof renderPortfolio === 'function') renderPortfolio(); } catch {}
}

function setupAcquisition() {
  if (!document.getElementById('acqSection')) return;

  document.querySelectorAll('.acq-src-btn').forEach(b => {
    b.addEventListener('click', () => {
      const src = b.dataset.src;
      if (!selectedCard) return;
      if (src === 'clear') { clearAcq(); return; }
      updateAcq({ source: src });
    });
  });

  // Save & Sync button — immediate push to cloud without waiting for debounce
  const saveBtn = document.getElementById('acqSaveBtn');
  const ACQ_SAVE_HTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg> Save &amp; Sync`;
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.classList.contains('is-saving')) return;
      saveBtn.classList.add('is-saving');
      saveBtn.textContent = 'Syncing…';
      if (typeof syncCloudPush === 'function' && syncGetPairCode && syncGetPairCode()) {
        await syncCloudPush({});
      } else {
        await new Promise(r => setTimeout(r, 300));
      }
      saveBtn.classList.remove('is-saving');
      saveBtn.classList.add('is-saved');
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => {
        saveBtn.classList.remove('is-saved');
        saveBtn.innerHTML = ACQ_SAVE_HTML;
      }, 2500);
    });
  }

  // Live-update on input changes
  const wire = (id, key, parser) => {
    const el = document.getElementById(id);
    if (!el) return;
    const handler = () => {
      const v = parser ? parser(el.value) : el.value;
      updateAcq({ [key]: v });
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  };
  wire('acqPackName', 'packName');
  wire('acqPackCost', 'packCostGBP', v => v === '' ? '' : parseFloat(v));
  wire('acqPackHits', 'packHits', v => v === '' ? '' : parseInt(v, 10));
  wire('acqSinglePrice', 'singlePriceGBP', v => v === '' ? '' : parseFloat(v));
  wire('acqSingleDate', 'singleDate');
  wire('acqSingleSrc', 'singleWhere');
  wire('acqSlabGrade', 'slabGrade', v => v === '' ? '' : parseInt(v, 10));
  wire('acqSlabPrice', 'slabPriceGBP', v => v === '' ? '' : parseFloat(v));
  wire('acqSlabDate', 'slabDate');
  wire('acqSlabWhere', 'slabWhere');
  // Slab grade/price changes affect the Hold Strategy tile labels & cost basis.
  ['acqSlabGrade', 'acqSlabPrice'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (selectedCard && typeof renderHoldStrategy === 'function') {
        try { renderHoldStrategy(selectedCard); } catch {}
      }
    });
  });

  // Storage materials checkboxes
  const wireCheck = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      updateAcq({ [key]: el.checked });
      if (selectedCard && typeof renderHoldStrategy === 'function') {
        try { renderHoldStrategy(selectedCard); } catch {}
      }
    });
  };
  wireCheck('acqHasSleeve', 'hasPennySleeve');
  wireCheck('acqHasToploader', 'hasToploader');
}

// =============================================================
// Card Condition Scanner
// =============================================================
const PSA_GRADE_LABELS = {
  10: 'Gem Mint', 9: 'Mint', 8: 'NM-MT', 7: 'Near Mint',
  6: 'EX-MT', 5: 'Excellent', 4: 'VG-EX', 3: 'Very Good', 2: 'Good', 1: 'Poor',
};
const ACE_GRADE_LABELS = {
  10: 'Gem Mint', 9.5: 'Mint+', 9: 'Mint', 8.5: 'NM-MT+',
  8: 'NM-MT', 7: 'Near Mint', 6: 'Excellent', 5: 'Very Good',
};

let _cgScores = { centering: null, corners: null, edges: null, surface: null };

function _cgCalcGrade() {
  const vals = Object.values(_cgScores).filter(v => v != null);
  if (vals.length < 4) return null;
  const min = Math.min(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (min >= 10) return 10;
  if (min >= 8 && avg >= 9.5) return 10;
  if (min >= 8 && avg >= 8.5) return 9;
  if (min >= 8) return 8;
  if (min >= 6 && avg >= 7.5) return 7;
  if (min >= 6) return 6;
  if (min >= 4 && avg >= 6) return 5;
  return 4;
}

// ACE uses half-grade increments (9.5, 8.5) — same criteria, more granularity.
// Thresholds reflect that a card scoring "three 10s one 8" is a borderline 10
// (ACE 9.5) rather than falling to PSA 9. Not fundamentally stricter than PSA.
function _cgCalcAceGrade() {
  const vals = Object.values(_cgScores).filter(v => v != null);
  if (vals.length < 4) return null;
  const min = Math.min(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (min >= 10) return 10;
  if (min >= 8 && avg >= 9.5) return 10;   // all criteria excellent, one minor → same as PSA 10
  if (min >= 8 && avg >= 9.0) return 9.5;  // "strong 9" — PSA rounds to 9, ACE captures it
  if (min >= 8 && avg >= 8.5) return 9;
  if (min >= 8) return 8.5;                // all 8s → solid but one clear issue
  if (min >= 6 && avg >= 7.5) return 8;
  if (min >= 6) return 7;
  if (min >= 4 && avg >= 6) return 6;
  return 5;
}

function _cgUpdateResult() {
  const psaGrade = _cgCalcGrade();
  const aceGrade = _cgCalcAceGrade();
  const resultEl = document.getElementById('cgResult');
  if (!resultEl) return;
  if (psaGrade == null) { resultEl.style.display = 'none'; return; }
  resultEl.style.display = 'block';

  document.getElementById('cgGradeNum').textContent    = psaGrade;
  const aceEl = document.getElementById('cgAceGradeNum');
  if (aceEl) aceEl.textContent = aceGrade != null ? aceGrade : '—';

  document.getElementById('cgGradeLabel').textContent =
    `PSA: ${PSA_GRADE_LABELS[psaGrade] || ''} · ACE: ${ACE_GRADE_LABELS[aceGrade] || ''}`;

  const issues = [];
  if (_cgScores.centering != null && _cgScores.centering < 10) issues.push(`centering (${_cgScores.centering < 6 ? 'miscut' : _cgScores.centering < 8 ? 'noticeable' : 'slight'})`);
  if (_cgScores.corners  != null && _cgScores.corners  < 10) issues.push('corners');
  if (_cgScores.edges    != null && _cgScores.edges    < 10) issues.push('edges');
  if (_cgScores.surface  != null && _cgScores.surface  < 10) issues.push('surface');
  let notes = '';
  if (issues.length === 0)   notes = 'All criteria perfect — strong PSA 10 / ACE 10 candidate.';
  else if (psaGrade >= 9)    notes = `Minor issues on ${issues.join(', ')} — clean submission for either service.`;
  else if (psaGrade >= 7)    notes = `Held back by ${issues.join(' and ')} — grade carefully; ACE's lower fee reduces downside.`;
  else                       notes = `Multiple issues on ${issues.join(', ')} — grading not worth the fee at this condition.`;
  document.getElementById('cgGradeNotes').textContent = notes;
}

function _cgShowPicker(imgs) {
  const wrap = document.getElementById('cgPickerWrap');
  const grid = document.getElementById('cgPickerGrid');
  if (!wrap || !grid) return;

  // Track which index is assigned to each slot
  const assigned = { Front: -1, Back: -1 };

  function refreshBadges() {
    grid.querySelectorAll('.cg-pick-item').forEach(item => {
      const idx = +item.dataset.idx;
      const badge = item.querySelector('.cg-pick-badge');
      const frontBtn = item.querySelector('[data-slot="Front"]');
      const backBtn = item.querySelector('[data-slot="Back"]');
      const label = idx === assigned.Front && idx === assigned.Back ? 'Front + Back'
                  : idx === assigned.Front ? 'Front'
                  : idx === assigned.Back  ? 'Back'
                  : '';
      badge.textContent = label;
      badge.style.display = label ? 'block' : 'none';
      if (frontBtn) frontBtn.classList.toggle('is-active', idx === assigned.Front);
      if (backBtn)  backBtn.classList.toggle('is-active', idx === assigned.Back);
    });
  }

  grid.innerHTML = imgs.map((src, i) => `
    <div class="cg-pick-item" data-idx="${i}">
      <img class="cg-pick-thumb" src="${src}" alt="Image ${i + 1}" loading="lazy">
      <div class="cg-pick-btns">
        <button class="cg-pick-btn" data-slot="Front" type="button">Front</button>
        <button class="cg-pick-btn" data-slot="Back" type="button">Back</button>
      </div>
      <div class="cg-pick-badge" style="display:none"></div>
    </div>`).join('');

  grid.querySelectorAll('.cg-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = +btn.closest('.cg-pick-item').dataset.idx;
      const slot = btn.dataset.slot;
      if (assigned[slot] === idx) {
        assigned[slot] = -1;
        _cgSetImg(slot, null);
      } else {
        assigned[slot] = idx;
        _cgSetImg(slot, imgs[idx]);
      }
      refreshBadges();
    });
  });

  wrap.style.display = 'block';
  refreshBadges();
}

function _cgSetImg(side, src) {
  const preview = document.getElementById(`cg${side}Preview`);
  const empty = document.getElementById(`cg${side}Empty`);
  const img = document.getElementById(`cg${side}Img`);
  if (!src) {
    preview.style.display = 'none';
    empty.style.display = 'flex';
    img.src = '';
    img.removeAttribute('data-cg-loaded');
  } else {
    img.src = src;
    img.setAttribute('data-cg-loaded', '1');
    preview.style.display = 'block';
    empty.style.display = 'none';
  }
  // Show criteria only once at least one image is loaded
  const hasImage = !!document.getElementById('cgFrontImg')?.getAttribute('data-cg-loaded')
                || !!document.getElementById('cgBackImg')?.getAttribute('data-cg-loaded');
  const criteria = document.getElementById('cgCriteriaWrap');
  if (criteria) criteria.style.display = hasImage ? 'block' : 'none';
}

function renderCardGrader() {
  const sec = document.getElementById('cardGraderSection');
  if (!sec) return;
  if (!selectedCard) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';

  // Load saved scores
  const acq = getAcq(selectedCard.i) || {};
  _cgScores = acq.cgScores ? { ..._cgScores, ...acq.cgScores } : { centering: null, corners: null, edges: null, surface: null };

  // Restore criterion button states
  document.querySelectorAll('.cg-crit').forEach(critEl => {
    const crit = critEl.dataset.crit;
    critEl.querySelectorAll('.cg-opt').forEach(btn => {
      btn.classList.toggle('is-active', +btn.dataset.score === _cgScores[crit]);
    });
  });

  // Clear images on card switch — also hides criteria until new image is loaded
  _cgSetImg('Front', null);
  _cgSetImg('Back', null);
  const cgWrap = document.getElementById('cgCriteriaWrap');
  if (cgWrap) cgWrap.style.display = 'none';
  const urlInput = document.getElementById('cgEbayUrl');
  if (urlInput) urlInput.value = '';
  const status = document.getElementById('cgEbayStatus');
  if (status) { status.style.display = 'none'; status.textContent = ''; }
  const pickerWrap = document.getElementById('cgPickerWrap');
  if (pickerWrap) { pickerWrap.style.display = 'none'; }
  const verdictEl = document.getElementById('cgVerdict');
  if (verdictEl) verdictEl.textContent = '';
  const gradeStatus = document.getElementById('cgGradeStatus');
  if (gradeStatus) { gradeStatus.textContent = ''; gradeStatus.className = 'cg-grade-status'; }

  _cgUpdateResult();

  // Update save button if already saved
  const saveBtn = document.getElementById('cgSaveGrade');
  if (saveBtn) {
    saveBtn.classList.remove('is-saved');
    if (acq.expectedGrade) saveBtn.textContent = `Saved: expected PSA ${acq.expectedGrade} — update`;
    else saveBtn.textContent = 'Save expected grade · update Hold Strategy';
  }
}

async function cgGradeCard() {
  const gradeBtn = document.getElementById('cgGradeBtn');
  const statusEl = document.getElementById('cgGradeStatus');
  if (gradeBtn) { gradeBtn.disabled = true; gradeBtn.textContent = 'Grading…'; }
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'cg-grade-status'; }

  try {
    const frontImg = document.getElementById('cgFrontImg');
    const backImg = document.getElementById('cgBackImg');
    const img = frontImg?.getAttribute('data-cg-loaded') ? frontImg : backImg;
    if (!img?.getAttribute('data-cg-loaded')) throw new Error('Load an image first.');

    let payload;
    if (img.src.startsWith('data:')) {
      const comma = img.src.indexOf(',');
      const mimeType = img.src.slice(5, img.src.indexOf(';'));
      payload = { imageB64: img.src.slice(comma + 1), mimeType };
    } else if (img.src.startsWith('blob:')) {
      const fetched = await fetch(img.src);
      const blob = await fetched.blob();
      const b64 = await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.readAsDataURL(blob);
      });
      payload = { imageB64: b64, mimeType: blob.type || 'image/jpeg' };
    } else {
      payload = { imageUrl: img.src };
    }

    const resp = await fetch(`${MKT_WORKER_DEFAULT}/grade-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      let msg = txt; try { msg = JSON.parse(txt).error || txt; } catch {}
      throw new Error(msg || `Worker returned ${resp.status}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    // Auto-select criteria buttons
    ['centering', 'corners', 'edges', 'surface'].forEach(crit => {
      const score = data[crit];
      if (!score) return;
      _cgScores[crit] = score;
      const critEl = document.querySelector(`.cg-crit[data-crit="${crit}"]`);
      critEl?.querySelectorAll('.cg-opt').forEach(b => b.classList.toggle('is-active', +b.dataset.score === score));
    });
    _cgUpdateResult();

    const verdictEl = document.getElementById('cgVerdict');
    if (verdictEl) verdictEl.textContent = data.verdict || '';
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message; statusEl.className = 'cg-grade-status is-error'; }
  } finally {
    if (gradeBtn) { gradeBtn.disabled = false; gradeBtn.textContent = 'Grade'; }
  }
}

function setupCardGrader() {
  if (!document.getElementById('cardGraderSection')) return;

  // Image slot wiring
  ['Front', 'Back'].forEach(side => {
    const cameraBtn = document.getElementById(`cg${side}CameraBtn`);
    const uploadBtn = document.getElementById(`cg${side}UploadBtn`);
    const cameraInput = document.getElementById(`cg${side}Camera`);
    const fileInput = document.getElementById(`cg${side}File`);
    const clearBtn = document.getElementById(`cg${side}Clear`);

    cameraBtn?.addEventListener('click', () => cameraInput?.click());
    uploadBtn?.addEventListener('click', () => fileInput?.click());

    const handleFile = (file) => {
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = e => _cgSetImg(side, e.target.result);
      reader.readAsDataURL(file);
    };
    cameraInput?.addEventListener('change', e => handleFile(e.target.files[0]));
    fileInput?.addEventListener('change', e => handleFile(e.target.files[0]));
    clearBtn?.addEventListener('click', () => _cgSetImg(side, null));
  });

  // Criteria button wiring
  document.querySelectorAll('.cg-crit').forEach(critEl => {
    const crit = critEl.dataset.crit;
    critEl.querySelectorAll('.cg-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const score = +btn.dataset.score;
        _cgScores[crit] = _cgScores[crit] === score ? null : score;
        critEl.querySelectorAll('.cg-opt').forEach(b => b.classList.toggle('is-active', +b.dataset.score === _cgScores[crit]));
        _cgUpdateResult();
      });
    });
  });

  // eBay URL fetch
  document.getElementById('cgEbayFetch')?.addEventListener('click', async () => {
    const urlInput = document.getElementById('cgEbayUrl');
    const status = document.getElementById('cgEbayStatus');
    const btn = document.getElementById('cgEbayFetch');
    const raw = (urlInput?.value || '').trim();
    if (!raw) return;
    btn.classList.add('is-loading');
    btn.textContent = 'Fetching…';
    status.style.display = 'block';
    status.className = 'cg-ebay-status';
    status.textContent = 'Fetching images from eBay…';
    try {
      const resp = await fetch(`${MKT_WORKER_DEFAULT}/img-proxy?url=${encodeURIComponent(raw)}`);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(txt.trim() || `Worker returned ${resp.status}`);
      }
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const imgs = data.images || [];
      if (!imgs.length) throw new Error('No images found in this listing.');
      const pickerWrap = document.getElementById('cgPickerWrap');
      if (imgs.length <= 2) {
        if (pickerWrap) pickerWrap.style.display = 'none';
        _cgSetImg('Front', imgs[0]);
        if (imgs[1]) _cgSetImg('Back', imgs[1]);
      } else {
        _cgShowPicker(imgs);
      }
      status.textContent = `${imgs.length} image${imgs.length > 1 ? 's' : ''} found${imgs.length > 2 ? ' — select Front and Back below' : ''}${data.title ? ` · ${data.title.slice(0, 55)}` : ''}.`;
      // Show inline deal check; pre-fill price if returned (GBP listings) or convert USD
      const dealRow = document.getElementById('cgDealRow');
      const cgPriceInput = document.getElementById('cgEbayPrice');
      if (dealRow) dealRow.style.display = 'block';
      if (cgPriceInput && data.price) {
        const priceVal = parseFloat(data.price.value) || 0;
        const currency = (data.price.currency || 'GBP').toUpperCase();
        const gbp = currency === 'GBP' ? priceVal : (currency === 'USD' ? usdToGbp(priceVal) : priceVal);
        cgPriceInput.value = gbp > 0 ? gbp.toFixed(2) : '';
      }
    } catch (err) {
      status.className = 'cg-ebay-status is-error';
      status.textContent = err.message || 'Failed to fetch images.';
    } finally {
      btn.classList.remove('is-loading');
      btn.textContent = 'Fetch';
    }
  });

  // Inline deal check button
  document.getElementById('cgDealCheckBtn')?.addEventListener('click', () => {
    const priceGBP = parseFloat(document.getElementById('cgEbayPrice')?.value) || 0;
    const resultEl = document.getElementById('cgDealResult');
    if (!resultEl) return;
    if (!priceGBP || priceGBP <= 0) { resultEl.innerHTML = ''; return; }
    const refUSD = selectedCard
      ? Math.min(lastModelPriceUSD || getCurrentPrice(selectedCard), getCurrentPrice(selectedCard))
      : lastModelPriceUSD;
    const refGBP = usdToGbp(refUSD);
    const diff = refGBP - priceGBP;
    const pct = refGBP > 0 ? ((diff / priceGBP) * 100).toFixed(0) : 0;
    let cls, verdict, note;
    if (diff > refGBP * 0.05) {
      cls = 'good-deal'; verdict = 'Good Deal';
      note = `${pct}% below fair value (ref: £${refGBP.toFixed(2)})`;
    } else if (diff < -refGBP * 0.05) {
      cls = 'bad-deal'; verdict = 'Overpriced';
      note = `${Math.abs(pct)}% above fair value (ref: £${refGBP.toFixed(2)})`;
    } else {
      cls = 'fair-deal'; verdict = 'Fair Price';
      note = `Within 5% of fair value (ref: £${refGBP.toFixed(2)})`;
    }
    resultEl.innerHTML = `<span class="deal-verdict ${cls}">${verdict}</span><span class="deal-note">${note}</span>`;
  });

  // AI grade button
  document.getElementById('cgGradeBtn')?.addEventListener('click', cgGradeCard);

  // Save grade
  document.getElementById('cgSaveGrade')?.addEventListener('click', () => {
    if (!selectedCard) return;
    const grade    = _cgCalcGrade();
    const aceGrade = _cgCalcAceGrade();
    if (grade == null) return;
    const btn = document.getElementById('cgSaveGrade');
    updateAcq({ cgScores: { ..._cgScores }, expectedGrade: grade, expectedAceGrade: aceGrade });
    btn.classList.add('is-saved');
    btn.textContent = `Saved: PSA ~${grade} · ACE ~${aceGrade ?? '?'} — update`;
    setTimeout(() => btn.classList.remove('is-saved'), 2000);
    // Re-render hold strategy immediately
    if (typeof renderHoldStrategy === 'function' && selectedCard) {
      try { renderHoldStrategy(selectedCard); } catch {}
    }
  });
}

// =============================================================
// PSA 10 anchor estimator
// =============================================================
// Many cards in the catalog don't have a tracked PSA 10 sale price (card.p10),
// and live PriceCharting fetches don't always return one either. Without an
// anchor, the Hold Strategy and PSA Grade Range sections can't compute
// projections and end up hidden. Instead, estimate PSA 10 from raw market
// using rarity-based multipliers, and surface a clear "estimated" badge so
// the user knows the precision is lower.

// Median PSA 10 / raw market ratios observed across modern Pokémon sets.
// Vintage cards usually exceed these by 2-10× — those almost always have a
// tracked card.p10 so the estimator is rarely used for them.
const PSA10_FROM_RAW = {
  SIR: 2.8,  // Special Illustration Rare — premium chase
  SAR: 2.6,  // Special Art Rare
  UR:  2.4,  // Ultra Rare (gold)
  HR:  2.4,  // Hyper Rare (rainbow)
  SR:  2.2,  // Secret Rare
  RR:  1.8,  // Double Rare
  IR:  2.2,  // Illustration Rare
  AR:  2.0,  // Art Rare
  CSR: 2.2,  // Character SR
  CHR: 1.8,  // Character Rare
  SHR: 2.5,
  MHR: 2.5,
  SHUR:2.6,
  DR:  1.6,
  AS:  1.8,
  PR:  1.8,
  R:   1.5,
  U:   1.4,
  C:   1.3,
  '':  1.6,
};

// Returns { usd, source } where source is:
//   'tracked'   — card.p10 from our static catalog (most accurate)
//   'live'      — PriceCharting PSA 10 from a live fetch (very accurate)
//   'estimated' — derived from raw market × rarity multiplier (±30% rule of thumb)
//   'none'      — could not determine an anchor
function getPsa10Anchor(card) {
  if (!card) return { usd: 0, source: 'none' };
  // Live PriceCharting PSA 10 takes priority for the currently-selected card
  if (typeof livePrice !== 'undefined' && livePrice
      && selectedCard && card.i === selectedCard.i
      && livePrice.pcPsa10 > 0) {
    return { usd: livePrice.pcPsa10, source: 'live' };
  }
  // Live cache for non-selected card
  const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(card.i) : null;
  if (cached && cached.pcPsa10 > 0) return { usd: cached.pcPsa10, source: 'live' };
  // Fall back to static database value
  if (card.p10 && card.p10 > 0) return { usd: card.p10, source: 'tracked' };
  // Estimate from raw × rarity multiplier
  // User-entered JP PSA 10 override (from EN↔JP scenario panel)
  const jpManual = (typeof getJpPsa10Override === 'function') ? getJpPsa10Override(card.i) : null;
  if (jpManual && jpManual.gbp > 0) {
    const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
    return { usd: jpManual.gbp / fx, source: 'manual-override', date: jpManual.date };
  }
  const raw = (typeof getCurrentPrice === 'function') ? getCurrentPrice(card) : (card.p || 0);
  if (raw > 0) {
    const mult = PSA10_FROM_RAW[card.rc] || PSA10_FROM_RAW[''];
    return { usd: raw * mult, source: 'estimated', multiplier: mult };
  }
  return { usd: 0, source: 'none' };
}

// Returns { usd, source } where source is:
//   'live'      — PriceCharting ACE 10 from a live fetch (only reliable source)
//   'cached'    — PriceCharting ACE 10 from a background-cached fetch
//   'none'      — PC has no ACE 10 comp for this card; caller should fall back
// Unlike PSA 10 there is no static catalog value and no reliable multiplier
// (ACE tracks ~70% of PSA 10 across the market but the variance is too large
// to synthesize a per-card estimate). ACE mode falls back to raw-based projection
// when no anchor is available.
function getAce10Anchor(card) {
  if (!card) return { usd: 0, source: 'none' };
  // Live PriceCharting ACE 10 for the currently-selected card
  if (typeof livePrice !== 'undefined' && livePrice
      && selectedCard && card.i === selectedCard.i
      && livePrice.pcAce10 > 0) {
    return { usd: livePrice.pcAce10, source: 'live' };
  }
  // Cached fetch for non-selected card
  const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(card.i) : null;
  if (cached && cached.pcAce10 > 0) return { usd: cached.pcAce10, source: 'cached' };
  return { usd: 0, source: 'none' };
}

// =============================================================
// Per-card Price Insight — sparkline + buy-window verdict
// =============================================================
// For every card in your Portfolio and Wishlist you can open an
// inline history graph. The chart marks:
//   ★  the historical low ("ideal buy point" — even if missed)
//   ▲  the historical high
//   ●  where the current price sits
// And we surface one of six verdicts, designed around your ask:
//   ✓ GOOD ENTRY        — near the floor, stable or stabilising
//   ⏳ WAIT — FALLING    — still trending down; cheaper days ahead
//   🔴 TOO LATE          — near the peak with momentum; chasing risk
//   ⚡ PUMPING — RISKY   — vertical move; mean-reversion likely
//   ⚠ MISSED THE BOTTOM — well above floor but off the peak; fair
//   · FAIR PRICE         — sideways, you're paying close to fair value

const PI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h cache
const PI_CACHE_PREFIX = 'pkm-hist-v1-';

function piCacheGet(cardId) {
  try {
    const raw = localStorage.getItem(PI_CACHE_PREFIX + cardId);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || !c.ts || (Date.now() - c.ts) > PI_CACHE_TTL_MS) return null;
    return c.history;
  } catch { return null; }
}
function piCacheSet(cardId, history) {
  try { localStorage.setItem(PI_CACHE_PREFIX + cardId, JSON.stringify({ ts: Date.now(), history })); } catch {}
}

// Fetch and normalise the price history series for a card.
// We reuse the same mycollectrics endpoint the main card view uses,
// but only keep date + raw price (USD) to keep the cache small.
async function piFetchHistory(cardId) {
  const cached = piCacheGet(cardId);
  if (cached) return cached;
  const apiUrl = `https://mycollectrics.com/api/card/${cardId}?include=ebay`;
  const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(apiUrl)}`;
  const r = await fetch(proxyUrl);
  if (!r.ok) throw new Error('history fetch failed (' + r.status + ')');
  const d = await r.json();
  const raw = Array.isArray(d.history) ? d.history : [];
  const cleaned = raw
    .filter(h => h && h.date && h['raw-price'] > 0)
    .map(h => ({ date: h.date, raw: +h['raw-price'] }))
    .sort((a, b) => a.date.localeCompare(b.date));
  piCacheSet(cardId, cleaned);
  return cleaned;
}

// Analyse the series and produce a buy-window verdict.
function piAnalyse(history, currentUsd) {
  if (!Array.isArray(history) || history.length < 5) return null;
  const sorted = history.slice().sort((a, b) => a.date.localeCompare(b.date));
  const prices = sorted.map(p => p.raw);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const minIdx = prices.indexOf(minP);
  const maxIdx = prices.indexOf(maxP);
  const lastInHist = prices[prices.length - 1];
  const last = (currentUsd && currentUsd > 0) ? currentUsd : lastInHist;

  const fromLow  = ((last - minP) / minP) * 100;
  const fromHigh = ((last - maxP) / maxP) * 100;

  const nowT = new Date(sorted[sorted.length - 1].date).getTime();
  function idxBefore(days) {
    const target = nowT - days * 86400000;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (new Date(sorted[i].date).getTime() <= target) return i;
    }
    return 0;
  }
  const i7  = idxBefore(7);
  const i30 = idxBefore(30);
  const i90 = idxBefore(90);
  const pct = (a, b) => ((a - b) / b) * 100;
  const d7  = pct(last, sorted[i7].raw);
  const d30 = pct(last, sorted[i30].raw);
  const d90 = pct(last, sorted[i90].raw);

  // Verdict ladder
  let label, cls, summary, action;
  if (d7 < -3 && d30 < -5 && fromHigh < -15) {
    label = '⏳ WAIT — STILL FALLING';
    cls = 'pi-wait';
    action = 'Wait';
    summary = `Down <strong>${d7.toFixed(1)}%</strong> in 7d and <strong>${d30.toFixed(1)}%</strong> in 30d. Trend still pointing down — likely cheaper soon. Set a wishlist target near the recent low.`;
  } else if (fromHigh > -5 && (d7 > 3 || d30 > 10)) {
    label = '🔴 TOO LATE — AT PEAK';
    cls = 'pi-late';
    action = 'Skip';
    summary = `Within <strong>${Math.abs(fromHigh).toFixed(1)}%</strong> of the all-time high with <strong>+${d30.toFixed(1)}%</strong> over 30d. Buying here means chasing the top — wait for a pullback of at least 10–15%.`;
  } else if (fromLow < 15 && d7 > -3 && d30 > -10) {
    label = '✓ GOOD ENTRY';
    cls = 'pi-good';
    action = 'Buy';
    summary = `Sitting just <strong>${fromLow.toFixed(1)}%</strong> above the range low (${fmtGBP(minP)}) and stabilising (7d ${d7 >= 0 ? '+' : ''}${d7.toFixed(1)}%). Good time to buy.`;
  } else if (d7 > 12) {
    label = '⚡ PUMPING — RISKY';
    cls = 'pi-pump';
    action = 'Wait a week';
    summary = `Up <strong>+${d7.toFixed(1)}%</strong> in 7d. Vertical moves usually retrace 5–10% within a week or two — be patient unless you must own it now.`;
  } else if (fromLow >= 15 && fromHigh < -8) {
    label = '⚠ MISSED THE BOTTOM';
    cls = 'pi-missed';
    action = 'Fair';
    summary = `<strong>${fromLow.toFixed(1)}%</strong> above the floor and <strong>${Math.abs(fromHigh).toFixed(1)}%</strong> off the peak. The ideal entry was at ${fmtGBP(minP)} — still a reasonable buy if you want it long-term, but no urgency.`;
  } else {
    label = '· FAIR PRICE';
    cls = 'pi-fair';
    action = 'Neutral';
    summary = `Sideways action: <strong>${d30 >= 0 ? '+' : ''}${d30.toFixed(1)}%</strong> in 30d, <strong>${d7 >= 0 ? '+' : ''}${d7.toFixed(1)}%</strong> in 7d. You're paying close to fair value either way.`;
  }

  return {
    label, cls, summary, action,
    min: { idx: minIdx, price: minP, date: sorted[minIdx].date },
    max: { idx: maxIdx, price: maxP, date: sorted[maxIdx].date },
    last, lastDate: sorted[sorted.length - 1].date,
    fromLow, fromHigh, d7, d30, d90,
    sorted,
  };
}

// SVG sparkline. We render markers separately so the verdict label sits
// outside the SVG and never collides with the line.
function piRenderSparkline(an) {
  const W = 280, H = 64, PAD = 6, AXIS = 0;
  const sorted = an.sorted;
  const prices = sorted.map(p => p.raw);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const range = (maxP - minP) || 1;
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2 - AXIS;
  const stepX = plotW / (prices.length - 1);
  const pt = (i) => [PAD + i * stepX, PAD + plotH - ((prices[i] - minP) / range) * plotH];

  let linePath = '';
  for (let i = 0; i < prices.length; i++) {
    const [x, y] = pt(i);
    linePath += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  }
  const [endX] = pt(prices.length - 1);
  const [startX] = pt(0);
  const areaPath = linePath + `L${endX.toFixed(1)},${(PAD + plotH).toFixed(1)} L${startX.toFixed(1)},${(PAD + plotH).toFixed(1)} Z`;

  const [lowX, lowY]   = pt(an.min.idx);
  const [highX, highY] = pt(an.max.idx);
  const [nowX,  nowY]  = pt(prices.length - 1);

  return `
  <svg class="pi-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price history sparkline">
    <path d="${areaPath}" fill="var(--accent)" fill-opacity="0.10"/>
    <path d="${linePath}" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
    <line x1="${nowX.toFixed(1)}" y1="${(PAD).toFixed(1)}" x2="${nowX.toFixed(1)}" y2="${(PAD + plotH).toFixed(1)}" stroke="var(--accent)" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.4"/>
    <circle cx="${highX.toFixed(1)}" cy="${highY.toFixed(1)}" r="3.5" fill="var(--red)" stroke="var(--bg)" stroke-width="1.5"/>
    <circle cx="${lowX.toFixed(1)}" cy="${lowY.toFixed(1)}" r="4" fill="var(--green)" stroke="var(--bg)" stroke-width="1.5"/>
    <text x="${lowX.toFixed(1)}" y="${(lowY - 6).toFixed(1)}" text-anchor="${lowX > W * 0.7 ? 'end' : (lowX < W * 0.3 ? 'start' : 'middle')}" font-size="9" font-weight="700" fill="var(--green)">★ BUY</text>
    <circle cx="${nowX.toFixed(1)}" cy="${nowY.toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="1.5"/>
  </svg>`;
}

function piFmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }); }
  catch { return iso; }
}

function piRenderInsight(history, currentUsd) {
  const an = piAnalyse(history, currentUsd);
  if (!an) {
    return `<div class="pi-panel-error">Not enough price history yet (need 5+ data points).</div>`;
  }
  const spark = piRenderSparkline(an);
  return `
    <div class="pi-verdict-row">
      <span class="pi-verdict-pill ${an.cls}">${an.label}</span>
      <span class="pi-deltas">
        <span class="pi-d ${an.d7  >= 0 ? 'pos' : 'neg'}">7d ${an.d7  >= 0 ? '+' : ''}${an.d7.toFixed(1)}%</span>
        <span class="pi-d ${an.d30 >= 0 ? 'pos' : 'neg'}">30d ${an.d30 >= 0 ? '+' : ''}${an.d30.toFixed(1)}%</span>
        <span class="pi-d ${an.d90 >= 0 ? 'pos' : 'neg'}">90d ${an.d90 >= 0 ? '+' : ''}${an.d90.toFixed(1)}%</span>
      </span>
    </div>
    <div class="pi-chart-wrap">${spark}</div>
    <div class="pi-markers-legend">
      <span><span class="dot dot-low"></span>Best buy ${fmtGBP(an.min.price)} · ${piFmtDate(an.min.date)}</span>
      <span><span class="dot dot-high"></span>Peak ${fmtGBP(an.max.price)} · ${piFmtDate(an.max.date)}</span>
      <span><span class="dot dot-now"></span>Now ${fmtGBP(an.last)}</span>
    </div>
    <div class="pi-summary">${an.summary}</div>
  `;
}

async function piLoadAndRender(cardId, panel, currentUsd) {
  panel.innerHTML = `<div class="pi-panel-loading">Loading history…</div>`;
  try {
    const history = await piFetchHistory(cardId);
    if (!history || history.length < 5) {
      panel.innerHTML = `<div class="pi-panel-error">No price history available for this card.</div>`;
      return;
    }
    panel.innerHTML = piRenderInsight(history, currentUsd);
  } catch (e) {
    console.warn('Price insight failed for', cardId, e);
    panel.innerHTML = `<div class="pi-panel-error">Couldn't load history. Try again later.</div>`;
  }
}

// Wires up every .pi-toggle / .pi-panel pair under a container.
// Call after every renderPortfolio() / renderWishlist().
function piWireToggles(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.pi-toggle').forEach(btn => {
    if (btn.dataset.piWired === '1') return;
    btn.dataset.piWired = '1';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.dataset.id;
      const card = btn.closest('.portfolio-item-card, .wishlist-item-card, .pi-host');
      if (!card) return;
      const panel = card.querySelector(':scope > .pi-panel[data-id="' + id + '"]');
      if (!panel) return;
      const isOpen = panel.classList.contains('open');
      if (isOpen) {
        panel.classList.remove('open');
        btn.classList.remove('active');
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      panel.classList.add('open');
      btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
      // If already rendered, skip the fetch
      if (panel.dataset.piLoaded === '1') return;
      const currentUsd = parseFloat(btn.dataset.currentUsd || '0') || 0;
      await piLoadAndRender(id, panel, currentUsd);
      panel.dataset.piLoaded = '1';
    });
  });
}

// Returns the HTML to inject inside each row item.
// Includes the toggle button and the (initially closed) insight panel.
function piRenderButton(cardId, currentUsd) {
  return `<button class="pi-toggle" data-id="${cardId}" data-current-usd="${currentUsd || 0}" title="Show price history and buy-window verdict" aria-expanded="false">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>
    Graph
  </button>`;
}
function piRenderPanel(cardId) {
  return `<div class="pi-panel" data-id="${cardId}"></div>`;
}

// "Load all graphs" — fetches history for every visible toggle with
// concurrency 3 so we don't hammer the proxy.
async function piLoadAllInContainer(rootEl, statusEl) {
  if (!rootEl) return;
  const toggles = Array.from(rootEl.querySelectorAll('.pi-toggle'));
  if (toggles.length === 0) return;
  let done = 0;
  const total = toggles.length;
  if (statusEl) statusEl.textContent = `Loading 0 / ${total}…`;
  const queue = toggles.slice();
  const CONCURRENCY = 3;
  async function worker() {
    while (queue.length) {
      const btn = queue.shift();
      const id = btn.dataset.id;
      const card = btn.closest('.portfolio-item-card, .wishlist-item-card, .pi-host');
      const panel = card && card.querySelector(':scope > .pi-panel[data-id="' + id + '"]');
      if (!panel) { done++; continue; }
      panel.classList.add('open');
      btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
      if (panel.dataset.piLoaded !== '1') {
        const currentUsd = parseFloat(btn.dataset.currentUsd || '0') || 0;
        try { await piLoadAndRender(id, panel, currentUsd); panel.dataset.piLoaded = '1'; }
        catch {}
      }
      done++;
      if (statusEl) statusEl.textContent = `Loading ${done} / ${total}…`;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  if (statusEl) statusEl.textContent = `Loaded ${done} graphs`;
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
}

function setupPriceInsight() {
  // Wire the "Load all" buttons (one per panel that has them).
  const wireLoadAll = (btnId, containerId, statusId) => {
    const btn = document.getElementById(btnId);
    const container = document.getElementById(containerId);
    if (!btn || !container) return;
    btn.addEventListener('click', () => piLoadAllInContainer(container, statusId ? document.getElementById(statusId) : null));
  };
  wireLoadAll('portfolioLoadAllGraphs', 'portfolioList', 'portfolioLoadAllStatus');
  wireLoadAll('wishlistLoadAllGraphs',  'wishlistList',  'wishlistLoadAllStatus');

  // ROI chart toggle
  document.getElementById('portfolioRoiBtn')?.addEventListener('click', () => {
    const sec = document.getElementById('portfolioRoiSection');
    if (!sec) return;
    const visible = sec.style.display !== 'none';
    sec.style.display = visible ? 'none' : 'block';
    if (!visible) renderRoiChart();
  });

  // Signal badge tap (mobile — toggle tooltip)
  document.getElementById('signalBadge')?.addEventListener('click', () => {
    if (!window.matchMedia('(hover: hover)').matches) {
      document.getElementById('signalWrap')?.classList.toggle('is-expanded');
    }
  });

  // Deal toast buttons
  document.getElementById('dealToastClose')?.addEventListener('click', hideDealToast);
  document.getElementById('dealToastDismiss')?.addEventListener('click', hideDealToast);
  document.getElementById('dealToastView')?.addEventListener('click', () => {
    if (_dealToastUrl) openExternalUrl(_dealToastUrl);
    hideDealToast();
  });
  document.getElementById('dealToastOpen')?.addEventListener('click', () => {
    if (!_dealToastCard) return;
    hideDealToast();
    selectCard(_dealToastCard.i);
    document.querySelector('.page-nav-btn[data-page="predict"]')?.click();
  });

  // Show deal history badge if there's existing history from previous sessions
  _updateDealHistoryBadge();

  // Start background eBay deal polling
  startDealPolling();

  // In iOS standalone PWA, intercept all external <a> clicks to avoid the
  // stuck-white-page caused by Universal Links opening SFSafariViewController.
  if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('http')) return;
      e.preventDefault();
      window.location.href = href;
    }, true);
  }

  // Drag-resize layout
  initLayoutResizer();
}

// =============================================================
// Ask-the-Predictor — in-app AI chatbot
// =============================================================
// A floating "Ask AI" widget that knows about your portfolio,
// wishlist, watchlist and the cards you've recently viewed, and
// can answer freeform questions about the market, what's
// underrated, what to grade, what to sell, etc.
//
// Key choices:
//   - Your API key never leaves the browser. We POST directly
//     to your chosen provider (Perplexity Sonar by default).
//   - Each turn we rebuild a fresh context summary from your
//     local data so answers reflect the latest state.
//   - We also pre-rank candidate picks with our existing scanner
//     so the bot has solid data to reason over when asked.

const AI_KEY_STORAGE   = 'pkm-ai-chat-key-v1';
const AI_PROV_STORAGE  = 'pkm-ai-chat-provider-v1';
const AI_HIST_STORAGE  = 'pkm-ai-chat-history-v1';
const AI_HISTORY_MAX   = 20;

const AI_PROVIDERS = {
  claude: {
    label: 'Claude Sonnet (via Worker)',
    model: 'claude-sonnet-4-6',
    keyHelp: 'No key needed — uses the Worker\'s built-in Anthropic key.',
    keyUrl: null,
    noKey: true,
  },
  perplexity: {
    label: 'Perplexity Sonar',
    endpoint: 'https://api.perplexity.ai/chat/completions',
    model: 'sonar',
    keyHelp: 'Get a key at perplexity.ai/account/api',
    keyUrl: 'https://www.perplexity.ai/account/api',
  },
  openai: {
    label: 'OpenAI (GPT-4o mini)',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyHelp: 'Get a key at platform.openai.com/api-keys',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

let aiChatHistory = [];
try { aiChatHistory = JSON.parse(localStorage.getItem(AI_HIST_STORAGE) || '[]') || []; }
catch { aiChatHistory = []; }

function aiSaveHistory() {
  try { localStorage.setItem(AI_HIST_STORAGE, JSON.stringify(aiChatHistory.slice(-AI_HISTORY_MAX))); }
  catch {}
}
function aiGetProvider() {
  return localStorage.getItem(AI_PROV_STORAGE) || 'claude';
}
function aiSetProvider(p) {
  if (AI_PROVIDERS[p]) localStorage.setItem(AI_PROV_STORAGE, p);
}
function aiGetKey() {
  return localStorage.getItem(AI_KEY_STORAGE) || '';
}
function aiSetKey(k) {
  if (k && k.trim()) localStorage.setItem(AI_KEY_STORAGE, k.trim());
  else localStorage.removeItem(AI_KEY_STORAGE);
}

// ---- Context builder ----
// We assemble a compact JSON-ish summary of the user's collection
// and the market so the LLM has fresh data on every turn. We keep
// it short — under ~3k tokens — so each call stays cheap.
function aiBuildContext() {
  const ctx = {
    now: new Date().toISOString(),
    fx_usd_per_gbp: (typeof fxRate === 'number' ? fxRate : null),
    max_budget_gbp: getMaxBudgetGBP() < 99000 ? getMaxBudgetGBP() : null, // null = no limit set
  };

  // Portfolio summary + top 10 cards by current value
  try {
    if (Array.isArray(portfolio) && portfolio.length) {
      let totalGBP = 0, totalCost = 0, hasCost = 0;
      const items = portfolio.map(p => {
        const card = getCardById(p.id);
        const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(p.id) : null;
        const usd = cached ? (cached.market || cached.mid || (card ? card.p : p.price)) : (card ? card.p : p.price);
        const gbp = usdToGbp(usd);
        totalGBP += gbp;
        const acqCost = (typeof getAcqCostBasisGBP === 'function') ? getAcqCostBasisGBP(p.id) : 0;
        if (acqCost > 0) { totalCost += acqCost; hasCost++; }
        const pullForCard = (() => { try { if (setsData?.[card?.sc]) { const r = setsData[card.sc].rarities?.[card.rc]; if (r?.pullRate > 0) return Math.round(1 / r.pullRate) * r.count / 100; } } catch {} return 7.65; })();
        const desForCard = card && (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pullForCard) : { total: 5 };
        const starsForCard = card && (typeof getInvestmentStars === 'function') ? getInvestmentStars(card, desForCard.total) : null;
        return {
          id: p.id, name: p.name, set: p.set,
          price_gbp: +gbp.toFixed(2),
          cost_gbp: acqCost > 0 ? +acqCost.toFixed(2) : null,
          psa10_gem_rate_pct: card?.g ? +(card.g * 100).toFixed(1) : null,
          investment_stars: starsForCard?.stars ?? null,
        };
      });
      items.sort((a, b) => b.price_gbp - a.price_gbp);

      // Pre-sorted list of 5-star cards by gem rate — answers sorting questions directly
      const fiveStarByGem = items
        .filter(i => i.investment_stars === 5 && i.psa10_gem_rate_pct != null)
        .sort((a, b) => b.psa10_gem_rate_pct - a.psa10_gem_rate_pct);

      ctx.portfolio = {
        count: portfolio.length,
        total_value_gbp: +totalGBP.toFixed(2),
        total_cost_gbp: hasCost ? +totalCost.toFixed(2) : null,
        pl_gbp: hasCost ? +(totalGBP - totalCost).toFixed(2) : null,
        top_cards: items.slice(0, 10),
        five_star_cards_by_gem_rate: fiveStarByGem,
      };
    }
  } catch (e) { console.warn('ctx portfolio', e); }

  // Wishlist
  try {
    if (Array.isArray(wishlist) && wishlist.length) {
      ctx.wishlist = wishlist.slice(0, 10).map(w => {
        const card = getCardById(w.id);
        const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(w.id) : null;
        const usd = cached ? (cached.pcUngraded || cached.market || cached.mid || (card ? card.p : 0)) : (card ? card.p : 0);
        const pullW = (() => { try { if (setsData?.[card?.sc]) { const r = setsData[card.sc].rarities?.[card.rc]; if (r?.pullRate > 0) return Math.round(1 / r.pullRate) * r.count / 100; } } catch {} return 7.65; })();
        const desW = card && (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pullW) : { total: 5 };
        const starsW = card && (typeof getInvestmentStars === 'function') ? getInvestmentStars(card, desW.total) : null;
        return {
          id: w.id, name: w.name, set: w.set, lang: w.lang || 'EN',
          current_gbp: +usdToGbp(usd).toFixed(2),
          target_gbp: w.targetGBP || null,
          psa10_gem_rate_pct: card?.g ? +(card.g * 100).toFixed(1) : null,
          investment_stars: starsW?.stars ?? null,
        };
      });
    }
  } catch (e) { console.warn('ctx wishlist', e); }

  // Watchlist
  try {
    if (Array.isArray(watchlist) && watchlist.length) {
      ctx.watchlist = watchlist.slice(0, 10).map(w => ({ id: w.id, name: w.name, added: w.addedDate }));
    }
  } catch (e) { console.warn('ctx watchlist', e); }

  // Selected card — full analysis snapshot so the AI can give card-specific advice
  try {
    if (selectedCard) {
      const c = selectedCard;
      const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
      const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(c.i) : null;
      const usd = cached ? (cached.pcUngraded || cached.market || cached.mid || c.p) : c.p;
      const anchor = (typeof getPsa10Anchor === 'function') ? getPsa10Anchor(c) : { usd: 0, source: 'none' };

      let pull = 7.65;
      if (setsData?.[c.sc]) {
        const r = setsData[c.sc].rarities?.[c.rc];
        if (r?.pullRate > 0) pull = Math.round(1 / r.pullRate) * r.count / 100;
      }
      const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(c, pull) : { total: 5 };
      const sig = (typeof computeSignal === 'function') ? computeSignal(c, pull, des.total) : null;
      const hc  = (typeof computeHoldCore === 'function') ? computeHoldCore(c) : null;
      const fc  = (typeof forecast === 'function') ? forecast(c, pull, des.total) : null;

      const starResult = (typeof getInvestmentStars === 'function') ? getInvestmentStars(c, des.total) : null;
      ctx.selected_card = {
        id: c.i, name: c.n, set: c.s, number: c.cn, rarity: c.rc, lang: c.lang || 'EN',
        raw_gbp: +usdToGbp(usd).toFixed(2),
        psa10_gbp: anchor.usd ? +usdToGbp(anchor.usd).toFixed(2) : null,
        psa10_source: anchor.source,
        psa10_gem_rate_pct: c.g ? +(c.g * 100).toFixed(1) : null,
        investment_stars: starResult?.stars ?? null,
        investment_stars_hint: starResult?.hint ?? null,
        signal: sig?.signal || null,
        signal_score: sig?.score != null ? +sig.score.toFixed(1) : null,
        signal_reasons: sig?.reasons || [],
        desirability: +des.total.toFixed(1),
        in_portfolio: portfolio.some(p => p.id === c.i),
        in_wishlist:  wishlist.some(w => w.id === c.i),
        in_watchlist: watchlist.some(w => w.id === c.i),
        best_strategy: hc?.ok && hc.bestLongTermPick ? {
          key: hc.bestLongTermPick.key,
          buy_price_gbp: +(hc.bestLongTermPick.today * fx).toFixed(2),
          roi_5yr_pct: +hc.bestLongTermPick.roi.toFixed(1),
          risk: hc.bestLongTermPick.risk,
          profit_gbp: +(hc.bestLongTermPick.profit * fx).toFixed(2),
        } : null,
        forecast_5yr_expected_gbp: fc ? +(fc.scenarios.expected[4].priceUSD * fx).toFixed(2) : null,
        forecast_5yr_optimistic_gbp: fc ? +(fc.scenarios.optimistic[4].priceUSD * fx).toFixed(2) : null,
        pull_cost_gbp: +(pull * fx).toFixed(2),
      };
    }
  } catch (e) { console.warn('ctx selected', e); }

  // Top value picks — pre-ranked, budget-filtered so the AI never suggests cards over the user's limit
  try {
    if (typeof scanValuePicks === 'function') {
      const budget = ctx.max_budget_gbp || Infinity;
      const top = scanValuePicks('all')
        .filter(p => usdToGbp(p.marketPrice) <= budget)
        .slice(0, 8)
        .map(p => ({
          id: p.card.i, name: p.card.n, set: p.card.s,
          raw_gbp: +usdToGbp(p.marketPrice).toFixed(2),
          target_gbp: +usdToGbp(p.targetPrice).toFixed(2),
          upside_pct: +p.upside,
          reasons: p.reasons,
          signal: p.signal,
        }));
      if (top.length) ctx.value_picks = top;
    }
  } catch (e) { console.warn('ctx value_picks', e); }

  // Broader card market — 4/5-star cards with gem rate data, NOT limited to owned cards.
  // This lets the AI answer "find me 5-star cards under £150 with 50%+ gem rate" without
  // being restricted to the user's collection.
  try {
    if (Array.isArray(searchIndex) && searchIndex.length) {
      const ownedIds = new Set((Array.isArray(portfolio) ? portfolio : []).map(p => p.id));
      const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
      const budget = ctx.max_budget_gbp || Infinity;

      const marketCards = [];
      for (const c of searchIndex) {
        if (!c.g || c.g < 0.30) continue;            // must have 30%+ gem rate
        if (c.lang === 'JP') continue;                // EN only for now
        const pull = (() => { try { if (setsData?.[c.sc]) { const r = setsData[c.sc].rarities?.[c.rc]; if (r?.pullRate > 0) return Math.round(1 / r.pullRate) * r.count / 100; } } catch {} return 7.65; })();
        const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(c, pull) : { total: 5 };
        const starObj = (typeof getInvestmentStars === 'function') ? getInvestmentStars(c, des.total) : null;
        if (!starObj || starObj.stars < 4) continue;  // 4-star and above only
        const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(c.i) : null;
        const usd = cached ? (cached.market || cached.mid || c.p) : c.p;
        const gbp = usdToGbp(usd);
        if (!gbp || gbp > budget) continue;
        marketCards.push({
          id: c.i,
          name: c.n,
          set: c.s,
          rarity: c.rc,
          price_gbp: +gbp.toFixed(2),
          psa10_gem_rate_pct: +(c.g * 100).toFixed(1),
          investment_stars: starObj.stars,
          owned: ownedIds.has(c.i),
        });
      }
      // Sort by gem rate desc, then price asc
      marketCards.sort((a, b) => b.psa10_gem_rate_pct - a.psa10_gem_rate_pct || a.price_gbp - b.price_gbp);
      if (marketCards.length) ctx.card_market = marketCards.slice(0, 80);
    }
  } catch (e) { console.warn('ctx card_market', e); }

  return ctx;
}

function aiSystemPrompt(ctx) {
  const budgetLine = ctx.max_budget_gbp
    ? `BUDGET CONSTRAINT: The user has set a maximum of £${ctx.max_budget_gbp} per card. Never suggest buying or grading anything whose cost exceeds this — not even as an aside. value_picks is pre-filtered to this budget. If budget is the binding constraint, say so and suggest alternatives within it.`
    : `BUDGET: No per-card limit set.`;

  const cardLine = ctx.selected_card
    ? `ACTIVE CARD: The user has [[card:${ctx.selected_card.id}|${ctx.selected_card.name}]] loaded on screen. Investment stars: ${ctx.selected_card.investment_stars ?? 'n/a'}/5. PSA 10 gem rate: ${ctx.selected_card.psa10_gem_rate_pct != null ? ctx.selected_card.psa10_gem_rate_pct + '%' : 'unknown'}. When asked to analyse it, use signal (${ctx.selected_card.signal || 'n/a'}), signal_reasons, desirability (${ctx.selected_card.desirability}), best_strategy, and forecast fields to give a complete verdict: buy/hold/sell, whether to grade, 5-year trajectory, and risks. Cite the actual numbers — don't be vague.`
    : '';

  return `You are "PokeKnow", an expert Pokemon TCG market analyst built into the user's collection-tracking app.

ROLE: Give crisp, data-driven advice on buying, selling, grading and timing the Pokemon TCG market. Be opinionated but honest about uncertainty. Optimise for actionable signal, not generic advice.

${budgetLine}
${cardLine}

USER CONTEXT (always reflects their latest local state — do not ask for it):
\`\`\`json
${JSON.stringify(ctx, null, 2)}
\`\`\`

PRINCIPLES:
- Prices are in GBP. The user is UK-based. Mention import VAT/fees when discussing US/JP purchases.
- "Underrated" means strong fundamentals (rarity, character demand, set age) at a depressed current price.
- "Graded upside" = PSA 10 / raw multiplier. Anything >2.5x is interesting; >4x is exceptional.
- DEFAULT DATA SOURCE: Unless the user explicitly asks about their own collection/portfolio/wishlist, answer using card_market — it contains 4–5 star EN cards with 30%+ gem rate from the full database, sorted by gem rate desc. The owned field tells you if the user already owns it.
- When suggesting picks, prefer cards from card_market where owned:false unless the user asks specifically about what they own.
- PSA 10 GEM RATE (psa10_gem_rate_pct): percentage of submitted copies that achieve PSA 10. Higher = easier to grade. 50%+ is excellent (relatively easy to hit 10). 20–49% is moderate. Below 20% is difficult — factor this heavily into grading advice. portfolio.five_star_cards_by_gem_rate is pre-sorted for you.
- INVESTMENT STARS (investment_stars 1–5): 5 = S-tier Pokémon in premium rarity (best long-term hold), 4 = strong, 3 = moderate, 2 = situational, 1 = low priority. Always mention stars when ranking or comparing cards.
- For sell/hold/grade questions, balance: gem rate, grading cost (~£25–£30 all-in), PSA 10 vs raw multiplier, and opportunity cost.
- Keep replies tight: 3-6 short paragraphs or a focused table. No filler.
- Use **bold** sparingly for emphasis. Bullet lists are fine. Never invent prices not in context.
- If asked something not about Pokemon TCG or the user's data, gently redirect.

CARD CITATIONS — you MUST follow this exactly:
- Whenever you reference a specific card that appears in the context JSON above (portfolio, wishlist, watchlist, selected_card, or value_picks), wrap the mention as [[card:ID|Display Name]] — e.g. [[card:sv8pt5-161|Charizard ex]].
- Only use this format for cards with a real "id" field present in the context. Never invent IDs. For cards not in context, use plain text.
- The Display Name should be the card's common name as you'd naturally write it in a sentence.

CHART SENTINELS — optional, use when discussing price performance or projections:
- When discussing a card's historical price performance, you may emit [[chart:price:ID]] on its own line to render an inline price chart for that card.
- When discussing projected/future performance, you may emit [[chart:forecast:ID]] on its own line to render an inline forecast chart.
- Only emit chart sentinels for card IDs present in context. Each sentinel must be on its own line, alone.
- Use charts sparingly — only when the visual adds clear value (e.g. "here's how it's trended" or "here's the 5-year projection").`;
}

// ---- LLM client (streaming) ----
async function aiStreamChat({ provider, key, messages, onToken, onDone, onError }) {
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) { onError('Unknown provider'); return; }

  const endpoint = cfg.noKey
    ? (getMktWorkerUrl() + '/ai/chat')
    : cfg.endpoint;

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.noKey) {
    const jwt = authGetToken();
    if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
  } else {
    headers['Authorization'] = 'Bearer ' + key;
  }

  const body = { model: cfg.model, messages, stream: true, temperature: 0.4 };

  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    onError('Network error: ' + (e.message || e));
    return;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch {}
    onError(`${cfg.label} returned ${res.status}. ${detail}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
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
        if (data === '[DONE]') { onDone(full); return; }
        try {
          const j = JSON.parse(data);
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) { full += delta; onToken(delta); }
        } catch {}
      }
    }
    onDone(full);
  } catch (e) {
    onError('Stream error: ' + (e.message || e));
  }
}

// ---- Markdown lite ----
// Just enough to keep replies readable. We escape first, then add
// **bold**, `code`, links, and turn blank lines into paragraphs.
function aiMdRender(text) {
  const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  let s = String(text || '').replace(/[&<>]/g, ch => escMap[ch]);
  // Code blocks (triple backtick)
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Lists — lines starting with "- " or "* "
  s = s.replace(/(^|\n)([\-\*] .+(\n[\-\*] .+)*)/g, (_, pre, block) => {
    const items = block.split(/\n/).map(line => '<li>' + line.replace(/^[\-\*] /, '') + '</li>').join('');
    return pre + '<ul>' + items + '</ul>';
  });
  // Paragraphs — double newline
  s = s.split(/\n{2,}/).map(p => p.includes('<ul>') || p.includes('<pre>') ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
  return s;
}

// ---- Sentinel post-processing ----
let _aiChartCounter = 0;

function aiProcessSentinels(html) {
  // Replace [[card:ID|Name]] with interactive chip
  html = html.replace(/\[\[card:([^\]|]+)\|([^\]]+)\]\]/g, (_, id, name) => {
    if (!cardData) return name;
    const card = getCardById(id);
    if (!card) return name;
    const wlActive = wishlist.some(w => w.id === id) ? ' is-active' : '';
    const wtActive = watchlist.some(w => w.id === id) ? ' is-active' : '';
    return `<span class="ai-card-chip" data-card-id="${id}">` +
      `<button class="ai-card-chip-name" onclick="aiGoToCard('${id}')">${name}</button>` +
      `<button class="ai-card-chip-btn${wlActive}" data-list="wishlist" onclick="aiToggleListFromChat('${id}','wishlist',this)" title="Wishlist">&#9825;</button>` +
      `<button class="ai-card-chip-btn${wtActive}" data-list="watchlist" onclick="aiToggleListFromChat('${id}','watchlist',this)" title="Watchlist">&#128065;</button>` +
      `</span>`;
  });

  // Replace [[chart:price:ID]] / [[chart:forecast:ID]] — strip surrounding <p> if present
  html = html.replace(/(?:<p>)?\[\[chart:(price|forecast):([^\]]+)\]\](?:<\/p>)?/g, (_, type, id) => {
    const n = ++_aiChartCounter;
    return `<div class="ai-chart-mount" data-chart-type="${type}" data-card-id="${id}" id="ai-chart-${n}">` +
      `<canvas></canvas><div class="ai-chart-loading">Loading chart…</div>` +
      `</div>`;
  });

  return html;
}

function aiGoToCard(id) {
  selectCard(id);
  document.querySelector('.page-nav-btn[data-page="predict"]')?.click();
  aiClosePanel();
}

function aiToggleListFromChat(id, listName, btnEl) {
  if (listName === 'wishlist') {
    toggleCardInWishlist(id);
    btnEl.classList.toggle('is-active', wishlist.some(w => w.id === id));
  } else if (listName === 'watchlist') {
    toggleCardInWatchlist(id);
    btnEl.classList.toggle('is-active', watchlist.some(w => w.id === id));
  }
}

async function aiHydrateCharts(containerEl) {
  // Wait one animation frame so the browser has laid out the new elements
  // before drawPriceChart / drawForecastChart call getBoundingClientRect().
  await new Promise(r => requestAnimationFrame(r));
  const mounts = containerEl.querySelectorAll('.ai-chart-mount:not([data-hydrated])');
  for (const mount of mounts) {
    mount.dataset.hydrated = '1';
    const type = mount.dataset.chartType;
    const cardId = mount.dataset.cardId;
    const canvas = mount.querySelector('canvas');
    const loading = mount.querySelector('.ai-chart-loading');

    if (!cardData) { if (loading) loading.textContent = 'Card data unavailable'; continue; }
    const card = getCardById(cardId);
    if (!card) { mount.innerHTML = '<div style="padding:12px;color:var(--text-faint);font-size:12px">Card not found</div>'; continue; }

    if (type === 'price') {
      try {
        const apiUrl = `https://mycollectrics.com/api/card/${cardId}?include=ebay`;
        const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(apiUrl)}`;
        const r = await fetch(proxyUrl);
        if (!r.ok) throw new Error('API ' + r.status);
        const d = await r.json();
        const cleaned = (d.history || [])
          .filter(h => h && h.date && h['raw-price'])
          .map(h => ({ date: h.date, raw: h['raw-price'] || 0, psa9: h['psa-9-price'] || 0, psa10: h['psa-10-price'] || 0, vol: h['sales-volume'] || 0 }))
          .filter(h => h.raw > 0)
          .sort((a, b) => a.date.localeCompare(b.date));
        if (cleaned.length < 2) throw new Error('insufficient data');
        if (loading) loading.style.display = 'none';
        drawPriceChart(canvas, cleaned);
      } catch (e) {
        if (loading) loading.textContent = 'Chart unavailable';
      }
    } else if (type === 'forecast') {
      try {
        const pullCost = 7.65;
        const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pullCost).total : 5;
        const fc = forecast(card, pullCost, des);
        if (loading) loading.style.display = 'none';
        drawForecastChart(canvas, fc);
      } catch (e) {
        if (loading) loading.textContent = 'Chart unavailable';
      }
    }
  }
}

// ---- UI ----
function aiRenderHistory() {
  const list = document.getElementById('aiChatMessages');
  if (!list) return;
  if (aiChatHistory.length === 0) {
    const cardBtn = selectedCard
      ? `<button class="ai-quick ai-quick-card" data-prompt="Analyse ${esc(selectedCard.n)} (${esc(selectedCard.s)}) in full. What's the signal, should I buy it, hold it, or grade it? Give me the 5-year outlook and any risks.">Analyse ${esc(selectedCard.n)}</button>`
      : '';
    const budgetGBP = getMaxBudgetGBP();
    const budgetHint = budgetGBP < 99000 ? ` under £${budgetGBP}` : '';
    list.innerHTML = `
      <div class="ai-welcome">
        <div class="ai-welcome-title">PokeKnow</div>
        <div class="ai-welcome-sub">An AI analyst with live access to your collection, wishlist, watchlist and the market${budgetHint ? ' — budget-aware' : ''}.</div>
        <div class="ai-welcome-suggest">Try one of these to get started:</div>
        <div class="ai-quick-grid">
          ${cardBtn}
          <button class="ai-quick" data-prompt="What are the most underrated cards I should look at right now — both raw and graded — with high growth potential${budgetHint}?">What's underrated right now?</button>
          <button class="ai-quick" data-prompt="Analyse my portfolio. Which cards should I consider selling, holding or grading?">Analyse my portfolio</button>
          <button class="ai-quick" data-prompt="Which wishlist cards are closest to a good buying window? Should I lower or raise any of my targets?">Wishlist buy timing</button>
          <button class="ai-quick" data-prompt="What's the smartest spend${budgetHint || ' this week'} in the modern era?">Best spend${budgetHint || ' this week'}</button>
        </div>
      </div>`;
    return;
  }
  list.innerHTML = aiChatHistory.map(m => {
    if (m.role === 'user') {
      const safe = String(m.content || '').replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
      return `<div class="ai-msg ai-msg-user"><div class="ai-msg-content">${safe.replace(/\n/g, '<br>')}</div></div>`;
    }
    return `<div class="ai-msg ai-msg-bot"><div class="ai-msg-content">${aiProcessSentinels(aiMdRender(m.content))}</div></div>`;
  }).join('');
  // Re-attach follow-up suggestions for the last assistant message
  const lastBot = aiChatHistory.slice().reverse().find(m => m.role === 'assistant');
  const lastUser = aiChatHistory.slice().reverse().find(m => m.role === 'user');
  if (lastBot) {
    const botEls = list.querySelectorAll('.ai-msg-bot');
    const lastBotEl = botEls[botEls.length - 1];
    if (lastBotEl) {
      const followups = aiGenerateFollowups(lastBot.content, lastUser?.content || '');
      if (followups.length) aiAppendFollowups(lastBotEl, followups);
    }
  }
  list.scrollTop = list.scrollHeight;
  aiHydrateCharts(list);
}

function aiAppendStreamMessage() {
  const list = document.getElementById('aiChatMessages');
  const div = document.createElement('div');
  div.className = 'ai-msg ai-msg-bot';
  div.innerHTML = '<div class="ai-msg-content"><span class="ai-cursor"></span></div>';
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  return div.querySelector('.ai-msg-content');
}

function aiToggleSettings(show) {
  const s = document.getElementById('aiChatSettingsPanel');
  if (!s) return;
  s.style.display = (show === undefined ? (s.style.display === 'none' ? 'block' : 'none') : (show ? 'block' : 'none'));
}

function aiOpenPanel() {
  const panel    = document.getElementById('aiChatPanel');
  const backdrop = document.getElementById('aiChatBackdrop');
  if (!panel) return;

  // Push a history entry so the back gesture closes the panel instead of navigating away.
  // Guard against double-push if somehow called while already open.
  if (!panel.classList.contains('open')) {
    try { history.pushState({ aiOpen: true }, '', location.href); } catch(e) {}
  }

  const _autoCard = selectedCard;

  panel.style.display = 'flex';
  if (backdrop) backdrop.style.display = 'block';
  setTimeout(() => {
    panel.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
  }, 10);
  aiRenderHistory();
  const _openCfg = AI_PROVIDERS[aiGetProvider()];
  const _needsKey = !_openCfg?.noKey && !aiGetKey();
  if (_needsKey) aiToggleSettings(true);
  const input = document.getElementById('aiChatInput');
  if (input) setTimeout(() => input.focus(), 200);

  // Auto-submit card analysis only if there's no existing conversation to resume.
  if (_autoCard && !_needsKey && aiChatHistory.length === 0) {
    setTimeout(() => aiSubmit(`Analyse ${_autoCard.n} (${_autoCard.s}) in full. What's the signal, should I buy it, hold it, or grade it? Give me the 5-year outlook and any risks.`), 300);
  }
}
function aiClosePanel(_viaPopstate) {
  const panel    = document.getElementById('aiChatPanel');
  const backdrop = document.getElementById('aiChatBackdrop');
  if (!panel) return;
  panel.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  setTimeout(() => {
    panel.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  }, 200);
  // If closed by UI (X button, backdrop, Escape) consume the history entry we pushed.
  // Don't call history.back() when we're already here via popstate — that would double-pop.
  if (!_viaPopstate) {
    try { history.back(); } catch(e) {}
  }
}

async function aiSubmit(userText) {
  const text = (userText || '').trim();
  if (!text) return;
  const cfg = AI_PROVIDERS[aiGetProvider()];
  const key = aiGetKey();
  if (!cfg?.noKey && !key) {
    aiToggleSettings(true);
    const k = document.getElementById('aiChatKey');
    if (k) k.focus();
    return;
  }

  aiChatHistory.push({ role: 'user', content: text });
  aiSaveHistory();
  aiRenderHistory();

  const ctx = aiBuildContext();
  const sys = aiSystemPrompt(ctx);
  // Keep only the recent conversation (last 10 turns) to control cost
  const recent = aiChatHistory.slice(-10);
  const messages = [
    { role: 'system', content: sys },
    ...recent.map(m => ({ role: m.role, content: m.content })),
  ];

  const target = aiAppendStreamMessage();
  let full = '';
  const _escStream = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  await aiStreamChat({
    provider: aiGetProvider(),
    key,
    messages,
    onToken: (tok) => {
      full += tok;
      // Plain-text during streaming — sentinels may be split across chunks, so
      // defer full markdown+sentinel processing until the message is complete.
      target.innerHTML = String(full).replace(/[&<>]/g, ch => _escStream[ch]).replace(/\n/g, '<br>') + '<span class="ai-cursor"></span>';
      target.parentElement.parentElement.scrollTop = target.parentElement.parentElement.scrollHeight;
    },
    onDone: (whole) => {
      aiChatHistory.push({ role: 'assistant', content: whole });
      aiSaveHistory();
      target.innerHTML = aiProcessSentinels(aiMdRender(whole));
      aiHydrateCharts(target);
      const followups = aiGenerateFollowups(whole, text);
      if (followups.length) aiAppendFollowups(target.parentElement, followups);
      const list = document.getElementById('aiChatMessages');
      if (list) list.scrollTop = list.scrollHeight;
    },
    onError: (err) => {
      target.innerHTML = `<p style="color:var(--red)">${aiMdRender('**Error:** ' + err)}</p>`;
    },
  });
}

function aiAppendFollowups(msgEl, followups) {
  const existing = msgEl.querySelector('.ai-followups');
  if (existing) existing.remove();
  const row = document.createElement('div');
  row.className = 'ai-followups';
  row.innerHTML = followups.map(f =>
    `<button class="ai-quick ai-followup" data-prompt="${esc(f.prompt)}">${esc(f.label)}</button>`
  ).join('');
  msgEl.appendChild(row);
}

function aiGenerateFollowups(responseText, userText) {
  const r = (responseText || '').toLowerCase();
  const u = (userText  || '').toLowerCase();
  const card = selectedCard;
  const cn = card ? esc(card.n) : '';
  const cs = card ? esc(card.s) : '';
  const has = (...words) => words.some(w => r.includes(w) || u.includes(w));
  const suggestions = [];

  // Grading / PSA / gem rate
  if (has('grade', 'psa', 'gem rate', 'slab', 'submit', 'gem %')) {
    if (card) suggestions.push({
      label: `Grade economics for ${cn}`,
      prompt: `Break down the full grading economics for ${cn} (${cs}): cost to grade, PSA 10 estimate, gem rate, and net profit if I sell graded on eBay.`,
    });
    suggestions.push({
      label: 'Best grading candidates in my collection',
      prompt: 'Which cards in my portfolio are the best PSA grading candidates right now? Rank by gem rate and PSA 10 upside, only include ones where grading makes financial sense.',
    });
  }

  // Buy / entry timing / sets
  if (has('buy', 'entry', 'timing', 'window', 'optimal', 'too early', 'approaching')) {
    suggestions.push({
      label: 'Which sets are in the buy window?',
      prompt: 'Which Scarlet & Violet sets are currently in the 6–10 month optimal entry window? Rank the best buys by set and character.',
    });
    if (card) suggestions.push({
      label: `Max buy price for ${cn}`,
      prompt: `What's the maximum I should pay for ${cn} (${cs}) to achieve a 20% ROI if I sell on eBay? Include the eBay fee buffer.`,
    });
  }

  // Sell / exit
  if (has('sell', 'exit', 'take profit', 'liquidate', 'offload')) {
    suggestions.push({
      label: 'Which portfolio cards to sell first?',
      prompt: 'Looking at my portfolio, which cards have the strongest sell signal right now based on set maturity, ROI already achieved, and market timing? Be direct.',
    });
  }

  // Hold / long-term forecast
  if (has('hold', '5-year', '5 year', 'long-term', 'long term', 'forecast')) {
    if (card) suggestions.push({
      label: `5-year forecast for ${cn}`,
      prompt: `Show me the 5-year price forecast for ${cn} (${cs}) across expected, optimistic, and pessimistic scenarios. What's driving the spread?`,
    });
    suggestions.push({
      label: 'Best long-term holds in my collection',
      prompt: 'Rank my portfolio cards by long-term hold potential over 5 years. Which should I never sell and which should I rotate out?',
    });
  }

  // Portfolio / P&L
  if (has('portfolio', 'collection', 'total value', 'p&l', 'profit', 'loss')) {
    suggestions.push({
      label: 'Which are my weakest holds?',
      prompt: 'Which cards in my portfolio have the worst long-term outlook or are most likely to underperform? Give me a clear ranking and what to do about each.',
    });
    suggestions.push({
      label: 'What should I sell to free up budget?',
      prompt: 'If I needed to free up £200–£500 from my portfolio without sacrificing the best long-term holds, what should I sell?',
    });
  }

  // Wishlist
  if (has('wishlist', 'target price', 'want list', 'wanted')) {
    suggestions.push({
      label: 'Which wishlist cards to buy first?',
      prompt: 'Looking at my wishlist, which should I prioritise buying first and why? Consider set age, current pricing vs target, and growth potential.',
    });
  }

  // Stars / investment rating
  if (has('star', '5-star', '4-star', 'investment rating', 'tier')) {
    suggestions.push({
      label: 'Rank all 5-star cards by gem rate',
      prompt: 'List all 5-star investment cards in my portfolio ordered by PSA 10 gem rate, highest first. Which are easiest to grade to PSA 10?',
    });
    suggestions.push({
      label: "Best 5-star buys under my budget",
      prompt: `What are the best 5-star investment cards I could buy right now within my budget, ranked by value? Include raw and graded options.`,
    });
  }

  // Marketplace / deals / eBay
  if (has('ebay', 'listing', 'deal', 'market', 'undervalued', 'underrated', 'cardmarket')) {
    if (card) suggestions.push({
      label: `Find live listings for ${cn}`,
      prompt: `Search for live eBay listings for ${cn} (${cs}). What's the best deal available right now versus fair value?`,
    });
    suggestions.push({
      label: "What's underrated right now?",
      prompt: "What are the most underrated 5-star cards available right now with the best risk/reward ratio? Give me your top 3 picks.",
    });
  }

  // EN vs JP
  if (has('japanese', 'jp version', 'en version', 'english', 'en vs', 'jp vs')) {
    if (card) suggestions.push({
      label: `EN vs JP for ${cn}`,
      prompt: `Compare the EN and JP versions of ${cn} (${cs}) — price gap, grading ceiling difference, liquidity, and which is better value right now.`,
    });
  }

  // Card-specific fallback when card is on screen but nothing specific triggered
  if (card && suggestions.length < 2) {
    suggestions.push({
      label: `Should I grade ${cn}?`,
      prompt: `Should I grade my ${cn} (${cs})? Factor in the gem rate, grading cost, PSA 10 vs raw multiplier, and whether the timing makes sense.`,
    });
    suggestions.push({
      label: `5-year outlook for ${cn}`,
      prompt: `What's the 5-year price outlook for ${cn} (${cs})? Walk through the bear, base, and bull scenarios.`,
    });
  }

  // General fallback
  if (suggestions.length < 2) {
    suggestions.push({
      label: 'Analyse my portfolio',
      prompt: 'Give me a full portfolio analysis: best holds, weakest links, top 3 action items.',
    });
    suggestions.push({
      label: 'Best spend this week',
      prompt: 'What is the single best card I could buy this week for long-term value within my budget?',
    });
  }

  // Deduplicate and cap at 3
  const seen = new Set();
  return suggestions.filter(s => {
    if (seen.has(s.label)) return false;
    seen.add(s.label);
    return true;
  }).slice(0, 3);
}

function aiSetupQuickPrompts() {
  document.body.addEventListener('click', (e) => {
    const q = e.target.closest && e.target.closest('.ai-quick');
    if (!q) return;
    e.preventDefault();
    const prompt = q.dataset.prompt || q.textContent;
    aiSubmit(prompt);
  });
}

function setupAiChat() {
  const btn = document.getElementById('aiChatBtn');
  const close = document.getElementById('aiChatClose');
  const settingsBtn = document.getElementById('aiChatSettings');
  const clearBtn = document.getElementById('aiChatClear');
  const saveBtn = document.getElementById('aiChatSaveKey');
  const provSel = document.getElementById('aiChatProvider');
  const keyInput = document.getElementById('aiChatKey');
  const helpLink = document.getElementById('aiChatKeyHelp');
  const form = document.getElementById('aiChatForm');
  const input = document.getElementById('aiChatInput');
  if (!btn || !form) return;

  btn.addEventListener('click', aiOpenPanel);
  close && close.addEventListener('click', aiClosePanel);
  document.getElementById('aiChatMinimise')?.addEventListener('click', aiClosePanel);
  document.getElementById('aiChatBackdrop')?.addEventListener('click', aiClosePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('aiChatPanel').classList.contains('open')) aiClosePanel();
  });

  // Swipe-down on handle to dismiss (mobile bottom sheet)
  const handle = document.getElementById('aiChatHandle');
  if (handle) {
    let _hTouchY = 0;
    handle.addEventListener('touchstart', e => { _hTouchY = e.touches[0].clientY; }, { passive: true });
    handle.addEventListener('touchend', e => {
      if (e.changedTouches[0].clientY - _hTouchY > 50) aiClosePanel();
    }, { passive: true });
  }
  settingsBtn && settingsBtn.addEventListener('click', () => aiToggleSettings());
  clearBtn && clearBtn.addEventListener('click', () => {
    if (!confirm('Clear chat history?')) return;
    aiChatHistory = [];
    aiSaveHistory();
    aiRenderHistory();
  });

  // Initialise provider + key form
  function refreshProviderUI() {
    const p = aiGetProvider();
    const cfg = AI_PROVIDERS[p] || {};
    if (provSel) provSel.value = p;
    if (keyInput) keyInput.value = aiGetKey();
    const keyRow = document.getElementById('aiChatKeyRow');
    if (keyRow) keyRow.style.display = cfg.noKey ? 'none' : '';
    if (helpLink) {
      helpLink.textContent = cfg.keyHelp || '';
      if (cfg.keyUrl) { helpLink.href = cfg.keyUrl; helpLink.style.display = ''; }
      else { helpLink.href = '#'; helpLink.style.display = 'none'; }
    }
  }
  provSel && provSel.addEventListener('change', () => {
    aiSetProvider(provSel.value);
    refreshProviderUI();
  });
  saveBtn && saveBtn.addEventListener('click', () => {
    aiSetKey(keyInput.value);
    aiToggleSettings(false);
  });
  refreshProviderUI();

  // Auto-grow textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = input.value;
      input.value = '';
      input.style.height = 'auto';
      aiSubmit(v);
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = '';
    input.style.height = 'auto';
    aiSubmit(v);
  });

  aiSetupQuickPrompts();
}

// =============================================================
// Page Nav — top-level routing (Predict · Discover · Tools)
// =============================================================
// On init we relocate a handful of sections out of the legacy single-page
// layout into dedicated page containers so each top-level tab feels like
// its own page without us having to rewrite the entire DOM.

function setupTheme() {
  function applyTheme(pref) {
    const root = document.documentElement;
    if (pref === 'light') {
      root.setAttribute('data-theme', 'light');
    } else if (pref === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
  }

  const stored = localStorage.getItem('theme-pref') || 'system';
  applyTheme(stored);

  const btns = document.querySelectorAll('.theme-btn');
  btns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeVal === stored);
    btn.addEventListener('click', () => {
      const val = btn.dataset.themeVal;
      localStorage.setItem('theme-pref', val);
      applyTheme(val);
      btns.forEach(b => b.classList.toggle('active', b.dataset.themeVal === val));
    });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('theme-pref') || 'system') === 'system') applyTheme('system');
  });
}

function setupGlassTint() {
  const STATES = ['default', 'clear', 'tinted'];
  const TITLES = { default: 'Default', clear: 'Ultraclear', tinted: 'Tinted' };
  const stored = localStorage.getItem('pkm-glass-tint') || 'default';
  let idx = Math.max(0, STATES.indexOf(stored));

  function apply(state) {
    document.documentElement.dataset.glass = state;
    const btn = document.getElementById('glassTintBtn');
    if (btn) btn.title = `Liquid Glass: ${TITLES[state]} — click to cycle`;
  }

  apply(STATES[idx]);

  document.getElementById('glassTintBtn')?.addEventListener('click', () => {
    idx = (idx + 1) % STATES.length;
    const state = STATES[idx];
    localStorage.setItem('pkm-glass-tint', state);
    apply(state);
  });
}
setupGlassTint();

// ─── Home Dashboard ───────────────────────────────────────────────
// ── Home Recommendations ──────────────────────────────────────────────────
const RECO_DISMISSED_KEY = 'pkm-reco-dismissed-v1';
let _recoCached = null; // { general: [], raw: [], psa8: [], psa9: [], psa10: [], ts: number }
let _recoPrefetchTs = 0;

// After the reco cache is built, quietly fetch live prices for the top
// strategy-section cards so PSA10 tiles show real prices (not stale card.p10).
// Rate-limited to once per PRICE_CACHE_TTL so it doesn't re-run on every
// home-tab visit.
async function _homeRecoPrefetch(all) {
  const now = Date.now();
  if (now - _recoPrefetchTs < PRICE_CACHE_TTL) return;
  _recoPrefetchTs = now;

  const seen = new Set();
  const toFetch = [];
  // Prioritise strategy sections (especially psa10) — that's where the wrong
  // price is most visible. Cap at 5 per section so we don't hammer the API.
  for (const key of ['psa10', 'psa9', 'psa8', 'raw', 'general']) {
    for (const r of (all[key] || []).slice(0, 5)) {
      if (seen.has(r.card.i)) continue;
      seen.add(r.card.i);
      const cached = getCachedPrice(r.card.i);
      // Only fetch if there's no live pcPsa10 in the cache (the stale case)
      if (!cached || (key !== 'general' && !cached.pcPsa10)) toFetch.push(r.card);
    }
  }
  if (!toFetch.length) return;

  for (const card of toFetch) {
    try {
      const priceData = await fetchFreshPriceData(card);
      // Preserve any previously fetched TCGPlayer prices
      if (priceData.tcgMarket <= 0) {
        const existing = getLastKnownPrice(card.i);
        if (existing && existing.tcgMarket > 0) {
          priceData.tcgMarket = existing.tcgMarket;
          priceData.tcgLow    = existing.tcgLow    || 0;
          priceData.tcgMid    = existing.tcgMid    || 0;
          priceData.tcgHigh   = existing.tcgHigh   || 0;
          priceData.tcgUrl    = priceData.tcgUrl   || existing.tcgUrl;
        }
      }
      setCachedPrice(card.i, priceData); // also nulls _recoCached
    } catch {}
  }
  // Rebuild tiles now that live prices are available
  _renderHomeReco(true);
}

function _getRecoDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(RECO_DISMISSED_KEY) || '[]')); }
  catch { return new Set(); }
}
function _dismissReco(cardId) {
  const s = _getRecoDismissed();
  s.add(cardId);
  try { localStorage.setItem(RECO_DISMISSED_KEY, JSON.stringify([...s])); } catch {}
  _recoCached = null;
}

// Get the best available static/cached price for a card (doesn't touch livePrice).
function _recoStaticPrice(c) {
  const cached = getCachedPrice(c.i);
  if (cached) {
    if (cached.pcUngraded > 0) return cached.pcUngraded;
    if (cached.market > 0) return cached.market;
    if (cached.mid > 0) return cached.mid;
  }
  return c.p || 0;
}

// Secondary scoring layer — structural reasons a card may be overlooked by the market.
// Returns 0–3 bonus; combined with signal score in sort but never replaces it.
function _gemScore(card, marketUSD) {
  let bonus = 0;
  const rc  = card.rc  || '';
  const sc  = (card.sc || '').toUpperCase();
  const r   = (card.r  || '').toLowerCase();
  const n   = (card.n  || '').toLowerCase();
  const charScore = getCharacterScore(card.n);

  // 1. Promo of a popular Pokémon
  // Promos are single-source, limited-window, harder to grade — market systematically
  // underprices them on release and reassesses years later.
  if (rc === 'PR' || /promo/i.test(r)) {
    if (charScore >= 9.0)      bonus += 2.5; // S-tier (Charizard, Pikachu, Mew…)
    else if (charScore >= 8.0) bonus += 1.5; // A-tier (Lucario, Greninja…)
    else                       bonus += 0.4;
  }

  // 2. High rarity trading well below expected for its tier
  // SIR/AR/IR cards priced at less than 35% of the tier median are likely overlooked.
  const expected = EXPECTED_PRICE_BY_RARITY[rc] || 0;
  if (expected > 0 && marketUSD > 0) {
    const ratio = marketUSD / expected;
    if ((rc === 'SIR' || rc === 'MHR' || rc === 'SHR') && ratio < 0.20) bonus += 2.5;
    else if ((rc === 'SIR' || rc === 'AR')              && ratio < 0.35) bonus += 1.5;
    else if ((rc === 'IR'  || rc === 'UR')              && ratio < 0.35) bonus += 1.0;
    else if ((rc === 'HR'  || rc === 'SR')              && ratio < 0.30) bonus += 0.5;
  }

  // 3. Franchise-spillover candidates — generational nostalgia / game re-releases
  // Mega Evolution (XY era): renewed interest driven by Legends ZA bringing megas back.
  // Require S/A-tier Pokémon + still cheap to avoid tagging already-expensive chases.
  const isMega = n.startsWith('mega ') || /\bm-[a-z]/i.test(n) || /mega evolution/i.test(r);
  const isXYEra = sc.startsWith('XY') || (card.s || '').match(/^(XY|Flashfire|Phantom Forces|Primal Clash|Roaring Skies|Ancient Origins|BREAKthrough|BREAKpoint|Fates Collide|Steam Siege|Evolutions)/i);
  if (isMega || isXYEra) {
    if (charScore >= 9.0 && marketUSD < 30) bonus += 2.0; // S-tier mega still cheap
    else if (charScore >= 8.0 && marketUSD < 20) bonus += 1.2;
    else if (charScore >= 6.5 && marketUSD < 12) bonus += 0.6;
  }

  // SWSH Gigantamax only (not all VMAX) — Gigantamax is the truly generation-exclusive
  // mechanic. Regular VMAX is too broad to be a meaningful signal.
  const isSwsh = sc.startsWith('SWSH') || sc.startsWith('SSH');
  const isGmax = n.includes('gigantamax') || n.includes('gmax');
  if (isSwsh && isGmax) {
    if (charScore >= 8.0) bonus += 1.2;
    else if (charScore >= 6.5) bonus += 0.5;
  }

  // 4. High-rarity cards from sets the market dismissed at release
  // Only the top rarity tiers (SIR/AR/IR) where the structural rarity is real.
  const overshadowedSets = /shrouded fable|hidden fates|celebrations|lost origin|chilling reign|evolving skies/i;
  if (overshadowedSets.test(card.s || '') && (rc === 'SIR' || rc === 'IR' || rc === 'AR')) {
    bonus += 0.8;
  }

  return Math.min(3.0, bonus);
}

// Conviction tier: five-level classification layered on top of the BUY/STRONG BUY filter.
// Returns one of: 'must-buy' | 'buy' | 'worth-holding' | 'buy-if-pc' | 'skip'
function _convictionTier(signal, score, upsidePct, gemScore) {
  if (signal === 'STRONG BUY' && upsidePct >= 20 && (gemScore >= 1.5 || score >= 4))
    return 'must-buy';
  if (signal === 'STRONG BUY' || (signal === 'BUY' && upsidePct >= 12))
    return 'buy';
  if (signal === 'BUY' && upsidePct >= 4)
    return 'worth-holding';
  if (signal === 'BUY')
    return 'buy-if-pc'; // BUY signal but minimal model upside — only worth it at a discount
  return 'skip';
}

const _TIER_RANK  = { 'must-buy': 4, 'buy': 3, 'worth-holding': 2, 'buy-if-pc': 1, 'skip': 0 };
const _TIER_LABEL = {
  'must-buy':     'Must buy',
  'buy':          'Buy',
  'worth-holding':'Worth holding',
  'buy-if-pc':    'Buy if cheap',
  'skip':         'Skip',
};

// Single-pass reco builder. Returns all five curated lists at once so the
// expensive card-loop + computeHoldCore work is only done once per rebuild.
function buildAllHomeRecos() {
  if (!cardData || !cardData.cards) return { general: [], raw: [], psa8: [], psa9: [], psa10: [] };
  const dismissed = _getRecoDismissed();
  const ownedIds  = new Set(portfolio.map(p => p.id));
  const wishIds   = new Set(wishlist.map(w => w.id));
  const watchIds  = new Set(watchlist.map(w => w.id));
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const maxBudget = getMaxBudgetGBP();
  const general = [];
  const byStrat  = { raw: [], psa8: [], psa9: [], psa10: [] };
  const seenIds  = new Set();
  // Pre-parse per-card stores once — avoids ~50k localStorage reads inside the loop.
  let allOverrides = {};
  try { allOverrides = JSON.parse(localStorage.getItem(HOLD_OVERRIDE_KEY) || '{}') || {}; } catch {}
  const priceCache = getPriceCache(); // in-memory singleton — no JSON.parse overhead

  for (const c of cardData.cards) {
    if (dismissed.has(c.i)) continue;
    if (ownedIds.has(c.i) || wishIds.has(c.i) || watchIds.has(c.i)) continue;
    if (seenIds.has(c.i)) continue;
    seenIds.add(c.i);

    const overrides = allOverrides[c.i] || {};
    const manualRawGBP = overrides.raw > 0 ? overrides.raw : null;
    const pcEntry = priceCache[c.i];
    const cachedUSD = pcEntry ? (pcEntry.pcUngraded || pcEntry.market || pcEntry.mid || 0) : 0;
    const marketUSD = manualRawGBP ? manualRawGBP / fx : (cachedUSD || c.p || 0);

    if (!marketUSD || marketUSD < 8) continue;
    if (marketUSD * fx > maxBudget) continue; // general section: budget filter on raw price

    let pullCost = 7.65;
    if (setsData && setsData[c.sc]) {
      const set = setsData[c.sc];
      const rarity = set.rarities?.[c.rc];
      if (rarity && rarity.pullRate > 0) {
        const packsPerHit = Math.round(1 / rarity.pullRate);
        pullCost = (packsPerHit * rarity.count) / 100;
      }
    }

    const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(c, pullCost) : { total: 5 };
    const sig = (typeof computeSignal === 'function') ? computeSignal(c, pullCost, des.total) : null;
    if (!sig || (sig.signal !== 'BUY' && sig.signal !== 'STRONG BUY')) continue;

    const modelUSD = (typeof predictPrice === 'function') ? (predictPrice(pullCost, des.total).priceUSD || 0) : 0;
    const upsidePct = modelUSD > marketUSD ? ((modelUSD - marketUSD) / marketUSD * 100) : 0;
    const gemScore  = _gemScore(c, marketUSD);
    const onWatchlist = watchIds.has(c.i);

    const convictionTier = _convictionTier(sig.signal, sig.score, upsidePct, gemScore);

    const base = {
      card: c,
      marketUSD,
      marketGBP: marketUSD * fx,
      manualPrice: !!manualRawGBP,
      signal: sig.signal,
      signalCls: sig.signal === 'STRONG BUY' ? 'sig-strong-buy' : 'sig-buy',
      score: sig.score,
      upsidePct,
      gemScore,
      onWatchlist,
      reasons: sig.reasons || [],
      convictionTier,
    };
    general.push(base);

    // Strategy sections — only cards where that specific strategy is the BEST LONG-TERM PICK
    // (not high-risk, ROI ≥ 35%). Matches exactly what gets the badge on the card's Hold Strategy.
    // PSA grade sections require a live or tracked PSA 10 price — 'estimated' anchors (raw × multiplier)
    // are excluded because the estimate can be wildly wrong (e.g. £78 estimate vs £1,209 live).
    const hc = (typeof computeHoldCore === 'function') ? computeHoldCore(c) : { ok: false };
    if (hc.ok && hc.bestLongTermPick) {
      const wk = hc.bestLongTermPick.key;
      const stratGBP = hc.bestLongTermPick.today * fx;
      const anchorOk = !wk.startsWith('psa') || (hc.anchorSource && hc.anchorSource !== 'estimated');
      if (byStrat[wk] && stratGBP <= maxBudget && anchorOk) {
        byStrat[wk].push({
          ...base,
          strategyRoi:       hc.bestLongTermPick.roi,
          strategyRiskAdj:   hc.bestLongTermPick.riskAdjusted,
          strategyProfitGBP: hc.bestLongTermPick.profit * fx,
          strategyToday:     hc.bestLongTermPick.today * fx,
          anchorSource:      hc.anchorSource,
        });
      }
    }
  }

  // General: conviction tier first, then score + gem weighting within tier
  general.sort((a, b) => {
    const tDiff = (_TIER_RANK[b.convictionTier] || 0) - (_TIER_RANK[a.convictionTier] || 0);
    if (tDiff !== 0) return tDiff;
    const cA = a.score + a.gemScore * 1.5;
    const cB = b.score + b.gemScore * 1.5;
    return cB - cA || b.upsidePct - a.upsidePct;
  });

  // Strategy sections: sorted by strategy ROI descending (highest expected return first)
  Object.values(byStrat).forEach(arr =>
    arr.sort((a, b) => b.strategyRoi - a.strategyRoi)
  );

  return {
    general: general.slice(0, 100),
    raw:     byStrat.raw.slice(0, 100),
    psa8:    byStrat.psa8.slice(0, 100),
    psa9:    byStrat.psa9.slice(0, 100),
    psa10:   byStrat.psa10.slice(0, 100),
  };
}

function _recoTileHtml(r) {
  const id = r.card.i;
  const imgSrc = (typeof getCardImg === 'function') ? getCardImg(r.card) : '';
  const img = imgSrc
    ? `<img class="home-card-art" src="${esc(imgSrc)}" alt="" loading="lazy" onerror="this.style.opacity='0.15'">`
    : `<div class="home-card-art"></div>`;
  const manual = r.manualPrice ? `<span class="reco-manual-tag">manual</span>` : '';
  const gem = r.gemScore >= 2.0 ? `<span class="reco-gem-tag">overlooked</span>` : '';
  const upside = r.upsidePct > 5
    ? `<span class="reco-upside pos">+${r.upsidePct.toFixed(0)}% upside</span>`
    : `<span class="reco-upside">${esc(r.card.s || '')}</span>`;
  const watchTitle = r.onWatchlist ? 'On watchlist' : 'Add to watchlist';
  const watchCls   = r.onWatchlist ? 'reco-watch reco-watch-active' : 'reco-watch';
  const tier = r.convictionTier || 'buy';
  const tierLabel = _TIER_LABEL[tier] || 'Buy';
  const pipBtn1 = `<button class="home-pip-trigger" data-pip-id="${esc(id)}" data-pip-img="${esc(imgSrc || '')}" aria-label="Quick view" title="Quick view">⤢</button>`;
  // Grade price ladder for cards with a PSA 10 anchor
  let gradeLadder1 = '';
  const p10USD1 = r.card.p10 || 0;
  if (p10USD1 > 0) {
    gradeLadder1 = `<div class="reco-grade-ladder">` +
      `<span class="reco-grade-pip">P9 ${fmtGBP(p10USD1 * PSA_RATIOS[9])}</span>` +
      `<span class="reco-grade-pip">P10 ${fmtGBP(p10USD1)}</span>` +
      `</div>`;
  }
  return `<div class="home-card-tile reco-tile" data-id="${esc(id)}">
    ${img}
    <span class="home-card-signal reco-tier reco-tier-${esc(tier)}">${esc(tierLabel)}</span>
    ${pipBtn1}
    <div class="reco-actions">
      <button class="reco-btn reco-dismiss" data-id="${esc(id)}" title="Not interested">✕</button>
      <button class="reco-btn reco-wish" data-id="${esc(id)}" title="Add to wishlist">♡</button>
      <button class="reco-btn ${watchCls}" data-id="${esc(id)}" title="${watchTitle}">◎</button>
      <a class="reco-btn home-card-newtab" href="?card=${esc(id)}" target="_blank" rel="noopener" title="Open in new tab">↗</a>
    </div>
    <div class="home-card-info">
      <div class="home-card-name">${esc(r.card.n)}</div>
      <div class="home-card-price">${fmtGBPDirect(r.marketGBP)}${manual}${gem}</div>
      <div class="home-card-sub">${upside}</div>
      ${gradeLadder1}
    </div>
  </div>`;
}

function _recoStrategyTileHtml(r) {
  const id = r.card.i;
  const imgSrc = (typeof getCardImg === 'function') ? getCardImg(r.card) : '';
  const img = imgSrc
    ? `<img class="home-card-art" src="${esc(imgSrc)}" alt="" loading="lazy" onerror="this.style.opacity='0.15'">`
    : `<div class="home-card-art"></div>`;
  const manual = r.manualPrice ? `<span class="reco-manual-tag">manual</span>` : '';
  const gem    = r.gemScore >= 2.0 ? `<span class="reco-gem-tag">overlooked</span>` : '';
  const roi    = r.strategyRoi !== undefined ? Math.round(r.strategyRoi) : 0;
  const profit = r.strategyProfitGBP !== undefined ? fmtGBPDirect(r.strategyProfitGBP) : '';
  const roiLine = roi > 0
    ? `<span class="reco-upside pos">+${roi}% ROI · ${profit} profit (5yr)</span>`
    : `<span class="reco-upside">${esc(r.card.s || '')}</span>`;
  const watchTitle = r.onWatchlist ? 'On watchlist' : 'Add to watchlist';
  const watchCls   = r.onWatchlist ? 'reco-watch reco-watch-active' : 'reco-watch';
  const displayPrice = r.strategyToday || r.marketGBP;
  const tier = r.convictionTier || 'buy';
  const tierLabel = _TIER_LABEL[tier] || 'Buy';
  const pipBtn2 = `<button class="home-pip-trigger" data-pip-id="${esc(id)}" data-pip-img="${esc(imgSrc || '')}" aria-label="Quick view" title="Quick view">⤢</button>`;
  // Grade price ladder — Raw → PSA 7 → PSA 8 → PSA 9 → PSA 10
  let gradeLadder = '';
  const p10USD = r.card.p10 || 0;
  if (p10USD > 0) {
    const _fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
    const rawGBP = r.marketGBP;
    gradeLadder = `<div class="reco-grade-ladder">` +
      `<span class="reco-grade-pip">Raw ${fmtGBPDirect(rawGBP)}</span>` +
      `<span class="reco-grade-pip">P8 ${fmtGBP(p10USD * PSA_RATIOS[8])}</span>` +
      `<span class="reco-grade-pip">P9 ${fmtGBP(p10USD * PSA_RATIOS[9])}</span>` +
      `<span class="reco-grade-pip">P10 ${fmtGBP(p10USD)}</span>` +
      `</div>`;
  }
  return `<div class="home-card-tile reco-tile" data-id="${esc(id)}">
    ${img}
    <span class="home-card-signal reco-tier reco-tier-${esc(tier)}">${esc(tierLabel)}</span>
    ${pipBtn2}
    <div class="reco-actions">
      <button class="reco-btn reco-dismiss" data-id="${esc(id)}" title="Not interested">✕</button>
      <button class="reco-btn reco-wish" data-id="${esc(id)}" title="Add to wishlist">♡</button>
      <button class="reco-btn ${watchCls}" data-id="${esc(id)}" title="${watchTitle}">◎</button>
      <a class="reco-btn home-card-newtab" href="?card=${esc(id)}" target="_blank" rel="noopener" title="Open in new tab">↗</a>
    </div>
    <div class="home-card-info">
      <div class="home-card-name">${esc(r.card.n)}</div>
      <div class="home-card-price">${fmtGBPDirect(displayPrice)}${manual}${gem}</div>
      <div class="home-card-sub">${roiLine}</div>
      ${gradeLadder}
    </div>
  </div>`;
}

function _recoListClick(e) {
  // View all button
  const viewAllBtn = e.target.closest('.reco-view-all-btn');
  if (viewAllBtn) {
    const section = viewAllBtn.dataset.recoSection;
    if (_recoCached && _recoCached[section]) {
      const titles = { general: 'All Recommendations', raw: 'Buy Raw', psa8: 'Buy PSA 8', psa9: 'Buy PSA 9', psa10: 'Buy PSA 10' };
      _openRecoViewAll(titles[section] || 'Recommendations', _recoCached[section]);
    }
    return;
  }
  // Dismiss
  const dismissBtn = e.target.closest('.reco-dismiss');
  if (dismissBtn) {
    e.stopPropagation();
    const id = dismissBtn.dataset.id;
    const tile = dismissBtn.closest('.home-card-tile') || dismissBtn.closest('.hva-row');
    if (tile) { tile.style.transition = 'transform 0.2s,opacity 0.2s'; tile.style.transform = 'scale(0.8)'; tile.style.opacity = '0'; }
    setTimeout(() => { _dismissReco(id); _renderHomeReco(true); }, 200);
    return;
  }
  // Wishlist
  const wishBtn = e.target.closest('.reco-wish');
  if (wishBtn) {
    e.stopPropagation();
    const id = wishBtn.dataset.id;
    const card = getCardById(id);
    if (card && !wishlist.some(w => w.id === id)) {
      const currentUSD = (typeof getCurrentPrice === 'function') ? getCurrentPrice(card) : 0;
      const currentGBP = usdToGbp(currentUSD);
      wishlist.push({
        id, name: card.n, set: card.s, lang: card.lang || 'EN',
        img: getCardImg(card),
        addedDate: new Date().toISOString(),
        addedPriceGBP: currentGBP,
        targetGBP: +(currentGBP * 0.85).toFixed(2),
      });
      saveWishlist();
      wishBtn.textContent = '♥'; wishBtn.title = 'On wishlist';
      wishBtn.style.background = 'rgba(232,182,52,0.85)'; wishBtn.style.color = '#1a1200';
      _recoCached = null;
      setTimeout(() => _renderHomeReco(true), 500);
    }
    return;
  }
  // Watchlist
  const watchBtn = e.target.closest('.reco-watch');
  if (watchBtn) {
    e.stopPropagation();
    const id = watchBtn.dataset.id;
    const card = getCardById(id);
    if (card && !watchlist.some(w => w.id === id)) {
      const pull = 7.65;
      const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pull).total : 50;
      const sig = (typeof computeSignal === 'function') ? computeSignal(card, pull, des) : null;
      watchlist.push({
        id, name: card.n, set: card.s, lang: card.lang || 'EN',
        img: getCardImg(card),
        addedAt: new Date().toISOString(),
        addedSignal: sig?.signal || 'BUY', addedScore: sig?.score || 0,
        addedPriceUSD: (typeof getCurrentPrice === 'function') ? getCurrentPrice(card) : 0,
        lastNotifiedSignal: sig?.signal || 'BUY',
        lastNotifiedAt: new Date().toISOString(),
      });
      saveWatchlist();
      watchBtn.textContent = '◉'; watchBtn.title = 'On watchlist';
      watchBtn.style.background = 'rgba(61,214,140,0.85)'; watchBtn.style.color = '#072215';
      _recoCached = null;
      setTimeout(() => _renderHomeReco(true), 500);
    }
    return;
  }
  // Tile click → open card (skip reco action buttons, PiP, and new-tab link)
  const tile = e.target.closest('.home-card-tile');
  if (tile && !e.target.closest('.reco-btn') && !e.target.closest('.home-pip-trigger') && !e.target.closest('.home-card-newtab')) _homeItemClick(tile.dataset.id);
}

const _STRAT_SECTIONS = [
  { key: 'raw',  listId: 'homeRecoBuyRawList', countId: 'homeRecoBuyRawCount' },
  { key: 'psa8', listId: 'homeRecoPsa8List',   countId: 'homeRecoPsa8Count'   },
  { key: 'psa9', listId: 'homeRecoPsa9List',   countId: 'homeRecoPsa9Count'   },
  { key: 'psa10',listId: 'homeRecoPsa10List',  countId: 'homeRecoPsa10Count'  },
];

function _bindRecoHandler(el) {
  if (el && !el._recoHandlerBound) {
    el.addEventListener('click', _recoListClick);
    el._recoHandlerBound = true;
  }
}

function _renderHomeReco(forceRebuild) {
  const list = $('homeRecoList');
  if (!list) return;
  _bindRecoHandler(list);
  _STRAT_SECTIONS.forEach(s => _bindRecoHandler($(s.listId)));

  if (forceRebuild) _recoCached = null;

  if (!_recoCached) {
    list.innerHTML = '<div class="home-empty">Scanning…</div>';
    _STRAT_SECTIONS.forEach(s => { const el = $(s.listId); if (el) el.innerHTML = '<div class="home-empty">Scanning…</div>'; });
    // Run scan during browser idle time so the page appears immediately.
    // Safari doesn't support requestIdleCallback; fall back to a 1ms timeout
    // which still yields to the paint task before the scan begins.
    const _ric = typeof requestIdleCallback === 'function'
      ? f => requestIdleCallback(f, { timeout: 3000 })
      : f => setTimeout(f, 1);
    _ric(() => {
      const all = buildAllHomeRecos();
      _recoCached = { ...all, ts: Date.now() };
      _renderHomeRecoResults(all.general, list, $('homeRecoCount'));
      _STRAT_SECTIONS.forEach(s => _renderHomeRecoStratResults(all[s.key], $(s.listId), $(s.countId), s.key));
      _renderRecoConsiderGrading(all.general);
      // Fetch live prices for top reco cards so PSA10 tiles don't show stale static prices
      _homeRecoPrefetch(all);
    });
  } else {
    _renderHomeRecoResults(_recoCached.general, list, $('homeRecoCount'));
    _STRAT_SECTIONS.forEach(s => _renderHomeRecoStratResults(_recoCached[s.key], $(s.listId), $(s.countId), s.key));
    _renderRecoConsiderGrading(_recoCached.general);
  }
}

const RECO_HOME_LIMIT = 5;

function _recoViewAllTile(section, total) {
  return `<div class="reco-view-all-tile"><button class="reco-view-all-btn" data-reco-section="${section}">View all ${total} ↗</button></div>`;
}

function _renderHomeRecoResults(results, list, countEl) {
  if (!list) return;
  if (countEl) countEl.textContent = results.length;
  if (!results.length) {
    list.innerHTML = '<div class="home-empty">No new recommendations right now — all BUY signals are already in your collection or wishlist.</div>';
    return;
  }
  const shown = results.slice(0, RECO_HOME_LIMIT);
  const extra = results.length > RECO_HOME_LIMIT ? _recoViewAllTile('general', results.length) : '';
  list.innerHTML = shown.map(_recoTileHtml).join('') + extra;
}

function _renderHomeRecoStratResults(results, list, countEl, sectionKey) {
  if (!list) return;
  if (countEl) countEl.textContent = results.length;
  if (!results.length) {
    list.innerHTML = '<div class="home-empty">No cards match this strategy right now — check back after prices refresh.</div>';
    return;
  }
  const shown = results.slice(0, RECO_HOME_LIMIT);
  const extra = results.length > RECO_HOME_LIMIT ? _recoViewAllTile(sectionKey || 'raw', results.length) : '';
  list.innerHTML = shown.map(_recoStrategyTileHtml).join('') + extra;
}

// ── Home "View All" modal ─────────────────────────────────────
let _hvaItems  = [];  // [{id, name, img, price, sub, signal, sigClass}]
let _hvaTitle  = '';

function openHomeViewAll(title, items) {
  _hvaTitle  = title;
  _hvaItems  = items;
  const modal   = $('hvaModal');
  const overlay = $('hvaOverlay');
  const search  = $('hvaSearch');
  const titleEl = $('hvaTitle');
  if (titleEl) titleEl.textContent = title;
  if (search) search.value = '';
  if (modal)   { modal.style.display   = 'flex'; modal.setAttribute('aria-hidden',   'false'); }
  if (overlay) { overlay.style.display = 'block'; overlay.setAttribute('aria-hidden', 'false'); }
  document.body.style.overflow = 'hidden';
  renderHvaGrid('');
  setTimeout(() => search?.focus(), 60);
}
function closeHomeViewAll() {
  const modal   = $('hvaModal');
  const overlay = $('hvaOverlay');
  const search  = $('hvaSearch');
  if (modal)   { modal.style.display   = 'none'; modal.setAttribute('aria-hidden',   'true'); }
  if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
  document.body.style.overflow = '';
  if (search) search.oninput = null;
}

// Compact list row for reco view-all (ranked, with inline action buttons)
function _recoViewRow(r, i) {
  const id     = r.card.i;
  const imgSrc = (typeof getCardImg === 'function') ? getCardImg(r.card) : '';
  const img    = imgSrc
    ? `<img class="hva-row-img" src="${esc(imgSrc)}" alt="" loading="lazy" onerror="this.style.opacity='0.15'">`
    : `<div class="hva-row-img"></div>`;
  const price  = r.strategyToday || r.marketGBP;
  const sub    = r.strategyRoi > 0
    ? `+${Math.round(r.strategyRoi)}% ROI`
    : (r.upsidePct > 1 ? `+${Math.round(r.upsidePct)}% upside` : '');
  const tier      = r.convictionTier || 'buy';
  const tierLabel = _TIER_LABEL[tier] || 'Buy';
  return `<div class="hva-row" data-id="${esc(id)}">
    <div class="hva-row-rank">${i + 1}</div>
    ${img}
    <div class="hva-row-body">
      <div class="hva-row-name">${esc(r.card.n)}</div>
      <div class="hva-row-set">${esc(r.card.s || '')}</div>
      <span class="hva-row-sig reco-tier reco-tier-${esc(tier)}">${esc(tierLabel)}</span>
    </div>
    <div class="hva-row-right">
      <div class="hva-row-price">${price > 0 ? fmtGBPDirect(price) : '—'}</div>
      ${sub ? `<div class="hva-row-sub">${esc(sub)}</div>` : ''}
    </div>
    <button class="home-pip-trigger" data-pip-id="${esc(id)}" data-pip-img="${esc(imgSrc || '')}" aria-label="Quick view">⤢</button>
    <div class="hva-row-acts">
      <button class="hva-row-act reco-dismiss" data-id="${esc(id)}" title="Not interested">✕</button>
      <button class="hva-row-act reco-wish"    data-id="${esc(id)}" title="Add to wishlist">♡</button>
      <button class="hva-row-act reco-watch"   data-id="${esc(id)}" title="Watch">◎</button>
    </div>
  </div>`;
}

function _openRecoViewAll(title, results) {
  const modal   = $('hvaModal');
  const overlay = $('hvaOverlay');
  const grid    = $('hvaGrid');
  const titleEl = $('hvaTitle');
  const countEl = $('hvaCount');
  const search  = $('hvaSearch');
  if (!modal || !grid) return;
  if (titleEl) titleEl.textContent = title;
  if (search) search.value = '';

  function _render(q) {
    const lq = (q || '').trim().toLowerCase();
    const items = lq
      ? results.filter(r => r.card.n.toLowerCase().includes(lq) || (r.card.s || '').toLowerCase().includes(lq))
      : results;
    if (countEl) countEl.textContent = `${items.length} card${items.length !== 1 ? 's' : ''}`;
    grid.innerHTML = items.length
      ? items.map(_recoViewRow).join('')
      : `<div class="hva-empty">${lq ? 'No cards match that search.' : 'Nothing here yet.'}</div>`;
    _bindRecoHandler(grid);
    grid.querySelectorAll('.hva-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.hva-row-acts') || e.target.closest('.home-pip-trigger')) return;
        const img = row.querySelector('img.hva-row-img');
        openHomePip(row.dataset.id, img?.src || '');
      });
    });
  }
  _render('');
  if (search) search.oninput = () => _render(search.value);
  if (modal)   { modal.style.display = 'flex'; modal.setAttribute('aria-hidden', 'false'); }
  if (overlay) { overlay.style.display = 'block'; overlay.setAttribute('aria-hidden', 'false'); }
  document.body.style.overflow = 'hidden';
  setTimeout(() => search?.focus(), 60);
}

// Compact list row for collection / wishlist / watchlist view-all
function renderHvaGrid(query) {
  const grid    = $('hvaGrid');
  const countEl = $('hvaCount');
  if (!grid) return;
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? _hvaItems.filter(it => it.name.toLowerCase().includes(q) || (it.sub || '').toLowerCase().includes(q))
    : _hvaItems;
  if (countEl) countEl.textContent = `${filtered.length} card${filtered.length !== 1 ? 's' : ''}`;
  if (!filtered.length) {
    grid.innerHTML = `<div class="hva-empty">${q ? 'No cards match that search.' : 'Nothing here yet.'}</div>`;
    return;
  }
  grid.innerHTML = filtered.map(it => {
    const img = it.img
      ? `<img class="hva-row-img" src="${esc(it.img)}" alt="" loading="lazy" onerror="this.style.opacity='0'">`
      : `<div class="hva-row-img"></div>`;
    const sig = it.sigClass && it.signal
      ? `<span class="hva-row-sig ${esc(it.sigClass)}">${esc(it.signal)}</span>` : '';
    const pip = it.id
      ? `<button class="home-pip-trigger" data-pip-id="${esc(it.id)}" data-pip-img="${esc(it.img || '')}" aria-label="Quick view">⤢</button>`
      : '';
    return `<div class="hva-row" data-id="${esc(it.id)}">
      ${img}
      <div class="hva-row-body">
        <div class="hva-row-name">${esc(it.name)}</div>
        <div class="hva-row-set">${esc(it.sub || '')}</div>
        ${sig}
      </div>
      <div class="hva-row-right">
        <div class="hva-row-price">${it.price || '—'}</div>
      </div>
      ${pip}
    </div>`;
  }).join('');
  grid.querySelectorAll('.hva-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.hva-row-acts') || e.target.closest('.home-pip-trigger')) return;
      const img = row.querySelector('img.hva-row-img');
      openHomePip(row.dataset.id, img?.src || '');
    });
  });
}
function _buildCollectionItems() {
  return portfolio.map(p => {
    const card = getCardById(p.id);
    const cached = getCachedPrice(p.id);
    const priceUSD = cached ? (cached.market || cached.mid || (card ? card.p : p.price)) : (card ? card.p : p.price);
    const priceGBP = usdToGbp(priceUSD);
    let signal = null, sigClass = null;
    if (card) {
      let pull = 7.65;
      if (setsData?.[card.sc]) {
        const r = setsData[card.sc].rarities?.[card.rc];
        if (r?.pullRate > 0) pull = Math.round(1 / r.pullRate) * r.count / 100;
      }
      const sig = computeSignal(card, pull, autoFillDesirability(card, pull).total);
      if (sig) { signal = sig.signal; sigClass = signal === 'STRONG BUY' ? 'sig-strong-buy' : signal === 'BUY' ? 'sig-buy' : signal === 'SELL' ? 'sig-sell' : 'sig-hold'; }
    }
    return { id: p.id, name: p.name, img: p.img, price: fmtGBPDirect(priceGBP), sub: p.set, signal, sigClass };
  });
}
function _buildWishlistItems() {
  const maxBudget = getMaxBudgetGBP();
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  return wishlist.flatMap(w => {
    const card = getCardById(w.id);
    if (!card) return [];
    const hc = computeHoldCore(card);
    const budgetPick = hc.ok ? _bestInBudgetPick(card, maxBudget, fx) : null;
    const cached = getCachedPrice(w.id) || getLastKnownPrice(w.id);
    const usd = (budgetPick ? null : cached) ? (cached.pcUngraded || cached.market || cached.mid || card.p) : card.p;
    const displayGBP = budgetPick ? budgetPick.displayGBP : usdToGbp(usd) || 0;
    const target = w.targetGBP || 0;
    let sigClass = 'alert-far', signal = 'Watching';
    if (target > 0) {
      if (displayGBP <= target) { sigClass = 'alert-buy'; signal = 'BUY NOW'; }
      else if (displayGBP <= target * 1.10) { sigClass = 'alert-watch'; signal = 'Close'; }
    }
    const sub = [target > 0 ? `Target: ${fmtGBPDirect(target)}` : w.set, budgetPick ? budgetPick.stratLabel : ''].filter(Boolean).join(' · ');
    return [{ id: w.id, name: w.name, img: w.img, price: displayGBP > 0 ? fmtGBPDirect(displayGBP) : '—', sub, signal, sigClass }];
  });
}
function _buildWatchlistItems() {
  const maxBudget = getMaxBudgetGBP();
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const alerts = (typeof computeActiveAlerts === 'function') ? computeActiveAlerts() : [];
  const alertMap = Object.fromEntries(alerts.map(a => [a.id, a]));
  return watchlist.flatMap(w => {
    const card = getCardById(w.id);
    if (!card) return [];
    const hc = computeHoldCore(card);
    const budgetPick = hc.ok ? _bestInBudgetPick(card, maxBudget, fx) : null;
    const cached = getCachedPrice(w.id) || getLastKnownPrice(w.id);
    const usd = (budgetPick ? null : cached) ? (cached.pcUngraded || cached.market || cached.mid || card.p) : card.p;
    const displayGBP = budgetPick ? budgetPick.displayGBP : usdToGbp(usd) || 0;
    const a = alertMap[w.id];
    const signal = a ? a.signal : (w.addedSignal || '—');
    const sc = signal === 'STRONG BUY' ? 'sig-strong-buy' : signal === 'BUY' ? 'sig-buy' : signal === 'SELL' ? 'sig-sell' : 'sig-hold';
    const sub = [w.set, budgetPick ? budgetPick.stratLabel : ''].filter(Boolean).join(' · ');
    return [{ id: w.id, name: w.name, img: w.img, price: displayGBP > 0 ? fmtGBPDirect(displayGBP) : '—', sub, signal, sigClass: sc }];
  });
}
function setupHomeViewAll() {
  $('hvaClose')?.addEventListener('click', closeHomeViewAll);
  $('hvaOverlay')?.addEventListener('click', closeHomeViewAll);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('hvaModal')?.style.display !== 'none') closeHomeViewAll();
  });
  let _hvaSearchTimer;
  $('hvaSearch')?.addEventListener('input', e => {
    clearTimeout(_hvaSearchTimer);
    _hvaSearchTimer = setTimeout(() => renderHvaGrid(e.target.value), 120);
  });
}

function setupHomeScrollControls() {
  document.querySelectorAll('.home-section-wrap').forEach(wrap => {
    const row = wrap.querySelector('.home-scroll-row');
    if (!row) return;
    const hd = wrap.querySelector('.home-section-hd');

    if (hd && !hd.querySelector('.home-scroll-arrows')) {
      const arrows = document.createElement('div');
      arrows.className = 'home-scroll-arrows';
      arrows.innerHTML =
        '<button class="home-scroll-btn prev" aria-label="Scroll left">‹</button>' +
        '<button class="home-scroll-btn next" aria-label="Scroll right">›</button>';
      const viewAll = hd.querySelector('.home-view-all');
      if (viewAll) hd.insertBefore(arrows, viewAll);
      else hd.appendChild(arrows);
    }

    if (!wrap.querySelector('.home-scroll-bar')) {
      const bar = document.createElement('div');
      bar.className = 'home-scroll-bar';
      bar.setAttribute('aria-hidden', 'true');
      bar.innerHTML = '<div class="home-scroll-thumb"></div>';
      row.insertAdjacentElement('afterend', bar);
    }

    const prev  = hd?.querySelector('.home-scroll-btn.prev');
    const next  = hd?.querySelector('.home-scroll-btn.next');
    const bar   = wrap.querySelector('.home-scroll-bar');
    const thumb = wrap.querySelector('.home-scroll-thumb');

    function update() {
      const { scrollLeft: sl, scrollWidth: sw, clientWidth: cw } = row;
      if (prev) prev.disabled = sl <= 2;
      if (next) next.disabled = sl >= sw - cw - 2;
      if (!thumb || !bar) return;
      const ratio = cw / sw;
      bar.style.opacity = ratio >= 1 ? '0' : '1';
      bar.style.pointerEvents = ratio >= 1 ? 'none' : 'auto';
      const barW = bar.offsetWidth;
      const thumbW = Math.max(36, ratio * barW);
      const thumbX = sw > cw ? (sl / (sw - cw)) * (barW - thumbW) : 0;
      thumb.style.width = thumbW + 'px';
      thumb.style.transform = 'translateX(' + thumbX + 'px)';
    }

    const step = () => Math.round(row.clientWidth * 0.75);
    if (prev) prev.addEventListener('click', () => row.scrollBy({ left: -step(), behavior: 'smooth' }));
    if (next) next.addEventListener('click', () => row.scrollBy({ left:  step(), behavior: 'smooth' }));

    row.addEventListener('scroll', update, { passive: true });

    if (thumb && bar) {
      let dragging = false, startX = 0, startScroll = 0;
      thumb.addEventListener('pointerdown', e => {
        dragging = true;
        startX = e.clientX;
        startScroll = row.scrollLeft;
        thumb.classList.add('dragging');
        thumb.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      thumb.addEventListener('pointermove', e => {
        if (!dragging) return;
        const { scrollWidth: sw, clientWidth: cw } = row;
        const scale = (sw - cw) / Math.max(1, bar.offsetWidth - thumb.offsetWidth);
        row.scrollLeft = startScroll + (e.clientX - startX) * scale;
      });
      const endDrag = () => { dragging = false; thumb.classList.remove('dragging'); };
      thumb.addEventListener('pointerup', endDrag);
      thumb.addEventListener('pointercancel', endDrag);
    }

    update();
    new MutationObserver(update).observe(row, { childList: true });
  });
}

function _renderHomeAcePicks() {
  const wrap = $('homeAcePicksWrap');
  const list = $('homeAcePicksList');
  if (!wrap || !list) return;

  if (!portfolio.length || !cardData) { wrap.style.display = 'none'; return; }

  const fx    = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const grade = ACE_FEE_STANDARD_GBP;   // £18
  const label = ACE_FEE_LABEL_GBP;      // £3
  const ship  = ACE_FEE_SHIPPING_GBP;   // £7.99 shared across whole batch

  // Score each portfolio card
  const scored = portfolio.map(p => {
    const dbCard = getCardById(p.id);
    if (!dbCard) return null;
    const cached = getCachedPrice(p.id);

    // ACE 10 price: prefer direct pcAce10 from cache, fall back to PSA 10 × 0.80
    let ace10GBP = 0, fromDirectPC = false;
    if (cached?.pcAce10 > 0) {
      ace10GBP = cached.pcAce10 * fx;
      fromDirectPC = true;
    } else {
      const psa10USD = cached?.pcPsa10 || dbCard.p10 || 0;
      if (psa10USD > 0) ace10GBP = psa10USD * fx * 0.80;
    }
    if (ace10GBP <= 0) return null;

    // Raw price: live cached ungraded, then portfolio-add price
    const rawGBP = (cached?.pcUngraded > 0 ? cached.pcUngraded * fx : 0)
      || p.addedPriceGBP
      || (p.price ? p.price * fx : 0);
    if (rawGBP <= 0) return null;

    // Per-card cost excludes batch shipping (shown separately); include in ROI calc
    const totalFee = grade + label + ship;
    const profit   = ace10GBP - rawGBP - totalFee;
    if (profit <= 0) return null;

    const roi = Math.round(profit / (rawGBP + totalFee) * 100);
    return { p, dbCard, ace10GBP, rawGBP, profit, roi, fromDirectPC };
  }).filter(Boolean).sort((a, b) => b.profit - a.profit);

  const countEl = $('homeAcePicksCount');
  if (countEl) countEl.textContent = scored.length;

  if (!scored.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  // Batch shipping note
  const batchEl = $('homeAcePicksBatchNote');
  if (batchEl) {
    const n = scored.length;
    const perCard = (ship / Math.min(n, 10)).toFixed(2);
    batchEl.textContent = `£${ship.toFixed(2)} shipping covers the entire batch — sending all ${n} pick${n !== 1 ? 's' : ''} together works out to ~£${perCard}/card for shipping.`;
  }

  list.innerHTML = scored.slice(0, 12).map(({ p, dbCard, ace10GBP, rawGBP, profit, roi, fromDirectPC }) => {
    const img = p.img || getCardImg(dbCard) || '';
    const imgEl = img
      ? `<img class="ace-pick-art" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.opacity='0'">`
      : `<div class="ace-pick-art"></div>`;
    const pcBadge = fromDirectPC
      ? `<span class="ace-pick-pc-badge">PC live</span>`
      : `<span class="ace-pick-pc-badge" style="opacity:0.6">~est.</span>`;
    return `<div class="ace-pick-tile" data-id="${esc(p.id)}">
      ${imgEl}
      ${pcBadge}
      <div class="ace-pick-name">${esc(dbCard.n)}</div>
      <div class="ace-pick-set">${esc(dbCard.s || '')}${dbCard.num ? ' #' + dbCard.num : ''}</div>
      <div class="ace-pick-profit">+${fmtGBPDirect(profit)}</div>
      <div class="ace-pick-roi">+${roi}% ROI</div>
      <div class="ace-pick-raw">Raw ${fmtGBPDirect(rawGBP)} · ACE 10 ${fmtGBPDirect(ace10GBP)}</div>
    </div>`;
  }).join('');

  // Clicking a tile navigates to that card in Predict
  list.querySelectorAll('.ace-pick-tile').forEach(tile => {
    tile.addEventListener('click', () => _homeItemClick(tile.dataset.id));
  });
}

function renderHomeDashboard() {
  _renderHomeCollection();
  _renderHomeCombinedWishlist();
  _renderHomeConsiderGrading();
  _renderHomeAiGrades();
  _renderHomeGradeCandidates();
  _renderHomeAcePicks();
  _renderHomeReco(); // use cache if valid; savePortfolio/Wishlist/Watchlist null it on change
}

// Silently refresh stale tracked card prices in the background when the user
// navigates home. Re-renders collection/wishlist/watchlist progressively as
// each price arrives, then force-rebuilds recommendations at the end.
async function _homeAutoRefresh() {
  if (_psState.running || !cardData) return;
  const cache = getPriceCache();
  const now = Date.now();
  const staleIds = _allRefreshIds().filter(id => {
    const e = cache[id];
    return !e || (now - (e._ts || 0)) > PRICE_CACHE_TTL;
  });
  if (!staleIds.length) return;
  _psState = { running: true, cancel: false, done: 0, total: staleIds.length };
  let cursor = 0;
  const worker = async () => {
    while (cursor < staleIds.length && !_psState.cancel) {
      const id = staleIds[cursor++];
      await psRefreshOne(id);
      _psState.done++;
      _scheduleHomeRender();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PRICE_SYNC_CONCURRENCY, staleIds.length) }, worker));
  psSetLastSync(Date.now());
  _psState.running = false;
  try { _renderHomeCollection(); _renderHomeWishlist(); _renderHomeWatchlist(); } catch {}
  try { _renderHomeAiGrades(); _renderHomeGradeCandidates(); _renderHomeAcePicks(); } catch {}
  try { _renderHomeReco(true); } catch {}
}

function _homeItemClick(id) {
  document.querySelector('.page-nav-btn[data-page="predict"]')?.click();
  setTimeout(() => selectCard(id), 80);
}

let _homePipId = null;

function openHomePip(id, imgUrl) {
  const pip = document.getElementById('homePip');
  if (!pip) return;
  _homePipId = id;

  const card = (typeof getCardById === 'function') ? getCardById(id) : null;

  const imgEl = document.getElementById('homePipImg');
  if (imgUrl) { imgEl.src = imgUrl; imgEl.style.display = ''; }
  else imgEl.style.display = 'none';

  document.getElementById('homePipName').textContent = card ? card.n : '';
  document.getElementById('homePipSet').textContent  = card ? (card.s || '') : '';

  // Pill elements
  const pillName = document.getElementById('homePipPillName');
  const pillPrice = document.getElementById('homePipPillPrice');
  if (pillName) pillName.textContent = card ? card.n : '';

  // Price from cache (shown immediately while live fetch runs)
  const cachedData = (typeof getCachedPrice === 'function') ? (getCachedPrice(id) || getLastKnownPrice(id)) : null;
  const _calcMid = d => (d && d.pcUngraded > 0 && d.tcgMarket > 0)
    ? (d.pcUngraded + d.tcgMarket) / 2
    : (d ? (d.pcUngraded || d.tcgMarket || d.market || d.mid || 0) : 0);
  let _pipPriceUSD = _calcMid(cachedData) || (card ? card.p : 0);

  const priceEl  = document.getElementById('homePipPrice');
  const psa10El  = document.getElementById('homePipPsa10');
  const liveDot  = document.getElementById('homePipLiveDot');

  function _pipSetPrice(usd, psa10USD) {
    if (priceEl)  priceEl.textContent  = usd > 0    ? fmtGBP(usd)    : '—';
    if (psa10El)  psa10El.textContent  = psa10USD > 0 ? fmtGBP(psa10USD) : '—';
    if (pillPrice) pillPrice.textContent = usd > 0   ? fmtGBP(usd)    : '—';
  }

  // Show cached price immediately
  const cachedPsa10 = cachedData?.pcPsa10 || (card?.p10 || 0);
  _pipSetPrice(_pipPriceUSD, cachedPsa10);

  // 5yr expected growth
  const potentialEl     = document.getElementById('homePipPotential');
  const rationaleEl     = document.getElementById('homePipPotentialRationale');
  if (potentialEl && card) {
    try {
      const fc = forecast(card, 0, 5);
      const yr5USD = fc.scenarios.expected[4].priceUSD;
      const pct = fc.currentPriceUSD > 0 ? Math.round((yr5USD / fc.currentPriceUSD - 1) * 100) : 0;
      potentialEl.textContent = `${fmtGBP(yr5USD)} · +${pct}%`;
      if (rationaleEl) {
        const annualPct = (fc.scenarios.expected[0].rate * 100).toFixed(1);
        const rarityLabel = (RARITY_RATES[card.rc] || RARITY_RATES['']).label;
        const charLabel = fc.charMult > 1 ? ` · ×${fc.charMult.toFixed(1)} char` : '';
        const ageLabel = fc.ageMonths >= 48 ? ' · vintage' : fc.ageMonths < 6 ? ' · very new' : fc.ageMonths < 24 ? ' · recent' : '';
        rationaleEl.textContent = `${rarityLabel}${charLabel} · ${annualPct}%/yr${ageLabel}`;
      }
    } catch {
      potentialEl.textContent = '—';
      if (rationaleEl) rationaleEl.textContent = '';
    }
  } else {
    if (potentialEl) potentialEl.textContent = '—';
    if (rationaleEl) rationaleEl.textContent = '';
  }

  // Max buy — grade-aware, updates when live prices arrive
  function _pipUpdateMaxBuy() {
    const grade = document.getElementById('homePipGrade')?.value || 'raw';
    let maxUSD = _pipPriceUSD;
    if (grade !== 'raw' && card) {
      const anchor = getPsa10Anchor(card);
      const psa10USD = anchor && anchor.usd > 0 ? anchor.usd : (card.p10 || 0);
      const gradeNum = parseInt(grade, 10);
      if (psa10USD > 0) maxUSD = psa10USD * (PSA_RATIOS[gradeNum] || 1);
    }
    const el = document.getElementById('homePipMaxBuy');
    if (el) el.textContent = maxUSD > 0 ? fmtGBP(maxUSD) : '—';
  }
  _pipUpdateMaxBuy();
  const gradeSelect = document.getElementById('homePipGrade');
  if (gradeSelect) gradeSelect.onchange = _pipUpdateMaxBuy;

  // Auto-fetch live prices — show dot while loading, update on complete
  if (card && typeof fetchFreshPriceData === 'function') {
    if (liveDot) liveDot.style.display = '';
    fetchFreshPriceData(card).then(priceData => {
      if (_homePipId !== id) return; // PiP was closed or changed card
      if (priceData) {
        if (typeof setCachedPrice === 'function') setCachedPrice(id, priceData);
        const liveUSD = _calcMid(priceData);
        if (liveUSD > 0) { _pipPriceUSD = liveUSD; }
        _pipSetPrice(_pipPriceUSD, priceData.pcPsa10 || cachedPsa10);
        _pipUpdateMaxBuy();
        // Refresh home tiles immediately so any stale price/signal is corrected,
        // and rebuild buy recommendations so over-budget cards are removed at once.
        try { _renderHomeCollection(); } catch {}
        try { _renderHomeReco(true); } catch {}
      }
      if (liveDot) liveDot.style.display = 'none';
    }).catch(() => { if (liveDot) liveDot.style.display = 'none'; });
  }

  document.getElementById('homePipView').onclick = () => { closeHomePip(); closeHomeViewAll(); _homeItemClick(id); };

  // Wish / Watch toggle buttons
  const _pipWishBtn  = document.getElementById('homePipWish');
  const _pipWatchBtn = document.getElementById('homePipWatch');
  function _pipSyncWish() {
    if (!_pipWishBtn) return;
    const on = wishlist.some(w => w.id === id);
    _pipWishBtn.textContent = on ? '♥' : '♡';
    _pipWishBtn.classList.toggle('pip-action-active', on);
  }
  function _pipSyncWatch() {
    if (!_pipWatchBtn) return;
    const on = watchlist.some(w => w.id === id);
    _pipWatchBtn.textContent = on ? '◉' : '◎';
    _pipWatchBtn.classList.toggle('pip-action-active', on);
  }
  if (_pipWishBtn && card) {
    _pipSyncWish();
    _pipWishBtn.onclick = () => {
      if (wishlist.some(w => w.id === id)) {
        wishlist = wishlist.filter(w => w.id !== id);
        saveWishlist(); renderWishlist(); updateWishlistButton();
      } else {
        const priceGBP = usdToGbp(_pipPriceUSD);
        wishlist.push({ id, name: card.n, set: card.s, lang: card.lang || 'EN', img: getCardImg(card), addedDate: new Date().toISOString(), addedPriceGBP: priceGBP, targetGBP: +(priceGBP * 0.85).toFixed(2) });
        saveWishlist(); renderWishlist(); updateWishlistButton();
        _recoCached = null; setTimeout(() => _renderHomeReco(true), 500);
      }
      _pipSyncWish();
      _scheduleHomeRender();
    };
  } else if (_pipWishBtn) { _pipWishBtn.onclick = null; }
  if (_pipWatchBtn && card) {
    _pipSyncWatch();
    _pipWatchBtn.onclick = () => {
      if (watchlist.some(w => w.id === id)) {
        watchlist = watchlist.filter(w => w.id !== id);
        saveWatchlist();
      } else {
        const pull = 7.65;
        const des = (typeof autoFillDesirability === 'function') ? autoFillDesirability(card, pull) : { total: 50 };
        const sig = (typeof computeSignal === 'function') ? computeSignal(card, pull, des.total) : null;
        watchlist.push({ id, name: card.n, set: card.s, lang: card.lang || 'EN', img: getCardImg(card), addedAt: new Date().toISOString(), addedSignal: sig?.signal || 'BUY', addedScore: sig?.score || 0, addedPriceUSD: _pipPriceUSD, lastNotifiedSignal: sig?.signal || 'BUY', lastNotifiedAt: new Date().toISOString() });
        saveWatchlist();
        _recoCached = null; setTimeout(() => _renderHomeReco(true), 500);
      }
      _pipSyncWatch();
      _scheduleHomeRender();
    };
  } else if (_pipWatchBtn) { _pipWatchBtn.onclick = null; }

  pip.classList.remove('pip-collapsed');
  pip.style.display = '';
  requestAnimationFrame(() => pip.classList.add('pip-visible'));
}

function closeHomePip() {
  const pip = document.getElementById('homePip');
  if (!pip) return;
  pip.classList.remove('pip-visible', 'pip-collapsed');
  setTimeout(() => { pip.style.display = 'none'; _homePipId = null; }, 280);
}

function collapseHomePip() {
  const pip = document.getElementById('homePip');
  if (!pip) return;
  pip.classList.add('pip-collapsed');
}

function expandHomePip() {
  const pip = document.getElementById('homePip');
  if (!pip) return;
  pip.classList.remove('pip-collapsed');
}

function _setupHomePip() {
  document.getElementById('homePipClose')?.addEventListener('click', closeHomePip);
  document.getElementById('homePipCollapse')?.addEventListener('click', collapseHomePip);
  document.getElementById('homePipExpand')?.addEventListener('click', expandHomePip);
  document.getElementById('homePipCloseFromPill')?.addEventListener('click', closeHomePip);
  document.getElementById('homePipBg')?.addEventListener('click', closeHomePip);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && _homePipId) closeHomePip(); });
  document.addEventListener('click', e => {
    const btn = e.target.closest('.home-pip-trigger');
    if (!btn) return;
    e.stopPropagation();
    openHomePip(btn.dataset.pipId, btn.dataset.pipImg);
  });
}

function _homeTile(id, imgUrl, name, price, signalClass, signalLabel, extraClass, subText, opts = {}) {
  const hiresImgUrl = _hiresUrl(imgUrl);
  const img = hiresImgUrl
    ? `<img class="home-card-art" src="${hiresImgUrl}" alt="" loading="lazy" onerror="this.style.opacity='0'">`
    : `<div class="home-card-art"></div>`;
  const signal = signalClass && signalLabel
    ? `<span class="home-card-signal ${signalClass}">${signalLabel}</span>`
    : '';
  const sub = subText ? `<div class="home-card-sub">${esc(subText)}</div>` : '';
  const tileClass = ['home-card-tile', extraClass, opts.urgentBuy ? 'urgent-buy' : ''].filter(Boolean).join(' ');
  const hiddenAttr = opts.hidden ? ' style="display:none"' : '';
  const dealUrlAttr = opts.dealUrl ? ` data-deal-url="${esc(opts.dealUrl)}"` : '';
  // PiP + new-tab buttons only for real card IDs (not listing URLs)
  const isRealCard = !opts.dealUrl && id && !id.startsWith('http');
  const pipBtn = isRealCard
    ? `<button class="home-pip-trigger" data-pip-id="${esc(id)}" data-pip-img="${esc(hiresImgUrl || '')}" aria-label="Quick view" title="Quick view">⤢</button>`
    : '';
  const newTabBtn = isRealCard
    ? `<a class="home-card-newtab" href="?card=${esc(id)}" target="_blank" rel="noopener" title="Open in new tab">↗</a>`
    : '';
  return `<div class="${tileClass}" data-id="${esc(id)}"${hiddenAttr}${dealUrlAttr}>
    ${img}${signal}${pipBtn}${newTabBtn}
    <button class="home-card-remove" aria-label="Remove">✕</button>
    <div class="home-card-info">
      <div class="home-card-name">${esc(name)}</div>
      <div class="home-card-price">${price}</div>
      ${sub}
    </div>
  </div>`;
}

function _setupTileEvents(scrollEl, deleteFn) {
  if (!scrollEl || scrollEl._tileWired) return;
  scrollEl._tileWired = true;
  scrollEl.addEventListener('click', e => {
    const removeBtn = e.target.closest('.home-card-remove');
    if (removeBtn) {
      e.stopPropagation();
      const tile = removeBtn.closest('.home-card-tile');
      if (!tile) return;
      const id = tile.dataset.id;
      tile.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
      tile.style.transform = 'scale(0.8)';
      tile.style.opacity = '0';
      setTimeout(() => deleteFn(id), 210);
      return;
    }
    const tile = e.target.closest('.home-card-tile');
    if (!tile || e.target.closest('.home-pip-trigger') || e.target.closest('.home-card-newtab')) return;
    if (tile.dataset.dealUrl) {
      window.open(tile.dataset.dealUrl, '_blank', 'noopener');
    } else {
      _homeItemClick(tile.dataset.id);
    }
  });
}

// ─── Home render deduplication ─────────────────────────────
let _homeCollHash = '', _homeWishHash = '', _homeWatchHash = '';
let _homeAiG10Hash = '', _homeAiG9Hash = '', _homeGradeCandHash = '';
let _homeRenderTimer = null;
function _scheduleHomeRender() {
  clearTimeout(_homeRenderTimer);
  _homeRenderTimer = setTimeout(() => {
    try { _renderHomeCollection(); _renderHomeWishlist(); _renderHomeWatchlist(); } catch {}
    try { _renderHomeAiGrades(); _renderHomeGradeCandidates(); _renderHomeAcePicks(); } catch {}
  }, 350);
}

// eBay listings that were AI graded PSA 10 or PSA 9 via the marketplace scan.
// Tiles link back to the eBay listing (not the card page).
function _renderHomeAiGrades() {
  const list10 = $('homeAiG10List'), list9 = $('homeAiG9List');
  const wrap10 = $('homeAiG10Wrap'), wrap9 = $('homeAiG9Wrap');
  if (!list10 || !list9) return;
  const allDeals = JSON.parse(localStorage.getItem('pkm-ai-grade-deals-v1') || '[]');
  const byGrade  = g => allDeals.filter(d => d.aiGrade === g);
  const g10 = byGrade(10), g9 = byGrade(9);
  const h10 = g10.map(d => d.listingUrl).join('|');
  const h9  = g9.map(d => d.listingUrl).join('|');
  if (wrap10) wrap10.style.display = g10.length ? '' : 'none';
  if (wrap9)  wrap9.style.display  = g9.length  ? '' : 'none';
  const renderDeals = (deals, list, hash, hashKey, labelCls, label, countId) => {
    if (hash === (hashKey === 10 ? _homeAiG10Hash : _homeAiG9Hash) && list.querySelector('.home-card-tile')) return;
    if (hashKey === 10) _homeAiG10Hash = hash; else _homeAiG9Hash = hash;
    const c = $(countId); if (c) c.textContent = deals.length;
    list.innerHTML = deals.map(d => {
      const img = d.listingImg
        ? `<img class="home-card-art" src="${esc(d.listingImg)}" alt="" loading="lazy" onerror="this.style.opacity='0'">`
        : `<div class="home-card-art"></div>`;
      const price = d.priceGBP ? `£${d.priceGBP.toFixed(2)}` : '';
      const verdict = d.breakdown?.verdict || '';
      return `<div class="home-card-tile" data-id="${esc(d.listingUrl)}" data-deal-url="${esc(d.listingUrl)}">
        ${img}
        <span class="home-card-signal ${labelCls}">${label}</span>
        <button class="home-card-remove" aria-label="Remove">✕</button>
        <div class="home-card-info">
          <div class="home-card-name">${esc(d.cardName || '')}</div>
          <div class="home-card-price">${price}</div>
          ${verdict ? `<div class="home-ai-verdict">${esc(verdict)}</div>` : ''}
          <div class="home-cand-actions">
            <button class="home-cand-grade-btn home-ai-card-btn" data-card-id="${esc(d.cardId || '')}">Card ↗</button>
            <a class="home-cand-ebay-btn" href="${esc(d.listingUrl)}" target="_blank" rel="noopener">eBay ↗</a>
          </div>
        </div>
      </div>`;
    }).join('');
    // Card button → navigate to Predict + select card
    list.querySelectorAll('.home-ai-card-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.cardId;
        if (id && typeof selectCard === 'function') {
          showPage('predict');
          selectCard(id);
        }
      });
    });
    if (deals.length) _setupTileEvents(list, url => {
      localStorage.setItem('pkm-ai-grade-deals-v1', JSON.stringify(allDeals.filter(d => d.listingUrl !== url)));
      _renderHomeAiGrades();
    });
  };
  renderDeals(g10, list10, h10, 10, 'sig-strong-buy', 'PSA 10', 'homeAiG10Count');
  renderDeals(g9,  list9,  h9,  9,  'sig-buy',        'PSA 9',  'homeAiG9Count');
}

// Raw eBay listings with PSA 9-10 text estimate, auto-saved by the marketplace
// scan. Deduped by cardId (max 15 tiles). Main tile click → card page.
function _renderHomeGradeCandidates() {
  const list = $('homeGradeCandList'), wrap = $('homeGradeCandWrap');
  if (!list) return;
  let raw = JSON.parse(localStorage.getItem('pkm-grade-candidates-v1') || '[]');
  // Auto-prune entries that have no listing image (can't AI grade without one)
  const withImg = raw.filter(c => c.listingImg);
  if (withImg.length !== raw.length) {
    raw = withImg;
    localStorage.setItem('pkm-grade-candidates-v1', JSON.stringify(raw));
  }

  // Filter out cards already in the collection — no point buying another raw copy.
  // Exception: keep if the raw price is ≤ 40% of the PSA 10 fair value, which is
  // genuine grading arbitrage worth flagging even for owned cards.
  const ownedIds = new Set(portfolio.map(p => p.id));
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const filtered = raw.filter(d => {
    if (!ownedIds.has(d.cardId)) return true;
    const dbCard = cardData?.cards?.find(x => x.i === d.cardId);
    const p10USD = getCachedPrice(d.cardId)?.pcPsa10 || dbCard?.p10 || 0;
    if (!p10USD || !d.priceGBP) return false;
    return d.priceGBP <= p10USD * fx * 0.40;
  });

  const cands = filtered.slice(0, 15);
  const hash = cands.map(c => c.listingUrl).join('|');
  if (wrap) wrap.style.display = cands.length ? '' : 'none';
  if (hash === _homeGradeCandHash && list.querySelector('.home-card-tile')) return;
  _homeGradeCandHash = hash;
  const countEl = $('homeGradeCandCount'); if (countEl) countEl.textContent = filtered.length;
  list.innerHTML = cands.map(d => {
    const isUpgradeCandidate = ownedIds.has(d.cardId);
    const cardDbImg = (() => {
      const c = cardData?.cards?.find(x => x.i === d.cardId);
      if (c) {
        const url = c.img || getCardImg(c) || '';
        if (url && !url.startsWith('data:')) return url;
      }
      // Derive URL from cardId format ({setCode}-{cardNum}) when card not in DB
      const idStr = String(d.cardId || '');
      if (idStr.startsWith('jp-')) return '';
      const dash = idStr.indexOf('-');
      return dash > 0 ? `https://images.pokemontcg.io/${idStr.slice(0, dash)}/${idStr.slice(dash + 1)}.png` : '';
    })();
    // Primary: eBay listing photo (for AI grading). Fallback: card DB art.
    const primarySrc = d.listingImg || cardDbImg;
    const fallbackSrc = d.listingImg ? cardDbImg : '';
    const onerr = fallbackSrc
      ? `this.onerror=null;this.src='${fallbackSrc.replace(/'/g, "\\'")}'`
      : `this.style.opacity='0'`;
    const img = primarySrc
      ? `<img class="home-card-art" src="${esc(primarySrc)}" alt="" loading="lazy" onerror="${onerr}">`
      : `<div class="home-card-art"></div>`;
    const price = d.priceGBP ? `£${Number(d.priceGBP).toFixed(2)}` : '';
    const signalLabel = isUpgradeCandidate ? 'PSA 10 Upgrade?' : 'AI Grade?';
    const signalCls   = isUpgradeCandidate ? 'sig-strong-buy' : 'sig-buy';
    return `<div class="home-card-tile${isUpgradeCandidate ? ' is-upgrade-cand' : ''}" data-id="${esc(String(d.cardId))}" data-listing-url="${esc(d.listingUrl)}" data-listing-img="${esc(d.listingImg || '')}" data-card-name="${esc(d.cardName || '')}" data-price-gbp="${d.priceGBP || 0}">
      ${img}
      <span class="home-card-signal ${signalCls}">${signalLabel}</span>
      <button class="home-card-remove" aria-label="Remove">✕</button>
      <div class="home-card-info">
        <div class="home-card-name">${esc(d.cardName || '')}</div>
        <div class="home-card-price">${price}</div>
        <div class="home-cand-actions">
          <button class="home-cand-grade-btn">AI Grade</button>
          <a class="home-cand-ebay-btn" href="${esc(d.listingUrl)}" target="_blank" rel="noopener">eBay ↗</a>
        </div>
      </div>
    </div>`;
  }).join('');
  if (cands.length) _setupGradeCandEvents(list);

  const refreshBtn = $('homeGradeCandRefresh');
  if (refreshBtn && !refreshBtn._wired) {
    refreshBtn._wired = true;
    refreshBtn.addEventListener('click', _gradeCandRefresh);
  }
}

function _setupGradeCandEvents(list) {
  list.addEventListener('click', async e => {
    // Dismiss ✕
    const removeBtn = e.target.closest('.home-card-remove');
    if (removeBtn) {
      e.stopPropagation();
      const tile = removeBtn.closest('.home-card-tile');
      if (!tile) return;
      const listingUrl = tile.dataset.listingUrl;
      tile.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
      tile.style.transform = 'scale(0.8)';
      tile.style.opacity = '0';
      setTimeout(() => {
        const store = JSON.parse(localStorage.getItem('pkm-grade-candidates-v1') || '[]');
        localStorage.setItem('pkm-grade-candidates-v1', JSON.stringify(store.filter(c => c.listingUrl !== listingUrl)));
        _homeGradeCandHash = '';
        _renderHomeGradeCandidates();
      }, 210);
      return;
    }
    // AI Grade button
    const gradeBtn = e.target.closest('.home-cand-grade-btn');
    if (gradeBtn) { e.stopPropagation(); _gradeHomeCandidate(gradeBtn); return; }
    // eBay link — let <a> handle it
    if (e.target.closest('.home-cand-ebay-btn')) return;
    // Main tile → card page
    const tile = e.target.closest('.home-card-tile');
    if (tile && tile.dataset.id && !e.target.closest('.home-pip-trigger')) _homeItemClick(tile.dataset.id);
  });
}

async function _gradeHomeCandidate(btn) {
  const tile = btn.closest('.home-card-tile');
  if (!tile) return;
  const listingImg = tile.dataset.listingImg;
  const listingUrl = tile.dataset.listingUrl;
  const cardId     = tile.dataset.id;
  const cardName   = tile.dataset.cardName;
  const priceGBP   = parseFloat(tile.dataset.priceGbp) || 0;
  if (!listingImg) { btn.textContent = 'No image'; return; }

  btn.textContent = 'Grading…';
  btn.disabled = true;

  try {
    const resp = await fetch(`${getMktWorkerUrl()}/grade-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: listingImg }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      let msg = txt; try { msg = JSON.parse(txt).error || txt; } catch {}
      throw new Error(msg || `Worker ${resp.status}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    const scores = [data.centering, data.corners, data.edges, data.surface].filter(v => v != null);
    let grade = null;
    if (scores.length === 4) {
      const min = Math.min(...scores), avg = scores.reduce((a, b) => a + b, 0) / 4;
      if (min >= 10) grade = 10;
      else if (min >= 8 && avg >= 9.5) grade = 10;
      else if (min >= 8 && avg >= 8.5) grade = 9;
      else if (min >= 8) grade = 8;
      else if (min >= 6 && avg >= 7.5) grade = 7;
      else if (min >= 6) grade = 6;
      else if (min >= 4 && avg >= 6) grade = 5;
      else grade = 4;
    }

    btn.textContent = grade != null ? `PSA ~${grade}` : 'No grade';
    if (grade >= 9) btn.classList.add('home-cand-grade-good');

    if (grade != null) {
      const breakdown = { centering: data.centering, corners: data.corners, edges: data.edges, surface: data.surface, verdict: data.verdict || '' };
      const gradeDeals = JSON.parse(localStorage.getItem('pkm-ai-grade-deals-v1') || '[]');
      const idx = gradeDeals.findIndex(d => d.listingUrl === listingUrl);
      const rec = { cardId, cardName, listingUrl, listingImg, priceGBP, aiGrade: grade, breakdown, ts: Date.now() };
      if (idx >= 0) gradeDeals[idx] = rec; else gradeDeals.unshift(rec);
      localStorage.setItem('pkm-ai-grade-deals-v1', JSON.stringify(gradeDeals.slice(0, 100)));

      const cands = JSON.parse(localStorage.getItem('pkm-grade-candidates-v1') || '[]');
      localStorage.setItem('pkm-grade-candidates-v1', JSON.stringify(cands.filter(c => c.listingUrl !== listingUrl)));

      _homeGradeCandHash = '';
      setTimeout(() => { try { _renderHomeAiGrades(); _renderHomeGradeCandidates(); _renderHomeAcePicks(); } catch {} }, 1500);
    }
  } catch (err) {
    console.error('[AI Grade]', err.message);
    btn.textContent = 'Failed';
    btn.title = err.message;
    btn.disabled = false;
  }
}

function _gradeCandRefresh() {
  const graded = new Set((JSON.parse(localStorage.getItem('pkm-ai-grade-deals-v1') || '[]')).map(r => r.listingUrl));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const pruned = (JSON.parse(localStorage.getItem('pkm-grade-candidates-v1') || '[]'))
    .filter(c => c.listingImg && !graded.has(c.listingUrl) && c.ts > cutoff);
  localStorage.setItem('pkm-grade-candidates-v1', JSON.stringify(pruned));
  _homeGradeCandHash = '';
  _renderHomeGradeCandidates();
}
function _homeItemHash(items, prefix) {
  const s = items.map(i => { const c = getCachedPrice(i.id); return i.id + ':' + Math.round((c?.market || c?.mid || 0) * 100); }).join('|');
  return (prefix != null ? String(prefix) : '') + '|' + s;
}

function _renderHomeCollection() {
  const list = $('homeCollList'), countEl = $('homeCollCount'), totalEl = $('homeCollTotal');
  if (!list) return;
  if (countEl) countEl.textContent = portfolio.length;
  if (portfolio.length === 0) {
    list.innerHTML = '<div class="home-empty">No cards in collection yet.<br>Search a card and tap + to add it.</div>';
    if (totalEl) totalEl.textContent = '';
    _homeCollHash = '';
    return;
  }
  const hash = _homeItemHash(portfolio, '');
  if (hash === _homeCollHash && list.querySelector('.home-card-tile')) return;
  _homeCollHash = hash;
  let totalGBP = 0;
  const tiles = portfolio.map(p => {
    const card = getCardById(p.id);
    const cached = getCachedPrice(p.id);
    const priceUSD = cached ? (cached.market || cached.mid || (card ? card.p : p.price)) : (card ? card.p : p.price);
    const priceGBP = usdToGbp(priceUSD);
    totalGBP += priceGBP;
    let signal = null;
    if (card) {
      let pull = 7.65;
      if (setsData?.[card.sc]) {
        const r = setsData[card.sc].rarities?.[card.rc];
        if (r?.pullRate > 0) pull = Math.round(1 / r.pullRate) * r.count / 100;
      }
      const sig = _getCachedSignal(card, pull, autoFillDesirability(card, pull).total);
      if (sig) signal = sig.signal;
    }
    const sc = signal === 'STRONG BUY' ? 'sig-strong-buy' : signal === 'BUY' ? 'sig-buy' : signal === 'SELL' ? 'sig-sell' : 'sig-hold';
    return _homeTile(p.id, p.img, p.name, fmtGBPDirect(priceGBP), signal ? sc : null, signal, '', p.set);
  });
  list.innerHTML = tiles.join('');
  if (totalEl) totalEl.textContent = `${fmtGBPDirect(totalGBP)} · ${portfolio.length} card${portfolio.length !== 1 ? 's' : ''}`;
  _setupTileEvents(list, id => {
    portfolio = portfolio.filter(p => p.id !== id);
    savePortfolio(); renderPortfolio(); updatePortfolioButton();
    _renderHomeCollection();
  });
}

// Find the best qualifying strategy for a card: must be low risk, strong hold
// (ROI >= 80%), and within budget. Cards with only medium/high-risk or weak
// strategies are excluded entirely — the home lists are signal, not noise.
// Returns { pick, displayGBP, stratLabel } or null.
function _bestInBudgetPick(card, maxBudget, fx) {
  if (!card || typeof computeHoldCore !== 'function') return null;
  const hc = _getHoldCoreCached(card);
  if (!hc.ok) return null;
  const candidates = (hc.strategies || []).filter(
    s => s.key !== 'gamble' && s.risk === 'low' && s.roi > 0 && s.today * fx <= maxBudget
  );
  const pick = candidates.length ? _pickBestLTP(candidates) : null;
  if (!pick) return null;
  const displayGBP = pick.today * fx;
  const stratLabel = pick.key === 'raw' ? 'Raw' : pick.key.startsWith('psa') ? pick.key.replace('psa', 'PSA ') : '';
  return { pick, displayGBP, stratLabel };
}

function _renderHomeWishlist() {
  const list = $('homeWishList'), countEl = $('homeWishCount');
  if (!list) { _renderHomeCombinedWishlist(); return; }
  if (wishlist.length === 0) {
    if (countEl) countEl.textContent = '0';
    list.innerHTML = '<div class="home-empty">No wishlisted cards yet.<br>Tap ♥ on any card to add it.</div>';
    _homeWishHash = '';
    return;
  }
  const maxBudget = getMaxBudgetGBP();
  const hash = _homeItemHash(wishlist, maxBudget);
  if (hash === _homeWishHash && list.querySelector('.home-card-tile')) return;
  _homeWishHash = hash;
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const tiles = wishlist.flatMap(w => {
    const card = getCardById(w.id);
    if (!card) return [];
    const hc = _getHoldCoreCached(card);
    const budgetPick = hc.ok ? _bestInBudgetPick(card, maxBudget, fx) : null;
    const filtered = hc.ok && !budgetPick; // has data but no qualifying strategy
    let displayGBP, stratLabel = '';
    if (budgetPick) {
      displayGBP = budgetPick.displayGBP;
      stratLabel = budgetPick.stratLabel;
    } else {
      const cached = getCachedPrice(w.id) || getLastKnownPrice(w.id);
      const usd = cached ? (cached.pcUngraded || cached.market || cached.mid || card.p) : card.p;
      displayGBP = usdToGbp(usd) || 0;
    }
    const target = w.targetGBP || 0;
    let alertClass = 'alert-far', alertLabel = 'Watching';
    if (target > 0) {
      if (displayGBP <= target) { alertClass = 'alert-buy'; alertLabel = 'BUY NOW'; }
      else if (displayGBP <= target * 1.10) { alertClass = 'alert-watch'; alertLabel = 'Close'; }
    }
    const subParts = [];
    if (target > 0) subParts.push(`Target: ${fmtGBPDirect(target)}`);
    else if (w.set) subParts.push(w.set);
    if (stratLabel) subParts.push(stratLabel);
    const urgentBuy = !!budgetPick && budgetPick.pick.roi >= 150;
    return [_homeTile(w.id, w.img, w.name, displayGBP > 0 ? fmtGBPDirect(displayGBP) : '—', alertClass, alertLabel, '', subParts.join(' · '), { hidden: filtered, urgentBuy })];
  });
  const visibleCount = tiles.filter(t => !t.includes('style="display:none"')).length;
  if (countEl) countEl.textContent = visibleCount;
  list.innerHTML = tiles.length
    ? tiles.join('')
    : '<div class="home-empty">No wishlist cards yet.<br>Tap ♥ on any card to add it.</div>';
  _setupTileEvents(list, id => {
    wishlist = wishlist.filter(w => w.id !== id);
    saveWishlist(); renderWishlist(); updateWishlistButton();
    _renderHomeWishlist();
  });
}

function _renderHomeWatchlist() {
  const list = $('homeWatchList'), countEl = $('homeWatchCount');
  if (!list) { _renderHomeCombinedWishlist(); return; }
  if (watchlist.length === 0) {
    if (countEl) countEl.textContent = '0';
    list.innerHTML = '<div class="home-empty">No cards being watched yet.<br>Tap "Watch" on any card to track it.</div>';
    _homeWatchHash = '';
    return;
  }
  const maxBudget = getMaxBudgetGBP();
  const hash = _homeItemHash(watchlist, maxBudget);
  if (hash === _homeWatchHash && list.querySelector('.home-card-tile')) return;
  _homeWatchHash = hash;
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const alerts = (typeof computeActiveAlerts === 'function') ? computeActiveAlerts() : [];
  const alertMap = Object.fromEntries(alerts.map(a => [a.id, a]));
  const tiles = watchlist.flatMap(w => {
    const card = getCardById(w.id);
    if (!card) return [];
    const hc = _getHoldCoreCached(card);
    const budgetPick = hc.ok ? _bestInBudgetPick(card, maxBudget, fx) : null;
    const filtered = hc.ok && !budgetPick; // has data but no qualifying strategy
    let displayGBP, stratLabel = '';
    if (budgetPick) {
      displayGBP = budgetPick.displayGBP;
      stratLabel = budgetPick.stratLabel;
    } else {
      const cached = getCachedPrice(w.id) || getLastKnownPrice(w.id);
      const usd = cached ? (cached.pcUngraded || cached.market || cached.mid || card.p) : card.p;
      displayGBP = usdToGbp(usd) || 0;
    }
    const a = alertMap[w.id];
    const signal = a ? a.signal : (w.addedSignal || '—');
    const triggered = a ? (a.triggered && a.dismissedFor !== a.signal) : false;
    const sc = signal === 'STRONG BUY' ? 'sig-strong-buy' : signal === 'BUY' ? 'sig-buy' : signal === 'SELL' ? 'sig-sell' : 'sig-hold';
    const subParts = [];
    if (w.set) subParts.push(w.set);
    if (stratLabel) subParts.push(stratLabel);
    const urgentBuy = !!budgetPick && budgetPick.pick.roi >= 150;
    return [_homeTile(w.id, w.img, w.name,
      displayGBP > 0 ? fmtGBPDirect(displayGBP) : '—',
      sc, signal,
      triggered ? 'alert-tile' : '',
      subParts.join(' · '), { hidden: filtered, urgentBuy })];
  });
  const visibleCount = tiles.filter(t => !t.includes('style="display:none"')).length;
  if (countEl) countEl.textContent = visibleCount;
  list.innerHTML = tiles.length
    ? tiles.join('')
    : '<div class="home-empty">No watched cards meet the criteria: low risk, strong hold, within budget.</div>';
  _setupTileEvents(list, id => {
    const idx = watchlist.findIndex(w => w.id === id);
    if (idx >= 0) { watchlist.splice(idx, 1); saveWatchlist(); }
    _renderHomeWatchlist();
  });
}

// ── Combined Wishlist (watchlist + wishlist merged for home dashboard) ──────
let _homeWishlistMergedHash = '';
function _renderHomeCombinedWishlist() {
  const list = $('homeWishlistMerged'), countEl = $('homeWishlistCount');
  if (!list) return;
  const maxBudget = getMaxBudgetGBP();
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const hash = _homeItemHash([...wishlist, ...watchlist], maxBudget);
  if (hash === _homeWishlistMergedHash && list.querySelector('.home-card-tile')) return;
  _homeWishlistMergedHash = hash;

  const alerts = (typeof computeActiveAlerts === 'function') ? computeActiveAlerts() : [];
  const alertMap = Object.fromEntries(alerts.map(a => [a.id, a]));
  const watchIds = new Set(watchlist.map(w => w.id));

  // Merge: watchlist first, then wishlist items not already in watchlist
  const merged = [
    ...watchlist,
    ...wishlist.filter(w => !watchIds.has(w.id)),
  ];

  if (merged.length === 0) {
    if (countEl) countEl.textContent = '0';
    list.innerHTML = '<div class="home-empty">No cards added yet.<br>Tap ♥ or Watch on any card.</div>';
    return;
  }

  const tiles = merged.flatMap(w => {
    const card = getCardById(w.id);
    if (!card) return [];
    const isWatch = watchIds.has(w.id);
    const hc = _getHoldCoreCached(card);
    const budgetPick = hc.ok ? _bestInBudgetPick(card, maxBudget, fx) : null;
    const filtered = hc.ok && !budgetPick;
    let displayGBP, stratLabel = '';
    if (budgetPick) {
      displayGBP = budgetPick.displayGBP;
      stratLabel = budgetPick.stratLabel;
    } else {
      const cached = getCachedPrice(w.id) || getLastKnownPrice(w.id);
      const usd = cached ? (cached.pcUngraded || cached.market || cached.mid || card.p) : card.p;
      displayGBP = usdToGbp(usd) || 0;
    }
    let alertClass, alertLabel;
    if (isWatch) {
      const a = alertMap[w.id];
      const signal = a ? a.signal : (w.addedSignal || '—');
      alertClass = signal === 'STRONG BUY' ? 'sig-strong-buy' : signal === 'BUY' ? 'sig-buy' : signal === 'SELL' ? 'sig-sell' : 'sig-hold';
      alertLabel = signal;
    } else {
      const target = w.targetGBP || 0;
      if (target > 0 && displayGBP <= target) { alertClass = 'alert-buy'; alertLabel = 'BUY NOW'; }
      else if (target > 0 && displayGBP <= target * 1.10) { alertClass = 'alert-watch'; alertLabel = 'Close'; }
      else { alertClass = 'alert-far'; alertLabel = 'Watching'; }
    }
    const subParts = [];
    if (!isWatch && w.targetGBP > 0) subParts.push(`Target: ${fmtGBPDirect(w.targetGBP)}`);
    else if (w.set) subParts.push(w.set);
    if (stratLabel) subParts.push(stratLabel);
    const urgentBuy = !!budgetPick && budgetPick.pick.roi >= 150;
    return [_homeTile(w.id, w.img, w.name, displayGBP > 0 ? fmtGBPDirect(displayGBP) : '—', alertClass, alertLabel, '', subParts.join(' · '), { hidden: filtered, urgentBuy })];
  });

  const visible = tiles.filter(t => !t.includes('style="display:none"')).length;
  if (countEl) countEl.textContent = visible;
  list.innerHTML = tiles.length ? tiles.join('') : '<div class="home-empty">No cards to show within your budget.</div>';

  _setupTileEvents(list, id => {
    const inWish = wishlist.findIndex(w => w.id === id);
    if (inWish >= 0) { wishlist.splice(inWish, 1); saveWishlist(); renderWishlist(); updateWishlistButton(); }
    const inWatch = watchlist.findIndex(w => w.id === id);
    if (inWatch >= 0) { watchlist.splice(inWatch, 1); saveWatchlist(); }
    _homeWishlistMergedHash = '';
    _renderHomeCombinedWishlist();
  });
}

// ── Consider Grading: PSA vs ACE ROI for wishlist / watchlist cards ─────────
// ---- Shared grading-analysis helpers (used by Consider Grading + Reco Consider Grading) ----

function _buildGradeItems(sourceItems) {
  const acePricesAll = (() => { try { return JSON.parse(localStorage.getItem('pkm-ace-prices-v1') || '{}'); } catch { return {}; } })();
  return sourceItems.flatMap(item => {
    const card = getCardById(item.id);
    if (!card) return [];
    const priceData = getCachedPrice(item.id) || getLastKnownPrice(item.id);
    const rawUSD = priceData ? (priceData.pcUngraded || priceData.market || priceData.mid || card.p) : card.p;
    const rawGBP = usdToGbp(rawUSD || 0);
    if (rawGBP < 8) return [];
    const p10USD = priceData?.pcPsa10 || card.p10 || 0;
    if (!p10USD || p10USD <= 0) return [];
    const p10GBP = usdToGbp(p10USD);
    if (p10GBP <= rawGBP) return [];

    const psaFeeGBP  = getUkGradingFeeGBP(p10USD);
    const psaProfit  = p10GBP - rawGBP - psaFeeGBP;
    const psaROI     = (psaProfit / (rawGBP + psaFeeGBP)) * 100;
    const aceTier    = recommendAceTier(rawGBP);
    const aceFeeBase = getAceFeeGBP(aceTier) + ACE_FEE_LABEL_GBP + ACE_FEE_SHIPPING_GBP;
    const aceData    = acePricesAll[item.id] || {};
    const ace10GBP   = aceData['10'] ? usdToGbp(aceData['10']) : p10GBP * 0.75;
    const aceProfit  = ace10GBP - rawGBP - aceFeeBase;
    const aceROI     = (aceProfit / (rawGBP + aceFeeBase)) * 100;
    const p9USD      = (priceData?.pcPsa9 && priceData.pcPsa9 > 0) ? priceData.pcPsa9 : estimateGradePrice(card, 9, p10USD);
    const psa9GBP    = usdToGbp(p9USD);
    const psa9Profit = psa9GBP - rawGBP - psaFeeGBP;
    const psa9ROI    = (psa9Profit / (rawGBP + psaFeeGBP)) * 100;
    const ace9GBP    = aceData['9'] ? usdToGbp(aceData['9']) : psa9GBP * 0.75;
    const ace9Profit = ace9GBP - rawGBP - aceFeeBase;
    const ace9ROI    = (ace9Profit / (rawGBP + aceFeeBase)) * 100;
    const name = item.name || card.n || '';
    const img  = item.img  || getCardImg(card) || '';
    return [{ card, item, name, img, rawGBP, p10GBP, psaFeeGBP, psaProfit, psaROI,
              ace10GBP, aceFeeBase, aceProfit, aceROI, psa9GBP, psa9Profit, psa9ROI,
              ace9GBP, ace9Profit, ace9ROI }];
  }).sort((a, b) => Math.max(b.psaROI, b.aceROI) - Math.max(a.psaROI, a.aceROI));
}

function _renderGradeItemHTML({ card, name, img, rawGBP, p10GBP, psaFeeGBP, psaProfit, psaROI,
    ace10GBP, aceFeeBase, aceProfit, aceROI, psa9GBP, psa9Profit, psa9ROI, ace9GBP, ace9Profit, ace9ROI }) {
    const bestROI   = Math.max(psaROI, aceROI);
    const psaBetter = psaROI >= aceROI;
    const margin    = Math.abs(psaROI - aceROI);
    const feeDelta  = psaFeeGBP - aceFeeBase;
    const winnerCls = psaBetter ? 'groi-winner-psa' : 'groi-winner-ace';

    let verdictText, verdictCls;
    if (margin < 5) {
      verdictText = `Similar ROI · ACE saves £${feeDelta.toFixed(0)} in fees`; verdictCls = 'groi-verdict-ace';
    } else if (psaBetter) {
      verdictText = `PSA ${margin.toFixed(0)}pp better ROI · ACE saves £${feeDelta.toFixed(0)} in fees`; verdictCls = 'groi-verdict-psa';
    } else {
      verdictText = `ACE ${margin.toFixed(0)}pp better ROI · saves £${feeDelta.toFixed(0)} vs PSA`; verdictCls = 'groi-verdict-ace';
    }

    const aceIsPracticalWinner = !psaBetter || margin < 15;
    // Grade-9 downside: if a 9 comes back worth less than the raw card plus
    // fees, grading only pays at a 10 — keeping raw preserves more value.
    const best9Profit = Math.max(psa9Profit, ace9Profit);
    const nineNote = p => p >= 0
      ? ` Even a 9 clears +£${p.toFixed(0)}.`
      : ` A 9 loses £${(-p).toFixed(0)} — only send if gem-confident.`;
    let worthIt, worthCls;
    if (bestROI < 0) {
      worthIt = 'Not worth grading at current raw price — hold raw.'; worthCls = 'groi-worth-no';
    } else if (best9Profit < 0) {
      // A 9 from either service is worth less than keeping the card raw.
      if (bestROI >= 100) {
        const svc  = psaBetter ? 'a PSA' : 'an ACE';
        const loss = -(psaBetter ? psa9Profit : ace9Profit);
        worthIt = `Gem-or-bust — a 10 pays well but ${svc} 9 loses £${loss.toFixed(0)}. Keep raw unless the card is flawless.`;
        worthCls = 'groi-worth-maybe';
      } else {
        worthIt = `Keep raw — a 9 loses £${(-psa9Profit).toFixed(0)} (PSA) / £${(-ace9Profit).toFixed(0)} (ACE), so raw holds more value unless it's a certain 10.`;
        worthCls = 'groi-worth-no';
      }
    } else if (psaBetter && margin >= 15) {
      worthIt = `PSA is the call — ${margin.toFixed(0)}pp ROI advantage outweighs the £${feeDelta.toFixed(0)} ACE fee saving.${nineNote(psa9Profit)}`;
      worthCls = bestROI >= 30 ? 'groi-worth-yes' : 'groi-worth-maybe';
    } else if (aceIsPracticalWinner && aceROI >= 25) {
      worthIt = `ACE is the play — saves £${feeDelta.toFixed(0)} in fees, solid return, faster turnaround.${nineNote(ace9Profit)}`; worthCls = 'groi-worth-yes';
    } else if (aceIsPracticalWinner && aceROI >= 0) {
      worthIt = `ACE makes more sense — £${feeDelta.toFixed(0)} fee saving reduces downside vs PSA.${nineNote(ace9Profit)}`; worthCls = 'groi-worth-maybe';
    } else {
      worthIt = `Borderline — only grade if confident on condition; ACE's lower fees limit the downside.`; worthCls = 'groi-worth-maybe';
    }

    const fmt = (profit, cost) => {
      const roi = (profit / cost) * 100;
      const cls = roi >= 40 ? 'groi-good' : roi >= 0 ? 'groi-ok' : 'groi-bad';
      return `<span class="${cls}">${profit >= 0 ? '+' : ''}£${profit.toFixed(0)} (${roi.toFixed(0)}%)</span>`;
    };
    const imgEl = img ? `<img class="home-card-art" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.opacity='0'">` : '<div class="home-card-art"></div>';
    return `<div class="home-grading-item" data-id="${esc(card.i)}">
      ${imgEl}
      <div class="home-grading-info">
        <div class="home-card-name">${esc(name)}</div>
        <div class="home-grading-raw">Raw £${rawGBP.toFixed(2)} · PSA 10 £${p10GBP.toFixed(2)} · PSA 9 £${psa9GBP.toFixed(2)}</div>
        <div class="home-grading-compare-grid">
          <div class="groi-svc-row">
            <span class="groi-svc-label ${psaBetter && margin >= 5 ? winnerCls : ''}">PSA</span>
            <span class="groi-grade-pair">
              <span class="groi-grade-col"><span class="groi-grade-num">10</span>${fmt(psaProfit, rawGBP + psaFeeGBP)}</span>
              <span class="groi-grade-col"><span class="groi-grade-num">9</span>${fmt(psa9Profit, rawGBP + psaFeeGBP)}</span>
            </span>
            <span class="groi-fee">£${psaFeeGBP} fee</span>
          </div>
          <div class="groi-svc-row">
            <span class="groi-svc-label ${!psaBetter && margin >= 5 ? winnerCls : ''}">ACE</span>
            <span class="groi-grade-pair">
              <span class="groi-grade-col"><span class="groi-grade-num">10</span>${fmt(aceProfit, rawGBP + aceFeeBase)}</span>
              <span class="groi-grade-col"><span class="groi-grade-num">9</span>${fmt(ace9Profit, rawGBP + aceFeeBase)}</span>
            </span>
            <span class="groi-fee">£${aceFeeBase.toFixed(0)} fee</span>
          </div>
        </div>
        <div class="home-grading-verdict ${verdictCls}">${verdictText}</div>
        <div class="home-grading-worthit ${worthCls}">${worthIt}</div>
      </div>
    </div>`;
}

// ---- Grade modal + inline list helpers ----

const GRADE_LIST_LIMIT = 5;
const _gradeAllItems = { collection: [], wishlist: [], reco: [] };
let _gradeModalItems = [];
let _gradeModalSort  = 'roi-desc';

function _sortGradeItems(items, sort) {
  const s = [...items];
  if      (sort === 'roi-asc')    s.sort((a, b) => Math.max(a.psaROI, a.aceROI) - Math.max(b.psaROI, b.aceROI));
  else if (sort === 'price-desc') s.sort((a, b) => b.rawGBP - a.rawGBP);
  else if (sort === 'price-asc')  s.sort((a, b) => a.rawGBP - b.rawGBP);
  else                            s.sort((a, b) => Math.max(b.psaROI, b.aceROI) - Math.max(a.psaROI, a.aceROI));
  return s;
}

function _gradeModalRender() {
  const list = $('gradeModalList');
  if (!list) return;
  list.innerHTML = _sortGradeItems(_gradeModalItems, _gradeModalSort).map(_renderGradeItemHTML).join('');
}

function _openGradeModal(title, items) {
  _gradeModalItems = items;
  _gradeModalSort  = 'roi-desc';
  const modal = $('gradeModal');
  if (!modal) return;
  $('gradeModalTitle').textContent = title;
  modal.querySelectorAll('.gm-sort-btn').forEach(b =>
    b.classList.toggle('gm-sort-active', b.dataset.gmsort === 'roi-desc'));
  _gradeModalRender();
  modal.style.display = '';
  document.body.style.overflow = 'hidden';
}

function _closeGradeModal() {
  const modal = $('gradeModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

function _setupGradeModal() {
  const modal = $('gradeModal');
  if (!modal || modal._gradeModalSetup) return;
  modal._gradeModalSetup = true;
  modal.addEventListener('click', e => { if (e.target === modal) _closeGradeModal(); });
  $('gradeModalClose')?.addEventListener('click', _closeGradeModal);
  modal.querySelector('.grade-modal-sort-bar')?.addEventListener('click', e => {
    const btn = e.target.closest('.gm-sort-btn');
    if (!btn) return;
    _gradeModalSort = btn.dataset.gmsort;
    modal.querySelectorAll('.gm-sort-btn').forEach(b => b.classList.toggle('gm-sort-active', b === btn));
    _gradeModalRender();
  });
  $('gradeModalList')?.addEventListener('click', e => {
    const row = e.target.closest('.home-grading-item[data-id]');
    if (row) { _closeGradeModal(); go('predict'); setTimeout(() => { try { selectCard(row.dataset.id); } catch {} }, 80); }
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-grade-viewall]');
    if (!btn) return;
    _openGradeModal(btn.dataset.gradeTitle || 'Consider Grading', _gradeAllItems[btn.dataset.gradeViewall] || []);
  });
}

function _renderGradeListInline(container, items, src, title, emptyMsg) {
  _gradeAllItems[src] = items;
  if (!items.length) { container.innerHTML = `<div class="home-empty">${emptyMsg}</div>`; return; }
  const shown = items.slice(0, GRADE_LIST_LIMIT);
  const more  = items.length - GRADE_LIST_LIMIT;
  container.innerHTML = shown.map(_renderGradeItemHTML).join('') +
    (more > 0 ? `<button class="grade-view-more-btn" data-grade-viewall="${esc(src)}" data-grade-title="${esc(title)}">View all ${items.length}</button>` : '');
  if (!container._gradingClickAdded) {
    container._gradingClickAdded = true;
    container.addEventListener('click', e => {
      const row = e.target.closest('.home-grading-item[data-id]');
      if (row) { go('predict'); setTimeout(() => { try { selectCard(row.dataset.id); } catch {} }, 80); }
    });
  }
}

let _homeGradingHash = '';
function _renderHomeConsiderGrading() {
  const collList      = $('homeGradingListCollection');
  const wishList      = $('homeGradingListWishlist');
  const collCountEl   = $('homeCollGradingCount');
  const wishCountEl   = $('homeGradingCount');
  if (!collList || !wishList) return;

  const collItems = _buildGradeItems(portfolio);
  const wishItems = _buildGradeItems(wishlist);

  const hash = portfolio.map(p => p.id).join('|') + '~' + wishlist.map(w => w.id).join('|');
  if (hash === _homeGradingHash && collList.querySelector('.home-grading-item')) return;
  _homeGradingHash = hash;

  _renderGradeListInline(collList, collItems, 'collection', 'Collection — Consider Grading',
    'No collection cards with PSA 10 data yet.<br>Add cards to your collection and sync prices.');
  _renderGradeListInline(wishList, wishItems, 'wishlist', 'Wishlist — Consider Grading',
    'No wishlist cards with PSA 10 data yet.<br>Add cards to your wishlist and sync prices.');

  if (collCountEl) collCountEl.textContent = collItems.length;
  if (wishCountEl) wishCountEl.textContent = wishItems.length;

  _setupGradeModal();
}

function _renderRecoConsiderGrading(recoItems) {
  const list    = $('homeRecoGradingList');
  const countEl = $('homeRecoGradingCount');
  if (!list) return;

  const normalized = (recoItems || []).map(r => ({ id: r.card.i, name: r.card.n, img: getCardImg(r.card) }));
  const items = _buildGradeItems(normalized);
  if (countEl) countEl.textContent = items.length;

  _renderGradeListInline(list, items, 'reco', 'Recommended — Consider Grading',
    'No recommended cards with grading ROI data yet — sync prices to populate.');

  _setupGradeModal();
}

function setupPageNav() {
  // --- Relocate existing sections into their target pages -----------
  const discoverMount = document.getElementById('discoverMount');
  const toolsMount = document.getElementById('toolsMount');
  if (discoverMount) {
    // Order: existing Top 10 Value Picks, then Top 50 by Grade.
    const vp = document.getElementById('valuePicksSection');
    const t50 = document.getElementById('top50Section');
    if (vp) discoverMount.appendChild(vp);
    if (t50) discoverMount.appendChild(t50);
  }
  if (toolsMount) {
    const ps = document.getElementById('priceSyncSection');
    const how = document.querySelector('.inputs-column .how-card') || document.querySelector('details.how-card');
    if (ps) toolsMount.appendChild(ps);
    if (how) toolsMount.appendChild(how);
  }

  // --- Wire the tab buttons + hash routing --------------------------
  const buttons = Array.from(document.querySelectorAll('.page-nav-btn[data-page]'));
  const pages = {
    home: document.getElementById('pageHome'),
    predict: document.getElementById('pagePredict'),
    discover: document.getElementById('pageDiscover'),
    tools: document.getElementById('pageTools'),
    binder: document.getElementById('pageBinder'),
    budget: document.getElementById('pageBudget'),
    vintage: document.getElementById('pageVintage'),
  };

  function go(page) {
    if (!pages[page]) page = 'home';
    closeHomePip();
    Object.entries(pages).forEach(([k, el]) => {
      if (!el) return;
      if (k === page) {
        el.style.display = '';
        el.classList.remove('pkm-page-in');
        void el.offsetWidth; // force reflow so animation restarts
        el.classList.add('pkm-page-in');
      } else {
        el.style.display = 'none';
        el.classList.remove('pkm-page-in');
      }
    });
    buttons.forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const fab = document.getElementById('filterFab');
    if (fab) fab.style.display = (page === 'predict') ? '' : 'none';
    document.getElementById('pageNav')?.classList.toggle('has-ctx', page === 'predict');
    if (page === 'discover' && !window._urRanOnce) {
      window._urRanOnce = true;
      setTimeout(() => { try { urRunScan(); } catch (e) {} }, 100);
    }
    if (page === 'home') { renderHomeDashboard(); _homeAutoRefresh(); _syncOnHomeNav(); }
    if (page === 'binder') { try { renderBinderPage(); } catch(e) {} _binderAutoRefresh(); }
    if (page === 'tools') { try { updateToolsDupeBadge(); } catch(e) {} }
    if (page === 'budget') { try { renderBudgetPage(); } catch(e) {} }
    if (page === 'vintage') { try { renderVintagePage(); } catch(e) {} }
    // URL + title: cards get their own address (#cardId); other pages reset to page hash
    if (page === 'predict' && selectedCard) {
      try { history.replaceState({ cardId: selectedCard.i }, '', '#' + selectedCard.i); } catch(e) {}
    } else {
      if (page !== 'predict') document.title = 'Pokémon Price Predictor';
      try { if (location.hash.replace('#', '') !== page) history.replaceState(null, '', '#' + page); } catch(e) {}
    }
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }
  window.go = go;

  // Wire "View all" / "Refresh" buttons on the home page
  document.getElementById('homeOpenCollection')?.addEventListener('click', () => openHomeViewAll('My Collection', _buildCollectionItems()));
  document.getElementById('homeOpenWishlist')?.addEventListener('click', () => openHomeViewAll('Wishlist', _buildWishlistItems()));
  document.getElementById('homeOpenWatchlist')?.addEventListener('click', () => openHomeViewAll('Watchlist', _buildWatchlistItems()));
  setupHomeViewAll();
  setupHomeScrollControls();
  document.getElementById('homeRecoRefresh')?.addEventListener('click', () => _renderHomeReco(true));
  document.getElementById('homeRefreshAll')?.addEventListener('click', () => {
    const btn = document.getElementById('homeRefreshAll');
    if (btn) { btn.classList.add('spinning'); setTimeout(() => btn.classList.remove('spinning'), 600); }
    _renderHomeCollection();
    _renderHomeWishlist();
    _renderHomeWatchlist();
    _renderHomeReco(true);
  });

  // Budget slider + manual input
  (() => {
    const slider  = document.getElementById('homeBudgetSlider');
    const inputEl = document.getElementById('homeBudgetInput');
    const goBtn   = document.getElementById('homeBudgetGo');
    if (!slider || !inputEl || !goBtn) return;

    function applyBudget(gbp, rebuild) {
      const noLimit = !isFinite(gbp) || gbp >= BUDGET_DEFAULT;
      slider.value  = noLimit ? 5000 : Math.min(Math.max(Math.round(gbp), 100), 5000);
      inputEl.value = noLimit ? '' : Math.round(gbp);
      localStorage.setItem(BUDGET_KEY, noLimit ? String(BUDGET_DEFAULT) : String(Math.round(gbp)));
      if (rebuild) {
        _renderHomeReco(true);
        _renderHomeWishlist();
        _renderHomeWatchlist();
      }
    }

    // Expose for post-sync UI refresh (reads from localStorage, updates slider+input only)
    window._applyBudgetUI = () => {
      const gbp = getMaxBudgetGBP();
      applyBudget(gbp, true);
    };

    // One-time migration from old unprefixed key
    const oldRaw = localStorage.getItem('budget-max-gbp');
    if (oldRaw !== null && localStorage.getItem(BUDGET_KEY) === null) {
      localStorage.setItem(BUDGET_KEY, oldRaw);
      localStorage.removeItem('budget-max-gbp');
    }

    const saved = parseFloat(localStorage.getItem(BUDGET_KEY));
    applyBudget(isFinite(saved) && saved > 0 ? saved : BUDGET_DEFAULT, false);

    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10);
      applyBudget(v >= 5000 ? BUDGET_DEFAULT : v, true);
    });

    const commitInput = () => {
      const raw = parseFloat(inputEl.value);
      applyBudget(!isFinite(raw) || raw <= 0 ? BUDGET_DEFAULT : raw, true);
    };

    goBtn.addEventListener('click', commitInput);
    inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') commitInput(); });
  })();

  // Currency selector
  (() => {
    const sel = document.getElementById('currencySelector');
    if (!sel) return;
    sel.value = _displayCurrency;
    sel.addEventListener('change', () => {
      _displayCurrency = sel.value;
      localStorage.setItem(DISP_CURRENCY_KEY, _displayCurrency);
      _renderHomeCollection();
      _renderHomeWishlist();
      _renderHomeWatchlist();
      _renderHomeReco(true);
      if (_lastLiveData) renderLivePrice(_lastLiveData);
      if (selectedCard) updateAll();
    });
  })();

  document.getElementById('signalJumpHold')?.addEventListener('click', () => {
    $('holdStrategySection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  buttons.forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
  window.addEventListener('hashchange', () => go((location.hash || '#home').replace('#', '')));
  document.getElementById('navAskCtx')?.addEventListener('click', aiOpenPanel);
  document.getElementById('navFilterCtx')?.addEventListener('click', openScreener);

  // Initial route — default to Home.
  // Supports two deep-link formats:
  //   ?card=<id>  — generated by the ↗ tile links (new tab, current tab unaffected)
  //   #<cardId>   — set by selectCard() / pwaPushCard, works as a bookmark
  const _deepCard = new URLSearchParams(location.search).get('card');
  const initial = (location.hash || '#home').replace('#', '');
  const isKnownPage = ['home', 'predict', 'discover', 'tools', 'binder', 'budget', 'vintage'].includes(initial);
  const _hashCard = !isKnownPage && initial ? initial : null;
  const cardToOpen = _deepCard || _hashCard;
  if (cardToOpen) {
    go('predict');
    setTimeout(() => { try { selectCard(cardToOpen); } catch(e) {} }, 300);
  } else {
    go(isKnownPage ? initial : 'home');
  }

  // ── Liquid glass tab bar: specular + sliding pill ──────────────
  const nav = document.getElementById('pageNav');
  const pill = document.getElementById('navPill');

  function _positionPill(activeBtn) {
    if (!pill || !nav || !activeBtn) return;
    const navRect = nav.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    pill.style.left = (btnRect.left - navRect.left) + 'px';
    pill.style.width = btnRect.width + 'px';
  }

  // Move pill after every page switch — wire onto button clicks after the fact
  buttons.forEach(b => {
    b.addEventListener('click', () => requestAnimationFrame(() => _positionPill(nav?.querySelector('.page-nav-btn.active'))));
  });

  // Initial pill position — defer until layout is settled
  function _initPill() {
    const activeBtn = nav?.querySelector('.page-nav-btn.active');
    if (!pill || !activeBtn) return;
    pill.style.transition = 'none';
    _positionPill(activeBtn);
    requestAnimationFrame(() => { if (pill) pill.style.transition = ''; });
  }
  requestAnimationFrame(() => requestAnimationFrame(_initPill));

  // Specular light follows pointer / touch along the bar
  const hoverBubble = document.getElementById('navHoverBubble');
  function _showHoverBubble(btn) {
    if (!hoverBubble || !nav || !btn) return;
    const navRect = nav.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    hoverBubble.style.left  = (btnRect.left - navRect.left) + 'px';
    hoverBubble.style.width = btnRect.width + 'px';
    hoverBubble.style.opacity = '1';
    hoverBubble.style.transform = 'scale(1)';
  }
  function _hideHoverBubble() {
    if (!hoverBubble) return;
    hoverBubble.style.opacity = '0';
    hoverBubble.style.transform = 'scale(0.88)';
  }
  if (nav) {
    buttons.forEach(b => {
      b.addEventListener('mouseenter', () => _showHoverBubble(b));
      b.addEventListener('mouseleave', _hideHoverBubble);
    });
    let _navRect = null;
    window.addEventListener('resize', () => { _navRect = null; }, { passive: true });
    nav.addEventListener('pointermove', e => {
      if (!_navRect) _navRect = nav.getBoundingClientRect();
      nav.style.setProperty('--nav-mx', (e.clientX - _navRect.left) + 'px');
      nav.style.setProperty('--nav-glow', '1');
    }, { passive: true });
    nav.addEventListener('pointerleave', () => {
      nav.style.setProperty('--nav-glow', '0');
      _hideHoverBubble();
    });
    nav.addEventListener('touchmove', e => {
      if (!_navRect) _navRect = nav.getBoundingClientRect();
      nav.style.setProperty('--nav-mx', (e.touches[0].clientX - _navRect.left) + 'px');
      nav.style.setProperty('--nav-glow', '1');
    }, { passive: true });
    nav.addEventListener('touchend', () => {
      nav.style.setProperty('--nav-glow', '0');
    }, { passive: true });
  }

  // Shrink nav to icon-only when scrolling down, expand on scroll-up
  let _prevNavScrollY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (nav) nav.classList.toggle('shrunk', y > _prevNavScrollY && y > 80);
    _prevNavScrollY = y;
  }, { passive: true });

  setupToolsTabs();
}

// =============================================================
// Tools page — inner tab bar (Price Sync / Duplicates)
// =============================================================
function setupToolsTabs() {
  const bar = document.querySelector('.tools-inner-tab-bar');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const btn = e.target.closest('[data-toolstab]');
    if (!btn) return;
    const tab = btn.dataset.toolstab;
    bar.querySelectorAll('[data-toolstab]').forEach(b => {
      b.classList.toggle('ptab-active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    const syncPanel  = document.getElementById('toolsSyncPanel');
    const dupesPanel = document.getElementById('toolsDupesPanel');
    if (syncPanel)  syncPanel.style.display  = tab === 'sync'  ? '' : 'none';
    if (dupesPanel) dupesPanel.style.display = tab === 'dupes' ? '' : 'none';
    if (tab === 'dupes') renderToolsDuplicates();
  });
}

// =============================================================
// Tools page — Duplicate / counterpart detection
// =============================================================
function _getDupeDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DUPE_DISMISS_KEY) || '[]')); } catch { return new Set(); }
}
function _saveDupeDismissed(set) {
  try { localStorage.setItem(DUPE_DISMISS_KEY, JSON.stringify([...set])); } catch {}
}

function _detectDupes() {
  const dismissed = _getDupeDismissed();
  const results = { exact: [], counterparts: [], nameDupes: [] };

  // 1. Exact ID duplicates (same card added twice)
  const idFirst = new Map();
  portfolio.forEach((p, i) => {
    if (idFirst.has(p.id)) {
      const key = `exact:${p.id}`;
      if (!dismissed.has(key)) results.exact.push({ a: portfolio[idFirst.get(p.id)], b: p, key });
    } else {
      idFirst.set(p.id, i);
    }
  });

  // 2. EN/JP counterpart pairs both in collection
  const portfolioIds = new Set(portfolio.map(p => p.id));
  const seenCpKeys   = new Set();
  for (const p of portfolio) {
    const card = getCardById(p.id);
    if (!card || card.lang !== 'EN') continue;
    const cpKey = counterpartByCard.get(p.id);
    if (!cpKey) continue;
    const bucket = counterpartIndex.get(cpKey);
    if (!bucket) continue;
    for (const jpCard of bucket.jp) {
      if (!portfolioIds.has(jpCard.i)) continue;
      const pairKey = [p.id, jpCard.i].sort().join(':');
      if (seenCpKeys.has(pairKey)) continue;
      seenCpKeys.add(pairKey);
      const key = `cp:${pairKey}`;
      if (dismissed.has(key)) continue;
      const jpItem = portfolio.find(x => x.id === jpCard.i);
      const enRawGBP = usdToGbp(getCurrentPrice(card));
      const jpRawGBP = usdToGbp(getCurrentPrice(jpCard));
      results.counterparts.push({ enItem: p, enCard: card, jpItem, jpCard, enRawGBP, jpRawGBP, key });
    }
  }

  // 3. Same card name in collection with different IDs (possible wrong duplicates)
  const nameGroups = new Map();
  for (const p of portfolio) {
    const card = getCardById(p.id);
    if (!card) continue;
    const norm = card.n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const arr = nameGroups.get(norm) || [];
    arr.push({ p, card });
    nameGroups.set(norm, arr);
  }
  for (const [, group] of nameGroups) {
    if (group.length < 2) continue;
    const ids = group.map(g => g.card.i).sort();
    // Skip pairs already covered by the EN/JP counterpart section
    const alreadyCovered = results.counterparts.some(cp => ids.includes(cp.enCard.i) && ids.includes(cp.jpCard.i));
    if (alreadyCovered) continue;
    const key = `name:${ids.join(':')}`;
    if (dismissed.has(key)) continue;
    results.nameDupes.push({ group, key });
  }

  return results;
}

function updateToolsDupeBadge() {
  const badge = document.getElementById('toolsDupeBadge');
  if (!badge) return;
  const d = _detectDupes();
  const count = d.exact.length + d.counterparts.length + d.nameDupes.length;
  badge.textContent = count;
  badge.style.display = count > 0 ? '' : 'none';
}

function renderToolsDuplicates() {
  const el = document.getElementById('toolsDupesMount');
  if (!el) return;
  const dupes = _detectDupes();
  const total = dupes.exact.length + dupes.counterparts.length + dupes.nameDupes.length;

  function cardThumb(item, card) {
    const img   = (item?.img || '') ? `<img class="dupe-thumb" src="${esc(item.img)}" alt="" onerror="this.style.opacity='0'">` : '<div class="dupe-thumb"></div>';
    const lang  = card?.lang === 'JP' ? '<span class="dupe-lang jp">JP</span>' : '<span class="dupe-lang en">EN</span>';
    const name  = esc(card?.n || item?.name || '');
    const set   = esc(card?.s || item?.set || '');
    const price = card ? `£${usdToGbp(getCurrentPrice(card)).toFixed(2)}` : '';
    return `<div class="dupe-card-thumb">${img}<div class="dupe-card-meta">${lang}<span class="dupe-card-name">${name}</span><span class="dupe-card-set">${set}</span>${price ? `<span class="dupe-card-price">${price}</span>` : ''}</div></div>`;
  }

  function actionBar(key, extra = '') {
    return `<div class="dupe-actions">${extra}<button class="dupe-btn dupe-dismiss" data-dupe-key="${esc(key)}">Dismiss</button></div>`;
  }

  if (total === 0) {
    el.innerHTML = '<div class="dupe-empty"><p>No duplicates or unconfirmed counterpart pairs found in your collection.</p></div>';
    return;
  }

  let html = '';

  // --- Exact duplicates ---
  if (dupes.exact.length > 0) {
    html += `<div class="dupe-section-hd">Exact duplicates · ${dupes.exact.length}</div>`;
    for (const { a, b, key } of dupes.exact) {
      const cardA = getCardById(a.id);
      html += `<div class="dupe-row" data-dupe-key="${esc(key)}">
        <div class="dupe-cards">
          ${cardThumb(a, cardA)}
          <span class="dupe-vs">×2</span>
          ${cardThumb(b, cardA)}
        </div>
        <div class="dupe-detail">Same card added twice — added ${a.addedDate ? new Date(a.addedDate).toLocaleDateString('en-GB') : 'unknown'} and ${b.addedDate ? new Date(b.addedDate).toLocaleDateString('en-GB') : 'unknown'}.</div>
        ${actionBar(key, `<button class="dupe-btn dupe-merge" data-dupe-key="${esc(key)}" data-keep-id="${esc(a.id)}" data-remove-id="${esc(b.id)}">Merge (keep older)</button>`)}
      </div>`;
    }
  }

  // --- EN/JP counterpart pairs ---
  if (dupes.counterparts.length > 0) {
    html += `<div class="dupe-section-hd">EN / JP pairs in collection · ${dupes.counterparts.length}</div>`;
    for (const { enItem, enCard, jpItem, jpCard, enRawGBP, jpRawGBP, key } of dupes.counterparts) {
      const diff = enRawGBP > 0 && jpRawGBP > 0
        ? (jpRawGBP < enRawGBP ? `JP is £${(enRawGBP - jpRawGBP).toFixed(2)} cheaper (${Math.round((enRawGBP - jpRawGBP) / enRawGBP * 100)}%)` : `EN is £${(jpRawGBP - enRawGBP).toFixed(2)} cheaper`)
        : '';
      html += `<div class="dupe-row" data-dupe-key="${esc(key)}">
        <div class="dupe-cards">
          ${cardThumb(enItem, enCard)}
          <span class="dupe-vs">vs</span>
          ${cardThumb(jpItem, jpCard)}
        </div>
        ${diff ? `<div class="dupe-detail">${diff}</div>` : ''}
        ${actionBar(key, `<button class="dupe-btn dupe-compare" data-en-id="${esc(enCard.i)}" data-jp-id="${esc(jpCard.i)}">Compare in Predict</button>`)}
      </div>`;
    }
  }

  // --- Name-based near-duplicates ---
  if (dupes.nameDupes.length > 0) {
    html += `<div class="dupe-section-hd">Same name, different cards · ${dupes.nameDupes.length}</div>`;
    for (const { group, key } of dupes.nameDupes) {
      const thumbs = group.map(({ p, card }) => cardThumb(p, card)).join('<span class="dupe-vs">·</span>');
      html += `<div class="dupe-row" data-dupe-key="${esc(key)}">
        <div class="dupe-cards">${thumbs}</div>
        <div class="dupe-detail">Multiple cards with the same name — may be intentional (different sets/variants).</div>
        ${actionBar(key)}
      </div>`;
    }
  }

  el.innerHTML = html;

  // Wire actions
  el.addEventListener('click', e => {
    const dismissBtn = e.target.closest('.dupe-dismiss');
    if (dismissBtn) {
      const key = dismissBtn.dataset.dupeKey;
      const dismissed = _getDupeDismissed();
      dismissed.add(key);
      _saveDupeDismissed(dismissed);
      dismissBtn.closest('.dupe-row')?.remove();
      updateToolsDupeBadge();
      if (!el.querySelector('.dupe-row')) el.innerHTML = '<div class="dupe-empty"><p>All clear.</p></div>';
      return;
    }
    const mergeBtn = e.target.closest('.dupe-merge');
    if (mergeBtn) {
      const removeId = mergeBtn.dataset.removeId;
      const keepId   = mergeBtn.dataset.keepId;
      const idx = portfolio.findIndex(p => p.id === removeId && portfolio.some(q => q.id === keepId && q !== p));
      if (idx >= 0) portfolio.splice(idx, 1);
      savePortfolio();
      renderPortfolio?.();
      const dismissed = _getDupeDismissed();
      dismissed.add(mergeBtn.dataset.dupeKey);
      _saveDupeDismissed(dismissed);
      mergeBtn.closest('.dupe-row')?.remove();
      updateToolsDupeBadge();
      if (!el.querySelector('.dupe-row')) el.innerHTML = '<div class="dupe-empty"><p>All clear.</p></div>';
      return;
    }
    const compareBtn = e.target.closest('.dupe-compare');
    if (compareBtn) {
      const enId = compareBtn.dataset.enId;
      go('predict');
      setTimeout(() => { try { selectCard(enId); } catch {} }, 80);
    }
  });
}

// =============================================================
// Underrated Engine — agentic ranker across Raw + PSA 1-10
// =============================================================
// Distinct from the existing Value Picks (which scores Raw only against the
// modelled fair value) and the Top 50 by Grade (which optimises 5yr ROI).
// The Underrated Engine answers a specific question:
//
//   "For a given format (Raw, or PSA grade X), which cards are most
//    underrated right now — i.e. trading well below where the fundamentals
//    say they should be, with momentum + setup supporting a re-rating?"
//
// Composite score per (card, format):
//   underratedScore = discountFactor       // how far below fair value
//                   * characterPremium     // popularity tailwind
//                   * setAgeFactor         // mature sets tighten supply
//                   * rarityFactor         // chase pull
//                   * roiFactor            // 5yr projected ROI (annualised)
//                   * liquidityFactor      // we have data confidence
//
// Grading cost (~£25 = $30) is subtracted from PSA entry prices so the
// "would I actually buy this graded?" maths is honest.

const UR_GRADING_COST_USD = 30;
const UR_PAGE_SIZE = 30;

let _urFmt = 'raw';
let _urLang = 'all';
let _urMaxGBP = 500;
let _urLastResults = [];

function setupUnderrated() {
  const fmtRow = document.getElementById('urFormatRow');
  if (fmtRow) {
    fmtRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.ur-fmt-btn');
      if (!btn) return;
      fmtRow.querySelectorAll('.ur-fmt-btn').forEach(b => b.classList.toggle('active', b === btn));
      _urFmt = btn.dataset.fmt;
      urRunScan();
    });
  }
  document.querySelectorAll('.ur-lang-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.ur-lang-btn').forEach(x => x.classList.toggle('active', x === b));
      _urLang = b.dataset.lang;
      urRunScan();
    });
  });
  const maxInput = document.getElementById('urMaxPrice');
  const maxVal = document.getElementById('urMaxPriceVal');
  if (maxInput) {
    maxInput.addEventListener('input', () => {
      _urMaxGBP = parseInt(maxInput.value, 10) || 500;
      if (maxVal) maxVal.textContent = '£' + _urMaxGBP.toLocaleString('en-GB');
    });
    maxInput.addEventListener('change', () => urRunScan());
  }
  const runBtn = document.getElementById('urRunBtn');
  if (runBtn) runBtn.addEventListener('click', () => urRunScan());
}

// USD→GBP for the max-price filter. We use the live fxRate when available.
function _urGbpFromUsd(usd) {
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  return usd * fx;
}

// Convert format key to grade number or 'raw' / 'low'.
function _urFmtToGrades(fmt) {
  if (fmt === 'raw') return null; // raw handled separately
  if (fmt === 'low') return [5, 4, 3, 2, 1]; // PSA 1-5 — pick best
  const g = parseInt(fmt, 10);
  return [g];
}

function urRunScan() {
  const list = document.getElementById('urList');
  const status = document.getElementById('urStatus');
  const summary = document.getElementById('urSummary');
  const runBtn = document.getElementById('urRunBtn');
  if (!list || !cardData || !cardData.cards) return;
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Scanning…'; }
  status.innerHTML = `Scanning <strong>${cardData.cards.length.toLocaleString()}</strong> cards for underrated ${_urFmt === 'raw' ? 'raw' : _urFmt === 'low' ? 'PSA 1-5' : 'PSA ' + _urFmt} opportunities…`;
  list.innerHTML = '';
  summary.style.display = 'none';

  // Defer one frame so the status repaints before we churn through 26k cards.
  requestAnimationFrame(() => {
    const results = (_urFmt === 'raw') ? urScanRaw() : urScanGrade(_urFmt);
    _urLastResults = results;
    urRender(results);
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg> Run scan`;
    }
  });
}

// --- RAW scanner --------------------------------------------------
//
// Fair value is computed by *calibrating* the desirability against the
// market price (same trick scanValuePicks uses), then nudging it up by a
// modest character premium. This avoids the trap of the auto-filled
// desirability returning "this Pikachu V is worth $500" when the market
// clearly says $3 (the model just hasn't learned about promo distribution).
//
// Discount is capped at 2.5× so we never claim 100× upside on Celebrations
// promos — those gaps are real-world supply quirks, not opportunities.
function urScanRaw() {
  const out = [];
  for (const c of cardData.cards) {
    if (_urLang !== 'all' && (c.lang || 'EN') !== _urLang) continue;
    const market = c.p;
    if (!market || market < 5) continue; // skip bulk
    if (_urGbpFromUsd(market) > _urMaxGBP) continue;

    let pullCost = 7.65;
    if (setsData && setsData[c.sc]) {
      const set = setsData[c.sc];
      const rarity = set.rarities?.[c.rc];
      if (rarity && rarity.pullRate > 0) {
        const packsPerHit = Math.round(1 / rarity.pullRate);
        pullCost = (packsPerHit * rarity.count) / 100;
      }
    }

    // --- Calibrated fair value (market-implied desirability + char boost) ---
    let impliedDes;
    try {
      const sf = Math.pow(PULL_MULT, pullCost);
      impliedDes = Math.log(market / (BASE * sf)) / Math.log(DES_MULT);
    } catch (e) { continue; }
    if (!isFinite(impliedDes) || impliedDes < 1) continue;

    const charMult = getCharacterMultiplier(c.n);
    const charBoost = Math.min(0.8, (charMult - 1) * 1.2);
    const modelDes = Math.min(10, impliedDes + charBoost);
    let fairUsd = 0;
    try { fairUsd = predictPrice(pullCost, modelDes).priceUSD || 0; } catch (e) { continue; }
    if (fairUsd <= market * 1.10) continue; // need at least 10% upside

    // Display discount capped at 2.5× to avoid "+1800%" stupidity. Score
    // uses log-discount so big underpricings count without saturating.
    const rawDiscount = fairUsd / market;
    const discount = Math.min(rawDiscount, 2.5);
    const logDiscount = Math.log(rawDiscount); // 0 at parity, grows slowly

    const rarityRate = (RARITY_RATES[c.rc] || RARITY_RATES['']).base;
    if (rarityRate < 0.03) continue; // standard commons rarely move

    const ageMonths = getSetAgeMonths(c.sc);
    const ageFactor = ageMonths > 48 ? 1.30 : ageMonths > 24 ? 1.12 : ageMonths < 6 ? 0.85 : 1.0;

    // 5yr projection — use PSA 9 trajectory deflated back to raw growth rate
    let yr5Usd = market;
    try {
      const proj = projectGradePrice(c, 9, market, 5) / (GRADE_GROWTH_PREMIUM[9] || 1.05);
      yr5Usd = isFinite(proj) ? proj : market;
    } catch (e) {}
    const roi5 = Math.max(0, (yr5Usd - market) / market);
    const roiFactor = 1 + Math.min(roi5, 2.5) * 0.6;

    // PSA 10 grading lever — if we have an anchor and grading yields a good
    // return, that's a strong underrated signal for the raw copy.
    let gradeLever = 1.0;
    let gradeRoi = 0;
    if (c.p10 && c.p10 > 0) {
      gradeRoi = (c.p10 - market - UR_GRADING_COST_USD) / (market + UR_GRADING_COST_USD);
      gradeLever = 1 + Math.max(0, Math.min(gradeRoi, 4)) * 0.4;
    }

    // Composite signal — log-discount keeps things in a sensible range.
    const score = (1 + logDiscount * 2.5)
                * Math.max(1, charMult)
                * ageFactor
                * (1 + rarityRate * 1.5)
                * roiFactor
                * gradeLever;

    const reasons = urReasonsRaw(c, { discount, charMult, ageMonths, rarityRate, roi5, gradeRoi });

    out.push({
      card: c,
      format: 'Raw',
      marketUsd: market,
      fairUsd: market * discount, // capped fair (display)
      effectiveUsd: market,
      upsidePct: (discount - 1) * 100,
      roi5Pct: roi5 * 100,
      yr5Usd,
      score,
      gradeRoi,
      reasons,
      signal: rawDiscount >= 1.8 || gradeRoi >= 0.8 ? 'STRONG BUY' : 'BUY',
    });
  }
  out.sort((a, b) => b.score - a.score);
  return urDiversifyAndCap(out);
}

// --- PSA grade scanner --------------------------------------------
function urScanGrade(fmt) {
  const grades = _urFmtToGrades(fmt);
  if (!grades) return [];
  const out = [];
  for (const c of cardData.cards) {
    if (_urLang !== 'all' && (c.lang || 'EN') !== _urLang) continue;
    const anchor = getPsa10Anchor(c);
    const psa10 = anchor && anchor.usd;
    if (!psa10 || psa10 <= 0) continue;

    // Pick the best grade in the requested band — for "low" we pick whichever
    // of PSA 1-5 has the strongest underrated score.
    let best = null;
    for (const g of grades) {
      const todayUsd = estimateGradePrice(c, g, psa10);
      if (todayUsd < 4) continue;
      const effectiveUsd = todayUsd + UR_GRADING_COST_USD; // honest cost-of-acquisition
      if (_urGbpFromUsd(effectiveUsd) > _urMaxGBP) continue;

      const yr5Usd = projectGradePrice(c, g, todayUsd, 5);
      if (!yr5Usd || yr5Usd <= effectiveUsd) continue;
      const roi5 = (yr5Usd - effectiveUsd) / effectiveUsd;

      // "Fair value" for a graded copy = projected 1yr price (proxy for
      // where the market should re-rate to given fundamentals).
      const yr1Usd = projectGradePrice(c, g, todayUsd, 1);
      const fairUsdRaw = Math.max(yr1Usd, todayUsd);
      if (fairUsdRaw <= effectiveUsd * 1.05) continue; // need at least 5% near-term upside

      // Cap PSA discount at 2.0× — graded markets are more efficient than raw.
      const discount = Math.min(fairUsdRaw / effectiveUsd, 2.0);
      const fairUsd = effectiveUsd * discount;
      const charMult = getCharacterMultiplier(c.n);
      const rarityRate = (RARITY_RATES[c.rc] || RARITY_RATES['']).base;
      const ageMonths = getSetAgeMonths(c.sc);
      const ageFactor = ageMonths > 48 ? 1.30 : ageMonths > 24 ? 1.12 : ageMonths < 6 ? 0.85 : 1.0;
      const roiFactor = 1 + Math.max(0, Math.min(roi5, 3)) * 0.7;
      // PSA grade trust: PSA 10 is the most liquid, PSA 6 is thin.
      const gradeLiquidity = g >= 9 ? 1.15 : g >= 8 ? 1.05 : g >= 7 ? 0.95 : 0.85;

      const score = discount * Math.max(1, charMult) * ageFactor * (1 + rarityRate) * roiFactor * gradeLiquidity;

      const cand = {
        card: c,
        grade: g,
        format: 'PSA ' + g,
        marketUsd: todayUsd,
        effectiveUsd,
        fairUsd,
        yr5Usd,
        roi5Pct: Math.min(roi5, 5) * 100,
        upsidePct: (discount - 1) * 100,
        score,
        reasons: urReasonsGrade(c, { discount, charMult, ageMonths, rarityRate, roi5: Math.min(roi5, 5), g, anchor }),
        signal: roi5 > 0.8 ? 'STRONG BUY' : 'BUY',
      };
      if (!best || cand.score > best.score) best = cand;
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.score - a.score);
  return urDiversifyAndCap(out);
}

// Diversify so the list isn't 30× Charizard.
function urDiversifyAndCap(scored) {
  const result = [];
  const charCount = {};
  for (const p of scored) {
    const base = p.card.n
      .replace(/ ex$/i, '').replace(/ V$/i, '').replace(/ VMAX$/i, '').replace(/ VSTAR$/i, '')
      .replace(/ GX$/i, '').replace(/ EX$/i, '').replace(/ \(JP\)$/i, '').trim().toLowerCase();
    charCount[base] = (charCount[base] || 0) + 1;
    if (charCount[base] <= 3) result.push(p);
    if (result.length >= UR_PAGE_SIZE) break;
  }
  return result;
}

function urReasonsRaw(c, ctx) {
  const r = [];
  const pct = ((ctx.discount - 1) * 100).toFixed(0);
  if (ctx.discount >= 2.0) r.push(`<strong>+${pct}% vs fair value</strong>`);
  else r.push(`+${pct}% vs fair value`);
  if (ctx.gradeRoi >= 1.5) r.push(`<strong>PSA 10 lever ${(1 + ctx.gradeRoi).toFixed(1)}×</strong>`);
  else if (ctx.gradeRoi >= 0.5) r.push(`Grading ROI +${(ctx.gradeRoi * 100).toFixed(0)}%`);
  if (ctx.charMult >= 1.4) r.push('Fan favourite');
  else if (ctx.charMult >= 1.2) r.push('Popular character');
  if (ctx.ageMonths > 36) r.push('Mature set');
  else if (ctx.ageMonths < 6) r.push('Fresh print run');
  if (ctx.rarityRate >= 0.2) r.push('Chase pull');
  if (ctx.roi5 >= 1) r.push(`<strong>5yr ROI +${(ctx.roi5 * 100).toFixed(0)}%</strong>`);
  else if (ctx.roi5 >= 0.4) r.push(`5yr ROI +${(ctx.roi5 * 100).toFixed(0)}%`);
  return r.join(' · ');
}

function urReasonsGrade(c, ctx) {
  const r = [];
  r.push(`<strong>PSA ${ctx.g}</strong>`);
  if (ctx.anchor && ctx.anchor.source === 'estimated') r.push('EST. anchor');
  if (ctx.discount >= 1.3) r.push(`Underpriced vs 1yr projection (+${((ctx.discount - 1) * 100).toFixed(0)}%)`);
  if (ctx.charMult >= 1.4) r.push('Fan favourite');
  else if (ctx.charMult >= 1.2) r.push('Popular character');
  if (ctx.ageMonths > 36) r.push('Mature set');
  if (ctx.rarityRate >= 0.2) r.push('Chase pull');
  if (ctx.roi5 >= 1) r.push(`<strong>5yr ROI +${(ctx.roi5 * 100).toFixed(0)}%</strong> (after grading)`);
  else r.push(`5yr ROI +${(ctx.roi5 * 100).toFixed(0)}% (after grading)`);
  return r.join(' · ');
}

function urRender(results) {
  const list = document.getElementById('urList');
  const status = document.getElementById('urStatus');
  const summary = document.getElementById('urSummary');
  if (!list) return;

  const fmtLabel = _urFmt === 'raw' ? 'raw' : _urFmt === 'low' ? 'PSA 1-5' : 'PSA ' + _urFmt;

  if (!results.length) {
    list.innerHTML = '';
    list.appendChild(Object.assign(document.createElement('div'), {
      className: 'ur-empty',
      innerHTML: `No underrated <strong>${fmtLabel}</strong> picks found at your filters. ${_urFmt !== 'raw' ? 'PSA grades need a PSA 10 anchor — try running Price Sync first, or lower the language filter.' : 'Try raising the max-entry slider or switching language filter.'}`,
    }));
    status.innerHTML = `Scan complete · <strong>0 matches</strong>. Try a different format or relax filters.`;
    summary.style.display = 'none';
    return;
  }

  // Summary block (top of the list)
  const avgUpside = results.reduce((s, p) => s + p.upsidePct, 0) / results.length;
  const top = results[0];
  const totalUpsideGbp = results.slice(0, 10).reduce((s, p) => s + _urGbpFromUsd(p.fairUsd - p.effectiveUsd), 0);
  summary.style.display = '';
  summary.innerHTML = `
    <div class="ur-summary-stat"><span class="ur-summary-num">${results.length}</span><span class="ur-summary-lbl">Underrated · ${fmtLabel}</span></div>
    <div class="ur-summary-stat"><span class="ur-summary-num">+${avgUpside.toFixed(0)}%</span><span class="ur-summary-lbl">Avg upside</span></div>
    <div class="ur-summary-stat"><span class="ur-summary-num">+${top.upsidePct.toFixed(0)}%</span><span class="ur-summary-lbl">Best pick</span></div>
    <div class="ur-summary-stat"><span class="ur-summary-num">£${totalUpsideGbp.toFixed(0)}</span><span class="ur-summary-lbl">Top-10 modelled upside</span></div>
  `;

  status.innerHTML = `Found <strong>${results.length}</strong> underrated ${fmtLabel} cards · ranked by composite signal (discount × character × age × ROI).`;

  list.innerHTML = results.map((p, i) => {
    const c = p.card;
    const isJP = (c.lang || 'EN') === 'JP';
    const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const upsideCls = p.upsidePct >= 100 ? 'lg' : '';
    const langPill = isJP
      ? '<span class="ur-lang-pill jp">JP</span>'
      : '<span class="ur-lang-pill">EN</span>';
    const fairBlock = _urFmt === 'raw'
      ? `<div class="ur-fair">Fair: ${fmtGBP(p.fairUsd)}</div>`
      : `<div class="ur-fair">1yr: ${fmtGBP(p.fairUsd)} · 5yr: ${fmtGBP(p.yr5Usd)}</div>`;
    const marketBlock = _urFmt === 'raw'
      ? `<div class="ur-market">Now: <strong>${fmtGBP(p.marketUsd)}</strong></div>`
      : `<div class="ur-market">${p.format}: <strong>${fmtGBP(p.marketUsd)}</strong></div>`;
    return `
      <div class="ur-row" data-id="${esc(c.i)}">
        <div class="ur-rank ${rankCls}">${i + 1}</div>
        <img class="ur-img" src="${getCardImg(c)}" alt="" loading="lazy" onerror="this.style.opacity=0">
        <div class="ur-info">
          <div class="ur-name">${esc(c.n)} ${langPill}</div>
          <div class="ur-meta">${esc(c.s || '—')} · ${esc((RARITY_RATES[c.rc] || RARITY_RATES['']).label || 'Rare')}</div>
          <div class="ur-reasons">${p.reasons}</div>
        </div>
        <div class="ur-values">
          ${marketBlock}
          ${fairBlock}
          <div class="ur-upside ${upsideCls}">↑ ${p.upsidePct.toFixed(0)}%</div>
        </div>
        <div class="ur-score" title="Composite Underrated Score">
          <span class="ur-score-val">${p.score.toFixed(1)}</span>
          <span class="ur-score-lbl">Score</span>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.ur-row').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (!id) return;
      // Switch to Predict tab and select the card.
      const predictBtn = document.querySelector('.page-nav-btn[data-page="predict"]');
      if (predictBtn) predictBtn.click();
      setTimeout(() => {
        try {
          selectCard(id);
          document.getElementById('selectedCardSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (e) {}
      }, 80);
    });
  });
}


// ============================================================================
// Hold Strategy — Market Price Override (per card, per grade tier)
// ----------------------------------------------------------------------------
// Users see the model's "fair value" for each strategy row (Buy Raw, Buy PSA 10,
// etc) but real eBay listings often clear well above (or below) that fair value.
// The override lets the user enter the actual market price they're seeing in
// GBP — that overrides only the "today" buy price for the affected strategy
// row(s). The 5yr target stays anchored to the model's projection so the
// resulting profit/ROI honestly tells the user whether paying the eBay number
// is worth it.
// ============================================================================
const HOLD_OVERRIDE_KEY = 'pkm-hold-overrides';
function _holdOverridesAll() {
  try { return JSON.parse(localStorage.getItem(HOLD_OVERRIDE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function getHoldOverridesForCard(cardId) {
  if (!cardId) return {};
  return _holdOverridesAll()[cardId] || {};
}
function setHoldOverride(cardId, gradeKey, gbpValue) {
  if (!cardId) return;
  const all = _holdOverridesAll();
  all[cardId] = all[cardId] || {};
  const n = (typeof gbpValue === 'string') ? parseFloat(gbpValue) : gbpValue;
  if (gbpValue == null || gbpValue === '' || !isFinite(n) || n <= 0) {
    delete all[cardId][gradeKey];
    if (!Object.keys(all[cardId]).length) delete all[cardId];
  } else {
    all[cardId][gradeKey] = +n;
  }
  try { localStorage.setItem(HOLD_OVERRIDE_KEY, JSON.stringify(all)); } catch {}
}
function clearHoldOverridesForCard(cardId) {
  if (!cardId) return;
  const all = _holdOverridesAll();
  delete all[cardId];
  try { localStorage.setItem(HOLD_OVERRIDE_KEY, JSON.stringify(all)); } catch {}
}
function setHoldOverrideNA(cardId, gradeKey, isNA) {
  if (!cardId) return;
  const all = _holdOverridesAll();
  all[cardId] = all[cardId] || {};
  if (isNA) {
    all[cardId]._na = all[cardId]._na || {};
    all[cardId]._na[gradeKey] = true;
    delete all[cardId][gradeKey]; // clear any price override for this grade
  } else {
    if (all[cardId]._na) {
      delete all[cardId]._na[gradeKey];
      if (!Object.keys(all[cardId]._na).length) delete all[cardId]._na;
    }
  }
  if (!Object.keys(all[cardId]).length) delete all[cardId];
  try { localStorage.setItem(HOLD_OVERRIDE_KEY, JSON.stringify(all)); } catch {}
}

// Apply user-entered market prices to a strategies array (mutates in place).
// Two modes depending on whether an acquisition cost is also recorded:
//
//   No acq cost: override replaces "today" and recomputes profit/ROI from market price.
//     → "I'm thinking of buying at £X, is it worth it?"
//
//   Has acq cost: override is "current market" only — profit/ROI stay on acq cost basis.
//     → "I bought at £10, it's now worth £15, project from there."
//     Surfaces gain-so-far (£10→£15) as a sub-row without changing the ROI denominator.
function applyHoldOverrides(card, strategies, fx, gradingFeeUSD) {
  if (!card || !card.i || !Array.isArray(strategies)) return;
  const overrides = getHoldOverridesForCard(card.i);
  if (!overrides || !Object.keys(overrides).length) return;
  const naFlags = overrides._na || {};
  const fxRateLocal = (typeof fx === 'number' && fx > 0) ? fx : 0.79;
  // When the user has an acquisition cost, the raw-card override means "current market"
  // rather than "what I'm about to pay" — keep acquisition cost as the ROI denominator.
  const acqCostGBP = getAcqCostBasisGBP(card.i);
  const hasAcqCost = acqCostGBP != null && acqCostGBP > 0;
  // The "gamble" (Buy Raw + Grade) row buys raw upfront, so it shares the raw override.
  const sourceKey = { raw: 'raw', gamble: 'raw', psa7: 'psa7', psa8: 'psa8', psa9: 'psa9', psa10: 'psa10' };
  strategies.forEach(s => {
    const ok = sourceKey[s.key];
    if (!ok) return;
    if (naFlags[ok]) { s.na = true; return; }
    const gbp = overrides[ok];
    if (gbp == null || !isFinite(gbp) || gbp <= 0) return;
    const usd = gbp / fxRateLocal;
    const isRawBased = (s.key === 'raw' || s.key === 'gamble');
    if (isRawBased && hasAcqCost) {
      // Override = current market. Preserve acquisition-cost denominator for profit/ROI.
      // profit/roi/today were already computed from acq cost — don't touch them.
      s.marketOverrideGBP = gbp; // kept for the "Override" badge
      s.marketNowGBP      = gbp; // canonical field used for "Market now" sub-row
      s.currentGrowthGBP  = gbp - acqCostGBP;
      s.currentGrowthPct  = acqCostGBP > 0 ? (gbp - acqCostGBP) / acqCostGBP * 100 : 0;
      s.overridden = true;
      s.overrideGBP = gbp;
      return;
    }
    // No acq cost recorded: override replaces the buy-in price and recomputes ROI.
    // The override is treated as an all-in price (listing + shipping already included),
    // so slabShipGBP is intentionally NOT added here.
    if (s.key === 'gamble') {
      s.today = usd + gradingFeeUSD;
    } else {
      s.today = usd;
    }
    s.slabShipGBP = 0; // suppress the "Est. UK shipping" sub-row — already in the override
    s.profit = s.yr5 - s.today;
    s.roi = s.today > 0 ? (s.profit / s.today) * 100 : 0;
    s.overridden = true;
    s.overrideGBP = gbp;
  });
}

// Render the override editor UI inside the Hold Strategy section.
// Five GBP inputs (Raw + PSA 7/8/9/10) collapsed behind a single details/summary.
function renderHoldOverridePanel(card) {
  const host = document.getElementById('holdOverride');
  if (!host) return;
  if (!card || !card.i) { host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = 'block';
  const overrides = getHoldOverridesForCard(card.i);
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  // Build fair-value reference for each grade for the placeholder hint.
  const anchor = (typeof getPsa10Anchor === 'function') ? getPsa10Anchor(card) : null;
  const psa10USD = anchor && anchor.usd;
  const rawUSD = (typeof getCurrentPrice === 'function') ? getCurrentPrice(card) : null;
  function fvGBP(grade) {
    if (grade === 'raw') return rawUSD ? rawUSD * fx : null;
    if (!psa10USD) return null;
    const g = parseInt(grade.replace('psa', ''), 10);
    if (g === 10) return psa10USD * fx;
    if (typeof estimateGradePrice === 'function') return estimateGradePrice(card, g, psa10USD) * fx;
    return null;
  }
  const rows = [
    { key: 'raw',   label: 'Raw' },
    { key: 'psa7',  label: 'PSA 7' },
    { key: 'psa8',  label: 'PSA 8' },
    { key: 'psa9',  label: 'PSA 9' },
    { key: 'psa10', label: 'PSA 10' },
  ];
  const naFlags = overrides._na || {};
  const activeCount = rows.filter(r => overrides[r.key] != null || naFlags[r.key]).length;
  // Check if the raw price is currently from the live feed (PriceCharting).
  const _lp = (typeof livePrice !== 'undefined') ? livePrice : null;
  const _hasLiveRaw = _lp && selectedCard && card.i === selectedCard.i && _lp.pcUngraded > 0;
  const summaryNote = activeCount > 0
    ? `<span class="ho-active">${activeCount} active override${activeCount === 1 ? '' : 's'}</span>`
    : `<span class="ho-hint">${_hasLiveRaw ? 'Using live price · override to correct eBay' : 'Override fair value with actual eBay prices'}</span>`;
  host.innerHTML = `
    <details class="ho-details"${activeCount > 0 ? ' open' : ''}>
      <summary class="ho-summary">
        <span class="ho-label"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg> Market price override</span>
        ${summaryNote}
        <svg class="ho-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="ho-body">
        <p class="ho-blurb">If eBay listings are clearing well above (or below) the model's fair value, drop the actual GBP price into the matching grade. The strategy ROI & winner will recompute using your number as the buy-in.</p>
        <div class="ho-grid">
          ${rows.map(r => {
            const isPSA = r.key !== 'raw';
            const isNA = isPSA && !!naFlags[r.key];
            const fv = fvGBP(r.key);
            const val = overrides[r.key] != null ? overrides[r.key] : '';
            const isLiveRaw = !isPSA && _hasLiveRaw;
            const priceLabel = isLiveRaw ? 'Live' : 'Fair';
            const placeholder = fv != null ? `${priceLabel} £${fv.toFixed(2)}` : 'Enter GBP';
            const fvNote = fv != null && !isNA ? `<span class="ho-fv${isLiveRaw ? ' ho-fv-live' : ''}">${priceLabel} £${fv.toFixed(2)}</span>` : '';
            return `
              <div class="ho-row ${isNA ? 'ho-row-na' : ''}">
                <div class="ho-row-head">
                  <label class="ho-row-label" for="ho-in-${r.key}">${r.label}</label>
                  ${isPSA ? `<label class="ho-na-wrap"><input type="checkbox" class="ho-na-check" data-grade="${r.key}"${isNA ? ' checked' : ''}><span class="ho-na-label-text">N/A</span></label>` : ''}
                </div>
                <div class="ho-input-wrap">
                  <span class="ho-cur">£</span>
                  <input type="number" id="ho-in-${r.key}" class="ho-input${isNA ? ' ho-input-na' : ''}" data-grade="${r.key}"
                         min="0" step="0.01" inputmode="decimal"
                         value="${val}" placeholder="${placeholder}"${isNA ? ' disabled' : ''}>
                </div>
                ${fvNote}
              </div>
            `;
          }).join('')}
        </div>
        <div class="ho-actions">
          <button type="button" class="ho-clear" id="holdOverrideClear">Clear all overrides for this card</button>
        </div>
      </div>
    </details>
  `;
  // Wire input changes — debounce a touch so typing isn't laggy.
  let debounceT = null;
  host.querySelectorAll('.ho-input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const grade = inp.getAttribute('data-grade');
      const v = inp.value;
      if (debounceT) clearTimeout(debounceT);
      debounceT = setTimeout(() => {
        setHoldOverride(card.i, grade, v);
        // Re-render the entire Hold Strategy with the new override applied.
        try { renderHoldStrategy(card); } catch {}
      }, 220);
    });
    // Re-render on blur immediately too, in case user tabs away.
    inp.addEventListener('blur', (e) => {
      const grade = inp.getAttribute('data-grade');
      setHoldOverride(card.i, grade, inp.value);
      try { renderHoldStrategy(card); } catch {}
    });
  });
  host.querySelectorAll('.ho-na-check').forEach(chk => {
    chk.addEventListener('change', () => {
      const grade = chk.getAttribute('data-grade');
      setHoldOverrideNA(card.i, grade, chk.checked);
      try { renderHoldStrategy(card); } catch {}
    });
  });
  const clearBtn = host.querySelector('#holdOverrideClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearHoldOverridesForCard(card.i);
      try { renderHoldStrategy(card); } catch {}
    });
  }
}

// ============================================================================
// Collapsible Sections — global UI cleanup
// ----------------------------------------------------------------------------
// Adds a chevron toggle to every `section.card` so users can collapse noisy
// sections. State persists in localStorage keyed by section id.
// ============================================================================
const COLLAPSED_SECTIONS_KEY = 'pkm-collapsed-sections';
function _getCollapsedSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
function _saveCollapsedSet(set) {
  try { localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...set])); } catch {}
}
function setupCollapsibleSections() {
  const collapsed = _getCollapsedSet();
  const sections = document.querySelectorAll('section.card');
  sections.forEach((sec, idx) => {
    if (sec.dataset.collapsibleReady === '1') return;
    sec.dataset.collapsibleReady = '1';
    const key = sec.id || `card-idx-${idx}`;
    sec.dataset.collapseKey = key;
    sec.classList.add('is-collapsible');

    // Chevron button — absolute-positioned top-right. Stays visible in both
    // collapsed and expanded states.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card-collapse-btn';
    btn.setAttribute('aria-label', 'Toggle section');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
    sec.appendChild(btn);

    if (collapsed.has(key)) {
      sec.classList.add('is-collapsed');
    } else if (sec.dataset.collapseMobile && window.innerWidth <= 600) {
      sec.classList.add('is-collapsed');
      const cur = _getCollapsedSet();
      cur.add(key);
      _saveCollapsedSet(cur);
    }

    function toggle() {
      sec.classList.toggle('is-collapsed');
      const cur = _getCollapsedSet();
      if (sec.classList.contains('is-collapsed')) cur.add(key); else cur.delete(key);
      _saveCollapsedSet(cur);
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

    // Also let users click anywhere on the first child (heading row) to toggle,
    // but skip if the click was on an interactive control inside the header.
    const head = sec.firstElementChild;
    if (head && head.classList && !head.classList.contains('card-collapse-btn')) {
      head.classList.add('card-collapse-header');
      head.addEventListener('click', (e) => {
        if (e.target.closest('input, button, select, textarea, a, [role=button], [contenteditable=true], .ho-details summary')) return;
        toggle();
      });
    }
  });
}

function setupHeaderMenu() {
  const btn = document.getElementById('headerMenuBtn');
  const right = document.querySelector('.header-right');
  if (!btn || !right) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = right.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (right.classList.contains('is-open') && !right.contains(e.target) && e.target !== btn) {
      right.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

function setupCardLinksToggle() {
  const toggle = document.getElementById('cardLinksToggle');
  const links = document.querySelector('.card-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('links-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.querySelector('.clt-chev').style.transform = open ? 'rotate(180deg)' : '';
  });
}

function setupCardEditToggle() {
  const toggle = document.getElementById('cardEditToggle');
  const items = document.getElementById('cardEditItems');
  if (!toggle || !items) return;
  toggle.addEventListener('click', () => {
    const open = items.classList.toggle('edit-open');
    toggle.querySelector('.cet-chev').style.transform = open ? 'rotate(180deg)' : '';
  });
}

// =============================================================================
// Cross-Device Sync · file backup + Cloudflare KV cloud sync
// =============================================================================
// Two-mode sync system:
//   • File backup — Export/import a JSON snapshot. Works today, no setup, ideal
//     for AirDrop / iCloud Drive transfers between Mac, iPhone, and iPad.
//   • Cloud sync   — Uses the marketplace worker's KV-backed /sync endpoint.
//     User picks a long random pair code once, enters it on each device, and
//     local changes auto-push (debounced) while remote changes pull on focus.
//
// The list of keys we sync is conservative: only user-created or
// user-intentionally-edited data. We exclude price caches, FX rate cache, and
// any device-local UI state so devices stay independent on those.
// -----------------------------------------------------------------------------

const SYNC_KEYS = [
  'pkm-portfolio',                  // My Collection
  'pkm-wishlist',                   // Wishlist
  'pkm-compare',                    // Compare slots
  'pkm-watchlist-v1',               // Watchlist (alerts)
  'pkm-mkt-reassignments',          // Listing reassignments
  'pkm-mkt-dismissals',             // Listing dismissals
  'pkm-counterpart-overrides-v1',   // EN<->JP counterpart overrides
  'pkm-pc-overrides-v1',            // PriceCharting overrides
  'pkm-user-cards-v1',              // User-added cards
  'pkm-card-overrides-v1',          // Card metadata overrides
  'pkm-acquisitions-v1',            // How each card was obtained (pack / single + cost)
  'pkm-hold-overrides',             // Per-card grade-specific market price overrides
  'pkm-tcg-overrides-v1',          // TCGPlayer URL overrides (auto-enriched or manual)
  'pkm-tcg-price-overrides-v1',   // TCGPlayer market price overrides (manual USD entry)
  'pkm-jp-psa10-overrides-v1',     // Manually entered JP PSA 10 prices for EN↔JP comparison
  'pkm-reco-dismissed-v1',         // Cards dismissed from Recommendations
  'pkm-budget-max-gbp',           // Max per card budget slider
  'pkm-grading-service-v1',       // Grading service pref: PSA or ACE
  'pkm-ace-tier-v1',              // ACE grading tier pref
  'pkm-fullart-binder-v1',        // Full Art Binder Project Wishlist
  'pkm-binder-species-overrides-v1', // Binder species name overrides (rename "Mega" → "Charizard" etc.)
  'pkm-binder-pairings-v1',      // Manual EN/JP card pairings within binder groups
  'pkm-binder-sort-v1',          // Binder page sort order preference
  'pkm-ace-prices-v1',           // ACE Grading sold prices by grade per card
  'pkm-vintage-v1',              // Vintage page targets (WOTC-era PSA hunt list)
  'pkm-dupe-dismissed-v1',        // Dismissed duplicate / counterpart pairs
];

const SYNC_PAIR_CODE_KEY = 'pkm-sync-pair-code';
const SYNC_ENDPOINT_KEY  = 'pkm-sync-endpoint';
const SYNC_META_KEY      = 'pkm-sync-meta';        // { lastPush, lastPull, lastErr }
const SYNC_LAST_HASH_KEY = 'pkm-sync-last-hash';   // payload hash of last successful push

// ---- Account auth constants (standalone — separate from pair-code legacy) ----
const AUTH_TOKEN_KEY = 'pkm-auth-token';   // JWT (device-local, not synced)
const AUTH_USER_KEY  = 'pkm-auth-user';    // { username, expiresAt } (device-local)

// ---- helpers ----------------------------------------------------------------
function syncGetPairCode()   { try { return localStorage.getItem(SYNC_PAIR_CODE_KEY) || ''; } catch { return ''; } }
function syncSetPairCode(c)  { try { c ? localStorage.setItem(SYNC_PAIR_CODE_KEY, c) : localStorage.removeItem(SYNC_PAIR_CODE_KEY); } catch {} }
function syncGetEndpoint()   {
  try {
    return localStorage.getItem(SYNC_ENDPOINT_KEY)
      || (typeof getMktWorkerUrl === 'function' ? getMktWorkerUrl() : '');
  } catch { return ''; }
}
function syncSetEndpoint(u)  { try { u ? localStorage.setItem(SYNC_ENDPOINT_KEY, u.replace(/\/+$/, '')) : localStorage.removeItem(SYNC_ENDPOINT_KEY); } catch {} }
function syncGetMeta()       { try { return JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}'); } catch { return {}; } }
function syncSetMeta(meta)   { try { localStorage.setItem(SYNC_META_KEY, JSON.stringify({ ...syncGetMeta(), ...meta })); } catch {} }

// 24 bytes of crypto-random → URL-safe base64 (~32 chars). Stays inside the
// worker's [16,64] character validation window.
function syncGenerateCode() {
  const a = new Uint8Array(24);
  (self.crypto || window.crypto).getRandomValues(a);
  let s = ''; for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Build the snapshot we send (or save to file). Includes a version flag so a
// future migration can recognise older blobs and a per-device id for diagnostics.
function syncBuildPayload() {
  const data = {};
  for (const k of SYNC_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) data[k] = v;
    } catch {}
  }
  return {
    v: 1,
    ts: Date.now(),
    device: (navigator.userAgent || '').slice(0, 80),
    keys: Object.keys(data).length,
    data,
  };
}

// Apply an incoming snapshot to localStorage and refresh in-memory state.
// mode: 'replace' overwrites the listed keys, 'merge' merges arrays by id /
// preserves whichever side has the longer entry. For per-key merge we keep it
// simple: arrays are unioned by id, objects are shallow-merged, scalars use
// the remote value.
function syncApplyPayload(payload, mode) {
  if (!payload || !payload.data) return { applied: 0, keys: [] };
  const applied = [];
  for (const k of SYNC_KEYS) {
    if (!(k in payload.data)) continue;
    try {
      const remoteRaw = payload.data[k];
      if (mode === 'replace') {
        localStorage.setItem(k, remoteRaw);
        applied.push(k);
        continue;
      }
      // merge — best effort union for arrays / shallow-merge for objects
      const local = JSON.parse(localStorage.getItem(k) || 'null');
      let remote;
      try { remote = JSON.parse(remoteRaw); } catch { remote = remoteRaw; }
      let merged = remote;
      if (Array.isArray(local) && Array.isArray(remote)) {
        const byId = new Map();
        for (const item of local) {
          const id = (item && (item.id || item.i || item.url)) || JSON.stringify(item);
          byId.set(id, item);
        }
        for (const item of remote) {
          const id = (item && (item.id || item.i || item.url)) || JSON.stringify(item);
          // Remote wins on conflict if it has a newer ts, otherwise keep local
          const existing = byId.get(id);
          if (!existing) byId.set(id, item);
          else if (item && existing && item.ts && existing.ts && item.ts > existing.ts) byId.set(id, item);
        }
        merged = Array.from(byId.values());
      } else if (local && typeof local === 'object' && remote && typeof remote === 'object') {
        merged = { ...local, ...remote };
      }
      localStorage.setItem(k, JSON.stringify(merged));
      applied.push(k);
    } catch (e) { /* skip corrupted key */ }
  }
  // Refresh module-level state so the UI sees the new data without a full reload.
  try {
    if (typeof portfolio !== 'undefined') portfolio = JSON.parse(localStorage.getItem('pkm-portfolio') || '[]');
    if (typeof wishlist !== 'undefined') wishlist = JSON.parse(localStorage.getItem('pkm-wishlist') || '[]');
    if (typeof fullArtBinder !== 'undefined') fullArtBinder = JSON.parse(localStorage.getItem('pkm-fullart-binder-v1') || '[]');
    if (typeof compareSlots !== 'undefined') compareSlots = JSON.parse(localStorage.getItem('pkm-compare') || '[null, null]');
    if (typeof watchlist !== 'undefined') watchlist = JSON.parse(localStorage.getItem('pkm-watchlist-v1') || '[]');
    if (typeof acquisitions !== 'undefined') acquisitions = JSON.parse(localStorage.getItem(ACQ_KEY) || '{}');
    if (typeof binderSpeciesOverrides !== 'undefined') binderSpeciesOverrides = JSON.parse(localStorage.getItem('pkm-binder-species-overrides-v1') || '{}');
    if (typeof binderPairings !== 'undefined') binderPairings = JSON.parse(localStorage.getItem('pkm-binder-pairings-v1') || '{}');
  } catch {}
  // Re-inject user-added cards that arrived from another device, then rebuild
  // the search index so they appear immediately without a page reload.
  try {
    if (applied.includes('pkm-user-cards-v1') && typeof injectUserCards === 'function' && typeof buildSearchIndex === 'function' && cardData) {
      injectUserCards();
      buildSearchIndex(cardData.cards);
      if (typeof buildCounterpartIndex === 'function') buildCounterpartIndex(cardData.cards);
    }
  } catch {}
  // Trigger re-render of any visible panels.
  try { typeof renderPortfolio    === 'function' && renderPortfolio();    } catch {}
  try { typeof renderWishlist        === 'function' && renderWishlist();        } catch {}
  try { typeof renderFullArtBinder   === 'function' && renderFullArtBinder();   } catch {}
  try { typeof renderBinderPage      === 'function' && renderBinderPage();      } catch {}
  try { typeof renderCompare         === 'function' && renderCompare();         } catch {}
  try { typeof renderWatchlist    === 'function' && renderWatchlist();    } catch {}
  try { typeof renderAlerts       === 'function' && renderAlerts();       } catch {}
  try { typeof renderHomeDashboard === 'function' && renderHomeDashboard(); } catch {}
  try { typeof window._applyBudgetUI === 'function' && window._applyBudgetUI(); } catch {}
  return { applied: applied.length, keys: applied };
}

// Cheap content hash so we skip pushes when nothing has changed since last push.
async function syncHashPayload(payload) {
  const json = JSON.stringify(payload.data);
  const buf = new TextEncoder().encode(json);
  const digest = await (self.crypto || window.crypto).subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Cloud sync (KV-backed worker) ------------------------------------------
async function syncCloudPush({ silent } = {}) {
  const endpoint = syncGetEndpoint();
  const code = syncGetPairCode();
  if (!endpoint || !code) return { ok: false, error: 'Endpoint or pair code missing' };
  const payload = syncBuildPayload();
  const hash = await syncHashPayload(payload);
  const lastHash = (() => { try { return localStorage.getItem(SYNC_LAST_HASH_KEY) || ''; } catch { return ''; } })();
  if (silent && hash === lastHash) return { ok: true, skipped: true };
  try {
    const res = await fetch(`${endpoint}/sync?key=${encodeURIComponent(code)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = `HTTP ${res.status} ${txt.slice(0, 140)}`;
      syncSetMeta({ lastErr: err, lastErrAt: Date.now() });
      syncUpdateStatus(); syncUpdateCloudLog(`Push failed: ${err}`, 'err');
      return { ok: false, error: err };
    }
    const j = await res.json().catch(() => ({}));
    try { localStorage.setItem(SYNC_LAST_HASH_KEY, hash); } catch {}
    syncSetMeta({ lastPush: Date.now(), lastPushBytes: j.bytes || 0, lastErr: null });
    syncUpdateStatus(); syncUpdateCloudLog(`Pushed ${j.bytes || '?'} bytes (${payload.keys} keys).`, 'ok');
    return { ok: true, ts: j.ts, bytes: j.bytes };
  } catch (e) {
    const err = e.message || String(e);
    syncSetMeta({ lastErr: err, lastErrAt: Date.now() });
    syncUpdateStatus(); syncUpdateCloudLog(`Push error: ${err}`, 'err');
    return { ok: false, error: err };
  }
}

async function syncCloudPull({ mode } = {}) {
  const endpoint = syncGetEndpoint();
  const code = syncGetPairCode();
  if (!endpoint || !code) return { ok: false, error: 'Endpoint or pair code missing' };
  try {
    const res = await fetch(`${endpoint}/sync?key=${encodeURIComponent(code)}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = `HTTP ${res.status} ${txt.slice(0, 140)}`;
      syncSetMeta({ lastErr: err, lastErrAt: Date.now() });
      syncUpdateStatus(); syncUpdateCloudLog(`Pull failed: ${err}`, 'err');
      return { ok: false, error: err };
    }
    const j = await res.json().catch(() => ({}));
    if (!j || !j.data) {
      syncSetMeta({ lastPull: Date.now(), lastErr: null });
      syncUpdateStatus(); syncUpdateCloudLog('Pulled — remote store is empty yet.', 'info');
      return { ok: true, applied: 0, empty: true };
    }
    const mergeMode = mode || syncReadMergeMode() || 'merge';
    const result = syncApplyPayload(j, mergeMode);
    syncSetMeta({ lastPull: Date.now(), lastErr: null, lastPullKeys: result.applied, lastPullMode: mergeMode });
    syncUpdateStatus(); syncUpdateCloudLog(`Pulled ${result.applied} keys (${mergeMode}).`, 'ok');
    return { ok: true, ...result, ts: j.ts };
  } catch (e) {
    const err = e.message || String(e);
    syncSetMeta({ lastErr: err, lastErrAt: Date.now() });
    syncUpdateStatus(); syncUpdateCloudLog(`Pull error: ${err}`, 'err');
    return { ok: false, error: err };
  }
}

// Wired into every save path that mutates a synced key. Debounced 4s so a burst
// of edits (e.g. dragging multiple cards) becomes one push.
let _syncPushTimer = null;
let _syncNudgeHideTimer = null;

function _syncNudgeShow() {
  const el = document.getElementById('syncNudge');
  const lbl = document.getElementById('syncNudgeLabel');
  if (!el) return;
  clearTimeout(_syncNudgeHideTimer);
  el.classList.remove('is-done');
  el.classList.add('is-visible');
  if (lbl) lbl.textContent = 'Sync changes';
}

function _syncNudgeDone() {
  const el = document.getElementById('syncNudge');
  const lbl = document.getElementById('syncNudgeLabel');
  if (!el) return;
  el.classList.add('is-done');
  if (lbl) lbl.textContent = '✓ Synced';
  clearTimeout(_syncNudgeHideTimer);
  _syncNudgeHideTimer = setTimeout(() => el.classList.remove('is-visible', 'is-done'), 2200);
}

// ---- Account auth helpers ----
// Safari ITP can evict localStorage for *.github.io after inactivity.
// Cookies survive that eviction, so we write both and read from cookies as fallback.
const AUTH_COOKIE_T = 'pkm_at';
const AUTH_COOKIE_U = 'pkm_au';
function _authSetCookie(name, val, days) {
  const exp = new Date(Date.now() + days * 86400000).toUTCString();
  const sec = location.protocol === 'https:' ? ';Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(val)};expires=${exp};path=/;SameSite=Lax${sec}`;
}
function _authGetCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function _authDelCookie(name) {
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}
function authGetToken() {
  try {
    const ls = localStorage.getItem(AUTH_TOKEN_KEY);
    if (ls) return ls;
    // Fallback: localStorage was cleared (e.g. Safari ITP) but cookie survived.
    const ck = _authGetCookie(AUTH_COOKIE_T);
    if (ck) localStorage.setItem(AUTH_TOKEN_KEY, ck); // restore
    return ck || '';
  } catch { return _authGetCookie(AUTH_COOKIE_T) || ''; }
}
function authGetUser() {
  try {
    const ls = localStorage.getItem(AUTH_USER_KEY);
    if (ls) return JSON.parse(ls);
    const ck = _authGetCookie(AUTH_COOKIE_U);
    if (ck) localStorage.setItem(AUTH_USER_KEY, ck); // restore
    return ck ? JSON.parse(ck) : null;
  } catch { return null; }
}
function authSetSession(token, username, expiresAt) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify({ username, expiresAt }));
    _authSetCookie(AUTH_COOKIE_T, token, 120);
    _authSetCookie(AUTH_COOKIE_U, JSON.stringify({ username, expiresAt }), 120);
  } catch {}
}
function authClearSession() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    _authDelCookie(AUTH_COOKIE_T);
    _authDelCookie(AUTH_COOKIE_U);
  } catch {}
}
function authIsActive() {
  const token = authGetToken();
  const user = authGetUser();
  if (!token || !user) return false;
  if (user.expiresAt && new Date(user.expiresAt) < new Date()) return false;
  return true;
}
function authWorkerBase() {
  return syncGetEndpoint() || MKT_WORKER_DEFAULT || '';
}
async function authRequest(path, opts = {}) {
  const base = authWorkerBase();
  if (!base) throw new Error('Worker URL not set. Configure it in the Cloud sync tab first.');
  const resp = await fetch(`${base}${path}`, opts);
  const json = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}
async function authRegister(username, password) {
  return authRequest('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}
async function authLogin(username, password) {
  return authRequest('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}
async function authSyncPush({ silent = false } = {}) {
  if (!authIsActive()) return false;
  const token = authGetToken();
  const payload = syncBuildPayload();
  const base = authWorkerBase();
  if (!base) return false;
  try {
    const resp = await fetch(`${base}/user/sync`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!silent) authLogLine('Pushed to account sync', 'ok');
    authUpdateStatus('Last push: ' + new Date().toLocaleTimeString('en-GB'));
    return true;
  } catch (err) {
    if (!silent) authLogLine('Push failed: ' + err.message, 'err');
    return false;
  }
}
async function authSyncPull({ mode } = {}) {
  if (!authIsActive()) return false;
  const token = authGetToken();
  const base = authWorkerBase();
  if (!base) return false;
  try {
    const resp = await fetch(`${base}/user/sync`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    if (!j || !j.data) { authLogLine('Nothing stored yet', 'info'); return false; }
    const m = mode || syncReadMergeMode() || 'merge';
    const result = syncApplyPayload(j, m);
    authLogLine(`Pulled (${m}): ${result.merged} keys applied`, 'ok');
    authUpdateStatus('Last pull: ' + new Date().toLocaleTimeString('en-GB'));
    return true;
  } catch (err) {
    authLogLine('Pull failed: ' + err.message, 'err');
    return false;
  }
}
// Push then pull on every home-tab navigation so all devices stay current.
async function _syncOnHomeNav() {
  try {
    if (authIsActive()) {
      await authSyncPush({ silent: true });
      await authSyncPull({ mode: 'merge' });
    } else if (syncGetPairCode() && syncGetEndpoint()) {
      await syncCloudPush({ silent: true });
      await syncCloudPull({ mode: 'merge' });
    }
  } catch {}
}
function authLogLine(msg, cls = '') {
  const log = document.getElementById('authSyncLog') || document.getElementById('authLog');
  if (!log) return;
  const el = document.createElement('div');
  el.className = `sync-log-line${cls ? ' sync-log-' + cls : ''}`;
  el.textContent = '[' + new Date().toLocaleTimeString('en-GB') + '] ' + msg;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}
function authUpdateStatus(text, cls = '') {
  const el = document.getElementById('authSyncStatus');
  if (!el) return;
  el.className = 'sync-cloud-status' + (cls ? ' ' + cls : ' is-connected');
  el.querySelector('.sync-cloud-text').textContent = text;
}
function authRenderState() {
  const notIn = document.getElementById('authNotSignedIn');
  const signedIn = document.getElementById('authSignedIn');
  if (!notIn || !signedIn) return;
  const active = authIsActive();
  notIn.style.display = active ? 'none' : '';
  signedIn.style.display = active ? '' : 'none';
  if (active) {
    const user = authGetUser();
    const av = document.getElementById('authAvatar');
    const nm = document.getElementById('authUsernameDisplay');
    const ex = document.getElementById('authExpiry');
    if (av) av.textContent = (user.username || '?')[0].toUpperCase();
    if (nm) nm.textContent = user.username || '';
    if (ex && user.expiresAt) {
      const days = Math.round((new Date(user.expiresAt) - Date.now()) / 86400000);
      ex.textContent = `Session expires in ${days} day${days !== 1 ? 's' : ''}`;
    }
    const jwt = authGetToken();
    const mcpBase = 'https://pokemon-marketplace.simontariq.workers.dev/mcp';
    const mcpFull = jwt ? `${mcpBase}?token=${jwt}` : mcpBase;
    const urlEl = document.getElementById('claudeMcpUrl');
    if (urlEl) {
      urlEl.textContent = jwt ? `${mcpBase}?token=${jwt.slice(0, 12)}…` : mcpBase;
      urlEl.dataset.full = mcpFull;
    }
    const tok = document.getElementById('claudeToken');
    if (tok) {
      tok.textContent = jwt ? jwt.slice(0, 24) + '…' : '—';
      tok.dataset.full = jwt || '';
    }
  }
}

function syncSchedulePush() {
  // Auth path takes priority; legacy pair-code is the fallback.
  if (authIsActive()) {
    clearTimeout(_syncPushTimer);
    _syncNudgeShow();
    _syncPushTimer = setTimeout(async () => {
      await authSyncPush({ silent: true });
      _syncNudgeDone();
    }, 4000);
    return;
  }
  if (!syncGetPairCode() || !syncGetEndpoint()) return;
  clearTimeout(_syncPushTimer);
  _syncNudgeShow();
  _syncPushTimer = setTimeout(async () => {
    await syncCloudPush({ silent: true });
    _syncNudgeDone();
  }, 4000);
}

// Patch known save functions so any data change auto-pushes. Done via wrappers
// so the original behaviour is preserved untouched.
function syncInstallAutoPushHooks() {
  const wrap = (name) => {
    if (typeof window[name] !== 'function') return;
    const orig = window[name];
    window[name] = function() { const r = orig.apply(this, arguments); syncSchedulePush(); return r; };
  };
  // Functions defined at module scope aren't on window; patch the localStorage
  // setter instead for total coverage of all SYNC_KEYS.
  const origSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(k, v) {
    origSet(k, v);
    if (SYNC_KEYS.includes(k)) syncSchedulePush();
  };
}

// ---- File backup ------------------------------------------------------------
function syncFileExportJson() {
  const payload = syncBuildPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `pokemon-predictor-backup-${ts}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { ok: true, filename, bytes: blob.size, keys: payload.keys };
}

async function syncFileShare() {
  if (!navigator.share) return { ok: false, error: 'Share API not available' };
  const payload = syncBuildPayload();
  try {
    const file = new File([JSON.stringify(payload, null, 2)], `pokemon-predictor-backup.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Pokémon Predictor Backup' });
      return { ok: true };
    }
    await navigator.share({ title: 'Pokémon Predictor Backup', text: JSON.stringify(payload) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function syncFileCopy() {
  const payload = syncBuildPayload();
  const json = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    return { ok: true, bytes: json.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function syncFileImportFromText(text, mode) {
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || !payload.data) {
      return { ok: false, error: 'Not a valid backup file (missing data)' };
    }
    const result = syncApplyPayload(payload, mode || syncReadMergeMode() || 'merge');
    syncSetMeta({ lastImport: Date.now(), lastImportKeys: result.applied });
    syncUpdateStatus();
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function syncFileImportFromFile(file, mode) {
  if (!file) return { ok: false, error: 'No file picked' };
  const text = await file.text();
  return syncFileImportFromText(text, mode);
}

function syncReadMergeMode() {
  const sel = document.querySelector('input[name="syncMode"]:checked');
  return sel ? sel.value : 'merge';
}

// ---- UI wiring --------------------------------------------------------------
function syncFmtTimeAgo(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5)   return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

function syncUpdateStatus() {
  const el = document.getElementById('syncStatus');
  const meta = syncGetMeta();
  const code = syncGetPairCode();
  const last = Math.max(meta.lastPush || 0, meta.lastPull || 0);
  if (el) {
    if (authIsActive()) {
      const user = authGetUser();
      el.textContent = user?.username ? `Account · ${user.username}` : 'Account sync active';
    } else if (!code) el.textContent = 'Not paired';
    else if (meta.lastErr) el.textContent = `Error · ${meta.lastErr.slice(0, 60)}`;
    else el.textContent = last ? `Synced ${syncFmtTimeAgo(last)}` : `Paired · awaiting first sync`;
  }
  // Stat row
  const row = document.getElementById('syncStatRow');
  if (row) {
    const counts = SYNC_KEYS.reduce((acc, k) => {
      try {
        const v = JSON.parse(localStorage.getItem(k) || 'null');
        acc[k] = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : (v ? 1 : 0));
      } catch { acc[k] = 0; }
      return acc;
    }, {});
    row.innerHTML = `
      <span class="sync-stat"><strong>${counts['pkm-portfolio'] || 0}</strong> collection</span>
      <span class="sync-stat"><strong>${counts['pkm-wishlist'] || 0}</strong> wishlist</span>
      <span class="sync-stat"><strong>${counts['pkm-watchlist-v1'] || 0}</strong> watchlist</span>
      <span class="sync-stat"><strong>${counts['pkm-mkt-reassignments'] || 0}</strong> reassignments</span>
      <span class="sync-stat"><strong>${counts['pkm-mkt-dismissals'] || 0}</strong> dismissals</span>
    `;
  }
  // Cloud status pill
  const cloudStatus = document.getElementById('syncCloudStatus');
  if (cloudStatus) {
    const txt = cloudStatus.querySelector('.sync-cloud-text');
    cloudStatus.classList.toggle('is-connected', !!code && !meta.lastErr);
    cloudStatus.classList.toggle('is-error', !!meta.lastErr);
    if (txt) {
      if (meta.lastErr) txt.textContent = `Error: ${meta.lastErr.slice(0, 80)}`;
      else if (code && last) txt.textContent = `Connected · last sync ${syncFmtTimeAgo(last)}`;
      else if (code) txt.textContent = `Connected · awaiting first sync`;
      else txt.textContent = `Not connected`;
    }
  }
  // Enable / disable cloud buttons
  const enable = !!(syncGetPairCode() && syncGetEndpoint());
  ['syncCloudPush', 'syncCloudPull'].forEach(id => {
    const b = document.getElementById(id); if (b) b.disabled = !enable;
  });
  const dis = document.getElementById('syncCloudDisconnect');
  if (dis) dis.style.display = enable ? '' : 'none';
}

function syncUpdateCloudLog(msg, kind) {
  const log = document.getElementById('syncCloudLog');
  if (!log) return;
  const line = document.createElement('div');
  line.className = `sync-log-line sync-log-${kind || 'info'}`;
  const stamp = new Date().toLocaleTimeString();
  line.textContent = `[${stamp}] ${msg}`;
  log.prepend(line);
  // Keep only last 8 lines
  while (log.children.length > 8) log.removeChild(log.lastChild);
}

function syncOpenPanel() {
  const p = document.getElementById('syncPanel'); if (!p) return;
  p.style.display = '';
  // Populate fields with current state
  const ep = document.getElementById('syncEndpoint');
  const pc = document.getElementById('syncPairCode');
  if (ep) ep.value = syncGetEndpoint() || (typeof MKT_WORKER_DEFAULT === 'string' ? MKT_WORKER_DEFAULT : '');
  if (pc) pc.value = syncGetPairCode();
  syncUpdateStatus();
}
function syncClosePanel() {
  const p = document.getElementById('syncPanel'); if (p) p.style.display = 'none';
}

function syncBindOnce() {
  // Show the toggle button (it's hidden by default in the HTML)
  const toggle = document.getElementById('syncToggle');
  if (toggle) {
    toggle.style.display = '';
    toggle.addEventListener('click', () => {
      const panel = document.getElementById('syncPanel');
      if (!panel) return;
      if (panel.style.display === 'none' || !panel.style.display) syncOpenPanel();
      else syncClosePanel();
    });
  }
  document.getElementById('syncClose')?.addEventListener('click', syncClosePanel);

  // Sync nudge chip — tap to push immediately instead of waiting for debounce
  document.getElementById('syncNudgeBtn')?.addEventListener('click', async () => {
    clearTimeout(_syncPushTimer);
    await syncCloudPush({ silent: true });
    _syncNudgeDone();
  });

  // Tab switching
  document.querySelectorAll('.sync-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.sync-tab').forEach(t => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.sync-tab-content').forEach(c => {
        const active = c.dataset.tab === target;
        c.classList.toggle('is-active', active);
        c.style.display = active ? '' : 'none';
      });
    });
  });

  // File-backup buttons
  document.getElementById('syncExportDownload')?.addEventListener('click', () => {
    const r = syncFileExportJson();
    syncUpdateCloudLog(`Exported ${r.filename} (${r.bytes} bytes, ${r.keys} keys).`, 'ok');
  });
  // Show share button only if Web Share API supports files
  if (navigator.share) {
    const sb = document.getElementById('syncExportShare');
    if (sb) {
      sb.style.display = '';
      sb.addEventListener('click', async () => {
        const r = await syncFileShare();
        if (!r.ok) alert(`Share failed: ${r.error}`);
      });
    }
  }
  document.getElementById('syncExportCopy')?.addEventListener('click', async () => {
    const r = await syncFileCopy();
    syncUpdateCloudLog(r.ok ? `Copied ${r.bytes} bytes to clipboard.` : `Copy failed: ${r.error}`, r.ok ? 'ok' : 'err');
  });
  document.getElementById('syncImportFile')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const mode = syncReadMergeMode();
    const r = await syncFileImportFromFile(file, mode);
    e.target.value = '';
    alert(r.ok ? `Imported ${r.applied} keys (${mode}).` : `Import failed: ${r.error}`);
    syncUpdateStatus();
  });
  document.getElementById('syncImportPaste')?.addEventListener('click', () => {
    const a = document.getElementById('syncPasteArea'); if (a) a.style.display = '';
  });
  document.getElementById('syncPasteCancel')?.addEventListener('click', () => {
    const a = document.getElementById('syncPasteArea'); if (a) a.style.display = 'none';
  });
  document.getElementById('syncPasteImport')?.addEventListener('click', async () => {
    const inp = document.getElementById('syncPasteInput'); if (!inp) return;
    const mode = syncReadMergeMode();
    const r = await syncFileImportFromText(inp.value, mode);
    alert(r.ok ? `Imported ${r.applied} keys (${mode}).` : `Import failed: ${r.error}`);
    if (r.ok) { inp.value = ''; const a = document.getElementById('syncPasteArea'); if (a) a.style.display = 'none'; }
    syncUpdateStatus();
  });

  // Cloud-sync buttons
  document.getElementById('syncGenCode')?.addEventListener('click', () => {
    const code = syncGenerateCode();
    const pc = document.getElementById('syncPairCode'); if (pc) pc.value = code;
  });
  document.getElementById('syncCloudConnect')?.addEventListener('click', async () => {
    const ep = (document.getElementById('syncEndpoint')?.value || '').trim();
    const pc = (document.getElementById('syncPairCode')?.value || '').trim();
    if (!ep) return alert('Worker URL is required');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(pc)) return alert('Pair code must be 16-64 letters/digits/_/- (tap Generate for one).');
    syncSetEndpoint(ep);
    syncSetPairCode(pc);
    syncUpdateStatus();
    syncUpdateCloudLog(`Saved endpoint + pair code. Pulling existing remote data…`, 'info');
    const pull = await syncCloudPull({ mode: 'merge' });
    if (pull.ok && pull.empty) {
      syncUpdateCloudLog(`Remote is empty — pushing local snapshot to seed it.`, 'info');
      await syncCloudPush();
    } else if (pull.ok) {
      // Also push so this device's deltas merge back up.
      await syncCloudPush();
    }
  });
  document.getElementById('syncCloudPush')?.addEventListener('click', async () => {
    const r = await syncCloudPush();
    if (!r.ok) alert(`Push failed: ${r.error}`);
  });
  document.getElementById('syncCloudPull')?.addEventListener('click', async () => {
    const r = await syncCloudPull();
    if (!r.ok) alert(`Pull failed: ${r.error}`);
  });
  document.getElementById('syncCloudDisconnect')?.addEventListener('click', () => {
    if (!confirm('Disconnect from cloud sync? Local data is kept; remote blob is left in place.')) return;
    syncSetPairCode('');
    // Wipe any lingering sync state so the UI returns to a clean "Not paired" view.
    try {
      localStorage.removeItem(SYNC_META_KEY);
      localStorage.removeItem(SYNC_LAST_HASH_KEY);
    } catch {}
    if (_syncPushTimer) { clearTimeout(_syncPushTimer); _syncPushTimer = null; }
    syncUpdateStatus();
    syncUpdateCloudLog('Disconnected. Local data unchanged.', 'info');
  });

  // Download paste-ready worker source so the user can drop it into Cloudflare.
  document.getElementById('syncDownloadWorker')?.addEventListener('click', async () => {
    try {
      const res = await fetch('worker-paste-this.js', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/javascript' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'worker-paste-this.js';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      syncUpdateCloudLog('Downloaded worker source. Paste into your Cloudflare worker editor.', 'ok');
    } catch (e) {
      syncUpdateCloudLog('Could not download worker source: ' + (e.message || e), 'err');
    }
  });

  // ---- Account auth tab event listeners ----
  function authFormLog(msg, cls = '') {
    const log = document.getElementById('authLog');
    if (!log) return;
    log.innerHTML = '';
    const el = document.createElement('div');
    el.className = `sync-log-line${cls ? ' sync-log-' + cls : ''}`;
    el.textContent = msg;
    log.appendChild(el);
  }

  async function authDoLogin(username, password, register = false) {
    const btn = document.getElementById(register ? 'authRegisterBtn' : 'authLoginBtn');
    if (btn) btn.disabled = true;
    authFormLog('Connecting…', 'info');
    try {
      const fn = register ? authRegister : authLogin;
      const res = await fn(username, password);
      authSetSession(res.token, res.username, res.expiresAt);
      authRenderState();
      authLogLine((register ? 'Account created' : 'Signed in') + ' as ' + res.username, 'ok');
      // Pull down any existing cloud data on first sign-in.
      await authSyncPull({ mode: 'merge' });
    } catch (err) {
      authFormLog(err.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.getElementById('authLoginBtn')?.addEventListener('click', async () => {
    const u = document.getElementById('authUsername')?.value.trim();
    const p = document.getElementById('authPassword')?.value;
    if (!u || !p) { authFormLog('Enter a username and password.', 'err'); return; }
    await authDoLogin(u, p, false);
  });
  document.getElementById('authRegisterBtn')?.addEventListener('click', async () => {
    const u = document.getElementById('authUsername')?.value.trim();
    const p = document.getElementById('authPassword')?.value;
    if (!u || !p) { authFormLog('Enter a username and password.', 'err'); return; }
    await authDoLogin(u, p, true);
  });
  document.getElementById('authSyncNowBtn')?.addEventListener('click', async () => {
    await authSyncPush({ silent: false });
    await authSyncPull({ mode: 'merge' });
  });
  document.getElementById('authPushBtn')?.addEventListener('click', async () => {
    await authSyncPush({ silent: false });
  });
  document.getElementById('authPullBtn')?.addEventListener('click', async () => {
    await authSyncPull({ mode: syncReadMergeMode() || 'merge' });
  });
  document.getElementById('authLogoutBtn')?.addEventListener('click', () => {
    authClearSession();
    authRenderState();
  });
  document.getElementById('authDeleteAccountBtn')?.addEventListener('click', async () => {
    if (!confirm('Delete your account? This removes all synced data permanently and cannot be undone.')) return;
    const token = authGetToken();
    const base = authWorkerBase();
    try {
      const resp = await fetch(`${base}/auth/account`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      authClearSession();
      authRenderState();
      authFormLog('Account deleted.', 'ok');
    } catch (err) {
      authLogLine('Delete failed: ' + err.message, 'err');
    }
  });

  document.querySelectorAll('.sync-claude-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.copy;
      let text = '';
      if (type === 'url') {
        text = document.getElementById('claudeMcpUrl')?.dataset.full || '';
      } else {
        text = document.getElementById('claudeToken')?.dataset.full || '';
      }
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      } catch { btn.textContent = 'Failed'; }
    });
  });

  // Initialise auth UI state on load.
  authRenderState();
  if (authIsActive()) {
    authSyncPull({ mode: 'merge' });
  }

  // Pull on focus so a return visit picks up changes from other devices.
  let lastFocusPull = 0;
  window.addEventListener('focus', () => {
    if (authIsActive()) {
      if (Date.now() - lastFocusPull < 30_000) return;
      lastFocusPull = Date.now();
      authSyncPull({ mode: 'merge' });
      return;
    }
    if (!syncGetPairCode() || !syncGetEndpoint()) return;
    if (Date.now() - lastFocusPull < 30_000) return;
    lastFocusPull = Date.now();
    syncCloudPull({ mode: 'merge' });
  });

  syncInstallAutoPushHooks();
  syncUpdateStatus();

  // Pull once on cold boot if already paired so the device starts fresh.
  if (syncGetPairCode() && syncGetEndpoint()) {
    setTimeout(() => syncCloudPull({ mode: 'merge' }), 800);
  }

  // Daily 9 AM pull — keeps every device in sync each morning without
  // needing a manual push. Uses a device-local key (not in SYNC_KEYS)
  // to track whether today's run has already happened.
  const SYNC_DAILY_KEY = 'pkm-sync-daily-pull-last';

  function syncScheduleDailyPull() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(syncRunDailyPull, next - now);
  }

  function syncRunDailyPull() {
    const todayStr = new Date().toISOString().slice(0, 10);
    localStorage.setItem(SYNC_DAILY_KEY, todayStr);
    if (authIsActive()) {
      authSyncPull({ mode: 'merge' });
    } else if (syncGetPairCode() && syncGetEndpoint()) {
      syncUpdateCloudLog('Daily 9 AM pull starting…', 'info');
      syncCloudPull({ mode: 'merge' });
    }
    syncScheduleDailyPull();
  }

  // On cold boot: if 9 AM has already passed today and the daily pull
  // hasn't run yet, fire it after the boot pull settles (6 s delay).
  // Otherwise just arm the timer for the next 9 AM.
  {
    const now = new Date();
    const nineAm = new Date(now); nineAm.setHours(9, 0, 0, 0);
    const lastDaily = localStorage.getItem(SYNC_DAILY_KEY);
    const todayStr = now.toISOString().slice(0, 10);
    if (lastDaily !== todayStr && now >= nineAm) {
      setTimeout(syncRunDailyPull, 6000);
    } else {
      syncScheduleDailyPull();
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncBindOnce);
} else {
  syncBindOnce();
}

// ═══════════════════════════════════════════════════════════════════════════
// BUDGETER — Aug–Dec 2026 monthly Pokémon spend tracker
// ═══════════════════════════════════════════════════════════════════════════

const BUDGETER_KEY = 'pkm-budgeter-v1';
const BUDGET_MONTHS = [
  { key: '2026-08', label: 'August',    short: 'Aug' },
  { key: '2026-09', label: 'September', short: 'Sep' },
  { key: '2026-10', label: 'October',   short: 'Oct' },
  { key: '2026-11', label: 'November',  short: 'Nov' },
  { key: '2026-12', label: 'December',  short: 'Dec' },
];

function _loadBudget() {
  try { const r = localStorage.getItem(BUDGETER_KEY); if (r) return JSON.parse(r); } catch(e) {}
  return { target: 250, months: {} };
}
function _saveBudget(data) {
  try { localStorage.setItem(BUDGETER_KEY, JSON.stringify(data)); } catch(e) {}
}
function _budgetMonth(data, key) {
  return data.months[key] || { packs: 0, singles: 0, sold: 0 };
}
function _gbp(n) {
  return '£' + (n || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// Returns { '2026-08': { target: N, rollover: N }, ... } — effective target per
// month after rolling the previous month's balance forward. Surplus increases
// next month's target; overspend decreases it (rollover < 0). The displayed
// target is clamped at £0 — a deficit bigger than one month's budget keeps
// carrying via the unclamped balance.
function _computeEffectiveTargets(data) {
  const base = data.target || 0;
  const result = {};
  let rollover = 0;
  BUDGET_MONTHS.forEach(m => {
    const rawEff = base + rollover;
    result[m.key] = { target: Math.max(0, rawEff), rollover };
    const md = _budgetMonth(data, m.key);
    const net = (md.packs || 0) + (md.singles || 0) - (md.sold || 0);
    const surplus = rawEff - net;
    // Deficits only carry when a target is actually set; with no budget
    // configured (base 0) only surplus from sales rolls, as before.
    rollover = base > 0 ? surplus : Math.max(0, surplus);
  });
  return result;
}

function _bdgRolloverText(rollover, effTarget) {
  if (rollover > 0) return `↪ ${_gbp(rollover)} rolled over · effective target ${_gbp(effTarget)}`;
  if (rollover < 0) return `↪ ${_gbp(-rollover)} overspend deducted · effective target ${_gbp(effTarget)}`;
  return '';
}

function _budgetChartHTML(data) {
  const effs = _computeEffectiveTargets(data);
  const W = 500, H = 200;
  const PL = 36, PR = 6, PT = 14, PB = 30;
  const CW = W - PL - PR, CH = H - PT - PB;
  const base = data.target || 250;

  let maxVal = base;
  BUDGET_MONTHS.forEach(m => {
    const md = _budgetMonth(data, m.key);
    maxVal = Math.max(maxVal, (md.packs||0)+(md.singles||0), effs[m.key].target);
  });
  const step = maxVal <= 500 ? 50 : maxVal <= 1500 ? 100 : 250;
  maxVal = Math.max(Math.ceil(maxVal / step) * step, step);

  const toY = v => PT + CH * (1 - v / maxVal);
  const toH = v => Math.max(0, CH * v / maxVal);

  const groupW = CW / 5;
  const mainW  = Math.min(28, groupW * 0.4);
  const soldW  = Math.min(12, groupW * 0.17);
  const gap    = 3;

  let svg = '';

  // Gridlines
  [0, 0.5, 1].forEach(f => {
    const v = maxVal * f, y = toY(v);
    svg += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W-PR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.055)" stroke-width="1"/>`;
    svg += `<text x="${(PL-5).toFixed(1)}" y="${(y+3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.27)" font-family="monospace">£${v>=1000?(v/1000)+'k':v}</text>`;
  });

  // Base target dashed line
  const ty = toY(base);
  svg += `<line x1="${PL}" y1="${ty.toFixed(1)}" x2="${(W-PR).toFixed(1)}" y2="${ty.toFixed(1)}" stroke="rgba(255,255,255,0.20)" stroke-width="1" stroke-dasharray="4,3"/>`;

  BUDGET_MONTHS.forEach((m, i) => {
    const md     = _budgetMonth(data, m.key);
    const packs   = md.packs   || 0;
    const singles = md.singles || 0;
    const sold    = md.sold    || 0;
    const gross   = packs + singles;

    const cx    = PL + i * groupW + groupW / 2;
    const totalW = mainW + gap + soldW;
    const mainX  = cx - totalW / 2;
    const soldX  = mainX + mainW + gap;
    const bot    = PT + CH;

    const grossH   = toH(gross);
    const singlesH = toH(singles);
    const soldH    = toH(sold);

    // Gross bar (packs = accent yellow as base)
    if (grossH > 0) {
      svg += `<rect x="${mainX.toFixed(1)}" y="${(bot-grossH).toFixed(1)}" width="${mainW}" height="${grossH.toFixed(1)}" fill="#e8b634" opacity="0.82" rx="3"/>`;
      // Singles overlay (purple) at the top
      if (singlesH > 0) {
        svg += `<rect x="${mainX.toFixed(1)}" y="${(bot-grossH).toFixed(1)}" width="${mainW}" height="${singlesH.toFixed(1)}" fill="#8a6ee0" opacity="0.88" rx="3"/>`;
        // Patch rounded bottom of singles rect so it sits flush on packs
        if (grossH - singlesH > 3) {
          svg += `<rect x="${mainX.toFixed(1)}" y="${(bot-grossH+singlesH-3).toFixed(1)}" width="${mainW}" height="3" fill="#8a6ee0" opacity="0.88"/>`;
        }
      }
    } else {
      svg += `<rect x="${mainX.toFixed(1)}" y="${(bot-1).toFixed(1)}" width="${mainW}" height="1" fill="rgba(255,255,255,0.07)"/>`;
    }

    // Sold bar (green)
    if (soldH > 0) {
      svg += `<rect x="${soldX.toFixed(1)}" y="${(bot-soldH).toFixed(1)}" width="${soldW}" height="${soldH.toFixed(1)}" fill="#4caf8c" opacity="0.85" rx="3"/>`;
    } else {
      svg += `<rect x="${soldX.toFixed(1)}" y="${(bot-1).toFixed(1)}" width="${soldW}" height="1" fill="rgba(255,255,255,0.06)"/>`;
    }

    // Month label
    svg += `<text x="${cx.toFixed(1)}" y="${(H-7).toFixed(1)}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.40)" font-family="system-ui,sans-serif">${m.short}</text>`;
  });

  return `<div class="bdg-chart-wrap card">
    <div class="bdg-chart-legend">
      <span class="bdg-legend-item"><span class="bdg-legend-dot" style="background:#e8b634"></span>Packs</span>
      <span class="bdg-legend-item"><span class="bdg-legend-dot" style="background:#8a6ee0"></span>Singles</span>
      <span class="bdg-legend-item"><span class="bdg-legend-dot" style="background:#4caf8c"></span>Sold</span>
      <span class="bdg-legend-item"><span class="bdg-legend-dash"></span>Monthly target</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">${svg}</svg>
  </div>`;
}

function _budgetMonthNetHTML(md, target, budgetOn) {
  const gross = (md.packs || 0) + (md.singles || 0);
  const net   = gross - (md.sold || 0);
  if (!gross && !md.sold) return '<span class="bdg-net-empty">No entries yet</span>';
  const under = budgetOn ? net <= target : true;
  const diff  = budgetOn ? target - net : null;
  return `
    <div class="bdg-net-breakdown">
      ${_gbp(md.packs)} packs
      <span class="bdg-sep">+</span>
      ${_gbp(md.singles)} singles
      <span class="bdg-sep">−</span>
      <span class="bdg-sold">${_gbp(md.sold || 0)} sold</span>
      <span class="bdg-sep">=</span>
      <strong class="${under ? 'bdg-under' : 'bdg-over'}">${_gbp(net)} net</strong>
    </div>
    ${diff !== null ? `<span class="bdg-diff ${diff >= 0 ? 'bdg-diff-ok' : 'bdg-diff-over'}">${diff >= 0 ? _gbp(diff) + ' under budget' : _gbp(-diff) + ' over budget'}</span>` : ''}
  `;
}

function _budgetMonthPct(net, effTarget) {
  if (effTarget > 0) return Math.min(100, (net / effTarget) * 100);
  return net > 0 ? 100 : 0; // £0 effective target: any spend maxes the bar
}

function _budgetMonthHTML(data, m, effInfo) {
  const { target: effTarget, rollover } = effInfo || { target: data.target || 0, rollover: 0 };
  const budgetOn = (data.target || 0) > 0;
  const md      = _budgetMonth(data, m.key);
  const gross   = (md.packs || 0) + (md.singles || 0);
  const net     = gross - (md.sold || 0);
  const under   = !budgetOn || net <= effTarget;
  const pct     = _budgetMonthPct(net, effTarget);
  const fillCls = pct >= 100 ? 'bdg-fill-over' : pct >= 80 ? 'bdg-fill-warn' : 'bdg-fill-ok';
  const hasData = gross > 0 || md.sold > 0;

  return `
    <div class="bdg-month card" data-month-card="${m.key}">
      <div class="bdg-month-hd">
        <span class="bdg-month-name">${m.label}</span>
        ${hasData ? `<span class="bdg-status ${under ? 'bdg-status-ok' : 'bdg-status-over'}">${under ? '✓ Under' : '✗ Over'}</span>` : '<span class="bdg-status bdg-status-none">—</span>'}
      </div>
      <div class="bdg-rollover-info${rollover < 0 ? ' bdg-rollover-neg' : ''}" data-rollover-row="${m.key}"${rollover !== 0 ? '' : ' style="display:none"'}>${_bdgRolloverText(rollover, effTarget)}</div>

      ${budgetOn ? `
      <div class="bdg-progress-wrap">
        <div class="bdg-progress-track">
          <div class="bdg-progress-fill ${fillCls}" style="width:${pct}%"></div>
        </div>
        <span class="bdg-progress-lbl">${_gbp(net)} / ${_gbp(effTarget)}</span>
      </div>` : ''}

      <div class="bdg-fields">
        <div class="bdg-field">
          <label class="bdg-field-lbl">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="1" y="3" width="22" height="18" rx="2.5"/><path d="M1 9h22"/></svg>
            Ripped Packs
          </label>
          <div class="bdg-amount">
            <span class="bdg-cur">£</span>
            <input type="number" class="bdg-inp" data-month="${m.key}" data-field="packs"
              value="${md.packs || ''}" placeholder="0" min="0" inputmode="decimal">
          </div>
        </div>
        <div class="bdg-field">
          <label class="bdg-field-lbl">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            Bought Singles
          </label>
          <div class="bdg-amount">
            <span class="bdg-cur">£</span>
            <input type="number" class="bdg-inp" data-month="${m.key}" data-field="singles"
              value="${md.singles || ''}" placeholder="0" min="0" inputmode="decimal">
          </div>
        </div>
        <div class="bdg-field bdg-field-sold">
          <label class="bdg-field-lbl bdg-lbl-sold">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            Sold
          </label>
          <div class="bdg-amount">
            <span class="bdg-cur bdg-cur-sold">−£</span>
            <input type="number" class="bdg-inp bdg-inp-sold" data-month="${m.key}" data-field="sold"
              value="${md.sold || ''}" placeholder="0" min="0" inputmode="decimal">
          </div>
        </div>
      </div>

      <div class="bdg-net-row" data-net-row="${m.key}">
        ${_budgetMonthNetHTML(md, effTarget, budgetOn)}
      </div>
    </div>
  `;
}

function _budgetAnalyticsHTML(data) {
  let totalPacks = 0, totalSingles = 0, totalSold = 0;
  BUDGET_MONTHS.forEach(m => {
    const md = _budgetMonth(data, m.key);
    totalPacks   += md.packs   || 0;
    totalSingles += md.singles || 0;
    totalSold    += md.sold    || 0;
  });
  const gross       = totalPacks + totalSingles;
  const net         = gross - totalSold;
  const target      = data.target || 0;
  const totalTarget = target * BUDGET_MONTHS.length;
  const remaining   = totalTarget - net;
  const effs = _computeEffectiveTargets(data);
  const budgetOn = target > 0;
  const monthsOver  = BUDGET_MONTHS.filter(m => {
    const md = _budgetMonth(data, m.key);
    const mn = (md.packs || 0) + (md.singles || 0) - (md.sold || 0);
    return budgetOn && mn > effs[m.key].target;
  }).length;

  return `
    <div class="bdg-analytics">
      <div class="bdg-stat">
        <div class="bdg-stat-val">${_gbp(gross)}</div>
        <div class="bdg-stat-lbl">Gross spend</div>
      </div>
      <div class="bdg-stat">
        <div class="bdg-stat-val bdg-green">−${_gbp(totalSold)}</div>
        <div class="bdg-stat-lbl">Sold</div>
      </div>
      <div class="bdg-stat">
        <div class="bdg-stat-val ${net > totalTarget ? 'bdg-red' : ''}">${_gbp(net)}</div>
        <div class="bdg-stat-lbl">Net spend</div>
      </div>
      <div class="bdg-stat">
        <div class="bdg-stat-val ${remaining >= 0 ? 'bdg-green' : 'bdg-red'}">${remaining >= 0 ? _gbp(remaining) : '−'+_gbp(-remaining)}</div>
        <div class="bdg-stat-lbl">${remaining >= 0 ? 'Remaining' : 'Over target'}</div>
      </div>
    </div>
    ${monthsOver > 0 ? `<p class="bdg-months-over">${monthsOver} month${monthsOver > 1 ? 's' : ''} over budget</p>` : ''}
  `;
}

let _bdgData = null;

function renderBudgetPage() {
  const el = document.getElementById('pageBudget');
  if (!el) return;

  _bdgData = _loadBudget();

  el.innerHTML = `
    <div class="app bdg-page">
      <div class="bdg-page-hd">
        <div class="bdg-page-title">2026 Pokémon Budget</div>
        <div class="bdg-page-sub">August – December · Strategic spend tracker</div>
      </div>

      <div class="bdg-target-card card">
        <div class="bdg-target-label">Monthly target</div>
        <div class="bdg-target-row">
          <span class="bdg-target-cur">£</span>
          <input type="number" id="bdgTargetInput" class="bdg-target-inp"
            value="${_bdgData.target || ''}" placeholder="250" min="0" step="10" inputmode="decimal">
          <span class="bdg-target-hint">per month</span>
        </div>
        <div class="bdg-target-total">Total target: ${_gbp((_bdgData.target || 0) * 5)} across Aug–Dec</div>
      </div>

      <div id="bdgChartContainer">${_budgetChartHTML(_bdgData)}</div>

      <div id="bdgAnalyticsWrap">${_budgetAnalyticsHTML(_bdgData)}</div>

      <div class="bdg-months-list" id="bdgMonthsList">
        ${(() => { const e = _computeEffectiveTargets(_bdgData); return BUDGET_MONTHS.map(m => _budgetMonthHTML(_bdgData, m, e[m.key])).join(''); })()}
      </div>
    </div>
  `;

  // Wire target input
  el.querySelector('#bdgTargetInput')?.addEventListener('input', function() {
    _bdgData.target = parseFloat(this.value) || 0;
    _saveBudget(_bdgData);
    el.querySelector('.bdg-target-total').textContent =
      'Total target: ' + _gbp((_bdgData.target || 0) * 5) + ' across Aug–Dec';
    _bdgRefreshAll(el);
  });

  // Wire month field inputs (event delegation on the list)
  el.querySelector('#bdgMonthsList')?.addEventListener('input', function(e) {
    const inp = e.target.closest('.bdg-inp');
    if (!inp) return;
    const { month, field } = inp.dataset;
    if (!month || !field) return;
    if (!_bdgData.months[month]) _bdgData.months[month] = { packs: 0, singles: 0, sold: 0 };
    _bdgData.months[month][field] = parseFloat(inp.value) || 0;
    _saveBudget(_bdgData);
    _bdgRefreshAll(el);
  });
}

function _bdgRefreshMonth(el, key, effInfo) {
  const { target: effTarget, rollover } = effInfo || { target: _bdgData.target || 0, rollover: 0 };
  const budgetOn = (_bdgData.target || 0) > 0;
  const md      = _budgetMonth(_bdgData, key);
  const gross   = (md.packs || 0) + (md.singles || 0);
  const net     = gross - (md.sold || 0);
  const under   = !budgetOn || net <= effTarget;
  const pct     = _budgetMonthPct(net, effTarget);
  const hasData = gross > 0 || md.sold > 0;
  const card    = el.querySelector(`[data-month-card="${key}"]`);
  if (!card) return;

  // Rollover indicator
  const rolloverRow = card.querySelector(`[data-rollover-row="${key}"]`);
  if (rolloverRow) {
    if (rollover !== 0) {
      rolloverRow.textContent = _bdgRolloverText(rollover, effTarget);
      rolloverRow.classList.toggle('bdg-rollover-neg', rollover < 0);
      rolloverRow.style.display = '';
    } else {
      rolloverRow.style.display = 'none';
    }
  }

  // Net row
  const netRow = card.querySelector(`[data-net-row="${key}"]`);
  if (netRow) netRow.innerHTML = _budgetMonthNetHTML(md, effTarget, budgetOn);

  // Status badge
  const status = card.querySelector('.bdg-status');
  if (status) {
    status.className = `bdg-status ${hasData ? (under ? 'bdg-status-ok' : 'bdg-status-over') : 'bdg-status-none'}`;
    status.textContent = hasData ? (under ? '✓ Under' : '✗ Over') : '—';
  }

  // Progress bar
  const fill = card.querySelector('.bdg-progress-fill');
  if (fill) {
    fill.style.width = pct + '%';
    fill.className = `bdg-progress-fill ${pct >= 100 ? 'bdg-fill-over' : pct >= 80 ? 'bdg-fill-warn' : 'bdg-fill-ok'}`;
  }
  const lbl = card.querySelector('.bdg-progress-lbl');
  if (lbl) lbl.textContent = _gbp(net) + ' / ' + _gbp(effTarget);
}

function _bdgRefreshAll(el) {
  const effs = _computeEffectiveTargets(_bdgData);
  BUDGET_MONTHS.forEach(m => _bdgRefreshMonth(el, m.key, effs[m.key]));
  const aw = el.querySelector('#bdgAnalyticsWrap');
  if (aw) aw.innerHTML = _budgetAnalyticsHTML(_bdgData);
  const cc = el.querySelector('#bdgChartContainer');
  if (cc) cc.innerHTML = _budgetChartHTML(_bdgData);
}

// ═══════════════════════════════════════════════════════════════════════════
// VINTAGE — WOTC-era (1999–2003) PSA-first collecting
// Browse the old sets in the database, read each card's PSA price ladder and
// find the grade that offers the best solution: gem chase, value sweet spot,
// or a budget slab that guarantees authenticity.
// ═══════════════════════════════════════════════════════════════════════════

const VINTAGE_KEY = 'pkm-vintage-v1';
const VINTAGE_CUTOFF = '2003/07';       // everything before EX Ruby & Sapphire
const VINTAGE_GRADES = [10, 9, 8, 7, 6, 5];

let _vgSelectedSet = 'base1';
let _vgSelectedSetJP = 'neo1';
let _vgLang = 'en';
let _vgSort = 'num';

function _vintageSets() {
  if (typeof setsData === 'undefined' || !setsData) return [];
  return Object.entries(setsData)
    .filter(([, s]) => (s.releaseDate || '9999') < VINTAGE_CUTOFF)
    .sort((a, b) => (a[1].releaseDate || '').localeCompare(b[1].releaseDate || ''))
    .map(([code, s]) => ({ code, name: s.name, releaseDate: s.releaseDate || '', total: s.total || 0 }));
}

// JP vintage sets listed in release order with approximate JP release dates.
// Names are derived at runtime from the first card found for each set code.
const VINTAGE_JP_SET_ORDER = [
  { code: 'neo1',  date: '2000/04' },
  { code: 'VS1',   date: '2000/11' },
  { code: 'neo2',  date: '2001/03' },
  { code: 'neo3',  date: '2001/07' },
  { code: 'web1',  date: '2001/08' },
  { code: 'E1',    date: '2001/12' },
  { code: 'E2',    date: '2002/03' },
  { code: 'neo4',  date: '2002/04' },
  { code: 'E3',    date: '2002/06' },
  { code: 'M1S',   date: '2002/07' },
  { code: 'E4',    date: '2002/09' },
  { code: 'E5',    date: '2002/12' },
  { code: 'M3',    date: '2003/03' },
  { code: 'PCG1',  date: '2003/09' },
  { code: 'PCG2',  date: '2003/11' },
];

function _vintageJPSets() {
  if (!searchIndex || !searchIndex.length) return [];
  const firstCard = new Map();
  for (const c of searchIndex) {
    if (c.lang === 'JP' && !firstCard.has(c.sc)) firstCard.set(c.sc, c);
  }
  return VINTAGE_JP_SET_ORDER
    .filter(({ code }) => firstCard.has(code))
    .map(({ code, date }) => ({ code, name: firstCard.get(code).s || code, releaseDate: date, total: 0 }));
}

function _vgLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(VINTAGE_KEY) || '{}');
    if (!d.targets) d.targets = {};
    return d;
  } catch { return { targets: {} }; }
}
function _vgSave(d) { localStorage.setItem(VINTAGE_KEY, JSON.stringify(d)); }

function _vgSetCards(setCode) {
  if (!searchIndex || !searchIndex.length) return [];
  const wantJP = _vgLang === 'jp';
  return searchIndex.filter(c => c.sc === setCode && (wantJP ? c.lang === 'JP' : c.lang !== 'JP'));
}

// PSA price ladder for one card, in GBP. Sources in preference order:
// live PriceCharting per-grade data (cached) → static DB PSA 10 → ratio
// estimate from the raw price (~9× raw for a 10, flagged as estimated).
function _vgLadder(card) {
  const pd = getCachedPrice(card.i) || getLastKnownPrice(card.i);
  const rawUSD  = pd ? (pd.pcUngraded || pd.market || pd.mid || card.p || 0) : (card.p || 0);
  const pc10    = pd?.pcPsa10 > 0 ? pd.pcPsa10 : 0;
  const base10  = pc10 || card.p10 || 0;
  const est10   = base10 > 0 ? base10 : rawUSD * 9;
  const liveByG = { 9: pd?.pcPsa9 || pd?.pcGrade9 || 0, 8: pd?.pcPsa8 || 0, 7: pd?.pcPsa7 || 0 };
  // WOTC cards rarely have gem rate data — assume low-moderate (8%) so ratio estimates
  // are more conservative: PSA 9 ~30% of 10, PSA 8 ~16% (rather than 35%/18%).
  const vgCard = card.g != null ? card : { ...card, g: 0.08 };
  const ladder = VINTAGE_GRADES.map(g => {
    let usd, src;
    if (g === 10) {
      usd = est10; src = pc10 ? 'pc' : (card.p10 ? 'db' : 'est');
    } else if (liveByG[g] > 0) {
      usd = liveByG[g]; src = 'pc';
    } else {
      usd = est10 * _gemRateGradeRatio(vgCard, g); src = 'est';
    }
    return { g, gbp: usdToGbp(usd || 0), src };
  });
  // Enforce monotonicity: estimated grades must not exceed the grade above them.
  // Mixed live/estimated data can otherwise produce inversions (e.g. PSA 8 est > PSA 9 live).
  for (let i = 1; i < ladder.length; i++) {
    const upper = ladder[i - 1];
    const lower = ladder[i];
    if (lower.src !== 'pc' && upper.gbp > 0 && lower.gbp > upper.gbp * 0.92) {
      lower.gbp = upper.gbp * 0.85;
    }
  }
  return { rawGBP: usdToGbp(rawUSD || 0), ladder, hasLive: !!pd };
}

// The "best solution" picks. Sweet spot = the grade sitting just below the
// steepest price jump in the ladder — the most eye appeal the market gives
// you before it starts charging gem money. Authenticity pick = the cheapest
// slabbed grade: real, graded, and holds the childhood slot for the least £.
function _vgIsGoldStar(card) {
  const r = (card.r || '').toLowerCase();
  const n = card.n || '';
  return r.includes('holo star') || n.endsWith(' ★') || n.toLowerCase().includes('gold star');
}

// Picks the grade tiers for label display.
// Collector range: 7–8 for regular vintage (all legitimately desirable unlike modern);
// extended to include 6 for Gold Stars where scarcity beats condition.
function _vgPicks(ladder, card) {
  let sweet = 9, biggest = 0;
  for (let i = ladder.length - 1; i > 0; i--) {
    const lower = ladder[i], upper = ladder[i - 1];
    if (lower.gbp > 0 && upper.gbp > 0) {
      const jump = upper.gbp / lower.gbp;
      if (jump >= biggest) { biggest = jump; sweet = lower.g; }
    }
  }
  const budget = ladder[ladder.length - 1].g;
  const isGS = card && _vgIsGoldStar(card);
  const collectorBase = isGS ? [8, 7, 6] : [8, 7];
  const collector = new Set(collectorBase.filter(g => g !== sweet && g !== budget && g !== 10));
  return { gem: 10, sweet, budget, collector };
}

function _vgGradeGBP(card, grade) {
  const { ladder } = _vgLadder(card);
  return ladder.find(l => l.g === grade)?.gbp || 0;
}

function _vgLadderHTML(card) {
  const { rawGBP, ladder, hasLive } = _vgLadder(card);
  const isGS = _vgIsGoldStar(card);
  const picks = _vgPicks(ladder, card);
  const data = _vgLoad();
  const target = data.targets[card.i];
  const srcBadge = s => s === 'pc' ? '<span class="vg-src vg-src-pc" title="PriceCharting recent sales">PC</span>'
    : s === 'db' ? '' : '<span class="vg-src vg-src-est" title="Estimated from raw price via grade ratios">~est</span>';
  const rows = ladder.map(({ g, gbp, src }) => {
    const tags = [];
    if (g === picks.gem)          tags.push('<span class="vg-tag vg-tag-gem">Gem</span>');
    if (g === picks.sweet)        tags.push('<span class="vg-tag vg-tag-sweet">Sweet spot</span>');
    if (picks.collector.has(g))   tags.push('<span class="vg-tag vg-tag-collector">Collector grade</span>');
    if (g === picks.budget)       tags.push('<span class="vg-tag vg-tag-budget">Authenticity pick</span>');
    const isTarget = target && target.grade === g;
    return `<div class="vg-ladder-row ${isTarget ? 'vg-ladder-target' : ''}">
      <span class="vg-ladder-grade">PSA ${g}</span>
      <span class="vg-ladder-price">${gbp > 0 ? fmtGBPDirect(gbp) : '—'}${srcBadge(src)}</span>
      <span class="vg-ladder-tags">${tags.join('')}</span>
      <button class="vg-target-btn ${isTarget ? 'vg-target-on' : ''}" data-vg-target="${esc(card.i)}" data-grade="${g}">${isTarget ? '★ Target' : 'Target'}</button>
    </div>`;
  }).join('');
  const rawRow = `<div class="vg-ladder-row vg-ladder-raw">
    <span class="vg-ladder-grade">Raw</span>
    <span class="vg-ladder-price">${rawGBP > 0 ? fmtGBPDirect(rawGBP) : '—'}</span>
    <span class="vg-ladder-tags"><span class="vg-tag vg-tag-raw">Ungraded ref</span></span>
    <span></span>
  </div>`;
  const liveNote = hasLive
    ? ''
    : `<div class="vg-ladder-note">Static estimates — <button class="vg-fetch-btn" data-vg-fetch="${esc(card.i)}">fetch live prices</button> for real sold data</div>`;
  const vintageCtx = `<div class="vg-vintage-ctx">${
    isGS
      ? 'Gold Star — scarcity drives value more than condition. PSA 6+ trades actively; lower grades still attract serious collectors.'
      : 'Unlike modern, PSA 7–8 retain genuine collector demand for vintage. PSA 10 is genuinely rare — most serious collections hold PSA 7–9.'
  }</div>`;
  return vintageCtx + rawRow + rows + liveNote;
}

function _vgCardRowHTML(card, data) {
  const target = data.targets[card.i];
  const cached = getCachedPrice(card.i) || getLastKnownPrice(card.i);
  const rawUSD = cached ? (cached.pcUngraded || cached.market || cached.mid || card.p || 0) : (card.p || 0);
  const rawGBP = usdToGbp(rawUSD || 0);
  const targetBadge = target
    ? `<span class="vg-row-target ${target.owned ? 'vg-row-owned' : ''}">${target.owned ? '✓' : '★'} PSA ${target.grade}</span>`
    : '';
  return `<details class="vg-card" data-vg-card="${esc(card.i)}">
    <summary class="vg-card-summary">
      <img class="vg-card-img" src="${esc(getCardImg(card) || '')}" alt="" loading="lazy" onerror="this.style.opacity='0'">
      <span class="vg-card-num">${card.cn ? '#' + esc(String(card.cn)) : ''}</span>
      <span class="vg-card-name">${esc(card.n)}</span>
      <span class="vg-card-meta">${esc(card.r || '')}</span>
      ${_vgIsGoldStar(card) ? '<span class="vg-gs-badge">★ Gold Star</span>' : ''}
      ${targetBadge}
      <span class="vg-card-raw">${rawGBP > 0 ? fmtGBPDirect(rawGBP) : '—'}</span>
      <button class="vg-open-btn" data-vg-open="${esc(card.i)}" title="Open in Predict">↗</button>
    </summary>
    <div class="vg-ladder" data-vg-ladder="${esc(card.i)}"></div>
  </details>`;
}

function _vgTargetsHTML(data) {
  const entries = Object.entries(data.targets);
  if (!entries.length) return '';
  let totalGBP = 0, ownedCount = 0, ownedGBP = 0;
  const rows = entries.map(([id, t]) => {
    const card = getCardById(id);
    if (!card) return '';
    const gbp = _vgGradeGBP(card, t.grade);
    if (t.owned) { ownedCount++; ownedGBP += gbp; } else totalGBP += gbp;
    const gradeOpts = VINTAGE_GRADES.map(g =>
      `<option value="${g}" ${g === t.grade ? 'selected' : ''}>PSA ${g}</option>`).join('');
    return `<div class="vg-tgt-row ${t.owned ? 'vg-tgt-owned' : ''}" data-id="${esc(id)}">
      <img class="vg-tgt-img" src="${esc(getCardImg(card) || '')}" alt="" loading="lazy" onerror="this.style.opacity='0'">
      <div class="vg-tgt-info">
        <span class="vg-tgt-name">${esc(card.n)}</span>
        <span class="vg-tgt-set">${esc(card.s)}${card.cn ? ' · #' + esc(String(card.cn)) : ''}</span>
      </div>
      <select class="vg-tgt-grade" data-vg-grade="${esc(id)}">${gradeOpts}</select>
      <span class="vg-tgt-price">${gbp > 0 ? fmtGBPDirect(gbp) : '—'}</span>
      <button class="vg-tgt-own" data-vg-own="${esc(id)}">${t.owned ? 'Got it' : 'Need it'}</button>
      <button class="vg-tgt-rm" data-vg-rm="${esc(id)}" title="Remove">✕</button>
    </div>`;
  }).join('');
  return `<div class="vg-targets card">
    <div class="vg-targets-hd">
      <span class="vg-targets-title">My Vintage Targets</span>
      <span class="vg-targets-meta">${entries.length} card${entries.length !== 1 ? 's' : ''} · ${ownedCount} owned${totalGBP > 0 ? ` · est ${fmtGBPDirect(totalGBP)} to complete` : ''}${ownedGBP > 0 ? ` · ${fmtGBPDirect(ownedGBP)} secured` : ''}</span>
    </div>
    <div class="vg-targets-list">${rows}</div>
  </div>`;
}

function renderVintagePage() {
  const el = document.getElementById('pageVintage');
  if (!el) return;
  const isJP = _vgLang === 'jp';
  const sets = isJP ? _vintageJPSets() : _vintageSets();
  // Deep links can land here before the async card DB decode finishes —
  // show a loading state and retry while the page is still visible.
  if (!sets.length || !searchIndex || !searchIndex.length) {
    el.innerHTML = '<div class="app"><p style="padding:40px;text-align:center;color:var(--text-muted)">Loading card database…</p></div>';
    setTimeout(() => { if (el.style.display !== 'none') renderVintagePage(); }, 400);
    return;
  }
  const selectedSet = isJP ? _vgSelectedSetJP : _vgSelectedSet;
  if (!sets.some(s => s.code === selectedSet)) {
    if (isJP) _vgSelectedSetJP = sets[0].code; else _vgSelectedSet = sets[0].code;
  }
  const activeSet = isJP ? _vgSelectedSetJP : _vgSelectedSet;

  const data = _vgLoad();
  const targetsBySet = {};
  for (const [id, t] of Object.entries(data.targets)) {
    const c = getCardById(id);
    if (c) {
      const cIsJP = c.lang === 'JP';
      if (cIsJP !== isJP) continue;
      if (!targetsBySet[c.sc]) targetsBySet[c.sc] = { total: 0, owned: 0 };
      targetsBySet[c.sc].total++;
      if (t.owned) targetsBySet[c.sc].owned++;
    }
  }

  const chips = sets.map(s => {
    const year = s.releaseDate.slice(0, 4);
    const tg = targetsBySet[s.code];
    const prog = tg ? `<span class="vg-chip-prog">${tg.owned}/${tg.total}</span>` : '';
    return `<button class="vg-set-chip ${s.code === activeSet ? 'vg-chip-active' : ''}" data-vg-set="${esc(s.code)}">
      <span class="vg-chip-name">${esc(s.name)}</span>
      <span class="vg-chip-year">${year}</span>${prog}
    </button>`;
  }).join('');

  let cards = _vgSetCards(activeSet);
  if (_vgSort === 'price' && !isJP) cards = [...cards].sort((a, b) => (b.p || 0) - (a.p || 0));
  else if (_vgSort === 'name')      cards = [...cards].sort((a, b) => a.n.localeCompare(b.n));
  else cards = [...cards].sort((a, b) => (parseInt(a.cn) || 9999) - (parseInt(b.cn) || 9999) || a.n.localeCompare(b.n));

  const setInfo = sets.find(s => s.code === activeSet);
  const rows = cards.map(c => _vgCardRowHTML(c, data)).join('');
  const subLine = isJP
    ? 'Japanese WOTC-era sets · 2000 – 2003 · tap a card for its grade ladder'
    : 'WOTC era 1999 – 2003 · PSA-first collecting · tap a card for its grade ladder';
  const jpNote = isJP
    ? '<div class="vg-jp-note">No price data in the DB for JP vintage. Expand a card and fetch live prices for estimates.</div>'
    : '';

  el.innerHTML = `
    <div class="app vg-page">
      <div class="vg-page-hd">
        <div class="vg-page-hd-top">
          <div class="vg-page-title">Vintage</div>
          <div class="vg-lang-toggle">
            <button class="vg-lang-btn ${!isJP ? 'vg-lang-active' : ''}" data-vg-lang="en">EN</button>
            <button class="vg-lang-btn ${isJP ? 'vg-lang-active' : ''}" data-vg-lang="jp">JP</button>
          </div>
        </div>
        <div class="vg-page-sub">${subLine}</div>
      </div>
      ${jpNote}
      ${_vgTargetsHTML(data)}
      <div class="vg-set-chips">${chips}</div>
      <div class="vg-set-bar">
        <span class="vg-set-title">${esc(setInfo?.name || '')} <span class="vg-set-count">${cards.length} cards</span></span>
        <select id="vgSortSel" class="binder-sort-sel">
          <option value="num" ${_vgSort === 'num' ? 'selected' : ''}>Set number</option>
          ${!isJP ? `<option value="price" ${_vgSort === 'price' ? 'selected' : ''}>Price high–low</option>` : ''}
          <option value="name" ${_vgSort === 'name' ? 'selected' : ''}>A–Z</option>
        </select>
      </div>
      <div class="vg-card-list" id="vgCardList">${rows || '<p class="vg-empty">No cards in the database for this set.</p>'}</div>
    </div>`;

  _vgWire(el);
}

async function _vgFetchPrices(cardId, el) {
  const card = getCardById(cardId);
  if (!card) return;
  const ladderEl = el.querySelector(`[data-vg-ladder="${CSS.escape(cardId)}"]`);
  if (ladderEl) ladderEl.innerHTML = '<div class="vg-ladder-note">Fetching live sold prices…</div>';
  try {
    const fresh = await fetchFreshPriceData(card);
    if (fresh) setCachedPrice(card.i, fresh);
  } catch (e) {}
  if (ladderEl) ladderEl.innerHTML = _vgLadderHTML(card);
}

function _vgWire(el) {
  if (el._vgWired) return;
  el._vgWired = true;

  el.addEventListener('click', e => {
    // EN/JP language toggle
    const langBtn = e.target.closest('[data-vg-lang]');
    if (langBtn) { _vgLang = langBtn.dataset.vgLang; renderVintagePage(); return; }

    // Set chip
    const chip = e.target.closest('[data-vg-set]');
    if (chip) {
      if (_vgLang === 'jp') _vgSelectedSetJP = chip.dataset.vgSet;
      else _vgSelectedSet = chip.dataset.vgSet;
      renderVintagePage(); return;
    }

    // Open in Predict
    const openBtn = e.target.closest('[data-vg-open]');
    if (openBtn) {
      e.preventDefault(); e.stopPropagation();
      const id = openBtn.dataset.vgOpen;
      go('predict');
      setTimeout(() => { try { selectCard(id); } catch (err) {} }, 80);
      return;
    }

    // Fetch live prices for one card
    const fetchBtn = e.target.closest('[data-vg-fetch]');
    if (fetchBtn) { e.preventDefault(); _vgFetchPrices(fetchBtn.dataset.vgFetch, el); return; }

    // Target a grade from the ladder
    const tgtBtn = e.target.closest('[data-vg-target]');
    if (tgtBtn) {
      e.preventDefault();
      const id = tgtBtn.dataset.vgTarget, grade = parseInt(tgtBtn.dataset.grade);
      const data = _vgLoad();
      const cur = data.targets[id];
      if (cur && cur.grade === grade) delete data.targets[id];      // toggle off
      else data.targets[id] = { grade, owned: cur?.owned || false };
      _vgSave(data);
      _vgRefresh(el, id);
      return;
    }

    // Targets panel: owned toggle / remove
    const ownBtn = e.target.closest('[data-vg-own]');
    if (ownBtn) {
      const data = _vgLoad();
      const t = data.targets[ownBtn.dataset.vgOwn];
      if (t) { t.owned = !t.owned; _vgSave(data); _vgRefresh(el, ownBtn.dataset.vgOwn); }
      return;
    }
    const rmBtn = e.target.closest('[data-vg-rm]');
    if (rmBtn) {
      const data = _vgLoad();
      delete data.targets[rmBtn.dataset.vgRm];
      _vgSave(data);
      _vgRefresh(el, rmBtn.dataset.vgRm);
      return;
    }
  });

  el.addEventListener('change', e => {
    if (e.target.id === 'vgSortSel') { _vgSort = e.target.value; renderVintagePage(); return; }
    const gradeSel = e.target.closest('[data-vg-grade]');
    if (gradeSel) {
      const data = _vgLoad();
      const t = data.targets[gradeSel.dataset.vgGrade];
      if (t) { t.grade = parseInt(gradeSel.value); _vgSave(data); _vgRefresh(el, gradeSel.dataset.vgGrade); }
    }
  });

  // Lazily render (and once cached, live-populate) the ladder on expand
  el.addEventListener('toggle', e => {
    const det = e.target.closest?.('.vg-card');
    if (!det || !det.open) return;
    const id = det.dataset.vgCard;
    const card = getCardById(id);
    const ladderEl = det.querySelector('.vg-ladder');
    if (card && ladderEl) ladderEl.innerHTML = _vgLadderHTML(card);
  }, true);
}

// Re-render while preserving open ladders and scroll position.
function _vgRefresh(el, changedId) {
  const openIds = Array.from(el.querySelectorAll('.vg-card[open]')).map(d => d.dataset.vgCard);
  const y = window.scrollY;
  renderVintagePage();
  for (const id of openIds) {
    const det = el.querySelector(`[data-vg-card="${CSS.escape(id)}"]`);
    if (det) {
      det.open = true;
      const card = getCardById(id);
      const ladderEl = det.querySelector('.vg-ladder');
      if (card && ladderEl) ladderEl.innerHTML = _vgLadderHTML(card);
    }
  }
  window.scrollTo(0, y);
}
