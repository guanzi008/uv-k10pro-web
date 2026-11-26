// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unhex, view } from '../src/core/encoding.mjs';
import {
  BAND_COUNT, BAND_DEFINITION_SIZE, VFO_BAND_BASE, BAND_GROUP_BASE, BAND_GROUP_COUNT,
  BAND_GROUP_SIZE, BAND_GROUP_MAGIC, BAND_PLAN_COVERAGE, FACTORY_BAND_ENVELOPES,
  bandGroupOffset, decodeBandDefinition, sanitizeBandDefinition,
  readVfoBandDefinition, readBandGroups, resolveActiveBands, classifyReceiveFrequency,
  deriveChannelAttribute, checkTransmitRange, patchBandDefinition,
  patchVfoBandInImage, patchGroupBandInImage, patchBandGroupInImage, patchBandSelection,
} from '../src/core/band-codec.mjs';

const oracle = JSON.parse(readFileSync(new URL('../docs/evidence/bands-replay.json', import.meta.url), 'utf8'));
const activeFields = ['index', 'rx_enabled', 'tx_enabled', 'rx_start_hz', 'rx_end_hz', 'tx_start_hz', 'tx_end_hz'];
const selectFields = band => Object.fromEntries(activeFields.map(field => [field, band[field]]));

function imageFor(vector) {
  const image = Uint8Array.from({ length: 0x1c880 }, (_, i) => (i * 13 + 7) & 255);
  image.set(unhex(vector.hidden_160_hex), 0x19000);
  image.set(unhex(vector.groups_2176_hex), BAND_GROUP_BASE);
  return image;
}
const vectorNamed = name => oracle.plans.find(v => v.case === name);
const fixture = name => imageFor(vectorNamed(name));

function assertOnlyChanged(before, after, permitted) {
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++)
    if (before[i] !== after[i]) assert(permitted.has(i), `unexpected byte changed at 0x${i.toString(16)}`);
}

test('band geometry is pinned to the stock consumer rather than the CPS inconsistent read loop', () => {
  assert.equal(BAND_COUNT, 7);
  assert.equal(BAND_DEFINITION_SIZE, 144);
  assert.equal(BAND_GROUP_COUNT, 8);
  assert.equal(BAND_GROUP_SIZE, 272);
  assert.equal(bandGroupOffset(7), 0x1c770);
  assert.equal(BAND_GROUP_MAGIC, 0x5a5a9876);
  assert.deepEqual(BAND_PLAN_COVERAGE, [{ address: 0x19000, length: 0xa0 }, { address: 0x1c000, length: 0x880 }]);
  assert.throws(() => bandGroupOffset(8), RangeError);
  assert.throws(() => decodeBandDefinition(new Uint8Array(143)), RangeError);
  assert.equal(oracle.sample_sha256, '061759672cc69a1b00420ce6fae67b0756d3db111f8fa4329cadc940dcd17f17');
  assert.equal(oracle.classifier_probes, 1212);
});

for (const vector of oracle.sanitizers) {
  test(`sanitizer matches actual stock Cortex-M0 execution: ${vector.case}`, () => {
    const raw = unhex(vector.input_hex);
    const before = raw.slice();
    const actual = sanitizeBandDefinition(raw);
    assert.deepEqual(actual.raw, unhex(vector.output_hex));
    assert.deepEqual(raw, before, 'read model must not normalize imported bytes');
    assert.deepEqual(actual.changed_offsets, Array.from(raw.keys()).filter(i => raw[i] !== actual.raw[i]));
  });
}

for (const vector of oracle.plans) {
  test(`active plan and RX/TX boundaries match stock instructions: ${vector.case}`, () => {
    const image = imageFor(vector);
    const plan = resolveActiveBands(image);
    assert.deepEqual(plan.bands.map(selectFields), vector.bands);
    assert.equal(plan.available_group_count, vector.available_count);
    assert.equal(plan.custom_enabled, vector.effective_mode === 1);
    assert.equal(plan.selected_group, vector.effective_selection);
    for (const probe of vector.classifier_probes) {
      const receive = classifyReceiveFrequency(image, probe.frequency_hz);
      assert.equal(receive.band_index, probe.band_index, `${probe.frequency_hz} RX band`);
      assert.equal(receive.accepted, probe.rx_accepted, `${probe.frequency_hz} RX accepted`);
      assert.equal(checkTransmitRange(image, probe.frequency_hz).allowed, probe.tx_accepted, `${probe.frequency_hz} TX accepted`);
    }
  });
}

