# K8 实时位置同步与 APRS 消息

本模块补充写频数据以外的 K8 实时功能：手填位置同步、APRS 消息构造及发送、被动接收 APRS 通知。命令来自 UV-K10 Pro 对应的 K8 App 路径，并与 ENG 8.02.16 原指令交叉核对；没有采用 K82 或 UV-5 协议。

位置同步和消息发送都具有设备端作用。预览只生成本地数据；只有明确执行同步或发送才会交给会话。页面默认不读取浏览器地理位置：用户可以手填坐标，也可以点击一次定位按钮并授权浏览器填入坐标；取得坐标不会自动发往电台，不持续跟踪。消息不会自动重发。收到成功结果不表示远端已接收 RF 消息。

## 样本与实现边界

| 样本 | SHA-256 |
|---|---|
| QUANSHENG 1.1.0-68 APK | `0395fa0332d025da73a39aad49b01eaedfe59e8296f17df56fa937ff9b83b326` |
| 68 包 `lib/arm64-v8a/libapp.so` | `c2cbc6245093682907109259fa1c888fa1f41c6505a48d113e0b5ca09fd5dabb` |
| ENG 8.02.16 明文应用 | `061759672cc69a1b00420ce6fae67b0756d3db111f8fa4329cadc940dcd17f17` |

App 发布入口、型号绑定和 GATT 调用链见 [BLE 证据](ble-profile.md)。本仓库不分发 APK、完整 AOT 反汇编或厂商固件。

| 已恢复的 App 调用链 | 关键地址 |
|---|---|
| 位置页 → `RadioSessionController.sendK8LocationSync` → `K8RadioProtocol.sendConnectionLocation` | `0x76D8D4` → `0x76E334` → `0x76E420` |
| `K8ConnectionRequest.toPayload / toFrame` | `0x772A28 / 0x772574` |
| `K8RadioProtocol.encodeAprsFixedPosDms` | `0x772BFC` |
| APRS 表单 → `K8AprsFrame.buildMessage` | `0x779480` → `0x7797AC` |
| `K8RadioProtocol.sendAprsPacket` → `K8AprsMessages.encodeSendRequest / decodeSendResponse` | `0x77AE3C` → `0x77B1A8 / 0x77B040` |
| `K8Session.request` 的消息类型匹配与串行队列 | `0x76E6FC`、`0x770BE4` |

APRS 页面在该 App 样本中是发送表单；未找到属于本 K8 路径的接收列表业务。Web 的被动接收支持来自同型号 stock 固件真实发送的 `0x02E1`，没有将通用会话队列误认为 App 已有接收界面。

## 位置同步

`buildLocationSync(sessionToken, {utcSeconds, latitude, longitude, altitudeMeters})` 返回内层命令体，外层 framing 继续由当前 USB/串口/BLE profile 处理。它发送 `0x02BC` 并等待 `0x02BD`，与 HELLO 使用同一处理器。

| Payload 偏移 | 宽度 | 含义 |
|---|---:|---|
| `+0` | u32 LE | 当前会话 token |
| `+4` | u32 LE | UTC Unix 秒 |
| `+8` | u8 | 位置有效，固定 1 |
| `+9` | u8 ASCII | 纬度为负取 `S`，否则 `N` |
| `+10` | u8 ASCII | 经度为负取 `W`，否则 `E` |
| `+11` | u8 | 固定 0 |
| `+12` | u32 LE | 纬度绝对值的 App packed 编码 |
| `+16` | u32 LE | 经度绝对值的 App packed 编码 |
| `+20` | i32 LE | 海拔米，四舍五入，半数远离零 |

Payload 长度为 24，内层声明也是 24。纬度只接受有限数值 `-90..90`，经度 `-180..180`，海拔取整后必须可由 i32 表示。

App 函数名包含 DMS，但实际计算是度与十进制分：

```text
whole = floor(abs(degrees))
minutes = parse((fraction(degrees) * 60).toStringAsPrecision(4))
packed = truncate(whole * 1_000_000 + minutes * 10_000)
```

这是 **4 位有效数字**，不是固定 4 位小数。比如 `12.3456789°` 得到 `12,207,400`。在 `89.9999999°` 附近，它会得到 `89,600,000`，并不把 `60.00` 分进位到 90 度。Web 保留这一已观察到的官方转换，测试向量核对最终字节；不能把它换成另一种“更准确”的编码后仍声称字节兼容。

### 对会话与写入基线的影响

stock `0x08002D38` 会设置 RTC、保存位置，并重生成 4 个 32 位 challenge word，随后由 `0x080035B8` 发回新的 HELLO 身份。位置保存到活动 RAM，不在这条命令中写入 APRS 固定位置 NOR 字段。

原指令重放覆盖访问标志 `(0,0)`、`(1,0)`、`(1,1)`：`0x200001E0` 与 `0x200000BB` 在这条处理器路径保持原值；随机 challenge 则每次更换。UI 状态和 RTC 硬件操作在实验中是明确替换边界，不能据此断言整台机器所有状态都不变。

