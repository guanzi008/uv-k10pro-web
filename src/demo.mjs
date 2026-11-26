// SPDX-License-Identifier: MIT
// Entirely synthetic values for offline UI demonstration. This is not a factory
// image, band plan, recommended transmit configuration, or captured radio dump.
import { PROFILE, READ_REGIONS } from './core/profile.mjs';
import { MemoryWorkspace } from './core/workspace.mjs';
import { patchChannelInImage, patchVfoInImage, patchScanListInImage } from './core/channel-codec.mjs';
import { patchRadioStation, patchRadioHeader } from './core/radio-codec.mjs';
import { patchSettings, patchContactInImage, patchMessageInImage } from './core/settings-codec.mjs';
import { FACTORY_BAND_ENVELOPES, patchVfoBandInImage } from './core/band-codec.mjs';

export function createDemoWorkspace() {
  let data = new Uint8Array(PROFILE.capacity).fill(255);
  for (const region of READ_REGIONS) data.fill(0, region.address, region.address + region.length);
  data.fill(255, 0x11000, 0x11400);
  for (const envelope of FACTORY_BAND_ENVELOPES) data = patchVfoBandInImage(data, envelope.index, {
    rx_enabled: true, tx_enabled: [0, 2, 5].includes(envelope.index),
    rx_start_hz: envelope.start_hz, rx_end_hz: envelope.end_hz, tx_start_hz: envelope.start_hz, tx_end_hz: envelope.end_hz });
  const names = ['本地守听', '城市中继', '山顶中继', '露营联络', '徒步一组', '徒步二组', '应急守听', '社区联络', '工作一组', '工作二组', '测试频道', 'AM 例子'];
  for (let i = 0; i < names.length; i++) data = patchChannelInImage(data, i, {
    name: names[i], rx_frequency_hz: 145500000 + i * 25000, offset_hz: i === 1 || i === 2 ? 600000 : 0,
    offset_direction: i === 1 || i === 2 ? 2 : 0, power: i % 3, bandwidth: i % 2,
    squelch: 3, step_index: 9, modulation: i === 11 ? 1 : 0, scan_list: i < 6 ? 0 : 1,
    tx_tone: i === 1 ? { kind: 1, value: 885 } : { kind: 0, value: 0 }, rx_tone: { kind: 0, value: 0 },
  }, { attribute: 2 });
  for (let band = 0; band < 7; band++) for (let side = 0; side < 2; side++)
    data = patchVfoInImage(data, band, side, { rx_frequency_hz: 145500000 + side * 25000,
      squelch: 3, step_index: 9, power: 0 }, { attribute: band });
  for (let index = 0; index < 32; index++) data = patchScanListInImage(data, index, {
    name: index === 0 ? '常用列表' : index === 1 ? '备用列表' : '',
    priorities: [index === 0 ? 0 : 0xffff, 0xffff],
    members: index === 0 ? [0, 1, 2, 3, 4, 5] : index === 1 ? [6, 7, 8, 9, 10, 11] : [],
  });
  const frequencies = { fm: [88100000, 92100000, 101700000, 106100000], lw: [200000, 250000], mw: [600000, 1000000], sw: [6000000, 9500000, 11800000] };
  for (const [band, presets] of Object.entries(frequencies)) {
    data = patchRadioHeader(data, 'si4732', band, { mode: 0, channel_index: 0, fm_step: 1, am_step: 0, ssb_step: 0 });
    [presets[0], ...presets].forEach((frequency_hz, index) => {
      data = patchRadioStation(data, 'si4732', band, index,
        { frequency_hz, ...(band === 'fm' ? {} : { demodulation: 1, bfo_raw: 0 }) });
    });
  }
  data = patchSettings(data, { beep: true, backlight_red: 25, backlight_green: 50, backlight_blue: 75,
    welcome_1: 'UV-K10 PRO', welcome_2: 'DEMO', device_name: 'K10 DEMO', ble_name: 'K10 DEMO',
    aprs_own_callsign: 'N0CALL', aprs_target_callsign: 'APRS', aprs_text: 'Synthetic offline demo',
    aprs_latitude: '0000.0000', aprs_longitude: '00000.0000', call_channel: 1 });
  data = patchContactInImage(data, 'dtmf', 0, { name: '演示联系人', code: '12345' });
  data = patchContactInImage(data, 'five_tone', 0, { name: '五音示例', code: '12345' });
  data = patchMessageInImage(data, 0, { text: 'Synthetic offline demo message.' });
  return new MemoryWorkspace({ name: '离线演示 · 合成数据', mode: 'demo', data,
    coverage: READ_REGIONS, provenance: { synthetic: true, source: 'independent demo generator, never a factory image' } });
}
