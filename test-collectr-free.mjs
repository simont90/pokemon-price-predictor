// The free set page is the unmetered half of the Collectr integration. These
// pin what it yields, using a real capture of Collectr's Fossil set page.
import { readFileSync, existsSync } from 'node:fs';
const src = readFileSync('worker-paste-this.js', 'utf8');

const grab = n => {
  const i = src.indexOf(n);
  if (i < 0) throw new Error(`not found: ${n}`);
  let d = 0, k = src.indexOf('{', i);
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0 && k < src.length);
  return src.slice(src.lastIndexOf('\n', i), k);
};

const ctx = src.slice(src.indexOf('const COLLECTR_PSA_GRADE'), src.indexOf('const COLLECTR_RAW_GRADE_ID'))
  + '\n' + grab('function parseCollectrSetPage')
  + '\n' + grab('function _collectrPickPrint')
  + '\n' + grab('function collectrPsaGradesPresent');
const { parseCollectrSetPage, _collectrPickPrint, collectrPsaGradesPresent } =
  new Function(ctx + '\nreturn { parseCollectrSetPage, _collectrPickPrint, collectrPsaGradesPresent };')();

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  ${got}${ok ? '' : `   (want ${want})`}`);
  ok ? pass++ : fail++;
};

const FIX = process.env.COLLECTR_FIXTURE || 'test-fixtures/collectr-fossil.html';
if (!existsSync(FIX)) {
  console.log(`SKIP  set-page parse — no fixture at ${FIX}`);
} else {
  const cards = parseCollectrSetPage(readFileSync(FIX, 'utf8'));

  t('the page yields fifteen cards',      Object.keys(cards).length, 15);
  t('and stops at fifteen — no page 2',   Object.keys(cards).includes('16'), false);

  const gengar = cards['5'];
  t('card 5 is Gengar',                   (gengar.name || '').trim(), 'Gengar');
  t('Gengar is a Holo Rare',              gengar.rarity, 'Holo Rare');
  t('both prints are carried',            Object.keys(gengar.prints).length, 2);

  const first = _collectrPickPrint(gengar.prints, '1sted');
  const unlim = _collectrPickPrint(gengar.prints, 'unlimited');
  t('1st Ed print is picked by variant',  first.subType,  '1st Edition Holofoil');
  t('Unlimited print is picked too',      unlim.subType,  'Unlimited Holofoil');
  t('1st Ed carries its own price',       first.rawPrice, 601.49);
  t('Unlimited is priced separately',     unlim.rawPrice, 213.12);
  t('and the two really do differ',       first.rawPrice !== unlim.rawPrice, true);
  // Collectr keys a product per card, not per print — both prints of Gengar
  // are product 106521, and the sub-type is what separates them. The priced
  // endpoint agrees: it returns one product carrying many product_sub_types.
  t('both prints share the product id',   first.productId === unlim.productId, true);
  t('the id is the card\'s',              first.productId, '106521');

  // Grade existence — the whole point of the free read.
  const psa = collectrPsaGradesPresent(first.gradeIds);
  t('PSA 10 exists on 1st Ed Gengar',     psa.includes('psa10'), true);
  t('so does PSA 3',                      psa.includes('psa3'),  true);
  t('PSA 1.5 was never graded',           psa.includes('psa1_5'), false);
  t('other companies are dropped',        psa.some(g => !/^psa/.test(g)), false);
  t('ids past the PSA table are ignored',
    collectrPsaGradesPresent([12, 130, 82, 41]).join(','), 'psa10');
  t('no grade ids means no answer, not none',
    collectrPsaGradesPresent([]), null);
}

// A record must never read a field off the next card's record.
const twoCards = String.raw`
 {\"product_id\":\"111\",\"product_name\":\"Alpha \",\"card_number\":\"1\",\"rarity\":\"Holo Rare\",\"product_sub_type\":\"Holofoil\",\"unique_sub_type_groups\":[{\"grade_id\":\"12\"}],\"latest_price\":\"10.0000\",\"market_price_percentage_diff\":\"1.5\"},
 {\"product_id\":\"222\",\"product_name\":\"Beta \",\"card_number\":\"2\",\"rarity\":\"Rare\",\"product_sub_type\":\"Holofoil\",\"unique_sub_type_groups\":[{\"grade_id\":\"11\"}],\"latest_price\":\"20.0000\",\"market_price_percentage_diff\":\"-2.5\"}`;
const two = parseCollectrSetPage(twoCards);
t('records are sliced apart',        two['1'].prints['Holofoil'].rawPrice, 10);
t('the second keeps its own price',  two['2'].prints['Holofoil'].rawPrice, 20);
t('grades do not bleed across',      two['1'].prints['Holofoil'].gradeIds.join(','), '12');
t('a negative move is kept',         two['2'].prints['Holofoil'].pct30d, -2.5);

// The route must not spend a credit when asked not to.
const handler = grab('async function handleCollectr');
t('meter=0 short-circuits',          /meter'\) === '0'/.test(handler), true);
t('and reports zero credits',        /credits_used: 0/.test(handler), true);
t('402 falls back to the free facts', /freeFacts && \(e\.status === 402/.test(handler), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
