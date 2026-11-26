// SPDX-License-Identifier: MIT
import { PROFILE, READ_REGIONS, WRITE_RANGES } from './profile.mjs';
import { MemoryWorkspace, covers, equalBytes } from './workspace.mjs';
import { hex, unhex, integer, formatMHz, parseMHz, visibleText } from './encoding.mjs';
import { readChannel, patchChannel, CHANNEL_COUNT } from './channel-codec.mjs';
import { RADIO_CHIPS, RADIO_BANKS, decodeRadioBank, patchRadioStation } from './radio-codec.mjs';
import { BAND_PLAN_COVERAGE, deriveChannelAttribute } from './band-codec.mjs';
import { restoreCpsDatEnvelope } from './cps-project.mjs';

export const MAX_FILE_BYTES = 24 * 1024 * 1024;
export const PROJECT_FORMAT = 'uv-k10pro-web-project';
const magicCSV = 'UV-K10-PRO-K8/v1';
const toBase64 = data => {
  let result = '';
  for (let i = 0; i < data.length; i += 32768) result += String.fromCharCode(...data.subarray(i, i + 32768));
  return btoa(result);
};
function fromBase64(value, expected) {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(expected / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error('项目包含无效或超长的 Base64 数据。');
  const decoded = atob(value);
  if (decoded.length !== expected) throw new Error('项目记录长度与数据不一致。');
  return Uint8Array.from(decoded, ch => ch.charCodeAt(0));
}
export async function sha256(data) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))); }

export async function exportProject(workspace) {
  const segments = [];
  for (const range of workspace.coverage) {
    const original = workspace.baseline.slice(range.address, range.address + range.length);
    const edited = workspace.data.slice(range.address, range.address + range.length);
    segments.push({ ...range, baseline: toBase64(original), data: toBase64(edited),
      baseline_sha256: await sha256(original), sha256: await sha256(edited) });
  }
  return JSON.stringify({ format: PROJECT_FORMAT, version: 1, profile: PROFILE.id,
    capacity: PROFILE.capacity, name: workspace.name, created_at: new Date().toISOString(),
    source: workspace.mode, provenance: workspace.provenance,
    coverage_complete: workspace.complete, segments, journal: workspace.journal }, null, 2);
}

export async function importProject(text, name = '导入项目') {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw new Error('项目文件过大。');
  const input = JSON.parse(text);
  if (input?.format !== PROJECT_FORMAT || input.version !== 1 || input.profile !== PROFILE.id || input.capacity !== PROFILE.capacity)
    throw new Error('只接受 UV-K10 Pro / K8 的 v1 项目；其他机型或格式不能混用。');
  if (!Array.isArray(input.segments) || !input.segments.length || input.segments.length > 4096) throw new Error('项目缺少有效分段。');
  const data = new Uint8Array(PROFILE.capacity).fill(255), baseline = data.slice();
  const coverage = [];
  let previousEnd = 0;
  for (const segment of input.segments) {
    integer(segment.address, previousEnd, PROFILE.capacity - 1, 'segment address');
    integer(segment.length, 1, PROFILE.capacity - segment.address, 'segment length');
    const original = fromBase64(segment.baseline, segment.length), edited = fromBase64(segment.data, segment.length);
    if (segment.baseline_sha256 !== await sha256(original) || segment.sha256 !== await sha256(edited))
      throw new Error('项目 SHA-256 校验失败；文件可能损坏。');
    baseline.set(original, segment.address); data.set(edited, segment.address);
    coverage.push({ address: segment.address, length: segment.length });
    previousEnd = segment.address + segment.length;
  }
  // A source label is descriptive only. Never trust imported device/session IDs.
  return new MemoryWorkspace({ name, mode: 'offline', data, baseline, coverage,
    provenance: { imported_format: PROJECT_FORMAT, claimed_source: String(input.source ?? '').slice(0, 40),
      ...await restoreCpsDatEnvelope(input.provenance) }, importedDirty: true });
}

