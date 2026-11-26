#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Replay K8 live protocol dispatch and APRS FCS stripping from stock ARM.

The original firmware is supplied separately and its digest is pinned by the
research helper. Transport delivery, RTC, UI, delay and RF transmission are
explicit boundaries. No radio, RF propagation, BLE chip or GPS is simulated.
"""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import struct
import sys


def run(raw, helpers):
    sys.path.insert(0, str(helpers.resolve()))
    from emulate_stock import StockEmulator, SCRATCH_BASE
    from emulate_programming import _new, _run_parser, _attach_transport_capture, _experiment_frame
    import programming_protocol as p

    cases = []
    # Independently constructed K8 App's simple destination/source/UI/message
    # layout. The firmware executes its own CRC against these content bytes.
    content = bytes.fromhex('82a0a4a64040e09c60868298986103f0') + b':N0TEST   :Hello'
    packet = content + struct.pack('<H', p.crc16_x25(content))

    def base(*, access=0, secondary=0, xor=False):
        e = _new(raw, xor_state=int(xor), state=p.ProgrammingState(0x12345678, access, secondary))
        chunks = []; _attach_transport_capture(e, chunks)
        for address, name in [(0x08006d20, 'UI status boundary'), (0x080144b8, 'UI redraw boundary'),
                              (0x0801d000, 'wall-clock delay boundary')]:
            e.hook_function(address, lambda machine: 0, name=name)
        return e, chunks

    for transport in (0, 1, 2):
        for access, secondary in ((0, 0), (1, 0), (1, 1)):
            e, chunks = base(access=access, secondary=secondary, xor=transport != 2)
            rtc = []; rng_words = iter((0x31415926, 0x27182818, 0x16180339, 0x14142135))
            e.hook_function(0x08019ac8, lambda machine: rtc.append(machine.reg(0)), name='RTC write capture')
            e.hook_function(0x0800220c, lambda machine: next(rng_words), name='deterministic RNG input')
            e.write(0x200023c0, bytes.fromhex('a5' * 16))
            payload = struct.pack('<IIBBBBIIi', 0x12345678, 1735689600, 1, ord('S'), ord('W'), 0,
                                  34567800, 123456700, -17)
            body = p.Message(0x02bc, payload).encode()
            parse, accepted = _run_parser(e, _experiment_frame(body, transport=transport, obfuscated=transport != 2), transport)
            assert accepted
            execution = e.call(0x08003468, (transport,))
            reply = p.decode_frame(b''.join(chunks), direction='response', transport=transport, obfuscated=transport != 2)
            assert reply.message.command == 0x02bd
            assert e.u32(0x200000c0) == 0x12345678 and rtc == [1735689600]
            assert e.read(0x20000164, 1) == b'\x01'
            assert e.read(0x200002e4, 2) == b'SW'
            assert e.u32(0x200002dc) == 34567800 and e.u32(0x200002e0) == 123456700
            assert struct.unpack('<i', e.read(0x200002d8, 4))[0] == -17
            assert e.read(0x200001e0, 1)[0] == access and e.read(0x200000bb, 1)[0] == secondary
            challenge = e.read(0x200023c0, 16)
            assert challenge.hex() == '26594131182818273903181635211414'
            assert reply.message.payload[20:36] == challenge
            cases.append({'kind': 'location-hello', 'transport': transport, 'request_body_hex': body.hex(),
                          'response_frame_hex': b''.join(chunks).hex(), 'rtc_seconds': rtc[0],
                          'latitude_packed': e.u32(0x200002dc), 'longitude_packed': e.u32(0x200002e0),
                          'altitude_signed': -17, 'hemispheres': 'SW', 'access_state': access,
                          'secondary_state': secondary, 'access_flags_unchanged': True,
                          'new_challenge_hex': challenge.hex(), 'execution': asdict(execution),
                          'parser_execution': asdict(parse), 'explicit_hooks': e.events})

    for transport in (0, 1, 2):
        for busy in (False, True):
            e, chunks = base(xor=transport != 2)
            sent = []
            e.hook_function(0x08005574, lambda machine: 0xffffffff if busy else 0, name='explicit RF permission/state boundary')
            e.hook_function(0x0800542c,
                            lambda machine: sent.append({'data_hex': e.read(machine.reg(0), machine.reg(1)).hex(),
                                                         'length': machine.reg(1), 'mode': machine.reg(2)}),
                            name='RF packet capture without transmitting')
            payload = struct.pack('<HH', len(packet), 0) + packet.ljust(128, b'\0')
            body = p.Message(0x02dd, payload).encode()
            parse, accepted = _run_parser(e, _experiment_frame(body, transport=transport, obfuscated=transport != 2), transport)
            assert accepted
            execution = e.call(0x08003468, (transport,))
            reply = p.decode_frame(b''.join(chunks), direction='response', transport=transport, obfuscated=transport != 2)
            assert reply.message.command == 0x02de and len(reply.message.payload) == 4
            assert reply.message.payload[0] == int(busy)
            assert sent == ([] if busy else [{'data_hex': packet.hex(), 'length': len(packet), 'mode': 1}])
            cases.append({'kind': 'aprs-send', 'transport': transport, 'synthetic_gate_rejected': busy,
                          'request_body_hex': body.hex(), 'response_frame_hex': b''.join(chunks).hex(),
                          'result': reply.message.payload[0], 'rf_boundary_calls': sent,
                          'execution': asdict(execution), 'parser_execution': asdict(parse),
                          'explicit_hooks': e.events})

    # Execute the real preliminary gate for the two unconditional rejected
    # states. Their user-facing state names are intentionally not guessed.
    for state in (0, 6):
        e = StockEmulator(raw); e.initialize_data(); e.write(0x200000b3, bytes([state]))
        result = e.call(0x08005574, (1,))
        assert result.r0 == 0xffffffff and result.hardware_hooks == 0
        cases.append({'kind': 'actual-preliminary-TX-gate', 'state_200000b3': state,
                      'result': 'rejected', 'execution': asdict(result)})

    for corrupt in (False, True):
        e, chunks = base()
        raw_packet = bytearray(packet)
        if corrupt:
            raw_packet[-1] ^= 1
        e.write(0x20003724, bytes(raw_packet))
        # Feed the actual HDLC delimiter bit pattern to the stock byte/FCS
        # consumer. This bypasses analog demodulation and nothing else below it.
        e.write(0x20003704, e.read(0x0801eb96, 8))
        e.write(0x2000031e, b'\x08')
        e.write(0x2000032c, struct.pack('<H', len(raw_packet)))
        consumer = e.call(0x0800420c)
        stripped_length = struct.unpack('<H', e.read(0x2000032c, 2))[0]
        ready = e.read(0x20000322, 1)[0]
        assert stripped_length == len(content) and ready == int(not corrupt)
        if ready:
            e.write(0x200023fc, b'\x01'); e.write(0x20000162, b'\x03')
            emitter = e.call(0x08003644, (stripped_length, 0x20003724))
            reply = p.decode_frame(b''.join(chunks), direction='response', transport=2)
            assert reply.message.command == 0x02e1 and len(reply.message.payload) == 132
            assert struct.unpack_from('<H', reply.message.payload)[0] == len(content)
            assert reply.message.payload[4:4 + len(content)] == content
        else:
            emitter = None
        cases.append({'kind': 'aprs-receive-FCS-consumer', 'input_packet_hex': bytes(raw_packet).hex(),
                      'corrupted_FCS': corrupt, 'ready': bool(ready), 'FCS_removed': True,
                      'reported_length_without_FCS': stripped_length, 'response_frame_hex': b''.join(chunks).hex(),
                      'consumer_execution': asdict(consumer),
                      'emitter_execution': asdict(emitter) if emitter else None,
                      'explicit_hooks': e.events})

    for enabled, link_state, count in ((0, 3, 31), (1, 2, 31), (1, 3, 0), (1, 3, 128), (1, 3, 200)):
        e, chunks = base(); e.write(0x200023fc, bytes([enabled])); e.write(0x20000162, bytes([link_state]))
        sample = bytes(range(256)); e.write(SCRATCH_BASE, sample)
        execution = e.call(0x08003644, (count, SCRATCH_BASE))
        emitted = enabled == 1 and link_state == 3
        assert bool(chunks) == emitted
        if emitted:
            reply = p.decode_frame(b''.join(chunks), direction='response', transport=2)
            size = min(count, 128)
            assert reply.message.command == 0x02e1 and len(reply.message.payload) == 132
            assert struct.unpack_from('<H', reply.message.payload)[0] == size
            assert reply.message.payload[4:4 + size] == sample[:size]
        cases.append({'kind': 'aprs-notification-gate-and-length', 'enabled_200023fc': enabled,
                      'link_state_20000162': link_state, 'input_length': count, 'emitted': emitted,
                      'response_frame_hex': b''.join(chunks).hex(), 'execution': asdict(execution), 'explicit_hooks': e.events})
    return {'schema_version': 1, 'sample_sha256': StockEmulator(raw).sample_sha256,
            'scope': 'Exact stock ARM parser/dispatcher/FCS/emitter instructions. Synthetic RAM and explicit hardware boundaries; RF/physical GPS/BLE delivery unverified.',
            'sample_aprs_packet_hex': packet.hex(), 'passed': len(cases), 'cases': cases}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stock_image', type=Path)
    parser.add_argument('--research-tools', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not __debug__:
        parser.error('run without -O')
    result = run(args.stock_image.read_bytes(), args.research_tools)
    report = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(report)
        print(json.dumps({'output': str(args.output), 'passed': result['passed']}))
    else:
        print(report)


if __name__ == '__main__':
    main()
