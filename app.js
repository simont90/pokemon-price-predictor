/* ========================================
   Pokémon Card Price Prediction Model
   Based on PokeDataDadGuy's video
   ======================================== */

// Model constants (calibrated from video examples)
const BASE_CONSTANT = 12.50;
const PULL_COST_MULTIPLIER = 1.19;   // +19% per point
const DESIRABILITY_MULTIPLIER = 1.41; // +41% per point

// Component weights for desirability index
const WEIGHTS = {
  characterPremium: 0.45,
  artworkHype: 0.45,
  universalAppeal: 0.10
};

// DOM elements
const els = {
  packRate: document.getElementById('packRate'),
  cardsInTier: document.getElementById('cardsInTier'),
  pullCostDisplay: document.getElementById('pullCostDisplay'),
  packsNeeded: document.getElementById('packsNeeded'),
  characterPremium: document.getElementById('characterPremium'),
  artworkHype: document.getElementById('artworkHype'),
  universalAppeal: document.getElementById('universalAppeal'),
  characterPremiumValue: document.getElementById('characterPremiumValue'),
  artworkHypeValue: document.getElementById('artworkHypeValue'),
  universalAppealValue: document.getElementById('universalAppealValue'),
  desirabilityDisplay: document.getElementById('desirabilityDisplay'),
  desirabilityBar: document.getElementById('desirabilityBar'),
  predictedPrice: document.getElementById('predictedPrice'),
  supplyFactor: document.getElementById('supplyFactor'),
  demandFactor: document.getElementById('demandFactor'),
  marketPrice: document.getElementById('marketPrice'),
  valuationResult: document.getElementById('valuationResult'),
};

// ---- Calculations ----

function calcPullCost() {
  const packs = parseFloat(els.packRate.value) || 1;
  const cards = parseFloat(els.cardsInTier.value) || 1;
  const rawPacks = packs * cards;
  const pullCost = rawPacks / 100;
  return { pullCost, rawPacks };
}

function calcDesirability() {
  const char = parseFloat(els.characterPremium.value);
  const art = parseFloat(els.artworkHype.value);
  const appeal = parseFloat(els.universalAppeal.value);
  return (char * WEIGHTS.characterPremium) +
         (art * WEIGHTS.artworkHype) +
         (appeal * WEIGHTS.universalAppeal);
}

function predictPrice(pullCost, desirability) {
  const supplyFactor = Math.pow(PULL_COST_MULTIPLIER, pullCost);
  const demandFactor = Math.pow(DESIRABILITY_MULTIPLIER, desirability);
  const price = BASE_CONSTANT * supplyFactor * demandFactor;
  return { price, supplyFactor, demandFactor };
}

// ---- UI Updates ----

function updateAll() {
  // Pull cost
  const { pullCost, rawPacks } = calcPullCost();
  els.pullCostDisplay.textContent = pullCost.toFixed(2);
  els.packsNeeded.textContent = `≈ ${Math.round(rawPacks).toLocaleString()} packs to pull this specific card`;

  // Desirability
  const desirability = calcDesirability();
  els.desirabilityDisplay.textContent = desirability.toFixed(1);
  els.desirabilityBar.style.width = `${(desirability / 10) * 100}%`;

  // Slider value displays
  els.characterPremiumValue.textContent = parseFloat(els.characterPremium.value).toFixed(1);
  els.artworkHypeValue.textContent = parseFloat(els.artworkHype.value).toFixed(1);
  els.universalAppealValue.textContent = parseFloat(els.universalAppeal.value).toFixed(1);

  // Prediction
  const { price, supplyFactor, demandFactor } = predictPrice(pullCost, desirability);
  els.predictedPrice.textContent = `$${Math.round(price).toLocaleString()}`;
  els.supplyFactor.textContent = `×${supplyFactor.toFixed(2)}`;
  els.demandFactor.textContent = `×${demandFactor.toFixed(2)}`;

  // Valuation
  updateValuation(price);
}

function updateValuation(predictedPrice) {
  const marketVal = parseFloat(els.marketPrice.value);
  if (!marketVal || marketVal <= 0) {
    els.valuationResult.innerHTML = '<div class="valuation-placeholder">Enter a market price above to see if the card is overvalued or undervalued</div>';
    els.valuationResult.className = 'valuation-result';
    return;
  }

  const diff = predictedPrice - marketVal;
  const pctDiff = ((diff / marketVal) * 100);
  const absPct = Math.abs(pctDiff).toFixed(0);

  let statusClass, statusText, note;

  if (pctDiff > 10) {
    statusClass = 'undervalued';
    statusText = 'Undervalued';
    note = `Model predicts $${Math.round(predictedPrice).toLocaleString()} — market may be below fair value`;
  } else if (pctDiff < -10) {
    statusClass = 'overvalued';
    statusText = 'Overvalued';
    note = `Model predicts $${Math.round(predictedPrice).toLocaleString()} — market may be above fair value`;
  } else {
    statusClass = 'fairly-valued';
    statusText = 'Fairly Valued';
    note = `Market price is within ±10% of the model prediction`;
  }

  els.valuationResult.className = `valuation-result ${statusClass}`;
  els.valuationResult.innerHTML = `
    <div class="valuation-active">
      <div class="valuation-status">${statusText}</div>
      <div class="valuation-diff">${pctDiff > 0 ? '+' : ''}${absPct}%</div>
      <div class="valuation-note">${note}</div>
    </div>
  `;
}

// ---- Presets ----

function loadPreset(btn) {
  // Remove active from all
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // Set values
  els.packRate.value = btn.dataset.pack;
  els.cardsInTier.value = btn.dataset.tier;
  els.characterPremium.value = btn.dataset.char;
  els.artworkHype.value = btn.dataset.art;
  els.universalAppeal.value = btn.dataset.appeal;
  els.marketPrice.value = btn.dataset.market || '';

  updateAll();
}

// ---- Event Listeners ----

// Inputs that trigger recalculation
const allInputs = [
  els.packRate, els.cardsInTier,
  els.characterPremium, els.artworkHype, els.universalAppeal,
  els.marketPrice
];

allInputs.forEach(input => {
  input.addEventListener('input', () => {
    // Clear active preset
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    updateAll();
  });
});

// Preset buttons
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => loadPreset(btn));
});

// ---- Init ----
updateAll();
