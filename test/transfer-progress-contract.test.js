'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [
  ['UI uses real progress', !read('www/index.html').includes('fakeProgress')],
  ['UI exposes cancel', read('www/index.html').includes('btn-dl-cancel')],
  ['UI exposes resume', read('www/index.html').includes('btn-dl-resume')],
  ['Home exposes receive action', read('www/index.html').includes('id="home-receive"')],
  ['Home receive action is wired', read('www/index.html').includes("on('home-receive','click'")],
  ['Ads wait 15 days', read('www/index.html').includes('AD_BANNER_DELAY_DAYS = 15')],
  ['Android uses its banner unit', read('www/index.html').includes('ca-app-pub-5804107706055854/2934472448')],
  ['iOS uses its banner unit', read('www/index.html').includes('ca-app-pub-5804107706055854/9877829327')],
  ['Ad install age is platform scoped', read('www/index.html').includes("gf_install_ts_'+adPlatform()")],
  ['Android uses its AdMob app ID', read('android/app/src/main/AndroidManifest.xml').includes('ca-app-pub-5804107706055854~3884592036')],
  ['iOS uses its AdMob app ID', read('ios/App/App/Info.plist').includes('ca-app-pub-5804107706055854~2190910995')],
  ['Android receiver requests ranges', read('android/app/src/main/java/com/goodfile/app/DownloaderPlugin.java').includes('setRequestProperty("Range"')],
  ['Android sender returns partial content', read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java').includes('206 Partial Content')],
  ['Android QR opens browser landing page', read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java').includes('port + "/?t=" + tok')],
  ['PC browser can download without app', read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java').includes('No GoodFile installation is needed')],
  ['Instant QR opens browser landing page', read('www/goodfile-instant-qr-patch.js').includes("SERVER_PORT+'/', tok")],
  ['Android receive UI exposes a 4-digit pairing code', read('www/index.html').includes('recv-pair-code')],
  ['Android registers its upload URL with pairing service', read('www/index.html').includes('PAIRING_SERVICE_URL')],
  ['Pairing service is the deployed GoodFile Worker', read('www/index.html').includes('https://goodfile-pair.maew0009.workers.dev')],
  ['Receive server generates a private upload token', read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java').includes('genReceiveToken()')],
  ['Receive server rejects an invalid upload token', read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java').includes('if (!receiveTokenOk(req.path))')],
  ['Browser upload preserves the private token', read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java').includes('encodeURIComponent(tk)')],
  ['Receiver discovery preserves the private token', read('android/app/src/main/java/com/goodfile/app/NsdPlugin.java').includes('?t=')],
  ['Android transfer stays foreground', read('android/app/src/main/AndroidManifest.xml').includes('foregroundServiceType="connectedDevice"')],
  ['iOS native downloader registered', read('ios/App/App/SceneDelegate.swift').includes('DownloaderPlugin()')],
  ['iOS local HTTP is allowed', read('ios/App/App/Info.plist').includes('NSAllowsLocalNetworking')]
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
