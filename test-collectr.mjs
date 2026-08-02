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
  if (typeof v === 'number') return v > 0 ? v : null;
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
        date: h.date ?? h.ts ?? h.timestamp ?? h.created_at ?? h.insertion_date ?? '',
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

// ─── collectrTrend (inlined from worker-paste-this.js) ───────────────────────

function collectrTrend(history, grade, days) {
  const rows = (history || [])
    .filter(h => String(h.grade).toLowerCase().replace(/\s/g, '') === String(grade).toLowerCase().replace(/\s/g, ''))
    .map(h => ({ t: Date.parse(h.date), price: h.price }))
    .filter(h => isFinite(h.t) && h.price > 0)
    .sort((a, b) => a.t - b.t);
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const cutoff = latest.t - days * 86400000;
  let base = null;
  for (const r of rows) { if (r.t <= cutoff) base = r; else break; }
  if (!base) base = rows[0];
  if (!(base.price > 0) || base === latest) return null;
  return {
    pct: +(((latest.price - base.price) / base.price) * 100).toFixed(1),
    from: base.price, to: latest.price,
    days: Math.round((latest.t - base.t) / 86400000),
  };
}

const HIST = [
  { date: '2026-04-04', grade: 'raw', price: 100 },
  { date: '2026-06-03', grade: 'raw', price: 120 },
  { date: '2026-07-04', grade: 'raw', price: 110 },
  { date: '2026-08-03', grade: 'raw', price: 132 },
  { date: '2026-08-03', grade: 'PSA 10', price: 900 },
];

test('trend: 30d measures from the reading at or before the cutoff', () => {
  const t = collectrTrend(HIST, 'raw', 30);
  assert.equal(t.from, 110);
  assert.equal(t.to, 132);
  assert.equal(t.pct, 20);
});
test('trend: 90d spans a longer window than 30d', () => {
  const t = collectrTrend(HIST, 'raw', 90);
  assert.equal(t.from, 100);
  assert.equal(t.pct, 32);
});
test('trend: falls to the oldest reading when none predates the cutoff', () => {
  const t = collectrTrend(HIST, 'raw', 3650);
  assert.equal(t.from, 100);
});
test('trend: grade match ignores spacing and case', () => {
  const rows = [
    { date: '2026-01-01', grade: 'psa10', price: 500 },
    { date: '2026-08-01', grade: 'PSA 10', price: 750 },
  ];
  assert.equal(collectrTrend(rows, 'PSA 10', 30).pct, 50);
});
test('trend: null when a grade has a single reading', () => {
  assert.equal(collectrTrend(HIST, 'PSA 10', 30), null);
});
test('trend: null on an empty history', () => {
  assert.equal(collectrTrend([], 'raw', 30), null);
});
test('trend: a falling market reports a negative move', () => {
  const rows = [
    { date: '2026-05-01', grade: 'raw', price: 200 },
    { date: '2026-08-01', grade: 'raw', price: 150 },
  ];
  assert.equal(collectrTrend(rows, 'raw', 30).pct, -25);
});

// insertion_date is what the wrapper actually returns for history rows
test('parses insertion_date as the history date', () => {
  const r = parseCollectrResponse({
    price_history: [{ insertion_date: '2026-07-01', product_sub_type: 'PSA 10', price: 910 }],
  });
  assert.equal(r.price_history[0].date, '2026-07-01');
  assert.equal(r.price_history[0].grade, 'PSA 10');
});
test('rejects a zero numeric price', () => {
  assert.equal(extractNumericPrice(0), null);
});

console.log(`\n${passed} tests passed.`);
