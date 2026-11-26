# UV-K10 Pro 硬件归属与 Web 写频边界

更新：2026-11-26。本页把机主确认、固定固件的代码证据和仍待实物核对的事项分开。Web 工作台读取的是 MCU 管理的外部存储；浏览器不能凭型号下拉框确认板上实际焊装。

## 硬件表

| 部件 | 本项目采用的配置/接口 | 依据 | 不能据此确定的内容 |
|---|---|---|---|
| MCU | PY32F071 系列，128 KiB 内置 Flash / 16 KiB SRAM 布局 | 前序固件特征与 Puya 官方定义对应，机主认可 MCU 推定 | 完整订货后缀、封装引脚号与板号 |
| 外部 NOR | 25Q32，32 Mbit /8 = 4 MiB = 4,194,304 B | 机主明确确认密度；样本使用 SPI NOR 指令与 4 KiB 擦除 | 厂商、后缀、JEDEC/SFDP、上半区用途 |
| NOR 总线 | SPI2：PA0 SCK、PA1 MOSI、PA2 MISO、PA3 CS | 原固件读写/初始化证据及芯片 AF 表 | PCB 测试点和实际电气连通性 |
| Si4732 | 可选广播接收路径；PB8/PB9，总线地址 0x11；FM/LW/MW/SW 存台 | 原固件兼容驱动、官方配置分支、广播 loader/saver 重放 | 具体机器是否焊装、复位供电和音频切换接线 |
| BK1080 | 另一广播接收配置，固件该条件强制 FM | CPS 活跃路径与官方 ARM 分支重放 | 板上实际芯片身份及总线实测 |
| 音频功放 `4898` | 音频功放，完整型号待核 | **机主在当前会话补充的标识** | 厂商、前后缀、封装、增益、SHDN、引脚和具体输出规格 |
| LCD | 128×64 单色，SPI1：PA5 SCK、PA7 MOSI、PB2 CS、PF2 D/C | 原固件初始化、页面刷新、图像头与复制代码重放 | 精确控制器、排线针序、实际方向、供电与硬复位 |
| RGB 背光 | PB6 / PA15 / PB5 三路 PWM | 原固件 PWM 初始化与亮度加载重放 | 焊接极性、色序与亮度电气曲线 |
| 按键 | 行 PF8/PB4/PB3/PA14，列 PB15/PB14/PB13/PB12/PA8；PC13 PTT | 前序 53 组扫描/事件状态机重放 | 键帽位置、侧键物理上下序、二极管和排线针序 |
| 主 RF | PF5 SCK、PF6 双向数据、PF9 低有效 CS | 真实三线总线函数执行 | BK4819/BK4829/兼容实现的最终型号 |
| USB | 样本含原生 CDC ACM 路径，VID 36B7 / PID 0001，bulk IN1/OUT2 | 固件描述符与协议 sender | 每个 Type-C 插口的数据线连接；不能据此指定 CH340 等桥接芯片 |
| 蓝牙 | 官方 App 写频存在；Web 适配器需明确 GATT 配置 | 官方应用/产品说明及协议研究 | 具体模块、K10 专属 UUID、MTU 与硬件版本适配 |

前序硬件接口与仿真锚点见固定研究提交
[`7712063`](https://github.com/guanzi008/uv-k10pro-firmware/tree/7712063ec4aa046950ac04bd88174bcc7bb4d863/docs)：
[pinmap](https://github.com/guanzi008/uv-k10pro-firmware/blob/7712063ec4aa046950ac04bd88174bcc7bb4d863/docs/pinmap.md)、
[display](https://github.com/guanzi008/uv-k10pro-firmware/blob/7712063ec4aa046950ac04bd88174bcc7bb4d863/docs/display.md)、
[keypad](https://github.com/guanzi008/uv-k10pro-firmware/blob/7712063ec4aa046950ac04bd88174bcc7bb4d863/docs/keypad.md)、
[hardware-research](https://github.com/guanzi008/uv-k10pro-firmware/blob/7712063ec4aa046950ac04bd88174bcc7bb4d863/docs/hardware-research.md)。

## 为什么不能把 4898 直接写成 LM4898

TI 确实有 [LM4898 官方器件页](https://www.ti.com/product/LM4898)，但候选芯片存在不能证明本板上的 `4898` 就是该器件。当前报告只有四位标识和“音频功放”的用途说明，因此本项目不复用该候选器件的引脚、输出功率或使能极性，不用它推导 MCU GPIO。

下一步需要可读的完整丝印、封装脚数、板卡正反面及必要的连通性测量。这个信息缺口不会影响已经证明的 NOR 存台地址，但会影响第三方固件的扬声器静音/功放使能驱动。

## 配置存储与接收器之间的关系

普通信道、VFO、扫描列表和广播预置都存于外部 NOR 的不同区域。网页先读写 NOR 参数，电台固件再把这些参数应用到主 RF 或广播接收器。Si4732 与 BK1080 的共同 FM 区不是两份独立 EEPROM：同一个 FM 存台在两个能力视图中应显示相同字节。

Si4732 分支支持四个银行；BK1080 分支强制 FM，并归一化其不使用的解调/BFO 字段。切换网页页签只改变编辑视图，不改硬件类型配置。详细的地址、记录结构和真实 ARM 证据见 [radio-memory.md](radio-memory.md)。

## 容量不是编程接口边界

25Q32 的 4 MiB 是存储器容量。样本的主机编程 handler 另有 `<0x1FF000` 范围限制，两者不能互相替代。Web 工作台只读取明确配置区，使用覆盖区间表达缺失内容，不把其余地址伪造成已读取的 FF。

WebUSB、串口和 BLE 还受到浏览器 API、操作系统驱动和服务配置影响。官方浏览器文档：

- [Web Serial](https://developer.chrome.com/docs/capabilities/serial)
- [Web Serial 标准](https://serial.spec.whatwg.org/)
- [WebUSB 与驱动/接口约束](https://developer.chrome.com/docs/capabilities/build-for-webusb)
- [Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)

本项目使用能力检测，不把某个浏览器品牌或系统版本硬编码为已经通过实机测试。
