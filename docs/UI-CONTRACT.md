# Web 工作台 UI 合同

`src/ui/workbench.mjs` 不依赖 codec 或传输模块。`index.html` 只加载 `src/app.mjs`，由应用入口挂载：

```js
import { mountWorkbench } from './ui/workbench.mjs';
const ui = mountWorkbench({ onAction: async (type, payload) => { /* controller */ } });
ui.render(model);
```

## 显示模型

`render` 接受完整模型或部分更新，未提供的顶层字段保留；workspace、connection、radio、capabilities 的子字段合并。需要清除进度时显式传 connection.progress=null。列表中任何用户/设备文本都作为纯文本显示。

```js
{
  workspace: {
    id: 'unique-import-or-session-id', // 改变时清空表格选择及未应用的设置表单草稿
    name: '设备备份.bin', mode: 'empty'|'demo'|'offline'|'device',
    bytes: 4194304, dirtyBytes: 0, modifiedCount: 0,
    complete: false, description: '', canUndo: false, canRedo: false, clipboardCount: 0
  },
  connection: {
    state: 'disconnected'|'connecting'|'connected'|'error',
    label: 'UV-K10 Pro', transport: 'serial'|'usb'|'ble', version: '8.02.16',
    writable: false, passwordRequired: false, reason: '', progress: { value: 32, total: 100, label: '读取信道' }
  },
  channels: [{ index: 0, number: 1, name: 'LOCAL', rxMHz: '145.50000',
    txMHz: '145.50000', mode: 'FM', power: '低', bandwidth: '宽', active: true,
    scanList: '1', modified: false }],
  vfos: [{ index: 0, band: 'VHF', side: 'A', name: '', rxMHz: '145.50000',
    txMHz: '145.50000', mode: 'FM', power: '低', bandwidth: '宽', active: true }],
  contacts: [{ index: 0, number: 1, type: 'DTMF', contactKind: 'dtmf',
    name: 'LOCAL', code: '12345', active: true }],
  messages: [{ index: 0, number: 1, name: '消息 1', text: '内容', active: true }],
  live: { canOperate: false, canLocate: false, preview: null, previewForCurrentSession: false,
    events: [], defaults: {}, lastLocationSync: null, reason: '' },
  radio: {
    si4732: [{ index: 0, number: 1, band: 'FM', name: '', frequency: '88.100 MHz',
      mode: 'FM', bfo: '', active: true, modified: false }],
    bk1080: [{ index: 0, number: 1, band: 'FM', name: '', frequency: '88.100 MHz',
      mode: 'FM', active: true, modified: false }]
  },
  settingsGroups: [{ id: 'general', title: '常规设置', description: '',
    fields: [{ key: 'beep', label: '按键提示音', type: 'checkbox', value: true }] }],
  scans: [{ index: 0, number: 1, name: '扫描列表 1', channels: [1,2,3],
    priority1: 1, priority2: null, modified: false }],
  changes: [{ address: 0x1000, length: 64, region: '普通信道',
    label: '信道 65', before: '00 01', after: '02 03' }],
  logs: [{ time: '10:23:44', level: 'info'|'success'|'warning'|'error', message: '...' }],
  capabilities: { serial: true, usb: true, ble: false, bleReason: '...', defaultBleProfile: {},
    features: [{ name: 'Web Serial', supported: true, detail: '...' }] }
}
```

`channels` 的 `index` 从 0 开始，`number` 是显示编号。UI 不做设备频率换算；root 应提供已经严格转换的 `rxMHz` / `txMHz` 文本。广播 `frequency` 为带单位的展示字符串。`active:false` 在表格显示为空槽，但原记录仍传回 controller。无字段或未知字段显示 `—`，不假填设备值。

## 通用编辑器字段

```js
ui.openEditor('channel'|'vfo'|'si4732'|'bk1080'|'scan'|'contact'|'message', record, [
  {key:'name', label:'名称', type:'text', value:'LOCAL', maxLength:10,
   required:false, readonly:false, disabled:false, help:'以设备字节限制为准'},
  {key:'rxMHz',label:'接收频率 / MHz',type:'number',value:'145.50000',
   min:'0',max:'1000',step:'0.00001',required:true},
  {key:'mode',label:'模式',type:'select',value:0,
   options:[{value:0,label:'FM'},{value:1,label:'AM'}]},
  {key:'active',label:'启用此记录',type:'checkbox',value:true}
]);
```

