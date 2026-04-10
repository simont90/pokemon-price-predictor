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

// ---- Auto-fill Desirability ----
function autoFillDesirability(card, pullCost) {
  const charScore = getCharacterScore(card.n);
  const appealScore = getAppealScore(card.n);

  const sf = Math.pow(PULL_MULT, pullCost);
  const targetPrice = getCurrentPrice(card);
  const impliedDes = Math.log(targetPrice / (BASE * sf)) / Math.log(DES_MULT);
  const clampedDes = Math.max(1, Math.min(10, impliedDes));

  const impliedArt = (clampedDes - charScore * WEIGHTS.char - appealScore * WEIGHTS.appeal) / WEIGHTS.art;
  const artScore = Math.max(1, Math.min(10, impliedArt));

  return {
    char: charScore,
    art: Math.round(artScore * 10) / 10,
    appeal: appealScore,
    total: clampedDes,
  };
}

// ---- Search ----
function buildSearchIndex(cards) {
  searchIndex = cards.map(c => ({
    ...c,
    _search: `${c.n} ${c.nj || ''} ${c.s} ${c.cn || ''} ${c.ns || ''} ${c.r || ''} ${c.sr || ''} ${c.lang || ''}`.toLowerCase(),
  }));
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
    results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-faint);font-size:13px;">No cards found — try a different name or card number</div>';
    results.classList.add('open');
    return;
  }

  results.innerHTML = matches.map(c => {
    const numLabel = c.cn && c.ct ? `#${c.cn}/${c.ct}` : c.cn ? `#${c.cn}` : '';
    const seriesLabel = c.sr && c.sr !== 'Scarlet & Violet' ? `<span class="meta-series">${esc(c.sr)}</span>` : '';
    const isJP = c.lang === 'JP';
    const langBadge = isJP ? '<span class="lang-badge jp">JP</span>' : '';
    const jpNameLabel = isJP && c.nj ? `<span class="jp-name">${esc(c.nj)}</span>` : '';
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
        <div class="search-result-name">${langBadge}${esc(c.n)}${jpNameLabel}</div>
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

// Fetch live pricing from PriceCharting JSON search API (works for both EN and JP)
// Returns { pcUngraded, pcPsa10, pcGrade9, pcName, pcConsole, pcId, pcImageUrl }
async function fetchPriceChartingData(card) {
  // Build search query: card name + card number + "japanese" for JP cards
  const name = card.n.replace(/\s*\(JP\)/, '').replace(/\s*#\d+/, '').trim();
  const num = card.cn ? ` ${card.cn}` : '';
  const lang = card.lang === 'JP' ? ' japanese' : '';
  const q = `${name}${num}${lang}`;
  
  const pcUrl = `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(q)}&format=json`;
  const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(pcUrl)}`;
  const r = await fetch(proxyUrl);
  if (!r.ok) throw new Error(`PriceCharting ${r.status}`);
  const data = await r.json();
  
  if (!data.products || data.products.length === 0) {
    return null;
  }

  // Pick the best match — for JP cards, prefer results with "Japanese" in consoleName
  let match = data.products[0];
  if (card.lang === 'JP') {
    const jpMatch = data.products.find(p => p.consoleName?.toLowerCase().includes('japanese'));
    if (jpMatch) match = jpMatch;
  }

  // Parse dollar prices — price1=ungraded, price2=PSA10, price3=Grade9
  const parsePrice = (s) => {
    if (!s) return 0;
    return parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
  };

  return {
    pcUngraded: parsePrice(match.price1),
    pcPsa10: parsePrice(match.price2),
    pcGrade9: parsePrice(match.price3),
    pcName: match.productName || '',
    pcConsole: match.consoleName || '',
    pcId: match.id || '',
    pcImageUrl: match.imageUri || '',
  };
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
    cmUpdated: '', cmUrl: '',
    pcUngraded: 0, pcPsa10: 0, pcGrade9: 0, pcName: '', pcConsole: '', pcId: '',
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

  return priceData;
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
      cmLink.href = data.cmUrl;
      cmLink.style.display = '';
    } else {
      cmLink.style.display = 'none';
    }
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
    // Link to PriceCharting product page
    const pcLink = $('priceChartingLink');
    if (data.pcId) {
      pcLink.href = `https://www.pricecharting.com/game/pokemon-japanese-${data.pcConsole ? data.pcConsole.toLowerCase().replace(/\s+/g, '-') : 'cards'}/${data.pcId}`;
      pcLink.style.display = '';
    } else {
      pcLink.style.display = 'none';
    }
  } else {
    pcRow.style.display = 'none';
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

  // Reset market dynamics section
  $('marketSection').style.display = 'none';
  $('marketContent').style.display = 'none';
  $('marketLoading').style.display = 'block';
  $('marketLoading').textContent = 'Loading market data...';
  $('marketTrend').textContent = '';
  $('marketTrend').className = 'market-trend-badge';
  $('gradeSection').style.display = 'none';

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
  if (!card || !setsData || !setsData[card.sc]) { section.style.display = 'none'; return; }

  const set = setsData[card.sc];
  const rarity = set.rarities?.[card.rc];
  if (!rarity || rarity.pullRate <= 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';

  const packsPerHit = Math.round(1 / rarity.pullRate);
  const packsNeeded = packsPerHit * rarity.count;
  const packCost = set.packCost || 4.50;
  const evPerPack = set.evPerPack || 0;

  const totalRipCost = packsNeeded * packCost;
  const evRecovered = packsNeeded * evPerPack;
  const netRipCost = totalRipCost - evRecovered;
  const singleCost = getCurrentPrice(card);

  const prob = 1 / packsNeeded;
  const luckyPacks = Math.ceil(Math.log(0.75) / Math.log(1 - prob));
  const unluckyPacks = Math.ceil(Math.log(0.25) / Math.log(1 - prob));
  const medianPacks = Math.ceil(Math.log(0.5) / Math.log(1 - prob));

  $('ripPackCost').textContent = fmtGBP(netRipCost);
  $('ripPackDetail').textContent = `${packsNeeded.toLocaleString()} packs × ${fmtGBP(packCost)}/pack`;
  $('ripPackSub').textContent = `Net after selling pulls (EV ${fmtGBP(evPerPack)}/pack)`;
  $('ripSingleCost').textContent = fmtGBP(singleCost);
  $('ripSingleDetail').textContent = livePrice ? 'Live market price' : 'Current market price';

  const savings = netRipCost - singleCost;
  const savingsGBP = usdToGbp(Math.abs(savings));
  const ripMultiple = netRipCost / singleCost;

  const badge = $('ripVerdict');
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
    $('ripSavings').innerHTML = `<span class="rip-save-rip">Ripping saves you £${savingsGBP.toFixed(0)}</span> vs buying`;
  }

  const luckyNet = (luckyPacks * packCost) - (luckyPacks * evPerPack);
  const medianNet = (medianPacks * packCost) - (medianPacks * evPerPack);
  const unluckyNet = (unluckyPacks * packCost) - (unluckyPacks * evPerPack);
  $('ripLuck').innerHTML = `
    <div class="rip-luck-row"><span class="rip-luck-label">Lucky (25th pct)</span><span>${luckyPacks.toLocaleString()} packs → net ${fmtGBP(luckyNet)}</span></div>
    <div class="rip-luck-row"><span class="rip-luck-label">Median</span><span>${medianPacks.toLocaleString()} packs → net ${fmtGBP(medianNet)}</span></div>
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

// ---- Events ----
function setupInputs() {
  ['packRate','cardsInTier','characterPremium','artworkHype','universalAppeal','ebayPrice']
    .forEach(id => $(id).addEventListener('input', updateAll));
}

// ---- Boot ----
init();
