# Validation record · 2026-11-26

This record describes evidence for the initial `0.1.0` Web workbench. It does
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

Result before publication: **100 tests passed, 0 failed, 0 skipped**. The module
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

BLE remains a configurable experimental adapter pending a model-specific GATT
binding; [ble-profile.md](ble-profile.md) records exactly what is missing and
how a read-only official App session can supply the needed evidence.
