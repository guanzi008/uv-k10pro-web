// SPDX-License-Identifier: MIT
// Independently described K8 / UV-K10 Pro storage facts. This is not a copy of
// the vendor's JSON. Each field names the evidence and stores original bytes.
export { CHANNEL_ENUMS, CHANNEL_FIELDS, STEP_HZ } from './channel-codec.mjs';

export const MODEL = Object.freeze({ id: 'UV-K10-PRO-K8', protocol: 'K8', product: 'UV-K10 Pro',
  reference_firmware: '8.02.16', flash_bytes: 4 * 1024 * 1024 });
export const RADIO_BANKS = Object.freeze({
  fm: { band: 'fm', label: 'FM', offset: 0x12100, count: 33, preset_count: 32, length: 272, min_hz: 76000000, max_hz: 108000000 },
  lw: { band: 'lw', label: 'LW', offset: 0x12300, count: 33, preset_count: 32, length: 272, min_hz: 150000, max_hz: 520000 },
  mw: { band: 'mw', label: 'MW', offset: 0x12500, count: 33, preset_count: 32, length: 272, min_hz: 520000, max_hz: 1800000 },
  sw: { band: 'sw', label: 'SW', offset: 0x12700, count: 129, preset_count: 128, length: 1040, min_hz: 1800000, max_hz: 30000000 },
});
export const RADIO_CHIPS = Object.freeze({
  si4732: { id: 'si4732', label: 'Si4732', bands: ['fm', 'lw', 'mw', 'sw'],
    evidence: 'CPS active FM/LW/MW/SW serializers; no physical device validation' },
  bk1080: { id: 'bk1080', label: 'BK1080', bands: ['fm'],
    evidence: 'CPS BK1080 UI uses the same active FM serializer; FM only; no physical device validation' },
});
export const RADIO_HEADER_FIELDS = Object.freeze({
  mode: { offset: 0, min: 0, max: 1, options: ['VFO', 'CHANNEL'] },
  channel_index: { offset: 1, min: 0, max: 127 },
  agc: { offset: 2, min: 0, max: 37 },
  fm_step: { offset: 3, min: 0, max: 2, hz: [50000, 100000, 200000] },
  am_step: { offset: 4, min: 0, max: 2, hz: [1000, 5000, 10000] },
  ssb_step: { offset: 5, min: 0, max: 2, hz: [1000, 5000, 10000] },
  am_bandwidth: { offset: 6, min: 0, max: 6, hz: [6000, 4000, 3000, 2000, 1000, 1800, 2500] },
  ssb_bandwidth: { offset: 7, min: 0, max: 5, hz: [1200, 2200, 3000, 4000, 500, 1000] },
});

const fields = [];
const limits = { u8: [0, 255], u16: [0, 65535], i16: [-32768, 32767], u32: [0, 0xffffffff], i32: [-0x80000000, 0x7fffffff], bool: [0, 1], bit: [0, 1] };
function field(id, label, group, offset, type = 'u8', extra = {}) {
  const bounds = limits[type] ?? [undefined, undefined];
  const f = { id, label, group, offset, type, min: bounds[0], max: bounds[1],
    length: /^(?:u|i)32$/.test(type) ? 4 : /^(?:u|i)16$/.test(type) ? 2 : 1,
    writable: true, evidence: 'K8 APK + CPS static layout', ...extra };
  fields.push(Object.freeze(f));
}
const opts = labels => labels.map((label, value) => ({ value, label }));
const onoff = opts(['关闭', '开启']);
const general = (id, label, off, type = 'u8', extra = {}) => field(id, label, 'general', 0x13000 + off, type, extra);

