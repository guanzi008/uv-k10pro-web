# UV-K10 Pro Web 读写会话与传输协议

本实现针对 **UV-K10 Pro、英文原厂应用固件 8.02.16、参数版本 0、官方 CPS 0.56**。`src/protocol/` 是不依赖运行时第三方包的 JavaScript ES modules，含实际浏览器 I/O、分片帧解析、串行请求、分块读写、超时、取消、备份与写后核对。它不是已经通过实机验收的官方 App/CPS 完整替代品。

`MockTransport` 是明确编写的字节级合成设备模型；原仓库的 Unicorn 实验才执行了原厂 Thumb 指令。两者不能混称“已在真实电台上验证”。本项目没有运行厂商 EXE/APK，没有打包厂商固件、APK、完整参数资产或反编译代码。

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
| `reboot({signal})` | 显式发送 `0x05DD` 后关闭，返回 `rebootConfirmed:false` |
| `close()` | 关闭传输并拒绝当前请求；读完不自动 reboot |
| `MockTransport({memory, ...})` | 合成设备模型，复制所给内存；不访问硬件 |

`signal` 是 `AbortSignal`。一个 session 串行执行完整操作，避免读写 interleave。超时、在途取消、错误帧、地址不匹配或写后不一致均使该 session 失效并关闭传输；继续操作必须创建新 session 并重新 HELLO，不能让延迟 ACK 落入下一个请求。纯参数错误、写前备份保存失败尚未执行设备写入。

`onProgress` 的字段为 `{operation,address,completed,total}`；写进度另带 `physicalBytes`。高地址整扇区恢复产生的物理写字节数可能大于用户修改长度。`onBackup` 是可等待的回调。写中异常带 `mayHaveModifiedDevice` 和真实 `recovery` 字节，允许上层导出恢复材料；代码不在异常后自动重试或回滚。

## 3. 型号、版本、锁定状态

当前写入允许列表固定为 **显式选择 UV-K10 Pro + 回应版本恰为 8.02.16 + 参数版本 0**。修改 `expectedFirmware` 不会将未知固件加入允许列表。未选择型号、型号不一致、未知版本或参数版本，均拒绝写入。未知版本仅能尝试其格式仍匹配的原始读取，不应解码成确定的信道模型。

HELLO 没有得到可用的唯一产品 ID，所以 `identity.modelReportedByDevice` 是 `null`，`hardwareVerified` 是 `false`。该检查不能替代用户查看机身型号；USB VID/PID、`K8 CPS` 产品字符串及参数版本 0 都不能单独证明这是 UV-K10 Pro。

`u8PasswordValid` 来自 stock RAM `0x200001E0`；等于 1 时必须先正常密码认证。认证之前拒绝读写，避免把门控返回的零字节视为存储；其值不在 0/1 时不发送猜测的认证请求。认证成功后保留 `identity.passwordValid=1`（机器确实配置了密码），另外设置 `authenticated:true` 和 `writeEnabled:true`。不能把配置密码标志改为 0 冒充认证成功。

`u8StartLockFlag` 则来自 `0x2000008D`；已静态确认它是 `0x17000` 块的独立写保护条件，**不是普通信道读写的全局密码门控**。因此此标志为 1 时仍允许已经正常授权的普通配置读写。库拒绝直接写 `0x17000..0x18FFF` 保护/凭据块，包括把地址错开一个字节的请求；凭据修改流程仍未开放。没有加入内部工程模式、默认口令、解锁绕过或自动改保护标志。

### 正常密码 MAC / AES 已独立重放

`auth.mjs` 实现了 CPS 的实际专用算法；它不是标准 HMAC，不能直接用 `SHA-256(password)` 代替：

1. trim 后的 UTF-8 密码放进 32 字节零填充缓冲。长度超过 32 字节在本地拒绝。
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
| 所有请求 | 真正的 CRC16/X25(body) | USB/USART1 支持 plain 或 XOR |
| USB/USART1 回应 | 固定 `FFFF` | 随 HELLO 建立的模式 |
| 辅助 USART3 回应 | 真正的 CRC16/X25(body) | 原固件此通道不使用 XOR |

XOR key 为 `16 6C 14 E6 2E 91 0D 40 21 35 D5 40 13 03 E9 80`，循环应用于 body **以及 checksum**，每帧从 body 第一个字节重新开始。外层头尾不 XOR。CPS `makefram` 总是对这部分调用 XOR，因此 Serial/USB 默认 `wireMode:'xor'`。回应固定 `FFFF` 仅标为 `placeholder-unverified`；库绝不会显示为 CRC 校验成功。

两个已确认的内层长度例外必须保留：

| 命令 | 实际 payload | `declared_length` |
|---|---:|---:|
| CPS HELLO `0x02BC` | 24 字节 | 4 |
| CPS WRITE `0x02C5` | 12 字节请求头 + 固定 128 字节数据数组 | 12 |

写入 count 只计算有效数据；数组剩余部分填零。其它命令与回应必须使内层长度和实际 payload 一致。解析器还接受研究仓库独立重放过的自洽 compact 写帧，但发送器使用 CPS 固定数组形态。

`FrameStreamParser` 支持任意分片、一个 chunk 中多帧、噪声和重新寻找帧头，内部缓冲有上限。普通 Serial/USB 最长帧设为 383 字节，严格小于 stock USB 384 字节 ring；BLE 实验适配器保守限制 199 字节。检测到坏候选帧后，正在工作的 session 会停止；独立 parser 则通过 `onError` 报错并继续同步。