`ProgrammingSession.synchronizeLocation()` 与 Web 操作层共同执行以下步骤：

1. 通过正常连接、型号与版本检查，以及已有密码的正常认证，串行发送用户明确确认的坐标。
2. 解析新的 `0x02BD`，检查固件/参数版本，更新 identity 与 challenge。
3. 清除主机旧的 authenticated 状态。有编程密码时使用新 challenge 重新完成正常认证。
4. 会话将 `baselineGeneration` 加一；Web 更换应用层 `sessionId` 并清除旧写入计划和 APRS 预览，使旧设备读取基线失效。再次写配置前重新从设备读取。
5. 告知用户这次操作同时同步 RTC，不将其展示为仅改变经纬度。

这套失效策略是 Web 的会话一致性要求。它不声称固件已经在 HELLO 中清空同名权限字节，也不使用保留状态来绕过正常认证。

该 API 返回 `{synchronized, baselineInvalidated, identity, authenticationRequired, rfTransmissionRequested:false}`。无编程密码的设备在新 HELLO 身份通过核对后可以继续使用实时命令；此前读取的配置仍需重新读取才能写入。有密码的设备必须先使用新 challenge 重新认证。请求失败或超时会按普通事务关闭不确定的传输流，不复用旧认证状态继续操作。

## APRS 消息构造与预览

`prepareAprsMessage({destination, destinationSsid, source, sourceSsid, addressee, path, text})` 返回可预览对象：`packet`、`packetHex`、`length`、`information`、`normalizedText`、变更计数和 `warnings`。`buildAprsMessage()` 仅返回同样的完整字节。

### 与 App 一致的转换

- 目标与源呼号去掉首尾空白并转大写，接受 1..6 个 `A-Z/0-9`；源/目标 SSID 是 0..15。
- 消息收件人独立于 AX.25 目标呼号，接受 1..9 个 `A-Z/0-9/-`，补空格到 9 字符。
- 正文删除 `|`、`~`、`{`，然后检查可打印 ASCII `0x20..0x7E`，保留最多 67 字符。不会把中文转换成问号；删除和截断会在预览中显示。
- 路径去首尾空白并转大写，最多 30 个可打印 ASCII 字符，按逗号或空格拆分。
- 路径每段使用最后一个 `-` 拆 SSID；解析失败为 0，数值只取低 4 位，呼号超过 6 字符会截断。这些 App 行为通过预览提示公开，而不会静默修改。
- 地址为目标、源、各路径地址，呼号字节左移 1；目标 C 位为 1，最后一个地址的扩展位为 1。K8 的路径地址把 SSID 字节 bit6 清零、bit5 置一，保留该样本真实的 `0x20` 基础值。
- 控制字节 `0x03`、PID `0xF0`，信息域为 `:收件人九字符:正文`。尾部带两字节、小端 CRC-16/X25 FCS；不包含 HDLC flags 或 bit stuffing。
- 包含 FCS 的总包长最多 128 字节。路径数量和正文长度共同决定是否超长。

这些转换分别来自 `K8AprsFrame` 的 `buildMessage`、`_buildAddress`、`_buildDigipeaterAddress`、`prepareAprsMessage`。修改源码中的特殊位或直接把 UTF-8 正文交给它，都会改变已恢复的 App 线格式。

## APRS 发送协议

| 项目 | 值 |
|---|---|
| 请求 | `0x02DD` |
| 请求 payload | 固定 132 字节：`u16LE packetLength`、`u16 0`、最多 128 字节包并补零 |
| 回应 | `0x02DE`，payload 固定 4 字节 |
| 返回值 | byte0 为 0：发送处理器返回接受；1：设备前置门控拒绝 |
| 回应其余 3 字节 | stock 没有明确初始化，不能要求全部为零 |
| App 超时 | 10 秒，`Duration@a51D61 = 10,000,000 μs` |
| App 自动重试 | 0 |

`buildAprsSend(packet)` 只构建命令；`parseAprsSendReply(message)` 返回 `{result, accepted, rfDeliveryConfirmed:false, payload}`。未知非零结果也保留数值，不猜其含义。发送动作必须由明确点击触发，且与所有读写操作共享会话串行队列。超时不能自动重试，因为第一次请求可能已经发射。

stock dispatcher `0x08003468` 将 `0x02DD` 交给 `0x080032E4`。处理器先调用 `0x08005574(1)`，结果非零返回 1；结果为零才调用 `0x0800542C(packet, length, 1)`，返回后报告 0。前置函数会检查设备当前状态与可用发射配置，不能仅把所有失败描述为“忙”。对状态字节 `0x200000B3=0` 或 6，原指令直接拒绝；本项目没有给这两个数值编造 UI 状态名称。

发送请求本身不含会话 token，但 Web 仍要求正常连接、用户确认机型、支持的固定固件版本及正常密码认证。不存在通过原处理器参数较少来扩大主机写权限的逻辑。

