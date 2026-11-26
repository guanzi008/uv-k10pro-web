#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Optional pinned-stock CPU experiment; not part of the Web runtime.

Requires the MIT StockEmulator / NorModel helpers from uv-k10pro-firmware and
their Unicorn dependency. The caller supplies the stock application image.
No vendor code bytes or hardware access are included in this repository.
"""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import struct
import sys


def run(raw, helpers):
    sys.path.insert(0, str(helpers.resolve()))
    from emulate_stock import StockEmulator, NorModel, SCRATCH_BASE

    def setup():
        emulator = StockEmulator(raw)
        emulator.initialize_data()
        nor = NorModel(0x400000)
        nor.attach(emulator)
        return emulator, nor

    def need(condition, message):
        if not condition:
            raise AssertionError(message)

    results = []
    for chip, requested_band, frequency in [(1, 0, 8810000), (1, 1, 19800),
                                           (1, 2, 100000), (1, 3, 1420000),
                                           (0, 3, 8810000)]:
        emulator, nor = setup()
        emulator.write(0x2000006C, bytes([chip]))
        emulator.write(0x20002410, b'\1')  # controlled FM range = 88..108 MHz
        nor.data[0x12000:0x12008] = bytes([requested_band, 0, 0, 0, 0, 0, 0, 0])
        actual_band = requested_band if chip == 1 else 0
        count = 128 if actual_band == 3 else 32
        bank = bytearray(1040)
        bank[:8] = bytes([0, 3, 7, 2, 1, 2, 4, 5])
        struct.pack_into('<IBBH', bank, 8, frequency, 3, 0xA5, 0xFF9C)
        for i in range(128):
            struct.pack_into('<IBBH', bank, 16 + i * 8, frequency + i, 1 + i % 3, 0x5A, i * 17)
        offset = 0x12100 + actual_band * 0x200
        nor.data[offset:offset + len(bank)] = bank
        call = emulator.call(0x0800F020)
        need(nor.operations == [{'op': 'read', 'address': 0x12000, 'length': 8},
                                {'op': 'read', 'address': offset, 'length': 1040}], 'broadcast read span mismatch')
        need(emulator.read(0x200025A8, 1)[0] == actual_band, 'radio selection mismatch')
        need(emulator.read(0x200000CE, 1)[0] == count, 'preset count mismatch')
        need(emulator.u32(0x200025B8) == frequency, 'VFO frequency word changed')
        need(emulator.read(0x200025C0, count * 8) == bytes(bank[16:16 + count * 8]), 'preset copy mismatch')
        if chip == 0:
            need(emulator.read(0x200025B3, 1) == b'\1', 'BK1080 step is not forced to index 1')
            need(emulator.read(0x200025BC, 1) == b'\0', 'BK1080 VFO demodulation is not zero')
            need(emulator.read(0x200025BE, 2) == b'\0\0', 'BK1080 VFO BFO is not zero')
        else:
            need(emulator.read(0x200025BE, 2) == b'\x9c\xff', 'Si4732 BFO raw bits changed')
        results.append({'case': 'load', 'chip_condition': chip, 'requested_band': requested_band,
                        'actual_band': actual_band, 'preset_count': count, 'read_operations': nor.operations,
                        'vfo_frequency_raw': frequency, 'vfo_bfo_raw': int.from_bytes(emulator.read(0x200025BE, 2), 'little'),
                        'call': asdict(call)})

    for band in range(4):
        for flags in (0, 1, 2, 3):
            emulator, nor = setup()
            global_header = bytes([band, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98])
            length = 1040 if band == 3 else 272
            bank = bytes((i * 17 + 23) & 255 for i in range(length))
            emulator.write(0x200025A8, global_header)
            emulator.write(0x200025B0, bank)
            before = bytes(nor.data)
            call = emulator.call(0x080101FC, (flags,))
            expected = bytearray(before)
            if flags & 1:
                expected[0x12000:0x12008] = global_header
            if flags & 2:
                offset = 0x12100 + band * 0x200
                expected[offset:offset + length] = bank
            need(nor.data == expected, f'broadcast save diff mismatch for band {band}, flags {flags}')
            results.append({'case': 'save', 'band': band, 'flags': flags,
                            'global_length': 8 if flags & 1 else 0,
                            'bank_address': 0x12100 + band * 0x200 if flags & 2 else None,
                            'bank_length': length if flags & 2 else 0,
                            'unrelated_nor_bytes_unchanged': True, 'call': asdict(call)})

    for magic, length in [(0x9ABC5A5A, 1024), (0, 1024), (0x9ABC5A5A, 1023)]:
        emulator, nor = setup()
        header = struct.pack('<IH2s', magic, length, b'\xA5\x5A')
        bitmap = bytes((i * 37 + 11) & 255 for i in range(1024))
        nor.data[0x45000:0x45008] = header
        nor.data[0x45008:0x45408] = bitmap
        emulator.write(SCRATCH_BASE, b'\xCC' * 1024)
        call = emulator.call(0x0800FD04, (SCRATCH_BASE,))
        accepted = magic == 0x9ABC5A5A and length == 1024
        need(call.r0 == int(accepted), 'boot bitmap validity mismatch')
        need(emulator.read(SCRATCH_BASE, 1024) == (bitmap if accepted else b'\xCC' * 1024), 'boot bitmap copy mismatch')
        results.append({'case': 'boot_bitmap', 'magic': f'0x{magic:08x}', 'length': length,
                        'reserved_hex': 'a55a', 'accepted': accepted, 'read_operations': nor.operations,
                        'call': asdict(call)})
    return {'schema_version': 1, 'sample_sha256': StockEmulator(raw).sample_sha256,
            'cpu': 'Unicorn Cortex-M0 instruction execution',
            'functions': {'broadcast_load': '0x0800f020', 'broadcast_save': '0x080101fc', 'boot_bitmap_load': '0x0800fd04'},
            'hardware_replacements': ['0x080195e4 NOR read', '0x08019588 NOR sector erase', '0x080197ec NOR page program'],
            'scope': 'Synthetic 4 MiB NOR. Actual stock loader, saver, memcpy, validation and RMW instructions execute. No receiver, MMIO, USB, BLE, display, RF or physical hardware is modeled.',
            'cases': results, 'passed': len(results)}


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
        print(json.dumps({'output': str(args.output), 'passed': report['passed']}))
    else:
        print(text)


if __name__ == '__main__':
    main()
