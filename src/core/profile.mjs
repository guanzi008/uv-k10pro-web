// SPDX-License-Identifier: MIT
// These are K8 / UV-K10 Pro configuration blocks. They are NOT an MCU image.
export const PROFILE = Object.freeze({ id: 'UV-K10-PRO-K8', model: 'UV-K10 Pro',
  protocol: 'K8', firmware: '8.02.16', capacity: 0x400000, version: 1 });

export const READ_REGIONS = Object.freeze([
  { id: 'channels', label: '999 个普通信道', address: 0, length: 999 * 64, writable: true },
  { id: 'vfo', label: '7 组双 VFO', address: 0x10000, length: 0x380, writable: true },
  { id: 'attributes', label: '信道与 VFO 属性', address: 0x11000, length: 1024, writable: true },
  { id: 'broadcast', label: '广播存台', address: 0x12000, length: 0xb10, writable: true },
  { id: 'general', label: '常规与信令设置', address: 0x13000, length: 0x128, writable: true },
  { id: 'identity', label: '标识与设备名称', address: 0x14000, length: 0x70, writable: true },
  { id: 'display', label: 'A/B 显示选择', address: 0x15000, length: 16, writable: true },
  { id: 'scans', label: '32 个扫描列表', address: 0x16000, length: 4096, writable: true },
  { id: 'password', label: '开机密码原始区', address: 0x17000, length: 4, writable: false },
  { id: 'bands', label: '频段定义原始区', address: 0x19000, length: 0xa8, writable: false },
  { id: 'dtmf', label: 'DTMF 联系人', address: 0x1a000, length: 384, writable: true },
  { id: 'five_tone', label: '5TONE 联系人', address: 0x1a800, length: 384, writable: true },
  { id: 'power_flag', label: '官方项目功率标记', address: 0x1b000, length: 1, writable: false },
  // APK and CPS serialization use 272-byte slots with a 160-byte structure;
  // the CPS read path separately advances by sizeof(struct)=160. Preserve the
  // whole slot view; the stock consumer independently confirms the 272-byte
  // stride. The codec preserves the unknown tail of every group slot.
  { id: 'band_groups', label: '8 个自定义频段组', address: 0x1c000, length: 2176, writable: true },
  { id: 'aprs', label: 'APRS 配置', address: 0x1e000, length: 256, writable: true },
  { id: 'messages', label: '64 条预设消息', address: 0x2e000, length: 16384, writable: true },
  { id: 'boot_image', label: '128 × 64 开机图像', address: 0x45000, length: 1032, writable: true },
]);

export function regionAt(address, length = 1) {
  return READ_REGIONS.find(r => address >= r.address && address + length <= r.address + r.length);
}

// The band consumer proves the row fields, not padding or the 112-byte group
// tail. File overlays use the same precise slices as online write planning.
const bandSlices = base => [[0, 7], [8, 7], [0x10, 28], [0x30, 28], [0x50, 28], [0x70, 28]]
  .map(([offset, length]) => ({ id: 'bands', label: '频段定义', address: base + offset, length }));
const writable = READ_REGIONS.filter(r => r.writable && !['band_groups', 'boot_image'].includes(r.id)).map(r => ({ ...r }));
writable.push({ id: 'bands', label: '频段计划选择', address: 0x19008, length: 2 }, ...bandSlices(0x19010));
writable.push({ id: 'bands', label: '空中写频重复次数', address: 0x19001, length: 1 },
  { id: 'bands', label: '信道重配置策略', address: 0x1900a, length: 1 });
for (let i = 0; i < 8; i++) {
  const base = 0x1c000 + i * 272;
  writable.push({ id: 'band_groups', label: '频段组', address: base, length: 4 },
    { id: 'band_groups', label: '频段组', address: base + 8, length: 8 },
    ...bandSlices(base + 16).map(r => ({ ...r, id: 'band_groups', label: '频段组' })));
}
writable.push({ id: 'boot_image', label: '开机图头', address: 0x45000, length: 6 },
  { id: 'boot_image', label: '开机图页面数据', address: 0x45008, length: 1024 });
const merged = [];
for (const range of writable.sort((a, b) => a.address - b.address)) {
  const previous = merged.at(-1);
  if (previous?.id === range.id && previous.address + previous.length === range.address) previous.length += range.length;
  else merged.push(range);
}
export const WRITE_RANGES = Object.freeze(merged.map(range => Object.freeze(range)));

export function isWritableRange(address, length) {
  return Number.isSafeInteger(address) && Number.isSafeInteger(length) && length > 0 &&
    WRITE_RANGES.some(range => address >= range.address && address + length <= range.address + range.length);
}
export const CONFIG_BYTES = READ_REGIONS.reduce((sum, r) => sum + r.length, 0);
