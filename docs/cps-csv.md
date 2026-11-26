# CPS 0.56 信道 CSV 兼容性

来源为固定 SHA-256 `79c9b3429187f7fca13cc8971d0e5fd46184f078127f149f333a267b99815132` 的官方 CPS 静态 IL 和其中用于该界面的少量标签。没有复制完整语言资源或附带用户信道数据。

## 当前 22 列

`main.GridViewChannelInit`，token `060003AB` / RVA `0x65068`，明确创建 22 列并依次赋值。`ExportDataGridViewToCsv`，`06000417` / `0x6A800`，按界面 HeaderText 与单元格顺序导出；`ImportCsvToDataGridView`，`0600041B` / `0x6AB9C`，按列位置读取，校验当前界面语言的枚举文本。导出使用 .NET `Encoding.Default`，所以不能保证每个用户生成的文件都是 UTF-8。

| 0 起算列 | 英文表头 | 中文表头 | 本项目字段 |
|---:|---|---|---|
| 0 | No. | 序号 | 用户编号 1..999 |
| 1 | Name | 名称 | name |
| 2 | RX Freq[MHZ] | 接收频率[MHZ] | rx_frequency_hz，显示 MHz |
| 3 | TX Freq[MHZ] | 发射频率[MHZ] | 由 RX、offset_direction、offset_hz 表达 |
| 4 | QT Encode Type | 亚音编码类型 | tx_tone.kind |
| 5 | QT Encode | 亚音编码 | tx_tone.value，按类型转换 |
| 6 | QT Decode Type | 亚音解码类型 | rx_tone.kind |
| 7 | QT Decode | 亚音解码 | rx_tone.value，按类型转换 |
| 8 | Band | 带宽 | bandwidth |
| 9 | Power | 功率 | power |
| 10 | Busy Lock | 繁忙禁发 | busy_lockout |
| 11 | ScanList | 扫描列表 | scan_list |
| 12 | Demode | Demode | modulation，见版本冲突 |
| 13 | Freq Reverse | 倒频 | reverse |
| 14 | SQ | 静噪 | squelch |
| 15 | Encrypt | 加密 | scrambler |
| 16 | Signaling Decode | 信令解码 | signaling_decode |
| 17 | PTTID | PTTID | ptt_id |
| 18 | Signal | 信令系统 | signaling_system |
| 19 | BeaconSrc | 信标源 | aprs_receive，CPS 实际校验 OFF/ON |
| 20 | APRS PTT | APRS PTT控制 | aprs_ptt |
| 21 | APRS TX Channel | APRS发射信道 | aprs_tx_channel |

安装包还附有 **旧 20 列**样例，含额外 MSW 列、`Powrer` 拼写、没有新增 APRS 列。不能把这些旧样例当成当前导入器的列布局，也不能根据列数直接按当前列号写入。

## 当前枚举文字

以下顺序是 CPS 中列表的顺序，不保证所有列表索引直接等于存储值；扫描列表尤其有转换。

| 类型 | 英文枚举 | 中文枚举 | 注意 |
|---|---|---|---|
| 亚音类型 | Null, Ctcss, NDCS, IDCS | 无, 模拟亚音, 数字亚音, 反向数字亚音 | CPS CSV 不表达固件 U23/U24 |
| 带宽 | 25K, 12.5K | 相同 | 0 / 1 |
| 功率 | LowPower, HighPower, UltraHighPower | 低功率, 高功率, 超高功率 | 0 / 1 / 2 |
| 开关 | OFF, ON | 关闭, 打开 | 0 / 1 |
| 扫描 | 1..32, Scan all CH, Null | 1..32, 扫描所有信道, 无 | 存储 0..31=列表 1..32、32=全部、255=无；见 `060002E5` 与普通信道转换器 |
| 调制 | FM, AM, CW | 相同 | CPS 仅三项，但参照固件 8.02.16 为 FM/AM/SSB/CW；必须显式处理 |
| 静噪 | 0..9 | 相同 | 十进制文本 |
| 扰频 | OFF, 1..10 | 关闭, 1..10 | 原界面标签为 Encrypt，不将其宣称为加密安全功能 |
| PTTID | OFF, Start, End, Start&End | 关闭, 开始, 结束, 开始和结束 | 0..3 |
| 信令系统 | DTMF, 5TONE | 相同 | 0 / 1 |
| APRS PTT | Null, Start, End | 无, 开始, 结束 | 0..2 |
| APRS 发射信道 | Current Channel, 1..8 | 当前信道, 1..8 | 0=当前信道，1..8=APRS 频率配置槽 |

CPS CSV 没有普通信道的步进、原始属性、VFO 扫描边界或全部保留字节。导入应对已存在备份做局部编辑，而不是把一行 CSV 当成可还原完整 64 字节记录的备份。无法无损表达的模式/亚音应明确报错或选择本项目的完整 JSON/NOR 备份格式。