general('main_channel', '主信道', 0, 'u8', { max: 1, options: opts(['A', 'B']) });
general('noaa_squelch', 'NOAA 静噪', 1, 'u8', { max: 9 });
general('tx_timeout_index', '发射限时选项', 2, 'u8', { raw: true, help: 'CPS 枚举索引；未将原始值当作秒数。' });
general('noaa_search', 'NOAA 搜索', 3, 'u8', { max: 1, options: opts(['手动', '自动']) });
general('key_lock', '按键锁选项', 4, 'u8', { raw: true });
general('vox_enabled', 'VOX 开关', 5, 'bool', { options: onoff });
general('vox_level', 'VOX 等级索引', 6, 'u8', { max: 9 });
general('microphone', '麦克风设置索引', 7, 'u8', { raw: true });
general('vfo_mode', 'VFO 模式', 8, 'bool', { options: onoff });
general('channel_display', '信道显示索引', 9, 'u8', { max: 3, raw: true, help: '64 包有 3 项、68 包有 4 项，保留版本差异。' });
general('power_save', '省电选项', 0x0b, 'u8', { raw: true });
general('dual_watch', '双守候', 0x0c, 'bool', { options: onoff });
general('backlight_timeout', '自动背光选项', 0x0d, 'u8', { raw: true });
general('call_channel', '即呼信道编号', 0x0e, 'u16', { min: 1, max: 999, display_add: 1 });
general('beep', '按键提示音', 0x10, 'bool', { options: onoff });
for (const [id, label, off] of [['side1_short', '侧键 1 短按', 0x11], ['side1_long', '侧键 1 长按', 0x12], ['side2_short', '侧键 2 短按', 0x13], ['side2_long', '侧键 2 长按', 0x14], ['side3_short', '侧键 3 短按', 0x2e], ['side3_long', '侧键 3 长按', 0x2f]])
  field(id, `${label}（功能索引）`, 'keys', 0x13000 + off, 'u8', { raw: true, help: 'K8 侧键字段；不借用其他型号枚举。' });
for (const [id, label, off] of [['scan_resume', '扫描恢复', 0x15], ['auto_lock', '自动锁', 0x16], ['startup_display', '开机界面', 0x17], ['alarm_mode', '报警模式', 0x18], ['repeater_tail', '中继尾音', 0x1a], ['radio_work_mode', '收音机工作模式', 0x20], ['language', '语言', 0x23], ['signaling_sidetone', '信令侧音', 0x2b], ['decode_response', '信令解码响应', 0x2c]])
  general(id, `${label}索引`, off, 'u8', { raw: true });
general('end_talk', '通话结束提示索引', 0x19, 'u8', { max: 2, raw: true, help: '不能以 bool 归一化；68 包有第三个选项。' });
for (const [id, label, off] of [['tail_elimination', '尾音消除', 0x1b], ['bluetooth', '蓝牙', 0x1c], ['call_permission_tone', '呼叫许可音', 0x1d], ['backlight_tx_rx', '背光收发提示', 0x21], ['gps', 'GPS', 0x27], ['sbar', 'S 表', 0x28], ['remote_kill_enabled', '遥毙接收开关', 0x2a]])
  general(id, label, off, 'bool', { options: onoff });
general('time_zone_index', '时区选项索引', 0x1e, 'i16', { raw: true, min: 0, help: 'CPS Int16 保存选项索引；不是 UTC 分钟偏移。' });
for (const [id, label, off] of [['backlight_red', '背光红色亮度', 0x24], ['backlight_green', '背光绿色亮度', 0x25], ['backlight_blue', '背光蓝色亮度', 0x26]])
  field(id, label, 'display', 0x13000 + off, 'u8', { max: 100, evidence: 'stock CPU load + PWM paths replayed' });
general('screen_reset_raw', '界面复位原始值', 0x29, 'u8', { raw: true, help: 'CPS 读取时减 8，再查枚举；保留原始存储值。' });
general('frequency_match_timeout', '对频超时原始值', 0x2d, 'u8', { min: 8, max: 32, raw: true });
general('fm_range_index', 'FM 分段选项', 0x30, 'u8', { max: 1, options: opts(['76–88 MHz', '88–108 MHz']) });
general('cw_pitch_raw', 'CW 频偏原始值', 0x32, 'u16', { raw: true });
for (const [id, label, offset] of [['welcome_1', '开机文字 1', 0x130f8], ['welcome_2', '开机文字 2', 0x13108], ['ble_name', '蓝牙名称', 0x13118], ['device_name', '设备名称', 0x14060]])
  field(id, label, 'display', offset, 'text', { length: 16, encoding: 'gb2312' });
