# K8 NOAA 与 SAME：已证路径和残留结构

当前样本可以确认并实现 **NOAA 静噪与搜台设置**。CPS 中还存在 SAME 地址、事件、发送内容等结构及界面代码，但没有找到这些结构进入当前 K8 活跃读写流程的证据。因此这里没有为 SAME 表分配猜测的 Flash 地址，也不把它描述为已经确认存在而尚未实现的 K10 Pro 功能。

## 样本边界

本次静态检查覆盖固定官方 UV-K10 Pro CPS 0.56 主程序中的全部有 IL 方法，以及官方分发的两个 K8 APK 配置。仅发布独立整理的结构事实、方法标识和结论；不包含原 EXE、完整 JSON、语言资源或原始 IL。

| 样本 | SHA-256 |
|---|---|
| UV-K10 Pro CPS 0.56 EXE | `79c9b3429187f7fca13cc8971d0e5fd46184f078127f149f333a267b99815132` |
| APK 64 包 K8 配置资产 | `5df044c86a2a2eee8fd4b709bf47c1a6cfeb030b30d23c3010b09f19593dfc5f` |
| APK 68 包 K8 配置资产 | `7b8cb1c712251fd892101f3650571ecf8992d285f82b9518c730402e9909a2a5` |

EXE 的 .NET 命名空间叫 `K7`，这不是将结构移用于另一个产品的依据；本文始终以该固定 K10 Pro 样本及协议 K8 的实际路径为判断范围。

## 已实现的 K8 NOAA 设置

| 地址 | 字段 | 存储与范围 | API |
|---|---|---|---|
| `0x13001` | NOAA 静噪 | `u8`，0..9 | `noaa_squelch` |
| `0x13003` | NOAA 搜台 | `u8`，0 手动、1 自动 | `noaa_search` |

两版 K8 APK 的 `noaa` 组都只声明上述两个字段。CPS 的 `CPS_GEN_INFO`（`0200007B`）含对应 `Noaa_sq`、`NoaaScan` 字节；`ConvertCpsGenParam` / `ConvertGen1Param`（`06000032` / `06000033`）进行转换，搜台列表 `06000314`（RVA `0x4BDB0`）的顺序是手动、自动。它们随 `0x13000` 的 296 字节常规参数块传输。

现有 `settings-codec.mjs` 读取未知值时保留原始字节，显式写入时限定范围。测试确认仅改动这两个字节，不影响中间的发射限时参数。

## CPS 中存在、但未建立 K8 存储关联的结构

以下布局由 `Pack=1` 和固定数组 marshaling 元数据计算。它们是 **托管程序结构**，不能据此推出设备 Flash 布局。

| 结构 token | 结构 | 已知布局 | 静态初始化容量 |
|---|---|---|---:|
| `0200007D` | `CPS_NOAA_SAME_INFO` | `same: byte[128]`，总 128 B | 4 项 |
| `0200008B` | `CPS_NOAA_DECODE_ADDR` | `addr: byte[8]`、`info: byte[32]`，总 40 B | 16 项 |
| `0200008C` | `CPS_NOAA_SELF_EVENT_SW` | `flag: byte[100]`，总 100 B | 未找到实例使用 |
| `0200008D` | `CPS_NOAA_EVENT` | `seq: Int32`、`number: u8`、保留 3 B、四组 `byte[8]`，总 40 B | 32 项 |

事件结构四组字节分别标作 `duration`、`date`、`event_befor_org`、`event_current_org`。残留转换器仅按字符串数组赋值，没有足够证据将它们解释为秒、日期整数或设备事件寄存器。SAME 地区编码的通用协议知识也不能替代 K8 固件的具体地址与编码证据。

## 为什么没有增加 SAME 写入器

扫描该 EXE 的全部静态 IL token 引用得到：

| 对象 | 静态引用结果 |
|---|---|
| `main.CpsNoaaSame`，字段 `0400055E` | 仅 `main..cctor`（`06000453`）初始化一次 |
| `main.CpsNoaaEventInfo`，字段 `04000561` | 仅同一静态构造器初始化一次 |
| `main.CpsNoaaDecodeAddr`，字段 `04000560` | 静态构造器一次；`ConvertNoaaDecodeAddr`（`060003EE`）两次 |
| `ConvertNoaaDecodeAddr`（`060003EE`，RVA `0x68F14`） | 没有静态 IL 调用者 |
| 单条地址转换器（`060003EF`，RVA `0x68F88`） | 仅由上面的未调用转换器调用 |
| `ConvertNoaaEvent`（`060003F0`，RVA `0x69010`） | 没有静态 IL 调用者 |
| `CPS_NOAA_SELF_EVENT_SW` 类型 `0200008C` | 没有方法 IL token 引用 |

主编程流程 `wfm_progress.backgroundWorker1_DoWork`（`060004E2`，RVA `0x7E5BC`）列出了普通信道、VFO、广播、常规参数、扫描、联系人、APRS、预制消息等实际读写调用，没有 SAME 表传输调用。`CPS_GEN_INFO`、`CPS_GEN2_INFO` 也没有旧界面 `GEN_INFO.same_decode` / `same_event` / `same_addr` 的对应存储字段。

这支持“当前样本没有建立活跃 K8 SAME 编程路径”的判断，并不证明固件绝对没有 SAME 实现。静态 token 引用检查不能排除未观察到的反射路径、其他正式版本或独立设备接口。若后续发现当前 K8 的读写抓包、官方升级版本或固件消费者，可在同一型号边界内继续补齐。

## 后续核验所需证据

新增 SAME 编辑器之前，需要确认至少一条完整的数据链：该 K8 版本的界面操作对应设备编程命令与地址，或参考固件中的消费者/保存器读写同一确定布局。最有用的是操作前后的实际 Flash 差分、该操作的完整请求/响应，以及能定位到固定固件版本的调用点。当前阻碍是缺少这条数据链；仅凭另一个型号的功能页面、同名结构或更换地址常量都不能解决。

实现状态在 `UNRESOLVED_FEATURES` 中保持无地址条目。`readUnresolvedBuffer('noaa_same')` 因没有已证固定区间而拒绝操作，避免从任意区间返回看似正确的 SAME 数据。
