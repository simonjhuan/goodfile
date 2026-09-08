'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../www/index.html'), 'utf8');
const code = html.slice(html.indexOf('  function configureHotspotUI()'), html.indexOf('  function hsOnActive('));
for (const ios of [true, false]) {
  const elements = {};
  const el = id => elements[id] || (elements[id] = {style:{},textContent:''});
  let starts = 0;
  const context = { _isIOS:ios, $:el, window:{Capacitor:{Plugins:{Hotspot:{
    start(){starts++; return Promise.resolve({});}, addListener(){}
  }}}}, toast(){}, hsOnActive(){}, hsOnStopped(){} };
  vm.createContext(context);
  vm.runInContext(code, context);
  context.configureHotspotUI();
  context.hsStart();
  if (ios) {
    assert.equal(starts, 0, 'iOS must not invoke the native Hotspot plugin');
    assert.equal(el('btn-hs-start').style.display, 'none');
    assert.equal(el('btn-hs-stop').style.display, 'none');
    assert.equal(el('hs-manual').style.display, '');
    assert.equal(el('hs-status-txt').textContent, 'Set up in Settings');
  } else {
    assert.equal(starts, 1, 'Android must retain native Hotspot startup');
    assert.equal(el('btn-hs-start').disabled, true);
  }
}
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) new vm.Script(match[1]);
}
console.log('PASS Hotspot platform behavior and inline JavaScript syntax');
