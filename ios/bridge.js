// The one entry point the iOS app calls. Everything below delegates to app.js's
// own functions — the model is never reimplemented, so the phone and the website
// cannot disagree about what a card is worth.
var __bridge = (function () {
  // app.js builds cardData inside init(), which also wires the whole UI and
  // cannot run headless. The catalogue is decoded directly instead, using
  // app.js's own decoder, so the rows are identical to the website's.
  function ensureData() {
    if (!cardData && typeof decodeCardDB === 'function' && typeof CARD_DB_RAW !== 'undefined') {
      try { cardData = decodeCardDB(CARD_DB_RAW); } catch (e) {}
    }
    if (typeof setsData !== 'undefined' && !setsData && typeof SETS_DB_RAW !== 'undefined') {
      try { setsData = SETS_DB_RAW; } catch (e) {}
    }
    return !!(cardData && cardData.cards && cardData.cards.length);
  }

  function cardById(id) {
    ensureData();
    // getCardById returns null headless: its index is built during init(),
    // which cannot run here. Fall through to the catalogue rather than
    // treating that null as "no such card".
    if (typeof getCardById === 'function') {
      try { var hit = getCardById(id); if (hit) return hit; } catch (e) {}
    }
    return (cardData && cardData.cards || []).find(function (c) { return c.i === id; }) || null;
  }

  function valuate(id) {
    if (!ensureData()) return { ok: false, why: 'Catalogue failed to load.' };
    var card = cardById(id);
    if (!card) return { ok: false, why: 'Card not found.' };

    var core;
    try { core = computeHoldCore(card); }
    catch (e) { return { ok: false, why: 'Model error: ' + e.message }; }
    if (!core || !core.ok) {
      return { ok: false, why: 'No raw price or PSA 10 anchor for this card, so there is nothing to compare.' };
    }

    var fx = (typeof fxRate === 'number' && fxRate > 0) ? fxRate : 0.79;
    var budget = (typeof BUDGET_DEFAULT === 'number') ? BUDGET_DEFAULT : 99999;

    var medals = { gold: null, silver: null, bronze: null, clearsBar: false };
    try {
      var pool = (typeof _slabOnlyCandidates === 'function')
        ? _slabOnlyCandidates(core.strategies, card, core.strategies, null)
        : core.strategies;
      medals = _medalPicks({
        pool: pool, allStrategies: core.strategies,
        bestPick: core.bestLongTermPick, bestPickOverBudget: false,
        maxBudgetGBP: budget, fx: fx, opts: { card: card, variant: 'unlimited' },
      }) || medals;
    } catch (e) { /* tiles still render without medals */ }

    var key = function (m) { return m && m.key ? m.key : null; };
    var g = key(medals.gold), s = key(medals.silver), b = key(medals.bronze);

    var stars = null;
    try { stars = getInvestmentStars(card, 5); } catch (e) {}

    var rows = (core.strategies || []).map(function (st) {
      return {
        key: st.key,
        label: st.label || st.key,
        allInGBP: (st.today || 0) * fx,
        roi: st.roi || 0,
        risk: st.risk || '',
        estimated: !!st.estimated,
        na: !!st.na,
        medal: st.key === g ? 'gold' : st.key === s ? 'silver' : st.key === b ? 'bronze' : null,
      };
    }).filter(function (r) { return !r.na && r.allInGBP > 0; });

    return {
      ok: true,
      rawGBP: (core.rawUSD || 0) * fx,
      psa10GBP: (core.psa10USD || 0) * fx,
      stars: stars ? (stars.stars || 0) : 0,
      starLabel: stars ? (stars.label || '') : '',
      clearsBar: !!medals.clearsBar,
      rows: rows,
    };
  }

  return { valuate: valuate, fx: function () { return (typeof fxRate === 'number') ? fxRate : 0; },
           setFx: function (v) { try { fxRate = v; } catch (e) {} },
           count: function () { ensureData(); return (cardData && cardData.cards) ? cardData.cards.length : 0; } };
})();
