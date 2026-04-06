/* ========================================
   Pokémon Card Price Predictor v2
   Live data from mycollectrics + tcgcollector
   GBP conversion · eBay deal checker
   ======================================== */

// Model constants
const BASE = 12.50;
const PULL_MULT = 1.19;
const DES_MULT = 1.41;
const WEIGHTS = { char: 0.45, art: 0.45, appeal: 0.10 };

// State
let cardData = null;
let setsData = null;
let fxRate = 0.79; // fallback USD→GBP
let selectedCard = null;

// DOM cache
const $ = id => document.getElementById(id);

// ---- Init ----
async function init() {
  // Load data in parallel
  const [cardsResp, setsResp, fxResp] = await Promise.allSettled([
    fetch('data/cards.json').then(r => r.json()),
    fetch('data/sets.json').then(r => r.json()),
    fetch('https://open.er-api.com/v6/latest/USD').then(r => r.json()),
  ]);

  if (cardsResp.status === 'fulfilled') {
    cardData = cardsResp.value;
    $('searchCount').textContent = `${cardData.count.toLocaleString()} cards`;
  }

  if (setsResp.status === 'fulfilled') {
    setsData = setsResp.value;
  }

  if (fxResp.status === 'fulfilled' && fxResp.value.rates?.GBP) {
    fxRate = fxResp.value.rates.GBP;
  }

  $('fxValue').textContent = `£${fxRate.toFixed(4)}`;
  $('loadingOverlay').classList.add('hidden');

  // Wire up events
  setupSearch();
  setupInputs();
  updateAll();
}

