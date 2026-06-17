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
const WEIGHTS = { char: 0.45, art: 0.45, appeal: 0.10 };

// ---- Pokémon Popularity Tiers ----
const CHAR_TIERS = {
  S: { score: 9.5, names: ['charizard','pikachu','mewtwo','umbreon','mew','eevee'] },
  A: { score: 8.2, names: ['dragonite','gyarados','gengar','lugia','rayquaza','gardevoir','lucario','greninja','sylveon','magikarp','espeon','vaporeon','leafeon','flareon','jolteon','glaceon','meowth','snorlax','blastoise','venusaur'] },
  B: { score: 6.5, names: ['arcanine','ninetales','alakazam','machamp','lapras','tyranitar','celebi','suicune','entei','raikou','ho-oh','latios','latias','deoxys','dialga','palkia','giratina','darkrai','arceus','reshiram','zekrom','kyurem','xerneas','yveltal','zygarde','lunala','solgaleo','necrozma','zacian','zamazenta','calyrex','miraidon','koraidon','terapagos'] },
};

const APPEAL_TIERS = {
  S: { score: 9.5, names: ['charizard','pikachu','mewtwo','eevee','mew'] },
  A: { score: 7.5, names: ['gengar','umbreon','snorlax','gyarados','dragonite','gardevoir','lucario','greninja','blastoise','venusaur','magikarp','sylveon','arcanine'] },
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

  // 3. Pack cost — sets-db value (treated as USD), otherwise era-based GBP default → USD
  if (set?.packCost > 0) {
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
const RARITY_RATES = {
  SIR: { base: 0.22, label: 'Special Illustration Rare' },
  SAR: { base: 0.20, label: 'Special Art Rare' },
  UR: { base: 0.18, label: 'Ultra Rare' },
  HR: { base: 0.16, label: 'Hyper Rare' },
  SR: { base: 0.14, label: 'Secret Rare' },
  RR: { base: 0.12, label: 'Double Rare' },
  IR: { base: 0.15, label: 'Illustration Rare' },
  AR: { base: 0.13, label: 'Art Rare' },
  CSR: { base: 0.17, label: 'Character SR' },
  CHR: { base: 0.11, label: 'Character Rare' },
  '': { base: 0.08, label: 'Standard' },
};

// ---- Global State ----
let cardData = null;
let setsData = null;
let fxRate = 0.79;
let selectedCard = null;
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
  // EN cards: pokemontcg.io format — {setCode}-{num} -> /images/{setCode}/{num}.png
  // If there's no setCode (user-added cards), the constructed URL would be
  // broken (`/images/pokemontcg.io//003.png`). Show the placeholder instead.
  if (!card.sc) return CARD_PLACEHOLDER_IMG;
  return `https://images.pokemontcg.io/${card.sc}/${card.cn || card.ns || ''}.png`;
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
const PRICE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const PRICE_CACHE_KEY = 'pkm-live-prices-v4'; // v4: PriceCharting primary for ALL cards

function getPriceCache() {
  try {
    return JSON.parse(localStorage.getItem(PRICE_CACHE_KEY) || '{}');
  } catch { return {}; }
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
}

function getCachedPrice(cardId) {
  const cache = getPriceCache();
  const entry = cache[cardId];
  if (!entry) return null;
  if (Date.now() - (entry._ts || 0) > PRICE_CACHE_TTL) return null;
  return entry;
}

// ---- Live Price State ----
let livePrice = null; // Current card's live pricing data
let livePriceFetchId = 0;

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
      const fxR = await fetch('https://open.er-api.com/v6/latest/USD').then(r => r.json());
      if (fxR.rates?.GBP) fxRate = fxR.rates.GBP;
    } catch (e) { /* use default */ }

    if (cardData) {
      if (loadingText) loadingText.textContent = 'Building search index...';
      buildSearchIndex(cardData.cards);
      buildCounterpartIndex(cardData.cards);
    }

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
  setupPriceInsight();
  setupAiChat();
  setupTheme();
  setupPageNav();
  setupUnderrated();
  setupPWANav();
  setupCollapsibleSections();
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
}

