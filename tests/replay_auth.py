#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Optional evidence generator: bounded x86 function replay, not Windows DLL execution.

Supply the exact vendor samples yourself. No sample bytes are bundled. Only the
two exported arithmetic functions execute in Unicorn; DllMain is not called.
An explicit memcpy hook replaces the sole external call. No OS API, network,
file operation, hardware, or executable host mapping is available to the guest.
Optional ARM checks use the existing research repo's controlled StockEmulator.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import dnfile
import pefile
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_PROT_ALL
from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_EIP, UC_X86_REG_EAX
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

DLL_SHA = '61a2cef101c4325a622d163edffa35f17c82b33cf4ed3847bd4eaa9a1920581d'
CPS_SHA = '79c9b3429187f7fca13cc8971d0e5fd46184f078127f149f333a267b99815132'
SENTINEL = 0x40000000
SECRET = 0x30000000
INPUT = 0x30001000
OUTPUT = 0x30002000

def reverse_words(data):
    assert len(data) % 4 == 0
    return b''.join(data[i:i+4][::-1] for i in range(0, len(data), 4))

class NativeArithmetic:
    def __init__(self, dll):
        raw = Path(dll).read_bytes()
        if hashlib.sha256(raw).hexdigest() != DLL_SHA:
            raise ValueError('Unsupported native arithmetic sample')
        pe = pefile.PE(data=raw)
        self.uc = Uc(UC_ARCH_X86, UC_MODE_32)
        self.uc.mem_map(0x10000000, 0x6000, UC_PROT_ALL)
        self.uc.mem_write(0x10000000, pe.get_memory_mapped_image())
        self.uc.mem_map(0x20000000, 0x20000)
        self.uc.mem_map(0x30000000, 0x10000)
        self.uc.mem_map(SENTINEL, 0x1000)
        self.uc.hook_add(UC_HOOK_CODE, self.hook)
        self.instructions = 0
        self.memcpy_calls = 0
        self.returned = False

    def hook(self, uc, address, size, _):
        self.instructions += 1
        if address == SENTINEL:
            self.returned = True
            uc.emu_stop()
        elif address == 0x10001e6e:
            # Explicit cdecl memcpy stub: no imported CRT function is executed.
            sp = uc.reg_read(UC_X86_REG_ESP)
            ret, dest, source, count = struct.unpack('<4I', uc.mem_read(sp, 16))
            if count > 4096:
                raise ValueError('Unexpected memcpy size')
            for ptr in (dest, source):
                if not (0x10000000 <= ptr <= 0x10006000 - count or
                        0x20000000 <= ptr <= 0x20020000 - count or
                        0x30000000 <= ptr <= 0x30010000 - count):
                    raise ValueError('memcpy outside explicit guest mappings')
            uc.mem_write(dest, bytes(uc.mem_read(source, count)))
            uc.reg_write(UC_X86_REG_EAX, dest)
            uc.reg_write(UC_X86_REG_ESP, sp + 4)
            uc.reg_write(UC_X86_REG_EIP, ret)
            self.memcpy_calls += 1
        elif not 0x10001000 <= address < 0x100015e7:
            raise ValueError(f'Execution left the audited arithmetic functions: {address:x}')

    def call(self, address, *args):
        sp = 0x2001f000
        self.uc.mem_write(sp, struct.pack('<' + 'I' * (len(args) + 1), SENTINEL, *args))
        self.uc.reg_write(UC_X86_REG_ESP, sp)
        self.returned = False
        self.uc.emu_start(address, SENTINEL + 1, timeout=5_000_000, count=1_000_000)
        if not self.returned:
            raise ValueError('Native arithmetic did not return within its budget')

    def compute(self, secret, password):
        password_bytes = password.strip().encode('utf-8')
        if len(password_bytes) > 32:
            raise ValueError('CPS password buffer is 32 bytes')
        data = bytearray(b'Z' * 128)
        data[:32] = password_bytes.ljust(32, b'\0')
        data[32:40] = b'xiaoxiao'
        self.uc.mem_write(SECRET, secret)
        self.uc.mem_write(INPUT, bytes(data))
        self.uc.mem_write(OUTPUT, bytes(32))
        self.call(0x10001000, SECRET)
        before = self.instructions
        self.call(0x10001030, INPUT, 119, OUTPUT)
        return bytes(self.uc.mem_read(OUTPUT, 32)), self.instructions - before

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dll', type=Path, required=True)
    parser.add_argument('--cps', type=Path, required=True)
    parser.add_argument('--research-tools', type=Path)
    parser.add_argument('--raw-firmware', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    cps = args.cps.read_bytes()
    if hashlib.sha256(cps).hexdigest() != CPS_SHA:
        raise ValueError('Unsupported CPS sample')
    pe = dnfile.dnPE(data=cps)
    rows = [row for row in pe.net.mdtables.FieldRva.rows if row.Field.row_index == 0x904]
    if len(rows) != 1 or rows[0].Rva != 0x42c08:
        raise ValueError('CPS protocol constant locator changed')
    secret = pe.get_data(rows[0].Rva, 32)
    native = NativeArithmetic(args.dll)
    vectors = []
    for password in ['', 'test-password', '123456', ' abc ', '测试', '0123456789abcdefghijklmnopqrstuv']:
        digest, instructions = native.compute(secret, password)
        key = bytes(digest[i] ^ digest[31-i] for i in range(16))
        challenge = hashlib.sha256(('synthetic challenge:' + password).encode()).digest()[:16]
        encryptor = Cipher(algorithms.AES(reverse_words(key)), modes.CBC(bytes(16))).encryptor()
        cipher = encryptor.update(reverse_words(challenge)) + encryptor.finalize()
        response = reverse_words(cipher)
        row = {'password': password, 'challengeHex': challenge.hex(), 'digestHex': digest.hex(),
               'keyHex': key.hex(), 'responseHex': response.hex(), 'nativeInstructions': instructions}
        if args.research_tools and args.raw_firmware:
            sys.path.insert(0, str(args.research_tools))
            from emulate_stock import StockEmulator
            emu = StockEmulator(args.raw_firmware.read_bytes())
            emu.initialize_data()
            emu.write(0x21000000, key)
            emu.write(0x21000100, challenge)
            emu.write(0x21000200, response)
            positive = emu.call(0x08005f28, (0x21000000, 0x21000100, 0x21000200))
            wrong = bytearray(response); wrong[0] ^= 1
            emu.write(0x21000200, bytes(wrong))
            negative = emu.call(0x08005f28, (0x21000000, 0x21000100, 0x21000200))
            if positive.r0 != 0 or negative.r0 != 1:
                raise ValueError('Stock AES compare did not confirm synthetic vector')
            row['stockCompare'] = {'valid': positive.r0, 'corrupt': negative.r0,
                'validInstructions': positive.instructions, 'hardwareHooks': positive.hardware_hooks + negative.hardware_hooks}
            # Test only the normal configured-password branch. No fallback/engineer key is provided.
            emu.write(0x200001e0, b'\1')
            emu.write(0x200000bb, b'\1')
            emu.write(0x200000bc, b'\0')
            emu.write(0x20002e90, key)
            emu.write(0x200023c0, challenge)
            emu.write(0x21000300, struct.pack('<HH', 0x02d5, 16) + response)
            replies = []
            def sender(e):
                replies.append(e.read(e.reg(1), e.reg(2)).hex())
                return 0
            emu.hook_function(0x0800361c, sender, name='capture_response_no_transport_io')
            accepted = emu.call(0x08002e28, (1, 0x21000300))
            if emu.read(0x200000bb, 1) != b'\0' or not replies or bytes.fromhex(replies[-1])[4] != 0:
                raise ValueError('Normal configured-password branch did not accept response')
            row['stockNormalAuth'] = {'replyBodyHex': replies[-1], 'secondaryGate': 0,
                                      'instructions': accepted.instructions, 'hardwareHooks': accepted.hardware_hooks}
        vectors.append(row)
    evidence = {'kind': 'synthetic-password-arithmetic-vectors', 'dllSha256': DLL_SHA, 'cpsSha256': CPS_SHA,
                'rawFirmwareSha256': hashlib.sha256(args.raw_firmware.read_bytes()).hexdigest() if args.raw_firmware else None,
                'hostVendorExecution': False, 'dllMainCalled': False, 'nativeExternalHooks': ['memcpy'],
                'nativeMemcpyCalls': native.memcpy_calls, 'vectors': vectors}
    args.output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'vectors': len(vectors), 'allStockCompared': all('stockCompare' in v for v in vectors), 'output': str(args.output)}))

if __name__ == '__main__':
    main()