// ---- Currency ----
function usdToGbp(usd) { return usd * fxRate; }
function fmtGBP(usd) { return `£${usdToGbp(usd).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtUSD(usd) { return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

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
    input.value = '';
    clearBtn.style.display = 'none';
    results.classList.remove('open');
    input.focus();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-section')) results.classList.remove('open');
  });
}

function showResults(query) {
  if (!cardData) return;
  const results = $('searchResults');
  const terms = query.split(/\s+/);

  // Filter + rank
  let matches = cardData.cards.filter(c => {
    const text = `${c.n} ${c.s} ${c.r}`.toLowerCase();
    return terms.every(t => text.includes(t));
  });

  // Sort: prioritize cards with rarity (chase cards), then by price
  matches.sort((a, b) => {
    const aChase = a.rc && ['SIR','HR','UR','IR','MAR','SHR','SHUR','MHR','BWR'].includes(a.rc) ? 1 : 0;
    const bChase = b.rc && ['SIR','HR','UR','IR','MAR','SHR','SHUR','MHR','BWR'].includes(b.rc) ? 1 : 0;
    if (bChase !== aChase) return bChase - aChase;
    return b.p - a.p;
  });

  matches = matches.slice(0, 30);

  if (matches.length === 0) {
    results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-faint);font-size:13px;">No cards found</div>';
    results.classList.add('open');
    return;
  }

  results.innerHTML = matches.map(c => `
    <div class="search-result-item" data-id="${c.i}">
      ${c.img ? `<img class="search-result-img" src="${c.img}" alt="" loading="lazy">` : `<div class="search-result-img no-img">No img</div>`}
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

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---- Card Selection ----
function selectCard(id) {
  if (!cardData) return;
  const card = cardData.cards.find(c => c.i === id);
  if (!card) return;

  selectedCard = card;

  // Close search
  $('searchResults').classList.remove('open');
  $('searchInput').value = card.n;

  // Show card section
  const section = $('selectedCardSection');
  section.style.display = 'block';

  // Card info
  if (card.img) {
    $('cardImage').src = card.img;
    $('cardImage').alt = card.n;
    $('cardImage').style.display = 'block';
  } else {
    $('cardImage').style.display = 'none';
  }
  $('cardName').textContent = card.n;
  $('cardSet').textContent = card.s;
  $('cardRarity').textContent = card.r || 'Unknown';

  // Links
  $('linkCollectrics').href = `https://mycollectrics.com/card.html?id=${card.i}`;

  // Build tcgcollector search URL
  const tcgSearchName = card.n.replace(/#\d+/, '').replace(/\s+/g, ' ').trim();
  $('linkTcgCollector').href = `https://www.tcgcollector.com/cards/intl?cardName=${encodeURIComponent(tcgSearchName)}`;

  // Prices
  $('marketRawUSD').textContent = fmtUSD(card.p);
  $('marketRawGBP').textContent = fmtGBP(card.p);
  $('psa10USD').textContent = card.p10 > 0 ? fmtUSD(card.p10) : '—';
  $('psa10GBP').textContent = card.p10 > 0 ? fmtGBP(card.p10) : '—';
  $('gemPct').textContent = card.g ? `${(card.g * 100).toFixed(1)}%` : '—';

  // Auto-fill pull cost from set data
  if (setsData && setsData[card.sc]) {
    const set = setsData[card.sc];
    const rarity = set.rarities[card.rc];
    if (rarity && rarity.pullRate > 0) {
      const packsPerHit = Math.round(1 / rarity.pullRate);
      $('packRate').value = packsPerHit;
      $('cardsInTier').value = rarity.count;

      const totalPacks = packsPerHit * rarity.count;
      const pullCost = (totalPacks / 100).toFixed(2);
      $('autoPullCost').textContent = pullCost;
      $('autoPullPacks').textContent = `≈ ${totalPacks.toLocaleString()} packs`;
    }
  }

  updateAll();

  // Scroll to card section on mobile
  if (window.innerWidth < 820) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---- Calculations ----
function calcPullCost() {
  const packs = parseFloat($('packRate').value) || 1;
  const cards = parseFloat($('cardsInTier').value) || 1;
  const raw = packs * cards;
  return { pullCost: raw / 100, rawPacks: raw };
}

function calcDesirability() {
  const ch = parseFloat($('characterPremium').value);
  const ar = parseFloat($('artworkHype').value);
  const ap = parseFloat($('universalAppeal').value);
  return (ch * WEIGHTS.char) + (ar * WEIGHTS.art) + (ap * WEIGHTS.appeal);
}

function predictPrice(pullCost, desirability) {
  const sf = Math.pow(PULL_MULT, pullCost);
  const df = Math.pow(DES_MULT, desirability);
  return { priceUSD: BASE * sf * df, sf, df };
}

// ---- UI Update ----
function updateAll() {
  const { pullCost, rawPacks } = calcPullCost();
  $('pullCostDisplay').textContent = pullCost.toFixed(2);
  $('packsNeeded').textContent = `≈ ${Math.round(rawPacks).toLocaleString()} packs for this specific card`;

  // Desirability
  const des = calcDesirability();
  $('desirabilityDisplay').textContent = des.toFixed(1);
  $('desirabilityBar').style.width = `${(des / 10) * 100}%`;
  $('characterPremiumValue').textContent = parseFloat($('characterPremium').value).toFixed(1);
  $('artworkHypeValue').textContent = parseFloat($('artworkHype').value).toFixed(1);
  $('universalAppealValue').textContent = parseFloat($('universalAppeal').value).toFixed(1);

  // Prediction
  const { priceUSD, sf, df } = predictPrice(pullCost, des);
  const priceGBP = usdToGbp(priceUSD);
  $('predictedPriceGBP').textContent = `£${Math.round(priceGBP).toLocaleString()}`;
  $('predictedPriceUSD').textContent = `≈ ${fmtUSD(priceUSD)}`;
  $('supplyFactor').textContent = `×${sf.toFixed(2)}`;
  $('demandFactor').textContent = `×${df.toFixed(2)}`;

  // Max buy price
  updateMaxPrice(priceUSD);

  // eBay deal check
  updateDealCheck(priceUSD);
}

function updateMaxPrice(modelPriceUSD) {
  let maxUSD;
  let logic;

  if (selectedCard) {
    const marketUSD = selectedCard.p;
    // Max price = lower of model prediction and market price (conservative)
    maxUSD = Math.min(modelPriceUSD, marketUSD);

    if (modelPriceUSD < marketUSD) {
      logic = `Based on model prediction (${fmtGBP(modelPriceUSD)}) — model says card is overvalued vs market (${fmtGBP(marketUSD)})`;
    } else if (modelPriceUSD > marketUSD * 1.1) {
      logic = `Based on market price (${fmtGBP(marketUSD)}) — model suggests upside to ${fmtGBP(modelPriceUSD)}`;
    } else {
      logic = `Market (${fmtGBP(marketUSD)}) and model (${fmtGBP(modelPriceUSD)}) agree — fairly valued`;
    }
  } else {
    maxUSD = modelPriceUSD;
    logic = 'Based on model prediction only. Select a card for market comparison.';
  }

  const maxGBP = usdToGbp(maxUSD);
  $('maxPriceGBP').textContent = `£${maxGBP.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $('maxPriceLogic').textContent = logic;
}

function updateDealCheck(modelPriceUSD) {
  const ebayGBP = parseFloat($('ebayPrice').value);
  if (!ebayGBP || ebayGBP <= 0) {
    $('dealResult').innerHTML = '<div class="deal-placeholder">Enter an eBay price to check</div>';
    $('dealResult').className = 'deal-result';
    return;
  }

  // Convert eBay GBP to USD for comparison
  const ebayUSD = ebayGBP / fxRate;

  // Compare against max buy price
  let referenceUSD = selectedCard ? Math.min(modelPriceUSD, selectedCard.p) : modelPriceUSD;
  const referenceGBP = usdToGbp(referenceUSD);

  const diff = referenceGBP - ebayGBP;
  const pct = ((diff / ebayGBP) * 100).toFixed(0);

  let cls, verdict, note;
  if (diff > referenceGBP * 0.05) {
    cls = 'good-deal';
    verdict = 'Good Deal';
    note = `${Math.abs(pct)}% below max buy price of ${fmtGBP(referenceUSD)}`;
  } else if (diff < -referenceGBP * 0.05) {
    cls = 'bad-deal';
    verdict = 'Too Expensive';
    note = `${Math.abs(pct)}% above max buy price of ${fmtGBP(referenceUSD)}`;
  } else {
    cls = 'ok-deal';
    verdict = 'Fair Price';
    note = `Within 5% of max buy price (${fmtGBP(referenceUSD)})`;
  }

  $('dealResult').className = `deal-result ${cls}`;
  $('dealResult').innerHTML = `
    <div class="deal-active">
      <div class="deal-verdict">${verdict}</div>
      <div class="deal-saving">${diff > 0 ? 'Save' : 'Over by'} £${Math.abs(diff).toFixed(2)}</div>
      <div class="deal-note">${note}</div>
    </div>
  `;
}

// ---- Events ----
function setupInputs() {
  const ids = ['packRate', 'cardsInTier', 'characterPremium', 'artworkHype', 'universalAppeal', 'ebayPrice'];
  ids.forEach(id => $(id).addEventListener('input', updateAll));
}

// ---- Boot ----
init();
