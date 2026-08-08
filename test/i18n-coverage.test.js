/*
 * i18n.js translates by substituting known Thai phrases anywhere inside a
 * string. When a phrase is only partially covered you don't get Thai and you
 * don't get English — you get "เซิร์ฟเวอร์Ready · รอเครื่องอื่นScan", which is
 * worse than leaving it untranslated.
 *
 * Every user-facing string on the connection path is checked here: after
 * translation nothing Thai may remain. These are the strings a confused user
 * reads when a transfer isn't working, so they have to land.
 *
 * Run: npm test
 */

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const THAI = /[฀-๿]/;

// stub the browser surface i18n.js expects
const els = {};
global.window = global;
Object.defineProperty(global, 'navigator', {
  value: { language: 'en-US', languages: ['en-US'] },
  configurable: true, writable: true,
});
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
function stubEl() {
  return {
    style: {}, dataset: {}, textContent: '', innerHTML: '', className: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild() {}, addEventListener() {}, setAttribute() {},
    firstChild: null, nextSibling: null, tagName: 'DIV', nodeType: 1,
  };
}
global.document = {
  getElementById: (id) => (els[id] || (els[id] = stubEl())),
  createElement: stubEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: stubEl(),
  body: Object.assign(stubEl(), { firstChild: null }),
  head: stubEl(),
};
global.MutationObserver = function () { return { observe() {}, disconnect() {} }; };

new Function(fs.readFileSync(path.join(__dirname, '..', 'www', 'i18n.js'), 'utf8'))();

const GF = global.GF_I18N;
assert.ok(GF && typeof GF.tr === 'function', 'i18n.js did not expose GF_I18N.tr');
GF.lang = 'en';

/* The connection-status path — what a user sees when a transfer is failing and
   they are deciding whether to delete the app. */
const MUST_TRANSLATE = [
  'กำลังตรวจสอบการเชื่อมต่อ…',
  'เซิร์ฟเวอร์พร้อม · รอเครื่องอื่นสแกน',
  '📱 อีกเครื่องเชื่อมต่อแล้ว ✓',
  'เชื่อมถึงกันได้จริง กำลังรับไฟล์',
  'ยังไม่มีเครื่องไหนเชื่อมต่อ',
  'อีกเครื่องอาจอยู่คนละ WiFi หรือ WiFi นี้บล็อกการเชื่อมต่อ',
  '⚠️ ยังไม่มีเครื่องไหนเชื่อมต่อเข้ามา',
  'ถ้าอีกเครื่องสแกนแล้วหน้าเว็บค้าง แปลว่าสองเครื่องยังคุยกันไม่ได้',
  '1. เช็คว่าทั้งสองเครื่องต่อ WiFi ชื่อเดียวกัน (2.4G กับ 5G ถือว่าคนละวง)',
  '2. ปิดเน็ตมือถือของเครื่องที่ส่ง แล้วกดทดสอบใหม่',
  '3. WiFi โรงแรม ร้านกาแฟ ออฟฟิศ มักบล็อกไม่ให้เครื่องคุยกัน',
  '4. เปิด Hotspot จากเครื่องส่ง แล้วให้อีกเครื่องมาต่อ วิธีนี้ได้ผลเสมอ',
  'ต่ออยู่กับเน็ตมือถือ ไม่ใช่ WiFi',
  'มีคนสแกน QR เก่า',
  'QR ที่เขาสแกนเป็นของรายการก่อนหน้า — ให้เลือกไฟล์ใหม่แล้วให้สแกน QR อันล่าสุด',
  '⚠️ QR ที่สแกนเป็นอันเก่า — ให้สแกนอันใหม่',
  '📡 เครือข่ายเปลี่ยน — อัปเดต QR แล้ว',
  '📋 รายงานปัญหา',
  'คัดลอกรายงานแล้ว — วางในแชตส่งมาได้เลย',
  // one-tap send (no QR)
  '⚡ ส่งตรงถึงเครื่องใกล้เคียง',
  'ไม่ต้องสแกน QR',
  'ส่ง ›',
  '★ เคยส่ง',
  'ส่งสำเร็จ ✓',
  'ได้รับไฟล์แล้ว',
  'ส่งตรงไม่สำเร็จ',
  'ให้อีกเครื่องสแกน QR แทน',
  '❌ ส่งตรงไม่สำเร็จ — ใช้ QR แทนได้',
  'ส่งตรงไม่ได้ — ใช้ QR แทน',
  'กำลังส่งอยู่',
  // home screen: secondary tools + theme
  'เครื่องมือเพิ่มเติม',
  '🟩 ธีมแฮกเกอร์',
  'พื้นหลังตัวอักษรตกแบบ Matrix (ปิดไว้เพื่อให้อ่านง่ายและประหยัดแบต)',
  'ส่งตรงแบบไม่ผ่าน WiFi ร่วม สำหรับ iPhone หรือเมื่อไม่มีเราเตอร์',
];

// Built by concatenation at runtime, so each half must translate on its own.
const INTERPOLATED = [
  ['เครื่องนี้อยู่วง ', '192.168.1.x', ' — อีกเครื่องต้องอยู่ WiFi ชื่อเดียวกัน'],
  ['กำลังส่งไปที่ ', 'Pixel 8', '…'],
  ['✅ ส่งถึง ', 'Pixel 8'],
  ['กำลังส่ง ', '42', '%'],
];

const failures = [];

for (const s of MUST_TRANSLATE) {
  const out = GF.tr(s);
  if (THAI.test(out)) failures.push(`half-translated:\n      TH: ${s}\n      EN: ${out}`);
}

for (const parts of INTERPOLATED) {
  const out = GF.tr(parts.join(''));
  if (THAI.test(out)) failures.push(`half-translated (interpolated):\n      TH: ${parts.join('')}\n      EN: ${out}`);
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} connection string(s) not fully translated\n`);
  failures.forEach((f) => console.error('  - ' + f + '\n'));
  console.error('Add the FULL phrase to DICT in www/i18n.js (partial words produce mixed-language text).');
  process.exit(1);
}

console.log(`PASS  ${MUST_TRANSLATE.length + INTERPOLATED.length} connection strings translate with no Thai left over`);
