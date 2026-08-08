/*
 * Diagnostics must do two things correctly or it is worse than useless:
 *   1. name the failure precisely enough to act on
 *   2. never carry the user's file names off the device
 *
 * Run: npm test
 */

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// minimal browser surface for diagnostics.js
const listeners = {};
global.window = global;
global.addEventListener = (k, fn) => { listeners[k] = fn; };
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'node-test', onLine: true, language: 'th-TH' },
  configurable: true, writable: true,
});
global.localStorage = {
  _d: {},
  getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
};
global.screen = { width: 400, height: 800 };

new Function(fs.readFileSync(path.join(__dirname, '..', 'www', 'diagnostics.js'), 'utf8'))();
const D = global.GFDiag;
assert.ok(D, 'diagnostics.js did not expose GFDiag');

function evOf(entry) { return entry.lv + ' ' + entry.ev; }

// ── 1. the exact bug that shipped: QR painted with no token at all ──────────
D.clear();
assert.strictEqual(
  evOf(D.checkQRToken('http://192.168.1.5:8080/download', 'abc123')),
  'ERR qr.token.missing',
  'a tokenless QR against a token-guarded server must be reported as MISSING'
);

// ── 2. stale QR from an earlier transfer — different cause, different fix ───
assert.strictEqual(
  evOf(D.checkQRToken('http://192.168.1.5:8080/download?t=OLDTOKEN', 'abc123')),
  'ERR qr.token.mismatch',
  'a QR carrying the wrong token must be reported as MISMATCH, not MISSING'
);

// ── 3. healthy ─────────────────────────────────────────────────────────────
assert.strictEqual(
  evOf(D.checkQRToken('http://192.168.1.5:8080/download?t=abc123', 'abc123')),
  'INF qr.token.ok'
);

// ── 4. privacy: the report must never carry a real file name ───────────────
D.clear();
D.log('transfer.complete', { fileName: 'ใบรับรองแพทย์-สมชาย.pdf', size: 4096 });
const rec = D.entries().slice(-1)[0];
assert.strictEqual(rec.d.fileName, '.pdf', 'file name must be reduced to its extension');

const report = D.report();
assert.ok(!/สมชาย/.test(report), 'report leaked a personal file name');
assert.ok(!/ใบรับรองแพทย์/.test(report), 'report leaked a personal file name');

// ── 5. tokens are never written out verbatim ───────────────────────────────
D.clear();
D.log('server.started', { token: 'deadbeef' });
assert.ok(!/deadbeef/.test(D.report()), 'report leaked a raw access token');

// ── 6. nothing in this module may touch the network ────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'diagnostics.js'), 'utf8');
for (const banned of ['fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', 'WebSocket']) {
  assert.ok(!src.includes(banned),
    `diagnostics.js must stay on-device, found ${banned} — that would contradict the Play "no data collected" declaration`);
}

console.log('PASS  missing token  -> qr.token.missing');
console.log('PASS  stale token    -> qr.token.mismatch');
console.log('PASS  matching token -> qr.token.ok');
console.log('PASS  file names redacted to extension');
console.log('PASS  tokens never written verbatim');
console.log('PASS  no network calls (stays on-device)');
