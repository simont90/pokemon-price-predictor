import { readFileSync } from 'node:fs';
const src = readFileSync('worker-paste-this.js', 'utf8');
const grab = n => { const i = src.indexOf(n); const s = src.lastIndexOf('\n', i); 
  let d = 0, j = src.indexOf('{', i); let k = j;
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0 && k < src.length);
  return src.slice(s, k); };
const ctx = grab('function extractNumericPrice') + '\n' +
  src.slice(src.indexOf('const COLLECTR_PSA_GRADE'), src.indexOf('const COLLECTR_RAW_GRADE_ID')) +
  'const COLLECTR_RAW_GRADE_ID = 52;\n' + grab('function parseCollectrResponse');
const parseCollectrResponse = new Function(ctx + '\nreturn parseCollectrResponse;')();

let pass = 0, fail = 0;
const t = (name, got, want) => { const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  ${got}${ok ? '' : `   (want ${want})`}`); ok ? pass++ : fail++; };

// Team Rocket's Mewtwo ex #281 — the grades the owner read off Collectr's page.
const body = { data: {
  product_name: "Team Rocket's Mewtwo ex", catalog_group: 'Ascended Heroes',
  ungraded_sub_types: [{ product_sub_type: 'Holofoil', market_price: 384.33 }],
  graded_sub_types: [
    { grade_id: 8,  product_sub_type: 'Holofoil', market_price: 321.00 },
    { grade_id: 9,  product_sub_type: 'Holofoil', market_price: 359.98 },
    { grade_id: 10, product_sub_type: 'Holofoil', market_price: 358.00 },
    { grade_id: 11, product_sub_type: 'Holofoil', market_price: 355.50 },
    { grade_id: 12, product_sub_type: 'Holofoil', market_price: 819.00 },
    { grade_id: 40, product_sub_type: 'Holofoil', market_price: 999.00 }, // BGS etc
  ], price_history: [] } };
const r = parseCollectrResponse(body);
const p = r.prints['Holofoil'];
t('PSA 8  = $360 (id 9)',    p.psa8,   359.98);
t('PSA 8.5 captured (id 10)', p.psa8_5, 358);
t('PSA 9  = $355 (id 11)',   p.psa9,   355.5);
t('PSA 10 = $819 (id 12)',   p.psa10,  819);
t('raw unchanged',            p.raw,    384.33);
t('PSA 10 now beats PSA 9',   p.psa10 > p.psa9, true);
t('non-PSA id reported, not silently dropped', JSON.stringify(r.unmapped_grade_ids), '[40]');
t('non-PSA id kept out of prices', Object.values(p).includes(999), false);

// The Fossil Gengar anchors from the original mapping must still hold.
const gengar = parseCollectrResponse({ data: { ungraded_sub_types: [], graded_sub_types: [
  { grade_id: 3, product_sub_type: '1st Edition Holofoil', market_price: 157.50 },
  { grade_id: 5, product_sub_type: '1st Edition Holofoil', market_price: 294.33 },
  { grade_id: 8, product_sub_type: '1st Edition Holofoil', market_price: 689.90 },
  { grade_id: 9, product_sub_type: '1st Edition Holofoil', market_price: 983.52 },
], price_history: [] } });
const gp = gengar.prints['1st Edition Holofoil'];
t('Gengar id 3 still PSA 2  ($157.50)', gp.psa2, 157.5);
t('Gengar id 5 still PSA 4  ($294.33)', gp.psa4, 294.33);
t('Gengar id 8 still PSA 7  ($689.90)', gp.psa7, 689.9);
t('Gengar id 9 still PSA 8  ($983.52)', gp.psa8, 983.52);

// Trough guard must still strip a placeholder, now across the 8.5 rung.
const trough = parseCollectrResponse({ data: { ungraded_sub_types: [], graded_sub_types: [
  { grade_id: 9,  product_sub_type: 'Holofoil', market_price: 341 },
  { grade_id: 11, product_sub_type: 'Holofoil', market_price: 99.99 },
  { grade_id: 12, product_sub_type: 'Holofoil', market_price: 839 },
], price_history: [] } });
t('placeholder PSA 9 still stripped', trough.prints['Holofoil'].psa9, undefined);
t('and reported in suspect',          trough.suspect.length, 1);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