export function importNor(data, name = 'NOR 转储') {
  if (!(data instanceof Uint8Array)) throw new TypeError('Expected raw bytes');
  if (data.length >= 8) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sp = view.getUint32(0, true), reset = view.getUint32(4, true);
    if (sp >= 0x20000000 && sp <= 0x20010000 && reset >= 0x08000001 && reset < 0x08100000 && (reset & 1))
      throw new Error('这是 MCU 应用固件，不能作为信道/NOR 备份导入。');
  }
  if (![0x200000, 0x400000].includes(data.length))
    throw new Error('裸 NOR 文件必须为 2 MiB（部分覆盖）或 4 MiB；固件更新包和 CPS 专有项目不能按 NOR 猜测。');
  const full = new Uint8Array(PROFILE.capacity).fill(255); full.set(data);
  return new MemoryWorkspace({ name, mode: 'offline', data: full, coverage: [{ address: 0, length: data.length }],
    provenance: { imported_format: 'raw-nor', model_assertion: 'user-selected K8; not device authentication' } });
}
export function exportNor(workspace) {
  if (!workspace.complete) throw new Error('当前仅覆盖已读取的配置区，不能导出伪造的 4 MiB 全片备份。请导出 .k10 项目。');
  return workspace.data.slice();
}

export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) throw new Error('CSV 过大或格式无效。');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], cell = '', quoted = false, endedQuote = false;
  function finishCell() { row.push(cell); cell = ''; endedQuote = false; }
  function finishRow() { finishCell(); if (row.some(x => x.length)) rows.push(row); row = []; }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; endedQuote = true; }
      else cell += ch;
    } else if (ch === '"') {
      if (cell || endedQuote) throw new Error('CSV 引号位置无效。');
      quoted = true;
    } else if (ch === ',') finishCell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; finishRow(); }
    else { if (endedQuote) throw new Error('CSV 引号后存在多余字符。'); cell += ch; }
    if (rows.length > 1100 || row.length > 64 || cell.length > 8192) throw new Error('CSV 超出支持的表格范围。');
  }
  if (quoted) throw new Error('CSV 引号未闭合。');
  if (cell || row.length || endedQuote) finishRow();
  if (!rows.length) throw new Error('CSV 为空。');
  const width = rows[0].length;
  rows.forEach((r, i) => { if (r.length !== width) throw new Error(`CSV 第 ${i + 1} 行有 ${r.length} 列，应为 ${width} 列。`); });
  return rows;
}
export function stringifyCsv(rows) {
  const quote = cell => { const value = String(cell ?? ''); return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; };
  return '\ufeff' + rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}
export function decodeCsvFile(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}

const LOSSLESS_HEADERS = ['profile', 'number', 'attribute_hex', 'record_hex', 'name', 'rx_mhz', 'tx_mhz_before_reverse'];
export function exportChannelsCsv(workspace) {
  const rows = [LOSSLESS_HEADERS];
  for (let index = 0; index < CHANNEL_COUNT; index++) {
    if (!workspace.has(index * 64, 64) || !workspace.has(0x11000 + index, 1)) continue;
    const channel = readChannel(workspace.data, index);
    rows.push([magicCSV, index + 1, channel.attribute.toString(16).padStart(2, '0'), channel.raw_hex,
      channel.name, formatMHz(channel.rx_frequency_hz), formatMHz(channel.derived_tx_frequency_hz_before_reverse)]);
  }
  return stringifyCsv(rows);
}
export function importChannelsCsv(workspace, text) {
  const rows = parseCsv(text), header = rows.shift();
  if (header.join(',') !== LOSSLESS_HEADERS.join(',')) return importCpsCsv(workspace, text);
  const next = workspace.data.slice(), seen = new Set();
  for (const row of rows) {
    if (row[0] !== magicCSV) throw new Error('CSV 的机型标识不是 UV-K10 Pro / K8。');
    const index = strictInt(row[1], 1, 999, '信道号') - 1;
    if (seen.has(index)) throw new Error(`重复信道号 ${index + 1}`); seen.add(index);
    workspace.require(index * 64, 64); workspace.require(0x11000 + index, 1);
    const record = unhex(row[3]), attribute = unhex(row[2]);
    if (record.length !== 64 || attribute.length !== 1) throw new Error('CSV 原始记录必须为 64 B + 1 B 属性。');
    // The raw columns are canonical. Human-readable columns are a view and may
    // be edited only in the workbench, preventing ambiguous dual definitions.
    const check = readChannel(record, 0);
    if (row[4] !== check.name || row[5] !== formatMHz(check.rx_frequency_hz) || row[6] !== formatMHz(check.derived_tx_frequency_hz_before_reverse))
      throw new Error(`信道 ${index + 1} 的展示列与原始字节不一致。请在工作台编辑，或使用官方 22 列 CSV。`);
    next.set(record, index * 64); next[0x11000 + index] = attribute[0];
  }
  return { data: next, count: rows.length, warnings: [] };
}

