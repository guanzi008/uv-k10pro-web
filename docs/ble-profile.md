# UV-K10 Pro：官方 Android APK 的 BLE 证据与待确认绑定

核对日期：2026-11-26。范围仅限已取得的官方 **QUANSHENG 1.1.0-64 / 1.1.0-68** 两份 APK；没有运行 APK、连接实机或获得手机 HCI 抓包。

## 结论

**目前不能发布一个已经证实属于 UV-K10 Pro / K8 的默认 BLE profile。** 两份 APK 都包含独立的 K8 协议名称、K8 专用 BLE 诊断字符串和 K8 参数资产，但同时包含 K82、UV5 资产及其他协议实现。FFE、FFF、FF12 等 UUID 常量也同时存在。此次静态提取没有恢复出“用户所选 UV-K10 Pro → K8RadioProtocol 实例 → GATT 服务/特征选择 → 帧编码配置”的完整引用链。

因此 `serviceUuid`、`writeUuid`、`notifyUuid`、`writeMode`、`wireMode`、`responseChecksum` 与有效分片大小均保持**待确认**。本项目的 BLE 入口属于需要用户提供经核实 profile 的实验传输接口；不能据此宣称已完整替代官方 Android App。未知 UUID 也不能用其他全盛产品、常见串口透传模块或 PC 串口配置补齐。

本文件没有修改 `src/protocol/` 或 `src/app.mjs`，也没有添加自动尝试多个 UUID/profile 的逻辑。

## 1. 样本与复现锚点

