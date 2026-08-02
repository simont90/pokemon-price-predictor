// Smoke test for the /collectr worker route.
// The pure helpers are inlined from worker-paste-this.js — keep them in step.
// Fixtures are real responses captured from the API, not invented shapes.
import assert from 'node:assert';

const COLLECTR_PSA_GRADE = {
  1: 'psa1', 2: 'psa1_5', 3: 'psa2',  4: 'psa3', 5: 'psa4', 6: 'psa5',
  7: 'psa6', 8: 'psa7',   9: 'psa8', 10: 'psa9', 11: 'psa10',
};
const COLLECTR_RAW_GRADE_ID = 52;

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
  const d = body?.data?.data ?? body?.data ?? body;
  if (!d) return null;
  const prints = {};
  const printOf = name => (prints[name] ||= {});
  for (const u of (d.ungraded_sub_types || [])) {
    const p = extractNumericPrice(u.market_price ?? u.price);
    if (p != null) printOf(u.product_sub_type || 'default').raw = p;
  }
  for (const g of (d.graded_sub_types || [])) {
    const key = COLLECTR_PSA_GRADE[parseInt(g.grade_id, 10)];
    if (!key) continue;
    const p = extractNumericPrice(g.market_price ?? g.price);
    if (p != null) printOf(g.product_sub_type || 'default')[key] = p;
  }
  if (!Object.keys(prints).length) {
    const p = extractNumericPrice(d.market_price);
    if (p != null) printOf('default').raw = p;
  }
  const price_history = (Array.isArray(d.price_history) ? d.price_history : [])
    .map(h => {
      const id = parseInt(h.grade_id, 10);
      return {
        date:  h.insertion_date ?? h.date ?? '',
        print: h.product_sub_type || 'default',
        grade: id === COLLECTR_RAW_GRADE_ID ? 'raw' : (COLLECTR_PSA_GRADE[id] || null),
        price: extractNumericPrice(h.price) ?? 0,
      };
    })
    .filter(h => h.price > 0 && h.grade && h.date);
  return {
    card_name: d.product_name ?? '',
    set_name:  d.catalog_group ?? '',
    card_number: d.card_number ?? null,
    rarity: d.rarity ?? null,
    currency: 'USD',
    prints,
    price_history,
  };
}

function collectrTrend(history, grade, days, print) {
  const rows = (history || [])
    .filter(h => h.grade === grade && (!print || h.print === print))
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

// Real response, Fossil Gengar #5 (product 106521), trimmed.
const GENGAR = { status: 'success', data: {
  product_id: '106521', product_name: 'Gengar', catalog_group: 'Fossil',
  card_number: '5', rarity: 'Holo Rare', market_price: '601.4900',
  product_sub_types: ['Unlimited Holofoil', '1st Edition Holofoil'],
  price_history: [
    { product_sub_type: 'Unlimited Holofoil',   grade_id: '52', insertion_date: '2026-08-01T00:00:00.000Z', price: '210.9200' },
    { product_sub_type: '1st Edition Holofoil', grade_id: '52', insertion_date: '2026-08-01T00:00:00.000Z', price: '601.4900' },
    { product_sub_type: '1st Edition Holofoil', grade_id: '52', insertion_date: '2026-07-31T00:00:00.000Z', price: '429.7460' },
    { product_sub_type: 'Unlimited Holofoil',   grade_id: '9',  insertion_date: '2026-07-31T00:00:00.000Z', price: '341.7001' },
    { product_sub_type: '1st Edition Holofoil', grade_id: '78', insertion_date: '2026-07-31T00:00:00.000Z', price: '240.0000' },
  ],
  ungraded_sub_types: [
    { product_sub_type: '1st Edition Holofoil', market_price: '601.4900' },
    { product_sub_type: 'Unlimited Holofoil',   market_price: '210.9200' },
  ],
  graded_sub_types: [
    { product_sub_type: '1st Edition Holofoil', grade_id: '3',  market_price: '157.5000' },
    { product_sub_type: '1st Edition Holofoil', grade_id: '5',  market_price: '294.3333' },
    { product_sub_type: '1st Edition Holofoil', grade_id: '8',  market_price: '689.8990' },
    { product_sub_type: '1st Edition Holofoil', grade_id: '9',  market_price: '983.5150' },
    { product_sub_type: '1st Edition Holofoil', grade_id: '11', market_price: '2630.1731' },
  ],
}};

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

test('extracts product id from a Collectr URL', () => {
  assert.equal(extractCollectrProductId('https://app.getcollectr.com/explore/product/106521'), '106521');
});
test('rejects a look-alike host', () => {
  assert.equal(extractCollectrProductId('https://evil.com/explore/product/1'), null);
});
test('rejects a Collectr URL with no product path', () => {
  assert.equal(extractCollectrProductId('https://app.getcollectr.com/collection'), null);
});
test('handles a string price with a currency symbol', () => {
  assert.equal(extractNumericPrice('$12.50'), 12.5);
});
test('treats zero as no price', () => { assert.equal(extractNumericPrice('0'), null); });

test('splits prices by print', () => {
  const r = parseCollectrResponse(GENGAR);
  assert.deepEqual(Object.keys(r.prints).sort(), ['1st Edition Holofoil', 'Unlimited Holofoil']);
  assert.equal(r.prints['Unlimited Holofoil'].raw, 210.92);
  assert.equal(r.prints['1st Edition Holofoil'].raw, 601.49);
});
test('maps grade ids onto PSA grades', () => {
  const p = parseCollectrResponse(GENGAR).prints['1st Edition Holofoil'];
  assert.equal(p.psa2, 157.50);   // verified exact against PriceCharting Grade 2
  assert.equal(p.psa4, 294.3333);
  assert.equal(p.psa7, 689.899);
  assert.equal(p.psa8, 983.515);
  assert.equal(p.psa10, 2630.1731);
});
test('ignores grade ids belonging to other grading companies', () => {
  const r = parseCollectrResponse(GENGAR);
  assert.equal(r.price_history.some(h => h.price === 240), false);  // id 78
});
test('reads the set from catalog_group', () => {
  assert.equal(parseCollectrResponse(GENGAR).set_name, 'Fossil');
});
test('treats grade id 52 as the raw price', () => {
  const r = parseCollectrResponse(GENGAR);
  const raws = r.price_history.filter(h => h.grade === 'raw');
  assert.equal(raws.length, 3);
});
test('unwraps the status/data envelope', () => {
  assert.equal(parseCollectrResponse(GENGAR).card_name, 'Gengar');
});
test('returns null for an empty body', () => { assert.equal(parseCollectrResponse(null), null); });

test('trend is measured within one print', () => {
  const r = parseCollectrResponse(GENGAR);
  const t = collectrTrend(r.price_history, 'raw', 30, '1st Edition Holofoil');
  assert.equal(t.from, 429.746);
  assert.equal(t.to, 601.49);
  assert.equal(t.pct, 40);
});
test('a print with one reading has no trend', () => {
  const r = parseCollectrResponse(GENGAR);
  assert.equal(collectrTrend(r.price_history, 'raw', 30, 'Unlimited Holofoil'), null);
});
test('a falling market reports a negative move', () => {
  const rows = [
    { date: '2026-05-01', print: 'p', grade: 'psa10', price: 200 },
    { date: '2026-08-01', print: 'p', grade: 'psa10', price: 150 },
  ];
  assert.equal(collectrTrend(rows, 'psa10', 30, 'p').pct, -25);
});
test('trend is null on an empty history', () => {
  assert.equal(collectrTrend([], 'raw', 30, 'p'), null);
});

console.log(`\n${passed} tests passed.`);
