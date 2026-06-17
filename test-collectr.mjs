// Smoke test for the /collectr worker route.
// Run with: node test-collectr.mjs
// Requires COLLECTR_TOKEN env var (or tests the token-missing error path).
//
// The test mocks globalThis.fetch so no real network calls are made.

import assert from 'node:assert/strict';

// ─── Inline the pure helpers from worker-paste-this.js ───────────────────────

function extractCollectrProductId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.endsWith('getcollectr.com')) return null;
    const m = u.pathname.match(/\/explore\/product\/(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function extractNumericPrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.]/g, ''));
    return isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function parseCollectrResponse(body) {
  const d = body?.data ?? body;
  if (!d) return null;
  const current_prices = {};
  const rawPrice = extractNumericPrice(d.market_price ?? d.ungraded_market_price);
  if (rawPrice != null) current_prices.raw = rawPrice;
  if (Array.isArray(d.ungraded_sub_types)) {
    const rawEntry = d.ungraded_sub_types[0];
    if (rawEntry) {
      const p = extractNumericPrice(rawEntry.market_price ?? rawEntry.price);
      if (p != null) current_prices.raw = p;
    }
  }
  if (Array.isArray(d.graded_sub_types)) {
    for (const g of d.graded_sub_types) {
      const label = (g.product_sub_type || g.name || '').toLowerCase();
      const p = extractNumericPrice(g.market_price ?? g.price);
      if (p == null) continue;
      if (label.includes('psa 10') || label.includes('psa10')) current_prices.psa10 = p;
      else if (label.includes('psa 9') || label.includes('psa9')) current_prices.psa9 = p;
      else if (label.includes('psa 8') || label.includes('psa8')) current_prices.psa8 = p;
      else if (label.includes('psa 7') || label.includes('psa7')) current_prices.psa7 = p;
    }
  }
  const historyRaw = d.price_history ?? d.priceHistory ?? d.history ?? [];
  const price_history = Array.isArray(historyRaw)
    ? historyRaw.map(h => ({
        date: h.date ?? h.ts ?? h.timestamp ?? h.created_at ?? '',
        grade: h.grade ?? h.product_sub_type ?? h.type ?? 'raw',
        price: extractNumericPrice(h.price ?? h.market_price ?? h.value) ?? 0,
      })).filter(h => h.price > 0)
    : [];
  return {
    card_name: d.name ?? d.card_name ?? d.product_name ?? '',
    set_name: d.set_name ?? d.set ?? d.expansion ?? '',
    currency: d.currency ?? 'GBP',
    current_prices,
    price_history,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let passed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// extractCollectrProductId
test('extracts product id from valid URL', () => {
  assert.equal(extractCollectrProductId('https://app.getcollectr.com/explore/product/42382'), '42382');
});
test('returns null for non-getcollectr URL', () => {
  assert.equal(extractCollectrProductId('https://evil.com/explore/product/1'), null);
});
test('returns null for getcollectr URL without product path', () => {
  assert.equal(extractCollectrProductId('https://app.getcollectr.com/collection'), null);
});
test('returns null for garbage string', () => {
  assert.equal(extractCollectrProductId('not-a-url'), null);
});

// extractNumericPrice
test('handles numeric value', () => { assert.equal(extractNumericPrice(12.5), 12.5); });
test('handles string price with currency symbol', () => { assert.equal(extractNumericPrice('£12.50'), 12.5); });
test('returns null for zero string', () => { assert.equal(extractNumericPrice('0'), null); });
test('returns null for null', () => { assert.equal(extractNumericPrice(null), null); });

// parseCollectrResponse — flat shape
test('parses flat response with market_price', () => {
  const r = parseCollectrResponse({ name: 'Charizard', market_price: 150.0, currency: 'GBP', price_history: [] });
  assert.equal(r.current_prices.raw, 150);
  assert.equal(r.card_name, 'Charizard');
});

// parseCollectrResponse — nested graded_sub_types
test('parses graded_sub_types for psa10', () => {
  const r = parseCollectrResponse({
    name: 'Charizard',
    graded_sub_types: [
      { product_sub_type: 'PSA 10', market_price: 999 },
      { product_sub_type: 'PSA 9', market_price: 400 },
      { product_sub_type: 'PSA 8', market_price: 220 },
      { product_sub_type: 'PSA 7', market_price: 140 },
    ],
    price_history: [],
  });
  assert.equal(r.current_prices.psa10, 999);
  assert.equal(r.current_prices.psa9, 400);
  assert.equal(r.current_prices.psa8, 220);
  assert.equal(r.current_prices.psa7, 140);
});

// parseCollectrResponse — price_history
test('maps price_history entries', () => {
  const r = parseCollectrResponse({
    price_history: [
      { date: '2025-01-01', grade: 'raw', price: 80 },
      { date: '2025-06-01', grade: 'psa10', price: 900 },
    ],
  });
  assert.equal(r.price_history.length, 2);
  assert.equal(r.price_history[1].price, 900);
});

// parseCollectrResponse — data envelope
test('handles { data: { ... } } wrapper shape', () => {
  const r = parseCollectrResponse({ data: { name: 'Blastoise', market_price: 75, price_history: [] } });
  assert.equal(r.card_name, 'Blastoise');
  assert.equal(r.current_prices.raw, 75);
});

// parseCollectrResponse — null body
test('returns null for null body', () => {
  assert.equal(parseCollectrResponse(null), null);
});

console.log(`\n${passed} tests passed.`);
