// SPDX-License-Identifier: MIT
import { mountWorkbench } from './ui/workbench.mjs';
import { PROFILE, READ_REGIONS, CONFIG_BYTES } from './core/profile.mjs';
import { MemoryWorkspace, executeWritePlan, equalBytes } from './core/workspace.mjs';
import { readChannel, patchChannelInImage, deleteChannel, readVfo, patchVfoInImage, vfoOffset,
  readScanList, patchScanListInImage, CHANNEL_FIELDS, CHANNEL_ENUMS, STEP_HZ } from './core/channel-codec.mjs';
import { RADIO_BANKS, RADIO_CHIPS, RADIO_HEADER_FIELDS, decodeRadioBank, patchRadioStation, patchRadioHeader } from './core/radio-codec.mjs';
import { SETTINGS_FIELDS, SETTINGS_GROUPS, readSetting, patchSettings, readContact, patchContactInImage,
  readMessage, patchMessageInImage, readStartupBitmap, patchStartupBitmap, UNRESOLVED_FEATURES } from './core/settings-codec.mjs';
import { parseMHz, formatMHz, integer, hex, unhex } from './core/encoding.mjs';
import { openBitmapEditor } from './ui/bitmap-editor.mjs';
import { BAND_PLAN_COVERAGE, readVfoBandDefinition, readBandGroups, resolveActiveBands, deriveChannelAttribute,
  patchVfoBandInImage, patchGroupBandInImage, patchBandGroupInImage, patchBandSelection } from './core/band-codec.mjs';
import { exportProject, importProject, importNor, exportNor, exportChannelsCsv, importChannelsCsv,
  exportCpsCsv, exportRadioCsv, importRadioCsv, decodeCsvFile, overlayConfiguration, MAX_FILE_BYTES } from './core/import-export.mjs';
import { saveRecovery, latestRecovery } from './core/recovery.mjs';
import { copyChannels, pasteChannels, moveChannels, sortChannels, batchPatchChannels, generateChannels } from './core/channel-tools.mjs';
import { importCpsDat, exportCpsDat, inspectCpsDatExport } from './core/cps-project.mjs';
import { prepareAprsMessage } from './core/aprs-frame.mjs';
import { createDemoWorkspace } from './demo.mjs';
import { ProgrammingSession, WebSerialTransport, WebUsbTransport, WebBluetoothTransport,
  discoverBleCharacteristics, normalizeBleProfile, parseBleProfile, serializeBleProfile, DEFAULT_K8_BLE_PROFILE, normalizePassword } from './protocol/index.mjs';

const state = { workspace: null, session: null, sessionId: null, controller: null, transport: '',
  connectionState: 'disconnected', logs: [], plan: null, busy: false, view: 'channels', edit: null,
  connectionError: '', progress: null, recoveryProject: null, clipboard: null, bleDevice: null,
  aprsPreview: null, liveEvents: [], lastLocationSync: null };
const ui = mountWorkbench({ onAction: action });
const labels = { aprs_ptt: 'APRS PTT', aprs_tx_channel: 'APRS 发射信道索引', offset_direction: '频差方向',
  bandwidth: '带宽', step_index: '步进', scrambler: '扰频索引', power: '功率', busy_lockout: '繁忙禁发',
  reverse: '倒频', signaling_decode: '信令解码', ptt_id: 'PTT ID', modulation: '调制模式',
  scan_list: '扫描列表索引', squelch: '静噪', signaling_system: '信令系统', aprs_receive: 'APRS 信标源原始值' };
const enumLabels = { ...CHANNEL_ENUMS, step_index: STEP_HZ.map(x => `${x} Hz`),
  busy_lockout: ['关闭', '开启'], reverse: ['关闭', '开启'], signaling_decode: ['关闭', '开启'],
  signaling_system: ['DTMF', '5TONE'], aprs_ptt: ['无', '开始', '结束'],
  ptt_id: ['关闭', '开始', '结束', '开始和结束'] };
enumLabels.scan_list = Object.fromEntries([...Array.from({ length: 32 }, (_, i) => [i, `扫描列表 ${i + 1}`]), [32, '扫描全部信道'], [255, '无']]);
const features = [
  { name: '普通信道 / 双 VFO', supported: true, detail: '999 × 64 B；7 组 A/B，独立属性保留' },
  { name: 'Si4732 / BK1080', supported: true, detail: 'FM 共用 32 存台；Si4732 另有 LW 32 / MW 32 / SW 128，均另含 VFO' },
  { name: 'APRS / 信令 / 联系人', supported: true, detail: '按 K8 与 CPS 结构逐字段编辑，未知值保留' },
  { name: '实机验证', supported: false, detail: '尚无本机实测；协议通过合成端到端测试和静态证据核对' },
  { name: '正常密码认证', supported: true, detail: '输入设备现有密码；6 组官方 PC 原生 MAC 与固件 ARM AES 重放验证，无自动重试' },
  { name: '128 × 64 开机图', supported: true, detail: '标准页格式与有效头已核对，保留头部预留字节' },
  { name: '自定义频段 / 频段组', supported: true, detail: '按固件 144 B 定义及 272 B 组槽编辑；自动属性依据本次已读计划' },
  { name: '正常密码修改', supported: true, detail: '开机数字密码与编程密码独立提交；旧密码认证、回读和新密码验证' },
  { name: 'APRS 实时收发 / 位置同步', supported: true, detail: 'K8 AX.25 消息预览与单次发送、被动接收事件、一次性位置和 RTC 同步' },
  { name: 'NOAA SAME', supported: false, detail: '未进入已检查的 K8 活跃编程流程，不沿用其他机型的布局' },
];

function log(message, level = 'info') {
  state.logs.push({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message: String(message) });
  if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000);
  ui.render({ logs: state.logs.slice() });
}
function needWorkspace() { if (!state.workspace) throw new Error('请先读取设备、导入备份或载入离线演示。'); return state.workspace; }
function needSession() { if (!state.session?.connected) throw new Error('设备尚未连接，或会话已结束。'); return state.session; }
function num(value, min, max, label) {
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) throw new Error(`${label} 必须为整数。`);
  return integer(Number(value), min, max, label);
}
function mhz(hz) { try { return formatMHz(hz); } catch { return '—'; } }
function choice(key, label, value, options, extra = {}) {
  const mapped = options.map((option, index) => typeof option === 'object' ? option : ({ value: index, label: option }));
  if (!mapped.some(o => String(o.value) === String(value))) mapped.unshift({ value, label: `保留原始值 ${value}` });
  return { key, label, type: 'select', value, options: mapped, ...extra };
}
function field(key, label, value, extra = {}) { return { key, label, type: 'text', value, ...extra }; }
function dirty(address, length) { return state.workspace?.rangeDirty(address, length) ?? false; }

function connectionModel() {
  const identity = state.session?.identity;
  const connected = state.session?.connected;
  const trustedWorkspace = state.workspace?.mode === 'device' && state.workspace?.sessionId === state.sessionId;
  let reason = state.connectionError || '请先连接并读取 UV-K10 Pro / K8。';
  if (connected) {
    if (!identity?.versionMatched) reason = '固件版本不匹配或机型未确认：只允许检查，不开放写入。';
    else if (identity.passwordValid !== 0 && !identity.authenticated) reason = '设备要求当前密码，请完成正常认证后读取配置。';
    else if (!trustedWorkspace) reason = '已连接；请先读取本次设备配置，导入或演示文件不授予写入权限。';
    else if (state.workspace?.uncertain) reason = '上一次写入结果不确定，请重新读取设备。';
    else reason = '已建立本次设备基线；写入仍需差异审阅、写前核对与回读验证。';
  }
  return { state: connected ? 'connected' : state.connectionState, label: PROFILE.model,
    transport: state.transport, version: identity?.firmware ?? '',
    writable: Boolean(connected && identity?.writeEnabled && trustedWorkspace && !state.workspace?.uncertain),
    passwordRequired: Boolean(identity && identity.passwordValid !== 0 && !identity.authenticated),
    reason, progress: state.progress };
}

function liveModel() {
  const session = state.session, ws = state.workspace, defaults = {};
  const mappings = { source: 'aprs_own_callsign', sourceSsid: 'aprs_own_ssid', destination: 'aprs_target_callsign',
    destinationSsid: 'aprs_target_ssid', path: 'aprs_path' };
  for (const [key, id] of Object.entries(mappings)) {
    const definition = SETTINGS_FIELDS.find(field => field.id === id);
    if (definition && ws?.has(definition.offset, definition.length)) defaults[key] = readSetting(ws.data, id);
  }
  return { canOperate: Boolean(session?.writeEnabled), canLocate: Boolean(navigator.geolocation && globalThis.isSecureContext),
    preview: state.aprsPreview, events: state.liveEvents.slice(), defaults,
    previewForCurrentSession: Boolean(state.aprsPreview && state.aprsPreview.sessionId === state.sessionId && state.sessionId),
    lastLocationSync: state.lastLocationSync,
    reason: session?.writeEnabled ? '已完成目标型号和访问状态核对。实时指令独立于配置差分提交。' : '连接已确认型号的 UV-K10 Pro 并完成正常认证后，才能发送或同步位置。' };
}

