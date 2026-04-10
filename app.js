/* ========================================
   Pokémon Card Price Predictor v5
   20k+ cards · All eras + Japanese search
   Auto-calibrated desirability · 5-year forecast
   Live GBP conversion · eBay deal checker
   ======================================== */

// ---- Model Constants ----
const BASE = 12.50;
const PULL_MULT = 1.19;
const DES_MULT = 1.41;
const WEIGHTS = { char: 0.45, art: 0.45, appeal: 0.10 };

// ---- Pokémon Popularity Tiers ----
// Based on market data, search trends, and historical card prices
const CHAR_TIERS = {
  S: { score: 9.5, names: ['charizard','pikachu','mewtwo','umbreon','mew','eevee'] },
  A: { score: 8.2, names: ['dragonite','gyarados','gengar','lugia','rayquaza','gardevoir','lucario','greninja','sylveon','magikarp','espeon','vaporeon','leafeon','flareon','jolteon','glaceon','meowth','snorlax','blastoise','venusaur'] },
  B: { score: 6.5, names: ['arcanine','ninetales','alakazam','machamp','lapras','tyranitar','celebi','suicune','entei','raikou','ho-oh','latios','latias','deoxys','dialga','palkia','giratina','darkrai','arceus','reshiram','zekrom','kyurem','xerneas','yveltal','zygarde','lunala','solgaleo','necrozma','zacian','zamazenta','calyrex','miraidon','koraidon','terapagos'] },
};

// Universal appeal tiers (Google Trends-based)
const APPEAL_TIERS = {
  S: { score: 9.5, names: ['charizard','pikachu','mewtwo','eevee','mew'] },
  A: { score: 7.5, names: ['gengar','umbreon','snorlax','gyarados','dragonite','gardevoir','lucario','greninja','blastoise','venusaur','magikarp','sylveon','arcanine'] },
};

// ---- Rarity Appreciation Rates (annual, post-stabilization) ----
// Calibrated from TCGPlayer trends, market research, mycollectrics data
const RARITY_RATES = {
  SIR: { base: 0.22, label: 'Special Illustration Rare' },
  HR:  { base: 0.18, label: 'Hyper Rare' },
  MHR: { base: 0.18, label: 'Mega Hyper Rare' },
  UR:  { base: 0.14, label: 'Ultra Rare' },
  IR:  { base: 0.16, label: 'Illustration Rare' },
  MAR: { base: 0.16, label: 'Master Art Rare' },
  SHR: { base: 0.15, label: 'Shiny Hyper Rare' },
  SHUR:{ base: 0.14, label: 'Shiny Ultra Rare' },
  BWR: { base: 0.13, label: 'Black & White Rare' },
  DR:  { base: 0.08, label: 'Double Rare' },
  AS:  { base: 0.06, label: 'ACE SPEC Rare' },
  '':  { base: 0.05, label: 'Other' },
};

// ---- State ----
let cardData = null;
let setsData = null;
let fxRate = 0.79;
let selectedCard = null;

const $ = id => document.getElementById(id);

// ---- Init ----
async function init() {
  const [cardsR, setsR, fxR] = await Promise.allSettled([
    fetch('data/cards-expanded.json').then(r => r.json()),
    fetch('data/sets-expanded.json').then(r => r.json()),
    fetch('https://open.er-api.com/v6/latest/USD').then(r => r.json()),
  ]);

  if (cardsR.status === 'fulfilled') cardData = cardsR.value;
  if (setsR.status === 'fulfilled') setsData = setsR.value;
  if (fxR.status === 'fulfilled' && fxR.value.rates?.GBP) fxRate = fxR.value.rates.GBP;

  // Build search index for fast filtering of 20k+ cards
  if (cardData) buildSearchIndex(cardData.cards);

  $('fxValue').textContent = `£${fxRate.toFixed(4)}`;
  if (cardData) $('searchCount').textContent = `${cardData.count.toLocaleString()} cards`;
  $('loadingOverlay').classList.add('hidden');

  setupSearch();
  setupInputs();
  updateAll();
}

