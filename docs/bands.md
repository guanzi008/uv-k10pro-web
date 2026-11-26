# UV-K10 Pro band definitions and channel attributes

This module implements the band data consumed by the **UV-K10 Pro ENG
8.02.16** application. The field map, runtime selection and RX/TX range checks
are supported by CPS static analysis and execution of the corresponding stock
Cortex-M0 instructions against synthetic NOR memory. No physical radio has been
used for acceptance testing.

The implementation is [band-codec.mjs](../src/core/band-codec.mjs). Reproducible
results are in [bands-replay.json](evidence/bands-replay.json), with the optional
[replay script](../tests/reference/replay-bands.py) and independent JavaScript
[comparison tests](../tests/band-codec.test.mjs). The repository contains no
vendor executable, firmware code, full vendor schema or default configuration
image. Every input in the replay report is synthetic.

## Sources and evidence boundary

| Source | Identity | Relevant evidence |
| --- | --- | --- |
| Decoded official application | SHA-256 `061759672cc69a1b00420ce6fae67b0756d3db111f8fa4329cadc940dcd17f17`; mapped at `0x08002000` | Actual band sanitizer, group scanner, loader and classifier instructions |
| UV-K10 Pro CPS 0.56 | SHA-256 `79c9b3429187f7fca13cc8971d0e5fd46184f078127f149f333a267b99815132`; .NET namespace `K7` | Struct fields, UI conversion, group serialization |
| Research helper | [uv-k10pro-firmware](https://github.com/guanzi008/uv-k10pro-firmware), MIT, reference commit `7712063ec4aa046950ac04bd88174bcc7bb4d863` | `tools/emulate_stock.py`, reference image hash check, explicit NOR replacement boundaries |

The emulator uses Unicorn's Cortex-M0 instruction model. SRAM, a synthetic
4 MiB NOR array and an artificial scratch page are test inputs. MMIO remains
unmapped. Only the known NOR read, erase and page-program entry points can be
replaced. The band experiments make reads; no RF chip, display, USB, BLE,
interrupt, startup sequence, target timing or physical flash is simulated.

The full configuration loader also reads unrelated settings. The replay
executes its band prefix from `0x0800F288` and deliberately stops **before
`0x0800F34E`**, after band initialization is complete. The report labels this
boundary explicitly. Other small functions run through their normal returns.
The result is evidence about these data consumers, not a claim that the whole
firmware boots in the emulator.

## Storage map

All multi-byte integers below are little-endian. Frequency words use **10 Hz
units**; the public JavaScript API uses integer Hz.

| NOR location | Size | Meaning |
| --- | ---: | --- |
| `0x19008` | 1 | Custom band mode: `1` selects custom ranges; `0` selects factory ranges. Stock treats values above `1` as `0`. |
| `0x19009` | 1 | Definition selection: `0` is the global definition; `1..8` is a group, subject to the available prefix. |
| `0x19010` | 144 | Global custom definition, seven bands |
| `0x1C000 + i × 0x110` | 272 per slot | Group `i`, zero-based, eight slots |

The CPS hidden-parameter struct is `0xA8` bytes at `0x19000`. Firmware's band
load consumes the first `0xA0`. The first header bytes include unrelated board
and configuration fields, while `0x190A0..0x190A5` contains the BLE address in
the CPS model. The band codec edits only the two selection bytes and the band
fields listed here; it does not rewrite that surrounding struct.

### A 144-byte band definition

These offsets are relative to `0x19010`, or to `group slot + 0x10`:

| Relative offset | Allocation | Meaning |
| --- | ---: | --- |
| `0x00` | 7 bytes | RX enabled flags, one per band |
| `0x07` | 1 byte | Reserved; preserved |
| `0x08` | 7 bytes | TX enabled flags |
| `0x0F` | 1 byte | Reserved; preserved |
| `0x10` | 7 × u32 | RX lower bounds |
| `0x2C` | 4 bytes | Reserved; preserved |
| `0x30` | 7 × u32 | RX upper bounds |
| `0x4C` | 4 bytes | Reserved; preserved |
| `0x50` | 7 × u32 | TX lower bounds |
| `0x6C` | 4 bytes | Reserved; preserved |
| `0x70` | 7 × u32 | TX upper bounds |
| `0x8C` | 4 bytes | Reserved; preserved |

The names and offsets correspond to the CPS `CPS_HIDE_PARAM_INFO` fields
`band_enable`, `band_tx_enable`, `band_rx_start`, `band_rx_end`,
`band_tx_start` and `band_tx_end`. `LockFreq.ConvertData` serializes UI MHz
values by multiplying by `100000`, consistent with 10 Hz words.

### A 272-byte group slot

| Slot offset | Size | Meaning |
| --- | ---: | --- |
| `0x00` | 4 | Enabled magic `0x5A5A9876`; CPS writes `0` when disabled |
| `0x04` | 4 | Reserved; preserved |
| `0x08` | 8 | Group name bytes |
| `0x10` | 144 | Definition above |
| `0xA0` | 112 | Unknown/reserved tail; preserved byte for byte |

CPS `LockFreq.GetData` (`0x0600004C`, RVA `0x351AC`) allocates eight 272-byte
slots and puts a 160-byte struct at the front of each. CPS
`main.ConvertCpsLockFreq` (`0x060003D4`, RVA `0x67D94`) likewise advances by
272 bytes. In contrast, the observed `wfm_progress.CpsReadLockFreq`
(`0x06000509`, RVA `0x80098`) advances by 160 bytes. These are conflicting
behaviors inside this CPS sample. The Web codec follows the stock consumer's
**272-byte** geometry; it does not propagate the 160-byte read-loop stride.

The CPU replay independently confirms that geometry in three places:

- `0x080078E4` reads the four-byte magic at `0x1C000 + i × 272`.
- `0x0800F1B4` reads eight name bytes at `0x1C008 + i × 272`.
- `0x0800F1E8` reads 256 bytes at `0x1C010 + i × 272`: 144 known bytes and the
  112-byte tail. Only the known fields are distributed to runtime band arrays.

The CPS uses Windows `Encoding.Default` for the name. Its exact character set
therefore depends on the host code page. The Web implementation offers an
explicit GB2312 subset, as used for other text fields in this project, and
requires the encoded name to fit in eight bytes. Unrepresentable characters
and oversized names are rejected. Raw imported name bytes remain intact until
the name is edited; decoding does not replace them.

## The available group count is a contiguous prefix

The stock scanner stops at the **first** slot whose magic is not
`0x5A5A9876`. For example, magic flags `[enabled, disabled, enabled, enabled]`
produce an available count of one. Groups after the gap may contain data but
are not selectable by this loader.

The API exposes both `enabled` (the raw magic matches) and `selectable` /
`counted_prefix` (the group falls inside the prefix). `available_count` is
the prefix length. An out-of-prefix selection is normalized to global
selection `0` in RAM; the source NOR byte is not changed by a read.

An explicit group edit therefore requires preceding groups to be enabled
before enabling a later one. Disabling a group while later groups still have
the magic is rejected. The codec never silently reorders groups or toggles
other slots.

## Exact stock normalization

The stock envelope tables at `0x0801E670` and `0x0801E68C` are:

| Index | Inclusive lower MHz | Inclusive upper MHz | TX flag used when its raw byte is invalid |
| ---: | ---: | ---: | --- |
| 0 | 25.000000 | 76.000000 | Enabled |
| 1 | 108.000000 | 135.999900 | Disabled |
| 2 | 136.000000 | 173.999900 | Enabled |
| 3 | 174.000000 | 349.999900 | Disabled |
| 4 | 350.000000 | 399.999900 | Disabled |
| 5 | 400.000000 | 469.999900 | Enabled |
| 6 | 470.000000 | 580.000000 | Disabled |

The upper bounds ending in `.999900` are the actual constants. Do not round
them up to close the following 100 Hz interval. Likewise, the main-radio
band table does not cover the gap above 76 MHz and below 108 MHz. Si4732 /
BK1080 broadcast memories use their separate codec and addressing.

Stock sanitizer `0x08003C20` applies the following rules to each definition:

1. RX flag bytes `0` and `1` survive; bytes above `1` become `1`.
2. TX flag bytes `0` and `1` survive; bytes above `1` become the value in the
   table. The table is a fallback for invalid bytes, not a prohibition on
   an explicitly stored valid flag.
3. A lower bound outside that index's envelope becomes the envelope's lower
   bound; an invalid upper bound becomes the upper bound.
4. If the resulting lower bound is greater than or equal to the upper bound,
   both become their envelope defaults. RX and TX intervals are handled
   separately.
5. All padding bytes survive unchanged.

`sanitizeBandDefinition` models these instructions on a copy. Its `raw` field
is the modeled sanitized result and `changed_offsets` identifies exactly
which definition bytes changed. `decodeBandDefinition` instead describes the
raw bytes. `readVfoBandDefinition` and `readBandGroups` provide `bands` and
`effective_bands` separately so callers can show both imported values and the
runtime interpretation. Reads never normalize the saved image in place.

After a definition is selected, `0x08003AFC` ensures at least one runtime RX
flag equals `1`. If all seven are off, it enables index **5** in RAM. This does
not change the NOR definition. The codec reports the fallback and rejects an
explicit edit that would switch off the last enabled RX band.

## Resolving the actual active plan

The loader prefix first normalizes the global definition, then loads and
normalizes the selected group if its 1-based selection belongs to the available
prefix. It fills intermediate band arrays and applies the all-RX-off fallback.
`0x08011D14` then chooses active ranges:

| Mode byte after normalization | Active RX bounds | Active RX flags | Active TX bounds | Active TX flags |
| --- | --- | --- | --- | --- |
| `1` | Selected definition | Selected definition, with band-5 fallback if needed | Selected definition | Selected definition |
| `0` | Factory envelopes | All seven enabled | Factory envelopes | **Global definition's** normalized TX flags |

The last column for mode `0` is easy to miss. The loader's instructions at
`0x0800F33A..0x0800F34C` copy the global TX flags after the range selector.
A selected group does not supply TX flags in factory mode. The replay case
`factory_selected_group_uses_global_tx` makes the two sets of flags differ
and confirms this behavior.

Changing a custom bound while mode `0` is active changes the saved definition,
but the active bounds remain the factory envelopes until custom mode is
explicitly selected. `patchBandSelection` provides that explicit edit; it
changes only `0x19008` and/or `0x19009` and validates the requested group
against the contiguous prefix.

## Ordinary channel attributes and TX range checks

The low nibble of an ordinary channel attribute records a main-radio band
index. `0x08005808` scans the **active RX bounds** in index order with
inclusive endpoints and returns `0..6`, or `7` for no matching range.
`0x08005FBE` additionally checks the corresponding active RX enabled byte
through `0x08005F18`. Ordinary channel validity at `0x080062DC` checks the
stored attribute's low nibble and that active enabled state.

`deriveChannelAttribute(image, frequencyHz, previousAttribute = 255)` uses
those active conditions. It returns a numeric attribute byte:

- For an empty/deleted `255` attribute, the result is a clean `0..6`.
- For another previous value, the unknown upper nibble is preserved and the
  lower nibble is replaced by the derived index.
- A frequency outside all active ranges throws `RangeError` with
  `code = 'BAND_NO_MATCH'`.
- A frequency matching a disabled RX band throws `RangeError` with
  `code = 'BAND_DISABLED'`.

The codec does not choose a nearby band, close frequency gaps, or restore an
invalid channel by merely assigning a visually plausible index. Existing
attributes are not silently rewritten when a band definition changes; callers
can review affected channels and request explicit edits.

`checkTransmitRange` separately models `0x0800629C`. Stock first classifies
the TX frequency using the **factory** envelope table at `0x08005834`, then
checks that index's active TX bounds and TX flag. The result describes this
software range check. It does not establish physical RF performance, the
transmitter's complete execution path, or regulatory authorization.

## Public API and integration

All image edits return a new `Uint8Array`; input bytes remain unchanged.

| Function | Result / operation |
| --- | --- |
| `readVfoBandDefinition(image)` | Global raw definition, raw and effective rows |
| `readBandGroups(image)` | `{ available_count, groups }`, with group geometry, flags, prefix availability, names, raw/effective rows and preserved tail |
| `resolveActiveBands(image)` | Active plan with `source`, `custom_enabled`, `selected_group`, `available_group_count`, `bands` and `warnings` |
| `classifyReceiveFrequency(image, hz)` | `{ band_index, accepted, reason, source }`; `7` means no matching range |
| `deriveChannelAttribute(image, hz, previous = 255)` | Numeric attribute byte, or the explicit errors above |
| `checkTransmitRange(image, hz)` | `{ allowed, band_index, reason }` for the observed stock range check |
| `patchVfoBandInImage(image, bandIndex, changes)` | Edit known fields of one global row |
| `patchGroupBandInImage(image, groupIndex, bandIndex, changes)` | Edit one row in a 272-byte group slot |
| `patchBandGroupInImage(image, groupIndex, { name, enabled })` | Edit only the group name and/or magic |
| `patchBandSelection(image, { custom_enabled, selected_group })` | Explicit mode and/or definition selection |

Row changes accept `rx_enabled`, `tx_enabled`, `rx_start_hz`, `rx_end_hz`,
`tx_start_hz`, and `tx_end_hz`. Flags accept booleans or integers `0/1`.
Frequencies must be safe integer Hz, exact multiples of 10, inside the
corresponding stock envelope, and survive the stock sanitizer unchanged.
Equal or reversed effective intervals are rejected. Untouched invalid raw
values remain untouched; an edit does not rewrite a whole definition with
defaults.

`selected_group` is `0` for the global definition and `1..8` for groups.
`groupIndex`, `bandIndex` and the result's `group_index` are zero-based.
`resolveActiveBands.source` is `'factory'`, `'vfo'` or `'group'`.
`requested_group` reports the original byte, while `selected_group` reports
the normalized runtime choice. `group_index` is `null` for global selection.

Before deriving a channel attribute, the workspace must have real source
coverage for both exported `BAND_PLAN_COVERAGE` spans:

- `0x19000`, length `0xA0`.
- `0x1C000`, length `0x880` (eight complete slots).

The codec rejects a physically short byte buffer, but a large buffer alone
cannot prove that every byte was actually read from a device or imported from
a complete backup. Coverage belongs to the workspace layer. Missing data must
not be filled with `0xFF` and treated as a known factory plan.

### Exact mutable byte ranges

For write planning, the global known fields are `0x19008 + 2`,
`0x19010 + 7`, `0x19018 + 7`, and four 28-byte arrays beginning at
`0x19020`, `0x19040`, `0x19060`, and `0x19080`.

Within each group slot, the mutable allocations are offsets `0 + 4`,
`8 + 8`, `0x10 + 7`, `0x18 + 7`, and four 28-byte arrays at `0x20`,
`0x40`, `0x60`, and `0x80`. The codec preserves every other byte, including
the 112-byte tail. The session layer still owns device/version checks,
authorization where required, backup, cancellation and mandatory readback;
the pure codec itself does not communicate with a radio.

## Reproduce the evidence

Regular tests need Node and the checked-in synthetic report:

```sh
node --test tests/band-codec.test.mjs
```

To regenerate the report, separately obtain the pinned stock application and
the research helpers with Unicorn installed:

```sh
python3 tests/reference/replay-bands.py /path/to/decoded-8.02.16.bin \
  --research-tools /path/to/uv-k10pro-firmware/tools \
  --output docs/evidence/bands-replay.json
```

The report has **26** top-level experiments: six sanitizer inputs, six group
prefix patterns, first/last group names, and twelve active-plan cases. Those
plan cases execute **1,212** RX/TX boundary probes through the actual stock
classifier functions, including each lower/upper endpoint and its adjacent
10 Hz values, the main-RF gaps, disabled bands, narrowed ranges, invalid mode
and selection bytes, and the all-RX-off fallback.

The JavaScript tests compare every sanitizer output byte, every active band
field and every classifier result against that report. They additionally
check immutable edits, reserved bytes, name limits, group-prefix transitions,
selection-only edits, rejected inputs and attribute high-nibble preservation.
Physical read/edit/write/readback behavior still needs testing with a matching
UV-K10 Pro and its actual transport.