function aprsInput(values) {
  const ssid = (value, label) => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new Error(`${label} 必须为 0–15 的整数。`);
    return integer(Number(value), 0, 15, label);
  };
  return { destination: String(values.destination ?? ''), destinationSsid: ssid(values.destinationSsid, '目标 SSID'),
    source: String(values.source ?? ''), sourceSsid: ssid(values.sourceSsid, '本机 SSID'),
    addressee: String(values.addressee ?? ''), path: String(values.path ?? ''), text: String(values.text ?? '') };
}
function addLiveEvent(event) {
  state.liveEvents.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), ...event });
  if (state.liveEvents.length > 200) state.liveEvents.length = 200;
  ui.render({ live: liveModel() });
}
function receiveLiveEvent(event) {
  const decoded = event.decoded;
  addLiveEvent({ direction: 'receive', source: decoded.source?.label ?? '', destination: decoded.destination?.label ?? '',
    path: decoded.path.map(item => item.label).join(','), information: decoded.information,
    message: decoded.message, packetHex: hex(event.packet), length: event.length, decoded: decoded.valid,
    possiblyTruncated: event.possiblyTruncated, fcsIncluded: false,
    checksumStatus: event.checksumStatus, reservedHex: hex(event.reserved) });
}

function render() {
  const ws = state.workspace;
  const model = { workspace: ws ? { id: ws.id, name: ws.name, mode: ws.mode, bytes: ws.loadedBytes,
      dirtyBytes: ws.dirtyBytes(), modifiedCount: ws.differences().length, complete: ws.complete,
      canUndo: ws.undoStack.length > 0 && !ws.uncertain, canRedo: ws.redoStack.length > 0 && !ws.uncertain,
      clipboardCount: state.clipboard?.records.length ?? 0,
      description: ws.mode === 'demo' ? '合成离线示例；不能作为工厂镜像或直接写入设备。' : ws.complete ? '完整 4 MiB 覆盖；未授予额外设备权限。' : '仅明确覆盖已读区；未读地址不会用空白数据冒充。' }
    : { id: 'empty', name: '尚未载入', mode: 'empty', bytes: 0, dirtyBytes: 0, modifiedCount: 0, complete: false },
    connection: connectionModel(), live: liveModel(), channels: [], vfos: [], contacts: [], messages: [],
    radio: { si4732: [], bk1080: [] }, settingsGroups: [], scans: [], changes: [], logs: state.logs.slice(),
    capabilities: { serial: Boolean(navigator.serial && globalThis.isSecureContext),
      usb: Boolean(navigator.usb && globalThis.isSecureContext), ble: Boolean(navigator.bluetooth && globalThis.isSecureContext),
      defaultBleProfile: DEFAULT_K8_BLE_PROFILE,
      bleReason: '已提供从 K8 App 还原的 K10 Pro 蓝牙预设。连接时会检查实际特征能力；浏览器与实机的长写入仍待验证。', features } };
  if (ws) {
    for (let index = 0; index < 999; index++) {
      if (!ws.has(index * 64, 64) || !ws.has(0x11000 + index, 1)) continue;
      const c = readChannel(ws.data, index);
      model.channels.push({ index, number: index + 1, name: c.name,
        rxMHz: c.deleted ? '' : mhz(c.rx_frequency_hz), txMHz: c.deleted ? '' : mhz(c.derived_tx_frequency_hz_before_reverse),
        mode: c.modulation_name, power: c.power_name, bandwidth: c.bandwidth_name,
        active: !c.deleted, scanList: c.scan_list < 32 ? String(c.scan_list + 1) : c.scan_list === 32 ? '全部' : '—',
        modified: dirty(index * 64, 64) || dirty(0x11000 + index, 1) });
    }
    for (let band = 0; band < 7; band++) for (let side = 0; side < 2; side++) {
      if (!ws.has(vfoOffset(band, side), 64) || !ws.has(0x11000 + 999 + band, 1)) continue;
      const c = readVfo(ws.data, band, side);
      model.vfos.push({ index: band * 2 + side, band: band + 1, side: side ? 'B' : 'A', name: c.name,
        rxMHz: mhz(c.rx_frequency_hz), txMHz: mhz(c.derived_tx_frequency_hz_before_reverse), mode: c.modulation_name,
        power: c.power_name, bandwidth: c.bandwidth_name, active: true, modified: dirty(vfoOffset(band, side), 64) });
    }
    for (const chip of Object.keys(RADIO_CHIPS)) for (const band of RADIO_CHIPS[chip].bands) {
      const b = RADIO_BANKS[band]; if (!ws.has(b.offset, b.length)) continue;
      for (const s of decodeRadioBank(ws.data, chip, band).stations)
        model.radio[chip].push({ index: s.index, number: s.index === 0 ? 'VFO' : s.index, band: band.toUpperCase(),
          name: s.index === 0 ? 'VFO' : `存台 ${s.index}`, frequency: s.empty ? '' : `${mhz(s.frequency_hz)} MHz`,
          mode: s.mode, bfo: band === 'fm' ? '—' : `${s.bfo_hz} Hz`, active: !s.empty,
          modified: dirty(b.offset + 8 + s.index * 8, 8), rangeWarning: !s.empty && !s.in_cps_range });
    }
    for (const [id, title] of Object.entries(SETTINGS_GROUPS)) {
      const definitions = SETTINGS_FIELDS.filter(f => f.group === id && ws.has(f.offset, f.length));
      if (!definitions.length) continue;
      model.settingsGroups.push({ id, title, description: '原始选项按存储值保留；只有实际修改的字段会写入。',
        fields: definitions.map(definition => settingField(ws, definition)) });
    }
    model.settingsGroups.push({ id: 'credentials', title: '设备密码', description: '开机数字密码与编程密码分别处理。密码变更独立提交，完成后需重新连接读取；不会随导入文件自动修改。',
      fields: [
        { key: 'startup_password', label: '开机数字密码', type: 'action', action: 'edit-startup-password', value: '修改开机密码',
          disabled: !connectionModel().writable || state.session?.identity?.startLockFlag !== 0,
          help: state.session?.identity?.startLockFlag ? '设备报告开机密码区已锁定，当前正常写入流程不修改该区。' : '需要本次连接的读取基线；可设置数字密码或清除。' },
        { key: 'programming_password', label: '编程密码', type: 'action', action: 'edit-programming-password', value: '修改编程密码',
          disabled: !connectionModel().writable, help: '已有密码时必须再次输入当前密码；没有密码时可以正常设置。' },
      ] });
    if (ws.has(0x45000, 1032)) {
      const bitmap = readStartupBitmap(ws.data);
      model.settingsGroups.push({ id: 'startup-bitmap', title: '开机图像',
        description: `128 × 64 单色，1024 字节页面格式。${bitmap.valid ? '当前头部有效。' : '当前未设置有效图像，保存时会写入已验证的头部。'}`,
        fields: [{ key: 'bitmap_editor', label: '预览与绘制开机图', type: 'action', action: 'edit-bitmap', value: '打开像素编辑器', help: '支持绘制、反色和本地图像转换。' },
          { key: 'page_bytes_hex', label: '图像页面字节（十六进制）', type: 'textarea', value: hex(bitmap.page_bytes),
            help: '恰好 1024 B / 2048 个十六进制字符；页地址=(y>>3)*128+x，bit=y&7。保存保留头部 +6/+7。' }] });
    }
    if (BAND_PLAN_COVERAGE.every(range => ws.has(range.address, range.length))) {
      const global = readVfoBandDefinition(ws.data), groups = readBandGroups(ws.data), plan = resolveActiveBands(ws.data);
      model.settingsGroups.push({ id: 'band-definition', title: '自定义频段',
        description: `活动计划：${plan.source}；固件有效组选择 ${plan.selected_group}；连续可选组 ${plan.available_group_count}。编辑模式/组选项才切换活动计划。${plan.warnings.length ? ' 原始设置中有会被固件归一化的值，未修改字段仍保留。' : ''}`,
        fields: [choice('custom_enabled', '频段模式', plan.mode_raw, ['固定范围', '自定义范围']),
          choice('selected_group', '自定义频段组', plan.requested_group, [{ value: 0, label: '全局定义' },
            ...groups.groups.filter(group => group.selectable).map(group => ({ value: group.index + 1, label: `组 ${group.index + 1} ${group.name}` }))],
            { help: '固定范围模式的 TX 开关来自全局定义；自定义模式才采用所选组的频率范围。' }), ...bandEditorFields(global.bands)] });
      for (const group of groups.groups) model.settingsGroups.push({ id: `band-group:${group.index}`, title: `频段组 ${group.index + 1}${group.name ? ' · ' + group.name : ''}`,
        description: `每槽 272 B；尾部 112 B 保留。${group.selectable ? '本组位于连续有效组前缀中。' : '本组当前不可被固件选择。'} 必须从第 1 组连续启用，停用时从末组开始。${group.sanitizer_changed_offsets.length ? ' 部分原始字段会由固件归一化。' : ''}`,
        fields: [field('name', '组名（8 个 GB2312 字节）', group.name, { maxLength: 8 }),
          { key: 'enabled', label: '启用本组', type: 'checkbox', value: group.enabled }, ...bandEditorFields(group.bands)] });
    }
    for (const chip of Object.keys(RADIO_CHIPS)) for (const band of RADIO_CHIPS[chip].bands) {
      const b = RADIO_BANKS[band]; if (!ws.has(b.offset, b.length)) continue;
      // FM is shared: expose its header once, with the narrower BK1080 contract
      // available separately to avoid treating AM controls as BK1080 features.
      const header = decodeRadioBank(ws.data, chip, band).header;
      const items = Object.entries(RADIO_HEADER_FIELDS).filter(([key]) => chip !== 'bk1080' || !['agc', 'am_step', 'ssb_step', 'am_bandwidth', 'ssb_bandwidth'].includes(key));
      const headerLabels = { mode: 'VFO / 存台模式', channel_index: '当前存台索引（从 0 开始）', agc: 'AGC 原始索引',
        fm_step: 'FM 步进', am_step: 'AM 步进', ssb_step: 'SSB 步进', am_bandwidth: 'AM 带宽', ssb_bandwidth: 'SSB 带宽' };
      model.settingsGroups.push({ id: `radio-header:${chip}:${band}`, title: `${RADIO_CHIPS[chip].label} ${band.toUpperCase()} 参数`,
        description: band === 'fm' ? 'FM 头与存台是同一物理区域；切换芯片视图不会复制另一份数据。' : '索引和保留字段遵循当前 CPS 结构。',
        fields: items.map(([key, spec]) => spec.options || spec.hz ? choice(key, headerLabels[key], header[key], spec.options ?? spec.hz.map(hz => `${hz} Hz`))
          : field(key, headerLabels[key], header[key], { type: 'number', min: spec.min, max: key === 'channel_index' ? b.preset_count - 1 : spec.max, step: 1 })) });
    }
    for (let index = 0; index < 32; index++) {
      if (!ws.has(0x16000 + index * 128, 128)) continue;
      const s = readScanList(ws.data, index);
      model.scans.push({ index, number: index + 1, name: s.name, channels: s.members.map(x => x + 1),
        priority1: priorityText(s.priorities[0]), priority2: priorityText(s.priorities[1]), modified: dirty(0x16000 + index * 128, 128) });
    }
    for (const kind of ['dtmf', 'five_tone']) for (let index = 0; index < 16; index++) {
      const address = (kind === 'dtmf' ? 0x1a000 : 0x1a800) + index * 24;
      if (!ws.has(address, 24)) continue;
      const c = readContact(ws.data, kind, index);
      model.contacts.push({ index, number: index + 1, type: kind === 'dtmf' ? 'DTMF' : '5TONE', contactKind: kind,
        name: c.name, code: c.code, active: Boolean(c.name || c.code), modified: dirty(address, 24) });
    }
    for (let index = 0; index < 64; index++) {
      if (!ws.has(0x2e000 + index * 256, 256)) continue;
      const m = readMessage(ws.data, index);
      model.messages.push({ index, number: index + 1, name: `预设消息 ${index + 1}${m.valid && !m.cps_visible ? '（官方 PC 中暂不可见）' : ''}`, text: m.text,
        active: m.valid !== false && Boolean(m.text), modified: dirty(0x2e000 + index * 256, 256) });
    }
    model.changes = ws.differences().map(change => ({ ...change,
      label: change.address < 999 * 64 ? `信道 ${Math.floor(change.address / 64) + 1}` : change.region,
      before: change.before_hex.match(/../g)?.join(' ') ?? '', after: change.after_hex.match(/../g)?.join(' ') ?? '' }));
  }
  ui.render(model);
}