// ---- Currency ----
function usdToGbp(usd) { return usd * fxRate; }
function fmtGBP(usd) { return `£${usdToGbp(usd).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtUSD(usd) { return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

// ---- Character Analysis ----
function extractPokemonName(cardName) {
  // Remove suffixes like "ex", "VMAX", "V", "#123", etc.
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
  for (const [, tier] of Object.entries(CHAR_TIERS)) {
    if (tier.names.some(n => name.includes(n))) return tier.score;
  }
  return 4.5; // Default for unknown Pokémon
}

function getAppealScore(cardName) {
  const name = extractPokemonName(cardName);
  for (const [, tier] of Object.entries(APPEAL_TIERS)) {
    if (tier.names.some(n => name.includes(n))) return tier.score;
  }
  return 4.0;
}

function getCharacterMultiplier(cardName) {
  const name = extractPokemonName(cardName);
  for (const [tier, data] of Object.entries(CHAR_TIERS)) {
    if (data.names.some(n => name.includes(n))) {
      return tier === 'S' ? 1.4 : tier === 'A' ? 1.2 : 1.0;
    }
  }
  return 0.85;
}

// ---- Auto-Desirability from Market ----
function calcImpliedDesirability(marketPriceUSD, pullCost) {
  if (marketPriceUSD <= 0 || pullCost <= 0) return 5;
  const supplyFactor = Math.pow(PULL_MULT, pullCost);
  const ratio = marketPriceUSD / (BASE * supplyFactor);
  if (ratio <= 0) return 1;
  const des = Math.log(ratio) / Math.log(DES_MULT);
  return Math.max(1, Math.min(10, des));
}

function autoFillDesirability(card, pullCost) {
  const implied = calcImpliedDesirability(card.p, pullCost);
  const charScore = getCharacterScore(card.n);
  const appealScore = getAppealScore(card.n);

  // Distribute: Character (45%) + Appeal (10%) are estimated from lookup
  // Artwork/Hype (45%) absorbs the rest to match the implied total
  const charContrib = charScore * WEIGHTS.char;
  const appealContrib = appealScore * WEIGHTS.appeal;
  const artNeeded = (implied - charContrib - appealContrib) / WEIGHTS.art;
  const artScore = Math.max(1, Math.min(10, artNeeded));

  return { char: charScore, art: Math.round(artScore * 10) / 10, appeal: appealScore, total: implied };
}

// ---- Search Index (for 20k+ cards) ----
let searchIndex = []; // pre-computed lowercase searchable text per card

function buildSearchIndex(cards) {
  searchIndex = cards.map(c => ({
    t: `${c.n} ${c.s} ${c.r} ${c.sc} ${c.sr || ''}`.toLowerCase(),
    cn: c.cn || 0,
    ct: c.ct || 0,
  }));
}

// ---- Search ----
function setupSearch() {
  const input = $('searchInput');
  const results = $('searchResults');
  const clearBtn = $('searchClear');
  let debounce = null;

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    clearBtn.style.display = input.value ? 'block' : 'none';
    debounce = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { results.classList.remove('open'); return; }
      showResults(q);
    }, 180);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) showResults(input.value.trim().toLowerCase());
  });
  clearBtn.addEventListener('click', () => {
    input.value = ''; clearBtn.style.display = 'none'; results.classList.remove('open'); input.focus();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-section')) results.classList.remove('open');
  });
}

function showResults(query) {
  if (!cardData || !searchIndex.length) return;
  const results = $('searchResults');
  const terms = query.split(/\s+/);

  // Detect card number patterns: "#125", "125/295", "125" (pure number)
  // Also detect set code + number: "PRE 161", "MEW #125"
  const numPatterns = terms.map(t => {
    const m = t.match(/^#?(\d+)(?:\/(\d+))?$/);
    return m ? { num: parseInt(m[1]), total: m[2] ? parseInt(m[2]) : null } : null;
  });
  const hasNumberQuery = numPatterns.some(p => p !== null);
  const textTerms = terms.filter((_, i) => !numPatterns[i]);
  const numberTerms = numPatterns.filter(p => p !== null);

  // Use pre-computed search index for fast filtering
  const matchIndices = [];
  const cards = cardData.cards;
  for (let idx = 0; idx < searchIndex.length; idx++) {
    const si = searchIndex[idx];

    // Text terms must all match
    let textOk = true;
    for (let j = 0; j < textTerms.length; j++) {
      if (!si.t.includes(textTerms[j])) { textOk = false; break; }
    }
    if (!textOk) continue;

    // Number terms must match card number
    if (numberTerms.length > 0) {
      let numOk = true;
      for (let j = 0; j < numberTerms.length; j++) {
        const nt = numberTerms[j];
        if (nt.total) {
          if (si.cn !== nt.num || si.ct !== nt.total) { numOk = false; break; }
        } else {
          if (si.cn !== nt.num) { numOk = false; break; }
        }
      }
      if (!numOk) continue;
    }

    matchIndices.push(idx);
    if (matchIndices.length > 200) break; // cap for perf
  }

  let matches = matchIndices.map(i => cards[i]);

  const CHASE = ['SIR','HR','UR','IR','MAR','SHR','SHUR','MHR','BWR'];
  matches.sort((a, b) => {
    const ac = CHASE.includes(a.rc) ? 1 : 0;
    const bc = CHASE.includes(b.rc) ? 1 : 0;
    if (bc !== ac) return bc - ac;
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
    return `
    <div class="search-result-item" data-id="${c.i}">
      ${c.img ? `<img class="search-result-img" src="${c.img}" alt="" loading="lazy">` : `<div class="search-result-img no-img"></div>`}
      <div class="search-result-info">
        <div class="search-result-name">${esc(c.n)}</div>
        <div class="search-result-meta">
          <span>${esc(c.s)}</span>
          ${numLabel ? `<span class="meta-num">${numLabel}</span>` : ''}
          ${c.r ? `<span style="color:var(--accent)">${esc(c.r)}</span>` : ''}
          ${seriesLabel}
        </div>
      </div>
      <div class="search-result-price">
        <span class="gbp">${fmtGBP(c.p)}</span>
        <span class="usd">${fmtUSD(c.p)}</span>
      </div>
    </div>
  `}).join('');

  results.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => selectCard(el.dataset.id));
  });
  results.classList.add('open');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ---- Card Selection ----
function selectCard(id) {
  if (!cardData) return;
  const card = cardData.cards.find(c => c.i === id);
  if (!card) return;
  selectedCard = card;

  $('searchResults').classList.remove('open');
  $('searchInput').value = card.n;

  const section = $('selectedCardSection');
  section.style.display = 'block';

  if (card.img) { $('cardImage').src = card.img; $('cardImage').style.display = 'block'; }
  else { $('cardImage').style.display = 'none'; }
  $('cardName').textContent = card.n;
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

  // Collectrics link: use mycollectrics ID if available, otherwise link to search
  if (card.mi) {
    $('linkCollectrics').href = `https://mycollectrics.com/card.html?id=${card.mi}`;
    $('linkCollectrics').style.display = '';
  } else {
    $('linkCollectrics').href = `https://mycollectrics.com/search.html?q=${encodeURIComponent(card.n)}`;
    $('linkCollectrics').style.display = '';
  }
  // TCG Collector link (international)
  const tcgName = card.n.replace(/#\d+/, '').replace(/\s+/g, ' ').trim();
  const tcgParams = new URLSearchParams({ cardName: tcgName });
  if (card.cn) tcgParams.set('displayNumber', String(card.cn));
  $('linkTcgCollector').href = `https://www.tcgcollector.com/cards/intl?${tcgParams.toString()}`;
  // TCG Collector Japanese link
  const jpParams = new URLSearchParams({ cardName: tcgName });
  if (card.cn) jpParams.set('displayNumber', String(card.cn));
  $('linkTcgJp').href = `https://www.tcgcollector.com/cards/jp?${jpParams.toString()}`;

  $('marketRawUSD').textContent = fmtUSD(card.p);
  $('marketRawGBP').textContent = fmtGBP(card.p);
  $('psa10USD').textContent = card.p10 > 0 ? fmtUSD(card.p10) : '—';
  $('psa10GBP').textContent = card.p10 > 0 ? fmtGBP(card.p10) : '—';
  $('gemPct').textContent = card.g ? `${(card.g * 100).toFixed(1)}%` : '—';

  // Auto-fill pull cost from set data
  let pullCost = 7.65; // default
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

  // Auto-fill desirability from market price
  const des = autoFillDesirability(card, pullCost);
  $('characterPremium').value = des.char;
  $('artworkHype').value = des.art;
  $('universalAppeal').value = des.appeal;

  updateAll();

  // Show forecast + rip-or-buy
  $('forecastSection').style.display = 'block';
  renderForecast(card, pullCost, des.total);
  updateRipOrBuy(card, pullCost);

  // Fetch live market dynamics from collectrics API (only for cards with mycollectrics ID)
  if (card.mi) {
    fetchMarketData(card.mi);
  } else {
    marketFetchId++; // invalidate any pending fetch
    $('marketSection').style.display = 'none';
    marketData = null;
  }

  if (window.innerWidth < 820) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  // Cards in early lifecycle may still be correcting
  const futureMonths = monthsOld + (yearsForward * 12);
  if (futureMonths < 6) return 0.6;
  if (futureMonths < 12) return 0.85;
  if (futureMonths < 24) return 1.0;
  if (futureMonths < 36) return 1.05;
  if (futureMonths < 48) return 1.1;
  return 1.15; // Scarcity premium kicks in for 4+ year old cards
}

