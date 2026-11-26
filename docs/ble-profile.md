# UV-K10 Pro / K8：官方 Android BLE 配置与实现

核对日期：2026-11-26。已恢复官方 **QUANSHENG 1.1.0-64 / 1.1.0-68** APK 中的 Dart AOT 方法、调用目标和对象字段。K8 的服务、发送特征、接收特征已取得型号专属引用证据；详细发送策略和帧校验分析以 APK 68 为准。本轮没有连接实机、运行完整 Android App 或取得 HCI 抓包。

## 已确定的默认配置

`src/protocol/transports.mjs` 导出 `DEFAULT_K8_BLE_PROFILE`，可直接用于 `WebBluetoothTransport.request({...DEFAULT_K8_BLE_PROFILE})`。该配置来自 **K8RadioProtocol → BleGattProfile.k8 → GATT 消费代码** 的调用和数据流，不再依赖字符串相邻关系。

| 配置项 | 官方 K8 行为 / Web 实现 |
|---|---|
| 产品名称 | `UV-K10 Pro`，存于 `BleGattProfile.k8` 构造结果 |
| 服务 UUID | `0000ff12-0000-1000-8000-00805f9b34fb` |
| TX 特征 UUID | `0000fff2-0000-1000-8000-00805f9b34fb` |
| RX 首选特征 UUID | `0000fff3-0000-1000-8000-00805f9b34fb` |
| 写方式 | `withResponse`，Web 使用 `writeValueWithResponse()` |
| 帧体 | `plain`，没有应用 PC/USB 的 XOR 密钥 |
| 请求校验 | CRC-16/X25 |
| 响应校验 | `crc16-x25-or-placeholder`：`FFFF` 占位或实际 X25；占位不标记为 CRC 已验证 |
| 请求长度方言 | `android-k8`：HELLO 声明 24，WRITE 声明 140；WRITE 仍保留 128 字节数据槽 |
| 每帧写入策略 | `whole-frame`：完整帧作为一次特征值写入 |
| 帧间等待 | 120 ms；适配器串行化写入，避免提前收到响应时跳过等待 |

这些 UUID 不是唯一机型标识。同包的其他独立协议也可能使用同一服务组；Web 仍要求明确选定 UV-K10 Pro，并保留固件、参数版本、密码认证、当前会话备份和读回校验。**静态确定默认连接参数，不等于通过实机验收。**

证据：[`ble-aot-profile.json`](evidence/ble-aot-profile.json)、[`ble-crc-replay.json`](evidence/ble-crc-replay.json)。此前 [`ble-static-inventory.json`](evidence/ble-static-inventory.json) 保留为历史字符串清单，其中“角色未确定”结论已被新的调用/数据流证据补齐。

## 1. 样本与复现锚点