export const CPS_HEADERS = ['No.', 'Name', 'RX Freq[MHZ]', 'TX Freq[MHZ]', 'QT Encode Type', 'QT Encode',
  'QT Decode Type', 'QT Decode', 'Band', 'Power', 'Busy Lock', 'ScanList', 'Demode', 'Freq Reverse',
  'SQ', 'Encrypt', 'Signaling Decode', 'PTTID', 'Signal', 'BeaconSrc', 'APRS PTT', 'APRS TX Channel'];
export const CPS_HEADERS_ZH = ['序号', '名称', '接收频率[MHZ]', '发射频率[MHZ]', '亚音编码类型', '亚音编码',
  '亚音解码类型', '亚音解码', '带宽', '功率', '繁忙禁发', '扫描列表', 'Demode', '倒频',
  '静噪', '加密', '信令解码', 'PTTID', '信令系统', '信标源', 'APRS PTT控制', 'APRS发射信道'];
const toneNames = ['Null', 'Ctcss', 'NDCS', 'IDCS'];
const toneValue = tone => tone.kind === 0 ? '' : tone.kind === 1 ? `${Math.floor(tone.value / 10)}.${tone.value % 10}` : tone.value.toString(8).padStart(3, '0');
const boolNames = ['OFF', 'ON'];
const powerNames = ['LowPower', 'HighPower', 'UltraHighPower'];
const pttNames = ['OFF', 'Start', 'End', 'Start&End'];
const aprsPttNames = ['Null', 'Start', 'End'];
function enumText(values, value, label) {
  if (values[value] === undefined) throw new Error(`${label} 原始枚举 ${value} 不能无损转换为当前官方 CSV。`);
  return values[value];
}
export function exportCpsCsv(workspace) {
  workspace.require(0, 999 * 64); workspace.require(0x11000, 999);
  const rows = [CPS_HEADERS];
  for (let index = 0; index < 999; index++) {
    const c = readChannel(workspace.data, index);
    if (c.deleted) { rows.push([index + 1, ...Array(21).fill('')]); continue; }
    if (c.attribute >= 7) throw new Error(`信道 ${index + 1} 的原始属性含 CPS 不读取的值，拒绝丢失属性。请用无损 CSV 或 .k10。`);
    if (c.modulation === 2 || c.modulation === 3) throw new Error(`信道 ${index + 1} 是固件 SSB/CW；当前 CPS 与参考固件的枚举不一致，拒绝生成会错写模式的官方 CSV。请用无损 CSV 或 .k10。`);
    if (c.rx_tone.kind > 3 || c.tx_tone.kind > 3) throw new Error(`信道 ${index + 1} 的 U23/U24 亚音不在 CPS 22 列枚举中。`);
    if (!c.rx_tone.valid || !c.tx_tone.valid) throw new Error(`信道 ${index + 1} 包含无效亚音原始值，拒绝转换为官方 CSV。`);
    rows.push([index + 1, c.name, formatMHz(c.rx_frequency_hz), formatMHz(c.derived_tx_frequency_hz_before_reverse),
      enumText(toneNames, c.tx_tone.kind, 'TX tone'), toneValue(c.tx_tone), enumText(toneNames, c.rx_tone.kind, 'RX tone'), toneValue(c.rx_tone),
      enumText(['25K', '12.5K'], c.bandwidth, '带宽'), enumText(powerNames, c.power, '功率'), enumText(boolNames, c.busy_lockout, '繁忙禁发'),
      enumText({ ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [i, String(i + 1)])), 32: 'Scan all CH', 255: 'Null' }, c.scan_list, '扫描列表'), enumText({ 0: 'FM', 1: 'AM', 3: 'CW' }, c.modulation, '调制'),
      enumText(boolNames, c.reverse, '倒频'), c.squelch, c.scrambler === 0 ? 'OFF' : c.scrambler,
      enumText(boolNames, c.signaling_decode, '信令解码'), enumText(pttNames, c.ptt_id, 'PTTID'),
      enumText(['DTMF', '5TONE'], c.signaling_system, '信令'), enumText(boolNames, c.aprs_receive, 'BeaconSrc'),
      enumText(aprsPttNames, c.aprs_ptt, 'APRS PTT'), enumText(['Current Channel', '1', '2', '3', '4', '5', '6', '7', '8'], c.aprs_tx_channel, 'APRS 发射信道')]);
  }
  return stringifyCsv(rows);
}