function settingField(ws, definition) {
  const f = definition, value = readSetting(ws.data, f.id);
  const extra = { help: f.help ?? (f.raw ? '未经单位换算的设备原始值。' : ''), disabled: !f.writable };
  if ((f.type === 'bool' || f.type === 'bit') && typeof value === 'boolean')
    return { key: f.id, label: f.label, type: 'checkbox', value, ...extra };
  if (f.options) return choice(f.id, f.label, value, f.options, extra);
  const outside = typeof value === 'number' && (value < f.min || value > f.max);
  if (outside) extra.help += ' 当前原始值超出已验证范围；不修改时原样保留，修改后按字段范围校验。';
  return field(f.id, f.label, value, { type: f.type === 'text' || f.type === 'coordinate' ? 'text' : 'number',
    min: outside ? undefined : f.min, max: outside ? undefined : f.max, step: 1, maxLength: f.type === 'text' ? f.length : undefined, ...extra });
}
function bandEditorFields(bands) {
  const fields = [];
  for (const band of bands) {
    const section = `频段索引 ${band.index}`;
    for (const direction of ['rx', 'tx']) {
      const raw = band[`${direction}_enable_raw`] ?? Number(band[`${direction}_enabled`]);
      const key = `band_${band.index}_${direction}_enabled`, label = `${direction.toUpperCase()} 启用`;
      fields.push(raw <= 1 ? { key, label, type: 'checkbox', value: raw === 1, section }
        : choice(key, label, raw, [{ value: 0, label: '关闭' }, { value: 1, label: '开启' }], { section, help: '未知原始值不自动归一化，未修改时保留。' }));
      fields.push(field(`band_${band.index}_${direction}_start`, `${direction.toUpperCase()} 起点 / MHz`, mhz(band[`${direction}_start_hz`]), { section }),
        field(`band_${band.index}_${direction}_end`, `${direction.toUpperCase()} 终点 / MHz`, mhz(band[`${direction}_end_hz`]), { section }));
    }
  }
  return fields;
}
function hasBandPlan(ws) { return BAND_PLAN_COVERAGE.every(range => ws.has(range.address, range.length)); }
function priorityText(value) { return value === 65535 ? null : value === 0x5a5a ? '当前' : value + 1; }
function priorityInput(value) { return value === 65535 ? '' : value === 0x5a5a ? 'current' : String(value + 1); }
function parsePriority(value) { return value === '' ? 65535 : /^current$/i.test(value) || value === '当前' ? 0x5a5a : num(value, 1, 999, '优先信道') - 1; }

