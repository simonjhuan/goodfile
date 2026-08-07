/*
 * This project does not run `cap sync` during the Android build, so
 * android/app/src/main/assets/public/ is a hand-maintained copy of www/.
 * Whatever sits in assets/public is what actually ships inside the APK.
 *
 * Edit www/index.html, forget the copy, and the build silently packages the
 * OLD code. You then debug a fix that was never in the app you installed.
 *
 * Run: npm test
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'www');
const SHIPPED = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function run() {
  if (!fs.existsSync(SHIPPED)) {
    console.error(`FAIL: ${path.relative(ROOT, SHIPPED)} does not exist -- the APK has no web assets.`);
    process.exit(1);
  }

  const webFiles = fs.readdirSync(SRC).filter((f) => /\.(html|js|css)$/i.test(f));
  const problems = [];

  for (const f of webFiles) {
    const shippedPath = path.join(SHIPPED, f);
    if (!fs.existsSync(shippedPath)) {
      problems.push(`${f}: in www/ but NOT in the APK assets -- it will 404 at runtime`);
      continue;
    }
    if (sha(path.join(SRC, f)) !== sha(shippedPath)) {
      problems.push(`${f}: www/ and APK assets differ -- the APK ships the older copy`);
    }
  }

  // A leftover in assets/public that no longer exists in www/ is dead weight and,
  // worse, can keep answering for a file you think you deleted.
  const shippedFiles = fs.readdirSync(SHIPPED).filter((f) => /\.(html|js|css)$/i.test(f));
  for (const f of shippedFiles) {
    // cordova.js / cordova_plugins.js are generated stubs, not sourced from www/.
    if (/^cordova(_plugins)?\.js$/.test(f)) continue;
    if (!fs.existsSync(path.join(SRC, f))) {
      problems.push(`${f}: stale file in APK assets with no counterpart in www/`);
    }
  }

  if (problems.length) {
    console.error('FAIL: web assets are out of sync\n');
    problems.forEach((p) => console.error('  - ' + p));
    console.error('\nFix:  npm run sync');
    process.exit(1);
  }

  console.log(`PASS  ${webFiles.length} web assets identical in www/ and APK assets`);
}

run();
