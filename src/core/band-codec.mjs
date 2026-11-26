// SPDX-License-Identifier: MIT
// Independent UV-K10 Pro 8.02.16 band model. See docs/bands.md for evidence.
import { bytes, exact, span, integer, view, visibleText, encodeText, frequencyUnits } from './encoding.mjs';

export const BAND_COUNT = 7;
export const BAND_DEFINITION_SIZE = 0x90;
export const VFO_BAND_BASE = 0x19010;
export const BAND_GROUP_BASE = 0x1c000;
export const BAND_GROUP_COUNT = 8;
export const BAND_GROUP_SIZE = 0x110;
export const BAND_GROUP_MAGIC = 0x5a5a9876;
export const BAND_PLAN_COVERAGE = Object.freeze([
  Object.freeze({ address: 0x19000, length: 0xa0 }),
  Object.freeze({ address: BAND_GROUP_BASE, length: BAND_GROUP_COUNT * BAND_GROUP_SIZE }),
]);

// Exact stock constants, inclusive, in Hz. The gaps are intentional.
export const FACTORY_BAND_ENVELOPES = Object.freeze([
  [25000000, 76000000], [108000000, 135999900], [136000000, 173999900],
  [174000000, 349999900], [350000000, 399999900], [400000000, 469999900],
  [470000000, 580000000],
].map((range, index) => Object.freeze({ index, start_hz: range[0], end_hz: range[1] })));

const FREQUENCY_FIELDS = Object.freeze({ rx_start_hz: 0x10, rx_end_hz: 0x30, tx_start_hz: 0x50, tx_end_hz: 0x70 });
const FLAG_FIELDS = Object.freeze({ rx_enabled: 0, tx_enabled: 8 });
const DEFAULT_TX_ENABLED = Object.freeze([true, false, true, false, false, true, false]);

export function bandGroupOffset(index) {
  return BAND_GROUP_BASE + integer(index, 0, BAND_GROUP_COUNT - 1, 'band group index') * BAND_GROUP_SIZE;
}

export function decodeBandDefinition(raw) {
  raw = exact(raw, BAND_DEFINITION_SIZE, 'band definition').slice();
  const dv = view(raw);
  return { raw, bands: Array.from({ length: BAND_COUNT }, (_, index) => ({
    index, rx_enable_raw: raw[index], tx_enable_raw: raw[8 + index],
    rx_enabled: raw[index] === 1, tx_enabled: raw[8 + index] === 1,
    ...Object.fromEntries(Object.entries(FREQUENCY_FIELDS).map(([field, offset]) => [field, dv.getUint32(offset + index * 4, true) * 10])),
  })) };
}

// Model the stock 0x08003c20 sanitizer without changing the source image.
export function sanitizeBandDefinition(raw) {
  const original = exact(raw, BAND_DEFINITION_SIZE, 'band definition');
  const output = original.slice();
  const dv = view(output);
  for (let i = 0; i < BAND_COUNT; i++) {
    if (output[i] > 1) output[i] = 1;
    if (output[8 + i] > 1) output[8 + i] = Number(DEFAULT_TX_ENABLED[i]);
    const { start_hz: minimum, end_hz: maximum } = FACTORY_BAND_ENVELOPES[i];
    for (const [field, offset] of Object.entries(FREQUENCY_FIELDS)) {
      const value = dv.getUint32(offset + i * 4, true) * 10;
      if (value < minimum || value > maximum)
        dv.setUint32(offset + i * 4, (field.endsWith('start_hz') ? minimum : maximum) / 10, true);
    }
    for (const [low, high] of [[0x10, 0x30], [0x50, 0x70]]) {
      if (dv.getUint32(low + i * 4, true) >= dv.getUint32(high + i * 4, true)) {
        dv.setUint32(low + i * 4, minimum / 10, true);
        dv.setUint32(high + i * 4, maximum / 10, true);
      }
    }
  }
  const changed_offsets = Array.from(output.keys()).filter(i => output[i] !== original[i]);
  return { ...decodeBandDefinition(output), changed_offsets, was_sanitized: changed_offsets.length !== 0 };
}

export function readVfoBandDefinition(image) {
  const raw = span(image, VFO_BAND_BASE, BAND_DEFINITION_SIZE);
  const effective = sanitizeBandDefinition(raw);
  return { ...decodeBandDefinition(raw), address: VFO_BAND_BASE, length: BAND_DEFINITION_SIZE,
    effective_bands: effective.bands, sanitizer_changed_offsets: effective.changed_offsets };
}

