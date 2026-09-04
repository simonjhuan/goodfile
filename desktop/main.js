const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

let mainWindow;
let fileServer = null;
let servedBuffer = null;
let servedFileName = '';
let servedMimeType = '';
let servedToken = '';
let receiveServer = null;
let receiveToken = '';
const MAX_RECEIVE_BYTES = 4 * 1024 * 1024 * 1024;

// Windows boxes are full of virtual adapters (VirtualBox, VMware, WSL, Hyper-V,
// VPNs) that answer before the real WiFi/Ethernet card. Returning one of those
// hands the phone a QR pointing at an address it can never reach, which looks
// exactly like "the app is broken". Pick the real LAN interface deliberately.
const VIRTUAL_ADAPTER = /virtualbox|vmware|hyper-v|vethernet|wsl|loopback|bluetooth|vpn|tap-|tailscale|zerotier|npcap|docker/i;

function isPrivateIPv4(addr) {
  return /^192\.168\./.test(addr)
      || /^10\./.test(addr)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(addr);
}

function collectIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      // Node <18 reports family as 'IPv4', >=18 as 4.
      const isV4 = iface.family === 'IPv4' || iface.family === 4;
      if (!isV4 || iface.internal) continue;
      if (/^169\.254\./.test(iface.address)) continue; // link-local, no DHCP
      out.push({ name, address: iface.address });
    }
  }
  return out;
}

function getLanIP() {
  const candidates = collectIPv4();
  const real = candidates.filter(c => !VIRTUAL_ADAPTER.test(c.name));

  // 1. A real WiFi adapter on a private subnet -- what the phone is almost always on.
  const wifi = real.find(c => /wi-?fi|wlan|wireless/i.test(c.name) && isPrivateIPv4(c.address));
  if (wifi) return wifi.address;

  // 2. Any real adapter on a private subnet (wired PC on the same router).
  const lan = real.find(c => isPrivateIPv4(c.address));
  if (lan) return lan.address;

  // 3. Any real adapter at all, then anything left rather than giving up.
  if (real.length) return real[0].address;
  if (candidates.length) return candidates[0].address;
  return '127.0.0.1';
}

function startFileServer(fileName, mimeType, buffer) {
  return new Promise((resolve, reject) => {
    if (fileServer) { fileServer.close(); fileServer = null; }

    servedBuffer = Buffer.from(buffer);
    servedFileName = fileName;
    servedMimeType = mimeType || 'application/octet-stream';
    servedToken = crypto.randomBytes(16).toString('hex');

    const ip = getLanIP();

    fileServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const requestUrl = new URL(req.url, 'http://localhost');

      if (requestUrl.pathname === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ app: 'goodfile', device: 'GoodFile on PC' }));
        return;
      }

      if (requestUrl.pathname === '/download' || requestUrl.pathname === '/api/download') {
        if (requestUrl.searchParams.get('t') !== servedToken) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invalid or expired download link');
          return;
        }
        res.writeHead(200, {
          'Content-Type': servedMimeType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(servedFileName)}"`,
          'Content-Length': servedBuffer.length,
        });
        res.end(servedBuffer);
        return;
      }

      // Download page
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GOODFILE</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#89D4F5,#3AA0DE);font-family:system-ui,sans-serif}
    .card{background:rgba(255,255,255,.25);backdrop-filter:blur(20px);
      border:1.5px solid rgba(255,255,255,.5);border-radius:28px;
      padding:40px 32px;text-align:center;max-width:380px;width:90%}
    .icon{font-size:60px;margin-bottom:16px}
    h1{font-size:22px;font-weight:800;color:#fff;margin-bottom:6px}
    p{font-size:14px;color:rgba(255,255,255,.8);margin-bottom:24px;word-break:break-all}
    a{display:block;padding:16px;border-radius:16px;
      background:linear-gradient(135deg,#52D68A,#27B562);
      color:#fff;font-size:16px;font-weight:700;text-decoration:none;
      box-shadow:0 8px 24px rgba(39,181,98,.45)}
    .size{font-size:12px;color:rgba(255,255,255,.6);margin-top:12px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📦</div>
    <h1>GOODFILE</h1>
    <p>${servedFileName}</p>
    <a href="/download?t=${servedToken}">⬇ Download Now</a>
    <div class="size">${(servedBuffer.length / 1048576).toFixed(2)} MB</div>
  </div>
</body>
</html>`);
    });

    fileServer.listen(8080, '0.0.0.0', () => {
      resolve({ url: `http://${ip}:8080/download?t=${servedToken}`, ip });
    });

    fileServer.on('error', () => {
      fileServer.listen(8081, '0.0.0.0', () => {
        resolve({ url: `http://${ip}:8081/download?t=${servedToken}`, ip });
      });
    });
  });
}