支持 `text`、`number`、`select`、`checkbox`，也支持可选 `textarea`；支持 `section` 分组标题、`unit` 尾缀、`placeholder`、`pattern`、`maxLength`。字段对象的 `value` 优先于 `record[key]`。保存时非复选框值保留字符串，复选框为布尔值，由 controller 做整数、编码和范围验证。`readonly` / `disabled` 字段不提交，保留原始记录由 codec 负责。

动作字段为 `{type:'action',key,label,action,value,help?}`，`value` 为按钮文字。点击时调用 `onAction(action,{})`；按钮标记 `data-skip-submit=true`，不进入表单值。仅含动作的分组不显示“应用到工作区”按钮。

保存统一调用：`onAction('save-editor', {kind, record, values})`。回调成功后关闭编辑器；抛错则留在编辑器显示错误。UI 不直接修改原记录。

## 事件

| type | payload |
|---|---|
| `navigate` | `{view:'channels'|'vfo'|'si4732'|'bk1080'|'settings'|'scans'|'contacts'|'messages'|'live'|'backup'|'logs'}` |
| `connect` | `{transport,selectedModel:'UV-K10 Pro',modelConfirmed:true,baudRate,...bleProfile}`；明确核对机型后提交。BLE profile 包含 serviceUuid/writeUuid/notifyUuid、writeMode、wireMode、responseChecksum、writeStrategy、interWriteDelayMs、mtuPayload、lengthConvention；枚举见 [BLE](ble-profile.md)。控制器通过 capabilities.defaultBleProfile 提供 K8 预设，UI 不猜 UUID |
| `discover-ble` | `{serviceUuid}`；返回 `{serviceUuid,characteristics:[{uuid,properties}]}`。授权的设备句柄仅在控制器内保存，检查不连接编程会话、不发 HELLO |
| `import-ble-profile` / `export-ble-profile` | `{file}` / 明确 profile 字段；文件不包含设备句柄或密码 |
| `authenticate` | `{password:string}`；只在已连接且 passwordRequired 时开放。UI提交后立即清空输入，操作完成后清空payload字段；controller不得将凭据或原始payload写入日志、工作区或存储。认证失败应返回固定错误说明，不包含密码 |
| `edit-startup-password` / `edit-programming-password` | `{}`；控制器核对本次设备读取基线后打开专用表单 |
| `change-credentials` | `{kind:'startup'|'programming',currentPassword,newPassword,confirmPassword,disable}`；UI提交期间禁用和清空所有密码框，完成/关闭再次清空。空白新密码不能隐式代替清除选项。成功后关闭连接并失效 sessionId |
| `disconnect` | `{}` |
| `read` | `{scope:'all'}` |
| `cancel` | `{}` |
| `preview-write` | `{}` |
| `write` | `{}`，只由写入预览的确认按钮触发，预览必须 `canWrite:true` |
| `import` | `{file:File}`，文件选择接受 `.bin,.dat,.json,.csv,.k10`；DAT 来源核对由控制器具体确认 |
| `export` | `{format:'project'|'nor'|'cps-dat'|'csv'|'cps-csv'|'radio-csv'|'log',chip?}`；导出条件由 codec 检查 |
| `demo` | `{}` |
| `new-channels` | `{}`；只创建信道与属性区，其他配置仍无覆盖 |
| `copy-channels` | `{indexes,cut:boolean}`；剪切不立即清空来源，直到成功粘贴 |
| `channel-tool` | `{operation:'paste'|'move'|'sort'|'batch'|'generate',indexes?}`；通过通用编辑器提交，控制器检查 workspaceId/revision 后原子应用 |
| `undo` / `redo` | `{}`；仅工作区本地历史，不跨成功设备写入 |
| `edit-channel` | `{record, index}` |
| `add-channel` | `{}` |
| `delete-channels` | `{indexes:number[]}`，仅清空当前选中记录，由 controller 确认并应用 |
| `edit-radio` | `{chip,record,index}` |
| `add-radio` | `{chip,band?}`；全部波段筛选时band未定义，由controller选择明确的目标 |
| `edit-scan` | `{record,index}` |
| `edit-record` | `{kind:'vfo'|'contact'|'message',record,index}`；record保留额外定位字段如bandIndex/side/contactKind，UI不会改写 |
| `save-editor` | `{kind,record,values}` |
| `save-settings` | `{groupId,values}`，使用相同字段提交规则 |
| `discard-changes` | `{}` |
| `clear-log` | `{}` |
| `restore-recovery` | `{}`；载入最近本地写前恢复快照，controller须将其视为离线数据，不授予在线写权限 |
| `reboot` | `{}`；仅连接且writable时显示为可用，controller另行请求明确确认后才发设备命令，不自动重启 |
| `preview-aprs` | `{values:{source,sourceSsid,destination,destinationSsid,addressee,path,text}}`；控制器构造最终帧、保存 input/id/sessionId 并更新 live.preview |
| `send-aprs` | `{previewId,values}`；UI核对未变更预览、当前连接、非空最终正文和勾选确认；控制器再验证快照与会话并仅发送一次 |
| `locate-browser` | `{}`；明确点击才申请一次定位。返回坐标、精度和高度缺失状态，不自动提交设备；取消后忽略迟到结果 |
| `sync-location` | `{values:{latitude,longitude,altitudeMeters}}`；单独确认提交；成功后旧 challenge/认证/写入基线失效 |
| `clear-live-events` / `export-live-events` | `{}`；最近 200 项内存记录，刷新即清空，不自动持久化 |

