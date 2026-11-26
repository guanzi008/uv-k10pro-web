// SPDX-License-Identifier: MIT
// DOM simulation only: no browser process, network device, or hardware API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function environment() {
  const errors = [], downloads = [], timers = new Set(), originalTimeout = globalThis.setTimeout;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: 'http://localhost:4173/', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  // JSDOM intentionally omits modal top-layer behavior. Simulate only the
  // standard open/close property and close event used by this application.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.HTMLAnchorElement.prototype.click = function () { downloads.push({ filename: this.download, href: this.href }); };
  window.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(event.reason));
  const unhandled = reason => errors.push(reason);
  process.on('unhandledRejection', unhandled);
  const replacements = { window, document: window.document, navigator: window.navigator,
    Event: window.Event, CustomEvent: window.CustomEvent, AbortController: window.AbortController,
    File: window.File, Node: window.Node, HTMLElement: window.HTMLElement, isSecureContext: true,
    setTimeout(callback, milliseconds, ...args) { const timer = originalTimeout(callback, milliseconds, ...args); timers.add(timer); return timer; } };
  const originals = new Map();
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return { window, document: window.document, errors, downloads,
    cleanup() {
      for (const timer of timers) clearTimeout(timer);
      process.off('unhandledRejection', unhandled);
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
      window.close();
    } };
}