field('display_a_raw', 'A 区显示选择原始索引', 'display', 0x15000, 'u16', { raw: true });
field('display_b_raw', 'B 区显示选择原始索引', 'display', 0x15002, 'u16', { raw: true });
field('radio_band', '收音机当前频段', 'radio', 0x12000, 'u8', { max: 3, options: opts(['FM', 'LW', 'MW', 'SW']), evidence: 'CPS main.GetFmParam 06000401' });

// CPS proves these are byte arrays containing ASCII, not UInt16 code values.
for (const [prefix, group, idOff, separatorOff, groupOff, resetOff, carryOff, firstOff, singleOff, gapOff, upOff, downOff] of [
  ['dtmf', 'dtmf', 0x78, 0x40, 0x60, 0x64, 0x68, 0x6c, 0x70, 0x74, 0x88, 0xa8],
  ['five_tone', 'five_tone', 0x80, 0x50, 0x62, 0x65, 0x6a, 0x6e, 0x72, 0x76, 0x98, 0xb8],
]) {
  for (const [suffix, label, off, length] of [['id', '本机 ID', idOff, 8], ['separator', prefix === 'dtmf' ? '分隔符' : '重复音', separatorOff, 2], ['group_code', '组码', groupOff, 2], ['up_code', '上线码', upOff, 16], ['down_code', '下线码', downOff, 16]])
    field(`${prefix}_${suffix}`, label, group, 0x13000 + off, 'text', { length, encoding: 'ascii', pattern: prefix === 'dtmf' ? '^[0-9A-D*#]*$' : '^[0-9A-E]*$', evidence: 'CPS_GEN_INFO fixed arrays + converters 06000032/33' });
  field(`${prefix}_reset_raw`, '自动复位原始计数', group, 0x13000 + resetOff, 'u8', { max: 60, raw: true });
  for (const [suffix, label, off] of [['precarrier_raw', '预载波原始计数', carryOff], ['first_code_raw', '首码持续原始计数', firstOff], ['single_code_raw', '单码持续原始计数', singleOff], ['gap_raw', '码间隔原始计数', gapOff]])
    field(`${prefix}_${suffix}`, label, group, 0x13000 + off, 'u16', { min: 30, max: 1000, raw: true });
}
field('dtmf_star_hash_raw', '* / # 持续原始计数', 'dtmf', 0x13042, 'u16', { min: 30, max: 1000, raw: true });
field('five_tone_protocol', '5TONE 协议索引', 'five_tone', 0x13052, 'u8', { raw: true });
for (let i = 0; i < 15; i++) field(`five_tone_frequency_${i}`, `自定义音频 ${i + 1} 原始值`, 'five_tone', 0x130d8 + i * 2, 'u16', { raw: true, evidence: 'CPS_GEN_INFO._5tone_user_freq fixed UInt16[15]; APK exposes only first 14' });
for (const [prefix, off] of [['dtmf', 0x14030], ['five_tone', 0x14038]]) {
  field(`${prefix}_kill_code`, '遥毙码', prefix, off, 'text', { length: 8, encoding: 'ascii', pattern: '^[0-9A-E*#]*$' });
  field(`${prefix}_wake_code`, '唤醒码', prefix, off + 0x10, 'text', { length: 8, encoding: 'ascii', pattern: '^[0-9A-E*#]*$' });
}

const aprs = (id, label, off, type = 'u8', extra = {}) => field(`aprs_${id}`, label, 'aprs', 0x1e000 + off, type,
  { evidence: 'CPS_APRS_Config Pack=1 + converters 06000018/19', ...extra });
