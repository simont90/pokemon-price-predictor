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

// ---- Image URL Helper (reconstructed from card ID to save DB size) ----
function getCardImg(card) {
  if (card.img) return card.img;
  if (card.lang === 'JP') {
    // JP cards: tcgdex format — jp-{set}-{num} -> /ja/{era}/{set}/{num}/high.png
    const parts = card.i.replace('jp-', '').split('-');
    const setCode = parts[0];
    const num = parts.slice(1).join('-');
    return `https://assets.tcgdex.net/ja/S/${setCode}/${num}/high.png`;
  }
  // EN cards: pokemontcg.io format — {setCode}-{num} -> /images/{setCode}/{num}.png
  return `https://images.pokemontcg.io/${card.sc}/${card.cn || card.ns || ''}.png`;
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
  setupPWANav();
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

async function pcSearchRaw(query) {
  const pcUrl = `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(query)}&format=json`;
  const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(pcUrl)}`;
  const r = await fetch(proxyUrl);
  if (!r.ok) throw new Error(`PriceCharting ${r.status}`);
  const data = await r.json();
  return data.products || [];
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
}

// ================================================================
// ---- Card Selection ----
// ================================================================
function selectCard(id) {
  if (!cardData) return;
  const card = cardData.cards.find(c => c.i === id);
  if (!card) return;
  selectedCard = card;

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

  // Card images
  if (isJP) {
    $('cardImageJp').src = getCardImg(card);
    $('cardImageJp').style.display = 'block';
    $('cardImageJp').title = 'Japanese card';
    $('cardImageJp').onclick = null;
    $('cardImageJp').style.cursor = 'default';
    $('cardImage').style.display = 'none';
  } else {
    $('cardImage').src = getCardImg(card);
    $('cardImage').style.display = 'block';
    loadJapaneseImage(card);
  }

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

  // Reset market dynamics section
  $('marketSection').style.display = 'none';
  $('marketContent').style.display = 'none';
  $('marketLoading').style.display = 'block';
  $('marketLoading').textContent = 'Loading market data...';
  $('marketTrend').textContent = '';
  $('marketTrend').className = 'market-trend-badge';
  $('gradeSection').style.display = 'none';

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
function loadJapaneseImage(card) {
  const jpImg = $('cardImageJp');
  const tcgName = card.n.replace(/#\d+/, '').replace(/\s+/g, ' ').trim();
  const jpSearchUrl = `https://www.tcgcollector.com/cards/jp?cardName=${encodeURIComponent(tcgName)}${card.cn ? '&displayNumber=' + card.cn : ''}`;

  jpImg.src = getCardImg(card);
  jpImg.style.display = 'block';
  jpImg.title = 'Click to find Japanese version on TCG Collector';
  jpImg.style.cursor = 'pointer';
  jpImg.onclick = () => window.open(jpSearchUrl, '_blank');
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

    return `
      <div class="portfolio-item" data-id="${p.id}">
        ${p.img ? `<img class="portfolio-item-img" src="${p.img}" alt="" onerror="this.style.display='none'">` : '<div class="portfolio-item-img"></div>'}
        <div class="portfolio-item-info">
          <div class="portfolio-item-name">${esc(p.name)}</div>
          <div class="portfolio-item-meta">${esc(p.set)}${change !== null ? ` · <span style="color:${parseFloat(change) >= 0 ? 'var(--green)' : 'var(--red)'}"> ${parseFloat(change) >= 0 ? '+' : ''}${change}%</span>` : ''}${isLive ? ' · <span class="live-dot-inline" title="Live price"></span>' : ''}</div>
        </div>
        <div class="portfolio-item-right">
          <div class="portfolio-item-price">£${currentGBP.toFixed(2)}</div>
          ${signal ? `<span class="portfolio-item-signal sig-${signal.signal.toLowerCase().replace('strong ', '')}"> ${signal.signal}</span>` : ''}
        </div>
        <button class="portfolio-item-remove" data-id="${p.id}" title="Remove">✕</button>
      </div>
    `;
  });

  list.innerHTML = items.join('');
  totalEl.textContent = `Total: £${totalGBP.toFixed(2)}`;

  list.querySelectorAll('.portfolio-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.portfolio-item-remove')) return;
      selectCard(el.dataset.id);
    });
  });
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
  ['portfolioPanel', 'wishlistPanel', 'comparePanel'].forEach(p => {
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
      <div class="wishlist-item ${rowClass}" data-id="${w.id}">
        ${w.img ? `<img class="wishlist-item-img" src="${w.img}" alt="" onerror="this.style.display='none'">` : '<div class="wishlist-item-img"></div>'}
        <div class="wishlist-item-info">
          <div class="wishlist-item-name">${esc(w.name)}</div>
          <div class="wishlist-item-meta">
            <span>${esc(w.set)}</span>
            <span class="lang-pill">${w.lang === 'JP' ? '🇯🇵 JP' : '🇬🇧 EN'}</span>
            <span class="wishlist-alert ${alertClass}">${alertLabel}</span>
          </div>
        </div>
        <div class="wishlist-target">
          <div class="wishlist-current">£${currentGBP.toFixed(2)}</div>
          <input class="wishlist-target-input" type="number" step="0.01" min="0" value="${target.toFixed(2)}" data-id="${w.id}" title="Target price (GBP)">
          <div class="wishlist-target-label">Target £</div>
        </div>
        <button class="wishlist-remove" data-id="${w.id}" title="Remove">✕</button>
      </div>
    `;
  });
  list.innerHTML = items.join('');
  totalEl.textContent = `${wishlist.length} cards · £${totalCurrent.toFixed(2)}` + (alertCount > 0 ? ` · ${alertCount} BUY` : '');

  list.querySelectorAll('.wishlist-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.wishlist-remove') || e.target.closest('.wishlist-target-input')) return;
      selectCard(el.dataset.id);
    });
  });
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
  // Focus the input on next tick so the keyboard pops on iOS
  setTimeout(() => $('qlInput').focus(), 50);
}
function closeQuickLookup() {
  $('qlOverlay').style.display = 'none';
  $('qlModal').style.display = 'none';
}

async function runQuickLookup() {
  const raw = $('qlInput').value.trim();
  if (!raw) {
    $('qlStatus').textContent = 'Type a card name (e.g. "Charizard ex 125 obsidian flames")';
    return;
  }
  const isJP = $('qlJP').checked;
  const query = isJP && !/japanese/i.test(raw) ? `${raw} japanese` : raw;
  $('qlStatus').textContent = 'Searching PriceCharting…';
  $('qlResults').innerHTML = '';
  try {
    const products = await pcSearchRaw(query);
    if (!products || products.length === 0) {
      $('qlStatus').textContent = 'No matches — try a different name or number';
      return;
    }
    $('qlStatus').textContent = `${products.length} match${products.length === 1 ? '' : 'es'}`;
    $('qlResults').innerHTML = products.slice(0, 50).map(p => renderQLCard(p)).join('');
  } catch (e) {
    $('qlStatus').textContent = 'Search failed — try again in a moment';
    console.warn('Quick Lookup error:', e);
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
  }
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

// Re-inject any user-added cards on init so they survive reloads.
function injectUserCards() {
  if (!cardData || !Array.isArray(cardData.cards)) return;
  const userCards = loadUserCards();
  if (!userCards.length) return;
  const existing = new Set(cardData.cards.map(c => c.i));
  for (const uc of userCards) {
    if (!existing.has(uc.i)) cardData.cards.push(uc);
  }
  cardData.count = cardData.cards.length;
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('maModal') && $('maModal').style.display !== 'none') closeManualAdd();
  });
  // Make openManualAdd globally reachable for the empty-state button
  window.openManualAdd = openManualAdd;
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