// ---- Currency ----
function usdToGbp(usd) { return usd * fxRate; }
function fmtGBP(usd) { return `£${usdToGbp(usd).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
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
    // PriceCharting is always primary
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

// ---- Auto-fill Desirability ----
function autoFillDesirability(card, pullCost) {
  const charScore = getCharacterScore(card.n);
  const appealScore = getAppealScore(card.n);

  // Art/Hype: base from rarity + card type
  let artScore = getArtBaseScore(card.rc, card.n);

  // Price-premium adjustment: if card trades above/below expected for its rarity, adjust art
  const price = getCurrentPrice(card);
  const expected = EXPECTED_PRICE_BY_RARITY[card.rc] || 2;
  if (price > 0 && expected > 0) {
    const ratio = price / expected;
    if (ratio > 5)       artScore = Math.min(10, artScore + 2.0);
    else if (ratio > 3)  artScore = Math.min(10, artScore + 1.5);
    else if (ratio > 2)  artScore = Math.min(10, artScore + 1.0);
    else if (ratio > 1.5) artScore = Math.min(10, artScore + 0.5);
    else if (ratio < 0.2) artScore = Math.max(1, artScore - 1.5);
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
function buildSearchIndex(cards) {
  searchIndex = cards.map(c => ({
    ...c,
    _search: `${c.n} ${c.nj || ''} ${c.s} ${c.cn || ''} ${c.ns || ''} ${c.r || ''} ${c.sr || ''} ${c.lang || ''}`
      .replace(/\s+/g, ' ')
      .toLowerCase(),
  }));
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
    const other = cardData.cards.find(c => c.i === overrideId);
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

  let verdict, reason;
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

  return {
    other, otherLang: cp.counterpartLang,
    selfUSD, otherUSD, selfGBP, otherGBP,
    cheaper, cheaperLang, pricier, savingsPct, savingsGBP,
    verdict, reason,
    totalCounterparts: cp.counterparts.length,
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
    badge.textContent = 'Get the JP';
    headline.innerHTML = `<strong>Japanese version is the value pick</strong>`;
  } else if (rec.verdict === 'buy-en') {
    badge.textContent = 'Get the EN';
    headline.innerHTML = `<strong>English version is cheaper here</strong>`;
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
    document.getElementById('comparePanel').style.display = 'block';
    document.getElementById('comparePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  let matches = searchIndex.filter(c => c._search.includes(query));

  const numSlashMatch = query.match(/^#?(\d+)\/(\d+)$/);
  if (numSlashMatch) {
    const [, num, total] = numSlashMatch;
    matches.sort((a, b) => {
      const aExact = (String(a.cn) === num && String(a.ct) === total) ? 2 : String(a.cn) === num ? 1 : 0;
      const bExact = (String(b.cn) === num && String(b.ct) === total) ? 2 : String(b.cn) === num ? 1 : 0;
      return bExact - aExact;
    });
  } else if (/^\d+$/.test(query) || /^#\d+/.test(query)) {
    const num = query.replace('#', '');
    matches.sort((a, b) => {
      const aExact = String(a.cn) === num ? 1 : 0;
      const bExact = String(b.cn) === num ? 1 : 0;
      return bExact - aExact;
    });
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
      ${`<img class="search-result-img" src="${getCardImg(c)}" alt="" loading="lazy" onerror="this.style.display='none'">`}
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
  });
  results.classList.add('open');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

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

  const errors = [];
  for (const p of chain) {
    try {
      const r = await fetchWithTimeout(p.fn(pcUrl));
      if (!r.ok) { errors.push(`${p.name} ${r.status}`); continue; }
      const data = await p.parse(r);
      if (data && Array.isArray(data.products)) {
        if (p.name !== cached) setCachedPcProxy(p.name);
        return data.products;
      }
      errors.push(`${p.name} no-products`);
    } catch (e) {
      errors.push(`${p.name} ${e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'err'}`);
    }
  }
  // All proxies failed — forget the cached winner so next attempt re-walks the chain.
  clearCachedPcProxy();
  const err = new Error('All proxies failed: ' + errors.join('; '));
  err.allProxiesFailed = true;
  throw err;
}

function productToPC(p) {
  if (!p) return null;
  return {
    pcUngraded: parsePCPrice(p.price1),
    pcPsa10: parsePCPrice(p.price2),
    pcGrade9: parsePCPrice(p.price3),
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
  if (override && override.id) {
    // The override carries the full product blob from when the user picked it.
    // We still re-fetch by ID via search so prices stay fresh.
    try {
      const products = await pcSearchRaw(override.productName || override.id);
      const exact = products.find(p => String(p.id) === String(override.id));
      if (exact) {
        return { ...productToPC(exact), pcMatchConfidence: 'override' };
      }
    } catch {}
    // If re-fetch fails, return the cached override blob unchanged
    return {
      pcUngraded: parsePCPrice(override.price1),
      pcPsa10: parsePCPrice(override.price2),
      pcGrade9: parsePCPrice(override.price3),
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
  return productToPC(best);
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
    // Still fetch fresh in background to update cache
    fetchAndCacheFresh(card, thisId);
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
async function fetchFreshPriceData(card) {
  let priceData = {
    source: 'pricecharting',
    market: 0, low: 0, mid: 0, high: 0, directLow: 0,
    tcgUpdated: '', tcgUrl: '',
    cmTrend: 0, cmAvg1: 0, cmAvg7: 0, cmAvg30: 0, cmLow: 0, cmSuggested: 0,
    cmUpdated: '', cmUrl: '', cmLang: card.lang || 'EN',
    pcUngraded: 0, pcPsa10: 0, pcGrade9: 0, pcName: '', pcConsole: '', pcId: '',
    crRaw: 0, crPsa10: 0, crGemRate: 0, crName: '', crUrl: '', crPsa10VsRaw: 0,
  };

  // 1. PriceCharting — primary source for ALL cards
  try {
    const pc = await fetchPriceChartingData(card);
    if (pc && pc.pcUngraded > 0) {
      Object.assign(priceData, pc);
      priceData.source = 'pricecharting';
      priceData.market = pc.pcUngraded;
      priceData.mid = pc.pcUngraded;
    }
  } catch (e) {
    console.warn('PriceCharting fetch failed:', e);
  }

  // 2. For EN cards, also fetch TCGPlayer/Cardmarket as secondary data
  if (card.lang !== 'JP') {
    try {
      const enData = await fetchLivePriceEN(card.i);
      if (enData) {
        // Merge TCGPlayer + Cardmarket data as secondary
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
        // Store TCGPlayer values for display but NOT as primary price
        priceData.tcgMarket = enData.market;
        priceData.tcgLow = enData.low;
        priceData.tcgMid = enData.mid;
        priceData.tcgHigh = enData.high;
        priceData.directLow = enData.directLow;
        // If PriceCharting failed, fall back to TCGPlayer as primary
        if (priceData.pcUngraded <= 0 && enData.market > 0) {
          priceData.source = 'pokemontcg.io';
          priceData.market = enData.market;
          priceData.low = enData.low;
          priceData.mid = enData.mid;
          priceData.high = enData.high;
        }
      }
    } catch (e) {
      console.warn('TCGPlayer secondary fetch failed:', e);
      // If PriceCharting also failed, this is a total failure
      if (priceData.pcUngraded <= 0) throw e;
    }
  } else if (priceData.pcUngraded <= 0) {
    // JP card with no PriceCharting data — throw to show fallback
    throw new Error('No pricing data available');
  }

  // 3. Collectrics — additional grading data source for all cards
  try {
    const cr = await fetchCollectricsSearchData(card);
    if (cr) Object.assign(priceData, cr);
  } catch (e) {
    // Silent — Collectrics is supplementary
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
  const loading = $('livePriceLoading');
  const content = $('livePriceContent');
  const status = $('livePriceStatus');

  loading.style.display = 'none';
  status.style.display = 'none';
  content.style.display = 'block';

  const hasMarket = data.market > 0;
  const hasCM = data.cmTrend > 0 || data.cmAvg7 > 0;
  const hasPC = data.pcUngraded > 0;

  // Primary live price — PriceCharting is always primary when available
  const primaryPrice = (data.pcUngraded > 0)
    ? data.pcUngraded
    : (data.market || data.mid || data.cmTrend || data.cmAvg7 || 0);
  $('liveMainPrice').textContent = primaryPrice > 0 ? fmtGBP(primaryPrice) : '—';
  $('liveMainUSD').textContent = primaryPrice > 0 ? fmtUSD(primaryPrice) : '';

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
    $('tcgLow').textContent = tl > 0 ? fmtGBP(tl) : '—';
    $('tcgMid').textContent = tmd > 0 ? fmtGBP(tmd) : '—';
    $('tcgHigh').textContent = th > 0 ? fmtGBP(th) : '—';
    const updatedEl = $('tcgUpdated');
    if (data.tcgUpdated) {
      const d = new Date(data.tcgUpdated);
      updatedEl.textContent = `Updated ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    } else {
      updatedEl.textContent = '';
    }
    // TCGPlayer link
    const tcgLink = $('tcgPlayerLink');
    if (data.tcgUrl) {
      tcgLink.href = data.tcgUrl;
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

  // Cache timestamp
  const cacheTs = $('livePriceCache');
  if (data._ts) {
    const ago = Math.round((Date.now() - data._ts) / 60000);
    cacheTs.textContent = ago < 1 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago/60)}h ago`;
    cacheTs.style.display = '';
  } else {
    cacheTs.textContent = 'just now';
    cacheTs.style.display = '';
  }
}

// Recalculate model with live price
function recalcWithLivePrice(card) {
  if (!card || !livePrice) return;
  // Pick best live price — PriceCharting is always primary
  const lp = (livePrice.pcUngraded > 0)
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
  }

  // Refresh EN ↔ JP recommendation with live price data
  renderCounterpartFlag(card);

  // Re-render Acquisition section so ROI uses the live raw + PSA 10 prices
  if (typeof renderAcquisition === 'function') renderAcquisition();
}

// ================================================================
// ---- Card Selection ----
// ================================================================
function selectCard(id) {
  if (!cardData) return;
  const card = cardData.cards.find(c => c.i === id);
  if (!card) return;
  selectedCard = card;

  // Refresh Price Sync stats so "Refresh selected card" button enables
  if (typeof psUpdateStats === 'function') psUpdateStats();
  // Refresh Acquisition section for the new card
  if (typeof renderAcquisition === 'function') renderAcquisition();

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
    $('cardImageJp').src = getCardImg(card);
    $('cardImageJp').style.display = 'block';
    $('cardImageJp').title = 'Click to view full resolution';
    $('cardImageJp').style.cursor = 'zoom-in';
    $('cardImageJp').onclick = () => openImageLightbox(getCardImg(card), card.n + ' (Japanese)');
    $('cardImage').style.display = 'none';
  } else {
    $('cardImage').src = getCardImg(card);
    $('cardImage').style.display = 'block';
    $('cardImage').title = 'Click to view full resolution';
    $('cardImage').style.cursor = 'zoom-in';
    $('cardImage').onclick = () => openImageLightbox(getCardImg(card), card.n);
    loadJapaneseImage(card);
  }
  const _heroBg = $('cardHeroBg');
  if (_heroBg) _heroBg.src = getCardImg(card);

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
    $('autoPullCost').textContent = '—';
    $('autoPullPacks').textContent = 'No pull rate data for this set';
  }

  // Auto-fill desirability from static price initially
  const des = autoFillDesirability(card, pullCost);
  $('characterPremium').value = des.char;
  $('artworkHype').value = des.art;
  $('universalAppeal').value = des.appeal;

  updateAll();

  $('forecastSection').style.display = 'block';
  renderForecast(card, pullCost, des.total);
  updateRipOrBuy(card, pullCost);
  updateSignal(card, pullCost, des.total);
  updatePortfolioButton();
  updateWishlistButton();
  updateCompareButton();
  renderCounterpartFlag(card);
  renderPsaGradeRange(card, pullCost, des.total);
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
  if (ageMonths < 6) { score -= 1; reasons.push('New set — price may drop'); }
  else if (ageMonths > 48) { score += 1; reasons.push('Vintage scarcity premium'); }

  let signal, cls;
  if (score >= 3) { signal = 'STRONG BUY'; cls = 'signal-strong-buy'; }
  else if (score >= 1) { signal = 'BUY'; cls = 'signal-buy'; }
  else if (score <= -2) { signal = 'SELL'; cls = 'signal-sell'; }
  else { signal = 'HOLD'; cls = 'signal-hold'; }

  return { signal, cls, reasons: reasons.slice(0, 3), score };
}

function updateSignal(card, pullCost, desirability) {
  const wrap = $('signalWrap');
  const result = computeSignal(card, pullCost, desirability);
  if (!result) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'flex';
  $('signalBadge').textContent = result.signal;
  $('signalBadge').className = `signal-badge ${result.cls}`;
  $('signalReason').textContent = result.reasons.join(' · ');
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
      priceUSD: currentPriceUSD * Math.pow(1 + adjRate * 1.6, y),
      rate: adjRate * 1.6,
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

  const rateLabel = (RARITY_RATES[card.rc] || RARITY_RATES['']).label;
  const charMult = fc.charMult;
  const annualPct = (fc.scenarios.expected[0].rate * 100).toFixed(1);
  const momLabel = fc.momentum?.label || '';
  const priceSource = livePrice ? 'Live price' : 'Static price';
  $('forecastInfo').innerHTML = `
    <span>${rateLabel} base rate</span> ·
    <span>${charMult > 1 ? charMult.toFixed(1) + '× character premium' : 'Standard character'}</span> ·
    <span>${annualPct}% expected annual growth</span>
    ${momLabel ? `· <span style="color:${fc.momentum.mult > 1 ? 'var(--green)' : fc.momentum.mult < 1 ? 'var(--red)' : 'var(--text-muted)'}">${momLabel}</span>` : ''}
    · <span style="color:var(--text-faint);font-size:11px">${priceSource}</span>
  `;

  drawForecastChart(canvas, fc);
}

function drawForecastChart(canvas, fc) {
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

  const { priceUSD, sf, df } = predictPrice(pullCost, des);
  const priceGBP = usdToGbp(priceUSD);
  $('predictedPriceGBP').textContent = `£${Math.round(priceGBP).toLocaleString()}`;
  $('predictedPriceUSD').textContent = `≈ ${fmtUSD(priceUSD)}`;
  $('supplyFactor').textContent = `×${sf.toFixed(2)}`;
  $('demandFactor').textContent = `×${df.toFixed(2)}`;

  updateMaxPrice(priceUSD);
  updateDealCheck(priceUSD);

  if (selectedCard) {
    renderForecast(selectedCard, pullCost, des);
    updateRipOrBuy(selectedCard, pullCost);
    updateSignal(selectedCard, pullCost, des);
  }
}

function updateMaxPrice(modelPriceUSD) {
  let maxUSD, logic;
  if (selectedCard) {
    const mkt = getCurrentPrice(selectedCard);
    const isLive = livePrice && (livePrice.market > 0 || livePrice.mid > 0);
    const priceTag = isLive ? 'Live market' : 'Market';
    maxUSD = Math.min(modelPriceUSD, mkt);
    if (modelPriceUSD < mkt) logic = `Model says ${fmtGBP(modelPriceUSD)} — card appears overvalued vs ${priceTag.toLowerCase()} (${fmtGBP(mkt)})`;
    else if (modelPriceUSD > mkt * 1.1) logic = `${priceTag} price (${fmtGBP(mkt)}) — model sees upside to ${fmtGBP(modelPriceUSD)}`;
    else logic = `${priceTag} (${fmtGBP(mkt)}) and model (${fmtGBP(modelPriceUSD)}) agree — fairly valued`;
  } else {
    maxUSD = modelPriceUSD;
    logic = 'Based on model only. Select a card for market comparison.';
  }
  $('maxPriceGBP').textContent = `£${usdToGbp(maxUSD).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $('maxPriceLogic').textContent = logic;
}