aprs('tx_interval', '发送间隔原始值', 3, 'u8', { max: 60, raw: true, help: 'CPS 字段为 1 字节；修复 APK 声明 2 字节与 ACK 重叠的问题。' });
aprs('ack', 'ACK', 4, 'bool', { options: onoff });
aprs('beacon_source', '信标来源索引', 5, 'u8', { raw: true });
aprs('icon', '图标索引', 6, 'u8', { raw: true });
for (const [bit, id, label] of [[0,'position','位置'],[1,'mic_e','Mic-E'],[2,'object','对象'],[3,'item','项目'],[4,'message','消息'],[5,'weather','气象'],[6,'nmea','NMEA'],[7,'status','状态']])
  aprs(`filter_${id}`, `${label}过滤`, 7, 'bit', { bit, options: onoff });
aprs('sidetone', '测试音 / 侧音', 8, 'bool', { options: onoff });
aprs('bandwidth', '带宽', 9, 'u8', { max: 1, options: opts(['宽', '窄']) });
aprs('tone_type', '亚音类型', 0x0a, 'u8', { max: 3, options: opts(['无', 'CTCSS', 'DCS-N', 'DCS-I']) });
aprs('power', '功率索引', 0x0b, 'u8', { max: 2, options: opts(['低', '高', 'TURBO']) });
aprs('precarrier_raw', '预载波原始计数', 0x0c, 'u16', { min: 30, max: 1000, raw: true });
aprs('own_ssid', '本机 SSID', 0x0e, 'u8', { max: 15 });
aprs('target_ssid', '目标 SSID', 0x0f, 'u8', { max: 15 });
aprs('tone_value', '亚音原始值', 0x10, 'u32', { raw: true });
aprs('altitude_raw', '固定高度原始值', 0x14, 'i32', { min: 0, max: 999999, raw: true });
aprs('latitude', '固定纬度 ddmm.mmmm', 0x18, 'coordinate', { length: 4, max_degrees: 90 });
aprs('longitude', '固定经度 dddmm.mmmm', 0x1c, 'coordinate', { length: 4, max_degrees: 180 });
aprs('latitude_hemisphere', '南北纬索引', 0x20, 'u8', { max: 1, raw: true });
aprs('longitude_hemisphere', '东西经索引', 0x21, 'u8', { max: 1, raw: true });
aprs('timed_tx_raw', '定时发送原始计数', 0x22, 'u16', { raw: true });
aprs('beacon_format', '信标格式索引', 0x24, 'u8', { raw: true });
aprs('auto_reply', '自动回复', 0x25, 'bool', { options: onoff });
aprs('auto_reply_interval', '自动回复间隔索引', 0x26, 'u8', { raw: true });
for (const [id, label, off, length] of [['own_callsign', '本机呼号', 0x28, 8], ['target_callsign', '目标呼号', 0x30, 8], ['path', 'APRS 路径', 0x38, 56], ['text', '位置备注', 0x70, 56], ['auto_reply_text', '自动回复文本', 0xc8, 56]])
  aprs(id, label, off, 'text', { length, encoding: 'ascii', help: 'CPS 使用 ASCII；无法编码的字符会明确拒绝。' });
for (let i = 0; i < 8; i++) aprs(`frequency_${i}`, `发射频率 ${i + 1} / Hz`, 0xa8 + i * 4, 'frequency', { length: 4, min: 0, max: 0xffffffff * 10 });

// Actual K8 CPS lists, inspected through the exact converter call sites. Values
// are storage indices; labels are independently phrased for this application.
function enrich(id, extra) {
  const i = fields.findIndex(f => f.id === id);
  if (i < 0) throw new Error(`Missing setting ${id}`);
  fields[i] = Object.freeze({ ...fields[i], ...extra });
}
function select(id, labels, token, extra = {}) {
  enrich(id, { options: opts(labels), min: 0, max: labels.length - 1, raw: false,
    evidence: `CPS parameter list ${token} + active converter`, ...extra });
}
select('tx_timeout_index', ['关闭', ...Array.from({ length: 10 }, (_, i) => `${i + 1} 分钟`)], '060002F2');
select('key_lock', ['解锁', '锁定'], '060002F4');
select('microphone', ['1', '2', '3', '4', '5'], '060002F6');
select('channel_display', ['频率', '信道编号', '信道名称', '频率与名称'], '060002FC');
select('power_save', ['关闭', '1:1', '1:2', '1:3', '1:4'], '060002FE');
select('backlight_timeout', ['关闭', '1', '2', '3', '4', '5', '10', '15', '20', '25', '30', '常开'], '060002F3',
  { help: '标签来自 CPS 的背光选项；存储值是列表索引。' });