test('group prefix, names and preserved unknown tails are exposed independently', () => {
  const image = fixture('selection_after_hole');
  const { available_count, groups } = readBandGroups(image);
  assert.equal(available_count, 1);
  assert.deepEqual(groups.slice(0, 4).map(g => [g.enabled, g.selectable, g.counted_prefix]),
    [[true, true, true], [false, false, false], [true, false, false], [true, false, false]]);
  assert.equal(groups[0].name, 'GROUP001');
  assert.equal(groups[7].name, 'GROUP008');
  assert.equal(groups[7].reserved_tail.length, 112);
  assert.deepEqual(groups[7].reserved_tail, image.slice(0x1c810, 0x1c880));
  const raw = groups[0].raw.slice();
  groups[0].raw.fill(0);
  assert.deepEqual(image.slice(BAND_GROUP_BASE, BAND_GROUP_BASE + 272), raw, 'decoder does not expose mutable input storage');
});

test('channel attributes use actual active RX ranges and preserve existing unrelated high bits', () => {
  const factory = fixture('factory_global');
  assert.equal(deriveChannelAttribute(factory, 145000000), 2);
  assert.equal(deriveChannelAttribute(factory, 435000000, 0xa2), 0xa5);
  assert.equal(deriveChannelAttribute(factory, 435000000, 255), 5);
  assert.equal(deriveChannelAttribute(factory, 135999900), 1);
  assert.throws(() => deriveChannelAttribute(factory, 135999910), error => error.code === 'BAND_NO_MATCH');
  assert.throws(() => deriveChannelAttribute(factory, 100000000), error => error.code === 'BAND_NO_MATCH');
  const custom = fixture('custom_global');
  assert.throws(() => deriveChannelAttribute(custom, 120000000), error => error.code === 'BAND_DISABLED');
  assert.throws(() => deriveChannelAttribute(custom, 136000000), error => error.code === 'BAND_NO_MATCH');
  assert.throws(() => deriveChannelAttribute(factory, 145000001), /multiple of 10/);
  assert.throws(() => deriveChannelAttribute(factory, 145000000, -1), RangeError);
});

test('global single-row patch preserves reserved bytes, other rows, mode, selection and BLE MAC', () => {
  const before = fixture('custom_global');
  const after = patchVfoBandInImage(before, 2, { rx_start_hz: 144000000, rx_end_hz: 148000000, tx_enabled: false });
  assert.notEqual(after, before);
  const row = readVfoBandDefinition(after).bands[2];
  assert.equal(row.rx_start_hz, 144000000);
  assert.equal(row.rx_end_hz, 148000000);
  assert.equal(row.tx_enabled, false);
  assertOnlyChanged(before, after, new Set([VFO_BAND_BASE + 10,
    ...Array.from({ length: 4 }, (_, i) => VFO_BAND_BASE + 0x18 + i),
    ...Array.from({ length: 4 }, (_, i) => VFO_BAND_BASE + 0x38 + i)]));
});

test('group row patch uses 272-byte stride and preserves header and all 112 tail bytes', () => {
  const before = fixture('custom_last_group');
  const after = patchGroupBandInImage(before, 7, 5, { rx_start_hz: 430000000, tx_start_hz: 431000000 });
  const groups = readBandGroups(after).groups;
  assert.equal(groups[7].bands[5].rx_start_hz, 430000000);
  assert.equal(groups[7].bands[5].tx_start_hz, 431000000);
  const base = bandGroupOffset(7) + 16;
  assertOnlyChanged(before, after, new Set([
    ...Array.from({ length: 4 }, (_, i) => base + 0x24 + i),
    ...Array.from({ length: 4 }, (_, i) => base + 0x64 + i),
  ]));
});