function updateDealCheck(modelPriceUSD) {
  const ebayGBP = parseFloat($('ebayPrice').value);
  if (!ebayGBP || ebayGBP <= 0) {
    $('dealResult').innerHTML = '<div class="deal-placeholder">Enter an eBay price to check</div>';
    $('dealResult').className = 'deal-result';
    return;
  }
  const refUSD = selectedCard ? Math.min(modelPriceUSD, getCurrentPrice(selectedCard)) : modelPriceUSD;
  const refGBP = usdToGbp(refUSD);
  const diff = refGBP - ebayGBP;
  const pct = ((diff / ebayGBP) * 100).toFixed(0);

  let cls, verdict, note;
  if (diff > refGBP * 0.05) {
    cls = 'good-deal'; verdict = 'Good Deal';
    note = `${Math.abs(pct)}% below max buy price of ${fmtGBP(refUSD)}`;
  } else if (diff < -refGBP * 0.05) {
    cls = 'bad-deal'; verdict = 'Too Expensive';
    note = `${Math.abs(pct)}% above max buy price of ${fmtGBP(refUSD)}`;
  } else {
    cls = 'ok-deal'; verdict = 'Fair Price';
    note = `Within 5% of max buy price (${fmtGBP(refUSD)})`;
  }

  $('dealResult').className = `deal-result ${cls}`;
  $('dealResult').innerHTML = `<div class="deal-active">
    <div class="deal-verdict">${verdict}</div>
    <div class="deal-saving">${diff > 0 ? 'Save' : 'Over by'} £${Math.abs(diff).toFixed(2)}</div>
    <div class="deal-note">${note}</div>
  </div>`;

  const saveBtn = $('dealSaveHold');
  if (saveBtn) {
    if (selectedCard && selectedCard.i) {
      saveBtn.style.display = 'block';
      saveBtn.onclick = () => {
        const gradeKey = $('dealGrade') ? $('dealGrade').value : 'raw';
        setHoldOverride(selectedCard.i, gradeKey, ebayGBP);
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
  const usingFallbackCost = !(set?.packCost > 0);
  const sourceLabel = usingFallbackRate || usingFallbackCost
    ? 'Estimated from rarity & set era'
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
  const gemRate = card.g ? (card.g * 100).toFixed(1) : null;
  const gradingFee = 20;

  const valueGain = psa10Price - rawPrice;
  const roi = ((valueGain - gradingFee) / (rawPrice + gradingFee)) * 100;
  const netProfit = valueGain - gradingFee;
  const multiplier = psa10Price / rawPrice;

  let evGrade = null, evNote = '';
  if (gemRate !== null) {
    const gemPct = card.g;
    evGrade = (gemPct * (psa10Price - gradingFee)) + ((1 - gemPct) * (rawPrice * 0.85 - gradingFee));
    const evRoi = ((evGrade - rawPrice) / rawPrice * 100).toFixed(0);
    evNote = `Expected value: ${fmtGBP(evGrade)} (${evRoi > 0 ? '+' : ''}${evRoi}% ROI at ${gemRate}% gem rate)`;
  }

  let verdictClass, verdictTitle, verdictDetail;
  if (roi > 100 && (gemRate === null || card.g > 0.3)) {
    verdictClass = 'grade-worth';
    verdictTitle = 'Worth Grading';
    verdictDetail = `${multiplier.toFixed(1)}× raw-to-PSA 10 multiplier with ${netProfit > 0 ? fmtGBP(netProfit) : ''} potential profit`;
  } else if (roi > 30) {
    verdictClass = 'grade-maybe';
    verdictTitle = 'Consider Grading';
    verdictDetail = gemRate ? `${gemRate}% gem rate — profitable if it hits PSA 10` : `${multiplier.toFixed(1)}× multiplier but check gem rate first`;
  } else {
    verdictClass = 'grade-skip';
    verdictTitle = 'Skip Grading';
    verdictDetail = `Only ${multiplier.toFixed(1)}× multiplier — not enough margin after fees`;
  }

  $('gradeContent').innerHTML = `
    <div class="grade-row"><span class="grade-label">Raw Price</span><span class="grade-val">${fmtGBP(rawPrice)}</span></div>
    <div class="grade-row"><span class="grade-label">PSA 10 Price</span><span class="grade-val grade-gain">${fmtGBP(psa10Price)}</span></div>
    <div class="grade-row"><span class="grade-label">Value Gain</span><span class="grade-val grade-gain">+${fmtGBP(valueGain)} (${multiplier.toFixed(1)}×)</span></div>
    <div class="grade-row"><span class="grade-label">Grading Fee (~$20)</span><span class="grade-val grade-loss">-${fmtGBP(gradingFee)}</span></div>
    <div class="grade-row"><span class="grade-label">Net Profit (if PSA 10)</span><span class="grade-val ${netProfit > 0 ? 'grade-gain' : 'grade-loss'}">${netProfit > 0 ? '+' : ''}${fmtGBP(netProfit)}</span></div>
    ${gemRate !== null ? `<div class="grade-row"><span class="grade-label">Gem Rate</span><span class="grade-val">${gemRate}%</span></div>` : ''}
    ${evNote ? `<div class="grade-row"><span class="grade-label">Expected Value</span><span class="grade-val">${fmtGBP(evGrade)}</span></div>` : ''}
    <div class="grade-verdict ${verdictClass}">
      <div class="grade-verdict-title">${verdictTitle}</div>
      <div class="grade-verdict-detail">${verdictDetail}</div>
    </div>
  `;
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
  renderPortfolio();
}

function togglePortfolio() {
  const panel = $('portfolioPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function toggleCardInPortfolio() {
  if (!selectedCard) return;
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
  savePortfolio();
  renderPortfolio();
  updatePortfolioButton();
}

function updatePortfolioButton() {
  const btn = $('addPortfolioBtn');
  if (!selectedCard) return;
  const inPortfolio = portfolio.some(p => p.id === selectedCard.i);
  btn.classList.toggle('in-portfolio', inPortfolio);
  btn.title = inPortfolio ? 'Remove from collection' : 'Add to collection';
}

function savePortfolio() {
  localStorage.setItem('pkm-portfolio', JSON.stringify(portfolio));
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
    const currentCard = cardData ? cardData.cards.find(c => c.i === p.id) : null;
    // Try cached live price first
    const cached = getCachedPrice(p.id);
    const currentPrice = cached ? (cached.market || cached.mid || (currentCard ? currentCard.p : p.price)) : (currentCard ? currentCard.p : p.price);
    const currentGBP = usdToGbp(currentPrice);
    const isLive = !!cached;
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
      signal = computeSignal(currentCard, pullCost, des.total);
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
          ${p.img ? `<img class="portfolio-item-img" src="${p.img}" alt="" onerror="this.style.display='none'">` : '<div class="portfolio-item-img"></div>'}
          <div class="portfolio-item-info">
            <div class="portfolio-item-name">${esc(p.name)} ${acqBadge}</div>
            <div class="portfolio-item-meta">${esc(p.set)}${change !== null ? ` · <span style="color:${parseFloat(change) >= 0 ? 'var(--green)' : 'var(--red)'}"> ${parseFloat(change) >= 0 ? '+' : ''}${change}%</span>` : ''}${isLive ? ' · <span class="live-dot-inline" title="Live price"></span>' : ''}</div>
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

  list.querySelectorAll('.portfolio-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.portfolio-item-remove')) return;
      if (e.target.closest('.pi-toggle')) return;
      selectCard(el.dataset.id);
    });
  });
  piWireToggles(list);
  list.querySelectorAll('.portfolio-item-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      portfolio = portfolio.filter(p => p.id !== btn.dataset.id);
      savePortfolio();
      renderPortfolio();
      updatePortfolioButton();
    });
  });
}

// =============================================================
// Wishlist (cards you want to buy at a target price)
// =============================================================
let wishlist = JSON.parse(localStorage.getItem('pkm-wishlist') || '[]');

function setupWishlist() {
  $('wishlistToggle').addEventListener('click', () => toggleSidePanel('wishlistPanel'));
  $('wishlistClose').addEventListener('click', () => { $('wishlistPanel').style.display = 'none'; });
  $('addWishlistBtn').addEventListener('click', toggleCardInWishlist);
  renderWishlist();
}

function toggleSidePanel(id) {
  // Close the others when one opens
  ['portfolioPanel', 'wishlistPanel', 'comparePanel', 'alertsPanel'].forEach(p => {
    const el = document.getElementById(p);
    if (!el) return;
    if (p === id) {
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    } else {
      el.style.display = 'none';
    }
  });
}

function toggleCardInWishlist() {
  if (!selectedCard) return;
  const idx = wishlist.findIndex(w => w.id === selectedCard.i);
  if (idx >= 0) {
    wishlist.splice(idx, 1);
  } else {
    const currentUSD = getCurrentPrice(selectedCard);
    const currentGBP = usdToGbp(currentUSD);
    // Default target: 15% below current price
    const targetGBP = +(currentGBP * 0.85).toFixed(2);
    wishlist.push({
      id: selectedCard.i,
      name: selectedCard.n,
      set: selectedCard.s,
      lang: selectedCard.lang || 'EN',
      img: getCardImg(selectedCard),
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
    const currentCard = cardData ? cardData.cards.find(c => c.i === w.id) : null;
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
          ${w.img ? `<img class="wishlist-item-img" src="${w.img}" alt="" onerror="this.style.display='none'">` : '<div class="wishlist-item-img"></div>'}
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

  list.querySelectorAll('.wishlist-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.wishlist-remove') || e.target.closest('.wishlist-target-input')) return;
      if (e.target.closest('.pi-toggle')) return;
      selectCard(el.dataset.id);
    });
  });
  piWireToggles(list);
  list.querySelectorAll('.wishlist-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      wishlist = wishlist.filter(w => w.id !== btn.dataset.id);
      saveWishlist();
      renderWishlist();
      updateWishlistButton();
    });
  });
  list.querySelectorAll('.wishlist-target-input').forEach(input => {
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', e => {
      const id = e.target.dataset.id;
      const w = wishlist.find(x => x.id === id);
      if (w) {
        w.targetGBP = +parseFloat(e.target.value || '0').toFixed(2);
        saveWishlist();
        renderWishlist();
      }
    });
  });
}

// =============================================================
// Compare (English vs Japanese, or any two cards)
// =============================================================
let compareSlots = JSON.parse(localStorage.getItem('pkm-compare') || '[null, null]');
if (!Array.isArray(compareSlots) || compareSlots.length !== 2) compareSlots = [null, null];