select('scan_resume', ['TO', 'CO', 'SE'], '060002FF');
select('auto_lock', ['关闭', '开启'], '060002DA');
select('startup_display', ['全屏', '欢迎文字', '电池电压', '图片', '无'], '060002FB');
select('alarm_mode', ['本地报警', '远端报警'], '06000312');
select('repeater_tail', ['关闭', ...Array.from({ length: 10 }, (_, i) => String((i + 1) * 100))], '060002F7');
select('radio_work_mode', ['广播与信道接收', '仅广播'], '060002DD');
select('language', ['中文', 'English'], '06000302');
select('signaling_sidetone', ['关闭', '开启'], '060002DA');
select('decode_response', ['关闭', '提醒', '回复', '提醒并回复'], '060002EA');
for (const id of ['side1_short', 'side1_long', 'side2_short', 'side2_long', 'side3_short', 'side3_long'])
  select(id, ['无', '切换功率', '监听', '扫描', 'VOX', '紧急报警', '广播收音机', '1750 Hz', 'APRS 信标发射', 'APRS 消息编辑', '定位开关', '蓝牙开关', '显示时间'], '06000303');
const zones = Array.from({ length: 48 }, (_, i) => {
  const minutes = -690 + i * 30;
  return `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
});
select('time_zone_index', zones, '060002CF');
enrich('screen_reset_raw', { min: 8, max: 200, help: 'CPS 列表为 8..200；读时减 8 查表，写时保存所选数字。', evidence: '0600030B + 06000032/33' });
enrich('cw_pitch_raw', { min: 400, max: 1000, evidence: 'CPS ConvertGenParam 06000032 validates 400..1000' });
select('five_tone_protocol', ['EIA', 'EEA', 'CCIR', 'ZVEI1', 'ZVEI2', '用户自定义'], '06000319');
select('aprs_beacon_source', ['GPS', '固定位置', '蓝牙'], '060002D7');
select('aprs_beacon_format', ['常规', 'Mic-E'], '060002D8');
select('aprs_latitude_hemisphere', ['N', 'S'], '060002D1');
select('aprs_longitude_hemisphere', ['E', 'W'], '060002D2');
enrich('aprs_auto_reply_interval', { min: 0, max: 60, raw: false, evidence: 'CPS 060002D9 returns 0..60 as strings' });

// Exact-model options whose earlier UI exposed only opaque storage indices.
select('end_talk', ['关闭', '嘀嘟提示音', '蛙鸣提示音'], 'K8.json build 68 end_talk_option',
  { help: '第三项由 68 版 K8 配置声明；64 版只声明前两项。原值仍无损保留。' });
for (const side of ['a', 'b']) {
  const labels = [...Array.from({ length: 999 }, (_, i) => `信道 ${i + 1}`),
    ...Array.from({ length: 7 }, (_, i) => `${side.toUpperCase()} / VFO 频段 ${i + 1}`)];
  select(`display_${side}_raw`, labels, side === 'a' ? '060002EB' : '060002EC',
    { label: `${side.toUpperCase()} 区开机显示`, help: '0..998 为普通信道，999..1005 为本侧 7 个 VFO；只修改当前选择，不清空历史选择。' });
}
for (const id of ['dtmf_separator', 'dtmf_group_code'])
  enrich(id, { pattern: '^[A-D*#]?$', help: '一个 A–D、* 或 # 字符；留空写入空字段。' });
for (const id of ['five_tone_separator', 'five_tone_group_code'])
  enrich(id, { pattern: '^[A-E]?$', help: '一个 A–E 字符；留空写入空字段。' });
for (const prefix of ['dtmf', 'five_tone']) {
  enrich(`${prefix}_reset_raw`, { label: '自动复位 / 秒', raw: false, unit: 's' });
  for (const [suffix, label] of [['precarrier_raw', '预载波'], ['first_code_raw', '首码持续'], ['single_code_raw', '单码持续'], ['gap_raw', '码间隔']])
    enrich(`${prefix}_${suffix}`, { label: `${label} / 毫秒`, raw: false, unit: 'ms',
      help: 'K8 配置标注毫秒，CPS 直接保存选中数字，未使用其他型号的比例换算。' });
}
enrich('dtmf_star_hash_raw', { label: '* / # 持续 / 毫秒', raw: false, unit: 'ms' });

// Only these two additional fields have an exact editable converter and stock
// consumer contract. Other state/board fields are inspectable and immutable.
field('air_programming_repeats', '空口写频发送次数', 'advanced', 0x19001, 'u8', {
  min: 1, max: 4, evidence: 'CPS 060003D6/GetHideParam + stock loader 0x0800F2A2',
  help: '设置电台自身空口写频功能的重复次数；保存此项不会开始发射。' });
field('remote_killed_state', '遥毙状态原值', 'advanced', 0x19002, 'u8', {
  writable: false, raw: true, evidence: 'CPS kill_flag + stock loader 0x0800F2BA',
  help: '状态字节仅显示和备份，不以普通配置表单修改设备的遥毙状态。' });
field('encrypted_call_flag', '加密通话标志原值', 'advanced', 0x19003, 'u8', {
  writable: false, raw: true, evidence: 'CPS encrypt_flag + stock loader 0x0800F2CC',
  help: '已确认存储字段；实际加密语义及互通行为未确认，仅显示和备份。' });
field('channel_reconfiguration', '信道重配置策略', 'advanced', 0x1900a, 'u8', {
  max: 2, options: opts(['正常', '禁止重配置', '禁止重配置及发射']),
  evidence: 'CPS GetChannelReconfigFlags 060002CE + stock loader 0x0800F306',
  help: '值 2 同时限制发射；该字段独立于信道功率和频段选择。' });
field('ultra_high_power_flag', '功率扩展状态原值', 'advanced', 0x1b000, 'u8', {
  writable: false, raw: true, evidence: 'CPS GetUltraHighPowerFlag 060003EB + stock loader 0x0800F34E',
  help: '官方 PC 读取但隐藏此控件，未接入其正常写入流程；只保存原值。' });

export const SETTINGS_FIELDS = Object.freeze(fields);
export const SETTINGS_BY_ID = Object.freeze(Object.fromEntries(fields.map(f => [f.id, f])));
export const SETTINGS_GROUPS = Object.freeze({ general: '常规设置', keys: '按键', display: '显示与名称', radio: '广播接收', dtmf: 'DTMF', five_tone: '5TONE', aprs: 'APRS', advanced: '高级设置与状态' });
export const STRUCTURED_TABLES = Object.freeze({
  dtmf_contacts: { offset: 0x1a000, count: 16, size: 24, name_bytes: 16, code_bytes: 8, code_pattern: '^[0-9]*$' },
  five_tone_contacts: { offset: 0x1a800, count: 16, size: 24, name_bytes: 16, code_bytes: 8, code_pattern: '^[0-9]*$' },
  predefined_messages: { offset: 0x2e000, count: 64, size: 256, text_offset: 24, text_bytes: 48,
    read_encoding: 'utf-8', write_encoding: 'ascii', evidence: 'CPS_PreDefineMesg 02000090 + converters 06000017/060003F3; APK 56-byte declaration conflicts' },
});
export const STARTUP_BITMAP = Object.freeze({ offset: 0x45000, length: 1032, data_offset: 8, data_length: 1024,
  magic: 0x9abc5a5a, width: 128, height: 64, evidence: 'CPS 0600036D/06000096/97 + stock CPU loader 0x0800FD04' });
export const UNRESOLVED_FEATURES = Object.freeze([
  { id: 'startup_password', offset: 0x17000, length: 4, reason: 'Special password formatter not yet replayed; preserved read-only.' },
  { id: 'noaa_same', reason: 'SAME structures remain in CPS metadata, but no active K8 storage/transfer path was found; see docs/noaa.md. No address is inferred.' },
]);