test('explicit field validation prevents silently reset frequencies or unrepresentable text', () => {
  const raw = readVfoBandDefinition(fixture('custom_global')).raw;
  assert.throws(() => patchBandDefinition(raw, 2, { rx_start_hz: 135999900 }), /envelope/);
  assert.throws(() => patchBandDefinition(raw, 2, { rx_start_hz: 145000001 }), /multiple of 10/);
  assert.throws(() => patchBandDefinition(raw, 2, { rx_start_hz: 148000000, rx_end_hz: 148000000 }), /reset by stock/);
  assert.throws(() => patchBandDefinition(raw, 2, { tx_start_hz: 148000000, tx_end_hz: 144000000 }), /reset by stock/);
  assert.throws(() => patchBandDefinition(raw, 2, { rx_enabled: 2 }), /boolean/);
  assert.throws(() => patchBandDefinition(raw, 2, { undocumented: 1 }), /Unknown/);
  assert.throws(() => patchBandGroupInImage(fixture('custom_first_group'), 0, { name: '123456789' }), /maximum/);
  assert.throws(() => patchBandGroupInImage(fixture('custom_first_group'), 0, { name: '😀' }), /representable/);
});

test('band edits preserve unrelated invalid raw values and all padding instead of rewriting defaults', () => {
  const vector = oracle.sanitizers.find(v => v.case === 'erased');
  const raw = unhex(vector.input_hex);
  const result = patchBandDefinition(raw, 2, { rx_start_hz: 144000000 });
  assertOnlyChanged(raw, result, new Set([0x18, 0x19, 0x1a, 0x1b]));
  assert.equal(sanitizeBandDefinition(result).bands[2].rx_start_hz, 144000000);
  assert.equal(result[0], 255, 'unrelated invalid enable byte survives');
  assert.equal(view(result).getUint32(0x38, true), 0xffffffff, 'unrequested invalid end word survives');
  const off = unhex(oracle.sanitizers.find(v => v.case === 'all_rx_off').input_hex);
  off[5] = 1;
  assert.throws(() => patchBandDefinition(off, 5, { rx_enabled: false }), /At least one RX/);
});

test('group name and enable patches preserve unrelated bytes and prevent creating unreachable groups', () => {
  const before = fixture('factory_global');
  const named = patchBandGroupInImage(before, 0, { name: '测试组', enabled: true });
  const groups = readBandGroups(named);
  assert.equal(groups.available_count, 1);
  assert.equal(groups.groups[0].name, '测试组');
  assertOnlyChanged(before, named, new Set([0, 1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15].map(i => BAND_GROUP_BASE + i)));
  assert.throws(() => patchBandGroupInImage(named, 2, { enabled: true }), /preceding/);
  const two = patchBandGroupInImage(named, 1, { enabled: true });
  assert.equal(readBandGroups(two).available_count, 2);
  assert.throws(() => patchBandGroupInImage(two, 0, { enabled: false }), /following/);
  const one = patchBandGroupInImage(two, 1, { enabled: false });
  assert.equal(readBandGroups(one).available_count, 1);
  assert.equal(readBandGroups(patchBandGroupInImage(one, 0, { enabled: false })).available_count, 0);
});

test('explicit band mode/selection patches affect only bytes 0x19008 and 0x19009', () => {
  const before = fixture('custom_last_group');
  const after = patchBandSelection(before, { custom_enabled: false, selected_group: 3 });
  assertOnlyChanged(before, after, new Set([0x19008, 0x19009]));
  assert.equal(resolveActiveBands(after).source, 'factory');
  assert.equal(resolveActiveBands(after).selected_group, 3);
  const global = patchBandSelection(after, { custom_enabled: true, selected_group: 0 });
  assert.equal(resolveActiveBands(global).source, 'vfo');
  const group = patchBandSelection(global, { selected_group: 8 });
  assert.equal(resolveActiveBands(group).source, 'group');
  assert.deepEqual(resolveActiveBands(group).bands.map(selectFields), vectorNamed('custom_last_group').bands);
  assert.throws(() => patchBandSelection(fixture('selection_after_hole'), { selected_group: 3 }), /contiguous/);
  assert.throws(() => patchBandSelection(before, { selected_group: 9 }), RangeError);
  assert.throws(() => patchBandSelection(before, { custom_enabled: 2 }), RangeError);
  assert.throws(() => patchBandSelection(before, { board: 1 }), /Unknown/);
});

test('truncated images cannot silently supply a plan', () => {
  assert.throws(() => resolveActiveBands(new Uint8Array(0x190a0)), RangeError);
  assert.throws(() => readVfoBandDefinition(new Uint8Array(VFO_BAND_BASE + 143)), RangeError);
  assert.throws(() => readBandGroups(new Uint8Array(0x1c87f)), RangeError);
  assert.equal(FACTORY_BAND_ENVELOPES[1].end_hz, 135999900);
});
