'use strict';
function randomBytes(n) {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return { toString(enc) {
    if (enc === 'hex') return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } };
}
function createHash() { let s = ''; return { update(x) { s += x; return this; }, digest() { return 'h:' + s; } }; }
module.exports = { randomBytes, createHash, scryptSync: () => ({ toString: () => 'x', length: 1 }), timingSafeEqual: () => false };