async function eventually(predicate, message) {
  const until = Date.now() + 3000;
  while (Date.now() < until) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), message);
}
function required(selector, root = document) { const result = root.querySelector(selector); assert.ok(result, `Missing ${selector}`); return result; }
function namedButton(name, root = document) {
  const result = [...root.querySelectorAll('button')].find(button => button.textContent.trim() === name);
  assert.ok(result, `Missing button: ${name}`); return result;
}
async function press(button) { assert.equal(button.disabled, false, `Disabled: ${button.textContent}`); button.click(); await delay(0); }
async function nav(view) { await press(required(`[data-view="${view}"]`)); }
function input(key, value, root = required('#editor-dialog')) {
  const field = required(`[data-field-key="${key}"]`, root);
  if (field.type === 'checkbox') field.checked = value; else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return field;
}
function submit(form) { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
async function saveEditor() {
  submit(required('#editor-dialog form'));
  await eventually(() => !required('#editor-dialog').open, 'Editor did not save: ' + required('#editor-dialog').textContent);
}
function radioRow(number, band = 'FM') {
  const result = [...document.querySelectorAll('#view-host tbody tr')].find(row => row.cells[0].textContent.trim() === String(number) && row.cells[1].textContent.trim() === band);
  assert.ok(result, `Missing ${band} record ${number}`); return result;
}

test('real app: offline demo edits survive navigation; FM is shared; device writes stay blocked', async () => {
  const env = environment();
  try {
    await import('../src/app.mjs');
    assert.equal(required('#connection-state').textContent, '未连接');
    assert.equal(required('#read-button').disabled, true);
    assert.equal(required('#write-button').disabled, true);
    assert.equal(document.querySelectorAll('#view-host tbody tr').length, 0);
    await press(namedButton('载入演示工作区'));
    await eventually(() => document.querySelector('.demo-banner'), 'Synthetic demo banner missing');
    assert.match(required('#workspace-mode').textContent, /演示/);

    await press(required('#view-host tbody tr button'));
    assert.equal(required('[data-field-key="modulation"]', required('#editor-dialog')).value, '0', 'Opening a select must preserve the stored FM enum');
    input('name', 'DOMTEST01');
    await saveEditor();
    assert.match(required('#view-host tbody tr').textContent, /DOMTEST01/);
    assert.match(required('#view-host tbody tr').textContent, /FM/, 'Changing only a name must preserve modulation');

    await nav('si4732');
    await press(required('button', radioRow(1)));
    input('frequencyMHz', '95.900000');
    await saveEditor();
    await nav('bk1080');
    assert.match(radioRow(1).textContent, /95\.900/);
    assert.deepEqual([...document.querySelectorAll('#view-host tbody tr')].map(row => row.cells[1].textContent.trim()).filter(band => band !== 'FM'), []);
    await press(required('button', radioRow(1)));
    input('frequencyMHz', '96.500000');
    await saveEditor();
    await nav('si4732');
    assert.match(radioRow(1).textContent, /96\.500/);

    await nav('settings');
    const beep = required('[data-field-key="beep"]');
    assert.equal(beep.checked, true);
    input('beep', false, required('.settings-form'));
    submit(required('.settings-form'));
    await delay(10);
    await nav('channels'); await nav('settings');
    assert.equal(required('[data-field-key="beep"]').checked, false);
    const bitmapGroup = [...document.querySelectorAll('.settings-nav-button')].find(button => button.textContent.startsWith('开机图像'));
    assert.ok(bitmapGroup, 'Expected real app startup bitmap settings group');
    await press(bitmapGroup);
    assert.equal(required('[data-action="edit-bitmap"]').disabled, false, 'Bitmap entry is a connected action; canvas rendering is outside DOM simulation');

    const bandGroup = [...document.querySelectorAll('.settings-nav-button')].find(button => button.textContent.startsWith('自定义频段'));
    assert.ok(bandGroup, 'Expected proven band definition editor');
    await press(bandGroup);
    input('custom_enabled', '1', required('.settings-form'));
    input('band_2_rx_start', '145.000000', required('.settings-form'));
    input('band_2_rx_end', '146.000000', required('.settings-form'));
    submit(required('.settings-form')); await delay(10);
    await nav('channels'); await nav('settings');
    assert.equal(required('[data-field-key="custom_enabled"]').value, '1');
    assert.equal(required('[data-field-key="band_2_rx_start"]').value, '145.000000');
    await nav('channels');
    await press(required('#view-host tbody tr button'));
    assert.equal(required('[data-field-key="attribute"]').value, 'auto');
    input('rxMHz', '430.100000'); input('txMHz', '430.100000'); await saveEditor();
    assert.match(required('#view-host tbody tr').textContent, /430\.100/);
    await press(required('#view-host tbody tr button'));
    assert.match(required('#editor-dialog').textContent, /现有属性 0x05/, 'Changing RX must update band attribute from the read plan');
    await press(namedButton('取消', required('#editor-dialog')));

    await nav('scans');
    await press(required('.scan-card button'));
    input('name', 'DOM Scan'); input('members', '1, 3, 5');
    await saveEditor();
    assert.match(required('.scan-card').textContent, /DOM Scan/);
    assert.equal(required('.scan-card .scan-members').textContent.replace(/\s/g, ''), 'CH1CH3CH5');

    await nav('contacts');
    await press(required('#view-host tbody tr button'));
    input('name', 'DOMCONTACT'); input('code', '54321');
    await saveEditor();
    assert.match(required('#view-host tbody tr').textContent, /DOMCONTACT.*54321/);

    await nav('messages');
    await press(required('#view-host tbody tr button'));
    input('text', 'DOM test message');
    await saveEditor();
    assert.match(required('#view-host tbody tr').textContent, /DOM test message/);

    await nav('vfo');
    await press(required('#view-host tbody tr button'));
    input('name', 'DOMVFO'); await saveEditor();
    assert.match(required('#view-host tbody tr').textContent, /DOMVFO/);

    await nav('backup');
    assert.ok(document.querySelectorAll('#view-host tbody tr').length > 0, 'Expected concrete byte differences');
    assert.notEqual(required('#summary-changes').textContent.trim(), '0 字节');
    for (const name of ['导出工作区项目', '导出无损 CSV', '导出 CPS CSV']) await press(namedButton(name));
    await eventually(() => env.downloads.length === 3, `Expected all three export actions to produce downloads; received ${JSON.stringify(env.downloads)}; ${required('#toast-stack').textContent}`);
    assert.ok(env.downloads.some(item => item.filename.endsWith('.k10')));
    await press(required('#write-button'));
    const preview = required('#preview-dialog');
    assert.equal(preview.open, true);
    const write = namedButton('确认写入设备', preview), review = required('#write-review-confirm');
    assert.equal(review.disabled, true); assert.equal(write.disabled, true);
    review.checked = true; review.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(write.disabled, true, 'Changing a checkbox cannot grant offline write permission');
    await press(namedButton('返回编辑', preview));

    await nav('logs');
    const logText = required('.log-output').textContent;
    assert.doesNotMatch(logText, /未实现的操作|ERROR/);
    assert.equal(namedButton('重启设备').disabled, true);
    assert.deepEqual(env.errors.map(error => String(error)), []);
  } finally { env.cleanup(); }
});

test('mount contract: explicit model selection, ephemeral password, and action fields', async () => {
  const env = environment();
  const calls = []; let finishAuthentication, failAuthentication = false;
  let ui;
  try {
    const { mountWorkbench } = await import('../src/ui/workbench.mjs');
    ui = mountWorkbench({ onAction: (type, payload) => {
      if (type === 'authenticate') {
        if (failAuthentication) throw new Error(`Synthetic failure ${payload.password}`);
        calls.push({ type, passwordAtCall: payload.password, payload });
        return new Promise(resolve => { finishAuthentication = resolve; });
      }
      calls.push({ type, payload });
    } });
    ui.render({ capabilities: { serial: true, usb: false, ble: false } });
    await press(required('#connect-button'));
    const connectDialog = required('#connection-dialog'), connect = namedButton('选择设备并连接', connectDialog);
    assert.equal(connect.disabled, true);
    submit(required('form', connectDialog));
    assert.equal(calls.some(call => call.type === 'connect'), false);
    const model = required('#connection-model-confirm'); model.checked = true;
    model.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(connect.disabled, false); submit(required('form', connectDialog)); await delay(0);
    assert.equal(calls.find(call => call.type === 'connect').payload.selectedModel, 'UV-K10 Pro');
    assert.equal(calls.find(call => call.type === 'connect').payload.modelConfirmed, true);

    ui.render({ connection: { state: 'connected', passwordRequired: true, writable: false } });
    assert.equal(required('#authenticate-button').hidden, false);
    assert.equal(required('#read-button').disabled, true);
    await press(required('#authenticate-button'));
    let password = required('#device-password');
    assert.equal(password.type, 'password'); assert.equal(password.autocomplete, 'current-password');
    password.value = 'synthetic-password'; submit(required('#authentication-dialog form'));
    assert.equal(password.value, '');
    assert.equal(calls.find(call => call.type === 'authenticate').passwordAtCall, 'synthetic-password');
    finishAuthentication();
    await eventually(() => !required('#authentication-dialog').open, 'Authentication modal did not close');
    assert.equal(calls.find(call => call.type === 'authenticate').payload.password, '');
    failAuthentication = true;
    await press(required('#authenticate-button'));
    password = required('#device-password'); password.value = 'never-render-this-secret';
    submit(required('#authentication-dialog form')); await delay(0);
    assert.equal(password.value, '');
    assert.doesNotMatch(document.body.textContent, /never-render-this-secret/);
    ui.closeDialog();
    assert.equal(env.window.localStorage.length, 0); assert.equal(env.window.sessionStorage.length, 0);

    ui.render({ connection: { state: 'disconnected', passwordRequired: false },
      workspace: { id: 'action-test', mode: 'offline', bytes: 1 }, settingsGroups: [{ id: 'startup-bitmap', title: '开机图', fields: [
        { type: 'action', key: 'bitmap_editor', label: '预览与绘制开机图', action: 'edit-bitmap', value: '打开像素编辑器' }
      ] }] });
    await nav('settings');
    const action = required('[data-action="edit-bitmap"]');
    assert.equal(action.dataset.skipSubmit, 'true'); assert.equal(action.type, 'button');
    await press(action);
    assert.ok(calls.some(call => call.type === 'edit-bitmap'));
    assert.equal(required('.settings-form button[type="submit"]').hidden, true);
    assert.deepEqual(env.errors.map(error => String(error)), []);
  } finally { ui?.destroy(); env.cleanup(); }
});

test('real app: channel tools, signed BFO, native DAT export and blank channel table are wired to data', async () => {
  const env = environment();
  try {
    await import('../src/app.mjs?channel-tools');
    await press(namedButton('载入演示工作区'));
    await press(required('input[aria-label="选择信道 1"]'));
    await press(namedButton('复制'));
    await press(namedButton('粘贴 1 个信道'));
    input('start', '13'); await saveEditor();
    assert.equal(document.querySelectorAll('#view-host tbody tr').length, 13);
    await press(namedButton('撤销'));
    assert.equal(document.querySelectorAll('#view-host tbody tr').length, 12);
    await press(namedButton('重做'));
    assert.equal(document.querySelectorAll('#view-host tbody tr').length, 13);
    await press(namedButton('批量参数')); input('power', '2'); await saveEditor();
    assert.match(required('#view-host tbody tr').textContent, /TURBO/);
    await press(namedButton('按步进生成'));
    input('start', '20'); input('count', '3'); input('rxStartMHz', '146.000000'); input('stepMHz', '0.025000'); input('namePrefix', 'GEN');
    await saveEditor();
    assert.match(required('#view-host tbody').textContent, /GEN3/);
    assert.match(required('#view-host tbody').textContent, /146\.050000/);

    await nav('si4732');
    const band = required('select[aria-label="广播波段"]'); band.value = 'SW'; band.dispatchEvent(new Event('change', { bubbles: true }));
    await press(required('button', radioRow(1, 'SW')));
    input('demodulation', '2'); input('bfo_hz', '-100'); await saveEditor();
    assert.match(radioRow(1, 'SW').textContent, /-100 Hz/);
    await nav('backup'); await press(namedButton('导出官方 DAT'));
    await eventually(() => env.downloads.some(item => item.filename.endsWith('.dat')), 'Native DAT download was not produced');
    await nav('channels'); await press(namedButton('新建信道表'));
    await press(namedButton('替换工作区', required('#confirm-dialog')));
    await eventually(() => required('#summary-name').textContent === '新建信道表', 'Blank project did not replace workspace');
    assert.equal(document.querySelectorAll('#view-host tbody tr').length, 0);
    assert.equal(required('#read-button').disabled, true);
    await nav('logs'); assert.doesNotMatch(required('.log-output').textContent, /ERROR|未实现的操作/);
    assert.deepEqual(env.errors.map(error => String(error)), []);
  } finally { env.cleanup(); }
});

test('credential dialog confirms direct change and erases all inputs without echoing controller secrets', async () => {
  const env = environment(); let ui, submitted, atCall, reject;
  try {
    const { mountWorkbench } = await import('../src/ui/workbench.mjs');
    ui = mountWorkbench({ onAction(type, payload) {
      if (type === 'change-credentials') {
        submitted = payload; atCall = { ...payload };
        return new Promise((_, fail) => { reject = fail; });
      }
    } });
    ui.render({ connection: { state: 'connected', writable: true, passwordRequired: false } });
    ui.openCredentials({ kind: 'programming', passwordRequired: true });
    const dialog = required('#credentials-dialog'), form = required('form', dialog);
    required('#credential-current').value = 'old-synthetic-secret';
    required('#credential-new').value = 'new-synthetic-secret';
    required('#credential-confirm').value = 'different-secret';
    const review = required('#credential-review-confirm');
    review.checked = true;
    submit(form); await delay(0);
    assert.equal(submitted, undefined, 'Mismatched confirmation cannot reach the controller');
    required('input[name="confirm"]').value = 'new-synthetic-secret';
    submit(form); await delay(0);
    assert.equal(atCall.currentPassword, 'old-synthetic-secret'); assert.equal(atCall.newPassword, 'new-synthetic-secret');
    assert.ok([...dialog.querySelectorAll('input[type="password"]')].every(input => input.value === ''));
    reject(new Error('Never render new-synthetic-secret')); await delay(0);
    assert.doesNotMatch(document.body.textContent, /new-synthetic-secret|old-synthetic-secret/);
    assert.equal(submitted.currentPassword, ''); assert.equal(submitted.newPassword, ''); assert.equal(submitted.confirmPassword, '');
    assert.equal(env.window.localStorage.length, 0); assert.equal(env.window.sessionStorage.length, 0);
    ui.closeDialog();
    ui.openCredentials({ kind: 'startup' });
    required('#credential-disable').click();
    assert.equal(required('input[name="new"]').disabled, true);
    assert.equal(required('input[name="confirm"]').disabled, true);
    ui.closeDialog();
  } finally { ui?.destroy(); env.cleanup(); }
});

test('BLE discovery UI exposes only observed write and notification characteristics', async () => {
  const env = environment(); let ui; const calls = [];
  const service = '0000ff12-0000-1000-8000-00805f9b34fb', write = '0000fff2-0000-1000-8000-00805f9b34fb', notify = '0000fff3-0000-1000-8000-00805f9b34fb';
  try {
    const { mountWorkbench } = await import('../src/ui/workbench.mjs');
    ui = mountWorkbench({ onAction(type, payload) {
      calls.push({ type, payload: { ...payload } });
      if (type === 'discover-ble') return { serviceUuid: service, characteristics: [
        { uuid: write, properties: { write: true } }, { uuid: notify, properties: { notify: true } },
        { uuid: '0000fff1-0000-1000-8000-00805f9b34fb', properties: { read: true } } ] };
    } });
    ui.render({ capabilities: { ble: true, serial: false, usb: false } });
    await press(required('#connect-button'));
    const dialog = required('#connection-dialog');
    input('serviceUuid', service, dialog);
    await press(namedButton('检查 BLE 服务', dialog));
    await eventually(() => document.querySelector('[data-field-key="writeUuid"]')?.tagName === 'SELECT', 'Discovered choices were not rendered');
    const tx = required('[data-field-key="writeUuid"]', dialog), rx = required('[data-field-key="notifyUuid"]', dialog);
    assert.deepEqual([...tx.options].map(option => option.value), ['', write]);
    assert.deepEqual([...rx.options].map(option => option.value), ['', notify]);
    assert.equal(calls.filter(call => call.type === 'connect').length, 0, 'Inspection must not implicitly start programming');
    input('writeUuid', write, dialog); input('notifyUuid', notify, dialog); input('wireMode', 'plain', dialog); input('responseChecksum', 'placeholder', dialog);
    await press(namedButton('导出连接配置', dialog));
    assert.equal(calls.find(call => call.type === 'export-ble-profile').payload.writeUuid, write);
    assert.equal(required('[data-field-key="mtuPayload"]', dialog).max, '244');
    assert.deepEqual(env.errors.map(error => String(error)), []);
  } finally { ui?.destroy(); env.cleanup(); }
});

test('real app: APRS preview stays offline, preserves drafts, and invalidates after edits', async () => {
  const env = environment();
  try {
    await import('../src/app.mjs?live-offline');
    await nav('live');
    const form = required('form[aria-label="APRS 消息"]');
    for (const [key, value] of Object.entries({ source:'N0CALL', sourceSsid:'07', destination:'APTEST', destinationSsid:'0.0',
      addressee:'TEST-1', path:'WIDE1-1', text:'Hello|~{' })) input(key,value,form);
    submit(form);
    await eventually(() => document.querySelector('.live-message-preview'), 'APRS preview was not built');
    assert.equal(required('.live-message-preview').textContent, ':TEST-1   :Hello');
    assert.match(required('.live-preview').textContent, /移除 3/);
    required('#live-send-confirm').click();
    assert.equal(namedButton('发送一次').disabled, true, 'Offline preview cannot transmit');
    await nav('channels'); await nav('live');
    assert.equal(required('[data-field-key="text"]').value, 'Hello|~{');
    input('text','Changed',required('form[aria-label="APRS 消息"]'));
    assert.equal(document.querySelector('.live-message-preview'), null);
    assert.equal(required('#live-send-confirm').checked, false);
    assert.equal(namedButton('同步一次位置与时间').disabled, true);
    assert.equal(env.window.localStorage.length, 0); assert.equal(env.window.sessionStorage.length, 0);
    assert.deepEqual(env.errors.map(error => String(error)), []);
  } finally { env.cleanup(); }
});

test('live UI: explicit preview confirmation, passive events, and one-shot position do not cross-trigger', async () => {
  const env = environment(); let ui; const calls = [];
  try {
    const { mountWorkbench } = await import('../src/ui/workbench.mjs');
    const { prepareAprsMessage } = await import('../src/core/aprs-frame.mjs');
    const defaults = { source:'N0CALL',sourceSsid:0,destination:'APTEST',destinationSsid:0,path:'' };
    const live = { canOperate:true,canLocate:true,previewForCurrentSession:true,defaults,events:[] };
    ui = mountWorkbench({ onAction(type,payload) {
      calls.push({type,payload});
      if(type==='preview-aprs') {
        const input = {...payload.values,sourceSsid:Number(payload.values.sourceSsid),destinationSsid:Number(payload.values.destinationSsid)};
        live.preview={...prepareAprsMessage(input),input,id:'synthetic-preview'}; ui.render({live});
      }
      if(type==='locate-browser')return {latitude:30.5,longitude:120.25,altitudeMeters:0,accuracyMeters:12,altitudeUnavailable:true};
    } });
    ui.render({live,connection:{state:'connected',passwordRequired:false}}); ui.navigate('live');
    await press(namedButton('从工作区填入'));
    let form=required('form[aria-label="APRS 消息"]'); input('addressee','TEST-1',form); input('text','Synthetic',form);
    submit(form); await delay(0);
    assert.equal(namedButton('发送一次').disabled,true);
    required('#live-send-confirm').click(); assert.equal(namedButton('发送一次').disabled,false);
    await press(namedButton('发送一次'));
    assert.equal(calls.filter(call=>call.type==='send-aprs').length,1);
    assert.equal(calls.find(call=>call.type==='send-aprs').payload.previewId,'synthetic-preview');

    live.events=[{direction:'receive',time:'2026-11-26T00:00:00Z',source:'TEST-1',destination:'APTEST',information:'<script>synthetic</script>',length:128,packetHex:'abcd',possiblyTruncated:true}];
    ui.render({live});
    assert.equal(document.querySelectorAll('.live-history tbody tr').length,1);
    assert.equal(document.querySelector('.live-history script'),null);
    assert.match(required('.live-history').textContent,/可能被设备截断/);
    assert.equal(calls.filter(call=>call.type==='send-aprs').length,1,'Passive events cannot trigger sending');

    await press(namedButton('读取浏览器当前位置'));
    assert.equal(required('[data-field-key="latitude"]').value,'30.5');
    assert.match(required('form[aria-label="一次性位置同步"]').textContent,/未提供海拔/);
    assert.equal(calls.filter(call=>call.type==='sync-location').length,0);
    required('#live-location-confirm').click(); submit(required('form[aria-label="一次性位置同步"]')); await delay(0);
    assert.equal(calls.filter(call=>call.type==='sync-location').length,1);
    assert.deepEqual(calls.find(call=>call.type==='sync-location').payload.values,{latitude:'30.5',longitude:'120.25',altitudeMeters:'0'});
    assert.deepEqual(env.errors.map(error => String(error)), []);
  } finally { ui?.destroy(); env.cleanup(); }
});

test('real app: cancel browser location ignores its late success callback', async () => {
  const env=environment(); let success;
  try {
    Object.defineProperty(env.window.navigator,'geolocation',{configurable:true,value:{getCurrentPosition(callback){success=callback;}}});
    await import('../src/app.mjs?live-location-cancel'); await nav('live');
    const form=required('form[aria-label="一次性位置同步"]'); input('latitude','12.5',form); input('longitude','34.5',form);
    await press(namedButton('读取浏览器当前位置'));
    assert.equal(typeof success,'function'); assert.equal(required('#task-progress').hidden,false);
    await press(required('#cancel-button'));
    await eventually(()=>required('#task-progress').hidden,'Cancellation did not finish the operation');
    success({coords:{latitude:88,longitude:77,altitude:66,accuracy:5}}); await delay(0);
    assert.equal(required('[data-field-key="latitude"]').value,'12.5');
    assert.equal(required('[data-field-key="longitude"]').value,'34.5');
    assert.equal(required('[data-field-key="altitudeMeters"]').value,'0');
    assert.equal(required('#connection-state').textContent,'未连接');
    assert.deepEqual(env.errors.map(error=>String(error)),[]);
  } finally {env.cleanup();}
});