export function readBandGroups(image) {
  const groups = Array.from({ length: BAND_GROUP_COUNT }, (_, index) => {
    const address = bandGroupOffset(index);
    const raw = span(image, address, BAND_GROUP_SIZE).slice();
    const definition = decodeBandDefinition(raw.subarray(0x10, 0xa0));
    const effective = sanitizeBandDefinition(definition.raw);
    const flag = view(raw).getUint32(0, true);
    return { index, selection: index + 1, address, raw, flag, enabled: flag === BAND_GROUP_MAGIC,
      name: visibleText(raw.subarray(8, 16)), name_raw: raw.slice(8, 16),
      bands: definition.bands, effective_bands: effective.bands,
      sanitizer_changed_offsets: effective.changed_offsets,
      reserved_tail: raw.slice(0xa0), selectable: false, counted_prefix: false };
  });
  let available_count = 0;
  while (available_count < groups.length && groups[available_count].enabled) available_count++;
  for (const group of groups) group.selectable = group.counted_prefix = group.index < available_count;
  return { address: BAND_GROUP_BASE, slot_size: BAND_GROUP_SIZE, count: BAND_GROUP_COUNT, available_count, groups };
}

/** Resolve the active stock plan; caller must prove both BAND_PLAN_COVERAGE spans were read. */
export function resolveActiveBands(image) {
  const header = span(image, 0x19000, 0x10);
  const global = readVfoBandDefinition(image);
  const groups = readBandGroups(image);
  const requested_group = header[9];
  const selected_group = requested_group <= groups.available_count ? requested_group : 0;
  const group_index = selected_group ? selected_group - 1 : null;
  const custom_enabled = header[8] === 1;
  const chosen = selected_group ? groups.groups[group_index].effective_bands : global.effective_bands;
  const warnings = [];
  if (header[8] > 1) warnings.push('Invalid custom-mode byte is treated as factory mode by stock.');
  if (requested_group !== selected_group) warnings.push('Selected group is outside the contiguous enabled prefix; stock uses the global definition.');
  if (groups.groups.some(g => g.enabled && !g.selectable)) warnings.push('Enabled group after a disabled slot is unreachable by stock selection.');
  const selectedSanitizerChanges = selected_group ? groups.groups[group_index].sanitizer_changed_offsets : global.sanitizer_changed_offsets;
  if (selectedSanitizerChanges.length) warnings.push('The selected raw definition contains values normalized by the stock sanitizer.');
  const rx_fallback_band = chosen.every(band => !band.rx_enabled) ? 5 : null;
  if (rx_fallback_band !== null && custom_enabled) warnings.push('All selected RX flags are off; stock enables RX band 5 in RAM.');
  const bands = chosen.map((band, index) => {
    if (custom_enabled) return { ...band, rx_enabled: band.rx_enabled || index === rx_fallback_band };
    const envelope = FACTORY_BAND_ENVELOPES[index];
    return { index, rx_enabled: true, tx_enabled: global.effective_bands[index].tx_enabled,
      rx_start_hz: envelope.start_hz, rx_end_hz: envelope.end_hz,
      tx_start_hz: envelope.start_hz, tx_end_hz: envelope.end_hz };
  });
  return { source: custom_enabled ? (selected_group ? 'group' : 'vfo') : 'factory',
    custom_enabled, mode_raw: header[8], requested_group, selected_group, group_index,
    available_group_count: groups.available_count, rx_fallback_band, bands, warnings };
}

function bandError(code, message) {
  const error = new RangeError(message);
  error.code = code;
  return error;
}

export function classifyReceiveFrequency(image, frequencyHz) {
  frequencyUnits(frequencyHz);
  const plan = resolveActiveBands(image);
  const band = plan.bands.find(candidate => frequencyHz >= candidate.rx_start_hz && frequencyHz <= candidate.rx_end_hz);
  return { band_index: band?.index ?? 7, accepted: Boolean(band?.rx_enabled),
    reason: !band ? 'outside_all_ranges' : !band.rx_enabled ? 'disabled_band' : null, source: plan.source };
}

export function deriveChannelAttribute(image, frequencyHz, previousAttribute = 255) {
  integer(previousAttribute, 0, 255, 'previous channel attribute');
  const result = classifyReceiveFrequency(image, frequencyHz);
  if (result.band_index === 7) throw bandError('BAND_NO_MATCH', 'RX frequency is outside the active band ranges.');
  if (!result.accepted) throw bandError('BAND_DISABLED', 'RX frequency belongs to a disabled band.');
  return (previousAttribute === 255 ? 0 : previousAttribute & 0xf0) | result.band_index;
}

