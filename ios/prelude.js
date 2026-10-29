// JavaScriptCore has no DOM. app.js is a browser app, so it gets just enough
// of one to parse and define its functions; init() still fails, which is fine
// because the bridge decodes the catalogue itself and only calls the model.
var __noop = function () {};

// JavaScriptCore ships no timers and no queueMicrotask. Without these app.js
// throws partway through evaluation, every `const` after that point stays in
// the temporal dead zone, and the first model call fails with a confusing
// "cannot access X before initialization". The model itself is synchronous, so
// deferred work simply never runs — that is intended, not a gap.
var __timerSeq = 1;
if (typeof setTimeout === 'undefined') {
  var setTimeout = function () { return __timerSeq++; };
  var clearTimeout = __noop;
}
if (typeof setInterval === 'undefined') {
  var setInterval = function () { return __timerSeq++; };
  var clearInterval = __noop;
}
if (typeof queueMicrotask === 'undefined') {
  var queueMicrotask = function (fn) {
    try { Promise.resolve().then(fn); } catch (e) {}
  };
}
if (typeof btoa === 'undefined') { var btoa = function (s) { return s; }; }
if (typeof atob === 'undefined') { var atob = function (s) { return s; }; }
var __el = new Proxy(function () {}, {
  get: function (t, p) {
    if (p === 'style') return new Proxy({}, { get: function () { return ''; }, set: function () { return true; } });
    if (p === 'classList') return { add: __noop, remove: __noop, toggle: __noop, contains: function () { return false; } };
    if (p === 'dataset') return {};
    if (p === 'children' || p === 'childNodes') return [];
    if (p === 'textContent' || p === 'innerHTML' || p === 'value' || p === 'cookie') return '';
    if (typeof p === 'symbol') return undefined;
    return function () { return __el; };
  },
  set: function () { return true; },
  apply: function () { return __el; },
});

var document = new Proxy({}, {
  get: function (t, p) {
    if (p === 'documentElement' || p === 'body' || p === 'head') return __el;
    if (p === 'querySelectorAll') return function () { return []; };
    if (p === 'readyState') return 'complete';
    if (p === 'cookie') return '';
    return function () { return __el; };
  },
  set: function () { return true; },
});

var __store = {};
var localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : null; },
  setItem: function (k, v) { __store[k] = String(v); },
  removeItem: function (k) { delete __store[k]; },
  clear: function () { __store = {}; },
  key: function (i) { return Object.keys(__store)[i] || null; },
  get length() { return Object.keys(__store).length; },
};
var sessionStorage = localStorage;

// No network inside the model: prices come from the native side, so anything
// that reaches for the wire fails fast rather than hanging the context.
var fetch = function () { return Promise.reject(new Error('offline model context')); };
var XMLHttpRequest = function () { this.open = __noop; this.send = __noop; };

var MutationObserver = function () { this.observe = __noop; this.disconnect = __noop; this.takeRecords = function () { return []; }; };
var ResizeObserver = MutationObserver, IntersectionObserver = MutationObserver;
var requestAnimationFrame = function (f) { return setTimeout(f, 0); };
var cancelAnimationFrame = __noop, requestIdleCallback = requestAnimationFrame;
var performance = { now: function () { return Date.now(); } };
var matchMedia = function () { return { matches: false, addEventListener: __noop, removeEventListener: __noop }; };
var getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
var alert = __noop, confirm = function () { return false; }, prompt = function () { return null; };
var navigator = { language: 'en-GB', userAgent: 'PokePredictor-iOS' };
var location = { href: '', hash: '', search: '', pathname: '/' };
var Image = function () {};

var window = this;
window.addEventListener = __noop;
window.removeEventListener = __noop;
window.dispatchEvent = function () { return true; };
window.scrollTo = __noop;
window.scrollBy = __noop;
window.innerWidth = 440;
window.innerHeight = 956;
var self = window;
