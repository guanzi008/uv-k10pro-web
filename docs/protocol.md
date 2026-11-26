# UV-K10 Pro Web 读写会话与传输协议

本实现针对 **UV-K10 Pro / K8、英文原厂应用固件 8.02.16、参数版本 0、官方 CPS 0.56 与官方 Android 1.1.0-64 / 68 的 K8 路径**。`src/protocol/` 是不依赖运行时第三方包的 JavaScript ES modules，含浏览器 I/O、帧解析、串行读写、认证、正常凭据变更、位置/RTC 同步和 APRS 发送及接收事件。默认 BLE 配置已由两版 APK 的 AOT 引用链确认；浏览器与真实电台的配合仍需实机验收。

`MockTransport` 是明确编写的字节级合成设备模型。独立 Unicorn 实验分别执行了固件 Thumb 指令、CPS 原生认证库 x86 算术，以及 APK 中的 ARM64 CRC/校验分支代码块；这些实验都有明确的替换边界。它们不能混称“已在真实电台上验证”。本项目没有启动厂商 EXE/APK 或 DLL 初始化，没有打包厂商二进制、完整参数资产或完整反编译代码。

## 1. 证据范围与追溯

协议移植基础来自 MIT 研究仓库 [`guanzi008/uv-k10pro-firmware`](https://github.com/guanzi008/uv-k10pro-firmware)，核对版本 `7712063ec4aa046950ac04bd88174bcc7bb4d863`。关键路径为 `tools/programming_protocol.py`、`tools/emulate_programming.py`、`tools/emulate_stock.py`、`docs/programming-protocol.md` 与其 JSON 证据。该仓库中的帧代码在这里按 MIT 许可转译并在源码标明来源。

| 样本 | SHA-256 / 入口 |
|---|---|
| 官方 `K10PRO_ENG_v8.02.16_publish.bin` | `aa33d01a06c5f013ef46afb6c6a37dd16b15318d0e6409bbadfaba53bdb5ad5b` |
| 解码应用，基址 `0x08002000` | `061759672cc69a1b00420ce6fae67b0756d3db111f8fa4329cadc940dcd17f17` |
| 实际 `UV-K10 Pro.exe`，910336 字节，CPS 0.56 | `79c9b3429187f7fca13cc8971d0e5fd46184f078127f149f333a267b99815132` |
| Android `QUANSHENG-1.1.0-64.apk` | `b12adceddfe49c7df04eab3b8b6dbc336d7a6eb32a0df62bc75b7e978559d048` |
| Android `QUANSHENG-1.1.0-68.apk` | `0395fa0332d025da73a39aad49b01eaedfe59e8296f17df56fa937ff9b83b326` |

厂商来源：[产品页](https://qsfj.com/products/11145)、[英文固件发布条目](https://cms.qsfj.com/api/entries/files/11434?fl-language=en)、[英文 CPS 条目](https://cms.qsfj.com/api/entries/files/11390?fl-language=en)、[Android 条目](https://cms.qsfj.com/api/entries/files/11398?fl-language=en)。版本选择依据实际已下载样本和上述摘要；在线发布条目更新后不能自动扩大本项目的兼容范围。

本轮另外静态核对了这些 .NET IL 方法，以下 token/RVA 只适用于上述 EXE：

| 方法 | Token / RVA | 结论 |
|---|---|---|
| `K7.main::Login` | `060003CF / 0x67AAC` | `Link(3)`、参数版本比较、需要密码时进入正常登录 |
| `K7.protocol_struct::Link` | `060002BC / 0x49CEC` | HELLO 的 28 字节 body、UTC 秒、读取版本与 challenge |
| `K7.protocol_struct::Read` | `060002BD / 0x49E88` | 读命令与 2000 ms 等待 |
| `K7.protocol_struct::Write` | `060002C2 / 0x4A298` | 128 字节固定数组及 declared length 12 |
| `K7.protocol_struct::makefram` | `060002B6 / 0x49934` | 先 CRC，再对 body 与 checksum 作 XOR |
| `K7.protocol_struct::AuthReq` | `060002BA / 0x49B3C` | 正常认证 `0x02D5`，16 字节响应数据，回应 `0x02D6` |
| `K7.protocol_struct::Reboot` | `060002B9 / 0x49AE0` | 发送 `0x05DD`，无 payload、无等待回应 |
| `K7.wfm_progress::backgroundWorker1_DoWork` | `060004E2 / 0x7E5BC` | 读后关端口；写后等待 1000 ms、发送 reboot、再等 500 ms 关闭 |

`K7` 是该目标 EXE 内的命名空间，不代表可以把其他 K7/K8/K82/UV5 产品的参数模型混入目标机。HELLO 的参数版本 0 也不是全球唯一产品编号。

Android 的型号绑定通过实际方法和字段追踪确认：APK 64 的 `K8RadioProtocol.gattProfile` 在 `0xBD6F2C` 调用 `BleGattProfile.k8(0xBD6F44)`；APK 68 的对应调用为 `0xBE82B8 → 0xBE82D0`。两者都在结果对象内存入名称 `UV-K10 Pro` 与 FF12 / FFF2 / FFF3。进一步追踪 APK 68 的服务比较、特征匹配、发送消费者与通知筛选，确定三者分别为服务、TX、首选 RX。详细地址、SHA-256、工具版本和剩余物理限制见 [BLE 证据](ble-profile.md) 与 [AOT 记录](evidence/ble-aot-profile.json)。

## 2. API 与使用顺序

```js
import { ProgrammingSession, WebSerialTransport } from './src/protocol/index.mjs';

// 必须由用户点击触发浏览器设备选择。连接会把当前 UTC 时间传给电台。
const transport = await WebSerialTransport.request({ baudRate: 38400 });
const session = new ProgrammingSession(transport, {
  selectedModel: 'UV-K10 Pro',
  expectedFirmware: '8.02.16',
  expectedParamsVersion: 0,
  timeoutMs: 2000,
});
let identity = await session.connect();
if (identity.passwordValid === 1) {
  // passwordFromUser 只来自用户明确输入，不填默认口令、不自动尝试。
  identity = await session.authenticate({ password: passwordFromUser });
}
const original = await session.readMemory(0x12000, 0x0b10);

// edited 必须来自实际读到的 original，并保留未改字段及 padding。
const edited = original.slice();
// 在这里通过上层字段 codec 修改 edited。
if (identity.writeEnabled) {
  await session.writeMemory(0x12000, edited, {
    onBackup: async ({ address, data, kind }) => {
      // 此异步回调在首次设备写入前完成。可保存为本地备份或下载文件。
      // 回调抛错会阻止本次写入，不会把尚未持久化的备份冒充已保存。
    },
    onProgress: ({ operation, completed, total }) => {},
  });
}
await session.close();
```

| 接口 | 结果 / 语义 |
|---|---|
| `new ProgrammingSession(transport, options)` | 不自动打开设备，不自动发送 HELLO |
| `connect({signal, utcSeconds})` | 建立随机 32 位 session；返回 `identity`；HELLO 同步 RTC |
| `readMemory(address, length, {signal, onProgress})` | 返回 `Uint8Array`，每次最多 128 字节 |
| `writeMemory(address, data, {signal, onProgress, onBackup})` | 先真实备份，再写、逐块读回、验证访问 canary；返回 `{verified, writtenBytes, backups}` |
| `authenticate({password, signal})` | 执行一次正常密码 challenge-response；设备确认后返回更新后的 `identity`；不自动重试 |
| `changeStartupPassword({password, disable, expectedCurrent, signal})` | 独立写入开机数字码；检查正常访问权限、开机锁与可选旧值；验证后关闭会话 |
| `changeProgrammingPassword({currentPassword, newPassword, confirmPassword, signal})` | 核对当前密码、确认新值、普通写入 16 字节 key、读回及新密码 AUTH；验证后关闭会话 |
| `synchronizeLocation({latitude, longitude, altitudeMeters, utcSeconds, signal})` | 显式同步一次位置与 RTC，处理新的 HELLO/challenge，失效旧认证和写入基线 |
| `sendAprs(packet, {signal})` | 一次 APRS 包发送请求；10 秒超时、无重发；设备处理结果不是 RF 送达证明 |
| `onEvent(listener)` | 接收独立的 `aprs-received` 事件，返回取消订阅函数；不消费 pending request |
| `reboot({signal})` | 显式发送 `0x05DD` 后关闭，返回 `rebootConfirmed:false` |
| `close()` | 关闭传输并拒绝当前请求；读完不自动 reboot |
| `MockTransport({memory, ...})` | 合成设备模型，复制所给内存；不访问硬件 |

`signal` 是 `AbortSignal`。一个 session 串行执行完整操作，避免读写 interleave。超时、在途取消、错误帧、地址不匹配或写后不一致均使该 session 失效并关闭传输；继续操作必须创建新 session 并重新 HELLO，不能让延迟 ACK 落入下一个请求。纯参数错误、写前备份保存失败尚未执行设备写入。

`onProgress` 的字段为 `{operation,address,completed,total}`；写进度另带 `physicalBytes`。高地址整扇区恢复产生的物理写字节数可能大于用户修改长度。`onBackup` 是可等待的回调。写中异常带 `mayHaveModifiedDevice` 和真实 `recovery` 字节，允许上层导出恢复材料；代码不在异常后自动重试或回滚。

上表中的普通 `writeMemory` 使用常规恢复备份；凭据专用操作的返回值不包含密码、key 或原凭据恢复字节。它们各自的失败状态与会话关闭规则见 [正常凭据变更](credentials.md)。实时消息的包格式、位置编码与射频边界见 [实时功能](live-functions.md)。

## 3. 型号、版本、锁定状态

当前写入允许列表固定为 **显式选择 UV-K10 Pro + 回应版本恰为 8.02.16 + 参数版本 0**。修改 `expectedFirmware` 不会将未知固件加入允许列表。未选择型号、型号不一致、未知版本或参数版本，均拒绝写入。未知版本仅能尝试其格式仍匹配的原始读取，不应解码成确定的信道模型。

HELLO 没有得到可用的唯一产品 ID，所以 `identity.modelReportedByDevice` 是 `null`，`hardwareVerified` 是 `false`。该检查不能替代用户查看机身型号；USB VID/PID、`K8 CPS` 产品字符串及参数版本 0 都不能单独证明这是 UV-K10 Pro。

`u8PasswordValid` 来自 stock RAM `0x200001E0`；等于 1 时必须先正常密码认证。认证之前拒绝读写，避免把门控返回的零字节视为存储；其值不在 0/1 时不发送猜测的认证请求。认证成功后保留 `identity.passwordValid=1`（机器确实配置了密码），另外设置 `authenticated:true` 和 `writeEnabled:true`。不能把配置密码标志改为 0 冒充认证成功。

`u8StartLockFlag` 则来自 `0x2000008D`；已静态确认它是 `0x17000` 块的独立写保护条件，**不是普通信道读写的全局密码门控**。因此此标志为 1 时仍允许已经正常授权的普通配置读写。通用 `writeMemory` 始终拒绝覆盖 `0x17000..0x18FFF`，包括把地址错开一个字节的请求；文件导入与普通写入计划也不能取得凭据修改权限。

凭据修改现通过两个独立正常 API 实现：`changeStartupPassword` 只修改 `0x17000` 的 4 字节数字码，要求 `startLockFlag == 0`，可用 `expectedCurrent` 核对旧值；`changeProgrammingPassword` 只修改 `0x18000` 的 16 字节 key，已有密码时必须重新核对用户输入的当前密码。两者均发送普通 `flag=0`，保留读取探针和写后逐字节验证；设置新编程密码还会执行新密码 AUTH。成功后关闭会话，要求重新连接读取。没有加入内部工程模式、默认口令、解锁绕过或自动改保护标志。[实现与八组原指令实验](credentials.md)

### 正常密码 MAC / AES 已独立重放

`auth.mjs` 实现了 CPS 的实际专用算法；它不是标准 HMAC，不能直接用 `SHA-256(password)` 代替：

1. 按 CPS 的 .NET `Trim` 字符集规范化后，将 UTF-8 密码放进 32 字节零填充缓冲。长度超过 32 字节在本地拒绝；不采用 JavaScript 对 U+FEFF 的额外 trim 行为。
2. 128 字节缓冲初始填 `0x5A`，前 32 字节替换为密码缓冲，`+32` 放 `xiaoxiao`，`+64` 放 CPS 的固定 32 字节协议常量。
3. 对前 108 字节逐 32 位字翻转字节序，输入长度固定 119。原生库使用 SHA-256 的压缩过程，但**最后一块不进行 state feed-forward 相加**，最终 32 字节摘要整体反转。
4. `key[i] = digest[i] XOR digest[31-i]` 得到 16 字节 key。key 与 HELLO 的 challenge 均按 32 位字翻转后，使用 AES-128 CBC、全零 IV；只取首个 16 字节密文块，再逐 32 位字翻转作为 `0x02D5` payload。
5. 要求 `0x02D6` payload 正好 4 字节，result 字节等于 0 才启用已认证会话。失败立即关闭该会话，不自动重试。stock 有失败计数状态；工具不尝试清除它。

实际原生库名为 **`ss.dll`**，SHA-256 `61a2cef101c4325a622d163edffa35f17c82b33cf4ed3847bd4eaa9a1920581d`。`_set_secret@4` 位于 `0x10001000`，`_ComputeMAC256@12` 位于 `0x10001030`。固定协议常量来自上述 CPS 的 FieldRVA `0x42C08`，并非用户密码或内部替代口令。

六组合成密码（含空串、两端空格、中文和 32 字节输入）已经逐层验证：

- Unicorn x86 在限定映射中执行原生算术函数，每组 12719 条 MAC 指令；仅把 `memcpy` 替换为受约束的内存拷贝。没有执行 `DllMain`、Windows API 或主机上的厂商 DLL。
- JavaScript 的完整 digest、key、AES response 与这六组向量逐字节一致。
- stock Cortex-M0 的 `0x08005F28` 真实软件 AES 校验对六组正确响应返回 0，对单比特错误响应返回 1；这个步骤没有硬件 hook。
- stock `0x08002E28` 的**正常已配置密码分支**接受这些正确响应，生成 `d602040000000000`，并将 secondary gate `0x200000BB` 清零；唯一 hook 是捕获发送 body，不访问真实传输。没有尝试内部备用或工程密码路径。

向量与指令计数见 [`auth-vectors.json`](../tests/fixtures/auth-vectors.json)。复现实验需自行提供准确摘要的厂商样本及研究仓库的 `StockEmulator`：

```sh
python tests/replay_auth.py --dll /path/to/ss.dll --cps /path/to/UV-K10-Pro.exe \
  --research-tools /path/to/uv-k10pro-firmware/tools \
  --raw-firmware /path/to/8.02.16.raw.bin --output /path/to/auth-vectors.json
```

此可选研究脚本使用 `unicorn`、`pefile`、`dnfile` 和 `cryptography`；Web 应用没有这些运行时依赖。浏览器 AES 使用 [W3C Web Crypto AES-CBC](https://www.w3.org/TR/webcrypto-2/)；其 PKCS#7 附加块不发送，和 CPS 的 `Take(16)` 一致。密码不写日志、文件或浏览器存储；真实电台上的正常登录仍需硬件验收。

## 4. 帧格式、CRC 与 XOR

多字节整数小端：

```text
AB CD | body_length:u16 | command:u16 | declared_length:u16 | payload | checksum:u16 | DC BA
```

`body_length` 包含 4 字节命令头。请求 checksum 是 CRC16/X25：反射多项式 `0x8408`，初值 `0xFFFF`，最终 XOR `0xFFFF`；`123456789` 的 check 是 `0x906E`。这与固件升级文件的 CRC16/XMODEM 不同。本项目实现的是编程器访问外部 Flash，不是固件升级器。

| 传输方向 | 校验字段 | 混淆 |
|---|---|---|
| 所有请求 | 真正的 CRC16/X25(body) | 由所选 profile 确定，K8 BLE 默认 plain，CPS 默认 XOR |
| USB/USART1 回应 | 固定 `FFFF` | 随 HELLO 建立的模式 |
| 辅助 USART3 回应 | 真正的 CRC16/X25(body) | 原固件此通道不使用 XOR |
| Android K8 接收规则 | `FFFF` 直接接受；其他值必须通过 CRC16/X25 | plain |

XOR key 为 `16 6C 14 E6 2E 91 0D 40 21 35 D5 40 13 03 E9 80`，循环应用于 body **以及 checksum**，每帧从 body 第一个字节重新开始。外层头尾不 XOR。CPS `makefram` 总是对这部分调用 XOR，因此 Serial/USB 默认 `wireMode:'xor'`。上述辅助串口是固件软件路径证据，不能单凭此表确定板上蓝牙模块的物理接线。

BLE 默认 `responseChecksum:'crc16-x25-or-placeholder'` 精确对应 APK 68 `K8FrameCodec.decode(0x771538)` 的两条分支。收到 FFFF 时返回 `placeholder-unverified` 与 `crcVerified:false`；其他校验字必须与 X25 一致。实际计算结果恰等于 FFFF 时，兼容响应模式仍把这一可跳过校验的字段标为未验证。请求方向始终验证真实 CRC；原来的严格 X25 和仅占位两种配置也保留。[40 项原指令 CRC/分支实验](evidence/ble-crc-replay.json)

两种官方客户端的内层长度声明不同，发送时按 transport 的 `lengthConvention` 选择：

| 命令 | 实际 payload | `cps-0.56` 声明长度 | `android-k8` 声明长度 |
|---|---:|---:|---:|
| HELLO `0x02BC` | 24 字节 | 4 | 24 |
| READ `0x02C3` | 12 字节 | 12 | 12 |
| WRITE `0x02C5` | 12 字节头 + 固定 128 字节数据数组 | 12 | 140 |

写入 count 只计算有效数据；数组剩余部分填零。Android 的 WRITE 也保持整个 140 字节 payload，不能误改成 `12 + count`。`buildHello` 的第三参数、`buildWrite` 的第四参数接收 `{lengthConvention}`；未指定时保持 CPS。会话自动从 `transport.protocolProfile` 继承并用于普通写入与凭据专用写入。解析器还接受研究仓库独立重放过的自洽 compact 写帧，但两个默认发送方言都使用固定 128 字节数据槽。[APK 分配和字段证据](ble-profile.md#4-帧编码与请求长度方言)

`FrameStreamParser` 支持任意分片、一个 chunk 中多帧、噪声和重新寻找帧头，内部缓冲有上限。普通 Serial/USB 最长帧设为 383 字节，严格小于 stock USB 384 字节 ring；BLE 适配器保守限制 199 字节。检测到坏候选外层帧后，正在工作的 session 会停止；独立 parser 则通过 `onError` 报错并继续同步。合法帧中的异步 APRS 通知先进入事件处理，不拿它匹配内存或认证的回应。

## 5. HELLO、读、写、退出

以下偏移从 **body** 第 0 字节计数：

| 命令 | 字段 |
|---|---|
| `02BC` HELLO | `+4 session:u32`、`+8 UTC秒:u32`；普通连接后 16 字节为零，位置同步使用这 16 字节；实际 body 28 字节 |
| `02BD` HELLO reply | body 56 字节；`+4 version[16]`、`+20 passwordValid:u8`、`+21 startLock:u8`、`+22 paramsVersion:u8`、`+24 challenge[16]`；其余保留 |
| `02C3` READ | `+4 address:u32`、`+8 count:u16`、`+10 reserved:u16=0`、`+12 session:u32` |
| `02C4` READ reply | `+4 address:u32`、`+8 count:u16`、`+10 reserved:u16=0`、`+12 data[count]` |
| `02C5` WRITE | `+4 address:u32`、`+8 count:u16`、`+10 advanceFlag:u8=0`、`+11 reserved=0`、`+12 session:u32`、`+16 data[128]` |
| `02C6` WRITE reply | `+4 address:u32`；body 总长 8 字节，**只有 ACK** |
| `02D5` AUTH | `+4 response[16]`，body 20 字节，declared 16；使用用户明确提供的正常密码 |
| `02D6` AUTH reply | `+4 result:u8`、3 字节保留；body 8 字节，result 0 才成功 |
| `02DD` APRS SEND | `+4 packetLength:u16`、`+6 reserved:u16=0`、`+8 packet[128]`；固定 payload 132，输入包带 FCS |
| `02DE` APRS result | `+4 result:u8`、3 字节未初始化保留；payload 4，result 0 表示处理器接受，无远端送达确认 |
| `02E1` APRS RECEIVE | `+4 packetLength:u16`、`+6 reserved[2]`、`+8 packet[128]`；异步通知；包中 FCS 已被电台验证并去除 |
| `05DD` REBOOT | body 4 字节，declared 0；未确认存在回应 |

CPS `main::Login` 先 `Link(3)`，核对参数版本，必要时进入正常密码验证。读取操作执行各参数块后关闭串口；写操作执行各块后再发 reboot。本库采用严格超时后重新连接的方式，不在同一失步会话自动重试；写完成是否 reboot 由上层显式选择。

完整读写区间必须落在 **`0 <= address < 0x001FF000`** 内，单个请求为 1..128 字节。本机的 25Q32 容量为 32 Mbit，即 4 MiB；这不等于此读写 handler 可访问全部 4 MiB。本库不会将不可读的后半部分填 `FF` 并叫作完整备份。

固件 handler `0x0800320C / 0x0800334C` 的门控细节见原仓库协议文档：session 不匹配、起点超范围可无回应；门控可使 READ 返回零，同时 WRITE 发 ACK 却没有写入。因此成功条件必须包含：

1. 回应命令、完整长度、地址、count 均匹配请求；
2. 实际 READ 回来的字节与预期逐字节一致；
3. 从写区间之外读取的非零 canary，在写后仍与写前一致。

第三项用于避免“请求写零、被门控跳过、门控读又返回零”的假成功。候选 canary 为已知配置地址 `0x11000 / 0x13000 / 0x19000 / 0x20000 / 0` 各 128 字节，避开写区间并要求至少一字节非零。不能找到时返回 `AMBIGUOUS_READ_ACCESS`，不会猜测设备已解锁。它不提供密码学保证，也不能证明模拟未覆盖的射频或硬件行为。

### 实时会话、异步通知与基线失效

`synchronizeLocation` 与内存操作共用串行队列，并要求正常的精确型号和访问权限。它发送携带位置的 HELLO，同时同步 RTC；stock 会保存活动位置并重生成 challenge。会话解析新的 `0x02BD` 后重新检查身份、替换 challenge、清除旧认证并增加 `baselineGeneration`。如果配置了编程密码，继续读写前要用新 challenge 正常认证。

返回值包含 `baselineInvalidated:true`、`authenticationRequired` 和新 `identity`。工作台成功同步后更换应用层 `sessionId`、清除写入计划和 APRS 发送预览；旧工作区保留为可查看的本地数据，但无法通过 `executeWritePlan` 的当前会话检查。再次写配置前必须重新从设备读取。直接使用库的调用者也应按 `baselineGeneration` 或该返回标志撤销旧基线与计划；协议库不会替调用者管理外部工作区。

`sendAprs(packet)` 只发送一次，等待 `0x02DE`，使用 App 的 10 秒超时。它与所有读写共享队列，不自动重发，结果始终带 `rfDeliveryConfirmed:false`。消息预览和构包由 `src/core/aprs-frame.mjs` 完成；Web 的明确发送动作可能启动实际射频发送，不能把调用它当作链路测试。

`onEvent(listener)` 订阅独立接收事件，返回取消订阅函数。读取循环在匹配 pending request 之前分流 `0x02E1`，所以接收通知不会结束、误匹配或取消 READ/WRITE/AUTH/HELLO/APRS SEND。格式错误的通知 payload 计入 `invalidEvents` 后丢弃；同步 listener 抛错计入 `listenerErrors`。坏外层帧仍按整个传输失步处理。关闭会话清除监听器。stock 的通知发送只走已启用且已连接的蓝牙 transport 2；USB 上没有通知不能直接解释为 RF 接收失败。[字段、门控与 24 组原指令实验](live-functions.md)

## 6. Flash 擦除模式与真实备份

stock 在地址 `<0x50000` 使用保留邻居的 4 KiB sector RMW 模式；`>=0x50000` 使用用于连续资源写入的另一模式。后者在需要擦除时只恢复写入位置以前的前缀，**扇区中本次写入以后原有数据可能变为 `FF`**。将它当作任意地址 byte patch 会损坏尾部。

本库对此做了实际处理：高区修改先读完整 4 KiB、合并修改、依地址递增重写所有 128 字节块，并在最后核对整个扇区。跨扇区时每个扇区都有真实备份。低区只写发生变化的块，但也先读原始目标区，并且从不发送跨 4 KiB 边界的单条写命令。

这不是原子事务。断电、拔线或取消发生在多块写之间，设备可能保留部分新数据；异常会保留 `recovery`。上层 UI 应先保存备份，默认只开放已经解析的低区配置。高区 RMW 在合成 NOR 行为模型中验证，不代表屏幕资源格式或实机断电恢复已经验证。

## 7. 浏览器传输

### Web Serial

`WebSerialTransport.request({baudRate:38400})` 使用 38400、8 data bits、1 stop bit、无 parity、无 flow control；RTS/DTR 关闭。38400 来自目标 CPS 配置；这不是声称原生 USB 总线以 38400 bit/s 传输。请求设备必须由用户交互触发，应用需安全上下文（HTTPS 或 localhost）。实现持有一个 reader/writer，关闭时取消、释放锁、再关闭端口。

依据：[Chrome Web Serial 文档](https://developer.chrome.com/docs/capabilities/serial)。桌面 OS 已以 CDC 串口驱动管理的设备通常应走 Web Serial。

### WebUSB CDC

`WebUsbTransport.request()` 过滤 `VID 36B7 / PID 0001` 并再次检查配置、接口、endpoint：配置 1，通信接口 0 为 CDC ACM，数据接口 1 为 `0A` 类，bulk OUT endpoint 2 / IN endpoint 1。传入 WebUSB 的 endpoint number 是 1，不是带方向位的 `0x81`。

打开后 claim 接口、设置 alternate、发送 CDC `SET_LINE_CODING(0x20)` 与 `SET_CONTROL_LINE_STATE(0x22)`。实际 I/O 用 `transferOut(2, bytes)` 和 `transferIn(1,64)`，核对状态与写字节数。OS 驱动或浏览器可能不允许 claim；此时失败并释放设备，不建议为本工具替换系统驱动。应优先尝试 Web Serial。

上述 USB 描述符来自固件静态解析，不是实机枚举记录。依据：[Chrome WebUSB 文档](https://developer.chrome.com/docs/capabilities/usb)、原仓库 `static_usb_descriptors` 证据。

### Web Bluetooth

`DEFAULT_K8_BLE_PROFILE` 已从官方两版 APK 的 K8 AOT 引用链恢复。通过用户操作选择目标设备，然后把该预设传给适配器：

```js
import { DEFAULT_K8_BLE_PROFILE, WebBluetoothTransport, ProgrammingSession }
  from './src/protocol/index.mjs';

const transport = await WebBluetoothTransport.request({ ...DEFAULT_K8_BLE_PROFILE });
const session = new ProgrammingSession(transport, { selectedModel: 'UV-K10 Pro' });
const identity = await session.connect();
// 有编程密码时先执行一次用户提供密码的正常认证，再读取当前设备基线。
```

预设为 FF12 服务、FFF2 TX、FFF3 RX，完整 UUID 后缀均为 `-0000-1000-8000-00805f9b34fb`；采用 `withResponse`、`plain`、`crc16-x25-or-placeholder` 与 `android-k8` 长度方言。连接时再次确认 TX 的 `write` 属性与 RX 的 `notify/indicate` 属性。UUID 绑定正确也不代表 UUID 具有机型唯一性，仍需用户确认机身型号和现有 HELLO 身份检查。

官方 App 先请求 MTU 253，失败再请求 78；K8 帧超过有效负载时走单次长值写入，帧后等待 120 ms。默认 Web 策略据此设置 `writeStrategy:'whole-frame'`、`interWriteDelayMs:120`，将完整帧交给 `writeValueWithResponse()`。Web Bluetooth 不提供对应的 MTU/allowLongWrite 控制，浏览器与目标设备的长值写入互操作仍待实机验证；适配器不声称协商过该 MTU，也不会在失败后自动拆片重发。

明确的手工 profile 可选择 `chunked`，分片负载 1..244；默认整帧模式忽略 `mtuPayload`。通知进入同一有界帧流，32 KiB 队列溢出会失败；所有写入保持顺序，关闭或断开清理监听并阻止旧连接排队数据写进新连接。

`discoverBleCharacteristics({serviceUuid, device?})` 只枚举明确指定服务的特征与真实属性，不读取特征、不订阅、不发送命令；完成即断开。发现和普通连接都使用 `acceptAllDevices:true` 与仅含明确服务的 `optionalServices`，和 APK 68 空服务过滤列表的扫描行为一致，不额外要求广播中出现 FF12。选中后仍严格取得指定服务和特征，不自动探测候选服务。`request({...profile, device})` 可复用该授权设备句柄并重新获得 GATT 对象。`serializeBleProfile` / `parseBleProfile` 支持有型号、版本和字段校验的 JSON；不保存设备句柄、ID、密码或会话。选定服务的发现能力不会被当作已识别机型。

调用链、允许枚举、FFF1 未使用结果、通知筛选与可复现实验见 [完整 BLE 说明](ble-profile.md)。浏览器依据：[Chrome Web Bluetooth 文档](https://developer.chrome.com/docs/capabilities/bluetooth)、[Web Bluetooth 规范](https://webbluetoothcg.github.io/web-bluetooth/)。

## 8. 测试与尚需实机验证的项目

运行 `node --test tests/protocol*.test.mjs tests/ble-*.test.mjs tests/live-codec.test.mjs`。测试覆盖 stock sender 黄金帧、两种请求长度方言、真实 CRC/FFFF 混合响应、分片/噪声/坏长度、正常认证、凭据 API 的专属守卫、先备份后写、ACK 跳过、门控零数据、跨扇区恢复、错误地址、超时、取消、显式 reboot、位置同步后的 challenge/认证失效，以及 APRS 通知与 pending request 的分流。浏览器适配器的合成 API 测试检查配置、调用边界、120 ms 顺序、失败和重连清理，不替代电台实测。

原指令实验分别记录在 [认证向量](../tests/fixtures/auth-vectors.json)、[正常凭据变更](evidence/credentials-replay.json)、[BLE CRC/校验分支](evidence/ble-crc-replay.json) 与 [实时功能](evidence/live-replay.json)。其中 8 组凭据案例执行真实 key 重新加载和正常 AUTH；40 项 APK ARM64 案例执行 CRC 算术和校验比较；24 组实时案例执行位置、通知、FCS 消费和发送门控，射频调用有明确替换边界。

仍需真实 UV-K10 Pro 与原厂工具对照的项目包括：USB/串口实际时序、驱动及浏览器组合、已恢复 BLE 服务的实际特征属性和长值写入、密码与开机锁的完整设备流程、写后 reboot 后菜单读回、位置同步实际时序、真实 RF 发送/接收及断电后的恢复。未知受保护区域未被开放。版本匹配、原指令块重放通过、合成模型成功或收到 ACK，均不能单独证明设备已达到预期状态。