function forecast(card, pullCost, desirability) {
  const rarityRate = (RARITY_RATES[card.rc] || RARITY_RATES['']).base;
  const charMult = getCharacterMultiplier(card.n);
  const ageMonths = getSetAgeMonths(card.sc);

  const currentPriceUSD = card.p;
  const years = [1, 2, 3, 4, 5];

  const scenarios = {
    conservative: [],
    expected: [],
    optimistic: [],
  };

  // Market momentum adjusts year 1 rate (fades out over subsequent years)
  const momentum = getMarketMomentum();

  years.forEach(y => {
    const ageMult = getAgeMultiplier(ageMonths, y);
    const annualRate = rarityRate * charMult * ageMult;

    // Momentum fades: full effect year 1, half year 2, none after
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

  // Render table
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

  // Render forecast info
  const rateLabel = (RARITY_RATES[card.rc] || RARITY_RATES['']).label;
  const charMult = fc.charMult;
  const annualPct = (fc.scenarios.expected[0].rate * 100).toFixed(1);
  const momLabel = fc.momentum?.label || '';
  $('forecastInfo').innerHTML = `
    <span>${rateLabel} base rate</span> ·
    <span>${charMult > 1 ? charMult.toFixed(1) + '× character premium' : 'Standard character'}</span> ·
    <span>${annualPct}% expected annual growth</span>
    ${momLabel ? `· <span style="color:${fc.momentum.mult > 1 ? 'var(--green)' : fc.momentum.mult < 1 ? 'var(--red)' : 'var(--text-muted)'}">${momLabel}</span>` : ''}
  `;

  // Draw chart
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

  // Data
  const current = usdToGbp(fc.currentPriceUSD);
  const allPrices = [current, ...fc.scenarios.optimistic.map(s => usdToGbp(s.priceUSD))];
  const maxP = Math.max(...allPrices) * 1.1;
  const minP = Math.min(current * 0.9, ...fc.scenarios.conservative.map(s => usdToGbp(s.priceUSD))) * 0.9;

  const pad = { l: 60, r: 20, t: 20, b: 36 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  function x(year) { return pad.l + (year / 5) * cw; }
  function y(price) { return pad.t + ch - ((price - minP) / (maxP - minP)) * ch; }

  // Grid lines
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

  // Year labels
  ctx.textAlign = 'center';
  ctx.fillStyle = '#555768';
  ctx.font = '11px Space Grotesk, sans-serif';
  for (let yr = 0; yr <= 5; yr++) {
    ctx.fillText(yr === 0 ? 'Now' : `${yr}yr`, x(yr), H - 8);
  }

  // Confidence band (conservative to optimistic)
  ctx.fillStyle = 'rgba(232, 182, 52, 0.06)';
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  for (let i = 0; i < 5; i++) ctx.lineTo(x(i + 1), y(usdToGbp(fc.scenarios.optimistic[i].priceUSD)));
  for (let i = 4; i >= 0; i--) ctx.lineTo(x(i + 1), y(usdToGbp(fc.scenarios.conservative[i].priceUSD)));
  ctx.lineTo(x(0), y(current));
  ctx.fill();

  // Conservative line (dashed)
  ctx.strokeStyle = 'rgba(138, 138, 138, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  fc.scenarios.conservative.forEach((s, i) => ctx.lineTo(x(i + 1), y(usdToGbp(s.priceUSD))));
  ctx.stroke();

  // Optimistic line (dashed)
  ctx.strokeStyle = 'rgba(232, 182, 52, 0.35)';
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  fc.scenarios.optimistic.forEach((s, i) => ctx.lineTo(x(i + 1), y(usdToGbp(s.priceUSD))));
  ctx.stroke();
  ctx.setLineDash([]);

  // Expected line (solid, bold)
  ctx.strokeStyle = '#e8b634';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x(0), y(current));
  fc.scenarios.expected.forEach((s, i) => ctx.lineTo(x(i + 1), y(usdToGbp(s.priceUSD))));
  ctx.stroke();

  // Current price dot
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(x(0), y(current), 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e8b634';
  ctx.beginPath(); ctx.arc(x(0), y(current), 3, 0, Math.PI * 2); ctx.fill();

  // 5-year expected dot + label
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

  // Update forecast + rip-or-buy if card selected
  if (selectedCard) {
    renderForecast(selectedCard, pullCost, des);
    updateRipOrBuy(selectedCard, pullCost);
  }
}

function updateMaxPrice(modelPriceUSD) {
  let maxUSD, logic;
  if (selectedCard) {
    const mkt = selectedCard.p;
    maxUSD = Math.min(modelPriceUSD, mkt);
    if (modelPriceUSD < mkt) logic = `Model says ${fmtGBP(modelPriceUSD)} — card appears overvalued vs market (${fmtGBP(mkt)})`;
    else if (modelPriceUSD > mkt * 1.1) logic = `Market price (${fmtGBP(mkt)}) — model sees upside to ${fmtGBP(modelPriceUSD)}`;
    else logic = `Market (${fmtGBP(mkt)}) and model (${fmtGBP(modelPriceUSD)}) agree — fairly valued`;
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
  const refUSD = selectedCard ? Math.min(modelPriceUSD, selectedCard.p) : modelPriceUSD;
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
  const singleCost = card.p;

  // Luck scenarios (geometric distribution)
  const prob = 1 / packsNeeded;
  const luckyPacks = Math.ceil(Math.log(0.75) / Math.log(1 - prob));
  const unluckyPacks = Math.ceil(Math.log(0.25) / Math.log(1 - prob));
  const medianPacks = Math.ceil(Math.log(0.5) / Math.log(1 - prob));

  $('ripPackCost').textContent = fmtGBP(netRipCost);
  $('ripPackDetail').textContent = `${packsNeeded.toLocaleString()} packs × ${fmtGBP(packCost)}/pack`;
  $('ripPackSub').textContent = `Net after selling pulls (EV ${fmtGBP(evPerPack)}/pack)`;
  $('ripSingleCost').textContent = fmtGBP(singleCost);
  $('ripSingleDetail').textContent = 'Current market price';

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
let marketData = null; // cached per card
let marketFetchId = 0; // guard against stale async results

async function fetchMarketData(cardId) {
  const thisId = ++marketFetchId;
  $('marketSection').style.display = 'block';
  $('marketLoading').style.display = 'block';
  $('marketContent').style.display = 'none';
  $('marketTrend').textContent = '';
  $('marketTrend').className = 'market-trend-badge';
  marketData = null;

  try {
    // Use CORS proxy to bypass cross-origin restriction on collectrics API
    const apiUrl = `https://mycollectrics.com/api/card/${cardId}?include=ebay`;
    const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(apiUrl)}`;
    const r = await fetch(proxyUrl);
    if (!r.ok) throw new Error('API error');
    const d = await r.json();
    if (thisId !== marketFetchId) return; // stale fetch, card changed
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

    // Re-render forecast with market momentum now available
    if (selectedCard) {
      const { pullCost } = calcPullCost();
      const des = calcDesirability();
      renderForecast(selectedCard, pullCost, des);
    }
  } catch (e) {
    $('marketLoading').textContent = 'Market data unavailable';
    console.warn('Market fetch failed:', e);
  }
}

function renderMarketDynamics(mp, ebayHist) {
  // Use estimated data (more accurate per PokeDataDadGuy)
  const est = mp.estimated || mp.observed;
  const obs = mp.observed;
  const d7 = est['7d'];
  const d30 = est['30d'];
  const baseline = est['baseline-comparison'] || obs?.['baseline-comparison'];

  if (!d7 || !d30) return;

  // Demand Pressure gauge (0-15% scale, higher = tighter market)
  const dp = (d7.metrics['demand-pressure-est'] || d7.metrics['demand-pressure'] || 0) * 100;
  const dpPct = Math.min(100, (dp / 15) * 100);
  $('gaugeDemand').style.width = `${dpPct}%`;
  $('demandValue').textContent = `${dp.toFixed(1)}%`;

  // Supply Saturation Index (0-2 scale, 1.0 = neutral, >1 = loosening, <1 = tightening)
  const ssi = baseline?.['supply-saturation-index'] ?? 1.0;
  const ssiPct = Math.min(100, Math.max(0, (ssi / 2) * 100));
  $('gaugeSupply').style.width = `${ssiPct}%`;
  $('supplyValue').textContent = ssi.toFixed(2);
  const ssiLabel = baseline?.['supply-saturation-label'] || (ssi < 0.8 ? 'tightening' : ssi > 1.2 ? 'loosening' : 'normal');
  $('supplyDesc').textContent = ssiLabel === 'normal' ? 'Balanced vs 30d' : ssiLabel === 'tightening' ? 'Supply tightening' : 'Supply loosening';

  // Trend badge
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

  // Market stats (7d averages)
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

  // Draw listing volume chart
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

  const data = history.slice(-30); // Last 30 days
  if (data.length < 2) return;

  const pad = { l: 36, r: 12, t: 10, b: 22 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  // Extract series
  const active = data.map(d => d['active-to'] || 0);
  const soldEst = data.map(d => d['sold-est'] || 0);
  const newL = data.map(d => d['new'] || 0);
  const maxVal = Math.max(...active, 1) * 1.15;
  const maxBar = Math.max(...soldEst, ...newL, 1) * 1.15;

  function x(i) { return pad.l + (i / (data.length - 1)) * cw; }
  function yLine(v) { return pad.t + ch - (v / maxVal) * ch; }
  function yBar(v) { return pad.t + ch - (v / maxVal) * ch; }

  // Grid
  ctx.strokeStyle = '#1e2030';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const gy = pad.t + (ch / 3) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#555768';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const val = maxVal * (1 - i / 3);
    ctx.fillText(Math.round(val).toString(), pad.l - 4, pad.t + (ch / 3) * i + 3);
  }

  // Bar width
  const bw = Math.max(2, (cw / data.length) * 0.3);

  // Sold bars (green)
  ctx.fillStyle = 'rgba(61, 214, 140, 0.5)';
  data.forEach((d, i) => {
    const v = d['sold-est'] || 0;
    const h = (v / maxVal) * ch;
    ctx.fillRect(x(i) - bw - 1, pad.t + ch - h, bw, h);
  });

  // New bars (grey)
  ctx.fillStyle = 'rgba(85, 87, 104, 0.5)';
  data.forEach((d, i) => {
    const v = d['new'] || 0;
    const h = (v / maxVal) * ch;
    ctx.fillRect(x(i) + 1, pad.t + ch - h, bw, h);
  });

  // Active line (blue)
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  active.forEach((v, i) => {
    const px = x(i), py = yLine(v);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Date labels
  ctx.fillStyle = '#555768';
  ctx.font = '9px Space Grotesk, sans-serif';
  ctx.textAlign = 'center';
  [0, Math.floor(data.length / 2), data.length - 1].forEach(i => {
    if (data[i]) {
      const d = data[i].date || '';
      const short = d.slice(5); // MM-DD
      ctx.fillText(short, x(i), H - 4);
    }
  });
}

// ---- Grading ROI ----
function renderGradingROI(apiData) {
  const section = $('gradeSection');
  const card = selectedCard;
  if (!card || !card.p10 || card.p10 <= 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  const rawPrice = card.p;
  const psa10Price = card.p10;
  const gemRate = card.g ? (card.g * 100).toFixed(1) : null;
  const gradingFee = 20; // PSA economy service ~$20

  const valueGain = psa10Price - rawPrice;
  const roi = ((valueGain - gradingFee) / (rawPrice + gradingFee)) * 100;
  const netProfit = valueGain - gradingFee;
  const multiplier = psa10Price / rawPrice;

  // Expected value accounting for gem rate
  let evGrade = null, evNote = '';
  if (gemRate !== null) {
    const gemPct = card.g;
    // If you get PSA 10: profit. If not (PSA 9 or lower): assume ~50% of raw as resale haircut
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
  // Returns a multiplier based on live market signals to adjust forecast
  if (!marketData) return { mult: 1.0, label: '' };
  const mp = marketData.collectrics?.['market-pressure'];
  if (!mp) return { mult: 1.0, label: '' };

  const est = mp.estimated || mp.observed;
  const baseline = est?.['baseline-comparison'];
  if (!baseline) return { mult: 1.0, label: '' };

  const trend = baseline.trend || 'stable';
  const ssi = baseline['supply-saturation-index'] ?? 1.0;
  const dpDelta = baseline['demand-delta-pct'] ?? 0;

  // Adjust year-1 forecast based on current market signals
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

// ---- Events ----
function setupInputs() {
  ['packRate','cardsInTier','characterPremium','artworkHype','universalAppeal','ebayPrice']
    .forEach(id => $(id).addEventListener('input', updateAll));
}

// ---- Boot ----
init();