function showEditor(kind, record, fields) {
  state.edit = { kind, record, workspaceId: needWorkspace().id, revision: state.workspace.revision,
    original: Object.fromEntries(fields.filter(f => f.key).map(f => [f.key, f.value])) };
  ui.openEditor(kind, record, fields);
}
function openChannel(index, { vfo = false, isNew = false } = {}) {
  const ws = needWorkspace();
  const band = Math.floor(index / 2), side = index % 2;
  const address = vfo ? vfoOffset(band, side) : index * 64;
  ws.require(address, 64); ws.require(0x11000 + (vfo ? 999 + band : index), 1);
  const c = vfo ? readVfo(ws.data, band, side) : readChannel(ws.data, index);
  const record = { index, band, side, isNew, title: vfo ? `VFO ${band + 1}${side ? 'B' : 'A'}` : `信道 ${index + 1}` };
  const fields = [field('name', '名称（最多 10 个 GB2312 字节）', isNew ? '' : c.name, { maxLength: 10 }),
    field('rxMHz', '接收频率 / MHz', isNew ? '' : mhz(c.rx_frequency_hz), { required: true, inputMode: 'decimal', help: '精度 10 Hz；固件当前解析边界为 25–580 MHz。' }),
    field('txMHz', '发射频率 / MHz（倒频前）', isNew ? '' : mhz(c.derived_tx_frequency_hz_before_reverse), { required: true, help: '由接收频率、频差方向及频差存储；倒频另设。' })];
  if (!vfo) fields.push({ key: 'active', label: '启用此信道', type: 'checkbox', value: isNew ? true : !c.deleted });
  fields.push(choice('attribute', vfo ? '共享 VFO 属性原始值（A/B 同频段共用）' : '频段属性', !vfo && hasBandPlan(ws) ? 'auto' : isNew ? '' : c.attribute,
    [...(!vfo && hasBandPlan(ws) ? [{ value: 'auto', label: '根据当前已读设备频段自动分配（保留高位）' }] : []),
      { value: '', label: '请选择已确认的设备频段索引' }, ...Array.from({ length: 7 }, (_, value) => ({ value, label: `频段索引 ${value}` })),
      ...(isNew ? [] : [{ value: c.attribute, label: `保持当前 0x${c.attribute.toString(16).padStart(2, '0')}` }])],
    { help: `设备频段可能自定义；不会按其他型号的频段表猜属性。现有属性 0x${c.attribute.toString(16).padStart(2, '0')}，固件使用低四位判频段；当前 CPS 另按原始值 <7 筛选。` }));
  for (const [key, spec] of Object.entries(CHANNEL_FIELDS)) {
    if (key === 'offset_direction') continue; // Derived from the explicit RX/TX edit.
    const value = isNew ? (key === 'squelch' ? 3 : key === 'step_index' ? 9 : 0) : c[key];
    fields.push(choice(key, labels[key], value, spec.allowed.map(n => ({ value: n, label: enumLabels[key]?.[n] ?? String(n) }))));
  }
  for (const side of ['rx', 'tx']) {
    const tone = isNew ? { kind: 0, value: 0 } : c[`${side}_tone`];
    fields.push(choice(`${side}_tone_kind`, `${side.toUpperCase()} 亚音类型`, tone.kind, CHANNEL_ENUMS.tone));
    fields.push(field(`${side}_tone_value`, `${side.toUpperCase()} 亚音值`, tone.kind === 1 ? `${Math.floor(tone.value / 10)}.${tone.value % 10}` : (tone.kind === 2 || tone.kind === 3) ? tone.value.toString(8).padStart(3, '0') : String(tone.value),
      { help: 'CTCSS 填 Hz（如 88.5）；DCS 填八进制（如 023）；U23/U24 填十进制原始值。' }));
  }
  fields.push(field('scanStartMHz', '频率扫描起点 / MHz', isNew ? '0.000000' : mhz(c.scan_start_hz)),
    field('scanEndMHz', '频率扫描终点 / MHz', isNew ? '0.000000' : mhz(c.scan_end_hz)));
  showEditor(vfo ? 'vfo' : 'channel', record, fields);
}
function parseEditorTone(kindText, valueText) {
  const kind = num(kindText, 0, 5, '亚音类型');
  if (kind === 0) return { kind, value: 0 };
  if (kind === 1) {
    if (!/^\d{2,3}(?:\.\d)?$/.test(valueText)) throw new Error('CTCSS 应为一位小数的 Hz 值。');
    const [whole, part = '0'] = valueText.split('.'); return { kind, value: Number(whole) * 10 + Number(part) };
  }
  if (kind === 2 || kind === 3) {
    if (!/^[0-7]{1,3}$/.test(valueText)) throw new Error('DCS 应为 000–777 范围内的八进制码。');
    return { kind, value: Number.parseInt(valueText, 8) };
  }
  return { kind, value: num(valueText, 0, kind === 4 ? 0x7fffff : 0xffffff, 'U23/U24') };
}
function openRadio(chip, row) {
  const ws = needWorkspace();
  const band = String(row.band ?? 'fm').toLowerCase();
  const b = RADIO_BANKS[band]; ws.require(b.offset, b.length);
  const s = decodeRadioBank(ws.data, chip, band).stations[row.index];
  const bfoEditable = Math.abs(s.bfo_hz) <= 16380 && s.bfo_hz % 10 === 0;
  const fields = [field('frequencyMHz', `${band.toUpperCase()} 频率 / MHz`, s.empty ? '' : mhz(s.frequency_hz), {
    help: `当前 CPS 可编辑范围 ${mhz(b.min_hz)}–${mhz(b.max_hz)} MHz；留空清除此存台，VFO 不可清空。` })];
  if (band !== 'fm') fields.push(choice('demodulation', '接收模式', s.demodulation, [
    { value: 1, label: 'AM' }, { value: 2, label: 'LSB' }, { value: 3, label: 'USB' }]),
    field('bfo_hz', 'BFO / Hz', s.bfo_hz, { type: 'number', min: bfoEditable ? -16380 : undefined,
      max: bfoEditable ? 16380 : undefined, step: bfoEditable ? 10 : 1,
      help: `以 10 Hz 为步进；固件当前生效值为 ${s.bfo_effective_hz} Hz。原始值即使超范围，未修改也会保留。` }));
  showEditor(chip, { ...row, band, index: row.index }, fields);
}
function openScan(index) {
  const ws = needWorkspace(); ws.require(0x16000 + index * 128, 128);
  const s = readScanList(ws.data, index);
  showEditor('scan', { index }, [field('name', '名称（最多 10 个 GB2312 字节）', s.name, { maxLength: 10 }),
    field('members', '扫描成员编号', s.members.map(x => x + 1).join(', '), { type: 'textarea', help: '1–999，逗号分隔，最多 48 个；清空即空列表。' }),
    field('priority1', '优先信道 1', priorityInput(s.priorities[0]), { help: '填信道号；留空关闭；current 表示当前信道。' }),
    field('priority2', '优先信道 2', priorityInput(s.priorities[1]), { help: '填信道号；留空关闭；current 表示当前信道。' })]);
}
function changedValues(values, original) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => Object.hasOwn(original, key) && String(value) !== String(original[key] ?? '')));
}
function openChannelTool(operation, indexes = []) {
  const ws = needWorkspace(), first = indexes[0] ?? 0, fields = [];
  const reference = () => ({ key: 'updateScanLists', label: '同步扫描列表中的成员和优先信道编号', type: 'checkbox', value: true,
    help: '扫描列表会跟随移动后的记录；当前选中信道等其他槽位编号保持原值。' });
  const titles = { paste: '粘贴信道', move: '移动信道', sort: '将排序写入信道槽位', batch: '批量修改参数', generate: '按步进生成信道' };
  if (operation === 'paste') {
    if (!state.clipboard?.records.length) throw new Error('请先复制或剪切信道。');
    fields.push(field('start', '粘贴到第几个信道', first + 1, { type: 'number', min: 1, max: 1000 - state.clipboard.records.length,
      help: `依次覆盖 ${state.clipboard.records.length} 个槽位，保留完整记录与属性；可用“撤销”恢复本地修改。` }));
  } else if (operation === 'move') fields.push(field('before', '插入到此信道之前', first + 1, { type: 'number', min: 1, max: 1000,
    help: '填 1000 移到末尾；中间记录整体移位，不丢弃原有信道。' }), reference());
  else if (operation === 'sort') fields.push(choice('sortKey', '按此字段排序', 'rx', [{ value: 'rx', label: '接收频率' }, { value: 'tx', label: '发射频率（倒频前）' }, { value: 'name', label: '名称' }]),
    { key: 'descending', label: '降序', type: 'checkbox', value: false }, reference());
  else if (operation === 'batch') {
    for (const [key, spec] of Object.entries(CHANNEL_FIELDS)) if (key !== 'offset_direction')
      fields.push(choice(key, labels[key], '', [{ value: '', label: '不修改' }, ...spec.allowed.map(value => ({ value, label: enumLabels[key]?.[value] ?? String(value) }))]));
    for (const side of ['rx', 'tx']) fields.push(choice(`${side}_tone_kind`, `${side.toUpperCase()} 亚音`, '', [{ value: '', label: '不修改' }, ...CHANNEL_ENUMS.tone.map((label, value) => ({ value, label }))]),
      field(`${side}_tone_value`, `${side.toUpperCase()} 亚音值`, '', { help: 'CTCSS 填 Hz；DCS 填八进制；关闭填 0。' }));
  } else if (operation === 'generate') {
    const source = indexes.find(index => readChannel(ws.data, index).deleted === false) ?? Array.from({ length: 999 }, (_, i) => i).find(index => ws.has(index * 64, 64) && ws.has(0x11000 + index, 1) && ws.data[0x11000 + index] !== 255);
    if (source === undefined) throw new Error('请先建立一个已启用信道作为模板。');
    const channel = readChannel(ws.data, source);
    fields.push(field('template', '模板信道编号', source + 1, { type: 'number', min: 1, max: 999 }),
      field('start', '起始目标信道编号', first + 1, { type: 'number', min: 1, max: 999 }), field('count', '生成数量', 1, { type: 'number', min: 1, max: 999 }),
      field('rxStartMHz', '起始接收频率 / MHz', mhz(channel.rx_frequency_hz)), field('stepMHz', '频率步进 / MHz', '0.012500'),
      field('txOffsetMHz', '发射相对接收频差 / MHz', '0.000000', { help: '可填负数，例如 -0.600000。' }),
      field('namePrefix', '名称前缀（可留空）', '', { help: '填写后自动追加序号；完整名称最多 10 个 GB2312 字节。其余参数从模板逐字节复制。' }));
  } else throw new Error('未知信道整理操作。');
  showEditor('channel-tool', { operation, indexes: [...indexes], title: titles[operation], index: first }, fields);
}
function applyChannelTool(ws, record, values) {
  const ref = { updateScanLists: values.updateScanLists === true };
  if (record.operation === 'paste') return pasteChannels(ws, state.clipboard, num(values.start, 1, 999, '目标信道') - 1);
  if (record.operation === 'move') return moveChannels(ws, record.indexes, num(values.before, 1, 1000, '插入位置') - 1, ref);
  if (record.operation === 'sort') return sortChannels(ws, record.indexes, { key: values.sortKey, descending: values.descending === true, ...ref });
  if (record.operation === 'batch') {
    const patch = {};
    for (const key of Object.keys(CHANNEL_FIELDS)) if (values[key] !== undefined && values[key] !== '') patch[key] = num(values[key], 0, 255, labels[key]);
    for (const side of ['rx', 'tx']) if (values[`${side}_tone_kind`] !== '') patch[`${side}_tone`] = parseEditorTone(values[`${side}_tone_kind`], values[`${side}_tone_value`]);
    return batchPatchChannels(ws, record.indexes, patch);
  }
  if (record.operation === 'generate') {
    const offset = values.txOffsetMHz.trim(), negative = offset.startsWith('-');
    return generateChannels(ws, { startIndex: num(values.start, 1, 999, '起始信道') - 1, count: num(values.count, 1, 999, '生成数量'),
      templateIndex: num(values.template, 1, 999, '模板信道') - 1, rxStartHz: parseMHz(values.rxStartMHz), stepHz: parseMHz(values.stepMHz),
      txOffsetHz: parseMHz(negative ? offset.slice(1) : offset.replace(/^\+/, '')) * (negative ? -1 : 1), namePrefix: values.namePrefix });
  }
  throw new Error('未知信道整理操作。');
}
function applyEditor({ kind, record, values }) {
  const ws = needWorkspace(), edit = state.edit;
  if (!edit || edit.kind !== kind || edit.workspaceId !== ws.id || edit.revision !== ws.revision)
    throw new Error('编辑器已过期，请重新打开。');
  record = edit.record; // Only controller-owned indices can select memory.
  const changes = changedValues(values, edit.original);
  let next = ws.data;
  if (kind === 'channel-tool') {
    next = applyChannelTool(ws, record, values);
    if (record.operation === 'paste' && state.clipboard?.cut) state.clipboard = null;
  } else if (kind === 'channel' || kind === 'vfo') {
    const c = kind === 'vfo' ? readVfo(ws.data, record.band, record.side) : readChannel(ws.data, record.index);
    const patch = {};
    if (record.isNew) Object.assign(changes, values);
    if ('name' in changes) patch.name = values.name;
    if ('rxMHz' in changes || 'txMHz' in changes) {
      const rx = parseMHz(values.rxMHz), tx = parseMHz(values.txMHz);
      if (rx < 25000000 || rx > 580000000 || tx < 25000000 || tx > 580000000)
        throw new Error('频率超出固件当前已验证的 25–580 MHz 解析边界。');
      patch.rx_frequency_hz = rx; patch.offset_hz = Math.abs(tx - rx); patch.offset_direction = rx === tx ? 0 : tx > rx ? 1 : 2;
    }
    for (const key of Object.keys(CHANNEL_FIELDS)) if (key in changes) patch[key] = num(values[key], 0, 255, labels[key]);
    for (const side of ['rx', 'tx']) if (`${side}_tone_kind` in changes || `${side}_tone_value` in changes)
      patch[`${side}_tone`] = parseEditorTone(values[`${side}_tone_kind`], values[`${side}_tone_value`]);
    if ('scanStartMHz' in changes) patch.scan_start_hz = parseMHz(values.scanStartMHz);
    if ('scanEndMHz' in changes) patch.scan_end_hz = parseMHz(values.scanEndMHz);
    let attribute;
    if (values.attribute === 'auto') {
      if (!hasBandPlan(ws)) throw new Error('尚未完整读取当前频段定义，不能自动分配信道属性。');
      if ('rxMHz' in changes || 'attribute' in changes || record.isNew || (c.deleted && values.active))
        attribute = deriveChannelAttribute(ws.data, patch.rx_frequency_hz ?? c.rx_frequency_hz, c.attribute);
    } else if ('attribute' in changes || record.isNew) attribute = num(values.attribute, 0, 255, '频段属性');
    if (kind === 'channel') {
      if (values.active && (record.isNew || c.deleted) && !(attribute >= 0 && attribute <= 6))
        throw new Error('启用空槽需要明确选择已确认的设备频段索引 0–6；不会按频率猜测。');
      if (!values.active) attribute = 255;
      if (record.isNew) { next = ws.data.slice(); next.fill(0, record.index * 64, record.index * 64 + 64); }
      next = patchChannelInImage(next, record.index, patch, { attribute });
    } else next = patchVfoInImage(ws.data, record.band, record.side, patch, { attribute });
  } else if (kind === 'si4732' || kind === 'bk1080') {
    const patch = {};
    if ('frequencyMHz' in changes) {
      if (!values.frequencyMHz.trim() && record.index === 0) throw new Error('VFO 不可清空。');
      patch.frequency_hz = values.frequencyMHz.trim() ? parseMHz(values.frequencyMHz) : 0;
    }
    if ('demodulation' in changes) patch.demodulation = num(values.demodulation, 1, 3, '广播模式');
    if ('bfo_hz' in changes) patch.bfo_hz = num(values.bfo_hz, -16380, 16380, 'BFO / Hz');
    next = patchRadioStation(ws.data, kind, record.band, record.index, patch);
  } else if (kind === 'scan') {
    const patch = {};
    if ('name' in changes) patch.name = values.name;
    if ('members' in changes) {
      patch.members = values.members.trim() ? values.members.split(/[,，\s]+/).filter(Boolean).map(x => num(x, 1, 999, '扫描成员') - 1) : [];
      if (new Set(patch.members).size !== patch.members.length) throw new Error('扫描列表中存在重复信道号。');
    }
    if ('priority1' in changes || 'priority2' in changes) patch.priorities = [parsePriority(values.priority1), parsePriority(values.priority2)];
    next = patchScanListInImage(ws.data, record.index, patch);
  } else if (kind === 'contact') next = patchContactInImage(ws.data, record.contactKind, record.index, changes);
  else if (kind === 'message') next = patchMessageInImage(ws.data, record.index, changes);
  else throw new Error('未知编辑器类型。');
  ws.apply(next); state.plan = null; state.edit = null; render();
  log(`已应用 ${kind} 记录 ${record.index + 1} 的本地修改；尚未写入设备。`);
}

