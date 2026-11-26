// SPDX-License-Identifier: MIT
// Local editing operations. Every record and attribute moves without re-encoding.
import { CHANNEL_COUNT, CHANNEL_SIZE, ATTRIBUTE_BASE, readChannel, patchChannel, readScanList } from './channel-codec.mjs';
import { integer } from './encoding.mjs';
import { deriveChannelAttribute, BAND_PLAN_COVERAGE } from './band-codec.mjs';
import { equalBytes } from './workspace.mjs';

function indices(values) {
  if (!Array.isArray(values) || !values.length) throw new Error('请选择至少一个信道。');
  const result = values.map(value => integer(value, 0, CHANNEL_COUNT - 1, '信道索引'));
  if (new Set(result).size !== result.length) throw new Error('信道选择不能重复。');
  return result.sort((a, b) => a - b);
}
function requireChannel(workspace, index) {
  workspace.require(index * CHANNEL_SIZE, CHANNEL_SIZE); workspace.require(ATTRIBUTE_BASE + index, 1);
}

export function copyChannels(workspace, selected, { cut = false } = {}) {
  const source = indices(selected);
  const records = source.map(index => {
    requireChannel(workspace, index);
    return { index, raw: workspace.data.slice(index * CHANNEL_SIZE, (index + 1) * CHANNEL_SIZE), attribute: workspace.data[ATTRIBUTE_BASE + index] };
  });
  return { workspaceId: workspace.id, cut: Boolean(cut), records };
}

export function pasteChannels(workspace, clipboard, startIndex) {
  integer(startIndex, 0, CHANNEL_COUNT - 1, '目标信道');
  if (!clipboard?.records?.length || clipboard.records.length > CHANNEL_COUNT) throw new Error('没有可粘贴的信道。');
  if (startIndex + clipboard.records.length > CHANNEL_COUNT) throw new Error('粘贴范围超过第 999 信道。');
  const destinations = clipboard.records.map((_, offset) => startIndex + offset);
  for (const index of destinations) requireChannel(workspace, index);
  if (clipboard.cut) {
    if (clipboard.workspaceId !== workspace.id) throw new Error('剪切来源工作区已变化，请重新选择。');
    for (const record of clipboard.records) {
      requireChannel(workspace, record.index);
      if (workspace.data[ATTRIBUTE_BASE + record.index] !== record.attribute ||
          !equalBytes(workspace.data.subarray(record.index * CHANNEL_SIZE, (record.index + 1) * CHANNEL_SIZE), record.raw))
        throw new Error('剪切来源信道已修改，请重新剪切。');
    }
  }
  const output = workspace.data.slice();
  if (clipboard.cut) for (const record of clipboard.records)
    if (!destinations.includes(record.index)) output[ATTRIBUTE_BASE + record.index] = 255;
  clipboard.records.forEach((record, offset) => {
    if (!(record.raw instanceof Uint8Array) || record.raw.length !== CHANNEL_SIZE) throw new Error('无效的剪贴板记录。');
    integer(record.attribute, 0, 255, '信道属性');
    output.set(record.raw, destinations[offset] * CHANNEL_SIZE); output[ATTRIBUTE_BASE + destinations[offset]] = record.attribute;
  });
  return output;
}

/** order[destination] = source; a complete permutation never drops a record. */
export function reorderChannels(workspace, order, { updateScanLists = false } = {}) {
  if (!Array.isArray(order) || order.length !== CHANNEL_COUNT || new Set(order).size !== CHANNEL_COUNT ||
      order.some(value => !Number.isInteger(value) || value < 0 || value >= CHANNEL_COUNT)) throw new Error('重排必须包含全部 999 个槽位且不重复。');
  for (let index = 0; index < CHANNEL_COUNT; index++) requireChannel(workspace, index);
  const output = workspace.data.slice(), destinationOf = new Map();
  for (let destination = 0; destination < CHANNEL_COUNT; destination++) {
    const source = order[destination]; destinationOf.set(source, destination);
    output.set(workspace.data.subarray(source * CHANNEL_SIZE, (source + 1) * CHANNEL_SIZE), destination * CHANNEL_SIZE);
    output[ATTRIBUTE_BASE + destination] = workspace.data[ATTRIBUTE_BASE + source];
  }
  if (updateScanLists) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    for (let index = 0; index < 32; index++) {
      const base = 0x16000 + index * 128; workspace.require(base, 128);
      const scan = readScanList(workspace.data, index);
      // Preserve holes, unknown indices, sentinels and every unrelated byte.
      scan.member_slots.forEach((value, slot) => { if (destinationOf.has(value)) view.setUint16(base + 0x18 + slot * 2, destinationOf.get(value), true); });
      scan.priorities.forEach((value, slot) => { if (destinationOf.has(value)) view.setUint16(base + 0x10 + slot * 2, destinationOf.get(value), true); });
    }
  }
  return output;
}