导航、搜索、排序和分页由 UI 自管，不要求 controller 重建行列表。`onAction` 可返回 Promise，抛错会显示明确错误；没有回调时不会假称操作成功。

## 其他 API

- `ui.toast(message, tone='info')`：短消息，tone 支持 info/success/warning/error。
- `ui.setBusy(boolean, label?)`：禁止并发动作，保留取消按钮；进度另由 connection.progress 提供。
- `ui.openCredentials({kind:'startup'|'programming',passwordRequired})`：打开独立密码表单，错误不回显提交内容。
- `ui.openWritePreview({changes?,summary?,canWrite:false,reason:''})`：具体差分审阅。确认写入仅在 canWrite 且勾选核对项后可用；离线状态仍可审阅差分。
- `ui.confirm({title,message,confirmLabel='确认',danger:false})`：返回 Promise<boolean>，用于替换未保存工作区等具体操作。
- `ui.closeDialog()`：关闭编辑器、连接与预览弹窗。
- `ui.destroy()`：卸载监听器及计时器。

所有设备验证、完整读取条件、写入保护、字节差分和读回核对由 controller/session 实现；UI 的 canWrite 只是展示与交互门槛，不能代替底层检查。默认状态为无工作区、未连接，无伪造硬件读数。

connection.passwordRequired=true 且已连接时显示“输入设备密码”按钮，密码输入使用 type=password 和 autocomplete=current-password。认证成功后controller更新passwordRequired=false；未认证前读取按钮禁用，写入仍由完整会话门槛控制。UI不会存储或记入日志，提交/关闭都会清空输入，报错不会回显密码。

连接对话框明确提示HELLO同步RTC，必须勾选核对设备本体型号为UV-K10 Pro。USB VID/PID、固件字符串与参数版本均不作为唯一型号证据，controller应核验modelConfirmed并将selectedModel传给session。浏览器serial/usb/ble能力默认从navigator检测，实际连接与硬件验证仍由controller/session负责。

## 实时页模型与分流

`live` 是完整替换的顶层对象。`preview` 包含最终信息文本、帧长、packetHex、warnings、规范化结果及原输入；数字 SSID 按数值比较，避免 `01` 与 `1` 的等价写法误判过期。其他文本精确比较。修改后重新预览和确认；离线可预览，但 `canOperate` 与 `previewForCurrentSession` 缺一时不能提交。

`events` 中的所有消息、呼号和原始帧均通过 textContent 展示；接收事件只更新列表，不触发发送。字段包括 `direction,time,source,destination,information,packetHex,length,possiblyTruncated,accepted,result`。仅 `accepted` 描述设备应答，不代表 RF 送达。坐标表单与消息表单草稿独立，浏览器定位、设备位置同步及发送消息互不自动触发。
