#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Replay exact stock BFO signed-load, quantization and Si command consumers.

Only receiver CTS polling, receiver command delivery and wall-clock delay are
replaced. The loader and SET_PROPERTY byte construction are actual instructions.
The receiver, RF and audio responses are not simulated or verified.
"""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import struct
import sys


def run(raw, helpers):
    sys.path.insert(0, str(helpers.resolve()))
    from emulate_stock import StockEmulator

    cases = []
    for mode in (2, 3):
        for signed in (-32768, -16383, -16380, -101, -100, -10, -9, -1,
                       0, 1, 9, 10, 100, 101, 16380, 16383, 32767):
            e = StockEmulator(raw)
            e.initialize_data()
            e.write(0x200025a8, b'\x03')
            record = struct.pack('<IBBh', 1420000, mode, 0xa5, signed)
            e.write(0x200025b0, bytes(8) + record)
            e.put_u32(0x200001f8, 180000)
            e.put_u32(0x200001fc, 3000000)
            load = e.call(0x080076ec)
            effective = int(signed / 10) * 10
            actual = struct.unpack('<h', e.read(0x200001ea, 2))[0]
            if actual != effective or load.hardware_hooks != 0:
                raise AssertionError('stock signed BFO quantization mismatch')
            if e.read(0x200025b8, 8) != record:
                raise AssertionError('loading modified the stored VFO record')

            packets = []
            e.hook_function(0x0801a180, lambda emu: 0, name='receiver CTS polling')
            e.hook_function(0x0801a1b8,
                            lambda emu: packets.append(emu.read(emu.reg(0), emu.reg(1)).hex()),
                            name='receiver command capture')
            e.hook_function(0x0801d000, lambda emu: 0, name='wall-clock delay')
            apply = e.call(0x080110bc)
            expected_packet = (bytes.fromhex('12000100') + struct.pack('>h', effective)).hex()
            bfo_packets = [p for p in packets if p.startswith('12000100')]
            if bfo_packets != [expected_packet]:
                raise AssertionError('stock did not forward BFO into SET_PROPERTY 0x0100')
            cases.append({'mode': mode, 'stored_signed': signed, 'stored_word': signed & 0xffff,
                          'effective_signed': effective, 'stored_record_unchanged': True,
                          'bfo_packet_hex': expected_packet, 'packets': packets,
                          'load_call': asdict(load), 'apply_call': asdict(apply)})
    return {'schema_version': 1, 'sample_sha256': StockEmulator(raw).sample_sha256,
            'functions': {'active_record_load': '0x080076EC', 'apply_radio_parameters': '0x080110BC',
                          'bfo_property': '0x0801A028', 'set_property': '0x08019F4C'},
            'scope': 'Synthetic RAM. Original Cortex-M0 instructions execute; receiver CTS, transport and delay are replaced. No physical receiver, RF or audio validation.',
            'property_reference': 'AN332 Rev 0.8a SSB amendment, Property 0x0100, page 23: signed Hz',
            'cases': cases, 'passed': len(cases)}


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
