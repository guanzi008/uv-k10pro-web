#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Replay APK 68 ARM64 CRC and checksum-branch instructions with synthetic inputs.

Requires the separately obtained official libapp.so and Unicorn. This executes
only the named arithmetic/branch blocks. Dart allocation, typed-list iteration,
the complete frame encoder, Bluetooth, Android and radio hardware are not run.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM
from unicorn.arm64_const import (UC_ARM64_REG_X0, UC_ARM64_REG_X3, UC_ARM64_REG_X5,
                                UC_ARM64_REG_X15, UC_ARM64_REG_X26,
                                UC_ARM64_REG_X29, UC_ARM64_REG_PC)

SAMPLE_SHA256 = 'c2cbc6245093682907109259fa1c888fa1f41c6505a48d113e0b5ca09fd5dabb'
CRC_BYTE_START, CRC_BYTE_END = 0x771c90, 0x771cf4
CRC_FINAL_START, CRC_FINAL_END = 0x771d18, 0x771d2c
FRAME_POINTER = 0x1019000


def independent_crc(data):
    crc = 0xffff
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ (0x8408 if crc & 1 else 0)
    return crc ^ 0xffff


class Blocks:
    def __init__(self, sample):
        if hashlib.sha256(sample).hexdigest() != SAMPLE_SHA256:
            raise ValueError('Expected the inspected APK 1.1.0-68 ARM64 libapp.so')
        # Confirm that these virtual addresses map directly to these file bytes.
        phoff = struct.unpack_from('<Q', sample, 32)[0]
        phsize, phnum = struct.unpack_from('<HH', sample, 54)
        segments = [struct.unpack_from('<IIQQQQQQ', sample, phoff + i * phsize)
                    for i in range(phnum)]
        if not any(p[0] == 1 and p[2] == p[3] and p[3] <= 0x771000 and
                   p[3] + p[5] >= 0x772000 for p in segments):
            raise ValueError('Unexpected ELF virtual/file mapping')
        self.cpu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        self.cpu.mem_map(0x771000, 0x1000)
        self.cpu.mem_write(0x771000, sample[0x771000:0x772000])
        self.cpu.mem_map(0x1000000, 0x20000)
        self.cpu.reg_write(UC_ARM64_REG_X15, 0x1018000)  # Dart stack pointer
        self.cpu.reg_write(UC_ARM64_REG_X26, 0x1001000)  # synthetic Thread
        self.cpu.reg_write(UC_ARM64_REG_X29, FRAME_POINTER)

    def crc(self, data):
        cpu, crc = self.cpu, 0xffff
        for octet in data:
            cpu.mem_write(FRAME_POINTER - 0x10, struct.pack('<Q', crc))
            cpu.reg_write(UC_ARM64_REG_X3, octet)
            cpu.emu_start(CRC_BYTE_START, CRC_BYTE_END, count=1000)
            if cpu.reg_read(UC_ARM64_REG_PC) != CRC_BYTE_END:
                raise AssertionError('CRC byte block did not reach its normal exit')
            crc = cpu.reg_read(UC_ARM64_REG_X5)
        cpu.reg_write(UC_ARM64_REG_X3, crc)
        cpu.emu_start(CRC_FINAL_START, CRC_FINAL_END, count=16)
        if cpu.reg_read(UC_ARM64_REG_PC) != CRC_FINAL_END:
            raise AssertionError('CRC final block did not reach its normal exit')
        return cpu.reg_read(UC_ARM64_REG_X0)

    def accepted(self, received, computed):
        cpu = self.cpu
        cpu.reg_write(UC_ARM64_REG_X3, received)
        cpu.emu_start(0x77187c, 0x7718c0, count=3)
        if cpu.reg_read(UC_ARM64_REG_PC) == 0x7718c0:
            return True, False
        if cpu.reg_read(UC_ARM64_REG_PC) != 0x771888:
            raise AssertionError('Unexpected placeholder comparison branch')
        cpu.mem_write(FRAME_POINTER - 8, struct.pack('<Q', received))
        cpu.reg_write(UC_ARM64_REG_X0, computed)
        cpu.emu_start(0x7718ac, 0x7718c0, count=5)
        result = cpu.reg_read(UC_ARM64_REG_PC)
        if result not in (0x7718c0, 0x771a78):
            raise AssertionError('Unexpected CRC comparison branch')
        return result == 0x7718c0, result == 0x7718c0


def run(sample):
    blocks = Blocks(sample)
    hello = struct.pack('<HHII', 0x2bc, 24, 0x12345678, 1700000000) + bytes(16)
    read = struct.pack('<HHIHHI', 0x2c3, 12, 0x12100, 4, 0, 0x12345678)
    write = (struct.pack('<HHIHHI', 0x2c5, 140, 0x12100, 4, 0, 0x12345678) +
             bytes([1, 2, 3, 4]) + bytes(124))
    ack = bytes.fromhex('c602040000100000')
    inputs = [('empty', b''), ('check-vector', b'123456789'),
              ('all-octets', bytes(range(256))), ('zero-128', bytes(128)),
              ('ones-128', bytes([255]) * 128), ('hello-android', hello),
              ('read-four', read), ('write-four-android-padded', write), ('write-ack', ack),
              ('crc-equals-placeholder', bytes.fromhex('01700200f2ac'))]
    cases, frames, branches = [], [], []
    for name, data in inputs:
        result = blocks.crc(data)
        if result != independent_crc(data):
            raise AssertionError(f'{name}: original instructions differ from reference')
        cases.append({'name': name, 'input_hex': data.hex(), 'crc16_x25': result})
        for received in (0xffff, result, result ^ 1):
            accepted, verified = blocks.accepted(received, result)
            if accepted != (received == 0xffff or received == result):
                raise AssertionError('Stock response checksum decision differs')
            branches.append({'name': name, 'received': received, 'computed': result,
                             'accepted': accepted, 'crc_verified': verified})
        if name in ('hello-android', 'read-four', 'write-four-android-padded', 'write-ack'):
            frame = (bytes.fromhex('abcd') + struct.pack('<H', len(data)) + data +
                     struct.pack('<H', result) + bytes.fromhex('dcba'))
            frames.append({'name': name, 'body_hex': data.hex(), 'frame_hex': frame.hex()})
    return {'schema_version': 1, 'sample_sha256': SAMPLE_SHA256,
            'scope': 'Original ARM64 CRC byte/final arithmetic and response checksum comparison blocks only. Synthetic inputs, stack and Thread. Frame layout is independently assembled from static AOT analysis; complete Dart codecs, Android, BLE and radio hardware are not executed.',
            'code_blocks': {'crc_byte': ['0x771C90', '0x771CF4'],
                            'crc_final': ['0x771D18', '0x771D2C'],
                            'placeholder_branch': ['0x77187C', '0x771888'],
                            'crc_branch': ['0x7718AC', '0x7718C0']},
            'crc_cases': cases, 'checksum_branch_cases': branches,
            'frame_vectors': frames, 'passed': len(cases) + len(branches)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('libapp', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = run(args.libapp.read_bytes())
    text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
        print(json.dumps({'output': str(args.output), 'passed': report['passed']}))
    else:
        print(text)


if __name__ == '__main__':
    main()
