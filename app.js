/* ========================================
   Pokémon Card Price Predictor v3
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
    fetch('data/cards.json').then(r => r.json()),
    fetch('data/sets.json').then(r => r.json()),
    fetch('https://open.er-api.com/v6/latest/USD').then(r => r.json()),
  ]);

  if (cardsR.status === 'fulfilled') cardData = cardsR.value;
  if (setsR.status === 'fulfilled') setsData = setsR.value;
  if (fxR.status === 'fulfilled' && fxR.value.rates?.GBP) fxRate = fxR.value.rates.GBP;

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
    }, 150);
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
  if (!cardData) return;
  const results = $('searchResults');
  const terms = query.split(/\s+/);

  let matches = cardData.cards.filter(c => {
    const text = `${c.n} ${c.s} ${c.r}`.toLowerCase();
    return terms.every(t => text.includes(t));
  });

  const CHASE = ['SIR','HR','UR','IR','MAR','SHR','SHUR','MHR','BWR'];
  matches.sort((a, b) => {
    const ac = CHASE.includes(a.rc) ? 1 : 0;
    const bc = CHASE.includes(b.rc) ? 1 : 0;
    if (bc !== ac) return bc - ac;
    return b.p - a.p;
  });
  matches = matches.slice(0, 30);

  if (!matches.length) {
    results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-faint);font-size:13px;">No cards found</div>';
    results.classList.add('open');
    return;
  }

  results.innerHTML = matches.map(c => `
    <div class="search-result-item" data-id="${c.i}">
      ${c.img ? `<img class="search-result-img" src="${c.img}" alt="" loading="lazy">` : `<div class="search-result-img no-img"></div>`}
      <div class="search-result-info">
        <div class="search-result-name">${esc(c.n)}</div>
        <div class="search-result-meta">
          <span>${esc(c.s)}</span>
          ${c.r ? `<span style="color:var(--accent)">${esc(c.r)}</span>` : ''}
        </div>
      </div>
      <div class="search-result-price">
        <span class="gbp">${fmtGBP(c.p)}</span>
        <span class="usd">${fmtUSD(c.p)}</span>
      </div>
    </div>
  `).join('');

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
  $('cardRarity').textContent = card.r || 'Unknown';

  $('linkCollectrics').href = `https://mycollectrics.com/card.html?id=${card.i}`;
  const tcgName = card.n.replace(/#\d+/, '').replace(/\s+/g, ' ').trim();
  $('linkTcgCollector').href = `https://www.tcgcollector.com/cards/intl?cardName=${encodeURIComponent(tcgName)}`;

  $('marketRawUSD').textContent = fmtUSD(card.p);
  $('marketRawGBP').textContent = fmtGBP(card.p);
  $('psa10USD').textContent = card.p10 > 0 ? fmtUSD(card.p10) : '—';
  $('psa10GBP').textContent = card.p10 > 0 ? fmtGBP(card.p10) : '—';
  $('gemPct').textContent = card.g ? `${(card.g * 100).toFixed(1)}%` : '—';

  // Auto-fill pull cost from set data
  let pullCost = 7.65; // default
  if (setsData && setsData[card.sc]) {
    const set = setsData[card.sc];
    const rarity = set.rarities[card.rc];
    if (rarity && rarity.pullRate > 0) {
      const packsPerHit = Math.round(1 / rarity.pullRate);
      $('packRate').value = packsPerHit;
      $('cardsInTier').value = rarity.count;
      const totalPacks = packsPerHit * rarity.count;
      pullCost = totalPacks / 100;
      $('autoPullCost').textContent = pullCost.toFixed(2);
      $('autoPullPacks').textContent = `≈ ${totalPacks.toLocaleString()} packs`;
    }
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
  const released = setsData[setCode].released;
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

  years.forEach(y => {
    const ageMult = getAgeMultiplier(ageMonths, y);
    const annualRate = rarityRate * charMult * ageMult;

    scenarios.conservative.push({
      year: y,
      priceUSD: currentPriceUSD * Math.pow(1 + annualRate * 0.5, y),
      rate: annualRate * 0.5,
    });
    scenarios.expected.push({
      year: y,
      priceUSD: currentPriceUSD * Math.pow(1 + annualRate, y),
      rate: annualRate,
    });
    scenarios.optimistic.push({
      year: y,
      priceUSD: currentPriceUSD * Math.pow(1 + annualRate * 1.6, y),
      rate: annualRate * 1.6,
    });
  });

  return { currentPriceUSD, scenarios, rarityRate, charMult, ageMonths };
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
  $('forecastInfo').innerHTML = `
    <span>${rateLabel} base rate</span> ·
    <span>${charMult > 1 ? charMult.toFixed(1) + '× character premium' : 'Standard character'}</span> ·
    <span>${annualPct}% expected annual growth</span>
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
  const rarity = set.rarities[card.rc];
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

// ---- Events ----
function setupInputs() {
  ['packRate','cardsInTier','characterPremium','artworkHype','universalAppeal','ebayPrice']
    .forEach(id => $(id).addEventListener('input', updateAll));
}

// ---- Boot ----
init();
