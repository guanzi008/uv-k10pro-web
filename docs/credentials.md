# 正常凭据变更

工作台提供独立的开机数字密码和编程密码操作。它们使用当前设备的正常访问权限，不通过信道导入、项目合并或通用写入计划修改凭据。通用 `writeMemory` 仍拒绝 `0x17000..0x18FFF` 的任意覆盖写入。

## 开机数字密码

```js
await session.changeStartupPassword({
  password: '123456',
  expectedCurrent: previouslyReadUint32,
  signal,
});

await session.changeStartupPassword({ disable: true, expectedCurrent, signal });
```

当前 CPS 的 `GetPwronPassword`（token `060003F1` / RVA `0x69100`）把十进制数字转换为 32 位无符号整数，按小端序放在 `0x17000`。关闭值是 `FF FF FF FF`。工作台接受 1–6 位十进制数字；前导零不会成为独立的存储信息。

操作要求正常的已认证读写权限；如果 HELLO 报告 `startLockFlag != 0`，在写入前拒绝。所有实际请求都使用普通 `flag=0`，没有使用工程覆盖标志。若传入 `expectedCurrent`，重新读取的值必须与该基线一致。

原指令实验确认：当保护标志为 1 时，普通写命令可以收到 ACK，但 `0x17000` 并不改变。因此不能把 ACK 单独当成成功。

## 编程密码

```js
await session.changeProgrammingPassword({
  currentPassword: 'current user-supplied password',
  newPassword: 'new user-supplied password',
  confirmPassword: 'new user-supplied password',
  signal,
});
```

新密码和确认密码都为空时，明确清除编程密码。字符串按照 CPS 的 .NET `Trim` 字符集规范化，规范化后最多 32 个 UTF-8 字节；不使用 JavaScript `trim()` 对 U+FEFF 的额外行为。

当前 CPS 的 `Passwrod.modify_password`（保留原程序拼写，token `06000091` / RVA `0x3D9DC`）提供正常旧密码认证、新密码派生和存储流程：新密码先经过与登录一致的自定义 MAC，再将 32 字节摘要折叠为 16 字节 key，写到 `0x18000`。清除时写入 16 个 `FF`。

工作台实现的正常路径是：

1. 核对精确机型选择、固件及参数版本，验证新密码确认和长度。
2. 如果设备已有编程密码，使用用户输入的当前密码进行一次正常 AUTH；即使本次会话此前已登录，也重新检查当前密码。
3. 如果设备没有编程密码，使用其已有的正常开放访问状态，不发送任何内置、工厂或工程口令。
4. 读取目标原值，并在目标外选择非零读取探针，确认读访问没有被门控为零数据。
5. 普通 `flag=0` 写入精确的 16 字节；检查 ACK、回读数据和读取探针。
6. 设置或更换密码后，使用新密码和本次 HELLO challenge 再次执行正常 AUTH，确认固件确实采用新 key。
7. 关闭会话，要求重新连接读取，防止旧认证状态和旧工作区基线继续用于写入。

当前样本在修改 `0x18000` 后会执行真实的 `0x0800F288` 加载函数；它把新 key 读入 RAM，并更新密码有效状态。新密码认证验证依赖这条实际行为，不能只在模拟设备中更新一个布尔值来证明。

## 返回值与失败处理

成功返回包含 `verified`、`changed`、`kind`、`disabled`、`reconnectRequired`，不返回密码、摘要、key 或原凭据备份。前后相同时可以返回 `changed:false`；仍关闭会话。

这些独立操作的密码输入和派生 key 不进入工作区编辑、日志或常规恢复快照。原有配置读取或 DAT 文件中包含的开机数字码字节仍按其备份语义保留，不作为自动修改凭据的授权。协议函数的临时字节缓冲在使用后清零；JavaScript 字符串与浏览器垃圾回收不提供可证明的全内存清除保证。界面在提交和关闭时清空密码输入。

错误旧密码不会触发写入或自动重试。写后回读或新密码验证失败，会停止并关闭会话，设置 `mayHaveModifiedDevice`，不自动回滚、不反复尝试密码。用户应重新连接并核对设备状态。

## Android K8 路径的两处差异

以下结论来自 `QUANSHENG-1.1.0-68.apk` 的 K8 AOT 数据流，地址为该样本 `libapp.so` 的 ARM64 虚拟地址；样本 SHA-256 见 [ble-aot-profile.json](evidence/ble-aot-profile.json)。未据其他型号路径推断，也未运行 Android 界面。

- `value_format.dart` 的 `k8PowerOnPasswordWrite`（`0x64B790`）同样写 4 字节小端整数，空值写 `FF×4`。但 `k8PowerOnPasswordRead`（`0x64B8F8`）先检查**首字节是否为 `FF`**，再检查完整整数是否超过 `999999`；因此 `255`、`511` 等低字节为 `FF` 的有效数字码会被 App 显示为空。Web 按完整 `uint32` 及 `0xFFFFFFFF` 关闭值判断，不复制这一显示缺陷。
- `k8_session.dart` 的 `ensureCanRead`（`0xBE04C0`）仅检查是否已有 HELLO 状态；`ensureCanWriteOrReboot`（`0xBDED24`）才检查 `passwordValid == 0` 或 `authenticated`。固件在未获正常读权限时可能回传门控零数据，因此 Web 在有编程密码时先完成正常 AUTH，再建立可信读取基线；这项权限判断不以 App 能发出 READ 为充分依据。

## 原指令实验

固定参考明文固件 SHA-256：`061759672cc69a1b00420ce6fae67b0756d3db111f8fa4329cadc940dcd17f17`。

`tests/reference/replay-credentials.py` 使用合成 NOR 和既有自定义 MAC/AES 测试向量，实际执行官方 parser、dispatcher、写入 handler、读改写函数、**未替换的 `0x0800F288`**、正常认证 handler 与 AES 比较。只替换三种底层 NOR 操作、传输发送、UI 重绘和延迟。

八个实验均通过，结果见 [credentials-replay.json](evidence/credentials-replay.json)：

| 实验 | 已验证结果 |
|---|---|
| 无编程密码 → 设置 | 无内置认证输入；普通写成功，密码有效状态由 0 变 1；新正常 AUTH 成功 |
| 已有密码 → 更换 | 旧正常 AUTH 成功；key 持久化、真实加载、新正常 AUTH 成功 |
| 已有密码 → 清除 | 写 `FF×16` 后密码有效状态由 1 变 0 |
| 开机锁标志存在时修改编程密码 | 当前样本仍允许 `0x18000` 的正常认证后写入；不借此修改开机锁 |
| 设置开机数字码 | `0x17000` 四字节普通写与回读一致 |
| 清除开机数字码 | `FF×4` 普通写与回读一致 |
| 开机锁保护下普通写 | 有 ACK，存储未变化；客户端对应操作在发包前拒绝 |
| 错误当前编程密码 | 正常认证拒绝，实验在写入前停止 |

每个允许写入的案例都比较整片合成 NOR，确认目标之外的字节保持原样；真实加载前后的 challenge 也保持一致。实验显式提供会话和开机锁状态，没有模拟开机解锁界面、完整复位、真实 USB/BLE 链路或物理 Flash 时序。

可重复执行：

```sh
python tests/reference/replay-credentials.py \
  --research-tools /path/to/uv-k10pro-firmware/tools \
  --raw-firmware /path/to/stock.raw.bin \
  --output /path/to/credentials-replay.json
```

需要已有研究仓库的 Unicorn 依赖及 `cryptography`。原固件与 DLL 不随 Web 项目分发。