官方发布来源沿用 [协议证据说明](protocol.md#1-证据范围与追溯)：

- [厂商 Android 英文条目 11398](https://cms.qsfj.com/api/entries/files/11398?fl-language=en)，保存样本为 `QUANSHENG-1.1.0-64.apk`。
- [厂商 Android 中文条目 11234](https://cms.qsfj.com/api/entries/files/11234?fl-language=zh)，保存样本为 `QUANSHENG-1.1.0-68.apk`。

在线条目可能更新，以下 SHA-256 确定本次样本范围。

| 样本 | SHA-256 |
|---|---|
| APK 64 | `b12adceddfe49c7df04eab3b8b6dbc336d7a6eb32a0df62bc75b7e978559d048` |
| APK 68 | `0395fa0332d025da73a39aad49b01eaedfe59e8296f17df56fa937ff9b83b326` |
| APK 64 内 `lib/arm64-v8a/libapp.so` | `8851fea2ebc54442d12062cba11673d3d8a0aad05dbcfd15009b657b21da7a4f` |
| APK 68 内 `lib/arm64-v8a/libapp.so` | `c2cbc6245093682907109259fa1c888fa1f41c6505a48d113e0b5ca09fd5dabb` |

两份库均为 stripped AArch64 ELF，使用 Dart 3.12.1，VM snapshot hash 为 `ace654289f5abc240509fc941453ebc5`。本次为匹配该格式构建 Dart SDK 与 Blutter，读取 snapshot 中的方法、对象池及类型元数据，再检查对应 ARM64 指令。工具版本与样本大小记录在 `ble-aot-profile.json`。整个 APK、厂商二进制及完整反汇编不进入本仓库。

以下函数地址均为**精确样本的 ELF 虚拟代码地址**；不是 APK 压缩包偏移，也不是字符串清单里的文件偏移。Dart 对象池中的 `Obj!…@…` 是分析器的对象标识，不能当作特征句柄或代码入口。

## 2. 型号、服务和特征的实际引用链

| 链路 | APK 64 | APK 68 |
|---|---|---|
| `K8RadioProtocol.gattProfile` | `0xBD6F18` | `0xBE82A4` |
| getter 调用 `BleGattProfile.k8` | `0xBD6F2C → 0xBD6F44` | `0xBE82B8 → 0xBE82D0` |
| 构造结果名称写入 | `0xBD6FE0`：`UV-K10 Pro` | `0xBE836C`：`UV-K10 Pro` |
| `field_b` 服务 UUID | `0xBD6FE8`：FF12 | `0xBE8374`：FF12 |
| `field_f` TX UUID | `0xBD6FF0`：FFF2 | `0xBE837C`：FFF2 |
| `field_13` RX UUID | `0xBD6FF8`：FFF3 | `0xBE8384`：FFF3 |

仅看构造字段仍不足以确定角色，因此继续追踪 APK 68 的消费端：

1. `BleGattProfile.resolveFromServices`（`0x481004`）把 `field_b` 与发现的 service UUID 比较，由此确定 FF12 是服务。
2. `FlutterBleRadioTransport.connect`（`0x47C53C`）读取 `field_f`、`field_13`，分别与所选服务中的 characteristic UUID 比较。比较范围为 `0x47D01C..0x47D070` 与 `0x47D090..0x47D0D0`。
3. 两个特征都有非空检查；FFF2 匹配对象在 `0x47D154` 存入 transport 的 `field_23`。发送函数 `_sendLocked` 在 `0x76F3F4` 读取同一字段并交给特征写方法，确定 FFF2 是 TX。
4. `_subscribeAllNotifications`（`0x47F378`）只考虑 `notify` 或 `indicate` 为真的特征，并在 K8 分支优先选择 `field_13` 的 FFF3，确定它的接收角色。

APK 的构造函数还对 FFF1 字符串调用了 `Guid._toBytes`，但该结果没有存入上述 service/TX/RX 字段。这里不给 FFF1 编造角色。FFE 组也不作为 K8 的备用 UUID 表。

官方通知函数在没有合格首选通知特征时，会考虑所选服务中的其他通知特征。Web 的默认配置严格要求 FFF3 支持通知或指示；若设备暴露属性不同，先检查真实特征，再由用户选择并保存手工配置，不自动混入其他来源的数据流。[证据：`ble-aot-profile.json` 的 `bindings`、`apk68_consumers.characteristic_match` 与 `notification_selection`]

## 3. 写方式、MTU 和发送边界

`_writeOnce`（`0x7704F4`）及 `_writeOnceAllowLong`（`0x76F680`）通过 `_writeWithBusyRetry`（`0x76F740`）进入 `BluetoothCharacteristic.write`（`0x76F960`）。后者在 `0x76FA90` 为请求写入 `BmWriteType`，对象元数据明确给出名称 **withResponse**。单看枚举数字 0 没有用作最终依据。

普通写与长写传入的布尔值不同，它们最终进入请求对象 `field_23`。`BmWriteCharacteristicRequest.toMap` 在 `0x7700B4` 将该字段映射到命名键 **allow_long_write**，因此这个布尔值不是 writeWithoutResponse 开关。[证据：`ble-aot-profile.json` 的 `write_mode`]

官方 `_negotiateMtu` 的顺序为：

1. 请求 MTU **253**，参数位于 `0x480CA4`。
2. 失败后请求 MTU **78**，参数位于 `0x480C58`。
3. 再失败则使用当前 `mtuNow`。

`_sendLocked` 计算单次负载 `min(MTU - 3, 250)`；若结果小于 1，则使用 20。帧未超过该负载时直接写；超过时，**K8 分支将整个帧交给允许长写的方法**。同函数中的手工分片和 15 ms 分片间隔属于另一条协议分支，不能照搬为 K8 默认逻辑。K8 每帧完成后另有 **120 ms** 等待，来自对象 `Duration@a51d41` 的 120000 微秒值。[证据：`ble-aot-profile.json` 的 `mtu`、`send`]

### Web 对应实现与平台差异

Web Bluetooth 提供 `writeValueWithResponse()`，没有公开与 Android插件等价的 `requestMtu()` 和 `allow_long_write` 控制。默认适配器把完整帧作为一个值交给浏览器，保留官方应用层写入边界；浏览器、操作系统与该设备之间能否按所需方式完成长值写入，仍需要真实设备验证。Web 不伪造“已协商到 253”的状态。

Chromium 的特征写实现拒绝超过 **512 字节**的属性值，适配器也在调用前检查这一上限；协议层继续使用已建立的 BLE 收帧边界 **199 字节**，没有因为浏览器可接受 512 就放大无线电接收缓冲区。152 字节的完整 WRITE 帧在两者范围内。[Web Bluetooth 规范](https://webbluetoothcg.github.io/web-bluetooth/)；[Chromium 特征写实现](https://chromium.googlesource.com/chromium/src/+/76e47a170aa0d395b2893eecf8c22148251fa6d0/third_party/blink/renderer/modules/bluetooth/bluetooth_remote_gatt_characteristic.cc)；收帧边界见 [协议说明](protocol.md)。

适配器对每次 `write()` 复制数据并串行化。即使回复先于浏览器写 Promise 返回，下一帧也会等待前帧与 120 ms 间隔。失败的整值写会结束连接，不静默改成小片重发；重连后的连接代号也阻止旧连接排队数据进入新会话。

手工 `chunked` 配置保留 `mtuPayload` 的 1..244 范围。默认配置中的 `mtuPayload: 20` 仅为可移植配置结构的字段，**whole-frame 模式不会用它切片**；它也不表示当前 ATT MTU。[实现：`src/protocol/transports.mjs`]

## 4. 帧编码与请求长度方言

APK 68 的 `K8FrameCodec.encode`（`0x7725AC`）构造明文 `AB CD` 帧、内层命令/长度、payload、X25 和 `DC BA`。`K8Session.request` 在 `0x76F170..0x76F17C` 把编码后字节直接交给传输层；这条链没有 PC/USB 的 XOR 变换。

`K8FrameCodec.decode`（`0x771538`）在 `0x77187C..0x771884` 先比较收到的校验字是否为 `FFFF`，相等则直接接受；否则在 `0x7718A8` 计算 X25，并在 `0x7718B8..0x7718BC` 比较，不等则报错。`K8Crc.compute`（`0x771BB0`）使用初值 FFFF、反射多项式 8408、最后取反并保留 16 位。

因此实现新增 `responseChecksum: 'crc16-x25-or-placeholder'`：

- 响应为 FFFF 时：`checksumStatus: 'placeholder-unverified'`、`crcVerified: false`。
- 其他校验字：必须与 X25 一致，一致后才标记 `crc16-x25-verified`。
- 即便恰好计算出的 X25 也为 FFFF，兼容响应模式仍将收到的 FFFF 标为未验证，避免把可绕过校验的占位分支冒充完整性保障。
- 请求始终计算并校验真实 X25；该兼容例外不扩展到请求方向。原来的“仅占位”和“严格 X25”两种配置仍可使用。

Android 和 CPS 的 HELLO/WRITE 内层长度声明不同：

| 指令 | 共同的实际 payload | CPS 0.56 的声明长度 | APK 68 的声明长度 |
|---|---:|---:|---:|
| HELLO | 24 字节 | 4 | 24 |
| READ | 12 字节 | 12 | 12 |
| WRITE | 12 字节头 + 128 字节数据槽，共 140 | 12 | 140 |

APK 的 `K8ConnectionRequest.toPayload`（`0x772A28`）分配 24 字节。`encodeWriteRequest`（`0xBDF6AC`）分配 140 字节，只把 `count` 个数据复制到 offset 12，再把**整个固定长度数组**交给通用帧编码器。因此部分块写入仍有零填充，不能缩短为 `12 + count` 字节。

`buildHello(..., {lengthConvention: 'android-k8'})` 与 `buildWrite(..., {lengthConvention: 'android-k8'})` 按此生成；未指定时维持 `cps-0.56`。`ProgrammingSession` 从 `transport.protocolProfile` 继承方言用于连接、普通写入及凭据区的专用写入流程。[证据：`ble-aot-profile.json` 的 `message_lengths`；代码：`src/protocol/frame.mjs`、`src/protocol/session.mjs`]

## 5. 服务检查与配置文件

`discoverBleCharacteristics({serviceUuid, device?})` 检查一个明确指定的服务。它返回设备句柄、服务 UUID、所有特征 UUID，以及浏览器报告的九个真实属性：`broadcast`、`read`、`writeWithoutResponse`、`write`、`notify`、`indicate`、`authenticatedSignedWrites`、`reliableWrite`、`writableAuxiliaries`。

检查期间不读取特征、不订阅通知、不发送 HELLO。完成或失败后即断开；已有活动 GATT 会话则拒绝检查。设备选择器使用 `acceptAllDevices` 和仅含该服务的 `optionalServices`，允许手动选择未在广播中列出服务的外设。该过程不推断机型，也不自动尝试其他 UUID。

普通连接也使用相同的 `acceptAllDevices` 与单个 `optionalServices`。这是明确恢复的官方扫描行为：APK 68 的扫描页在 `0x797B0C` 调用 `FlutterBluePlus.startScan(0x797B20)`；扫描设置在 `0x797C60..0x797C68` 写入空的服务 UUID 列表，`BmScanSettings.toMap` 又在 `0x798ED8` 将该空列表映射为 `with_services`。服务存在于 GATT，并不意味着设备必须在广播中公布该服务；因此选择器不额外要求广播 FF12。此规则不会授权未知服务，也不会在选中设备后尝试其他型号的 UUID。[证据：`ble-aot-profile.json` 的 `scan`]

`WebBluetoothTransport.request({...profile, device})` 可复用刚刚授权的设备句柄，但会重新获取服务与特征对象；连接时只取 profile 指定的服务，检查 TX 是否支持指定写方式，RX 是否支持 notify/indicate，检查失败在订阅或发送前拒绝。设备句柄仅保留在进程内，不进入导出文件。[Web Bluetooth 规范](https://webbluetoothcg.github.io/web-bluetooth/)

`serializeBleProfile(profile)` / `parseBleProfile(text)` 使用以下封装：

```json
{
  "format": "uv-k10pro-ble-profile",
  "version": 1,
  "model": "UV-K10-PRO-K8",
  "profile": {
    "serviceUuid": "0000ff12-0000-1000-8000-00805f9b34fb",
    "writeUuid": "0000fff2-0000-1000-8000-00805f9b34fb",
    "notifyUuid": "0000fff3-0000-1000-8000-00805f9b34fb",
    "writeMode": "withResponse",
    "wireMode": "plain",
    "responseChecksum": "crc16-x25-or-placeholder",
    "mtuPayload": 20,
    "writeStrategy": "whole-frame",
    "interWriteDelayMs": 120,
    "lengthConvention": "android-k8"
  }
}
```

导入上限为 16 KiB UTF-8，验证格式、版本、型号、三个完整 UUID、枚举、分片尺寸与 0..1000 ms 等待范围。整帧写策略要求 `withResponse`。旧版配置缺少三个新增字段时，沿用 `chunked`、0 ms、`cps-0.56`，不会默默变成 Android 预设。导出严格列出已知配置字段；密码、设备 ID/名称、设备句柄与会话状态不会被序列化。型号标签只描述配置目标，不能替代设备确认。

## 6. 验证与剩余实机工作

[`tests/reference/replay-ble-crc.py`](../tests/reference/replay-ble-crc.py) 在 Unicorn AArch64 中读取精确 SHA-256 样本，执行原始 CRC 每字节算术、CRC 收尾与响应校验比较指令块。输入覆盖空数据、标准校验向量、全 256 种字节、全零/全 FF、HELLO、READ、固定槽 WRITE、ACK，以及实际 CRC 恰等于 FFFF 的边界值：**10 组 CRC + 30 组分支，40 项通过**。生成的四个帧向量由独立布局构造与原指令计算的 CRC 组成。

复现命令（需自行取得上述 APK 中的 ARM64 `libapp.so`，并安装 Python `unicorn`）：

```sh
python tests/reference/replay-ble-crc.py /path/to/libapp.so --output docs/evidence/ble-crc-replay.json
node --test tests/ble-frame.test.mjs tests/ble-profile.test.mjs tests/protocol-transports.test.mjs tests/protocol.test.mjs
```

Node 测试覆盖 profile 文件隔离、手工发现无协议发送、GATT 属性、句柄复用、连接失败/断开清理、完整值写入、120 ms 顺序、禁止失败后切片重试、旧队列隔离、混合 CRC/占位响应、两种请求长度方言和会话实际读写。原指令实验的范围是上述代码块；Dart 分配器、完整 App、BLE 栈、射频及芯片外设没有被仿真。

需要实机补齐的项目集中于浏览器与设备的配合：实际 GATT 属性、浏览器/系统对完整 152 字节值写入的支持、订阅后的回复时序、长时间读写和断连重连后的行为。恢复出的型号绑定与这些物理验收项分别记录，不把离线测试结果当作实机成功。