function setupCompare() {
  $('compareToggle').addEventListener('click', () => toggleSidePanel('comparePanel'));
  $('compareClose').addEventListener('click', () => { $('comparePanel').style.display = 'none'; });
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
  if (compareSlots[0] && compareSlots[1]) {
    $('comparePanel').style.display = 'block';
  }
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
        ${slot.img ? `<img class="compare-card-img" src="${slot.img}" alt="" onerror="this.style.display='none'">` : '<div class="compare-card-img"></div>'}
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
  ['packRate','cardsInTier','characterPremium','artworkHype','universalAppeal','ebayPrice']
    .forEach(id => $(id).addEventListener('input', updateAll));
  const dealGradeEl = $('dealGrade');
  if (dealGradeEl) dealGradeEl.addEventListener('change', updateAll);
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
        <img class="vp-img" src="${getCardImg(c)}" alt="" loading="lazy" onerror="this.style.display='none'">
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
  const cur = livePrice && livePrice.pcName
    ? `Currently using: <strong>${escapeHtml(livePrice.pcName)}</strong> (${escapeHtml(livePrice.pcConsole || '')})`
    : 'No PriceCharting match yet for this card.';
  $('pcovCurrent').innerHTML = cur;
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
    $('pcovStatus').textContent = `${products.length} match${products.length === 1 ? '' : 'es'} — click “Use this match” on the right one`;
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
  // Persist the full product blob so we can re-render even when offline
  setPCOverride(pcovCard.i, {
    id: product.id,
    productName: product.productName,
    consoleName: product.consoleName,
    price1: product.price1,
    price2: product.price2,
    price3: product.price3,
    imageUri: product.imageUri,
  });
  // Bust the live-price cache for this card so the override is picked up immediately
  try {
    const cache = getPriceCache();
    delete cache[pcovCard.i];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  closePCOverride();
  // Re-fetch with the override applied
  if (selectedCard && selectedCard.i === pcovCard.i) {
    fetchLivePrice(selectedCard);
  }
}

function clearPCOverride() {
  if (!pcovCard) return;
  setPCOverride(pcovCard.i, null);
  try {
    const cache = getPriceCache();
    delete cache[pcovCard.i];
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  closePCOverride();
  if (selectedCard && selectedCard.i === pcovCard.i) {
    fetchLivePrice(selectedCard);
  }
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
    const o = cardData.cards.find(c => c.i === overrideId);
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
  const isJP = $('maJP').checked;
  $('maStatus').className = 'ql-status';
  $('maStatus').textContent = 'Searching TCG Collector…';
  $('maResults').innerHTML = '';
  const btn = $('maSearchBtn'); btn.disabled = true;
  try {
    const md = await fetchTCGCollectorMarkdown(q);
    let rows = parseTCGCollectorMarkdown(md);
    if (isJP) {
      rows = rows.filter(r => /japan/i.test(r.setName) || /\b(jp|japanese)\b/i.test(r.setName));
    }
    if (!rows.length) {
      $('maStatus').className = 'ql-status error';
      $('maStatus').textContent = isJP
        ? 'No Japanese matches on TCG Collector. Try unchecking Japanese, or rephrase.'
        : 'No cards on TCG Collector for that query. Try just the Pokémon name + number.';
      return;
    }
    $('maStatus').className = 'ql-status success';
    $('maStatus').textContent = `Found ${rows.length} card${rows.length === 1 ? '' : 's'}. Pick the right one.`;
    $('maResults').innerHTML = rows.map(renderManualAddCard).join('');
    $('maResults').querySelectorAll('.ma-add-btn').forEach(b => {
      b.addEventListener('click', () => addManualCardFromTCGC(JSON.parse(b.dataset.card), isJP));
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
  const img = r.imgUrl ? `<img class="ma-thumb" src="${escapeHtml(r.imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
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
  if (cardData.cards.find(c => c.i === id)) {
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
        status.textContent = 'Couldn’t find card art on that page — paste a different link or a direct image URL.';
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
      status.textContent = `Couldn’t reach TCG Collector. ${e.message || ''}`;
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
    status.textContent = 'Couldn’t resolve that link to an image. Card was saved without artwork.';
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
  if (cardData.cards.find(c => c.i === id)) {
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
    ? `Editing <code>${escapeHtml(orig.n)}</code> — <strong>currently overridden</strong>. Saved on this device only.`
    : `Editing <code>${escapeHtml(c.n)}</code>. Changes are saved on this device only.`;
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
    status.textContent = 'Name, set and card number can’t be empty.';
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

// Compute estimated price for a single PSA grade.
function estimateGradePrice(card, grade, psa10Price) {
  if (!psa10Price || psa10Price <= 0) return 0;
  return psa10Price * (PSA_RATIOS[grade] || 0);
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

// Render the PSA 1-10 grade range table on the selected card.
function renderPsaGradeRange(card, pullCost, desirability) {
  const section = $('psaRangeSection');
  if (!section || !card) return;
  // Need a PSA 10 anchor price (static p10 or PriceCharting PSA 10) to derive grades.
  const anchor = getPsa10Anchor(card);
  const psa10Price = anchor.usd;
  if (!psa10Price || psa10Price <= 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
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
  const rows = grades.map(g => {
    const todayUSD = estimateGradePrice(card, g, psa10Price);
    const yr1USD = projectGradePrice(card, g, todayUSD, 1);
    const yr3USD = projectGradePrice(card, g, todayUSD, 3);
    const yr5USD = projectGradePrice(card, g, todayUSD, 5);
    const roi5 = todayUSD > 0 ? ((yr5USD - todayUSD) / todayUSD) * 100 : 0;
    // Verdict: compare 5yr value to today's entry + small assumed friction
    // (5% buy/sell fees). For ungraded raw we also subtract the £20 grading fee.
    let verdict, verdictClass;
    if (roi5 >= 80) { verdict = 'Strong pick'; verdictClass = 'psa-v-strong'; }
    else if (roi5 >= 40) { verdict = 'Worth a look'; verdictClass = 'psa-v-good'; }
    else if (roi5 >= 15) { verdict = 'Fair'; verdictClass = 'psa-v-fair'; }
    else { verdict = 'Skip'; verdictClass = 'psa-v-skip'; }
    return { g, todayUSD, yr1USD, yr3USD, yr5USD, roi5, verdict, verdictClass };
  });

  const tbody = $('psaRangeTable').querySelector('tbody');
  // Cell highlighting: emphasise PSA 10 row + the grade with highest 5yr ROI.
  const bestRoiIdx = rows.reduce((bestI, r, i, arr) => r.roi5 > arr[bestI].roi5 ? i : bestI, 0);
  tbody.innerHTML = rows.map((r, i) => {
    const isBest = i === bestRoiIdx;
    const isPsa10 = r.g === 10;
    const roiSign = r.roi5 >= 0 ? '+' : '';
    return `<tr class="${isPsa10 ? 'psa-row-10' : ''} ${isBest ? 'psa-row-best' : ''}">
      <td class="psa-g">PSA ${r.g}${isBest ? ' <span class="psa-best-pill">Best ROI</span>' : ''}</td>
      <td class="psa-money">${fmtGBP(r.todayUSD)}</td>
      <td class="psa-money">${fmtGBP(r.yr1USD)}</td>
      <td class="psa-money">${fmtGBP(r.yr3USD)}</td>
      <td class="psa-money psa-yr5">${fmtGBP(r.yr5USD)}</td>
      <td class="psa-roi ${r.roi5 >= 0 ? 'psa-roi-pos' : 'psa-roi-neg'}">${roiSign}${r.roi5.toFixed(0)}%</td>
      <td><span class="psa-verdict ${r.verdictClass}">${r.verdict}</span></td>
    </tr>`;
  }).join('');

  const rateLabel = (RARITY_RATES[card.rc] || RARITY_RATES['']).label;
  const annualPctAt10 = (((rows[0].yr1USD / rows[0].todayUSD) - 1) * 100).toFixed(1);
  const bestRow = rows[bestRoiIdx];
  const rawPart = (rawPriceUSD && !isNaN(rawPriceUSD) && rawPriceUSD > 0) ? ` · raw ≈ ${fmtGBP(rawPriceUSD)}` : '';
  $('psaRangeFootnote').innerHTML = `
    Anchored on PSA 10 = ${fmtGBP(psa10Price)}${rawPart} · ${rateLabel} base rate ·
    Expected ${annualPctAt10}% annual growth at PSA 10.
    Model suggests <strong>PSA ${bestRow.g}</strong> offers the strongest 5yr ROI (${bestRow.roi5 >= 0 ? '+' : ''}${bestRow.roi5.toFixed(0)}%).
    Ratios are typical-modern; individual cards can deviate ±30%.
  `;
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
let watchlist = [];
try { watchlist = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]'); } catch { watchlist = []; }
// Active alerts the user has dismissed (cardId -> signal they dismissed for).
// If the signal flips back and then to BUY again we re-alert.
let dismissedAlerts = {};
try { dismissedAlerts = JSON.parse(localStorage.getItem(WATCHLIST_ALERT_DISMISS_KEY) || '{}'); } catch { dismissedAlerts = {}; }

function saveWatchlist() { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist)); }
function saveDismissed() { localStorage.setItem(WATCHLIST_ALERT_DISMISS_KEY, JSON.stringify(dismissedAlerts)); }

function isWatched(cardId) { return watchlist.some(w => w.id === cardId); }

function toggleCardInWatchlist() {
  if (!selectedCard) return;
  const id = selectedCard.i;
  const idx = watchlist.findIndex(w => w.id === id);
  if (idx >= 0) {
    watchlist.splice(idx, 1);
    delete dismissedAlerts[id];
    saveDismissed();
  } else {
    const pull = (function () {
      try { return calcPullCost().pullCost; } catch { return 7.65; }
    })();
    const des = autoFillDesirability(selectedCard, pull).total;
    const sig = computeSignal(selectedCard, pull, des);
    watchlist.push({
      id,
      name: selectedCard.n,
      set: selectedCard.s,
      lang: selectedCard.lang || 'EN',
      img: getCardImg(selectedCard),
      addedAt: new Date().toISOString(),
      addedSignal: sig?.signal || 'HOLD',
      addedScore: sig?.score || 0,
      addedPriceUSD: getCurrentPrice(selectedCard),
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
    const card = cardData.cards.find(c => c.i === w.id);
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
  $('watchBtn')?.addEventListener('click', toggleCardInWatchlist);
  $('alertsToggle')?.addEventListener('click', () => {
    toggleSidePanel('alertsPanel');
    if ($('alertsPanel').style.display === 'block') refreshAlerts();
  });
  $('alertsClose')?.addEventListener('click', () => { $('alertsPanel').style.display = 'none'; });
  $('alertsTabActive')?.addEventListener('click', () => switchAlertsTab('active'));
  $('alertsTabWatching')?.addEventListener('click', () => switchAlertsTab('watching'));
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
    list.innerHTML = `<div class="portfolio-empty">Nothing on your watchlist yet. Open a card and tap “Watch this card” to start tracking it. You’ll see a notification here the moment the model flips it to BUY or STRONG BUY.</div>`;
    return;
  }
  const alerts = computeActiveAlerts();
  let shown = alerts;
  if (_alertsTab === 'active') shown = alerts.filter(a => a.triggered && a.dismissedFor !== a.signal);
  if (shown.length === 0) {
    list.innerHTML = _alertsTab === 'active'
      ? `<div class="portfolio-empty">No new alerts. You’re watching ${watchlist.length} card${watchlist.length === 1 ? '' : 's'} — switch to “All watched” to review them.</div>`
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
        ${a.img ? `<img class="alert-item-img" src="${a.img}" alt="" onerror="this.style.display='none'">` : '<div class="alert-item-img"></div>'}
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
  const setName = (card.s || '').replace(/[^a-zA-Z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim();
  const langTerm = (card.lang === 'JP') ? 'japanese' : '';
  const gradeTerm = gradeLabel === 'Raw' ? '' : gradeLabel;
  return [name, setName, langTerm, gradeTerm].filter(Boolean).join(' ');
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
  // Need PSA 10 anchor (same data dependency as PSA range section).
  const pcPsa10 = (typeof livePrice !== 'undefined' && livePrice && livePrice.pcPsa10 > 0) ? livePrice.pcPsa10 : 0;
  const psa10Price = card.p10 > 0 ? card.p10 : pcPsa10;
  if (!psa10Price || psa10Price <= 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

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

  // Sort by descending deal score so the most attractive grades surface first.
  rows.sort((a, b) => b.score - a.score);

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
      ? `<img src="${esc(payload.image)}" alt="" onerror="this.style.display='none'">`
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
    return `
      <button type="button" class="mra-result mra-suggested" data-card-id="${esc(c.i)}">
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
    return `
      <button type="button" class="mra-result" data-card-id="${esc(c.i)}">
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
    const p = _mktReassignPayload;
    const target = _mktReassignPickedCard;
    const grade = _mktReassignPickedGrade || 'raw';
    addReassignment({
      url: p.url, title: p.title, image: p.image, source: p.source,
      condition: p.condition, seller: p.seller, priceGBP: p.priceGBP,
      spreadPct: p.spreadPct, signal: p.signal,
      fromCardId: p.fromCardId, fromGrade: p.fromGrade,
      toCardId: target.i, toGrade: grade,
    });
    closeReassignModal();
    if (typeof selectedCard !== 'undefined' && selectedCard) fetchLiveDeals(selectedCard);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('mraModal') && $('mraModal').style.display !== 'none') closeReassignModal();
  });
  // Event delegation — catch reassign-button clicks even though the parent
  // .mkt-deal is an <a>. We have to prevent both navigation AND bubbling.
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
  else if (/\bv\b/.test(name) && !/\bex\b/.test(name)) out.push(' v ');
  else if (/\bex\b/.test(name)) out.push(' ex');
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
  // Required name + tag tokens
  for (const tok of requiredTokens) {
    if (!t.includes(tok)) return true;
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
  // Min-price floor
  if (typeof deal.priceGBP === 'number' && fairValueGBP > 0) {
    const floor = Math.max(3, fairValueGBP * 0.08);
    if (deal.priceGBP < floor) return true;
  }
  return false;
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
  // Spread sign convention matches the existing UI: positive = below fair.
  const spreadPct = (priceGBP > 0 && fair > 0)
    ? ((fair - priceGBP) / fair) * 100
    : 0;
  const overPct = (priceGBP > 0 && fair > 0 && priceGBP > fair)
    ? ((priceGBP - fair) / fair) * 100
    : 0;

  // Re-derive the existing VALUE / STRONG VALUE / FAIR / PREMIUM signal so
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
function mktRenderDealCard(d, meta) {
  meta = meta || {};
  const sigCls = d.signal === 'STRONG VALUE' ? 'mkt-strong'
               : d.signal === 'VALUE'        ? 'mkt-fair'
               : d.signal === 'PREMIUM'      ? 'mkt-weak' : 'mkt-fair';
  const sourceCls = (d.source || '').includes('UK') ? 'src-uk'
                  : (d.source || '').includes('US') ? 'src-us' : 'src-cm';
  const img = d.image
    ? `<img class="mkt-deal-img" src="${esc(d.image)}" alt="" onerror="this.style.display='none'">`
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
  return `
    <a class="mkt-deal ${meta.claimed ? 'is-claimed' : ''}" href="${esc(d.url)}" target="_blank" rel="noopener">
      ${img}
      <div class="mkt-deal-body">
        <div class="mkt-deal-title">${esc(d.title)}</div>
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
        <div class="mkt-deal-actions">
          <button type="button" class="mkt-deal-reassign" data-payload="${enc}" title="Wrong card? Move this listing" aria-label="Move this listing to a different card">⇄ Move</button>
          <button type="button" class="mkt-deal-dismiss" data-payload="${enc}" title="Not relevant — hide this listing for this card + grade" aria-label="Dismiss this listing">✕ Dismiss</button>
        </div>
      </div>
    </a>
  `;
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
  const url = `${workerUrl}/search?q=${encodeURIComponent(query)}&max=${scanCapGBP.toFixed(2)}&grade=${g.workerGrade}&fx=${fxUsdToGbp}&fxEur=${fxEurToGbp}${cacheBust}`;
  try {
    const t0 = performance.now();
    const res = await fetch(url);
    if (isStale()) return 0;
    if (!res.ok) throw new Error(`Worker ${res.status}`);
    const data = await res.json();
    if (isStale()) return 0;
    const took = Math.round(performance.now() - t0);
    const rawDeals = data.deals || [];
    let deals = rawDeals.filter(d => !mktIsJunk(d, card, required, g.workerGrade, fairValueGBP));
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
    if (status) status.innerHTML = `${totalShown} clean · £${fairValueGBP.toFixed(0)} fair value${overStr} · UK ${c.ebay_uk || 0} · US ${c.ebay_us || 0} · CM ${c.cardmarket || 0} · ${took}ms${filterStr}${errStr}${dismissedPill ? ' · ' + dismissedPill : ''}`;
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

  const pcPsa10 = (typeof livePrice !== 'undefined' && livePrice && livePrice.pcPsa10 > 0) ? livePrice.pcPsa10 : 0;
  const psa10PriceRaw = card.p10 > 0 ? card.p10 : pcPsa10;
  const rawPriceUSD = getCurrentPrice(card);
  // Fallback PSA 10 anchor when the card has no explicit p10 — use raw ×5 as a
  // rough modern-holo proxy. Keeps the live-scan visible on cards the price
  // model can't anchor exactly.
  const psa10Price = psa10PriceRaw > 0 ? psa10PriceRaw : (rawPriceUSD > 0 ? rawPriceUSD * 5 : 0);
  if (psa10Price <= 0 && !(rawPriceUSD > 0)) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  setupMktGradeTabs();
  if (topStatus) topStatus.textContent = `Scanning 5 grades · eBay UK + US + Cardmarket…`;

  const fxUsdToGbp = (typeof fxRate === 'number' ? fxRate : 0.79);
  const fxEurToGbp = 0.86;
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
  _originalRenderMarketplaceScan(card, pullCost, des);
  mktLastScannedCard = card || null;
  if (getMktWorkerUrl()) fetchLiveDeals(card);
  else if ($('mktLiveWrap')) $('mktLiveWrap').style.display = 'none';
};

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
// card once PSA tier fee (~£15 economy), the intermediary fee (~£15), and
// insured round-trip shipping (~£10) are added together. Turnaround is
// typically 6-9 months for the economy tier as of mid-2026.
const UK_GRADING_ALL_IN_GBP = 40;    // PSA fee + intermediary fee + insured shipping (round trip)
const UK_GRADING_WAIT_MONTHS = 9;    // typical UK third-party submission cycle
const OPPORTUNITY_COST_ANNUAL = 0.06; // pre-tax return you could earn elsewhere while capital is locked
const BUY_SELL_FRICTION = 0.10;      // 10% combined buy + sell fees (fair tier midpoint)

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
  const gradingFeeUSD = UK_GRADING_ALL_IN_GBP / fx;
  const waitYears = UK_GRADING_WAIT_MONTHS / 12;
  const waitDiscount = 1 / (1 + OPPORTUNITY_COST_ANNUAL * waitYears);
  const baseGemRate = (typeof card.g === 'number' && card.g > 0) ? card.g : DEFAULT_GEM_RATE;
  const gemRate = baseGemRate * ONLINE_BUY_GEM_PENALTY;

  // Strategy 1 — Buy Raw, hold ungraded
  const rawYr5USD = projectGradePrice(card, 9, rawUSD, 5) / GRADE_GROWTH_PREMIUM[9] * 1.0;
  const rawSell5USD = rawYr5USD * (1 - BUY_SELL_FRICTION);
  const rawProfitUSD = rawSell5USD - rawUSD;
  const rawRoi = rawUSD > 0 ? (rawProfitUSD / rawUSD) * 100 : 0;

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
  const gradeCost = rawUSD + gradingFeeUSD;
  const gradeProfit = gradeSell5EV - gradeCost;
  const gradeRoi = gradeCost > 0 ? (gradeProfit / gradeCost) * 100 : 0;

  // Strategies 3-6 — Buy graded at each tier
  const gradedStrategies = [7, 8, 9, 10].map(g => {
    const today = estimateGradePrice(card, g, psa10Price);
    const yr5 = projectGradePrice(card, g, today, 5);
    const sell = yr5 * (1 - BUY_SELL_FRICTION);
    const profit = sell - today;
    const roi = today > 0 ? (profit / today) * 100 : 0;
    return { label: `Buy PSA ${g}`, key: `psa${g}`, grade: g, today, yr5: sell, profit, roi };
  });

  const strategies = [
    { label: 'Buy Raw',         key: 'raw',    today: rawUSD,    yr5: rawSell5USD, profit: rawProfitUSD, roi: rawRoi,   variance: 0.20 },
    { label: 'Buy Raw + Grade', key: 'gamble', today: gradeCost, yr5: gradeSell5EV, profit: gradeProfit, roi: gradeRoi, variance: 0.85 },
    ...gradedStrategies.map(s => ({
      ...s,
      variance: s.grade === 10 ? 0.15 : s.grade === 9 ? 0.22 : s.grade === 8 ? 0.28 : 0.32,
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

  const positives = strategies.filter(s => s.roi > 0);
  const winner = positives.length
    ? positives.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a)
    : null;
  const rawSide = strategies.filter(s => (s.key === 'raw' || s.key === 'gamble') && s.roi > 0);
  const gradedSide = strategies.filter(s => s.key.startsWith('psa') && s.roi > 0);
  const bestRaw = rawSide.length ? rawSide.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;
  const bestGraded = gradedSide.length ? gradedSide.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;

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
    bestRaw,
    bestGraded,
    winnerOutlayGBP,
    outlayPenalty,
    overallScore: winner ? (winner.riskAdjusted - outlayPenalty) : -Infinity,
    anchorSource: anchor && anchor.source,
    gemRate,
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
      verdictBody = `<strong>${selfLang} and ${otherLang}</strong> score within ${absMargin.toFixed(0)} points on risk-adjusted return after factoring upfront outlay. Pick the language you already have access to — the algorithm doesn’t see a meaningful edge either way.${cheaperLine}`;
    } else {
      const winnerStrat = winCore.winner;
      verdictPill = `Buy ${winLang}`;
      verdictBody = `The <strong>${winLang}</strong> version is the smarter buy on this card — <strong>${winnerStrat.label}</strong> projects +${winnerStrat.roi.toFixed(0)}% ROI vs the ${loseLang} copy’s best play. Risk-adjusted edge after capital outlay: +${absMargin.toFixed(0)} pts.${cheaperLine}`;
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

  // Convert UK all-in grading cost back to USD for internal arithmetic so the
  // rest of the math (which works in USD) stays consistent. fxRate is GBP/USD
  // — so USD = GBP / fxRate.
  const fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
  const gradingFeeUSD = UK_GRADING_ALL_IN_GBP / fx;
  const waitYears = UK_GRADING_WAIT_MONTHS / 12;
  // Opportunity-cost discount applied to the post-grade 5yr value: while the
  // card sits at PSA for ~9 months your capital is locked. We pretend that
  // money could have earned ~6% p.a. elsewhere and discount the eventual
  // value accordingly. Small but it matters for close calls.
  const waitDiscount = 1 / (1 + OPPORTUNITY_COST_ANNUAL * waitYears);
  const baseGemRate = (typeof card.g === 'number' && card.g > 0) ? card.g : DEFAULT_GEM_RATE;
  const gemRateSource = (typeof card.g === 'number' && card.g > 0) ? 'tracked' : 'estimated';
  // Apply the online sight-unseen penalty — default assumption is the user is
  // buying raw online (eBay/TCGplayer), not hand-picking from a binder.
  const gemRate = baseGemRate * ONLINE_BUY_GEM_PENALTY;

  // ----- Strategy 1: Buy Raw, hold ungraded -----
  const rawYr5USD = projectGradePrice(card, 9, rawUSD, 5) / GRADE_GROWTH_PREMIUM[9] * 1.0;
  // ^ Use the same growth machinery, but apply the "raw" growth premium (1.0).
  //   Doing it this way keeps the projection consistent with renderPsaGradeRange.
  const rawSell5USD = rawYr5USD * (1 - BUY_SELL_FRICTION);
  const rawProfitUSD = rawSell5USD - rawUSD;
  const rawRoi = rawUSD > 0 ? (rawProfitUSD / rawUSD) * 100 : 0;

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
  const gradeYr5EVRaw = gemRate * psa10Yr5 + (1 - gemRate) * subgemEV;
  // Apply opportunity-cost discount because your capital is locked for the wait.
  const gradeYr5EV = gradeYr5EVRaw * waitDiscount;
  const gradeSell5EV = gradeYr5EV * (1 - BUY_SELL_FRICTION);
  const gradeCost = rawUSD + gradingFeeUSD;
  const gradeProfit = gradeSell5EV - gradeCost;
  const gradeRoi = gradeCost > 0 ? (gradeProfit / gradeCost) * 100 : 0;

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

  // ----- Strategies 3-6: Buy graded at each tier -----
  const gradedStrategies = [7, 8, 9, 10].map(g => {
    const today = estimateGradePrice(card, g, psa10Price);
    const yr5 = projectGradePrice(card, g, today, 5);
    const sell = yr5 * (1 - BUY_SELL_FRICTION);
    const profit = sell - today;
    const roi = today > 0 ? (profit / today) * 100 : 0;
    return { label: `Buy PSA ${g}`, key: `psa${g}`, grade: g, today, yr5, profit, roi };
  });

  const strategies = [
    { label: 'Buy Raw',          key: 'raw',      desc: 'Hold ungraded for 5 yrs',                today: rawUSD,    yr5: rawSell5USD,   profit: rawProfitUSD, roi: rawRoi,    risk: 'low',    variance: 0.20 },
    { label: 'Buy Raw + Grade',  key: 'gamble',   desc: `EV across PSA outcomes \u2014 ${(goodOutcomeProb*100).toFixed(0)}% chance of PSA 9 or 10`, today: gradeCost, yr5: gradeSell5EV, profit: gradeProfit,  roi: gradeRoi,  risk: 'high',   variance: 0.85, waitMonths: UK_GRADING_WAIT_MONTHS, lossProb, lossEV },
    ...gradedStrategies.map((s, i) => ({
      ...s,
      desc: i === 0 ? 'Graded floor entry' : i === 1 ? 'Mid-grade graded copy' : i === 2 ? 'Near-mint graded copy' : 'Gem mint — best ceiling',
      // Variance falls as grade rises (less subjective re-grade risk).
      risk: s.grade === 10 ? 'low' : s.grade === 9 ? 'med' : 'med',
      variance: s.grade === 10 ? 0.15 : s.grade === 9 ? 0.22 : s.grade === 8 ? 0.28 : 0.32,
    })),
  ];

  // Apply any user-entered eBay market overrides. We override the "today" buy
  // price for the matching strategy row(s) but leave 5yr targets on the model's
  // projection — that way ROI honestly reflects "I paid £X, here's what the
  // model says it'll be worth."
  if (typeof applyHoldOverrides === 'function') applyHoldOverrides(card, strategies, fx, gradingFeeUSD);

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

  // Pick winners. Two separate questions per the user's ask:
  //   1. Raw vs Graded — which broad approach wins? Compare best raw-side
  //      option (Raw, Raw+Grade) vs best already-graded option (PSA 7-10).
  //   2. Which graded tier (PSA 7/8/9/10) is the best long-term hold?
  const positives = strategies.filter(s => s.roi > 0);
  const overallWinner = positives.length
    ? positives.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a)
    : null;

  const rawSide = strategies.filter(s => (s.key === 'raw' || s.key === 'gamble') && s.roi > 0);
  const gradedSide = strategies.filter(s => s.key.startsWith('psa') && s.roi > 0);
  const bestRaw = rawSide.length ? rawSide.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;
  const bestGraded = gradedSide.length ? gradedSide.reduce((a, b) => b.riskAdjusted > a.riskAdjusted ? b : a) : null;

  // The card visually highlighted as the winner is the overall best risk-adjusted
  // option. But the recommendation copy answers BOTH the user's questions in
  // plain English so they don't have to read the table to extract the answer.
  const winner = overallWinner;

  // Build the two-line recommendation: raw-vs-graded verdict + best graded tier.
  const recEl = $('holdRecommendation');
  if (!winner) {
    recEl.innerHTML = `
      <div class="hold-rec-pill hold-rec-skip">Skip this card</div>
      <div class="hold-rec-body">
        No version of this card projects positive 5-year ROI after buy/sell friction and grading fees.
        Park your capital somewhere with a better expected return.
      </div>
    `;
  } else {
    // Raw-vs-graded headline: which side wins outright?
    // We also flag the UK wait + loss case whenever the gamble (Buy Raw + Grade)
    // is the winning raw-side play, because the headline ROI hides the friction.
    let gambleCaveat = '';
    if (bestRaw && bestRaw.key === 'gamble') {
      if (lossProb > 0.01) {
        gambleCaveat = ` Heads-up: this means shipping to a UK third-party (Ludkins / GetGraded), waiting ~${UK_GRADING_WAIT_MONTHS} months with your capital locked, and accepting a <strong>${(lossProb*100).toFixed(0)}% chance of a sub-PSA 9 outcome that loses money (avg −${fmtGBP(Math.abs(gbpFromUSD(lossEV)))})</strong>.`;
      } else {
        gambleCaveat = ` Heads-up: still a ~${UK_GRADING_WAIT_MONTHS}-month UK grading wait with capital locked — every PSA outcome turns a profit on this card, but you forfeit liquidity until the grades come back.`;
      }
    }
    let rawVsGradedLine;
    if (bestRaw && bestGraded) {
      const rawScore = bestRaw.riskAdjusted;
      const gradedScore = bestGraded.riskAdjusted;
      if (rawScore > gradedScore + 30) {
        rawVsGradedLine = `<strong>Buy raw</strong> — <strong>${bestRaw.label}</strong> beats the best graded option (${bestGraded.label}) by a wide margin on risk-adjusted return.${gambleCaveat}`;
      } else if (gradedScore > rawScore + 30) {
        rawVsGradedLine = `<strong>Buy graded</strong> — <strong>${bestGraded.label}</strong> beats the best raw approach (${bestRaw.label}) on risk-adjusted return. From the UK, skipping the ~${UK_GRADING_WAIT_MONTHS}-month grading wait is the better play here.`;
      } else {
        rawVsGradedLine = `<strong>Close call</strong> — ${bestRaw.label} and ${bestGraded.label} are within a few points of each other. From the UK, the tie-breaker is usually the ~${UK_GRADING_WAIT_MONTHS}-month grading wait and ${(lossProb*100).toFixed(0)}% loss case on Raw + Grade — the graded copy gives you an instant, certain position.`;
      }
    } else if (bestGraded) {
      rawVsGradedLine = `<strong>Buy graded</strong> — no raw-side option projects positive 5yr ROI for this card; only graded holds make sense.`;
    } else {
      rawVsGradedLine = `<strong>Buy raw</strong> — graded copies don’t project a positive 5yr return at current prices; the raw card is the only sensible entry.`;
    }

    // Best graded tier line.
    let gradedLine;
    if (bestGraded) {
      const gradeNum = bestGraded.grade;
      gradedLine = `Among graded copies, <strong>PSA ${gradeNum}</strong> is the best long-term hold: ${fmtGBP(bestGraded.today)} today → ${fmtGBP(bestGraded.yr5)} in 5yrs (+${bestGraded.roi.toFixed(0)}% ROI, +${fmtGBP(bestGraded.profit)} profit, ${bestGraded.risk === 'low' ? 'low' : 'medium'} risk).`;
    } else {
      gradedLine = `No graded tier projects positive 5yr ROI — every graded copy is overpriced relative to the model.`;
    }

    recEl.innerHTML = `
      <div class="hold-rec-pill">Verdict</div>
      <div class="hold-rec-body">
        <div class="hold-rec-line">${rawVsGradedLine}</div>
        <div class="hold-rec-line hold-rec-line-sub">${gradedLine}</div>
      </div>
    `;
  }

  // Render the comparison grid.
  const grid = $('holdGrid');
  grid.innerHTML = strategies.map(s => {
    const isWinner = winner && s.key === winner.key;
    const verdict = s.roi >= 80 ? { c: 'hold-v-strong', t: 'Strong hold' }
                  : s.roi >= 40 ? { c: 'hold-v-good',   t: 'Worth holding' }
                  : s.roi >= 15 ? { c: 'hold-v-fair',   t: 'Fair' }
                  : s.roi >= 0  ? { c: 'hold-v-flat',   t: 'Flat' }
                  :               { c: 'hold-v-skip',   t: 'Skip' };
    const riskLabel = s.risk === 'low' ? 'Low risk' : s.risk === 'med' ? 'Medium risk' : 'High risk';
    const profitSign = s.profit >= 0 ? '+' : '−';
    return `
      <div class="hold-tile ${isWinner ? 'hold-winner' : ''} ${verdict.c} ${s.overridden ? 'hold-tile-overridden' : ''}">
        ${isWinner ? '<div class="hold-winner-tag">\u2605 Best long-term pick</div>' : ''}
        ${s.overridden ? `<div class="hold-tile-override-tag" title="Using your manual market price">Market £${(+s.overrideGBP).toFixed(2)}</div>` : ''}
        <div class="hold-tile-head">
          <div class="hold-tile-title">${s.label}</div>
          <div class="hold-tile-desc">${s.desc}</div>
        </div>
        <div class="hold-tile-row">
          <span class="hold-tile-k">Today${s.overridden ? ' <span class="hold-tile-ov">(override)</span>' : ''}</span>
          <span class="hold-tile-v">${fmtGBP(s.today)}</span>
        </div>
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
          <span class="hold-tile-k">UK wait</span>
          <span class="hold-tile-v">~${s.waitMonths} mo locked</span>
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
  }).join('');

  // ---------- Grading outcome distribution ----------
  // A focused little table showing what actually happens when you grade:
  // for each outcome, the probability bar + the realised P&L.
  const outcomeHost = $('holdOutcomes');
  if (outcomeHost) {
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
            otherLine = `Crack alt: ${fmtGBP(o.crackNetUSD)} EV\u00a0\u00b7\u00a0only +${fmtGBP(o.nextMoveEdgeUSD)} edge \u2014 not worth another \u00a3${UK_GRADING_ALL_IN_GBP} + ${UK_GRADING_WAIT_MONTHS}mo wait + ${(CRACK_DAMAGE_RISK*100).toFixed(0)}% damage risk`;
          } else {
            otherLine = `Crack alt: ${fmtGBP(o.crackNetUSD)} EV\u00a0\u00b7\u00a0\u2212${fmtGBP(o.nextMoveEdgeUSD)} after \u00a3${UK_GRADING_ALL_IN_GBP} resub fee + ${(CRACK_DAMAGE_RISK*100).toFixed(0)}% damage risk`;
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
    outcomeHost.innerHTML = `
      <div class="hold-out-head">
        <div class="hold-out-title">What you actually get when you grade</div>
        <div class="hold-out-summary">
          <span class="hold-out-chip hold-out-chip-good">${goodPct}% PSA 9 or 10</span>
          <span class="hold-out-chip hold-out-chip-bad">${lossPct}% loss case</span>
          <span class="hold-out-chip hold-out-chip-wait">${UK_GRADING_WAIT_MONTHS} mo wait (UK)</span>
          <span class="hold-out-chip hold-out-chip-online">Online buy: ${(ONLINE_BUY_GEM_PENALTY*100).toFixed(0)}% of hand-picked gem rate</span>
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
  $('holdFootnote').innerHTML = `
    <strong>UK grading assumptions:</strong> £${UK_GRADING_ALL_IN_GBP} all-in cost per card
    (PSA economy fee + Ludkins/GetGraded intermediary fee + insured round-trip shipping)
    and a ~${UK_GRADING_WAIT_MONTHS}-month wait. Capital locked during the wait is discounted at
    ${(OPPORTUNITY_COST_ANNUAL*100).toFixed(0)}% p.a. opportunity cost so the gamble can’t look better
    than it really is once your money is tied up. Also assumes ${(BUY_SELL_FRICTION*100).toFixed(0)}%
    combined buy + sell friction.<br>
    <strong>Online buy penalty:</strong> base gem rate is ${baseGemPctStr}% (${gemRateSource}) but we apply a
    ${(ONLINE_BUY_GEM_PENALTY*100).toFixed(0)}% multiplier because buying raw online (eBay / TCGplayer) is sight-unseen —
    you can’t check centering, whitening, or surface scratches — so the effective PSA 10
    hit rate drops to <strong>${gemPctStr}%</strong>. Hand-pick from a shop or show and you can dial that back up.<br>
    <strong>Flip vs Crack on a non-10 outcome:</strong> for each PSA 7/8/9 row above we compare
    flipping the slab at current market against cracking it out, paying another £${UK_GRADING_ALL_IN_GBP}, waiting
    ~${UK_GRADING_WAIT_MONTHS} more months, and gambling on a regrade. PSA grades are sticky on resub —
    upgrade rates used: PSA 9→10 = 10%, PSA 8→9+ = 15%, PSA 7→8+ = 25%. A ${(CRACK_DAMAGE_RISK*100).toFixed(0)}%
    crack-damage haircut and the same wait discount apply to the crack EV. Cracking only
    pays off when the PSA 10 / PSA 9 spread is wide enough to overcome those costs —
    usually only on chase cards with 5-10× spread between adjacent grades.<br>
    Risk-adjusted ranking discounts ROI by variance so a coin-flip can’t win “best” when
    a steadier graded copy delivers nearly the same return without the wait.
  `;
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

const PRICE_SYNC_CONCURRENCY = 3;
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
  const card = cardData.cards.find(c => c.i === id);
  if (!card) return { ok: false, error: `Card not in catalog: ${id}` };
  try {
    const data = await fetchFreshPriceData(card);
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
      const card = cardData?.cards.find(c => c.i === id);
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
  return null;
}

function fmtPct(v, signed) {
  if (!Number.isFinite(v)) return '—';
  const s = (signed && v > 0 ? '+' : '') + v.toFixed(1) + '%';
  return s;
}
function fmtGBPDirect(gbp) {
  if (!Number.isFinite(gbp)) return '—';
  return '£' + gbp.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderAcquisition() {
  const sec = document.getElementById('acqSection');
  if (!sec) return;
  if (!selectedCard) { sec.style.display = 'none'; return; }
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

  // Show the right fields
  const packFields = document.getElementById('acqFieldsPack');
  const singleFields = document.getElementById('acqFieldsSingle');
  const empty = document.getElementById('acqEmpty');
  const roi = document.getElementById('acqRoi');
  packFields.style.display = acq.source === 'pack' ? 'grid' : 'none';
  singleFields.style.display = acq.source === 'single' ? 'grid' : 'none';
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

  // Compute ROI readout
  const costGBP = getAcqCostBasisGBP(card.i);
  if (!acq.source || !Number.isFinite(costGBP) || costGBP <= 0) {
    roi.style.display = 'none';
    return;
  }
  roi.style.display = 'block';

  const rawUSD = getCurrentPrice(card);
  const marketGBP = usdToGbp(rawUSD || 0);
  const psa10USD = (card.p10 || 0) || (livePrice && livePrice.pcPsa10 > 0 ? livePrice.pcPsa10 : 0);

  // Realised ROI: market value now (raw) vs cost basis
  // Assume 10% buy/sell friction if you flipped it today
  const FRICTION = 0.10;
  const realisedNetGBP = marketGBP * (1 - FRICTION);
  const realisedROI = costGBP > 0 ? ((realisedNetGBP - costGBP) / costGBP) * 100 : null;

  // Max ROI scenario: PSA 10 in 5 years
  let maxROI = null, maxProfit = null, maxValueGBP = null;
  if (psa10USD > 0) {
    const psa10NowUSD = estimateGradePrice(card, 10, psa10USD);
    const psa10In5USD = projectGradePrice(card, 10, psa10NowUSD, 5);
    const psa10In5GBP = usdToGbp(psa10In5USD);
    const gradingFeeGBP = (typeof UK_GRADING_ALL_IN_GBP === 'number') ? UK_GRADING_ALL_IN_GBP : 40;
    const netGBP = psa10In5GBP * (1 - FRICTION) - gradingFeeGBP;
    maxValueGBP = psa10In5GBP;
    maxROI = costGBP > 0 ? ((netGBP - costGBP) / costGBP) * 100 : null;
    maxProfit = netGBP - costGBP;
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
    profSub.textContent = `after £40 grading + 10% sell fees`;
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
    const rows = grades.map(g => {
      const todayUSD = estimateGradePrice(card, g, psa10USD);
      const yr5USD = projectGradePrice(card, g, todayUSD, 5);
      const yr5GBP = usdToGbp(yr5USD);
      const gradingFee = 40;
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
  const inPortfolio = (portfolio || []).some(p => p.id === card.i);
  meta.innerHTML = [
    acqLabel,
    inPortfolio ? '<span class="acq-pill">In collection</span>' : '<span class="acq-pill acq-pill-muted">Not in collection</span>'
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
  // Tracked anchor wins
  if (card.p10 && card.p10 > 0) return { usd: card.p10, source: 'tracked' };
  // Live PriceCharting PSA 10 from currently-selected card
  if (typeof livePrice !== 'undefined' && livePrice
      && selectedCard && card.i === selectedCard.i
      && livePrice.pcPsa10 > 0) {
    return { usd: livePrice.pcPsa10, source: 'live' };
  }
  // Live cache for non-selected card
  const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(card.i) : null;
  if (cached && cached.pcPsa10 > 0) return { usd: cached.pcPsa10, source: 'live' };
  // Estimate from raw × rarity multiplier
  const raw = (typeof getCurrentPrice === 'function') ? getCurrentPrice(card) : (card.p || 0);
  if (raw > 0) {
    const mult = PSA10_FROM_RAW[card.rc] || PSA10_FROM_RAW[''];
    return { usd: raw * mult, source: 'estimated', multiplier: mult };
  }
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
  return localStorage.getItem(AI_PROV_STORAGE) || 'perplexity';
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
  const ctx = { now: new Date().toISOString(), fx_usd_per_gbp: (typeof fxRate === 'number' ? fxRate : null) };

  // Portfolio summary + top 10 cards by current value
  try {
    if (Array.isArray(portfolio) && portfolio.length) {
      let totalGBP = 0, totalCost = 0, hasCost = 0;
      const items = portfolio.map(p => {
        const card = cardData && cardData.cards.find(c => c.i === p.id);
        const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(p.id) : null;
        const usd = cached ? (cached.market || cached.mid || (card ? card.p : p.price)) : (card ? card.p : p.price);
        const gbp = usdToGbp(usd);
        totalGBP += gbp;
        const acqCost = (typeof getAcqCostBasisGBP === 'function') ? getAcqCostBasisGBP(p.id) : 0;
        if (acqCost > 0) { totalCost += acqCost; hasCost++; }
        return { id: p.id, name: p.name, set: p.set, price_gbp: +gbp.toFixed(2), cost_gbp: acqCost > 0 ? +acqCost.toFixed(2) : null };
      });
      items.sort((a, b) => b.price_gbp - a.price_gbp);
      ctx.portfolio = {
        count: portfolio.length,
        total_value_gbp: +totalGBP.toFixed(2),
        total_cost_gbp: hasCost ? +totalCost.toFixed(2) : null,
        pl_gbp: hasCost ? +(totalGBP - totalCost).toFixed(2) : null,
        top_cards: items.slice(0, 10),
      };
    }
  } catch (e) { console.warn('ctx portfolio', e); }

  // Wishlist
  try {
    if (Array.isArray(wishlist) && wishlist.length) {
      ctx.wishlist = wishlist.slice(0, 10).map(w => {
        const card = cardData && cardData.cards.find(c => c.i === w.id);
        const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(w.id) : null;
        const usd = cached ? (cached.pcUngraded || cached.market || cached.mid || (card ? card.p : 0)) : (card ? card.p : 0);
        return {
          id: w.id, name: w.name, set: w.set, lang: w.lang || 'EN',
          current_gbp: +usdToGbp(usd).toFixed(2),
          target_gbp: w.targetGBP || null,
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

  // Selected card snapshot
  try {
    if (selectedCard) {
      const c = selectedCard;
      const cached = (typeof getCachedPrice === 'function') ? getCachedPrice(c.i) : null;
      const usd = cached ? (cached.pcUngraded || cached.market || cached.mid || c.p) : c.p;
      const anchor = (typeof getPsa10Anchor === 'function') ? getPsa10Anchor(c) : { usd: 0, source: 'none' };
      ctx.selected_card = {
        id: c.i, name: c.n, set: c.s, number: c.cn, rarity: c.rc, lang: c.lang || 'EN',
        raw_gbp: +usdToGbp(usd).toFixed(2),
        psa10_gbp: anchor.usd ? +usdToGbp(anchor.usd).toFixed(2) : null,
        psa10_source: anchor.source,
      };
    }
  } catch (e) { console.warn('ctx selected', e); }

  // Top value picks — pre-ranked so the bot can answer
  // "what's underrated" without us building a separate page
  try {
    if (typeof scanValuePicks === 'function') {
      const top = scanValuePicks('all').slice(0, 8).map(p => ({
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

  return ctx;
}

function aiSystemPrompt(ctx) {
  return `You are "Ask the Predictor", an expert Pokemon TCG market analyst built into the user's collection-tracking app.

ROLE: Give crisp, data-driven advice on buying, selling, grading and timing the Pokemon TCG market. Be opinionated but honest about uncertainty. Optimise for actionable signal, not generic advice.

USER CONTEXT (always reflects their latest local state — do not ask for it):
\`\`\`json
${JSON.stringify(ctx, null, 2)}
\`\`\`

PRINCIPLES:
- Prices are in GBP. The user is UK-based. Mention import VAT/fees when discussing US/JP purchases.
- "Underrated" means strong fundamentals (rarity, character demand, set age) at a depressed current price.
- "Graded upside" = PSA 10 / raw multiplier. Anything >2.5x is interesting; >4x is exceptional.
- When suggesting picks, prefer cards from value_picks above where relevant — they're pre-screened.
- For sell/hold/grade questions, balance: gem rate, grading cost (~£25), opportunity cost.
- Keep replies tight: 3-6 short paragraphs or a focused table. No filler.
- Use **bold** sparingly for emphasis. Bullet lists are fine. Never invent prices not in context.
- If asked something not about Pokemon TCG or the user's data, gently redirect.`;
}

// ---- LLM client (streaming) ----
async function aiStreamChat({ provider, key, messages, onToken, onDone, onError }) {
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) { onError('Unknown provider'); return; }
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: 0.4,
  };
  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify(body),
    });
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

// ---- UI ----
function aiRenderHistory() {
  const list = document.getElementById('aiChatMessages');
  if (!list) return;
  if (aiChatHistory.length === 0) {
    list.innerHTML = `
      <div class="ai-welcome">
        <div class="ai-welcome-title">Ask the Predictor</div>
        <div class="ai-welcome-sub">An AI analyst with live access to your collection, wishlist, watchlist and the market.</div>
        <div class="ai-welcome-suggest">Try one of these to get started:</div>
        <div class="ai-quick-grid">
          <button class="ai-quick" data-prompt="What are the most underrated cards I should look at right now — both raw and graded — with high growth potential?">What's underrated right now?</button>
          <button class="ai-quick" data-prompt="Analyse my portfolio. Which cards should I consider selling, holding or grading?">Analyse my portfolio</button>
          <button class="ai-quick" data-prompt="Which wishlist cards are closest to a good buying window? Should I lower or raise any of my targets?">Wishlist buy timing</button>
          <button class="ai-quick" data-prompt="What's the smartest £100 spend in the modern era this week?">Best £100 spend this week</button>
        </div>
      </div>`;
    return;
  }
  list.innerHTML = aiChatHistory.map(m => {
    if (m.role === 'user') {
      const safe = String(m.content || '').replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
      return `<div class="ai-msg ai-msg-user"><div class="ai-msg-content">${safe.replace(/\n/g, '<br>')}</div></div>`;
    }
    return `<div class="ai-msg ai-msg-bot"><div class="ai-msg-content">${aiMdRender(m.content)}</div></div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
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
  const panel = document.getElementById('aiChatPanel');
  if (!panel) return;
  panel.style.display = 'flex';
  setTimeout(() => panel.classList.add('open'), 10);
  aiRenderHistory();
  // First-time? Force settings open
  if (!aiGetKey()) aiToggleSettings(true);
  const input = document.getElementById('aiChatInput');
  if (input) setTimeout(() => input.focus(), 200);
}
function aiClosePanel() {
  const panel = document.getElementById('aiChatPanel');
  if (!panel) return;
  panel.classList.remove('open');
  setTimeout(() => { panel.style.display = 'none'; }, 200);
}

async function aiSubmit(userText) {
  const text = (userText || '').trim();
  if (!text) return;
  const key = aiGetKey();
  if (!key) {
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
  await aiStreamChat({
    provider: aiGetProvider(),
    key,
    messages,
    onToken: (tok) => {
      full += tok;
      target.innerHTML = aiMdRender(full);
      target.parentElement.parentElement.scrollTop = target.parentElement.parentElement.scrollHeight;
    },
    onDone: (whole) => {
      aiChatHistory.push({ role: 'assistant', content: whole });
      aiSaveHistory();
      target.innerHTML = aiMdRender(whole);
    },
    onError: (err) => {
      target.innerHTML = `<p style="color:var(--red)">${aiMdRender('**Error:** ' + err)}</p>`;
    },
  });
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('aiChatPanel').classList.contains('open')) aiClosePanel();
  });
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
    if (provSel) provSel.value = p;
    if (keyInput) keyInput.value = aiGetKey();
    if (helpLink) {
      const cfg = AI_PROVIDERS[p];
      helpLink.textContent = cfg.keyHelp;
      helpLink.href = cfg.keyUrl;
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

// ─── Home Dashboard ───────────────────────────────────────────────
function renderHomeDashboard() {
  _renderHomeCollection();
  _renderHomeWishlist();
  _renderHomeWatchlist();
}

function _homeItemClick(id) {
  document.querySelector('.page-nav-btn[data-page="predict"]')?.click();
  setTimeout(() => selectCard(id), 80);
}

function _homeTile(id, imgUrl, name, price, signalClass, signalLabel, extraClass, subText) {
  const img = imgUrl
    ? `<img class="home-card-art" src="${imgUrl}" alt="" loading="lazy" onerror="this.style.opacity='0'">`
    : `<div class="home-card-art"></div>`;
  const signal = signalClass && signalLabel
    ? `<span class="home-card-signal ${signalClass}">${signalLabel}</span>`
    : '';
  const sub = subText ? `<div class="home-card-sub">${esc(subText)}</div>` : '';
  return `<div class="home-card-tile${extraClass ? ' ' + extraClass : ''}" data-id="${id}">
    ${img}${signal}
    <button class="home-card-remove" aria-label="Remove">✕</button>
    <div class="home-card-info">
      <div class="home-card-name">${esc(name)}</div>
      <div class="home-card-price">${price}</div>
      ${sub}
    </div>
  </div>`;
}

function _setupTileEvents(scrollEl, deleteFn) {
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
    if (tile) _homeItemClick(tile.dataset.id);
  });
}

function _renderHomeCollection() {
  const list = $('homeCollList'), countEl = $('homeCollCount'), totalEl = $('homeCollTotal');
  if (!list) return;
  if (countEl) countEl.textContent = portfolio.length;
  if (portfolio.length === 0) {
    list.innerHTML = '<div class="home-empty">No cards in collection yet.<br>Search a card and tap + to add it.</div>';
    if (totalEl) totalEl.textContent = '';
    return;
  }
  let totalGBP = 0;
  const tiles = portfolio.map(p => {
    const card = cardData?.cards.find(c => c.i === p.id);
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
      const sig = computeSignal(card, pull, autoFillDesirability(card, pull).total);
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

function _renderHomeWishlist() {
  const list = $('homeWishList'), countEl = $('homeWishCount');
  if (!list) return;
  if (countEl) countEl.textContent = wishlist.length;
  if (wishlist.length === 0) {
    list.innerHTML = '<div class="home-empty">No wishlisted cards yet.<br>Tap ♥ on any card to add it.</div>';
    return;
  }
  const tiles = wishlist.map(w => {
    const card = cardData?.cards.find(c => c.i === w.id);
    const cached = getCachedPrice(w.id);
    const priceUSD = cached ? (cached.pcUngraded || cached.market || cached.mid || (card ? card.p : 0)) : (card ? card.p : 0);
    const priceGBP = usdToGbp(priceUSD);
    const target = w.targetGBP || 0;
    let alertClass = 'alert-far', alertLabel = 'Watching';
    if (target > 0) {
      if (priceGBP <= target) { alertClass = 'alert-buy'; alertLabel = 'BUY NOW'; }
      else if (priceGBP <= target * 1.10) { alertClass = 'alert-watch'; alertLabel = 'Close'; }
    }
    const sub = target > 0 ? `Target: ${fmtGBPDirect(target)}` : (w.set || '');
    return _homeTile(w.id, w.img, w.name, fmtGBPDirect(priceGBP), alertClass, alertLabel, '', sub);
  });
  list.innerHTML = tiles.join('');
  _setupTileEvents(list, id => {
    wishlist = wishlist.filter(w => w.id !== id);
    saveWishlist(); renderWishlist(); updateWishlistButton();
    _renderHomeWishlist();
  });
}

function _renderHomeWatchlist() {
  const list = $('homeWatchList'), countEl = $('homeWatchCount');
  if (!list) return;
  if (countEl) countEl.textContent = watchlist.length;
  if (watchlist.length === 0) {
    list.innerHTML = '<div class="home-empty">No cards being watched yet.<br>Tap "Watch" on any card to track it.</div>';
    return;
  }
  const alerts = (typeof computeActiveAlerts === 'function') ? computeActiveAlerts() : [];
  const alertMap = Object.fromEntries(alerts.map(a => [a.id, a]));
  const tiles = watchlist.map(w => {
    const a = alertMap[w.id];
    const priceGBP = a ? a.currentPriceGBP : usdToGbp(w.addedPriceUSD || 0);
    const signal = a ? a.signal : (w.addedSignal || '—');
    const triggered = a ? (a.triggered && a.dismissedFor !== a.signal) : false;
    const sc = signal === 'STRONG BUY' ? 'sig-strong-buy' : signal === 'BUY' ? 'sig-buy' : signal === 'SELL' ? 'sig-sell' : 'sig-hold';
    return _homeTile(w.id, w.img, w.name,
      priceGBP > 0 ? fmtGBPDirect(priceGBP) : '—',
      sc, signal,
      triggered ? 'alert-tile' : '',
      w.set || '');
  });
  list.innerHTML = tiles.join('');
  _setupTileEvents(list, id => {
    const idx = watchlist.findIndex(w => w.id === id);
    if (idx >= 0) { watchlist.splice(idx, 1); saveWatchlist(); }
    _renderHomeWatchlist();
  });
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
  const buttons = Array.from(document.querySelectorAll('.page-nav-btn'));
  const pages = {
    home: document.getElementById('pageHome'),
    predict: document.getElementById('pagePredict'),
    discover: document.getElementById('pageDiscover'),
    tools: document.getElementById('pageTools'),
  };

  function go(page) {
    if (!pages[page]) page = 'home';
    Object.entries(pages).forEach(([k, el]) => { if (el) el.style.display = (k === page) ? '' : 'none'; });
    buttons.forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const fab = document.getElementById('filterFab');
    if (fab) fab.style.display = (page === 'predict') ? '' : 'none';
    if (page === 'discover' && !window._urRanOnce) {
      window._urRanOnce = true;
      setTimeout(() => { try { urRunScan(); } catch (e) {} }, 100);
    }
    if (page === 'home') renderHomeDashboard();
    try { if (location.hash.replace('#', '') !== page) history.replaceState(null, '', '#' + page); } catch (e) {}
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  // Wire "View all" buttons on the home page
  document.getElementById('homeOpenCollection')?.addEventListener('click', () => { $('portfolioToggle')?.click(); });
  document.getElementById('homeOpenWishlist')?.addEventListener('click', () => { $('wishlistToggle')?.click(); });
  document.getElementById('homeOpenWatchlist')?.addEventListener('click', () => { $('alertsToggle')?.click(); });

  buttons.forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
  window.addEventListener('hashchange', () => go((location.hash || '#home').replace('#', '')));

  // Initial route — default to Home.
  const initial = (location.hash || '#home').replace('#', '');
  go(['home', 'predict', 'discover', 'tools'].includes(initial) ? initial : 'home');

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
  if (nav) {
    nav.addEventListener('pointermove', e => {
      const x = e.clientX - nav.getBoundingClientRect().left;
      nav.style.setProperty('--nav-mx', x + 'px');
      nav.style.setProperty('--nav-glow', '1');
    });
    nav.addEventListener('pointerleave', () => {
      nav.style.setProperty('--nav-glow', '0');
    });
    nav.addEventListener('touchmove', e => {
      const x = e.touches[0].clientX - nav.getBoundingClientRect().left;
      nav.style.setProperty('--nav-mx', x + 'px');
      nav.style.setProperty('--nav-glow', '1');
    }, { passive: true });
    nav.addEventListener('touchend', () => {
      nav.style.setProperty('--nav-glow', '0');
    }, { passive: true });
  }
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
    if (rarityRate < 0.05) continue; // commons rarely move

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
      signal: rawDiscount >= 1.8 || gradeRoi >= 1.5 ? 'STRONG BUY' : 'BUY',
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
        signal: roi5 > 1.5 ? 'STRONG BUY' : 'BUY',
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

// Apply user-entered market prices to a strategies array (mutates in place).
// We override the "today" buy price only — 5yr target stays from the model.
// That way ROI honestly reflects "I paid £X today, model says it'll be worth
// £Y in 5yr". Recompute profit/ROI for affected rows.
function applyHoldOverrides(card, strategies, fx, gradingFeeUSD) {
  if (!card || !card.i || !Array.isArray(strategies)) return;
  const overrides = getHoldOverridesForCard(card.i);
  if (!overrides || !Object.keys(overrides).length) return;
  const fxRateLocal = (typeof fx === 'number' && fx > 0) ? fx : 0.79;
  // Map strategy key → which override key feeds it.
  // The "gamble" (Buy Raw + Grade) row buys raw upfront, so it uses the raw override.
  const sourceKey = { raw: 'raw', gamble: 'raw', psa7: 'psa7', psa8: 'psa8', psa9: 'psa9', psa10: 'psa10' };
  strategies.forEach(s => {
    const ok = sourceKey[s.key];
    if (!ok) return;
    const gbp = overrides[ok];
    if (gbp == null || !isFinite(gbp) || gbp <= 0) return;
    const usd = gbp / fxRateLocal;
    if (s.key === 'gamble') {
      s.today = usd + gradingFeeUSD;
    } else {
      s.today = usd;
    }
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
  const activeCount = rows.filter(r => overrides[r.key] != null).length;
  const summaryNote = activeCount > 0
    ? `<span class="ho-active">${activeCount} active override${activeCount === 1 ? '' : 's'}</span>`
    : `<span class="ho-hint">Override fair value with actual eBay prices</span>`;
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
            const fv = fvGBP(r.key);
            const val = overrides[r.key] != null ? overrides[r.key] : '';
            const placeholder = fv != null ? `Fair value £${fv.toFixed(2)}` : 'Enter GBP';
            const fvNote = fv != null ? `<span class="ho-fv">Fair £${fv.toFixed(2)}</span>` : '';
            return `
              <div class="ho-row">
                <label class="ho-row-label" for="ho-in-${r.key}">${r.label}</label>
                <div class="ho-input-wrap">
                  <span class="ho-cur">£</span>
                  <input type="number" id="ho-in-${r.key}" class="ho-input" data-grade="${r.key}"
                         min="0" step="0.01" inputmode="decimal"
                         value="${val}" placeholder="${placeholder}">
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

    if (collapsed.has(key)) sec.classList.add('is-collapsed');

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
];

const SYNC_PAIR_CODE_KEY = 'pkm-sync-pair-code';
const SYNC_ENDPOINT_KEY  = 'pkm-sync-endpoint';
const SYNC_META_KEY      = 'pkm-sync-meta';        // { lastPush, lastPull, lastErr }
const SYNC_LAST_HASH_KEY = 'pkm-sync-last-hash';   // payload hash of last successful push

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
    if (typeof compareSlots !== 'undefined') compareSlots = JSON.parse(localStorage.getItem('pkm-compare') || '[null, null]');
    if (typeof watchlist !== 'undefined') watchlist = JSON.parse(localStorage.getItem('pkm-watchlist-v1') || '[]');
  } catch {}
  // Trigger re-render of any visible panels.
  try { typeof renderPortfolio    === 'function' && renderPortfolio();    } catch {}
  try { typeof renderWishlist     === 'function' && renderWishlist();     } catch {}
  try { typeof renderCompare      === 'function' && renderCompare();      } catch {}
  try { typeof renderWatchlist    === 'function' && renderWatchlist();    } catch {}
  try { typeof renderAlerts       === 'function' && renderAlerts();       } catch {}
  try { typeof renderHomeDashboard === 'function' && renderHomeDashboard(); } catch {}
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
function syncSchedulePush() {
  if (!syncGetPairCode() || !syncGetEndpoint()) return;
  clearTimeout(_syncPushTimer);
  _syncPushTimer = setTimeout(() => syncCloudPush({ silent: true }), 4000);
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
    if (!code) el.textContent = 'Not paired';
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

  // Pull on focus so a return visit picks up changes from other devices.
  let lastFocusPull = 0;
  window.addEventListener('focus', () => {
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncBindOnce);
} else {
  syncBindOnce();
}
