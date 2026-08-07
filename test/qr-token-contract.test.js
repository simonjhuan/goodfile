/*
 * Regression test for the bug that made every transfer fail with
 * "401 Unauthorized - open the QR link from the sender."
 *
 * The instant-QR path paints the QR before the server exists, so it builds the
 * URL itself. The server rejects any request without a matching ?t= token. If
 * those two ever disagree, the QR on screen is unscannable garbage -- the app
 * looks fine and every single transfer fails. That shipped for ~6 weeks.
 *
 * The contract this locks down:
 *   the token encoded INTO the QR image
 *     === the token handed to the native server
 *     === the token advertised over mDNS
 *
 * Run: npm test
 */

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ── minimal DOM: just enough for the patch's QR path ────────────────────────
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {},
    _class: '', textContent: '', innerHTML: '',
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  Object.defineProperty(el, 'className', {
    get() { return this._class; },
    set(v) { this._class = v; },
  });
  return el;
}

function installDOM() {
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl('div'));
      return byId.get(id);
    },
    createElement: makeEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: makeEl('html'),
    body: makeEl('body'),
    head: makeEl('head'),
  };
  global.document = document;
  global.window = global;
  // navigator is a read-only getter on modern Node.
  Object.defineProperty(global, 'navigator', {
    value: { onLine: true, userAgent: 'node-test' },
    configurable: true, writable: true,
  });
  global.localStorage = {
    _d: {},
    getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  return { document, byId };
}

// ── the run ────────────────────────────────────────────────────────────────
async function run() {
  installDOM();

  const captured = { qrText: null, serverOpts: null, nsd: null };

  // The QR library is the ground truth: whatever string lands here is exactly
  // what the receiver's camera will read.
  global.QRCode = function QRCode(_el, opts) { captured.qrText = opts && opts.text; };

  global.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FileServer: {
        getIP: () => Promise.resolve({ ip: '192.168.1.5' }),
        pickFile: () => Promise.resolve({
          files: [{ uri: 'content://media/external/video/1', name: 'movie.mp4', size: 734003200, mimeType: 'video/mp4' }],
        }),
        startServer(opts) {
          captured.serverOpts = opts;
          // Mirror the native contract: honour a caller-supplied token.
          const tok = opts.token || 'server-generated';
          return Promise.resolve({ url: `http://192.168.1.5:8080/download?t=${tok}`, ip: '192.168.1.5', token: tok });
        },
        addListener() {},
      },
    },
  };
  global.nsdRegister = (port, name, tok) => { captured.nsd = { port, name, tok }; };

  const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'goodfile-instant-qr-patch.js'), 'utf8');
  new Function(src)(); // defines window.gfNativePick

  assert.strictEqual(typeof global.gfNativePick, 'function', 'patch did not define gfNativePick');
  assert.strictEqual(global.gfNativePick(), true, 'gfNativePick should claim the native path');

  // let the promise chain settle
  await new Promise((r) => setTimeout(r, 50));

  // ── assertions ───────────────────────────────────────────────────────────
  assert.ok(captured.qrText, 'nothing was ever encoded into a QR');
  assert.ok(captured.serverOpts, 'the native server was never started');

  const qrToken = (captured.qrText.match(/[?&]t=([^&]+)/) || [])[1];

  assert.ok(qrToken, `QR carries no token, receiver will get 401: ${captured.qrText}`);
  assert.strictEqual(qrToken, captured.serverOpts.token,
    `QR token (${qrToken}) != token given to the server (${captured.serverOpts.token}) -- every scan 401s`);
  assert.ok(captured.nsd, 'mDNS was never told about the server');
  assert.strictEqual(captured.nsd.tok, qrToken,
    `mDNS advertises token ${captured.nsd.tok} but the server expects ${qrToken} -- discovered devices 401`);

  // The whole point of the native pick: serve the original, never copy it.
  assert.ok(/^content:\/\//.test(captured.serverOpts.uri),
    `expected a zero-copy content:// uri, got ${captured.serverOpts.uri}`);

  console.log('PASS  QR token          ', qrToken);
  console.log('PASS  server token      ', captured.serverOpts.token);
  console.log('PASS  mDNS token        ', captured.nsd.tok);
  console.log('PASS  zero-copy uri     ', captured.serverOpts.uri);
  console.log('\nAll QR/token contract checks passed.');
}

run().catch((err) => {
  console.error('\nFAIL:', err.message);
  process.exit(1);
});