## 5. HELLO、读、写、退出

以下偏移从 **body** 第 0 字节计数：

| 命令 | 字段 |
|---|---|
| `02BC` HELLO | `+4 session:u32`、`+8 UTC秒:u32`、余下 16 字节零；实际 body 28 字节 |
| `02BD` HELLO reply | body 56 字节；`+4 version[16]`、`+20 passwordValid:u8`、`+21 startLock:u8`、`+22 paramsVersion:u8`、`+24 challenge[16]`；其余保留 |
| `02C3` READ | `+4 address:u32`、`+8 count:u16`、`+10 reserved:u16=0`、`+12 session:u32` |
| `02C4` READ reply | `+4 address:u32`、`+8 count:u16`、`+10 reserved:u16=0`、`+12 data[count]` |
| `02C5` WRITE | `+4 address:u32`、`+8 count:u16`、`+10 advanceFlag:u8=0`、`+11 reserved=0`、`+12 session:u32`、`+16 data[128]` |
| `02C6` WRITE reply | `+4 address:u32`；body 总长 8 字节，**只有 ACK** |
| `02D5` AUTH | `+4 response[16]`，body 20 字节，declared 16；使用用户明确提供的正常密码 |
| `02D6` AUTH reply | `+4 result:u8`、3 字节保留；body 8 字节，result 0 才成功 |
| `05DD` REBOOT | body 4 字节，declared 0；未确认存在回应 |

CPS `main::Login` 先 `Link(3)`，核对参数版本，必要时进入正常密码验证。读取操作执行各参数块后关闭串口；写操作执行各块后再发 reboot。本库采用严格超时后重新连接的方式，不在同一失步会话自动重试；写完成是否 reboot 由上层显式选择。

完整读写区间必须落在 **`0 <= address < 0x001FF000`** 内，单个请求为 1..128 字节。本机的 25Q32 容量为 32 Mbit，即 4 MiB；这不等于此读写 handler 可访问全部 4 MiB。本库不会将不可读的后半部分填 `FF` 并叫作完整备份。

固件 handler `0x0800320C / 0x0800334C` 的门控细节见原仓库协议文档：session 不匹配、起点超范围可无回应；门控可使 READ 返回零，同时 WRITE 发 ACK 却没有写入。因此成功条件必须包含：

1. 回应命令、完整长度、地址、count 均匹配请求；
2. 实际 READ 回来的字节与预期逐字节一致；
3. 从写区间之外读取的非零 canary，在写后仍与写前一致。

第三项用于避免“请求写零、被门控跳过、门控读又返回零”的假成功。候选 canary 为已知配置地址 `0x11000 / 0x13000 / 0x19000 / 0x20000 / 0` 各 128 字节，避开写区间并要求至少一字节非零。不能找到时返回 `AMBIGUOUS_READ_ACCESS`，不会猜测设备已解锁。它不提供密码学保证，也不能证明模拟未覆盖的射频或硬件行为。

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

存在实际可调用的通知/分片适配器，但 **尚未建立目标型号的默认 GATT profile**。必须明确提供：

```js
const transport = await WebBluetoothTransport.request({
  serviceUuid, writeUuid, notifyUuid,        // 完整 canonical UUID，不猜默认值
  writeMode: 'withResponse',                // 或 withoutResponse，按已观察特征属性选
  wireMode: 'plain',                        // 或 xor，需要从目标链路观察确认
  responseChecksum: 'crc16-x25',             // 或 placeholder，需要从目标链路观察确认
  mtuPayload: 20,                           // 保守分片上限，不声称 Web Bluetooth 可以协商 MTU
});
```

这里的 framing 示例是说明必需选项，不是提供已验证 K10 蓝牙参数。两份多型号 APK 的 libapp 同时存在 FFE1/FFE2/FFE3、FFF1/FFF2/FFF3、FF12 等 UUID，亦有 `K8 BLE enabling notify`、`K8 BLE MTU negotiated` 与 K8 session 字符串；仅靠字符串共存无法把 UUID、写模式及分片路由唯一归给 UV-K10 Pro。没有从其他型号借默认 UUID，也没有将 USART3 直接命名为已确认板载蓝牙接线。

适配器按指定写模式串行写分片，通知交给同一帧 parser，32 KiB 通知队列溢出会明确失败；断线时清理监听与连接。依据：[Chrome Web Bluetooth 文档](https://developer.chrome.com/docs/capabilities/bluetooth)、[Web Bluetooth 规范](https://bluetooth.spec.whatwg.org/)。

## 8. 测试与尚需实机验证的项目

运行 `node --test tests/protocol*.test.mjs`。协议测试覆盖真实 stock sender 黄金帧、独立 Python codec 结果、所有单一切分位置、噪声/坏长度/CRC、随机 session 和 RTC、操作串行化、未知版本拒写、受保护块拒写、备份先于写入、ACK 跳过、全零伪成功、跨两扇区恢复、错误地址、超时、取消和显式 reboot。浏览器适配器的 fake API 测试只检验其 API 调用约定与清理，不替代电台实测。

仍需真实 UV-K10 Pro 与原厂工具对照的项目包括：USB/串口实际时序，驱动及浏览器组合，HELLO 与锁定状态的真实变化，已重放正常密码算法的实机登录，K10 专属 BLE profile 与分片，凭据修改与其它受保护块的官方流程，写完 reboot 后各菜单的读回，以及供电中断后的恢复流程。获得这些证据前，不应把版本相同、模型测试通过或 ACK 收到写成“官方功能完全兼容”。
