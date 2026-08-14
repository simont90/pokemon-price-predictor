// A spent Collectr allowance is a recoverable state, not a broken gateway.
// These lock in what /collectr says when the credit call fails.
import { readFileSync } from 'node:fs';
const src = readFileSync('worker-paste-this.js', 'utf8');

const grab = n => {
  const i = src.indexOf(n);
  if (i < 0) throw new Error(`not found: ${n}`);
  let d = 0, k = src.indexOf('{', i);
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0 && k < src.length);
  return src.slice(src.lastIndexOf('\n', i), k);
};

const _jsonResp = (status, body, headers) =>
  ({ status, body, headers, json: () => body });
const _collectrErrResp = new Function('_jsonResp',
  grab('function _collectrErrResp') + '\nreturn _collectrErrResp;')(_jsonResp);

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  ${got}${ok ? '' : `   (want ${want})`}`);
  ok ? pass++ : fail++;
};

const err = (status, detail) => Object.assign(new Error(`Collectr API returned ${status}`), { status, detail });

// 402 — the allowance is spent.
const r402 = _collectrErrResp(err(402, '{"error":{"error":"Usage limit exceeded"}}'), {});
t('402 keeps its own status',        r402.status,        402);
t('402 is named for the client',     r402.body.reason,   'credits_exhausted');
t('402 does not leak the raw string', /returned 402/.test(r402.body.error), false);
t('402 says what to do',             /top up|monthly reset/i.test(r402.body.error), true);

// 429 — slow down, but nothing is spent.
const r429 = _collectrErrResp(err(429, ''), {});
t('429 keeps its own status',        r429.status,        429);
t('429 is named for the client',     r429.body.reason,   'rate_limited');

// Anything else is a genuine upstream fault.
const r500 = _collectrErrResp(err(500, 'boom'), {});
t('500 is still a bad gateway',      r500.status,        502);
t('500 is named for the client',     r500.body.reason,   'upstream_error');
t('500 keeps the upstream detail',   r500.body.detail,   'boom');

// A refresh that cannot be paid for must not discard a good cached body.
const handler = grab('async function handleCollectr');
t('402 on refresh falls back to cache',
  /if \(cached && \(e\.status === 402 \|\| e\.status === 429\)\)/.test(handler), true);
t('the fallback marks itself stale',
  /'X-Cache': 'stale'/.test(handler), true);
t('a failed call is never written to KV',
  handler.indexOf('SYNC_KV.put(priceKey') > handler.indexOf('parseCollectrResponse'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