export function moveChannels(workspace, selected, beforeIndex, options) {
  const source = indices(selected); integer(beforeIndex, 0, CHANNEL_COUNT, '插入位置');
  if (source.includes(beforeIndex)) return workspace.data.slice();
  const rest = Array.from({ length: CHANNEL_COUNT }, (_, index) => index).filter(index => !source.includes(index));
  const at = beforeIndex === CHANNEL_COUNT ? rest.length : rest.indexOf(beforeIndex);
  return reorderChannels(workspace, [...rest.slice(0, at), ...source, ...rest.slice(at)], options);
}

export function sortChannels(workspace, selected, { key = 'rx', descending = false, updateScanLists = false } = {}) {
  const targets = indices(selected), keys = { rx: 'rx_frequency_hz', tx: 'derived_tx_frequency_hz_before_reverse', name: 'name' };
  if (!keys[key]) throw new Error('不支持的信道排序字段。');
  const rows = targets.map(index => { requireChannel(workspace, index); return { index, channel: readChannel(workspace.data, index) }; });
  rows.sort((a, b) => {
    if (a.channel.deleted !== b.channel.deleted) return a.channel.deleted ? 1 : -1;
    const av = a.channel[keys[key]], bv = b.channel[keys[key]];
    const compared = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN');
    return (descending ? -compared : compared) || a.index - b.index;
  });
  const order = Array.from({ length: CHANNEL_COUNT }, (_, index) => index);
  targets.forEach((destination, index) => { order[destination] = rows[index].index; });
  return reorderChannels(workspace, order, { updateScanLists });
}

export function batchPatchChannels(workspace, selected, changes) {
  const source = indices(selected), output = workspace.data.slice();
  if (!changes || !Object.keys(changes).length) throw new Error('请选择需要批量修改的字段。');
  if (['rx_frequency_hz', 'offset_hz', 'offset_direction', 'name'].some(key => Object.hasOwn(changes, key)))
    throw new Error('批量参数编辑不修改名称或收发频率；请使用单独编辑或等步进生成。');
  for (const index of source) {
    requireChannel(workspace, index);
    if (workspace.data[ATTRIBUTE_BASE + index] === 255) throw new Error('批量参数编辑仅适用于已启用信道。');
    output.set(patchChannel(workspace.data.subarray(index * CHANNEL_SIZE, (index + 1) * CHANNEL_SIZE), changes), index * CHANNEL_SIZE);
  }
  return output;
}

export function generateChannels(workspace, { startIndex, count, rxStartHz, stepHz, txOffsetHz = 0, templateIndex, namePrefix = '' }) {
  integer(startIndex, 0, 998, '起始信道'); integer(count, 1, 999 - startIndex, '信道数量');
  integer(templateIndex, 0, 998, '模板信道'); integer(rxStartHz, 25000000, 580000000, '起始频率');
  integer(stepHz, 10, 555000000, '频率步进'); integer(txOffsetHz, -555000000, 555000000, '收发频差');
  if (stepHz % 10 || rxStartHz % 10 || txOffsetHz % 10) throw new Error('频率和步进必须是 10 Hz 的整数倍。');
  requireChannel(workspace, templateIndex);
  if (workspace.data[ATTRIBUTE_BASE + templateIndex] === 255) throw new Error('请选择一个已启用信道作为模板。');
  for (const range of BAND_PLAN_COVERAGE) workspace.require(range.address, range.length);
  const template = workspace.data.slice(templateIndex * CHANNEL_SIZE, (templateIndex + 1) * CHANNEL_SIZE), output = workspace.data.slice();
  for (let offset = 0; offset < count; offset++) {
    const index = startIndex + offset, frequency = rxStartHz + stepHz * offset;
    requireChannel(workspace, index);
    integer(frequency, 25000000, 580000000, '生成的接收频率'); integer(frequency + txOffsetHz, 25000000, 580000000, '生成的发射频率');
    const patch = { rx_frequency_hz: frequency, offset_hz: Math.abs(txOffsetHz), offset_direction: txOffsetHz === 0 ? 0 : txOffsetHz > 0 ? 1 : 2 };
    if (namePrefix) patch.name = `${namePrefix}${offset + 1}`;
    output.set(patchChannel(template, patch), index * CHANNEL_SIZE);
    output[ATTRIBUTE_BASE + index] = deriveChannelAttribute(workspace.data, frequency, workspace.data[ATTRIBUTE_BASE + templateIndex]);
  }
  return output;
}
