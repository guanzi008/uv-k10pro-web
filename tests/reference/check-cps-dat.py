#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Check the separately supplied official CPS assembly's DAT file path.

Requires dnfile and dncil. Reads metadata/IL without loading a CLR or executing
the vendor application. The official binary is not distributed in this repo.
"""
import argparse
import hashlib
import json
from pathlib import Path

ASSEMBLY_SHA256 = "79c9b3429187f7fca13cc8971d0e5fd46184f078127f149f333a267b99815132"


def check(path):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ASSEMBLY_SHA256:
        raise ValueError("Unsupported assembly; expected UV-K10 Pro CPS 0.56")
    import dnfile
    from dncil.cil.body import CilMethodBody
    from dncil.cil.body.reader import CilMethodBodyReaderBytes

    pe = dnfile.dnPE(data=raw)

    def body(index):
        row = pe.net.mdtables.MethodDef.rows[index - 1]
        return CilMethodBody(CilMethodBodyReaderBytes(pe.get_data(row.Rva))).instructions

    def token(instruction):
        return getattr(instruction.operand, "value", None)

    def calls(index):
        return [token(i) for i in body(index) if i.opcode.name in ("call", "callvirt")]

    def require(value, message):
        if not value:
            raise ValueError(message)

    constructor = body(0x453)
    stores = [n for n, i in enumerate(constructor)
              if i.opcode.name == "stsfld" and token(i) == 0x0400053F]
    require(len(stores) == 1, "CpsData allocation not unique")
    before = constructor[stores[0] - 2:stores[0]]
    require(before[0].opcode.name == "ldc.i4" and before[0].operand == 0xD7000,
            "Default DAT length differs")
    require(before[1].opcode.name == "newarr", "CpsData is not a byte array allocation")
    save_calls = calls(0x3E8)
    require(0x060003EA in save_calls and 0x0A000091 in save_calls,
            "Save does not call GetCpsData and BinaryWriter.Write")
    writer = pe.net.mdtables.MemberRef.rows[0x91 - 1]
    require(str(writer.Name) == "Write" and bytes(writer.Signature.value).hex() == "2001011d05",
            "Writer overload is not void Write(byte[])")
    open_calls = calls(0x40D)
    require(all(t in open_calls for t in (0x0A000095, 0x0A000096, 0x0A000097, 0x060003D0)),
            "Open path does not directly read stream length/data and parse CpsData")
    init = body(0x3E6)
    require(any(i.opcode.name == "ldc.i4" and i.operand == 255 for i in init) and
            any(i.opcode.name == "stelem.i1" for i in init), "FF initialization not found")
    require(0x060003E6 in calls(0x3EA), "GetCpsData does not initialize its array")
    for index in (0x3E8, 0x40B):
        literals = [pe.net.user_strings.get(token(i) & 0xFFFFFF).value
                    for i in body(index) if i.opcode.name == "ldstr"]
        require("(*.dat)|*.dat" in literals, "Native file dialog does not select .dat")
    expected_addresses = {0x3ED: 0x45000, 0x3EC: 0x1C000, 0x3EB: 0x1B000,
                          0x3FF: 0x10000, 0x400: 0x11000, 0x401: 0x12000,
                          0x402: 0x13000, 0x403: 0x14000, 0x404: 0x15000,
                          0x405: 0x16000, 0x3F1: 0x17000, 0x408: 0x19000,
                          0x409: 0x1A000, 0x40A: 0x1A800, 0x407: 0x1E000,
                          0x406: 0x2E000}
    for index, address in expected_addresses.items():
        require(any(i.opcode.name == "ldc.i4" and i.operand == address for i in body(index)),
                f"Destination address missing in method {index:04X}")
    names = {0x453: "static-initializer", 0x3E8: "save-DAT", 0x40B: "open-dialog",
             0x40D: "open-file", 0x3EA: "serialize-config", 0x3E6: "initialize-FF"}
    return {"schema_version": 1, "kind": "static-CPS-native-DAT-path-check",
            "assembly_sha256": ASSEMBLY_SHA256, "container_length": 0xD7000,
            "container_hex_length": "0xD7000", "vendor_code_executed": False,
            "methods": [{"role": role, "token": f"0x{0x06000000 + index:08x}",
                         "rva": f"0x{pe.net.mdtables.MethodDef.rows[index - 1].Rva:08x}"}
                        for index, role in names.items()],
            "config_destination_constants_checked": len(expected_addresses),
            "native_model_signature": None,
            "limitations": "Static file/serialization path checks, not execution in official CPS or device acceptance. Native file bytes do not authenticate the product."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assembly", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = check(args.assembly)
        output = json.dumps(result, indent=2) + "\n"
        if args.output:
            args.output.write_text(output, encoding="utf-8")
            print(json.dumps({"output": str(args.output), "verified": True}))
        else:
            print(output, end="")
    except (OSError, ValueError) as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    main()
