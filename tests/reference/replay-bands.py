#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Optional stock-instruction band oracle; no vendor image is redistributed.

Supply the pinned 8.02.16 decoded application and the MIT StockEmulator helpers.
Only the known physical NOR helpers are replaced. The configuration loader is
deliberately stopped at 0x0800f34e, after its band setup and before unrelated
configuration reads. This is not a radio, startup or hardware emulator.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import struct
import sys

LOWER = [2500000, 10800000, 13600000, 17400000, 35000000, 40000000, 47000000]
UPPER = [7600000, 13599990, 17399990, 34999990, 39999990, 46999990, 58000000]
MAGIC = 0x5a5a9876


def definition(seed=0, *, rx_off=False):
    raw = bytearray((i * 37 + 11 + seed) & 255 for i in range(144))
    for band, (lo, hi) in enumerate(zip(LOWER, UPPER)):
        raw[band] = 0 if rx_off else int((band + seed) % 4 != 1)
        raw[8 + band] = int((band + seed) % 3 == 0)
        margin = (seed + 1) * 1000 + band * 10
        struct.pack_into('<I', raw, 0x10 + band * 4, lo + margin)
        struct.pack_into('<I', raw, 0x30 + band * 4, hi - margin)
        struct.pack_into('<I', raw, 0x50 + band * 4, lo + margin * 2)
        struct.pack_into('<I', raw, 0x70 + band * 4, hi - margin * 2)
    return raw


def group_image(enabled, *, zero_rx_group=None):
    raw = bytearray((i * 53 + 19) & 255 for i in range(8 * 272))
    for i in range(8):
        offset = i * 272
        struct.pack_into('<I', raw, offset, MAGIC if i in enabled else 0)
        raw[offset + 8:offset + 16] = f'GROUP{i + 1:03d}'.encode('ascii')
        raw[offset + 16:offset + 160] = definition(i + 1, rx_off=i == zero_rx_group)
    return raw


