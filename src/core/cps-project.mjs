// SPDX-License-Identifier: MIT
// CPS 0.56 saves its 0xD7000-byte CpsData array directly with BinaryWriter.
// This file is an interchange container, not a full NOR dump or device identity.
import { PROFILE } from './profile.mjs';
import { MemoryWorkspace } from './workspace.mjs';
import { hex } from './encoding.mjs';
import { CHANNEL_FIELDS } from './channel-codec.mjs';

export const CPS_DAT_SIZE = 0xd7000;
export const CPS_DAT_VERSION = '0.56';
export const CPS_DAT_REGIONS = Object.freeze([
  ['channels', 0, 999 * 64], ['vfo', 0x10000, 14 * 64],
  ['attributes', 0x11000, 1024], ['broadcast', 0x12000, 0xb10],
  ['general', 0x13000, 296], ['identity', 0x14000, 112],
  ['display', 0x15000, 16], ['scans', 0x16000, 32 * 128],
  ['power_on_password', 0x17000, 4], ['bands', 0x19000, 168],
  ['dtmf', 0x1a000, 16 * 24], ['five_tone', 0x1a800, 16 * 24],
  ['power_flag', 0x1b000, 1], ['band_groups', 0x1c000, 8 * 272],
  ['aprs', 0x1e000, 256], ['messages', 0x2e000, 64 * 256],
  ['boot_image', 0x45000, 1032],
].map(([id, address, length]) => Object.freeze({ id, address, length })));

const envelopeFormat = 'uv-k10pro-cps-dat-original';
const envelopeLength = 4 * Math.ceil(CPS_DAT_SIZE / 3);
const digest = async data => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
function toBase64(data) {
  let value = '';
  for (let i = 0; i < data.length; i += 32768) value += String.fromCharCode(...data.subarray(i, i + 32768));
  return btoa(value);
}
function fromBase64(text) {
  if (typeof text !== 'string' || text.length !== envelopeLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw new Error('原始 CPS DAT 封套长度或 Base64 格式无效。');
  const bytes = Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
  if (bytes.length !== CPS_DAT_SIZE || toBase64(bytes) !== text) throw new Error('原始 CPS DAT 封套不是规范的 880640 字节数据。');
  return bytes;
}
function requireDatBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CPS_DAT_SIZE)
    throw new Error('仅支持 UV-K10 Pro CPS 0.56 的 880640 字节（0xD7000）DAT；不能按扩展名猜测其他版本或机型。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sp = view.getUint32(0, true), reset = view.getUint32(4, true);
  if (sp >= 0x20000000 && sp <= 0x20010000 && reset >= 0x08000001 && reset < 0x08100000 && (reset & 1))
    throw new Error('检测到 MCU 应用向量；固件镜像不能作为 CPS DAT 配置导入。');
}
async function decodeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      envelope.format !== envelopeFormat || envelope.version !== 1 || envelope.bytes !== CPS_DAT_SIZE ||
      typeof envelope.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.sha256))
    throw new Error('原始 CPS DAT 封套元数据无效。');
  const data = fromBase64(envelope.base64);
  requireDatBytes(data);
  if (await digest(data) !== envelope.sha256) throw new Error('原始 CPS DAT SHA-256 校验失败。');
  return data;
}

/** Copy only the bounded, validated opaque file envelope when restoring .k10.
 * Hash validation detects corruption; it never authenticates a model or device.
 * All other imported provenance remains the caller's descriptive-only policy. */
export async function restoreCpsDatEnvelope(provenance) {
  if (!provenance || !Object.hasOwn(provenance, 'cps_dat_original')) return {};
  const supplied = { ...provenance.cps_dat_original };
  await decodeEnvelope(supplied);
  return { cps_dat_original: { format: envelopeFormat, version: 1, bytes: CPS_DAT_SIZE,
    sha256: supplied.sha256, base64: supplied.base64 } };
}

/** Model confirmation is required because the official format has no magic,
 * model field or checksum. The caller should obtain it from an explicit source
 * choice, not infer it from the filename or bytes. */
export async function importCpsDat(bytes, name = '官方 CPS DAT', { modelConfirmed = false } = {}) {
  if (modelConfirmed !== true) throw new Error('请先确认此 DAT 来自 UV-K10 Pro 的官方 CPS 0.56；格式内没有可验证的唯一机型标识。');
  requireDatBytes(bytes);
  // Own the input before awaiting its hash; callers cannot race later mutation.
  const original = bytes.slice();
  const data = new Uint8Array(PROFILE.capacity).fill(255);
  for (const region of CPS_DAT_REGIONS)
    data.set(original.subarray(region.address, region.address + region.length), region.address);
  return new MemoryWorkspace({ name, mode: 'offline', data, coverage: CPS_DAT_REGIONS,
    provenance: { imported_format: 'cps-0.56-dat',
      model_assertion: 'user-confirmed UV-K10 Pro CPS 0.56 file; not device authentication',
      coverage_origin: 'CPS configuration container; not observed NOR or full-flash coverage',
      cps_dat_original: { format: envelopeFormat, version: 1, bytes: CPS_DAT_SIZE,
        sha256: await digest(original), base64: toBase64(original) } } });
}

export function inspectCpsDatExport(workspace) {
  if (!(workspace instanceof MemoryWorkspace)) throw new TypeError('Expected a MemoryWorkspace');
  const missing = CPS_DAT_REGIONS.filter(r => !workspace.has(r.address, r.length));
  const warnings = [
    'DAT 不含唯一机型标识、校验和或读取覆盖信息；只用于已确认的 UV-K10 Pro CPS 0.56。',
    'CPS 再次打开并保存会重新编码已知字段，可能归一化未知值；保留 .k10 作为完整工作区备份。',
  ];
  if (!workspace.provenance.cps_dat_original)
    warnings.push('新 DAT 的非配置填充区按官方保存器初始化为 FF；这不是电台全片转储。');
  if (workspace.has(0, 999 * 64) && workspace.has(0x11000, 999)) {
    // CPS 0.56 offers three labels, while stock ENG 8.02.16 has four modes.
    // DAT is byte-preserving: report this consumer mismatch, never remap bytes.
    let incompatible = 0;
    for (let index = 0; index < 999; index++)
      if (workspace.data[0x11000 + index] !== 255 && workspace.data[index * 64 + CHANNEL_FIELDS.modulation.offset] >= 2) incompatible++;
    if (incompatible) warnings.push(`${incompatible} 个信道含 CPS/固件调制枚举差异；DAT 保留原字节，不保证官方 PC 显示及重存语义。`);
  }
  return { supported: missing.length === 0, size: CPS_DAT_SIZE, missing: missing.map(r => ({ ...r })), warnings };
}

export async function exportCpsDat(workspace) {
  const inspection = inspectCpsDatExport(workspace);
  if (!inspection.supported)
    throw new Error(`DAT 所需配置尚未完整载入：${inspection.missing.map(r => `${r.id} @ 0x${r.address.toString(16)}`).join('、')}。请重新读取设备或导入完整的本型号 DAT。`);
  const config = workspace.data.slice(0, CPS_DAT_SIZE);
  const envelope = workspace.provenance.cps_dat_original ? { ...workspace.provenance.cps_dat_original } : null;
  const data = envelope ? await decodeEnvelope(envelope) : new Uint8Array(CPS_DAT_SIZE).fill(255);
  for (const region of CPS_DAT_REGIONS)
    data.set(config.subarray(region.address, region.address + region.length), region.address);
  return data;
}
