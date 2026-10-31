// Sign in with Apple (/auth/apple): token verification and account mapping.
// Apple's signing key is replaced by a locally generated RSA key served from
// a mocked JWKS endpoint; everything else is the worker's own code.
import { readFileSync } from 'node:fs';
const src = readFileSync('worker-paste-this.js', 'utf8');

const grab = n => {
  const i = src.indexOf(n);
  if (i < 0) throw new Error(`not found: ${n}`);
  let d = 0, k = src.indexOf('{', i);
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0 && k < src.length);
  return src.slice(src.lastIndexOf('\n', i), k);
};
const line = n => { const i = src.indexOf(n); return src.slice(i, src.indexOf('\n', i)); };

// --- a stand-in for Apple's signing key ---
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'TESTKID', use: 'sig', alg: 'RS256' };
let jwksCalls = 0;
const fetch = async url => {
  if (url !== 'https://appleid.apple.com/auth/keys') throw new Error('unexpected fetch ' + url);
  jwksCalls++;
  return { ok: true, json: async () => ({ keys: [jwk] }) };
};

const code = [
  line('const APPLE_ISSUER'), line('const APPLE_JWKS_URL'), line('const APPLE_DEFAULT_AUDIENCES'),
  'let _appleJwks = null; let _appleJwksAt = 0;',
  ...['async function _jwtKey', 'function _b64u(', 'function _b64uDec', 'async function jwtSign', 'async function jwtVerify',
      'async function pwHash', 'function hexToU8', 'async function authMiddleware', 'function _jsonResp',
      'async function _appleKeys', 'async function _sha256Hex', 'async function verifyAppleIdToken',
      'async function handleAuthApple', 'async function handleAuthLogin', 'async function handleDeleteAccount'].map(grab),
  'return { handleAuthApple, handleAuthLogin, handleDeleteAccount, jwtSign, _sha256Hex, _b64u };',
].join('\n');
const W = new Function('fetch', 'corsHeaders', code)(fetch, () => ({}));

// --- helpers ---
const kv = new Map();
const env = {
  JWT_SECRET: 'test-secret',
  SYNC_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async k => { kv.delete(k); } },
};
const enc = new TextEncoder();
async function appleToken({ sub = '001234.abcd', aud = 'com.simontariq.pokepredictor', nonce = 'n1', exp = 600, key = privateKey, kid = 'TESTKID' } = {}) {
  const h = W._b64u(enc.encode(JSON.stringify({ alg: 'RS256', kid })));
  const now = Math.floor(Date.now() / 1000);
  const b = W._b64u(enc.encode(JSON.stringify({ iss: 'https://appleid.apple.com', aud, sub, exp: now + exp, iat: now, nonce: await W._sha256Hex(nonce) })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${h}.${b}`));
  return `${h}.${b}.${W._b64u(sig)}`;
}
const req = (body, bearer) => ({ headers: new Headers(bearer ? { Authorization: `Bearer ${bearer}` } : {}), json: async () => body });
const call = async (fn, r) => { const res = await fn(r, env); return { status: res.status, body: await res.json() }; };

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  ${got}${ok ? '' : `   (want ${want})`}`);
  ok ? pass++ : fail++;
};

// 1. First sign-in creates an account keyed by the Apple id.
let r = await call(W.handleAuthApple, req({ idToken: await appleToken(), nonce: 'n1' }));
t('new Apple ID: 200', r.status, 200);
t('new Apple ID: created', r.body.created, true);
t('new Apple ID: account key', JSON.parse(kv.get('auth:apple:001234.abcd')).sub, 'apple:001234.abcd');
t('new Apple ID: has a session token', typeof r.body.token, 'string');

// 2. Signing in again returns the same account, not a new one.
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ nonce: 'n2' }), nonce: 'n2' }));
t('repeat sign-in: same account, not created', r.body.created, false);
t('JWKS cached across sign-ins', jwksCalls, 1);

// 3. A signed-in username account links instead of creating.
kv.set('auth:user:simon', JSON.stringify({ username: 'Simon', passwordHash: 'x', salt: '00' }));
const simonJwt = await W.jwtSign({ sub: 'simon' }, env.JWT_SECRET);
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ sub: '009999.ffff', nonce: 'n3' }), nonce: 'n3' }, simonJwt));
t('link: linked to the signed-in account', r.body.linked, true);
t('link: maps to that account', JSON.parse(kv.get('auth:apple:009999.ffff')).sub, 'simon');
t('link: keeps the username', r.body.username, 'Simon');
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ sub: '009999.ffff', nonce: 'n4' }), nonce: 'n4' }));
t('link: later Apple sign-in alone reaches it', r.body.username, 'Simon');

// 4. Website Services ID is an accepted audience.
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ aud: 'com.simontariq.pokepredictor.web', nonce: 'w' }), nonce: 'w' }));
t('web Services ID accepted', r.status, 200);

// 5. Rejections.
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ nonce: 'a' }), nonce: 'b' }));
t('wrong nonce rejected', r.status, 401);
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ aud: 'com.someone.else', nonce: 'c' }), nonce: 'c' }));
t('foreign audience rejected', r.status, 401);
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ exp: -3600, nonce: 'd' }), nonce: 'd' }));
t('expired token rejected', r.status, 401);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
r = await call(W.handleAuthApple, req({ idToken: await appleToken({ key: other.privateKey, nonce: 'e' }), nonce: 'e' }));
t('forged signature rejected', r.status, 401);
r = await call(W.handleAuthApple, req({ idToken: 'not.a.token', nonce: 'f' }));
t('garbage token rejected', r.status, 401);

// 6. Password login against a password-less (Apple) account: 401, not a crash.
r = await call(W.handleAuthLogin, req({ username: 'apple:001234.abcd', password: 'whatever1' }));
t('password login on Apple account is 401', r.status, 401);

// 7. Deleting the account removes the Apple link too.
const appleJwt = await W.jwtSign({ sub: 'apple:001234.abcd' }, env.JWT_SECRET);
r = await call(W.handleDeleteAccount, req({}, appleJwt));
t('delete: ok', r.status, 200);
t('delete: Apple link removed', kv.has('auth:apple:001234.abcd'), false);
t('delete: account removed', kv.has('auth:user:apple:001234.abcd'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