// Models stock 0x0800629c only: configured range acceptance, not RF capability.
export function checkTransmitRange(image, frequencyHz) {
  frequencyUnits(frequencyHz);
  const plan = resolveActiveBands(image);
  const envelope = FACTORY_BAND_ENVELOPES.find(band => frequencyHz >= band.start_hz && frequencyHz <= band.end_hz);
  if (!envelope) return { allowed: false, band_index: 7, reason: 'outside_factory_envelopes' };
  const band = plan.bands[envelope.index];
  const inRange = frequencyHz >= band.tx_start_hz && frequencyHz <= band.tx_end_hz;
  return { allowed: band.tx_enabled && inRange, band_index: band.index,
    reason: !band.tx_enabled ? 'disabled_band' : !inRange ? 'outside_configured_range' : null };
}

function booleanByte(value, field) {
  if (value !== true && value !== false && value !== 0 && value !== 1)
    throw new RangeError(`${field} must be a boolean or 0/1`);
  return Number(value);
}

/** Change just the requested row fields. Reserved bytes and unedited raw values survive. */
export function patchBandDefinition(raw, bandIndex, changes) {
  integer(bandIndex, 0, BAND_COUNT - 1, 'band index');
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Band changes must be an object');
  const output = exact(raw, BAND_DEFINITION_SIZE, 'band definition').slice();
  const dv = view(output);
  const envelope = FACTORY_BAND_ENVELOPES[bandIndex];
  for (const [key, value] of Object.entries(changes)) {
    if (Object.hasOwn(FLAG_FIELDS, key)) output[FLAG_FIELDS[key] + bandIndex] = booleanByte(value, key);
    else if (Object.hasOwn(FREQUENCY_FIELDS, key)) {
      const units = frequencyUnits(value);
      if (value < envelope.start_hz || value > envelope.end_hz)
        throw new RangeError(`${key} must remain inside stock band ${bandIndex}'s envelope.`);
      dv.setUint32(FREQUENCY_FIELDS[key] + bandIndex * 4, units, true);
    } else throw new RangeError(`Unknown band field: ${key}`);
  }
  // A requested frequency must survive the actual sanitizer unchanged. This also
  // rejects equal/reversed intervals while preserving unrelated invalid bytes.
  const effective = sanitizeBandDefinition(output);
  for (const [key, value] of Object.entries(changes)) {
    if (Object.hasOwn(FREQUENCY_FIELDS, key) && effective.bands[bandIndex][key] !== value)
      throw new RangeError(`${key} would be reset by stock; require start < end in the band envelope.`);
  }
  if (Object.hasOwn(changes, 'rx_enabled') && effective.bands.every(band => !band.rx_enabled))
    throw new RangeError('At least one RX band must remain enabled; stock otherwise forces band 5 on.');
  return output;
}

export function patchVfoBandInImage(image, bandIndex, changes) {
  const edited = patchBandDefinition(span(image, VFO_BAND_BASE, BAND_DEFINITION_SIZE), bandIndex, changes);
  const output = bytes(image).slice();
  output.set(edited, VFO_BAND_BASE);
  return output;
}

export function patchGroupBandInImage(image, groupIndex, bandIndex, changes) {
  const offset = bandGroupOffset(groupIndex) + 0x10;
  const edited = patchBandDefinition(span(image, offset, BAND_DEFINITION_SIZE), bandIndex, changes);
  const output = bytes(image).slice();
  output.set(edited, offset);
  return output;
}

export function patchBandGroupInImage(image, groupIndex, changes) {
  const offset = bandGroupOffset(groupIndex);
  const groups = readBandGroups(image).groups;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Group changes must be an object');
  const output = bytes(image).slice();
  const dv = view(output);
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name') output.set(encodeText(value, 8), offset + 8);
    else if (key === 'enabled') {
      const enabled = booleanByte(value, key) === 1;
      if (enabled && groups.slice(0, groupIndex).some(group => !group.enabled))
        throw new RangeError('Enable preceding groups first; stock stops at the first disabled group.');
      if (!enabled && groups.slice(groupIndex + 1).some(group => group.enabled))
        throw new RangeError('Disable following groups first; a gap would make them unreachable.');
      dv.setUint32(offset, enabled ? BAND_GROUP_MAGIC : 0, true);
    } else throw new RangeError(`Unknown group field: ${key}`);
  }
  return output;
}

/** Explicit ordinary band-plan selection. Does not edit any other header field. */
export function patchBandSelection(image, changes) {
  span(image, 0x19008, 2);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Band selection changes must be an object');
  const output = bytes(image).slice();
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'custom_enabled') output[0x19008] = booleanByte(value, key);
    else if (key === 'selected_group') {
      integer(value, 0, BAND_GROUP_COUNT, 'selected group');
      if (value > readBandGroups(image).available_count)
        throw new RangeError('Selected group must belong to the contiguous enabled prefix; 0 selects the global definition.');
      output[0x19009] = value;
    } else throw new RangeError(`Unknown band selection field: ${key}`);
  }
  return output;
}