function strictInt(value, min, max, label) {
  if (!/^(0|[1-9]\d*)$/.test(String(value))) throw new Error(`${label} 应为整数。`);
  return integer(Number(value), min, max, label);
}
function oneOf(value, variants, label) {
  const normalized = String(value).trim().toLowerCase().replaceAll(' ', '');
  for (let i = 0; i < variants.length; i++) if (variants[i].some(x => String(x).toLowerCase().replaceAll(' ', '') === normalized)) return i;
  throw new Error(`${label} 值 ${JSON.stringify(value)} 不在已验证枚举中。`);
}
function readBool(value, label) { return oneOf(value, [['OFF', '关闭', '關閉', '关', '0'], ['ON', '打开', '打開', '开启', '开', '1']], label); }
function parseTone(kind, value) {
  const type = oneOf(kind, [['Null', 'OFF', '无', '無', '关闭'], ['Ctcss', 'CTCSS', '模拟亚音', '模擬亞音'], ['NDCS', 'DCS-N', '数字亚音', '數位亞音'], ['IDCS', 'DCS-I', '反向数字亚音', '反向數位亞音']], '亚音类型');
  if (type === 0) return { kind: 0, value: 0 };
  if (type === 1) {
    if (!/^\d{2,3}(?:\.\d)?$/.test(value)) throw new Error('CTCSS 必须为一位小数的 Hz 值。');
    const [whole, part = '0'] = value.split('.');
    return { kind: 1, value: Number(whole) * 10 + Number(part) };
  }
  if (!/^[0-7]{1,3}$/.test(value)) throw new Error('DCS 必须是最多三位的八进制码。');
  return { kind: type, value: Number.parseInt(value, 8) };
}
export function importCpsCsv(workspace, text) {
  const rows = parseCsv(text), headers = rows.shift();
  if (headers.length === 20) throw new Error('这是带 MSW 的旧版 20 列文件；当前 CPS 使用 22 列，拒绝错位导入。');
  if (headers.length !== 22 || !['No.', '序号'].includes(headers[0]) || !['Name', '名称'].includes(headers[1]))
    throw new Error('无法识别此 CSV；支持本项目无损 CSV 和当前 CPS 的 22 列文件。');
  headers.forEach((header, index) => {
    if (header !== CPS_HEADERS[index] && header !== CPS_HEADERS_ZH[index])
      throw new Error(`官方 CSV 第 ${index + 1} 列应为 ${CPS_HEADERS[index]} / ${CPS_HEADERS_ZH[index]}，不能重排后按原位置写入。`);
  });
  if (rows.length !== 999) throw new Error('官方 CPS 按行位置而非 No. 列导入，必须提供顺序完整的 999 行，避免错写信道。');
  workspace.require(0, 999 * 64); workspace.require(0x11000, 999);
  let next = workspace.data.slice(); const warnings = []; let count = 0;
  rows.forEach((r, index) => {
    if (strictInt(r[0], 1, 999, 'No.') !== index + 1) throw new Error(`第 ${index + 1} 行 No. 与行位置不一致。`);
    if (r.slice(1).every(x => !x.trim())) { next[0x11000 + index] = 255; return; }
    const rx = parseMHz(r[2].trim()), tx = parseMHz(r[3].trim());
    if (rx < 25000000 || rx > 580000000 || tx < 25000000 || tx > 580000000)
      throw new Error(`信道 ${index + 1} 超出已重放的固件频率边界 25–580 MHz。`);
    const modulation = oneOf(r[12], [['FM'], ['AM'], ['CW']], 'CPS 调制');
    const scanText = r[11].trim();
    const scan = /^(Null|无|無)$/i.test(scanText) ? 255 : /^(Scan all CH|扫描所有信道|掃描所有信道)$/i.test(scanText) ? 32
      : strictInt(scanText, 1, 32, '扫描列表') - 1;
    const scrambler = /^(OFF|关闭|0)$/i.test(r[15]) ? 0 : strictInt(r[15], 1, 10, '扰频');
    const aprsTx = /^(CurrentChannel|Current|当前信道|当前|0)$/i.test(r[21].replaceAll(' ', '')) ? 0
      : strictInt(r[21].replace(/^(Channel|信道)\s*/i, ''), 1, 8, 'APRS 发射信道');
    const edited = patchChannel(next.subarray(index * 64, index * 64 + 64), { name: r[1], rx_frequency_hz: rx, offset_hz: Math.abs(tx - rx), offset_direction: tx === rx ? 0 : tx > rx ? 1 : 2,
      tx_tone: parseTone(r[4], r[5]), rx_tone: parseTone(r[6], r[7]),
      bandwidth: oneOf(r[8], [['25K', '宽'], ['12.5K', '窄']], '带宽'),
      power: oneOf(r[9], [['LowPower', '低功率', '低'], ['HighPower', '高功率', '高'], ['UltraHighPower', '超高功率', '超高']], '功率'),
      busy_lockout: readBool(r[10], '繁忙禁发'), scan_list: scan, modulation: modulation === 2 ? 3 : modulation,
      reverse: readBool(r[13], '倒频'), squelch: strictInt(r[14], 0, 9, '静噪'), scrambler,
      signaling_decode: readBool(r[16], '信令解码'), ptt_id: oneOf(r[17], [['OFF', '关闭'], ['Start', '开始'], ['End', '结束'], ['Start&End', '开始和结束']], 'PTTID'),
      signaling_system: oneOf(r[18], [['DTMF'], ['5TONE']], '信令'), aprs_receive: readBool(r[19], 'BeaconSrc'),
      aprs_ptt: oneOf(r[20], [['Null', '无', '無'], ['Start', '开始', '開始'], ['End', '结束', '結束']], 'APRS PTT'), aprs_tx_channel: aprsTx });
    next.set(edited, index * 64);
    if (modulation === 2) warnings.push(`信道 ${index + 1} 的 CPS CW 已明确转换为参考固件的原始值 3；官方 CPS 自身写值 2，请勿直接往返混用。`);
    if (BAND_PLAN_COVERAGE.every(range => workspace.has(range.address, range.length)))
      next[0x11000 + index] = deriveChannelAttribute(workspace.data, rx, next[0x11000 + index]);
    else if (next[0x11000 + index] === 255) warnings.push(`信道 ${index + 1} 已导入记录，但仍为空槽；缺少频段定义，需明确选择设备频段属性再启用。`);
    count++;
  });
  return { data: next, count, warnings };
}

