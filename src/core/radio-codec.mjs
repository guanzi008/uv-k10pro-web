// SPDX-License-Identifier: MIT
// Active UV-K10 Pro CPS serializers, not the unused legacy CpsFmConfigStruct.
import { bytes, exact, span, integer, view, frequencyUnits } from './encoding.mjs';
import { RADIO_BANKS, RADIO_CHIPS, RADIO_HEADER_FIELDS } from './schema.mjs';
export { RADIO_BANKS, RADIO_CHIPS, RADIO_HEADER_FIELDS } from './schema.mjs';

export const RADIO_TRANSFER_REGION = Object.freeze({ offset: 0x12000, length: 0xb10 });
export const RADIO_STATION_SIZE = 8;
export const RADIO_DEMODULATIONS = Object.freeze({ 1: 'AM', 2: 'LSB', 3: 'USB' });

function bankFor(chip, band) {
  if (!Object.hasOwn(RADIO_CHIPS, chip)) throw new RangeError(`Unknown radio chip profile: ${chip}`);
  if (!RADIO_CHIPS[chip].bands.includes(band)) throw new RangeError(`${chip} does not support the ${band} bank`);
  return RADIO_BANKS[band];
}

export function radioStationOffset(chip, band, index) {
  const bank = bankFor(chip, band);
  return bank.offset + 8 + integer(index, 0, bank.count - 1, 'station record index (0 = VFO)') * 8;
}

export function decodeRadioStation(raw, { band = 'fm', index = null } = {}) {
  if (!Object.hasOwn(RADIO_BANKS, band)) throw new RangeError(`Unknown radio band: ${band}`);
  raw = exact(raw, 8, 'radio station record').slice();
  const dv = view(raw);
  const frequency_hz = dv.getUint32(0, true) * 10;
  const limits = RADIO_BANKS[band];
  return { raw, index, is_vfo: index === 0, frequency_hz,
    demodulation: raw[4], mode: band === 'fm' ? 'FM' : RADIO_DEMODULATIONS[raw[4]] ?? 'unknown',
    bfo_raw: dv.getUint16(6, true), reserved: raw[5],
    empty: dv.getUint32(0, true) === 0 || dv.getUint32(0, true) === 0xffffffff,
    in_cps_range: frequency_hz >= limits.min_hz && frequency_hz <= limits.max_hz };
}

export function decodeRadioBank(image, chip, band) {
  const bank = bankFor(chip, band);
  const raw = span(image, bank.offset, bank.length).slice();
  const header = Object.fromEntries(Object.entries(RADIO_HEADER_FIELDS).map(([key, f]) => [key, raw[f.offset]]));
  const stations = Array.from({ length: bank.count }, (_, index) =>
    decodeRadioStation(raw.subarray(8 + index * 8, 16 + index * 8), { band, index }));
  return { chip, band, ...bank, raw, header, stations, vfo: stations[0], presets: stations.slice(1),
    shared_storage: band === 'fm',
    evidence: RADIO_CHIPS[chip].evidence };
}

export function patchRadioStation(image, chip, band, index, changes) {
  const bank = bankFor(chip, band);
  const offset = radioStationOffset(chip, band, index);
  const edited = span(image, offset, 8).slice();
  const dv = view(edited);
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'frequency_hz') {
      const units = frequencyUnits(value);
      // Zero is the CPS serializer's empty-cell value. Reserved byte, mode, BFO
      // and other stations remain unchanged when a slot is cleared.
      if (value !== 0 && (value < bank.min_hz || value > bank.max_hz))
        throw new RangeError(`${band.toUpperCase()} CPS range is ${bank.min_hz}..${bank.max_hz} Hz`);
      dv.setUint32(0, units, true);
    } else if (key === 'demodulation') {
      if (band === 'fm') throw new RangeError('FM broadcast records do not expose AM/SSB demodulation editing');
      edited[4] = integer(value, 1, 3, 'AM / LSB / USB value');
    } else if (key === 'bfo_raw') {
      if (band === 'fm') throw new RangeError('FM broadcast records do not expose BFO editing');
      // CPS stores UInt16 but its display validator mixes signed bounds. Do
      // not invent a signed-Hz contract before a firmware consumer is traced.
      dv.setUint16(6, integer(value, 0, 65535, 'raw BFO word'), true);
    } else throw new RangeError(`Unknown or reserved radio field: ${key}`);
  }
  const output = bytes(image).slice();
  output.set(edited, offset);
  return output;
}

export function patchRadioHeader(image, chip, band, changes) {
  const bank = bankFor(chip, band);
  const edited = span(image, bank.offset, 8).slice();
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(RADIO_HEADER_FIELDS, key)) throw new RangeError(`Unknown radio header field: ${key}`);
    if (chip === 'bk1080' && ['am_step', 'ssb_step', 'am_bandwidth', 'ssb_bandwidth', 'agc'].includes(key))
      throw new RangeError(`${key} has not been verified as an active BK1080 setting`);
    const f = RADIO_HEADER_FIELDS[key];
    edited[f.offset] = integer(value, f.min, key === 'channel_index' ? bank.preset_count - 1 : f.max, key);
  }
  const output = bytes(image).slice();
  output.set(edited, bank.offset);
  return output;
}

export function clearRadioStation(image, chip, band, index) {
  if (index === 0) throw new RangeError('The VFO record is not a deletable preset');
  return patchRadioStation(image, chip, band, index, { frequency_hz: 0 });
}
