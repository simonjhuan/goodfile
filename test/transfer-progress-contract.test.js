'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [
  ['UI uses real progress', !read('www/index.html').includes('fakeProgress')],
  ['UI exposes cancel', read('www/index.html').includes('btn-dl-cancel')],
  ['UI exposes resume', read('www/index.html').includes('btn-dl-resume')],
  ['Android receiver requests ranges', read('android/app/src/main/java/com/goodfile/app/DownloaderPlugin.java').includes('setRequestProperty("Range"')],
  ['Android sender returns partial content', read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java').includes('206 Partial Content')],
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
