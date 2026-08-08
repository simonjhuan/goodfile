/*
 * goodfile diagnostics — on-device only.
 *
 * The 401 bug shipped for ~6 weeks with every transfer failing and no way to
 * know. This records what actually happened on the device so a failure can be
 * explained after the fact.
 *
 * Privacy: nothing leaves the device unless the user taps "report". The Play
 * listing declares no data collection, and this keeps that true — there is no
 * network call in this file. File names are reduced to an extension so a report
 * never carries what the person was sending.
 */
(function () {
  'use strict';

  var MAX = 200;                    // rolling window; old entries drop off
  var KEY = '_gf_diag';             // survives restart, so a user can report later
  var buf = [];
  var t0 = Date.now();

  try {
    var saved = localStorage.getItem(KEY);
    if (saved) buf = JSON.parse(saved) || [];
  } catch (e) { buf = []; }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(buf.slice(-MAX))); } catch (e) {}
  }

  // "holiday-photos.jpg" -> ".jpg". Enough to debug a mime/extension issue,
  // nothing about the person's file.
  function safeName(name) {
    if (!name) return '';
    var m = String(name).match(/(\.[a-z0-9]{1,8})$/i);
    return m ? m[1] : '(no ext)';
  }

  function scrub(data) {
    if (!data || typeof data !== 'object') return data;
    var out = {};
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      var v = data[k];
      if (/name$/i.test(k)) out[k] = safeName(v);
      else if (/^(token|tok|t)$/i.test(k)) out[k] = v ? 'set(' + String(v).length + ')' : 'MISSING';
      else if (v instanceof Error) out[k] = v.message || String(v);
      else if (typeof v === 'object') { try { out[k] = JSON.parse(JSON.stringify(v)); } catch (e) { out[k] = '[obj]'; } }
      else out[k] = v;
    }
    return out;
  }

  function push(level, ev, data) {
    var entry = { ms: Date.now() - t0, at: new Date().toISOString(), lv: level, ev: ev };
    var d = scrub(data);
    if (d !== undefined && d !== null) entry.d = d;
    buf.push(entry);
    if (buf.length > MAX) buf = buf.slice(-MAX);
    persist();
    if (level === 'ERR' && typeof console !== 'undefined') {
      try { console.error('[gf] ' + ev, d || ''); } catch (e) {}
    }
    return entry;
  }

  function device() {
    var c = window.Capacitor;
    return {
      ua: (navigator.userAgent || '').slice(0, 180),
      native: !!(c && c.isNativePlatform && c.isNativePlatform()),
      platform: (c && c.getPlatform && c.getPlatform()) || 'web',
      plugins: c && c.Plugins ? Object.keys(c.Plugins).join(',') : '(none)',
      online: navigator.onLine,
      lang: navigator.language || '',
      screen: (window.screen ? screen.width + 'x' + screen.height : '')
    };
  }

  var GFDiag = {
    log: function (ev, data) { return push('INF', ev, data); },
    warn: function (ev, data) { return push('WRN', ev, data); },
    error: function (ev, data) { return push('ERR', ev, data); },

    entries: function () { return buf.slice(); },
    errors: function () { return buf.filter(function (e) { return e.lv === 'ERR'; }); },
    clear: function () { buf = []; persist(); },

    /* A QR whose token doesn't match the server's is invisible to the sender —
       the receiver just gets a 401. Assert it at runtime so it lands in the log
       of the person who actually hit it. */
    checkQRToken: function (qrURL, serverToken) {
      var inQR = (String(qrURL || '').match(/[?&]t=([^&]+)/) || [])[1] || '';
      // Order matters: a missing token is the shape the shipped bug had, and
      // it's a different fix from a token that's merely stale, so name it first.
      if (serverToken && !inQR) {
        return push('ERR', 'qr.token.missing', { note: 'QR has no token; receiver will get 401' });
      }
      if (serverToken && inQR !== serverToken) {
        return push('ERR', 'qr.token.mismatch', { note: 'QR token is not the one the server accepts' });
      }
      return push('INF', 'qr.token.ok', { token: inQR });
    },

    report: function () {
      var dev = device();
      var lines = [];
      lines.push('goodfile diagnostic report');
      lines.push('generated: ' + new Date().toISOString());
      lines.push('app: ' + (window._gfVersion || 'unknown'));
      lines.push('platform: ' + dev.platform + (dev.native ? ' (native)' : ' (web)'));
      lines.push('online: ' + dev.online + '  lang: ' + dev.lang + '  screen: ' + dev.screen);
      lines.push('plugins: ' + dev.plugins);
      lines.push('ua: ' + dev.ua);
      var errs = GFDiag.errors();
      lines.push('');
      lines.push('errors: ' + errs.length + ' of ' + buf.length + ' events');
      lines.push('--------------------------------------------');
      buf.forEach(function (e) {
        var d = e.d ? '  ' + JSON.stringify(e.d) : '';
        lines.push('[' + String(e.ms).padStart(7) + 'ms] ' + e.lv + '  ' + e.ev + d);
      });
      lines.push('--------------------------------------------');
      lines.push('(file names reduced to extension; nothing was sent automatically)');
      return lines.join('\n');
    },

    /* User-initiated only. Nothing here runs on its own. */
    share: function () {
      var text = GFDiag.report();
      var Share = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
      if (Share && Share.share) {
        return Share.share({ title: 'goodfile diagnostic report', text: text })
          .catch(function () { return GFDiag.copy(text); });
      }
      return GFDiag.copy(text);
    },

    copy: function (text) {
      text = text || GFDiag.report();
      var Clip = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Clipboard;
      if (Clip && Clip.write) return Clip.write({ string: text });
      if (navigator.clipboard) return navigator.clipboard.writeText(text);
      return Promise.reject(new Error('no clipboard'));
    }
  };

  window.GFDiag = GFDiag;

  // Anything that blows up unhandled is exactly what we never got to see before.
  window.addEventListener('error', function (e) {
    push('ERR', 'js.error', { msg: e.message, src: (e.filename || '').split('/').pop(), line: e.lineno });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    push('ERR', 'js.unhandledRejection', { msg: (r && (r.message || r)) + '' });
  });

  push('INF', 'app.start', device());
})();