厂商发布记录与 APK 来源沿用 [协议证据说明](protocol.md#1-证据范围与追溯)：

- [厂商 Android 英文发布条目 11398](https://cms.qsfj.com/api/entries/files/11398?fl-language=en)。下载样本为 `QUANSHENG-1.1.0-64.apk`。
- [厂商 Android 中文发布条目 11234](https://cms.qsfj.com/api/entries/files/11234?fl-language=zh)。条目标题指向 UV-K10 Pro Android App 1.1.0-68；本轮使用已保存的对应 APK。

在线条目可能更新；以下 SHA-256 才是本次结论的样本范围。机器可读记录见 [ble-static-inventory.json](evidence/ble-static-inventory.json)。

| 样本 | SHA-256 |
|---|---|
| APK 64 | `b12adceddfe49c7df04eab3b8b6dbc336d7a6eb32a0df62bc75b7e978559d048` |
| APK 68 | `0395fa0332d025da73a39aad49b01eaedfe59e8296f17df56fa937ff9b83b326` |
| APK 64 内 `lib/arm64-v8a/libapp.so` | `8851fea2ebc54442d12062cba11673d3d8a0aad05dbcfd15009b657b21da7a4f` |
| APK 68 内 `lib/arm64-v8a/libapp.so` | `c2cbc6245093682907109259fa1c888fa1f41c6505a48d113e0b5ca09fd5dabb` |

两份 `libapp.so` 分别为 12,518,288 / 12,583,824 字节，均为 stripped AArch64 ELF。各自 `libflutter.so` 内都可定位到 `3.12.1 (stable)`；两份 VM snapshot 的 hash 都是 `ace654289f5abc240509fc941453ebc5`，flags 含 `arm64 android compressed-pointers`。这些标记只说明运行时格式相同，不能证明两版 App 的分支行为完全相同。[证据：本地样本、JSON inventory]

`readelf -Ws libapp.so` 仅列出 6 个动态符号条目，其中非空条目为 Dart VM/isolate 的 data/instructions snapshot 和 build ID。以下偏移都是**解压后的 `libapp.so` 文件字节偏移**，不是 APK 内偏移、运行时虚拟地址或已识别函数入口。

## 2. 已确认的资产和型号隔离

两版 APK 的 `assets/flutter_assets/assets/products/data.json` 内容相同，产品名称列表仅有 `UV-K10 Pro`，文件 SHA-256 为 `efdaa8efdc8bfcef1d4d6a98a35ea7acffafcf4ab752d92106ad940c598354be`。但同一 APK 同时打包：

| 资产 | 确认内容 | 不能据此推导的内容 |
|---|---|---|
| `assets/flutter_assets/assets/K8.json` | `deviceModel` 为 `K8` | 不能仅凭资产存在认定运行时已经选择 K8 |
| `assets/flutter_assets/assets/K82.json` | `deviceModel` 为 `K82` | 不能借用其地址或 BLE 行为给 K8 |
| `assets/flutter_assets/assets/UV5.json` | 另一个独立参数资产 | 不能因同包分发就把布局合并 |
| `assets/flutter_assets/assets/products/data.json` | 展示的产品名称为 UV-K10 Pro | 产品展示列表没有提供 GATT 路由映射 |

K8 参数资产有 BLE 设备名称等配置字段，但未发现可直接读取的 service/write/notify UUID 绑定。`libapp.so` 中又同时存在 `K8RadioProtocol`、`K82RadioProtocol`、`BopttRadioProtocol`，进一步说明必须找到实际路由，而不能把整个 App 当成只有一种协议。[证据：两份 APK 的资产与下表定位]

| 静态字符串/标记 | APK 64 偏移 | APK 68 偏移 |
|---|---:|---:|
| `package:walkie_talkie_main/core/protocol/k8/k8_radio_protocol.dart` | `0x36747` | `0x36797` |
| `K8RadioProtocol` | `0x9F525` | `0x9F638` |
| `K82RadioProtocol` | `0x6CFB6` | `0x6D074` |
| `BopttRadioProtocol` | `0xC6B9D` | `0xC6CFE` |
| `assets/K8.json` | `0xB07B0` | `0xB08EA` |
| `assets/K82.json` | `0xE1EC5` | `0xE2081` |
| `UV-K10 Pro` | `0x86C33` | `0x86CFA` |

这是存在性证据，不是调用图证据；相邻字符串的位置也不构成函数引用关系。

## 3. UUID 常量：所有角色仍待核对

以下前缀都使用 Bluetooth Base UUID 后缀 `-0000-1000-8000-00805f9b34fb`：

| UUID 前缀 | APK 64 偏移 | APK 68 偏移 | 本轮可确认的角色 |
|---|---:|---:|---|
| `0000ffe1` | `0x77186` | `0x77244` | 未确认 |
| `0000ffe2` | `0x4CBC6` | `0x4CC79` | 未确认 |
| `0000ffe3` | `0xA5322` | `0xA5435` | 未确认 |
| `0000fff1` | `0x687B4` | `0x68872` | 未确认 |
| `0000fff2` | `0x5C968` | `0x5CA26` | 未确认 |
| `0000fff3` | `0x6E0BF` | `0x6E17D` | 未确认 |
| `0000ff12` | `0xADD43` | `0xADE7D` | 未确认 |
| `00002902` | `0xE1AD3` | `0xE1C8F` | 标准 CCCD UUID 常量；不是 K8 专用服务证据 |

`0x2902` 的标准名称是 Client Characteristic Configuration，见 [Bluetooth SIG Assigned Numbers](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/index-en.html)。APK 中存在此常量，仍不能确定它关联到哪一个 K8 特征。

没有把 FFE/FFF 组的数字顺序解释为 service/write/notify 顺序，也没有因未找到某个完整 UUID 字符串就断言该服务不存在：服务可能通过枚举筛选、短 UUID、运行时构造或其他形式选择。

## 4. K8 专用日志能帮助下一次定位什么

| 完整定位前缀 | APK 64 偏移 | APK 68 偏移 | 若实机运行时出现，可补齐的证据 |
|---|---:|---:|---|
| `K8 GATT char ` | `0x8C11F` | `0x8C1E6` | 枚举到的特征及属性；仍需服务归属 |
| `K8 BLE enabling notify on ` | `0xCF881` | `0xCFA0C` | 实际订阅的通知特征 |
| `K8 BLE RX via ` | `0xDF482` | `0xDF61F` | 收到数据的实际特征与方向 |
| `K8 BLE TX (` | `0xA51D0` | `0xA52E3` | 发送帧及长度的线索 |
| `K8 BLE TX long (` | `0x58B3D` | `0x58BFB` | 长发送/分片分支的线索 |
| `K8 BLE MTU negotiated=` | `0xC5118` | `0xC5279` | 本次连接的协商 MTU |
| `K8 CRC mismatch: expected=0x` | `0x88D91` | `0x88E58` | 某条 K8 解析路径带 CRC 比较逻辑 |

同样定位到 `K8 frame header must be AB CD`、`K8 frame tail must be DC BA`。这支持 App 中存在 K8 帧校验实现，但不能单凭报错字符串确认实际 BLE 通道使用 plain 或 XOR、CRC 多项式、反射/初值/终值，或是否接受固定 `FFFF`。库中的 PC/USB 和辅助 UART 已核实行为见 [帧格式、CRC 与 XOR](protocol.md#4-帧格式crc-与-xor)，本轮没有建立“BLE 模块连接到哪条 MCU UART”的硬件证据，不能把其中一条直接指定为 BLE。

这些字符串可能只出现在未执行的分支或被运行时日志开关抑制。release APK 能否实际输出，仍需观察；不能把它们当成已经收到的设备日志。

## 5. 未闭合的证据链

| 要确认的字段 | 目前缺少什么 | 最小有效证据 |
|---|---|---|
| K8 型号路由 | 产品选择/识别逻辑到 K8 协议实例的引用 | 同次会话的产品选择、K8 路由日志，或恢复后的构造调用图 |
| `serviceUuid` | 所选特征所属服务 | 该设备本次 GATT 服务发现结果及 handle 范围 |
| `writeUuid` | 发送 HELLO/读请求时使用的特征 | ATT 写入 handle 对应的 characteristic UUID |
| `notifyUuid` | 开启通知并返回 K8 响应的特征 | CCCD 配置、通知 handle 和响应数据对应关系 |
| `writeMode` | App 实际使用 write request、write command 或其他过程 | HELLO/读命令发送时的 ATT opcode 和应答序列 |
| `wireMode` | BLE 帧体是否 XOR | 完整 HELLO TX/RX 与已核实帧格式对照 |
| `responseChecksum` | 响应 checksum 是计算值还是固定占位 | 至少 HELLO 与不同内容的读响应，解码后逐帧计算比较 |
| `mtuPayload` / 分片 | App 协商、实际写入大小及组帧行为 | MTU 交换、每个 ATT payload 长度、长读响应的连续分片 |

本轮只完成资产、ELF 动态符号和静态字节索引。Dart AOT 的完整对象池/函数到常量引用未恢复，没有以 native 符号或普通字符串相邻关系替代这一步。为控制本轮范围，没有继续编译大型 Dart 分析运行时，也没有把未验证的工具输出当成依据。

## 6. 最小实机取证流程：无需写入信道

以下是后续验证计划，本轮没有执行。

1. 记录机身型号 **UV-K10 Pro**、固件版本，以及使用的官方 APK 的 SHA-256。只连接这一台目标电台；保留本次在 App 内选择的产品/型号信息。
2. 在 Android 开发者选项启用 **Bluetooth HCI snoop log**，重新启动手机蓝牙后再连接。AOSP 官方说明了启用顺序、通常的 `data/misc/bluetooth/logs` 位置，以及通过 bug report 和 `btsnooz.py` 提取的路径；不同手机的导出方式以其实际权限为准。[AOSP：Verify and debug](https://source.android.com/docs/core/connect/bluetooth/verifying_debugging)
3. 启动官方 App，选择 UV-K10 Pro，连接并执行一次正常“读取设备”。这会发送 GATT 写操作来传送读请求，因此**不需要执行电台 Flash/信道写入**也能观察 `writeMode`。已知 HELLO 会同步电台 RTC；连接不能表述成完全无副作用。
4. 保存从连接开始到首批读取完成的 HCI/ATT 会话，至少包含服务/特征发现、CCCD 配置、MTU 交换、完整 HELLO 请求/响应、一个以上参数读请求/响应。若系统缓存省略 GATT 发现，另提供同一设备的服务/特征枚举结果，用 handle 关联；只有十六进制通知内容不足以确认 UUID。
5. 若官方 App 的 K8 日志可见，同时保存上一节日志前缀对应的完整行和时间。提取目标会话所需部分即可；无需提供其他设备流量或密码。

在 Wireshark 中可先用 `btatt` 展示过滤器，结合目标连接和服务 handle 范围定位数据；`btatt.opcode`、`btatt.handle` 等字段以 [Wireshark ATT 显示过滤器参考](https://www.wireshark.org/docs/dfref/b/btatt.html) 为准。保留原始完整会话以便重组，不要把单个 ATT 通知误当成完整的 K8 帧。

验收时必须把以上字段关联到**同一台电台、同一 APK、同一次 K8 会话**。先证明模型路由和 UUID，再重组帧核对长度、命令、地址、XOR 与 checksum；最后才把经过复核的 profile 转成显式配置及黄金帧测试。对一次响应恰好出现 `FFFF` 的观察，应使用其他不同内容响应继续排除偶合，不能直接宣布为占位校验。

## 7. 本地重现常量索引

以下 Python 只读取指定 APK，不运行其中代码；无需安装 Android 或蓝牙依赖：

```python
import hashlib, re, zipfile
from pathlib import Path

apk = Path('QUANSHENG-1.1.0-68.apk')
print('APK SHA-256:', hashlib.sha256(apk.read_bytes()).hexdigest())
with zipfile.ZipFile(apk) as archive:
    app = archive.read('lib/arm64-v8a/libapp.so')
    engine = archive.read('lib/arm64-v8a/libflutter.so')
    print('libapp SHA-256:', hashlib.sha256(app).hexdigest())
    print('Dart:', re.search(rb'\d+\.\d+\.\d+ \(stable\)', engine).group().decode())
    for match in re.finditer(rb'0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb', app):
        print(hex(match.start()), match.group().decode(), 'role=unresolved')
    for needle in (b'K8RadioProtocol', b'K82RadioProtocol', b'BopttRadioProtocol',
                   b'K8 GATT char ', b'K8 BLE enabling notify on ',
                   b'K8 BLE MTU negotiated=', b'K8 BLE RX via '):
        print(hex(app.find(needle)), needle.decode())
```

把输入换成已核对 SHA-256 的 APK 64 可复查另一列。`bytes.find()` 返回的位置只是字符串数据位置；该脚本特意不输出推测的 profile。
