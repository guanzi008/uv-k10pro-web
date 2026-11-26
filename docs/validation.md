# Validation record · 2026-11-26

This record describes evidence for the `0.2.0` Web workbench. It does
not claim that a physical UV-K10 Pro has been connected or that the complete
official firmware boots in a board emulator.

## Automated application checks

Executed from the repository with Node.js 24.22.3; CI uses Node.js 22:

```sh
npm ci
npm test
npm run check
npm run build
```

Result before publication: **179 tests passed, 0 failed, 0 skipped**. The module
syntax/import/distribution checks and static build also passed. CI repeats the
same commands on the submitted commit; its result is available from the
[repository Actions page](https://github.com/guanzi008/uv-k10pro-web/actions).

| Layer | What was exercised |
|---|---|
| Channel and settings codecs | Exact integer units, GB2312/ASCII/UTF-8 distinctions, unknown/reserved byte preservation, invalid enum handling, VFO attributes, scan sentinels, APRS bit packing, contacts/messages and bitmap pages |
| Broadcast codecs | Four Si4732 banks, FM-only BK1080, common FM bytes, VFO record zero, preset boundaries and preservation of BFO/reserved data |
| Bands | Stock sanitizer and activity rules, group prefix/stride, factory/custom selection, RX/TX boundary classifications, exact field patches, protected padding and high-nibble attributes |
| File workflows | Sparse project hash/coverage validation, no imported session authority, MCU firmware rejection, complete versus partial NOR, strict CSV structure/encoding/mode distinctions and safe overlays |
| Protocol | Stock-derived frame fixtures, CRC/XOR and legacy length declarations, fragmentation, corruption, serialization, timeouts/cancellation, authentication, ACK without mutation, zero-gated responses and sector preservation |
| Write orchestration | All preflight reads before mutation, persisted-backup failure stops writes, stale baseline detection, per-block verified progress, uncertain outcomes and recovery journal |
| Browser adapters | Fake Web Serial/WebUSB/Web Bluetooth API boundaries, exact settings/descriptors, supplied BLE UUIDs, transfer errors and stream/device cleanup |
| Real application in JSDOM | Empty startup, synthetic demo, channel/VFO edits, shared FM views, settings, custom bands and automatic attribute changes, scans, contacts, messages, exports, concrete diffs and offline write refusal |
| UI contracts | Explicit model confirmation, no password retention/error echo, semantic action fields and correct HTML Boolean select behavior |
| Channel tools and history | Overlapping copy/cut/paste, stale cut refusal, stable sorting, raw-slot scan remapping with holes/sentinels, atomic batch generation and undo/redo write boundaries |
| Native CPS DAT | Exact 880,640-byte container, 17-region coverage, opaque SHA-256 envelope, DAT → project → DAT preservation, incomplete export refusal and live overlay protection |
| Normal credential changes | Current-password reauthentication, startup lock refusal, dedicated flag-0 writes, readback/canary and new-password verification, automatic session closure without credential logs |
| K8 Bluetooth | FF12/FFF2/FFF3 model profile, actual property verification, whole-frame/chunked strategies, 120 ms pacing, mixed CRC/placeholder response decoding, CPS versus Android length conventions and profile files |
| Live APRS/session | AX.25/FCS vectors, K8 text/path rules, fixed command payloads, passive events interleaved with replies, changed challenge after location sync, explicit authentication reset, 10-second single-attempt timeout and cancellation |
| New DOM flows | Native DAT export, copy/paste/batch/generation/history, signed BFO, credential clearing/redaction, BLE discovery choices, APRS preview invalidation, escaped receive text, one-shot location and late-result cancellation |

The DOM regression exposed and fixed a real bug where `selected="false"` still
selected an option. The test now checks that editing a channel name preserves
its FM modulation. It also edits a channel from 145 MHz to 430 MHz using the
loaded band plan and verifies the resulting attribute is band 5.

## Independent stock instruction evidence

| Experiment | Result | Evidence |
|---|---:|---|
| Broadcast load/save and startup bitmap validation | 24 cases passed | [radio-replay.json](evidence/radio-replay.json) |
| Band sanitizer, group scanning/loading and active mode | 26 cases passed | [bands-replay.json](evidence/bands-replay.json) |
| Actual RX/TX classifier instructions at boundaries | 1,212 probes matched | Same band report, compared by `band-codec.test.mjs` |
| Normal password native MAC plus stock AES/authentication | 6 input vectors; correct accepted, one-bit error rejected | [auth-vectors.json](../tests/fixtures/auth-vectors.json), [protocol evidence](protocol.md) |
| Signed BFO consumer and actual receiver property packing | 34 cases passed | [bfo-replay.json](evidence/bfo-replay.json), [BFO](bfo.md) |
| Normal credential set/change/clear and startup lock behavior | 8 cases passed, including the unhooked credential reload function | [credentials-replay.json](evidence/credentials-replay.json), [credentials](credentials.md) |
| Location HELLO, APRS TX gate/FCS and RX notification behavior | 24 cases passed | [live-replay.json](evidence/live-replay.json), [live functions](live-functions.md) |
| APK ARM64 CRC arithmetic and CRC/FFFF decision branches | 10 CRC vectors and 30 decoding branch cases passed | [ble-crc-replay.json](evidence/ble-crc-replay.json); function/block emulation, not full App execution |
| APK64/68 model-specific BLE profile and native CPS DAT | Static call/data flow and actual IL assertions | [ble-aot-profile.json](evidence/ble-aot-profile.json), [cps-dat.json](evidence/cps-dat.json) |

The reference firmware SHA-256 is
`061759672cc69a1b00420ce6fae67b0756d3db111f8fa4329cadc940dcd17f17`.
The native authentication DLL SHA-256 is
`61a2cef101c4325a622d163edffa35f17c82b33cf4ed3847bd4eaa9a1920581d`.
Vendor binaries are external inputs, not repository contents.

NOR access is replaced by an explicit memory model at the known hardware
boundaries. The native MAC runs in an x86 instruction emulator with only the
required memory-copy hook; no DLL entry point or Windows application is run.
The authentication checks run the ordinary configured-password path, without
engineering or alternate credentials. Function-level and prefix-stop boundaries
are recorded in the protocol/band/radio documents.

## Remaining acceptance boundaries

No physical serial/USB/BLE transfer, flash cycle, RF reception/transmission,
audio path or LCD panel result has been measured in this turn. Browser adapter
tests use fake APIs; the stock experiments do not model an entire board.

The local HTTP server was started successfully. The available cloud browser
does not share the executor's localhost and reported connection refused for
that URL. Consequently this turn does not include an actual browser visual
layout, mobile viewport or Canvas-painting acceptance result. JSDOM validates
events and DOM behavior, not pixel rendering or browser device permission UI.

The K10/K8 GATT binding has been recovered from both APK64 and APK68 AOT call
paths. This resolves model ownership; it does not validate a physical browser
BLE connection. Whole-frame GATT long writes and real notifications remain
device/browser acceptance items. [ble-profile.md](ble-profile.md) distinguishes
the recovered profile, exact sample provenance and hardware boundaries.

The complete recovered K8 ordinary programming scope is enumerated in
[feature-coverage.md](feature-coverage.md). App/cloud account services, firmware
upgrading, calibration/factory operations and unsupported residual schema types
are not silently treated as ordinary channel programming features.