def run(raw, helpers):
    sys.path.insert(0, str(helpers.resolve()))
    from emulate_stock import StockEmulator, NorModel, SCRATCH_BASE, RETURN_ADDRESS
    from unicorn import UC_HOOK_CODE
    from unicorn.arm_const import UC_ARM_REG_PC

    def need(condition, message):
        if not condition:
            raise AssertionError(message)

    def setup():
        emu = StockEmulator(raw)
        emu.initialize_data()
        nor = NorModel(0x400000)
        nor.attach(emu)
        return emu, nor

    emu, _ = setup()
    need(list(struct.unpack('<7I', emu.read(0x0801e670, 28))) == LOWER, 'factory lower ROM table changed')
    need(list(struct.unpack('<7I', emu.read(0x0801e68c, 28))) == UPPER, 'factory upper ROM table changed')
    sanitizers = []
    invalid_flags = definition(2)
    invalid_flags[:7] = bytes([0, 1, 2, 255, 127, 1, 0])
    invalid_flags[8:15] = bytes([255, 2, 127, 1, 0, 9, 255])
    invalid_ranges = definition(3)
    for band, (lo, hi) in enumerate(zip(LOWER, UPPER)):
        struct.pack_into('<I', invalid_ranges, 0x10 + band * 4, lo - 1 if band % 2 else hi + 1)
        struct.pack_into('<I', invalid_ranges, 0x30 + band * 4, hi + 1 if band % 2 else lo - 1)
        struct.pack_into('<I', invalid_ranges, 0x50 + band * 4, lo + 5)
        struct.pack_into('<I', invalid_ranges, 0x70 + band * 4, lo + 5 if band % 2 else lo + 4)
    for name, data in [('erased', bytes([255]) * 144), ('zero', bytes(144)),
                       ('valid_narrow', definition()), ('invalid_flags', invalid_flags),
                       ('invalid_ranges', invalid_ranges), ('all_rx_off', definition(rx_off=True))]:
        emu, nor = setup()
        emu.write(SCRATCH_BASE, bytes(data))
        call = emu.call(0x08003c20, (SCRATCH_BASE,))
        need(not nor.operations and call.hardware_hooks == 0, 'sanitizer accessed hardware')
        output = emu.read(SCRATCH_BASE, 144)
        known = set(range(7)) | set(range(8, 15))
        for start in (0x10, 0x30, 0x50, 0x70):
            known.update(range(start, start + 28))
        need(all(data[i] == output[i] for i in range(144) if i not in known), 'sanitizer modified padding')
        sanitizers.append({'case': name, 'input_hex': bytes(data).hex(), 'output_hex': output.hex(),
                           'padding_preserved': True, 'call': asdict(call)})

    group_counts = []
    for enabled in [[], [0], [0, 1, 2], list(range(8)), [0, 2, 3], [1, 2, 3]]:
        emu, nor = setup()
        nor.data[0x1c000:0x1c880] = group_image(enabled)
        call = emu.call(0x080078e4)
        count = emu.read(0x20000160, 1)[0]
        expected = 0
        while expected in enabled and expected < 8:
            expected += 1
        need(count == expected, 'group count was not contiguous prefix')
        need(nor.operations == [{'op': 'read', 'address': 0x1c000 + i * 272, 'length': 4}
                                for i in range(min(8, count + 1))], 'group count used wrong stride/length')
        group_counts.append({'enabled_indices': enabled, 'available_count': count,
                             'read_operations': nor.operations, 'call': asdict(call)})

    names = []
    for selection in [1, 8]:
        emu, nor = setup()
        groups = group_image(list(range(8)))
        nor.data[0x1c000:0x1c880] = groups
        call = emu.call(0x0800f1b4, (selection, SCRATCH_BASE))
        output = emu.read(SCRATCH_BASE, 8)
        need(output == groups[(selection - 1) * 272 + 8:(selection - 1) * 272 + 16], 'group name stride mismatch')
        names.append({'selection': selection, 'name_hex': output.hex(), 'read_operations': nor.operations, 'call': asdict(call)})

    cases = [
        ('factory_erased', 255, 255, bytes([255]) * 144, bytes([255]) * (8 * 272)),
        ('factory_global', 0, 0, definition(), group_image([])),
        ('factory_selected_group_uses_global_tx', 0, 1, definition(), group_image([0])),
        ('custom_global', 1, 0, definition(), group_image([])),
        ('custom_first_group', 1, 1, definition(), group_image([0])),
        ('custom_last_group', 1, 8, definition(), group_image(list(range(8)))),
        ('selection_beyond_prefix', 1, 4, definition(), group_image([0, 1])),
        ('selection_after_hole', 1, 3, definition(), group_image([0, 2, 3])),
        ('custom_global_all_rx_off', 1, 0, definition(rx_off=True), group_image([])),
        ('custom_group_all_rx_off', 1, 1, definition(), group_image([0], zero_rx_group=0)),
        ('invalid_mode_uses_factory', 2, 1, definition(), group_image([0])),
        ('custom_erased_definition', 1, 0, bytes([255]) * 144, group_image([])),
    ]
    plans = []
    for name, mode, selection, global_definition, groups in cases:
        emu, nor = setup()
        hidden = bytearray((i * 31 + 7) & 255 for i in range(160))
        hidden[8:10] = bytes([mode, selection])
        hidden[16:] = global_definition
        nor.data[0x19000:0x190a0] = hidden
        nor.data[0x1c000:0x1c880] = groups
        count_call = emu.call(0x080078e4)
        count = emu.read(0x20000160, 1)[0]
        prefix_reached = []

        def stop_after_bands(uc, address, size, user):
            del size, user
            if address == 0x0800f34e:
                prefix_reached.append(address)
                uc.reg_write(UC_ARM_REG_PC, RETURN_ADDRESS | 1)

        hook = emu.uc.hook_add(UC_HOOK_CODE, stop_after_bands)
        load_call = emu.call(0x0800f288)
        emu.uc.hook_del(hook)
        need(len(prefix_reached) == 1, 'loader did not reach the declared prefix boundary')
        effective_mode, effective_selection = emu.read(0x20002510, 2)
        need(effective_mode == (mode if mode < 2 else 0), 'mode normalization mismatch')
        need(effective_selection == (selection if selection <= count else 0), 'selection normalization mismatch')
        bands = []
        for band in range(7):
            bands.append({'index': band,
                          'rx_enabled': emu.read(0x2000019b + band, 1)[0] == 1,
                          'tx_enabled': emu.read(0x200002c9 + band, 1)[0] == 1,
                          'rx_start_hz': emu.u32(0x20002ca4 + band * 4) * 10,
                          'rx_end_hz': emu.u32(0x20002cc0 + band * 4) * 10,
                          'tx_start_hz': emu.u32(0x20002cdc + band * 4) * 10,
                          'tx_end_hz': emu.u32(0x20002cf8 + band * 4) * 10})
        read_operations = nor.operations.copy()
        expected_group_read = ([{'op': 'read', 'address': 0x1c000 + (effective_selection - 1) * 272 + 16, 'length': 256}]
                               if effective_selection else [])
        need(read_operations[min(8, count + 1):] == [{'op': 'read', 'address': 0x19000, 'length': 160}] + expected_group_read,
             'band loader read range/stride mismatch')
        probes = {0, 7600001, 10000000, 58000001, 0xffffffff}
        for band, lo, hi in zip(bands, LOWER, UPPER):
            for boundary in (lo, hi, band['rx_start_hz'] // 10, band['rx_end_hz'] // 10,
                             band['tx_start_hz'] // 10, band['tx_end_hz'] // 10):
                probes.update([boundary - 1, boundary, boundary + 1])
            probes.add((lo + hi) // 2)
        classifiers = []
        for frequency in sorted(probes):
            emu.write(SCRATCH_BASE, b'\xcc')
            rx = emu.call(0x08005fbe, (frequency, SCRATCH_BASE))
            tx = emu.call(0x0800629c, (frequency,))
            need(rx.hardware_hooks == 0 and tx.hardware_hooks == 0, 'classification accessed hardware')
            classifiers.append({'frequency_hz': frequency * 10, 'band_index': emu.read(SCRATCH_BASE, 1)[0],
                                'rx_accepted': rx.r0 == 1, 'tx_accepted': tx.r0 == 0})
        plans.append({'case': name, 'hidden_160_hex': bytes(hidden).hex(), 'groups_2176_hex': bytes(groups).hex(),
                      'available_count': count, 'effective_mode': effective_mode, 'effective_selection': effective_selection,
                      'bands': bands, 'read_operations': read_operations, 'count_call': asdict(count_call),
                      'loader_prefix_call': asdict(load_call), 'classifier_probes': classifiers})
    return {'schema_version': 1, 'sample_sha256': hashlib.sha256(raw).hexdigest(),
            'cpu': 'Unicorn Cortex-M0 instruction execution',
            'source_scope': 'UV-K10 Pro ENG 8.02.16 decoded application only',
            'scope': 'Synthetic 4 MiB NOR; real stock sanitizer, group scanner, name reader, band-loader prefix and RX/TX classifier instructions execute. No RF, MMIO, USB, BLE, timing, boot or physical hardware is modeled.',
            'prefix_boundary': {'entry': '0x0800f288', 'stop_before': '0x0800f34e',
                                'reason': 'band setup complete; next instruction begins unrelated configuration load'},
            'functions': {'sanitizer': '0x08003c20', 'group_count': '0x080078e4', 'group_name': '0x0800f1b4',
                          'selected_definition_load': '0x0800f1e8', 'rx_at_least_one': '0x08003afc',
                          'active_plan_copy': '0x08011d14', 'rx_classifier': '0x08005fbe', 'tx_check': '0x0800629c'},
            'hardware_replacements': ['0x080195e4 NOR read', '0x08019588 NOR sector erase', '0x080197ec NOR page program'],
            'sanitizers': sanitizers, 'group_counts': group_counts, 'group_names': names, 'plans': plans,
            'passed': len(sanitizers) + len(group_counts) + len(names) + len(plans),
            'classifier_probes': sum(len(case['classifier_probes']) for case in plans)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stock_image', type=Path)
    parser.add_argument('--research-tools', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not __debug__:
        parser.error('run without -O')
    report = run(args.stock_image.read_bytes(), args.research_tools)
    text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
        print(json.dumps({'output': str(args.output), 'passed': report['passed'], 'classifier_probes': report['classifier_probes']}))
    else:
        print(text)


if __name__ == '__main__':
    main()
