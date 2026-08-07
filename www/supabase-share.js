/* GoodFile — Cloud Share via Supabase Storage
 * Uploads a file to Supabase Storage, returns a public link + QR, and shows a
 * 20-minute countdown. The actual deletion that frees space is done server-side
 * by a pg_cron job (see supabase/setup.sql) — this file only handles the upload
 * and the UI. No SDK required: plain REST + XMLHttpRequest (keeps the no-build setup).
 */
(function () {
  'use strict';

  // ===========================================================================
  // >>> CONFIG — fill these in. See supabase/README.md for where to find them. <<<
  // ===========================================================================
  var GF_SUPABASE = {
    url: '',                    // e.g. 'https://abcdefghijklmnop.supabase.co'  (Project URL)
    anon: '',                   // anon public key (starts with 'eyJ...')  — safe to ship
    bucket: 'shared',           // storage bucket name (created by setup.sql)
    maxBytes: 50 * 1024 * 1024  // client-side guard; keep <= bucket file_size_limit
  };
  // ===========================================================================

  var CLOUD_TTL_MS = 20 * 60 * 1000; // 20 minutes — must match setup.sql interval
  var cloudCurrentURL = '';
  var cloudTimer = null;

  // -- small helpers (fall back to globals defined in index.html when present) --
  function $id(id) { return document.getElementById(id); }
  function fmtSize(b) {
    if (window.fmt) return window.fmt(b);
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function emoji(name) { return window.fileEmoji ? window.fileEmoji(name) : '📄'; }
  function toastMsg(m) { if (window.toast) window.toast(m); }

  function cfg() {
    if (!GF_SUPABASE.url || !GF_SUPABASE.anon) return null;
    return GF_SUPABASE;
  }

  function setProg(lbl, pct) {
    var l = $id('cloud-prog-lbl'), p = $id('cloud-prog-pct'), f = $id('cloud-prog-fill');
    if (l && lbl != null) l.textContent = lbl;
    if (pct != null) { if (p) p.textContent = Math.round(pct) + '%'; if (f) f.style.width = pct + '%'; }
  }
  function showErr(msg) {
    var box = $id('cloud-err'); if (!box) return;
    if (msg) { box.textContent = msg; box.classList.add('on'); }
    else { box.textContent = ''; box.classList.remove('on'); }
  }

  // -- filename / path safety: random folder + sanitized ascii name -----------
  function randomId() {
    var a = new Uint8Array(12), s = '';
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s; // 24 hex chars — unguessable
  }
  function safeName(name) {
    name = name || 'file';
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot + 1) : '';
    base = base.replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'file';
    ext = ext.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
    if (base.length > 60) base = base.slice(0, 60);
    return ext ? (base + '.' + ext) : base;
  }
  function parseErr(text) {
    if (!text) return '';
    try { var j = JSON.parse(text); return j.message || j.error || j.msg || text; }
    catch (e) { return String(text).slice(0, 140); }
  }

  // -- upload -----------------------------------------------------------------
  function cloudUpload(file) {
    var c = cfg();
    if (!c) { warnConfig(); toastMsg('⚙️ ยังไม่ได้ตั้งค่า Supabase'); return; }
    if (!file) return;
    if (file.size > c.maxBytes) {
      showErr('ไฟล์ใหญ่เกิน ' + fmtSize(c.maxBytes) + ' — ปรับ limit ได้ใน supabase-share.js และ bucket');
      return;
    }
    showErr('');
    hideResult();

    var key = randomId() + '/' + safeName(file.name);
    var encKey = key.replace(/[^A-Za-z0-9_\-./]/g, function (ch) { return encodeURIComponent(ch); });
    var uploadUrl = c.url + '/storage/v1/object/' + c.bucket + '/' + encKey;
    var publicUrl = c.url + '/storage/v1/object/public/' + c.bucket + '/' + encKey;

    var prog = $id('cloud-prog');
    if (prog) prog.style.display = '';
    if ($id('cloud-prog-ic')) $id('cloud-prog-ic').textContent = emoji(file.name);
    if ($id('cloud-prog-name')) $id('cloud-prog-name').textContent = file.name;
    if ($id('cloud-prog-size')) $id('cloud-prog-size').textContent = fmtSize(file.size);
    setProg('กำลังอัปโหลด...', 0);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl, true);
    xhr.setRequestHeader('apikey', c.anon);
    xhr.setRequestHeader('authorization', 'Bearer ' + c.anon);
    xhr.setRequestHeader('cache-control', 'max-age=1200'); // 20 min
    if (file.type) xhr.setRequestHeader('content-type', file.type);

    if (xhr.upload) {
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) setProg('กำลังอัปโหลด...', e.loaded / e.total * 100);
      };
    }
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        setProg('เสร็จแล้ว', 100);
        setTimeout(function () { if (prog) prog.style.display = 'none'; renderResult(publicUrl, file); }, 350);
      } else {
        if (prog) prog.style.display = 'none';
        var hint = xhr.status === 413 ? ' (ไฟล์ใหญ่เกิน limit ของ bucket)' :
                   xhr.status === 400 || xhr.status === 403 ? ' (ตรวจ anon key / RLS policy / ชื่อ bucket)' : '';
        showErr('อัปโหลดไม่สำเร็จ [' + xhr.status + ']' + hint + ' ' + parseErr(xhr.responseText));
      }
    };
    xhr.onerror = function () {
      if (prog) prog.style.display = 'none';
      showErr('เชื่อมต่อ Supabase ไม่ได้ — ตรวจอินเทอร์เน็ตและ Project URL');
    };
    xhr.send(file);
  }

  // -- result UI --------------------------------------------------------------
  function renderResult(url, file) {
    cloudCurrentURL = url;
    var card = $id('cloud-result'); if (card) card.style.display = '';
    if ($id('cloud-url-box')) { $id('cloud-url-box').textContent = url; $id('cloud-url-box').style.opacity = ''; }
    if ($id('cloud-file-chip')) $id('cloud-file-chip').textContent = '📄 ' + (file ? file.name : 'file');
    if ($id('cloud-size-chip')) $id('cloud-size-chip').textContent = file ? fmtSize(file.size) : '';
    buildQR(url);
    startCountdown(Date.now() + CLOUD_TTL_MS);
    toastMsg('☁️ อัปโหลดสำเร็จ — แชร์ลิงก์ได้เลย');
  }
  function hideResult() {
    clearInterval(cloudTimer);
    cloudCurrentURL = '';
    var card = $id('cloud-result'); if (card) card.style.display = 'none';
  }

  function ensureQRLib(cb, tries) {
    tries = tries || 0;
    if (window.QRCode) { cb(true); return; }
    if (tries === 0 && !window.__cloudQRloading) {
      window.__cloudQRloading = true;
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      document.head.appendChild(s);
    }
    if (tries < 50) setTimeout(function () { ensureQRLib(cb, tries + 1); }, 100);
    else cb(false);
  }
  function buildQR(url) {
    var box = $id('cloud-qr'); if (!box) return;
    box.innerHTML = '<div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#aaa">Loading QR...</div>';
    ensureQRLib(function (ok) {
      if (!ok) { box.textContent = url; return; }
      box.innerHTML = '';
      try { new QRCode(box, { text: url, width: 200, height: 200, colorDark: '#000000', colorLight: '#ffffff', correctLevel: 0 }); }
      catch (e) { box.textContent = url; }
    });
  }

  function startCountdown(expireAt) {
    clearInterval(cloudTimer);
    var chip = $id('cloud-expire-chip');
    function tick() {
      var left = Math.max(0, expireAt - Date.now());
      var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      if (chip) chip.textContent = '⏱ ' + m + ':' + ('0' + s).slice(-2);
      if (left <= 0) {
        clearInterval(cloudTimer);
        if (chip) { chip.textContent = '⌛ หมดอายุแล้ว'; chip.classList.remove('tag-green'); chip.classList.add('tag-muted'); }
        var box = $id('cloud-url-box');
        if (box) { box.style.opacity = '0.4'; box.textContent = 'ลิงก์หมดอายุ — ไฟล์ถูกลบแล้ว'; }
      }
    }
    tick();
    cloudTimer = setInterval(tick, 1000);
  }

  // -- public actions (referenced by inline onclick=) -------------------------
  function cloudCopyURL() {
    if (!cloudCurrentURL) return;
    if (window.copyURL) { window.copyURL(cloudCurrentURL); return; }
    try { navigator.clipboard.writeText(cloudCurrentURL).then(function () { toastMsg('คัดลอกลิงก์แล้ว'); }); }
    catch (e) { toastMsg(cloudCurrentURL); }
  }
  function cloudShare() {
    if (!cloudCurrentURL) return;
    var Share = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
    if (navigator.share) { navigator.share({ title: 'goodfile', url: cloudCurrentURL }).catch(function () {}); }
    else if (Share && Share.share) { Share.share({ title: 'goodfile', url: cloudCurrentURL, dialogTitle: 'แชร์ลิงก์' }).catch(function () {}); }
    else { cloudCopyURL(); }
  }
  function cloudReset() {
    hideResult();
    showErr('');
    var prog = $id('cloud-prog'); if (prog) prog.style.display = 'none';
    var input = $id('cloud-in-file'); if (input) { input.value = ''; input.click(); }
  }
  function warnConfig() { var w = $id('cloud-cfg-warn'); if (w) w.style.display = ''; }

  // -- wiring -----------------------------------------------------------------
  function init() {
    var ring = $id('cloud-send-ring'), input = $id('cloud-in-file');
    if (ring && input) {
      ring.addEventListener('click', function () { if (input) input.click(); });
      input.addEventListener('change', function () { var f = this.files[0]; this.value = ''; if (f) cloudUpload(f); });
    }
    if (!cfg()) warnConfig();
  }

  // expose actions for inline handlers
  window.cloudCopyURL = cloudCopyURL;
  window.cloudShare = cloudShare;
  window.cloudReset = cloudReset;

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