async function runBusy(label, operation) {
  if (state.busy) throw new Error('已有操作正在进行，请等待或取消。');
  state.busy = true; state.controller = new AbortController(); ui.setBusy(true, label);
  try { return await operation(state.controller.signal); }
  finally { state.busy = false; state.controller = null; state.progress = null; ui.setBusy(false); render(); }
}
function progress(completed, total, label) {
  state.progress = { value: completed, total, label };
  ui.render({ connection: connectionModel() });
}
async function replaceAllowed() {
  return !state.workspace?.dirtyBytes() || await ui.confirm({ title: '替换当前工作区？',
    message: '当前仍有本地修改。请先导出 .k10 项目保留修改，再替换工作区。', confirmLabel: '替换工作区', danger: true });
}
function download(name, data, type = 'application/octet-stream') {
  const blob = new Blob([data], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function filename(suffix) { return `uv-k10pro-${new Date().toISOString().replace(/[:.]/g, '-')}.${suffix}`; }

async function action(type, payload = {}) {
  try {
    if (state.busy && !['cancel', 'navigate', 'clear-log'].includes(type)) throw new Error('读写操作进行中，请先等待或取消。');
    switch (type) {
      case 'navigate': state.view = payload.view; return;
      case 'preview-aprs': {
        const input = aprsInput(payload.values), prepared = prepareAprsMessage(input);
        state.aprsPreview = { ...prepared, input, id: crypto.randomUUID(), sessionId: state.sessionId };
        ui.render({ live: liveModel() }); return;
      }
      case 'send-aprs': {
        const session = needSession(), preview = state.aprsPreview;
        if (!preview || payload.previewId !== preview.id || preview.sessionId !== state.sessionId || !session.writeEnabled)
          throw new Error('请在本次已认证连接中重新生成 APRS 预览。');
        const prepared = prepareAprsMessage(aprsInput(payload.values));
        if (prepared.packetHex !== preview.packetHex) throw new Error('消息已变化，请重新预览后再发送。');
        if (!prepared.normalizedText.trim()) throw new Error('规范化后的消息正文为空，请修改后重新预览。');
        return await runBusy('发送一次 APRS 消息', async signal => {
          state.aprsPreview = null;
          const result = await session.sendAprs(prepared.packet, { signal });
          addLiveEvent({ direction: 'send', source: `${prepared.source}-${prepared.sourceSsid}`, destination: `${prepared.destination}-${prepared.destinationSsid}`,
            information: prepared.information, packetHex: prepared.packetHex, length: prepared.length,
            accepted: result.accepted, result: result.result, rfDeliveryConfirmed: false, fcsIncluded: true });
          log(result.accepted ? '设备已接受本次 APRS 发送请求；尚未确认无线送达。' : `设备拒绝本次 APRS 发送请求（结果 ${result.result}）；未重试。`, result.accepted ? 'success' : 'warning');
        });
      }
      case 'locate-browser':
        if (!navigator.geolocation) throw new Error('当前浏览器未提供位置 API，可以手工填写经纬度。');
        return await runBusy('获取浏览器位置', signal => new Promise((resolve, reject) => {
          let settled = false;
          const finish = (value, error) => {
            if (settled) return; settled = true; signal.removeEventListener('abort', cancel);
            if (error) reject(error); else resolve(value);
          };
          const cancel = () => finish(null, new Error('已取消浏览器定位，后续位置结果不会应用。'));
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) { cancel(); return; }
          try {
            navigator.geolocation.getCurrentPosition(position => finish({ latitude: position.coords.latitude,
              longitude: position.coords.longitude, altitudeMeters: position.coords.altitude ?? 0,
              accuracyMeters: position.coords.accuracy, altitudeUnavailable: position.coords.altitude == null }),
            () => finish(null, new Error('未取得浏览器位置；请检查授权或手工填写坐标。')), { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
          } catch { finish(null, new Error('浏览器定位调用失败，可以手工填写坐标。')); }
        }));
      case 'sync-location': {
        const session = needSession(), values = payload.values;
        if (!session.writeEnabled) throw new Error('请先连接并完成正常认证。');
        for (const key of ['latitude', 'longitude', 'altitudeMeters']) if (typeof values[key] !== 'string' || !values[key].trim() || !Number.isFinite(Number(values[key])))
          throw new Error('纬度、经度和高度必须为明确的数值。');
        return await runBusy('同步一次位置与时间', async signal => {
          const result = await session.synchronizeLocation({ latitude: Number(values.latitude), longitude: Number(values.longitude),
            altitudeMeters: Number(values.altitudeMeters), signal });
          state.sessionId = crypto.randomUUID(); state.plan = null; state.aprsPreview = null;
          state.lastLocationSync = new Date().toISOString();
          log(`位置与 RTC 已同步一次，旧写入基线已失效。${result.authenticationRequired ? '请重新输入设备密码，再读取配置。' : '继续写入配置前请重新读取。'}`, 'success');
        });
      }
      case 'clear-live-events': state.liveEvents = []; ui.render({ live: liveModel() }); return;
      case 'export-live-events': download(filename('aprs.json'), JSON.stringify({ format: 'uv-k10pro-aprs-events', version: 1, events: state.liveEvents }, null, 2), 'application/json'); return;
      case 'clear-log': state.logs = []; ui.render({ logs: [] }); return;
      case 'undo': needWorkspace().undo(); state.plan = null; render(); return;
      case 'redo': needWorkspace().redo(); state.plan = null; render(); return;
      case 'copy-channels':
        state.clipboard = copyChannels(needWorkspace(), payload.indexes, { cut: payload.cut });
        log(`已${payload.cut ? '剪切选中' : '复制'} ${state.clipboard.records.length} 个信道；${payload.cut ? '粘贴后才清空来源槽位。' : '原始记录与属性一并保留。'}`); render(); return;
      case 'channel-tool': return openChannelTool(payload.operation, payload.indexes);
      case 'cancel': state.controller?.abort(); log('已请求取消；若协议会话中断，需要重新连接。', 'warning'); return;
      case 'demo':
        if (!await replaceAllowed()) return false;
        state.workspace = createDemoWorkspace(); state.plan = null; render();
        log('已载入完全合成的离线演示；未连接或读取设备。', 'info'); return;
      case 'new-channels': {
        if (!await replaceAllowed()) return false;
        const data = new Uint8Array(PROFILE.capacity).fill(255); data.fill(0, 0, 999 * 64);
        state.workspace = new MemoryWorkspace({ name: '新建信道表', data, mode: 'offline', coverage: [{ address: 0, length: 999 * 64 }, { address: 0x11000, length: 999 }],
          provenance: { generated: 'empty channel table; no device settings or factory defaults inferred' } });
        state.clipboard = null; state.plan = null;
        log('已新建空信道表。仅包含信道及属性；编辑空槽时需选择频段，设备设置仍需导入或读取。'); render(); return;
      }
      case 'discover-ble':
        if (state.session?.connected) throw new Error('请先断开编程连接，再检查蓝牙服务。');
        return await runBusy('检查蓝牙服务', async () => {
          const result = await discoverBleCharacteristics({ serviceUuid: payload.serviceUuid });
          state.bleDevice = { device: result.device, serviceUuid: result.serviceUuid };
          log(`蓝牙服务检查完成：${result.characteristics.length} 个特征。未发送写频指令，未同步 RTC。`);
          return { serviceUuid: result.serviceUuid, characteristics: result.characteristics };
        });
      case 'import-ble-profile': {
        if (!(payload.file instanceof File) || payload.file.size > 16384) throw new Error('蓝牙配置文件须小于 16 KiB。');
        const profile = parseBleProfile(new TextDecoder('utf-8', { fatal: true }).decode(await payload.file.arrayBuffer()));
        state.bleDevice = null; return profile;
      }
      case 'export-ble-profile':
        download(filename('ble.json'), serializeBleProfile({ ...payload, mtuPayload: Number(payload.mtuPayload), interWriteDelayMs: Number(payload.interWriteDelayMs ?? 0) }), 'application/json'); return;
      case 'connect':
        if (payload.modelConfirmed !== true || payload.selectedModel !== PROFILE.model) throw new Error('请先明确确认设备本体型号为 UV-K10 Pro。');
        if (state.session?.connected) throw new Error('请先断开当前连接。');
        return await runBusy('连接设备', async signal => {
          state.connectionState = 'connecting'; state.connectionError = ''; state.transport = payload.transport; render();
          const Transport = { serial: WebSerialTransport, usb: WebUsbTransport, ble: WebBluetoothTransport }[payload.transport];
          if (!Transport) throw new Error('不支持的传输方式。');
          const bleProfile = payload.transport === 'ble' ? normalizeBleProfile(payload) : null;
          const device = bleProfile && state.bleDevice?.serviceUuid === bleProfile.serviceUuid ? state.bleDevice.device : undefined;
          const transport = await Transport.request({ ...payload, ...(device ? { device } : {}) });
          const session = new ProgrammingSession(transport, { selectedModel: payload.selectedModel });
          state.session = session; state.sessionId = crypto.randomUUID();
          session.onEvent(event => { if (state.session === session) receiveLiveEvent(event); });
          try {
            const identity = await session.connect({ signal }); state.connectionState = 'connected';
            log(`已收到固件 ${identity.firmware}，参数版本 ${identity.paramsVersion}。HELLO 已同步 RTC。${identity.writeEnabled ? '可以读取并建立配置基线。' : '当前身份或保护状态不允许写入。'}`, identity.writeEnabled ? 'success' : 'warning');
            if (!identity.modelReportedByDevice) log('协议未返回独立机型字符串；当前配置基于你明确选择的 UV-K10 Pro，并核对固件版本。');
          } catch (error) { await session.close().catch(() => {}); state.connectionState = 'error'; throw error; }
        });
      case 'authenticate':
        return await runBusy('验证设备密码', async signal => {
          const session = needSession();
          try {
            const identity = await session.authenticate({ password: payload.password, signal });
            payload.password = '';
            if (!identity.authenticated && identity.passwordValid !== 0) throw new Error('认证未完成。');
            state.connectionError = ''; log('设备已接受当前密码，本次会话可以读取配置。', 'success');
          } catch (error) {
            payload.password = '';
            if (!session.connected) state.connectionState = 'error';
            throw new Error(error.code === 'INVALID_PASSWORD' ? '密码格式无效：去除两端空格后最多 32 个 UTF-8 字节。' : '设备密码认证未成功；未自动重试。请确认密码并在需要时重新连接。');
          }
        });
      case 'edit-startup-password':
      case 'edit-programming-password':
        needSession();
        if (!connectionModel().writable) throw new Error('请先完成正常认证并读取本次设备配置。');
        ui.openCredentials({ kind: type === 'edit-startup-password' ? 'startup' : 'programming', passwordRequired: state.session.identity.passwordValid === 1 }); return;
      case 'change-credentials':
        return await runBusy('提交设备密码变更', async signal => {
          const session = needSession(), ws = needWorkspace();
          if (!connectionModel().writable) throw new Error('请先完成认证并读取本次设备配置。');
          try {
            let result;
            if (payload.kind === 'startup') {
              if (!payload.disable && payload.newPassword !== payload.confirmPassword) throw new Error('两次密码不一致。');
              ws.require(0x17000, 4);
              const expectedCurrent = new DataView(ws.baseline.buffer, ws.baseline.byteOffset, ws.baseline.byteLength).getUint32(0x17000, true);
              result = await session.changeStartupPassword({ password: payload.newPassword, disable: payload.disable === true, expectedCurrent, signal });
            } else if (payload.kind === 'programming') {
              if (!payload.disable && normalizePassword(payload.newPassword).length === 0) throw new Error('清除密码需要明确勾选清除选项。');
              result = await session.changeProgrammingPassword({ currentPassword: payload.currentPassword,
                newPassword: payload.newPassword, confirmPassword: payload.confirmPassword, signal });
            }
            else throw new Error('无效的密码类型。');
            state.session = null; state.sessionId = null; state.connectionState = 'disconnected'; state.plan = null;
            log(`${payload.kind === 'startup' ? '开机' : '编程'}密码${result.disabled ? '清除' : '修改'}已验证。连接已关闭，请重新连接并读取配置。`, 'success');
          } catch (error) {
            if (!session.connected) { state.sessionId = null; state.connectionState = 'error'; state.plan = null; }
            throw new Error(error.mayHaveModifiedDevice ? '密码变更结果未能完全确认；连接已停止，请重新连接并核对设备密码状态。' : '密码修改未完成，请核对当前密码、新密码格式和设备锁定状态。');
          } finally { payload.currentPassword = ''; payload.newPassword = ''; payload.confirmPassword = ''; }
        });
      case 'disconnect':
        await state.session?.close(); state.session = null; state.sessionId = null; state.connectionState = 'disconnected'; state.plan = null;
        log('已断开连接；本地工作区仍可编辑与导出。'); render(); return;
      case 'read': {
        const session = needSession();
        if (!await replaceAllowed()) return false;
        return await runBusy('读取设备配置', async signal => {
          const data = new Uint8Array(PROFILE.capacity).fill(255); const coverage = []; let completed = 0;
          for (const region of READ_REGIONS) {
            const block = await session.readMemory(region.address, region.length, { signal,
              onProgress: p => progress(completed + p.completed, CONFIG_BYTES, `读取 ${region.label}`) });
            data.set(block, region.address); coverage.push({ address: region.address, length: region.length }); completed += region.length;
          }
          state.workspace = new MemoryWorkspace({ name: `UV-K10 Pro ${session.identity.firmware} 配置`, mode: 'device', data, coverage,
            sessionId: state.sessionId, provenance: { firmware: session.identity.firmware, params_version: session.identity.paramsVersion,
              selected_model: PROFILE.model, transport: state.transport, read_at: new Date().toISOString(), checksum: session.identity.checksumStatus } });
          state.plan = null; log(`读取完成：${CONFIG_BYTES.toLocaleString()} 字节，覆盖 ${coverage.length} 个明确配置区。未宣称完整 4 MiB 转储。`, 'success');
        });
      }
      case 'preview-write': {
        const ws = needWorkspace(); const changes = ws.differences(); let reason = connectionModel().reason, plan;
        try { plan = ws.planWrites(); } catch (error) { reason = error.message; }
        state.plan = plan ?? null;
        const canWrite = Boolean(plan?.bytes && connectionModel().writable);
        ui.openWritePreview({ summary: `${changes.length} 处差异，共 ${ws.dirtyBytes()} 字节。写前保存恢复快照并核对设备基线，每次写入必须回读一致。`,
          canWrite, reason: canWrite ? '确认后只写入当前差异；需要立即生效时可在完成后显式重启。' : reason }); return;
      }
      case 'write': {
        const ws = needWorkspace(), session = needSession(), plan = state.plan;
        if (!plan || !plan.bytes || !connectionModel().writable) throw new Error('没有可执行的、已审阅的本次会话写入计划。');
        return await runBusy('写入并回读验证', async signal => {
          // Serialize and commit the complete baseline + edits before touching hardware.
          state.recoveryProject = await exportProject(ws); await saveRecovery(state.recoveryProject);
          const result = await executeWritePlan(ws, session, state.sessionId, plan, { signal,
            onProgress: p => progress(p.completed, p.total, p.phase === 'preflight' ? '写前核对设备数据' : '写入并回读核对'),
            onBackup: async backup => { if (backup.kind === 'configuration-before-write') log('本地恢复快照已保存，全部待写地址通过基线核对。'); } });
          state.plan = null; log(`已通过逐块回读：${result.writtenBytes} 字节，${result.blocks} 个差异块。尚未发送重启命令。`, 'success');
          ui.closeDialog();
        });
      }
      case 'reboot':
        if (!await ui.confirm({ title: '重启设备以重新加载配置？', message: '将发送官方 PC 使用的重启命令并关闭连接。命令没有应答，不能以发送成功代替实机重启确认。', confirmLabel: '发送重启命令' })) return false;
        await needSession().reboot(); state.session = null; state.sessionId = null; state.connectionState = 'disconnected';
        log('已发送重启命令并关闭会话；请观察设备是否重新启动。', 'info'); render(); return;
      case 'restore-recovery': {
        const recovery = await latestRecovery(); if (!recovery) throw new Error('本浏览器尚未保存写前恢复快照。');
        if (!await replaceAllowed()) return false;
        state.workspace = await importProject(recovery.project, `写前恢复快照 ${recovery.time}`); state.plan = null;
        log('已载入写前快照，包含原始基线和待写修改。作为离线项目打开，不自动回滚设备。', 'warning'); render(); return;
      }
      case 'import': {
        const file = payload.file; if (!(file instanceof File) || file.size > MAX_FILE_BYTES) throw new Error('文件无效或超过 24 MiB。');
        const content = new Uint8Array(await file.arrayBuffer());
        if (/\.csv$/i.test(file.name)) {
          const ws = needWorkspace(), text = decodeCsvFile(content);
          const radio = text.replace(/^\ufeff/, '').startsWith('profile,chip,band,record,');
          const result = radio ? importRadioCsv(ws, text) : importChannelsCsv(ws, text);
          ws.apply(result.data); state.plan = null; log(`已导入 ${result.count} 条${radio ? '广播' : '信道'}记录，仅修改本地工作区。`, 'success');
          result.warnings.slice(0, 20).forEach(w => log(w, 'warning'));
          if (result.warnings.length > 20) log(`另有 ${result.warnings.length - 20} 个空槽仍需明确设置属性后启用。`, 'warning');
          render(); return;
        }
        let imported;
        if (/\.dat$/i.test(file.name)) {
          if (!await ui.confirm({ title: '确认官方 DAT 文件来源', message: '此格式没有唯一机型标记。请确认文件由 UV-K10 Pro 的 CPS 0.56 保存；其他机型即使文件长度相同也不能混用。', confirmLabel: '确认为 UV-K10 Pro 文件' })) return false;
          imported = await importCpsDat(content, file.name, { modelConfirmed: true });
          log('已解析官方 DAT 配置；文件填充区单独保留，不作为已读取的 NOR 数据。');
        } else imported = /\.(?:k10|json)$/i.test(file.name) ? await importProject(new TextDecoder('utf-8', { fatal: true }).decode(content), file.name) : importNor(content, file.name);
        if (state.workspace?.mode === 'device' && state.workspace.sessionId === state.sessionId && state.session?.connected) {
          if (!await ui.confirm({ title: '把备份配置合并到本次设备工作区？', message: '只复制双方已覆盖且格式已允许写入的配置区；保留本次设备原始基线。写入前仍需核对差异。', confirmLabel: '合并并预览' })) return false;
          const result = overlayConfiguration(state.workspace, imported); state.workspace.apply(result.data);
          log(`已合并 ${result.ranges.length} 个配置区；设备尚未写入。`, 'info');
        } else {
          if (!await replaceAllowed()) return false;
          state.workspace = imported; log(`已导入 ${file.name}，以离线模式打开。`, 'success');
        }
        state.plan = null; render(); return;
      }
      case 'export': {
        if (payload.format === 'log') { download(filename('log.txt'), state.logs.map(x => `${x.time} [${x.level}] ${x.message}`).join('\n'), 'text/plain'); return; }
        const ws = needWorkspace();
        if (payload.format === 'project') download(filename('k10'), await exportProject(ws), 'application/json');
        else if (payload.format === 'cps-dat') {
          const report = inspectCpsDatExport(ws);
          const content = await exportCpsDat(ws);
          report.warnings.forEach(warning => log(warning, 'warning'));
          download(filename('dat'), content);
        }
        else if (payload.format === 'nor') download(filename('bin'), exportNor(ws));
        else if (payload.format === 'csv') download(filename('channels.csv'), exportChannelsCsv(ws), 'text/csv;charset=utf-8');
        else if (payload.format === 'cps-csv') download(filename('cps-22.csv'), exportCpsCsv(ws), 'text/csv;charset=utf-8');
        else if (payload.format === 'radio-csv') download(filename(`${payload.chip ?? 'si4732'}.csv`), exportRadioCsv(ws, payload.chip ?? 'si4732'), 'text/csv;charset=utf-8');
        else throw new Error('不支持的导出格式。');
        log('已生成本地下载；工作区编辑仍保留。'); return;
      }
      case 'edit-channel': return openChannel(payload.index ?? payload.record.index);
      case 'add-channel': {
        const ws = needWorkspace();
        for (let index = 0; index < 999; index++) if (ws.has(index * 64, 64) && ws.has(0x11000 + index, 1) && ws.data[0x11000 + index] === 255) return openChannel(index, { isNew: true });
        throw new Error('已读取范围中没有可用空槽。');
      }
      case 'delete-channels': {
        const ws = needWorkspace();
        if (!payload.indexes.length || !await ui.confirm({ title: '清空所选信道？', message: `将 ${payload.indexes.length} 个槽位标记为空；原始 64 字节记录会保留。仅修改本地工作区。`, confirmLabel: '清空信道', danger: true })) return false;
        let next = ws.data;
        for (const index of payload.indexes) { ws.require(index * 64, 64); ws.require(0x11000 + index, 1); next = deleteChannel(next, index); }
        ws.apply(next); state.plan = null; render(); return;
      }
      case 'edit-radio': return openRadio(payload.chip, payload.record);
      case 'add-radio': {
        const ws = needWorkspace(), chip = payload.chip;
        const selectedBand = payload.band ? String(payload.band).toLowerCase() : undefined;
        if (selectedBand && !RADIO_CHIPS[chip].bands.includes(selectedBand)) throw new Error('此芯片不支持所选波段。');
        for (const band of RADIO_CHIPS[chip].bands.filter(band => !selectedBand || band === selectedBand)) {
          const b = RADIO_BANKS[band]; if (!ws.has(b.offset, b.length)) continue;
          const station = decodeRadioBank(ws.data, chip, band).presets.find(s => s.empty);
          if (station) return openRadio(chip, { band, index: station.index });
        }
        throw new Error('当前芯片配置中没有已读取的空广播槽位。');
      }
      case 'edit-scan': return openScan(payload.index ?? payload.record.index);
      case 'edit-record': {
        const ws = needWorkspace(), { kind, record } = payload;
        if (kind === 'vfo') return openChannel(record.index, { vfo: true });
        if (kind === 'contact') {
          const c = readContact(ws.data, record.contactKind, record.index); ws.require(c.offset, 24);
          return showEditor(kind, record, [field('name', '联系人名称（最多 16 字节）', c.name), field('code', '信令编码（最多 8 字节）', c.code,
            { maxLength: 8, help: '联系人编号只接受数字 0–9；上线/下线码是不同字段。' })]);
        }
        if (kind === 'message') {
          const m = readMessage(ws.data, record.index); ws.require(m.offset, 256);
          return showEditor(kind, record, [field('text', '消息文本（CPS 兼容：最多 48 个 ASCII 字节）', m.text, { type: 'textarea', maxLength: 48,
              help: '已有 UTF-8 文本可读取和保留。官方 PC 写入使用 ASCII；不能编码的修改会明确拒绝。' }),
            { key: 'active', label: '启用此消息槽', type: 'checkbox', value: m.valid !== false,
              help: '官方 PC 在首个失效索引处停止读取；后面的非连续消息不会自动压缩或移动。' },
            field('auto_index_raw', '内部索引（只读）', m.auto_index_raw, { readonly: true })]);
        }
        throw new Error('未知记录类型。');
      }
      case 'save-editor': return applyEditor(payload);
      case 'edit-bitmap': {
        const ws = needWorkspace(); ws.require(0x45000, 1032); const revision = ws.revision;
        openBitmapEditor({ pageBytes: readStartupBitmap(ws.data).page_bytes, onSave: pageBytes => {
          if (ws !== state.workspace || ws.revision !== revision) throw new Error('工作区已变化，请重新打开图像编辑器。');
          ws.apply(patchStartupBitmap(ws.data, pageBytes)); state.plan = null; render(); log('已应用开机图像的本地修改，尚未写入设备。');
        } }); return;
      }
      case 'save-settings': {
        const ws = needWorkspace(); let next;
        if (payload.groupId === 'band-definition' || payload.groupId.startsWith('band-group:')) {
          for (const range of BAND_PLAN_COVERAGE) ws.require(range.address, range.length);
          const groupIndex = payload.groupId === 'band-definition' ? null : num(payload.groupId.split(':')[1], 0, 7, '频段组');
          const definition = groupIndex === null ? readVfoBandDefinition(ws.data) : readBandGroups(ws.data).groups[groupIndex];
          const original = Object.fromEntries(bandEditorFields(definition.bands).map(f => [f.key, f.value]));
          if (groupIndex !== null) Object.assign(original, { name: definition.name, enabled: definition.enabled });
          else { const plan = resolveActiveBands(ws.data); Object.assign(original, { custom_enabled: plan.mode_raw, selected_group: plan.requested_group }); }
          const changes = changedValues(payload.values, original);
          next = ws.data;
          for (let index = 0; index < 7; index++) {
            const patch = {};
            for (const direction of ['rx', 'tx']) {
              const prefix = `band_${index}_${direction}_`;
              if (`${prefix}enabled` in changes) patch[`${direction}_enabled`] = typeof changes[`${prefix}enabled`] === 'boolean' ? changes[`${prefix}enabled`] : num(changes[`${prefix}enabled`], 0, 1, '频段开关');
              for (const end of ['start', 'end']) if (`${prefix}${end}` in changes) patch[`${direction}_${end}_hz`] = parseMHz(changes[`${prefix}${end}`]);
            }
            if (Object.keys(patch).length) next = groupIndex === null ? patchVfoBandInImage(next, index, patch) : patchGroupBandInImage(next, groupIndex, index, patch);
          }
          if (groupIndex !== null) {
            const metadata = Object.fromEntries(['name', 'enabled'].filter(key => key in changes).map(key => [key, changes[key]]));
            next = patchBandGroupInImage(next, groupIndex, metadata);
          } else next = patchBandSelection(next, Object.fromEntries(['custom_enabled', 'selected_group'].filter(key => key in changes)
            .map(key => [key, num(changes[key], 0, key === 'custom_enabled' ? 1 : 8, key)])));
        } else if (payload.groupId === 'startup-bitmap') {
          ws.require(0x45000, 1032);
          const pageBytes = unhex(String(payload.values.page_bytes_hex).replace(/\s+/g, ''));
          next = patchStartupBitmap(ws.data, pageBytes);
        } else if (payload.groupId.startsWith('radio-header:')) {
          const [, chip, band] = payload.groupId.split(':'); const b = RADIO_BANKS[band]; ws.require(b.offset, b.length);
          const original = decodeRadioBank(ws.data, chip, band).header;
          const changes = changedValues(payload.values, original);
          next = patchRadioHeader(ws.data, chip, band, Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, num(value, 0, 255, key)])));
        } else {
          const definitions = SETTINGS_FIELDS.filter(f => f.group === payload.groupId), original = {}, changes = {};
          for (const f of definitions) if (ws.has(f.offset, f.length)) original[f.id] = readSetting(ws.data, f.id);
          for (const [key, value] of Object.entries(changedValues(payload.values, original))) {
            const f = definitions.find(f => f.id === key); ws.require(f.offset, f.length);
            changes[key] = f.type === 'text' || f.type === 'coordinate' ? value : typeof value === 'boolean' ? value : num(value, f.min ?? 0, f.max ?? 0xffffffff, f.label);
          }
          next = patchSettings(ws.data, changes);
        }
        ws.apply(next); state.plan = null; log(`已应用 ${payload.groupId} 的本地设置修改。`); render(); return;
      }
      case 'discard-changes':
        if (!await ui.confirm({ title: '撤销尚未写入的修改？', message: '工作区恢复到原始读取或导入基线；已经验证写入的设备数据不会被回滚。', confirmLabel: '撤销本地修改', danger: true })) return false;
        needWorkspace().discard(); state.plan = null; render(); return;
      default: throw new Error(`未实现的操作：${type}`);
    }
  } catch (error) {
    if (['connect', 'read', 'write', 'send-aprs', 'sync-location'].includes(type)) {
      state.connectionError = error.message;
      if (state.session && !state.session.connected) state.connectionState = 'error';
      render();
    }
    log(error.message, 'error'); throw error;
  }
}

window.addEventListener('beforeunload', event => {
  if (state.busy || state.workspace?.dirtyBytes()) { event.preventDefault(); event.returnValue = ''; }
});
log('工作台已就绪。默认未连接、无设备数据；所有导入与编辑均在本浏览器执行。');
if (!globalThis.isSecureContext) log('当前不是安全上下文：离线编辑可用，设备 API 需要 HTTPS 或本机 localhost。', 'warning');
render();