const RADIO_HEADERS = ['profile', 'chip', 'band', 'record', 'frequency_hz', 'demodulation_raw', 'bfo_raw', 'record_hex'];
export function exportRadioCsv(workspace, chip) {
  if (!Object.hasOwn(RADIO_CHIPS, chip)) throw new Error('Unknown radio chip');
  const rows = [RADIO_HEADERS];
  for (const band of RADIO_CHIPS[chip].bands) {
    const spec = RADIO_BANKS[band]; if (!workspace.has(spec.offset, spec.length)) continue;
    for (const s of decodeRadioBank(workspace.data, chip, band).stations)
      rows.push([magicCSV, chip, band, s.index, s.frequency_hz, s.demodulation, s.bfo_raw, hex(s.raw)]);
  }
  return stringifyCsv(rows);
}
export function importRadioCsv(workspace, text) {
  const rows = parseCsv(text), header = rows.shift();
  if (header.join(',') !== RADIO_HEADERS.join(',')) throw new Error('广播 CSV 表头无效。');
  const next = workspace.data.slice(), seen = new Set();
  let fileChip;
  for (const r of rows) {
    const [profile, chip, band] = r;
    if (profile !== magicCSV || !Object.hasOwn(RADIO_CHIPS, chip) || !RADIO_CHIPS[chip].bands.includes(band)) throw new Error('广播机型或芯片/频段组合无效。');
    fileChip ??= chip; if (chip !== fileChip) throw new Error('一个广播 CSV 必须只属于一种接收芯片。');
    const bank = RADIO_BANKS[band], index = strictInt(r[3], 0, bank.count - 1, '广播记录号');
    if (seen.has(`${band}/${index}`)) throw new Error('广播 CSV 记录重复。'); seen.add(`${band}/${index}`);
    const address = bank.offset + 8 + index * 8; workspace.require(address, 8);
    const raw = unhex(r[7]); if (raw.length !== 8) throw new Error('广播记录须为 8 字节。');
    const view = new DataView(raw.buffer, raw.byteOffset, 8);
    if (String(view.getUint32(0, true) * 10) !== r[4] || String(raw[4]) !== r[5] || String(view.getUint16(6, true)) !== r[6])
      throw new Error('广播 CSV 展示值与原始记录不一致，请在工作台编辑。');
    next.set(raw, address);
  }
  return { data: next, count: rows.length, chip: fileChip, warnings: ['FM 存台在 Si4732 / BK1080 视图中共用同一存储区。'] };
}

/** Deliberately copy only known writable configuration ranges onto a live read.
 * No imported header, claimed model or session token can enable writes. */
export function overlayConfiguration(target, source) {
  const next = target.data.slice(), ranges = [];
  for (const r of WRITE_RANGES) {
    if (source.has(r.address, r.length) && target.has(r.address, r.length)) {
      next.set(source.data.subarray(r.address, r.address + r.length), r.address); ranges.push(r.id);
    }
  }
  if (!ranges.length) throw new Error('导入文件没有与当前设备已读配置重合的可写区。');
  return { data: next, ranges: [...new Set(ranges)] };
}