`0x0800542C` 是实验中的射频边界；实验只捕获参数和包字节，未模拟实际调制、射频输出或远端 ACK。因此结果 0 是设备处理结果，不是 RF 送达证明。

## APRS 被动接收

stock `0x08003644` 在以下两个条件同时满足时，将接收内容通过 transport 2 发给蓝牙模块：

- `0x200023FC == 1`：正常蓝牙开关。装载器 `0x0800F4CC..0x0800F4D6` 从 NOR `0x1301C` 读取该设置。
- `0x20000162 == 3`：模块连接状态。内部模块状态通知 `0x0323` 进入 `0x08002BE8` 后更新此值；Web 不伪造这个内部通知来强制启用接收。

通知命令是 `0x02E1`，payload 固定 132 字节：

| 偏移 | 内容 |
|---|---|
| `+0..1` | u16LE 包长，stock 限到 128 |
| `+2..3` | 未赋值的保留字节，原样保留 |
| `+4..131` | 接收包前缀与剩余未使用空间；只解析包长指定的部分 |

`0x0800420C` 在成功接收 HDLC 帧后，先把长度减去 2，再计算并比较 FCS；验证正确才置接收待处理标志。主循环 `0x0800D098` 调用 `0x08004CA0`，其中 `0x08004CC0` 把已减去 FCS 的长度交给通知函数。所以 `0x02E1` 的包 **不带 FCS**，与发送 API 输入不同。

`parseAprsReceive(message)` 返回原始包、保留字节、传输校验状态、AX.25 头和可识别的消息正文。它不会发送自动回复。长度为 128 时标注 `possiblyTruncated:true`，因为设备可能截掉了更长 RF 包的尾部。原包无法解码时仍保留原始十六进制；不把不可解码数据补成消息。

`ProgrammingSession.onEvent(listener)` 注册独立事件处理器，并返回取消注册函数。会话读取循环先把 `0x02E1` 分流，再尝试匹配正在等待的命令回应。收到 APRS 通知不能完成或取消内存读取、写入、认证、位置同步或 APRS 发送的 pending request。格式不符的 `0x02E1` payload 只增加 `invalidEvents`；某个监听器抛错只增加 `listenerErrors`，不消耗正在等待的回应。外层帧校验失败仍按普通协议错误处理。通知是 stock 的 BLE 路径，本版本并不把普通 USB 上未见通知解释为接收失败。

页面保存最近 200 项本次收发记录，可导出 JSON。接收内容始终作为文本展示，不能执行为网页标记；不能解析的包仍可检查原始字节。接收事件不会自动回复或自动触发发送。消息发送 API `sendAprs(packet)` 与所有内存及认证事务共用串行队列，复制调用方字节，并强制使用 10 秒超时及零重试。

## 实际执行的验证

`tests/reference/replay-live.py` 使用独立提供的固定固件，执行了 24 组 Cortex-M0 原指令案例，记录见 [live-replay.json](evidence/live-replay.json)：

| 原指令案例 | 数量 | 观察结果 |
|---|---:|---|
| HELLO 位置、RTC 参数、challenge、访问标志 | 9 | 3 个 transport × 3 组访问标志；精确位置写入，challenge 更新，所检查访问字节保持 |
| APRS 请求 parser → dispatcher → 门控 → 返回 framing | 6 | 3 个 transport × 门控允许/拒绝；只在允许时到达显式 RF 边界 |
| 真实前置 TX 门控 | 2 | 两个无条件拒绝状态，未替换该函数，无硬件 hook |
| 真实 FCS 消费者 | 2 | 正确 FCS 置待处理标志；改错一位被拒绝；通知不含 FCS |
| 通知启用条件与 0/128/200 字节输入 | 5 | 条件不满足不发；超过 128 字节精确截断 |

Node 测试 `tests/live-codec.test.mjs` 核对 AX.25 特殊位、地址顺序、FCS、ASCII/长度边界、公开的删除与截断、位置半数取整、原始响应逐帧解码及 malformed 通知。测试不把 Mock 或函数级实验视为实机无线通信验收。

`tests/protocol-live-session.test.mjs` 使用明确的合成对端验证新 challenge 认证、基线代次、正常访问门控、通知与请求交错、10 秒单次发送、超时和取消；`tests/ui-dom.test.mjs` 核对逐次预览确认、字段变化失效、被动显示与位置按钮之间不相互触发。这些是主机实现的一致性测试，不替代上表的原指令证据或实机试验。

从仓库父目录重新执行原指令验证：

```sh
PYTHONPATH=k10pro_analysis/deps python uv-k10pro-web/tests/reference/replay-live.py \
  k10pro_analysis/results/K10PRO_ENG_v8.02.16_analysis_only.raw.bin \
  --research-tools uv-k10pro-firmware/tools \
  --output uv-k10pro-web/docs/evidence/live-replay.json
```

仍需真实设备验证：浏览器 BLE 长写和通知时序、手机/模块实时链路、实际 RF 发送接收与已配置频率、目标电台对消息的解释。现有证据不支持完整电路级仿真或 RF 送达承诺。
