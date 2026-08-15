/* ════════════════════════════════════════════════════════════
   goodfile — INSTANT QR PATCH v3 (WITH DEBUG OVERLAY)
   ════════════════════════════════════════════════════════════
   v3 ใหม่: เพิ่ม Debug Overlay บนหน้าจอมือถือ
   เห็น timing + log ทุกอย่างบนจอเลย ไม่ต้องต่อ Chrome

   วิธีใช้:
   - เก็บไฟล์ใน folder เดียวกับ index.html
   - เพิ่ม [script src='goodfile-instant-qr-patch.js'][/script]
     ก่อน [/body]
══════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  /* ═══ CONFIG ═══ */
  var BLOB_THRESHOLD = 50 * 1024 * 1024;
  var SERVER_PORT    = 8080;
  var IP_CACHE_KEY   = '_gf_cached_ip';
  var IP_CACHE_TTL   = 5 * 60 * 1000;
  var DEBUG_ON       = false;

  /* The server rejects any request without the right ?t= token. We mint it here,
     BEFORE painting the QR, and hand the same value to the native server — if the
     QR is drawn first and the server picks its own token, every scan gets a 401. */
  function gfMakeToken(){
    try{
      var b = new Uint8Array(4);
      crypto.getRandomValues(b);
      return Array.prototype.map.call(b, function(x){ return ('0'+x.toString(16)).slice(-2); }).join('');
    }catch(e){
      return (Math.random().toString(16).slice(2,10) + '0000000').slice(0,8);
    }
  }
  function gfWithToken(url, tok){ return url + (url.indexOf('?')>-1 ? '&' : '?') + 't=' + tok; }

  /* ═══ STATE ═══ */
  var _cachedIP = null;
  var _cachedIPTime = 0;
  var _blobURL = null;
  var _serverReady = false;
  var _t0 = 0;
  var _debugBox = null;

  function $(id){return document.getElementById(id);}
  function getPlugin(){return window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.FileServer;}
  function isNative(){return !!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());}

  /* ═══ DEBUG OVERLAY บนจอมือถือ ═══ */
  function ensureDebugBox(){
    if(!DEBUG_ON) return null;
    if(_debugBox) return _debugBox;
    var box = document.createElement('div');
    box.id = 'gf-debug-overlay';
    box.style.cssText = 'position:fixed;top:60px;left:8px;right:8px;max-height:40vh;overflow-y:auto;background:rgba(0,0,0,0.92);border:1px solid #00E676;border-radius:10px;padding:10px;z-index:9998;font-family:monospace;font-size:11px;color:#00E676;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,0.6)';
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(0,230,118,0.3)';
    header.innerHTML = '<span style="font-weight:700;color:#00E676">🐛 DEBUG v3</span>';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:1px solid #00E676;color:#00E676;border-radius:50%;width:20px;height:20px;font-size:10px;cursor:pointer;padding:0';
    closeBtn.onclick = function(){box.style.display='none';};
    header.appendChild(closeBtn);
    box.appendChild(header);
    var logArea = document.createElement('div');
    logArea.id = 'gf-debug-log';
    box.appendChild(logArea);
    document.body.appendChild(box);
    _debugBox = box;
    return box;
  }

  function dlog(msg, color){
    if(!DEBUG_ON) return;
    try{console.log('[GF]', msg);}catch(e){}
    ensureDebugBox();
    var area = $('gf-debug-log');
    if(!area) return;
    var t = ((Date.now() - _t0) / 1000).toFixed(2);
    var line = document.createElement('div');
    line.style.cssText = 'padding:2px 0;color:'+(color||'#00E676');
    line.innerHTML = '<span style="color:#888">+'+t+'s</span> '+msg;
    area.appendChild(line);
    area.scrollTop = area.scrollHeight;
  }

  function dlogReset(){
    _t0 = Date.now();
    ensureDebugBox();
    var area = $('gf-debug-log');
    if(area) area.innerHTML = '';
    var box = $('gf-debug-overlay');
    if(box) box.style.display = 'block';
  }

  /* ═══ IP DETECTION (cached) ═══ */
  function getLocalIPFast(){
    return new Promise(function(resolve){
      var now = Date.now();
      if(_cachedIP && (now - _cachedIPTime) < IP_CACHE_TTL){
        dlog('🟢 IP from memory: '+_cachedIP);
        resolve(_cachedIP); return;
      }
      try{
        var raw = localStorage.getItem(IP_CACHE_KEY);
        if(raw){
          var obj = JSON.parse(raw);
          if(obj && obj.ip && (now - obj.t) < IP_CACHE_TTL){
            _cachedIP = obj.ip; _cachedIPTime = obj.t;
            dlog('🟢 IP from localStorage: '+obj.ip);
            resolve(obj.ip); return;
          }
        }
      }catch(e){}
      if(window.deviceIP && window.deviceIP !== '127.0.0.1'){
        dlog('🟢 IP from deviceIP: '+window.deviceIP);
        cacheIP(window.deviceIP); resolve(window.deviceIP); return;
      }
      /* ═══ FIX: ลอง native FileServer.getIP() ก่อน (แม่นกว่า WebRTC, ไม่โดน mDNS บล็อก) ═══ */
      var _fs = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FileServer;
      if(_fs && _fs.getIP){
        dlog('🔍 Trying native getIP()...');
        var _nativeTimer = setTimeout(function(){ webrtcFallback(); }, 1200);
        var _nativeDone = false;
        _fs.getIP().then(function(res){
          if(_nativeDone) return; _nativeDone = true;
          clearTimeout(_nativeTimer);
          var ip = res && res.ip;
          if(ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1' && ip !== '0.0.0.0' && ip.indexOf('169.254.') !== 0){
            dlog('🟢 IP from native: '+ip);
            cacheIP(ip); resolve(ip);
          } else {
            dlog('⚠️ native IP invalid ('+ip+') → WebRTC');
            webrtcFallback();
          }
        }).catch(function(e){
          if(_nativeDone) return; _nativeDone = true;
          clearTimeout(_nativeTimer);
          dlog('⚠️ native getIP failed → WebRTC');
          webrtcFallback();
        });
        return;
      }
      webrtcFallback();
      function webrtcFallback(){
      dlog('🔍 Detecting IP via WebRTC...');
      try{
        var pc = new RTCPeerConnection({iceServers:[]});
        pc.createDataChannel('');
        var resolved = false;
        var doneFn = function(ip){
          if(resolved) return;
          resolved = true;
          try{pc.close();}catch(e){}
          if(ip){cacheIP(ip);dlog('🟢 IP detected: '+ip);}
          else dlog('⚠️ IP fail, fallback 127.0.0.1', '#ff8888');
          resolve(ip || '127.0.0.1');
        };
        pc.createOffer().then(function(o){return pc.setLocalDescription(o);}).catch(function(){doneFn(null);});
        pc.onicecandidate = function(e){
          if(!e || !e.candidate) return;
          var m = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
          if(m && m[1] !== '127.0.0.1' && !m[1].startsWith('169.254.')) doneFn(m[1]);
        };
        setTimeout(function(){doneFn(null);}, 1500);
      }catch(e){
        dlog('❌ RTC error: '+e.message, '#ff8888');
        resolve('127.0.0.1');
      }
      } /* end webrtcFallback */
    });
  }

  function cacheIP(ip){
    _cachedIP = ip; _cachedIPTime = Date.now();
    try{localStorage.setItem(IP_CACHE_KEY, JSON.stringify({ip:ip, t:_cachedIPTime}));}catch(e){}
  }

  /* ═══ QR BUILDER ═══ */
  var _paintedQRURL = null;
  function buildInstantQR(url, file){
    var wrap = $('qr-wrap');
    if(!wrap){dlog('❌ qr-wrap not found', '#ff8888');return;}
    dlog('🎨 Building QR UI...');
    _paintedQRURL = url;
    wrap.innerHTML = '';
    var qrFrame = document.createElement('div');
    qrFrame.className = 'qr-frame';
    var qrDiv = document.createElement('div');
    qrFrame.appendChild(qrDiv);
    wrap.appendChild(qrFrame);
    var fname = document.createElement('div');
    fname.className = 'qr-fn';
    fname.textContent = file ? file.name : 'File';
    wrap.appendChild(fname);
    var fsize = document.createElement('div');
    fsize.className = 'qr-fs';
    fsize.textContent = file ? fmtSize(file.size) : '';
    wrap.appendChild(fsize);
    var pairCard = document.createElement('div');
    pairCard.id = 'send-pair-card';
    pairCard.style.cssText = 'width:100%;padding:16px;border-radius:18px;background:linear-gradient(135deg,rgba(41,121,255,.19),rgba(0,230,118,.10));border:1px solid rgba(130,177,255,.34);text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.16)';
    pairCard.innerHTML = '<div style="font-size:11px;color:var(--t3);font-weight:800;letter-spacing:.8px">ส่งไปยัง PC โดยไม่ต้องพิมพ์ IP</div><div id="send-pair-code" style="font:900 46px/1.2 DM Mono,monospace;letter-spacing:12px;color:#82B1FF;padding-left:12px;margin:8px 0">----</div><div id="send-pair-note" style="font-size:12px;color:var(--t2)">กำลังสร้างรหัส 4 ตัว...</div><div id="send-pair-expiry" style="font-size:11px;color:var(--t3);margin-top:5px"></div><div id="send-pair-link" style="margin-top:12px;padding:9px 10px;border-radius:10px;background:rgba(10,15,30,.45);font:700 10px/1.4 DM Mono,monospace;color:#BFD5FF;word-break:break-all">กำลังเตรียมลิงก์...</div><button id="btn-send-pair-copy" type="button" disabled style="width:100%;margin-top:9px;padding:10px;border:0;border-radius:11px;background:#2979FF;color:white;font:800 12px DM Sans,sans-serif">คัดลอกลิงก์สำหรับ PC</button><div style="margin-top:10px;font-size:11px;color:var(--t3);line-height:1.55">1. PC เปิด <b style="color:#BFD5FF">gf.maew0009.workers.dev</b><br>2. กรอกรหัสนี้ แล้วกดดาวน์โหลด</div>';
    wrap.appendChild(pairCard);
    var copyPairBtn = $('btn-send-pair-copy');
    if(copyPairBtn)copyPairBtn.addEventListener('click',function(){if(window.goodfileCopyDownloadPairLink)window.goodfileCopyDownloadPairLink();});
    var pill = document.createElement('div');
    pill.id = 'qr-instant-status';
    pill.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:100px;background:rgba(0,230,118,.1);border:1px solid rgba(0,230,118,.3);color:#00E676;font-size:11px;font-weight:700';
    pill.innerHTML = '<div style="width:6px;height:6px;border-radius:50%;background:#00E676;animation:blink 1s infinite"></div><span id="qr-instant-status-txt">⚡ พร้อมส่งทันที</span>';
    wrap.appendChild(pill);
    var urlBox = document.createElement('div');
    urlBox.className = 'qr-url';
    urlBox.textContent = url;
    urlBox.addEventListener('click', function(){copyToClipboard(url);});
    wrap.appendChild(urlBox);
    var shareBtn = document.createElement('button');
    shareBtn.className = 'qr-share-btn';
    shareBtn.type = 'button';
    shareBtn.textContent = 'Share Link';
    shareBtn.addEventListener('click', function(){
      if(navigator.share) navigator.share({title:'goodfile', url:url}).catch(function(){});
      else copyToClipboard(url);
    });
    wrap.appendChild(shareBtn);
    qrDiv.innerHTML = '<div style="width:240px;height:240px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#aaa">⚡ Loading...</div>';
    function makeQR(a){
      a = a || 0;
      if(window.QRCode){
        qrDiv.innerHTML = '';
        try{new QRCode(qrDiv, {text:url, width:240, height:240, colorDark:'#000', colorLight:'#fff', correctLevel:0});dlog('✅ QR rendered');}
        catch(e){qrDiv.textContent = url;dlog('⚠️ QR fallback: '+e.message, '#ffaa44');}
      }else if(a < 20){
        if(a===0) dlog('⏳ Wait QR lib...');
        setTimeout(function(){makeQR(a+1);}, 200);
      }else{qrDiv.textContent = url;dlog('⚠️ QR lib missing', '#ffaa44');}
    }
    makeQR();
  }

  function updateQRStatus(text, color){
    var el = $('qr-instant-status-txt');
    if(el) el.textContent = text;
    var pill = $('qr-instant-status');
    if(pill && color){
      pill.style.background = 'rgba('+color+',.1)';
      pill.style.borderColor = 'rgba('+color+',.3)';
      pill.style.color = 'rgb('+color+')';
      var dot = pill.querySelector('div');
      if(dot) dot.style.background = 'rgb('+color+')';
    }
  }

  function fmtSize(b){
    if(!b) return '0 B';
    if(b < 1024) return b+' B';
    if(b < 1048576) return (b/1024).toFixed(1)+' KB';
    if(b < 1073741824) return (b/1048576).toFixed(1)+' MB';
    return (b/1073741824).toFixed(2)+' GB';
  }

  function copyToClipboard(text){
    try{
      if(navigator.clipboard){
        navigator.clipboard.writeText(text).then(function(){
          if(window.toast) window.toast('✅ Copy URL');
        }).catch(function(){if(window.toast) window.toast(text);});
      }
    }catch(e){if(window.toast) window.toast(text);}
  }

  function fileEmoji(name){
    if(!name) return '📄';
    var e = name.split('.').pop().toLowerCase();
    var m = {jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼',mp4:'🎬',mov:'🎬',mp3:'🎵',pdf:'📕',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',zip:'🗜',apk:'📲',txt:'📋'};
    return m[e] || '📄';
  }

  /* ═══ MAIN ═══ */
  // Electron has its own local HTTP server. Keep the base desktop transfer flow.
  var baseProcessFile = window.processFile;
  window.processFile = function(file){
    if(window.electronAPI && baseProcessFile){ return baseProcessFile(file); }
    if(!file){if(window.toast) window.toast('No file');return;}
    dlogReset();
    dlog('📂 File: '+file.name);
    dlog('📦 Size: '+fmtSize(file.size));
    dlog('🏷️ Type: '+(file.type||'unknown'));
    window.curFile = file;
    if(window.showErr) window.showErr(null);
    var prog = $('prog'); if(prog) prog.classList.add('on');
    var pi = $('prog-ic'); if(pi) pi.textContent = fileEmoji(file.name);
    var pn = $('prog-name'); if(pn) pn.textContent = file.name;
    var ps = $('prog-size'); if(ps) ps.textContent = fmtSize(file.size);
    if(window.showXbar) window.showXbar(file.name, fileEmoji(file.name), file.size);
    dlog('🌐 Get IP...');
    getLocalIPFast().then(function(ip){
      var tok = gfMakeToken();
      var url = gfWithToken('http://'+ip+':'+SERVER_PORT+'/', tok);
      window._gfToken = tok;
      window._lastServerIP = ip;
      window._lastServerFile = file;
      dlog('🔗 URL: '+url);
      dlog('🎨 Show QR NOW!', '#FFD700');
      buildInstantQR(url, file);
      if(window.go) window.go('qr');
      if(window.toast) window.toast('⚡ QR พร้อม!');
      if(file.size <= BLOB_THRESHOLD){
        dlog('🟢 Small file path');
        startBlobServer(file, url, ip);
      }else{
        dlog('🔥 Large file path');
        startBackgroundServer(file, url, ip);
      }
    }).catch(function(e){
      dlog('❌ IP error: '+(e&&e.message||e), '#ff5555');
      if(window.GFDiag) window.GFDiag.error('ip.resolve.failed', {err:(e&&e.message)||String(e)});
      if(window.showErr) window.showErr('IP failed');
    });
  };

  /* ═══ FAST PATH: native pick → DIRECT serve from content:// (no copy) ═══ */
  /* วงกลมหลัก: 1 ไฟล์ = เสิร์ฟตรงจากต้นฉบับ (ไม่ก็อป), หลายไฟล์ = รวมเป็น zip */
  /* คืน true = เข้า native path แล้ว, false = ไม่รองรับ → ให้ caller fallback ไป <input> */
  window.gfNativePick = function(){
    var plugin = getPlugin();
    if(!(plugin && plugin.pickFile && isNative())) return false;
    dlogReset();
    dlog('⚡ Native pick...', '#FFD700');
    plugin.pickFile().then(function(res){
      var files = (res && res.files) || (res && res.uri ? [res] : []);
      if(!files.length){ if(window.toast) window.toast('ยกเลิก'); return; }
      if(files.length === 1) gfDirectServe(plugin, files[0]);
      else if(files.every(function(f){return /^image\//.test(f.mimeType||'');})) gfGalleryServe(plugin, files);
      else gfZipAndServe(plugin, files);
    }).catch(function(e){
      var msg = (e && (e.message||e.errorMessage)) || '';
      if(/cancel/i.test(msg)){ dlog('⏹️ Cancelled'); }
      else { dlog('❌ pick: '+msg, '#ff5555'); if(window.toast) window.toast('เลือกไฟล์ไม่ได้'); }
    });
    return true;
  };

  /* 1 ไฟล์ → เสิร์ฟตรงจาก content:// (0-copy เร็วไม่ขึ้นกับขนาด) */
  function gfDirectServe(plugin, f){
    var meta = { name: f.name || 'file', size: +f.size || 0, type: f.mimeType || f.mime || '' };
    window.curFile = meta;
    if(window.showErr) window.showErr(null);
    dlog('📂 '+meta.name+' ('+fmtSize(meta.size)+')');
    var prog=$('prog'); if(prog) prog.classList.add('on');
    var pi=$('prog-ic'); if(pi) pi.textContent=fileEmoji(meta.name);
    var pn=$('prog-name'); if(pn) pn.textContent=meta.name;
    var ps=$('prog-size'); if(ps) ps.textContent=fmtSize(meta.size);
    if(window.showXbar) window.showXbar(meta.name, fileEmoji(meta.name), meta.size);
    if(window.setProgress) window.setProgress('⚡ Direct...', 40);
    dlog('🌐 Get IP...');
    getLocalIPFast().then(function(ip){
      var tok = gfMakeToken();
      var url = gfWithToken('http://'+ip+':'+SERVER_PORT+'/', tok);
      window._gfToken = tok;
      window._lastServerIP = ip;
      window._lastServerFile = meta;
      dlog('🔗 URL: '+url);
      dlog('🎨 Show QR NOW!', '#FFD700');
      buildInstantQR(url, meta);
      if(window.go) window.go('qr');
      if(window.toast) window.toast('⚡ QR พร้อม!');
      dlog('🚀 startServer (content URI, 0-copy)', '#00E676');
      updateQRStatus('🚀 server...', '41,121,255');
      window._lastSavedUri = f.uri;
      window._lastSavedDir = 'ORIGINAL';
      plugin.startServer({uri:f.uri, fileName:meta.name, mimeType:meta.type||'application/octet-stream', port:SERVER_PORT, size:meta.size, token:tok})
        .then(function(res){
          dlog('✅ Server ready (no copy)', '#00E676');
          if(window.GFDiag) window.GFDiag.checkQRToken(res.url||url, res.token||tok);
          finalizeServer(res.url||url, res.ip||ip, meta, 'ready');
        })
        .catch(function(e){
          dlog('❌ Server err: '+(e&&e.message||e), '#ff5555');
          if(window.GFDiag) window.GFDiag.error('server.start.failed', {mode:'direct', err:(e&&e.message)||String(e)});
          if(window.showErr) window.showErr('Server failed');
        });
    }).catch(function(e){
      dlog('❌ IP error: '+(e&&e.message||e), '#ff5555');
      if(window.GFDiag) window.GFDiag.error('ip.resolve.failed', {err:(e&&e.message)||String(e)});
      if(window.showErr) window.showErr('IP failed');
    });
  }

  /* รูปหลายใบ → เสิร์ฟหน้าแกลเลอรี (ไม่ zip): native ปล่อยแต่ละรูปจาก content:// ตรงๆ
     ฝั่งรับสแกน QR → เห็น thumbnail ทุกใบ → iPhone กดค้าง→Save to Photos ได้ทีละใบ */
  function gfGalleryServe(plugin, files){
    var total=0; files.forEach(function(f){ total += (+f.size||0); });
    var meta = { name: files.length+' photos', size: total, type: 'gallery' };
    window.curFile = meta;
    if(window.showErr) window.showErr(null);
    dlog('🖼️ Gallery: '+files.length+' images', '#FFD700');
    var prog=$('prog'); if(prog) prog.classList.add('on');
    var pi=$('prog-ic'); if(pi) pi.textContent='🖼️';
    var pn=$('prog-name'); if(pn) pn.textContent=meta.name;
    var ps=$('prog-size'); if(ps) ps.textContent=fmtSize(total);
    if(window.showXbar) window.showXbar(meta.name, '🖼️', total);
    if(window.setProgress) window.setProgress('⚡ Gallery...', 40);
    getLocalIPFast().then(function(ip){
      var tok = gfMakeToken();
      var url = gfWithToken('http://'+ip+':'+SERVER_PORT+'/', tok);
      window._gfToken = tok;
      window._lastServerIP = ip; window._lastServerFile = meta;
      dlog('🔗 URL: '+url); dlog('🎨 Show QR NOW!', '#FFD700');
      buildInstantQR(url, meta);
      if(window.go) window.go('qr');
      if(window.toast) window.toast('⚡ QR พร้อม!');
      updateQRStatus('🚀 gallery...', '41,121,255');
      window._lastSavedDir = 'ORIGINAL';
      var payload = files.map(function(f){ return {uri:f.uri, name:f.name, mimeType:f.mimeType, size:f.size}; });
      plugin.startGalleryServer({files:payload, port:SERVER_PORT, token:tok})
        .then(function(res){
          dlog('✅ Gallery server ready', '#00E676');
          if(window.GFDiag) window.GFDiag.checkQRToken(res.url||url, res.token||tok);
          finalizeServer(res.url||url, res.ip||ip, meta, 'ready');
        })
        .catch(function(e){
          dlog('❌ Gallery err: '+(e&&e.message||e), '#ff5555');
          if(window.GFDiag) window.GFDiag.error('server.start.failed', {mode:'gallery', err:(e&&e.message)||String(e)});
          if(window.showErr) window.showErr('Server failed');
        });
    }).catch(function(e){
      dlog('❌ IP error: '+(e&&e.message||e), '#ff5555');
      if(window.GFDiag) window.GFDiag.error('ip.resolve.failed', {err:(e&&e.message)||String(e)});
      if(window.showErr) window.showErr('IP failed');
    });
  }

  /* หลายไฟล์ → อ่าน bytes ทีละไฟล์ผ่าน plugin แล้วรวมเป็น zip → เสิร์ฟผ่าน flow ปกติ */
  function gfZipAndServe(plugin, files){
    dlog('📦 หลายไฟล์: '+files.length+' → zip', '#FFD700');
    if(window.showErr) window.showErr(null);
    if(window.toast) window.toast('⏳ รวม '+files.length+' ไฟล์...');
    var pgEl=$('prog'); if(pgEl) pgEl.classList.add('on');
    var blobs=[];
    function b64ToBlob(b64,type){var bin=atob(b64||''),len=bin.length,ch=65536,parts=[];for(var o=0;o<len;o+=ch){var sl=bin.slice(o,o+ch),a=new Uint8Array(sl.length);for(var i=0;i<sl.length;i++)a[i]=sl.charCodeAt(i);parts.push(a);}return new Blob(parts,{type:type||'application/octet-stream'});}
    (function readNext(i){
      if(i>=files.length){
        if(!blobs.length){ if(window.showErr) window.showErr('อ่านไฟล์ไม่ได้'); return; }
        if(typeof window.loadJSZip!=='function'){ if(window.showErr) window.showErr('JSZip ไม่พบ'); return; }
        if(window.setProgress) window.setProgress('Zipping '+blobs.length+' files...', 25);
        window.loadJSZip(function(){
          var zip=new JSZip();
          blobs.forEach(function(b){zip.file(b.name,b.blob);});
          zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}}).then(function(zblob){
            var d=new Date().toISOString().slice(0,10);
            window.processFile(new File([zblob],'goodfile-'+d+'.zip',{type:'application/zip'}));
          });
        });
        return;
      }
      var f=files[i];
      if(window.setProgress) window.setProgress('Reading '+(i+1)+'/'+files.length+'...', 12);
      plugin.readReceivedFile({path:f.uri, name:f.name}).then(function(r){
        blobs.push({name:(f.name||('file'+i)), blob:b64ToBlob(r&&r.data,(r&&r.mimeType)||f.mimeType)});
        readNext(i+1);
      }).catch(function(){ dlog('⚠️ อ่านไม่ได้: '+(f.name||i), '#ffaa44'); readNext(i+1); });
    })(0);
  }

  function startBlobServer(file, url, ip){
    if(window.setProgress) window.setProgress('⚡ Quick...', 50);
    if(!pluginAvailable()){
      dlog('⚠️ No plugin → preview', '#ffaa44');
      finalizeServer(url, ip, file, 'preview');
      return;
    }
    fastWriteSmall(file, url, ip);
  }

  function fastWriteSmall(file, url, ip){
    var Filesystem = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    if(!Filesystem){
      dlog('❌ Filesystem missing', '#ff5555');
      finalizeServer(url, ip, file, 'preview');
      return;
    }
    dlog('💾 Write small to CACHE...');
    if(window.setProgress) window.setProgress('⚡ Write...', 60);
    updateQRStatus('⏳ เตรียม...', '255,193,7');
    var safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
    var reader = new FileReader();
    reader.onload = function(){
      dlog('📤 To Filesystem...');
      var b64 = reader.result.split(',')[1];
      reader = null;
      Filesystem.writeFile({path:safeName, data:b64, directory:'CACHE', recursive:false})
        .then(function(res){
          dlog('✅ Written: '+res.uri);
          launchServer(res.uri, 'CACHE', file, url, ip);
        })
        .catch(function(e){
          dlog('❌ Write fail: '+(e&&e.message||e), '#ff5555');
          if(window.showErr) window.showErr('Write failed');
        });
    };
    reader.onerror = function(){dlog('❌ Read error', '#ff5555');};
    dlog('📖 Reading as base64...');
    reader.readAsDataURL(file);
  }

  function startBackgroundServer(file, url, ip){
    var Filesystem = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    if(!Filesystem){
      dlog('❌ Filesystem missing', '#ff5555');
      finalizeServer(url, ip, file, 'preview');
      return;
    }
    updateQRStatus('⏳ ไฟล์ใหญ่...', '255,193,7');
    if(window.setProgress) window.setProgress('🔥 BG write...', 45);
    var isSamsung = /SM-|Samsung|SCG|SCV|SGH|SHV|SPH|SCH/.test(navigator.userAgent||'');
    var safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
    var DIRS = isSamsung
      ? ['DOCUMENTS','EXTERNAL_STORAGE','CACHE','DATA']
      : ['CACHE','DATA','DOCUMENTS','EXTERNAL_STORAGE'];
    dlog('🔥 Large path. Samsung='+isSamsung);
    tryWriteWithFallback(Filesystem, DIRS, 0, safeName, file, function(uri, dir){
      launchServer(uri, dir, file, url, ip);
    });
  }

  function tryWriteWithFallback(Filesystem, dirs, idx, safeName, file, onDone){
    if(idx >= dirs.length){
      dlog('❌ All dirs fail', '#ff5555');
      if(window.showErr) window.showErr('Cannot write');
      return;
    }
    var dir = dirs[idx];
    dlog('🔍 Test dir: '+dir);
    Filesystem.writeFile({path:'_gf_test.tmp', data:'YQ==', directory:dir, recursive:false})
      .then(function(){
        dlog('✅ Dir OK: '+dir);
        try{Filesystem.deleteFile({path:'_gf_test.tmp', directory:dir}).catch(function(){});}catch(e){}
        writeFileInChunks(Filesystem, file, safeName, dir, onDone);
      })
      .catch(function(){
        dlog('⏭️ '+dir+' fail', '#ffaa44');
        tryWriteWithFallback(Filesystem, dirs, idx+1, safeName, file, onDone);
      });
  }

  function writeFileInChunks(Filesystem, file, safeName, dir, onDone){
    var total = file.size;
    var isSamsung = /SM-|Samsung|SCG|SCV|SGH|SHV|SPH|SCH/.test(navigator.userAgent||'');
    var CHUNK;
    if(total <= 10*1024*1024)      CHUNK = total;
    else if(total <= 100*1024*1024) CHUNK = isSamsung ? 2*1024*1024 : 3*1024*1024;
    else if(total <= 500*1024*1024) CHUNK = isSamsung ? 3*1024*1024 : 4*1024*1024;
    else                            CHUNK = isSamsung ? 4*1024*1024 : 5*1024*1024;
    var nChunks = Math.ceil(total / CHUNK);
    dlog('📊 '+nChunks+' chunks x '+(CHUNK/1048576).toFixed(1)+'MB');
    var idx = 0, uri = null, startTime = Date.now();
    function nextChunk(){
      if(idx >= nChunks){
        dlog('✅ All chunks done ('+((Date.now()-startTime)/1000).toFixed(1)+'s)');
        if(!uri){
          Filesystem.getUri({path:safeName, directory:dir})
            .then(function(u){onDone(u.uri, dir);})
            .catch(function(){onDone(safeName, dir);});
        }else onDone(uri, dir);
        return;
      }
      var offset = idx * CHUNK;
      var blob = file.slice(offset, Math.min(offset+CHUNK, total));
      var pctRaw = offset / total;
      var pct = 45 + Math.round(pctRaw * 45);
      if(idx%5===0 || idx===nChunks-1) dlog('📝 '+(idx+1)+'/'+nChunks+' ('+Math.round(pctRaw*100)+'%)');
      if(window.setProgress) window.setProgress('🔥 '+(idx+1)+'/'+nChunks, pct);
      updateQRStatus('⏳ '+Math.round(pctRaw*100)+'%', '255,193,7');
      var r = new FileReader();
      r.onload = function(){
        var b64 = r.result.split(',')[1]; r = null;
        var op = (nChunks===1 || idx===0)
          ? Filesystem.writeFile({path:safeName, data:b64, directory:dir, recursive:false})
          : Filesystem.appendFile({path:safeName, data:b64, directory:dir});
        op.then(function(res){
          if(res && res.uri) uri = res.uri;
          b64 = null; idx++;
          setTimeout(nextChunk, isSamsung ? 30 : 5);
        }).catch(function(e){
          dlog('❌ Chunk '+idx+' fail: '+(e&&e.message||e), '#ff5555');
          if(window.showErr) window.showErr('Write error');
        });
      };
      r.onerror = function(){dlog('❌ Read err', '#ff5555');};
      r.readAsDataURL(blob);
    }
    nextChunk();
  }

  function launchServer(uri, dir, file, fallbackURL, fallbackIP){
    var plugin = getPlugin();
    if(!plugin){
      dlog('⚠️ No FileServer → preview', '#ffaa44');
      finalizeServer(fallbackURL, fallbackIP, file, 'preview');
      return;
    }
    dlog('🚀 Start FileServer...');
    if(window.setProgress) window.setProgress('🚀 Start...', 95);
    updateQRStatus('🚀 server...', '41,121,255');
    window._lastSavedUri = uri;
    window._lastSavedDir = dir;
    plugin.startServer({uri:uri, fileName:file.name, mimeType:file.type||'application/octet-stream', port:SERVER_PORT, token:window._gfToken||''})
      .then(function(res){
        dlog('✅ Server: '+(res.url||fallbackURL));
        finalizeServer(res.url||fallbackURL, res.ip||fallbackIP, file, 'ready');
      })
      .catch(function(e){
        dlog('❌ Server err: '+(e&&e.message||e), '#ff5555');
        if(window.showErr) window.showErr('Server failed');
      });
  }

  function finalizeServer(url, ip, file, mode){
    var totalTime = ((Date.now()-_t0)/1000).toFixed(2);
    dlog('🎉 DONE '+totalTime+'s (mode='+mode+')', '#FFD700');
    window.srvURL = url;
    var srv = $('srv'); if(srv) srv.style.display = 'block';
    var su = $('srv-url'); if(su) su.textContent = url;
    // The QR on screen was painted from the pre-flight URL. If the server came
    // back with a different one (different token or IP), the visible QR is now
    // wrong and every scan would 401 -- repaint it from the authoritative URL.
    if(url !== _paintedQRURL){
      dlog('♻️ QR repaint (server URL differs)', '#ffaa44');
      buildInstantQR(url, file);
    }
    if(window.setProgress) window.setProgress('✅ Running', 100);
    if(window.setBadge) window.setBadge(ip?'📡 '+ip:'Live', true);
    updateQRStatus(mode==='preview' ? '🔍 Preview' : '✅ พร้อม download', mode==='preview' ? '120,120,255' : '0,230,118');
    var xn = $('xbar-name'); if(xn) xn.textContent = '✓ '+file.name;
    if(window.hideXbar) setTimeout(window.hideXbar, 2500);
    if(window.toast) window.toast('✅ Server: '+(ip||''));
    setTimeout(function(){if(window.showSuccess) window.showSuccess(file.name, fmtSize(file.size));}, 300);
    var port = parseInt((url.match(/:(\d+)/)||[0,SERVER_PORT])[1]);
    // mDNS advertises a download URL too; without the token the devices it finds
    // hit the same 401 the QR path used to.
    var tok = (url.match(/[?&]t=([^&]+)/) || [])[1] || window._gfToken || '';
    if(window.nsdRegister) window.nsdRegister(port, file.name, tok);
    if(window.linkShow) setTimeout(window.linkShow, 500);
    // Offer the no-QR push path once the server is genuinely up.
    if(window.nearbyStartForSend) setTimeout(window.nearbyStartForSend, 500);
    if(window.qrTabAvail) window.qrTabAvail(true);
    if(window.goodfileRegisterDownloadPair) window.goodfileRegisterDownloadPair(url);
    _serverReady = true;
  }

  function pluginAvailable(){return !!(getPlugin() && isNative());}

  /* ═══ CLEANUP ═══ */
  var _origStop = window.doStop;
  window.doStop = function(){
    if(_blobURL){try{URL.revokeObjectURL(_blobURL);}catch(e){}_blobURL=null;}
    _serverReady = false;
    if(window.goodfileCancelDownloadPair) window.goodfileCancelDownloadPair();
    if(_origStop) _origStop();
  };

  /* ═══ STARTUP ═══ */
  _t0 = Date.now();
  dlog('✅ Patch v3 loaded', '#FFD700');
  dlog('📱 Native: '+isNative());
  dlog('📦 FileServer: '+(getPlugin()?'OK':'MISSING'));
  dlog('💾 Filesystem: '+(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.Filesystem?'OK':'MISSING'));
  dlog('🎨 QRCode: '+(window.QRCode?'OK':'loading...'));
  dlog('👆 ลองเลือกไฟล์เลย!', '#888');

  /* ═══ WARM-UP: ดึง IP จริงจาก native plugin ตั้งแต่เปิดแอป ═══ */
  /* แก้ปัญหา Android mDNS ที่ทำให้ WebRTC คืน 127.0.0.1 */
  (function warmIP(){
    var fs = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FileServer;
    if(fs && fs.getIP){
      fs.getIP().then(function(res){
        var ip = res && res.ip;
        if(ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1' && ip !== '0.0.0.0' && ip.indexOf('169.254.') !== 0){
          window.deviceIP = ip;
          cacheIP(ip);
          dlog('🟢 Warm IP: '+ip, '#00E676');
        }
      }).catch(function(){});
    }
  })();

  console.log('%c⚡ goodfile Patch v3',
    'background:#00E676;color:#000;padding:4px 8px;border-radius:4px;font-weight:bold');

})();