function safeFileName(name) {
  const clean = path.basename(String(name || 'received_file')).replace(/[\\/:*?"<>|]/g, '_').trim();
  return clean || 'received_file';
}

function startReceiveServer() {
  return new Promise((resolve, reject) => {
    if (receiveServer) receiveServer.close();
    receiveToken = crypto.randomBytes(16).toString('hex');
    const ip = getLanIP();
    receiveServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://localhost');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS' }); res.end(); return; }
      if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/upload')) {
        if (requestUrl.searchParams.get('t') !== receiveToken) { res.writeHead(403); res.end('Invalid or expired upload link'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>GoodFile</title><style>body{font-family:system-ui;background:#effaf4;margin:0;display:grid;place-items:center;min-height:100vh}.card{background:#fff;padding:28px;border-radius:20px;text-align:center;box-shadow:0 8px 28px #0002;max-width:340px}button{background:#27b562;color:#fff;border:0;border-radius:12px;padding:13px 20px;font-weight:700;margin-top:14px}</style><main class="card"><h2>📥 Send to PC</h2><p>Select a file to send securely over local Wi-Fi.</p><input id="f" type="file"><br><button id="b">Send file</button><p id="s"></p></main><script>b.onclick=async()=>{let f=document.getElementById('f').files[0];if(!f)return;s.textContent='Uploading…';try{let r=await fetch('/upload?name='+encodeURIComponent(f.name)+'&t=${receiveToken}',{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f});s.textContent=r.ok?'Sent ✓':'Failed: HTTP '+r.status}catch(e){s.textContent='Connection failed'}}</script>`);
        return;
      }
      if (req.method !== 'POST' || requestUrl.pathname !== '/upload' || requestUrl.searchParams.get('t') !== receiveToken) { res.writeHead(403); res.end('Invalid upload request'); return; }
      const length = Number(req.headers['content-length'] || 0);
      if (!Number.isFinite(length) || length > MAX_RECEIVE_BYTES) { res.writeHead(413); res.end('File is too large'); return; }
      const directory = path.join(app.getPath('downloads'), 'GoodFile');
      fs.mkdirSync(directory, { recursive: true });
      const fileName = safeFileName(requestUrl.searchParams.get('name'));
      const destination = path.join(directory, `${Date.now()}-${fileName}`);
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      let received = 0;
      req.on('data', chunk => { received += chunk.length; if (received > MAX_RECEIVE_BYTES) req.destroy(); });
      req.on('aborted', () => output.destroy());
      output.on('error', () => { res.writeHead(500); res.end('Unable to save file'); });
      output.on('finish', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('file-received', { fileName, size: received, path: destination });
        res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, fileName, size: received }));
      });
      req.pipe(output);
    });
    receiveServer.once('error', reject);
    receiveServer.listen(8081, '0.0.0.0', () => resolve({ url: `http://${ip}:8081/upload?t=${receiveToken}`, ip, token: receiveToken }));
  });
}

function stopReceiveServer() {
  if (receiveServer) receiveServer.close();
  receiveServer = null;
  receiveToken = '';
}
function stopFileServer() {
  if (fileServer) { fileServer.close(); fileServer = null; }
  servedBuffer = null;
}

ipcMain.handle('serve-buffer', async (event, fileName, mimeType, arrayBuffer) => {
  return await startFileServer(fileName, mimeType, arrayBuffer);
});

ipcMain.handle('start-receive-server', () => startReceiveServer());
ipcMain.handle('stop-receive-server', () => stopReceiveServer());
ipcMain.handle('stop-server', () => { stopFileServer(); });
ipcMain.handle('get-lan-ip', () => getLanIP());

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    title: 'GOODFILE',
    backgroundColor: '#89D4F5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'www', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopFileServer();
  stopReceiveServer();
  if (process.platform !== 'darwin') app.quit();
});
