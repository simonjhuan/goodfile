'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Android: "Share → GoodFile" reaches the plugin, and the web app drains it.
const manifest = read('android/app/src/main/AndroidManifest.xml');
assert.ok(manifest.includes('android.intent.action.SEND"'), 'Android must accept ACTION_SEND');
assert.ok(manifest.includes('android.intent.action.SEND_MULTIPLE"'), 'Android must accept ACTION_SEND_MULTIPLE');
const plugin = read('android/app/src/main/java/com/goodfile/app/FileServerPlugin.java');
assert.ok(/public void getSharedFiles\(PluginCall call\)/.test(plugin), 'Android plugin exposes getSharedFiles');
assert.ok(plugin.includes('handleOnNewIntent'), 'Android handles shares while the app is running');
const patch = read('www/goodfile-instant-qr-patch.js');
assert.ok(patch.includes('getSharedFiles()') && patch.includes("addListener('shareReceived'"), 'web app drains shared files');

// iOS app: "Copy to goodfile" from Files/Mail lands in the same JS path.
const iosPlugin = read('ios/App/App/FileServerPlugin.swift');
assert.ok(iosPlugin.includes('CAPPluginMethod(name: "getSharedFiles"'), 'iOS plugin exposes getSharedFiles');
assert.ok(read('ios/App/App/Info.plist').includes('CFBundleDocumentTypes'), 'iOS app declares document types');

// iOS Share Extension: embedded in the app, same version, bundle ID the CI signs.
const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
const settings = key => [...pbx.matchAll(new RegExp(`${key} = ([^;]+);`, 'g'))].map(m => m[1]);
const bundleIds = settings('PRODUCT_BUNDLE_IDENTIFIER');
const appId = bundleIds.find(id => !id.endsWith('.share'));
assert.ok(bundleIds.includes(`${appId}.share`), 'extension bundle ID must be <app>.share');
assert.equal(new Set(settings('MARKETING_VERSION')).size, 1,
  'app and Share Extension MARKETING_VERSION must match (App Store rejects a mismatch) — bump both');
assert.ok(/Embed Foundation Extensions[\s\S]*ShareExtension\.appex/.test(pbx), 'app embeds ShareExtension.appex');
assert.ok(pbx.includes('"com.apple.product-type.app-extension"'), 'ShareExtension target exists');
for (const f of ['ShareViewController.swift', 'ShareFileServer.swift', 'Info.plist']) {
  assert.ok(fs.existsSync(path.join(__dirname, '../ios/App/ShareExtension', f)), `ShareExtension/${f} exists`);
}
const extPlist = read('ios/App/ShareExtension/Info.plist');
assert.ok(extPlist.includes('<string>$(PRODUCT_MODULE_NAME).ShareViewController</string>'), 'principal class matches the Swift class');
assert.ok(!/TRUEPREDICATE/.test(extPlist), 'App Review rejects a TRUEPREDICATE activation rule');

const yaml = read('codemagic.yaml');
assert.ok(yaml.includes(`BUNDLE_ID: "${appId}"`), 'Codemagic BUNDLE_ID matches the Xcode app bundle ID');
assert.ok(yaml.includes('fetch-signing-files "$BUNDLE_ID.share"'), 'Codemagic fetches/creates the extension profile');

console.log('PASS Share targets: Android SEND, iOS document types, iOS Share Extension + signing');
