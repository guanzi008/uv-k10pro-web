#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Replay normal credential changes against official ARM instructions.

The target image must be supplied separately. Real parser, dispatcher, RMW,
credential reload and AES authentication execute; only the three NOR hardware
operations, transport transmission, UI redraw and delay are stubbed. Inputs
are synthetic passwords from the existing arithmetic reference vectors.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import struct
import sys


def run(raw, vectors):
    from emulate_programming import _new, _run_parser, _attach_transport_capture, SESSION
    from emulate_stock import NorModel
    import programming_protocol as protocol
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    old = next(row for row in vectors if row['password'] == 'test-password')
    new = next(row for row in vectors if row['password'] == '123456')
    cases = []
    definitions = [
        ('set-programming-without-existing-password', None, new, 0x18000, None, 0),
        ('replace-programming-password', old, new, 0x18000, None, 0),
        ('clear-programming-password', old, None, 0x18000, None, 0),
        ('programming-password-with-startup-lock-flag', old, new, 0x18000, None, 1),
        ('set-startup-code', None, None, 0x17000, struct.pack('<I', 123456), 0),
        ('clear-startup-code', None, None, 0x17000, b'\xff' * 4, 0),
        ('startup-write-blocked-by-lock', None, None, 0x17000, struct.pack('<I', 123456), 1),
        ('wrong-current-password-stops-before-write', old, new, 0x18000, None, 0),
    ]
    for name, initial, replacement, address, startup_data, lock in definitions:
        emulator = _new(raw)
        nor = NorModel(); nor.attach(emulator)
        for base, factor in [(0x17000, 13), (0x18000, 17)]:
            nor.data[base:base + 4096] = bytes((index * factor + 7) & 255 for index in range(4096))
        nor.data[0x17000:0x17004] = struct.pack('<I', 654321)
        nor.data[0x18000:0x18010] = bytes.fromhex(initial['keyHex']) if initial else b'\xff' * 16
        # Actual loader: no replacement at 0x0800F288.
        loader = emulator.call(0x0800F288)
        emulator.put_u32(0x200000C0, SESSION)
        emulator.write(0x200000A5, b'\x05')
        emulator.write(0x2000008D, bytes([lock]))
        challenge = bytes(range(16))
        emulator.write(0x200023C0, challenge)
        chunks = []
        _attach_transport_capture(emulator, chunks)
        for function, label in [(0x08006D20, 'programming_UI_noop'),
                                (0x080144B8, 'redraw_UI_noop'), (0x0801D000, 'delay_noop')]:
            emulator.hook_function(function, lambda machine: 0, name=label)
        transactions = []

        def auth_response(key):
            rev = lambda data: b''.join(data[i:i + 4][::-1] for i in range(0, len(data), 4))
            aes = Cipher(algorithms.AES(rev(key)), modes.CBC(bytes(16))).encryptor()
            return rev(aes.update(rev(challenge)) + aes.finalize())

        def transaction(role, body):
            chunks.clear()
            op_start = len(nor.operations)
            frame = protocol.encode_frame(body, transport=1)
            parser, accepted = _run_parser(emulator, frame, 1)
            assert accepted
            dispatcher = emulator.call(0x08003468, (1,))
            reply = protocol.decode_frame(b''.join(chunks), direction='response', transport=1).message
            operations = nor.operations[op_start:]
            transactions.append({'role': role, 'request_command': f'0x{struct.unpack_from("<H", body)[0]:04x}',
                                 'response_command': f'0x{reply.command:04x}',
                                 'parser': asdict(parser), 'dispatcher': asdict(dispatcher),
                                 'nor_reads': sum(op['op'] == 'read' for op in operations),
                                 'nor_erases': sum(op['op'] == 'erase' for op in operations),
                                 'nor_programs': sum(op['op'] == 'program' for op in operations)})
            return reply

        before = bytes(nor.data)
        if initial:
            response = auth_response(bytes.fromhex(initial['keyHex']))
            if name.startswith('wrong-'):
                response = bytes([response[0] ^ 1]) + response[1:]
            reply = transaction('authenticate-current', protocol.Message(0x02D5, response).encode())
            if name.startswith('wrong-'):
                assert reply.payload[0] != 0 and emulator.read(0x200000BB, 1) != b'\0'
                assert bytes(nor.data) == before
                cases.append({'name': name, 'passed': True, 'wrote': False,
                              'normal_authentication_rejected': True, 'all_nor_bytes_unchanged': True,
                              'transactions': transactions})
                continue
            assert reply.payload[0] == 0 and emulator.read(0x200000BB, 1) == b'\0'
        payload = startup_data if address == 0x17000 else bytes.fromhex(replacement['keyHex']) if replacement else b'\xff' * 16
        gate_before = emulator.read(0x200001E0, 1)[0]
        request = protocol.build_write(address, payload, SESSION, flag=0)
        reply = transaction('normal-write-flag-zero', request)
        assert reply.command == protocol.WRITE_REPLY and reply.payload == struct.pack('<I', address)
        guarded = address == 0x17000 and lock == 1
        expected = bytearray(before)
        if not guarded: expected[address:address + len(payload)] = payload
        assert nor.data == expected
        readback = transaction('read-credential-back', protocol.build_read(address, len(payload), SESSION))
        assert readback.payload[8:] == bytes(expected[address:address + len(payload)])
        if address == 0x18000:
            assert emulator.read(0x20002E90, 16) == payload
            assert emulator.read(0x200001E0, 1) == (b'\1' if replacement else b'\0')
            # Same HELLO challenge remains in RAM across the actual reload.
            assert emulator.read(0x200023C0, 16) == challenge
            if replacement:
                reply = transaction('verify-new-normal-password', protocol.Message(0x02D5, auth_response(payload)).encode())
                assert reply.payload[0] == 0 and emulator.read(0x200000BB, 1) == b'\0'
        excluded = bytearray(nor.data)
        excluded[address:address + len(payload)] = before[address:address + len(payload)]
        assert bytes(excluded) == before
        assert not any(address == 0x0800F288 for address in emulator.hooks)
        cases.append({'name': name, 'passed': True, 'address': f'0x{address:x}', 'write_flag': 0,
                      'write_acknowledged': True, 'write_applied': not guarded,
                      'all_neighbors_preserved': True, 'readback_matches_expected': True,
                      'password_valid_before': gate_before,
                      'password_valid_after': emulator.read(0x200001E0, 1)[0],
                      'initial_loader': asdict(loader), 'transactions': transactions})
    return {'schema_version': 1, 'kind': 'stock-ARM-normal-credential-change-with-synthetic-NOR',
            'raw_firmware_sha256': hashlib.sha256(raw).hexdigest(), 'passed_cases': len(cases),
            'executed': ['stock parser and dispatcher', 'stock credential write handler',
                         'stock 0x08019694 RMW', 'stock 0x0800F288 reload',
                         'stock 0x08002E28 normal authentication', 'stock 0x08005F28 AES compare'],
            'hardware_replacements': ['NOR read', 'NOR sector erase', 'NOR page program',
                                      'USB/UART transmit capture', 'UI redraw', 'delay'],
            'reload_function_replaced': False, 'factory_password_supplied': False,
            'physical_device_accessed': False, 'cases': cases,
            'limitations': 'Function-level original ARM execution with synthetic NOR and supplied session/lock state. No boot/power-cycle, physical USB/BLE, actual flash timing or lock-screen interaction is simulated.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--research-tools', type=Path, required=True)
    parser.add_argument('--raw-firmware', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.research_tools))
    vectors = json.loads((Path(__file__).parents[1] / 'fixtures/auth-vectors.json').read_text())['vectors']
    evidence = run(args.raw_firmware.read_bytes(), vectors)
    args.output.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'passed_cases': evidence['passed_cases'], 'output': str(args.output)}))


if __name__ == '__main__':
    main()
