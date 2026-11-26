/* SPDX-License-Identifier: MIT */
/* Rendering and interaction only. Device identity, binary editing, writes and
 * readback verification belong to the application controller. */

const ICONS = {
  channels:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  radio:'<rect x="4" y="8" width="16" height="12" rx="2"/><path d="m6 8 11-5M8 12h4M8 16h2"/><circle cx="16" cy="15" r="2"/>',
  broadcast:'<path d="M7.3 6a8 8 0 0 0 0 12M16.7 6a8 8 0 0 1 0 12M9.8 9a4 4 0 0 0 0 6M14.2 9a4 4 0 0 1 0 6"/><circle cx="12" cy="12" r=".7"/>',
  sliders:'<path d="M4 6h5m4 0h7M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  scan:'<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M4 12h16"/><path d="M8 8h8m-8 8h8"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>',
  shield:'<path d="M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
  plug:'<path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5"/>',
  import:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M12 12v6m-3-3 3 3 3-3"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  upload:'<path d="M12 16V4m-4 4 4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  edit:'<path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-4-4L5 15l-1 5Z"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  chevronLeft:'<path d="m14 6-6 6 6 6"/>',
  chevronRight:'<path d="m10 6 6 6-6 6"/>',
  sort:'<path d="m8 8 4-4 4 4m-8 8 4 4 4-4"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  alert:'<path d="M10.3 4.7 2.7 18A2 2 0 0 0 4.4 21h15.2a2 2 0 0 0 1.7-3L13.7 4.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v5m0 3h.01"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8m-8 4h5"/>',
  table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16m6-10v10M3 15h18"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
  usb:'<path d="M12 20V4m-3 3 3-3 3 3M12 16l-5-5V8m5 5 5-4V6"/><circle cx="7" cy="7" r="1"/><rect x="16" y="4" width="2" height="2"/><circle cx="12" cy="20" r="1"/>',
  bluetooth:'<path d="m7 7 10 10-5 4V3l5 4L7 17"/>',
  folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  contacts:'<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M3 7h4m-4 5h4m-4 5h4"/><circle cx="13" cy="9" r="2"/><path d="M9 17v-1a4 4 0 0 1 8 0v1"/>',
  message:'<path d="M21 14a3 3 0 0 1-3 3H9l-6 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8Z"/><path d="M7 8h10M7 12h7"/>',
};

const VIEW_META = {
  channels:['普通对讲信道','CHANNEL WORKSPACE','整理收发频率与信道参数，修改后先审阅差分，再写入设备。'],
  vfo:['VFO A / B','FREQUENCY WORKSPACE','逐频段编辑 A、B 两个 VFO，保留各自的模式与信道参数。'],
  si4732:['Si4732 广播存台','BROADCAST RECEIVER','管理 FM、长波、中波与短波存台，保持各波段自己的频率和模式。'],
  bk1080:['BK1080 广播存台','FM BROADCAST RECEIVER','单独管理 BK1080 的 FM 存台，保留对应接收芯片的数据布局。'],
  settings:['设备设置','DEVICE CONFIGURATION','按功能分组编辑参数；未确认的单位与字段保持原值。'],
  scans:['扫描列表','SCAN COLLECTIONS','整理扫描成员与优先信道，便于在不同场景中快速切换。'],
  contacts:['信令联系人','SIGNALING CONTACTS','分别整理 DTMF、五音等信令联系人，保留其编码与记录类型。'],
  messages:['消息与文本','MESSAGES & TEXT','编辑对应数据区中的文本记录，按字段编码和长度保存。'],
  backup:['备份与差分','BACKUP & REVIEW','保存可恢复的工作区，并逐项核对本次修改涉及的字节。'],
  logs:['连接日志','CONNECTION DIAGNOSTICS','查看会话、读写进度与校验结果，定位设备连接问题。'],
};

export function formatByteCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n.toLocaleString('zh-CN')} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} KiB`;
  return `${(n / 1048576).toFixed(n % 1048576 ? 2 : 0)} MiB`;
}

function element(tag, attributes = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key,value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (key === 'on') { for (const [event,listener] of Object.entries(value)) el.addEventListener(event,listener); }
    else if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (['value','checked','selected','disabled','hidden','readOnly','required','multiple','tabIndex','indeterminate'].includes(key)) el[key] = value;
    else el.setAttribute(key,String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function icon(name) {
  const el = element('span',{'data-icon':name,'aria-hidden':'true'});
  // Only this module's fixed SVG path literals enter innerHTML.
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
  return el;
}

function button(label,handler,{tone='outline',iconName,small=false,disabled=false,title}={}) {
  return element('button',{type:'button',class:`button button-${tone}${small?' button-small':''}`,disabled,title,on:{click:handler}},iconName ? icon(iconName) : null,element('span',{},label));
}

function iconButton(name,label,handler,disabled=false) {
  return element('button',{type:'button',class:'icon-button','aria-label':label,title:label,disabled,on:{click:handler}},icon(name));
}

function pill(text,tone='') { return element('span',{class:`pill${tone?` pill-${tone}`:''}`},text); }
function display(value,fallback='—') { return value == null || value === '' ? fallback : String(value); }
function active(row) { return row.active !== false; }
function numberOf(row) { return row.number ?? (Number(row.index) + 1); }
function address(value) { return typeof value === 'number' ? `0x${value.toString(16).toUpperCase().padStart(6,'0')}` : display(value); }

function bytesText(value) {
  if (typeof value === 'string') return value;
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return Array.from(value,x=>Number(x).toString(16).padStart(2,'0').toUpperCase()).join(' ');
  return display(value);
}

function byteCell(value,tone) {
  const text = bytesText(value);
  if (text.length < 70) return element('td',{class:`diff-bytes diff-${tone}`},text);
  return element('td',{class:`diff-bytes diff-${tone}`},element('details',{},
    element('summary',{},`${text.slice(0,47)} …`),element('div',{},text)));
}

export function mountWorkbench({onAction} = {}) {
  const byId = id => {
    const result = document.getElementById(id);
    if (!result) throw new Error(`Missing workbench element: ${id}`);
    return result;
  };
  const abort = new AbortController();
  const timers = new Set();
  const host = byId('view-host');
  const dialogs = ['connection-dialog','authentication-dialog','editor-dialog','preview-dialog','confirm-dialog','help-dialog'].map(byId);
  const state = {
    view:'channels',query:'',channelFilter:'active',modeFilter:'all',page:0,pageSize:25,
    sort:{key:'number',direction:1},selected:new Set(),radioQueries:{si4732:'',bk1080:''},
    radioBands:{si4732:'all',bk1080:'all'},radioPages:{si4732:0,bk1080:0},
    settingsGroup:'',settingsQuery:'',settingsDrafts:new Map(),busy:false,busyLabel:'',logFilter:'all',
    recordQueries:{vfo:'',contacts:'',messages:''},recordPages:{vfo:0,contacts:0,messages:0},
  };
  let model = {
    workspace:{id:'empty',name:'尚未载入',mode:'empty',bytes:0,dirtyBytes:0,modifiedCount:0,complete:false},
    connection:{state:'disconnected',label:'UV-K10 Pro',transport:'',version:'',writable:false},
    channels:[],vfos:[],contacts:[],messages:[],radio:{si4732:[],bk1080:[]},settingsGroups:[],scans:[],changes:[],logs:[],
    capabilities:{serial:'serial' in navigator,usb:'usb' in navigator,ble:'bluetooth' in navigator,features:[]},
  };
  let workspaceId = 'empty';
  let confirmResolve = null;

  document.querySelectorAll('[data-icon]').forEach(el=>{
    const name=el.getAttribute('data-icon');
    el.replaceChildren(...icon(name).childNodes);
  });

  function listen(el,event,fn) { el.addEventListener(event,fn,{signal:abort.signal}); }

  async function invoke(type,payload={}) {
    try {
      if (typeof onAction !== 'function') throw new Error('应用控制器尚未就绪，操作未执行。');
      const result = await onAction(type,payload);
      return {ok:result !== false,result};
    } catch (error) {
      // Authentication failures must never echo submitted credentials, even
      // if a controller or transport accidentally embeds them in an error.
      const message = type==='authenticate' ? '认证未完成，请检查设备密码与连接状态后重试。' : error instanceof Error ? error.message : String(error);
      toast(message,'error');
      return {ok:false,error:message};
    }
  }

  function toast(message,tone='info') {
    const area=byId('toast-stack');
    const safeTone=['info','success','warning','error'].includes(tone)?tone:'info';
    const item=element('div',{class:`toast toast-${safeTone}`,role:safeTone==='error'?'alert':'status'},
      icon(safeTone==='success'?'check':safeTone==='warning'||safeTone==='error'?'alert':'info'),
      element('span',{},message));
    item.append(iconButton('close','关闭提示',()=>item.remove()));
    area.append(item);
    while (area.children.length>4) area.firstElementChild.remove();
    const timer=setTimeout(()=>{item.remove();timers.delete(timer);},safeTone==='error'?11000:6500);
    timers.add(timer);
  }

  function modalHeader(title,id,description,dialog) {
    return element('header',{class:'modal-header'},element('div',{},element('h2',{id},title),description?element('p',{},description):null),iconButton('close','关闭',()=>dialog.close()));
  }

  function show(dialog) { if (!dialog.open) dialog.showModal(); }
  function closeDialog() { for (const dialog of dialogs) if (dialog.open) dialog.close(); }
  function importFile() { if (!state.busy) byId('import-file').click(); }
  function hasWorkspace() { return model.workspace?.mode !== 'empty' && Number(model.workspace?.bytes)>0; }

  function emptyState({title='从设备或备份开始',message='导入已有备份，或连接 UV-K10 Pro 读取配置。所有编辑先保存在当前工作区。',actions=true,compact=false,iconName='channels'}={}) {
    return element('div',{class:`empty-state${compact?' empty-state-compact':''}`},element('div',{class:'empty-icon'},icon(iconName)),
      element('h2',{},title),element('p',{},message),actions?element('div',{class:'empty-actions'},
        button('导入备份',importFile,{tone:'primary',iconName:'import',disabled:state.busy}),
        button('载入演示工作区',()=>invoke('demo'),{iconName:'channels',disabled:state.busy})):null);
  }

  function navigate(view) {
    if (!(view in VIEW_META)) return;
    state.view=view;
    state.settingsQuery='';
    closeNavigation();
    render();
    void invoke('navigate',{view});
  }

  function closeNavigation() {
    byId('sidebar').classList.remove('is-open');
    byId('mobile-scrim').hidden=true;
    byId('menu-button').setAttribute('aria-expanded','false');
  }

  function setBusy(busy,label='正在处理') {
    state.busy=Boolean(busy);state.busyLabel=label;
    renderChrome();
    // Refresh table edit controls as well as toolbar buttons. Dialogs are
    // outside view-host and remain intact; focused search fields are restored.
    renderView();
  }

  function renderChrome() {
    const {workspace:w,connection:c}=model;
    const meta=VIEW_META[state.view];
    byId('breadcrumb-current').textContent=meta[0];
    byId('page-title').textContent=meta[0];
    byId('page-eyebrow').textContent=meta[1];
    byId('page-description').textContent=meta[2];
    document.querySelectorAll('.nav-item').forEach(el=>{
      const selected=el.dataset.view===state.view;
      el.classList.toggle('is-active',selected);
      el.setAttribute('title',VIEW_META[el.dataset.view]?.[0]||'');
      if (selected) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
    });
    const status={connected:'已连接',connecting:'连接中',error:'连接异常',disconnected:'未连接'}[c.state]||'未连接';
    byId('connection-state').textContent=status;
    byId('connection-dot').className=`state-indicator${c.state!=='disconnected'?` is-${c.state}`:''}`;
    const transport={serial:'串口',usb:'USB CDC',ble:'蓝牙'}[c.transport]||'';
    byId('connection-detail').textContent=c.state==='connected'
      ? [c.label||'设备',transport,c.version?`固件 ${c.version}`:'',c.passwordRequired?'设备要求认证':c.writable?'写入基线已就绪':c.reason||'读取并核对后可写入'].filter(Boolean).join(' · ')
      : c.reason||'可先导入备份，在本地编辑配置';
    const modeText={empty:'没有工作区',demo:'演示数据',offline:'离线文件',device:'设备数据'}[w.mode]||'离线文件';
    byId('workspace-mode').textContent=modeText;
    byId('workspace-mode').className=`workspace-mode${w.mode==='demo'?' is-demo':w.mode==='device'?' is-device':''}`;
    byId('summary-name').textContent=w.mode==='empty'?'尚未载入':w.name||'未命名工作区';
    byId('summary-name').title=w.name||'';
    const rows=state.view==='si4732'||state.view==='bk1080'?model.radio?.[state.view]||[]:model.channels||[];
    const used=rows.filter(active).length;
    byId('summary-count-label').textContent=state.view==='si4732'||state.view==='bk1080'?'已使用存台':'已使用信道';
    byId('summary-count').replaceChildren(...(hasWorkspace()?[String(used),element('small',{},`/ ${rows.length}`)]:['—']));
    byId('summary-changes').replaceChildren(Number(w.dirtyBytes||0).toLocaleString('zh-CN'),element('small',{},'字节'));
    byId('summary-source').textContent=w.mode==='empty'?'本地工作台':`${modeText} · ${formatByteCount(w.bytes)}`;
    byId('nav-channel-count').textContent=hasWorkspace()?String((model.channels||[]).filter(active).length):'—';
    const changeBadge=byId('nav-change-count');
    changeBadge.hidden=!Number(w.modifiedCount||model.changes.length||0);
    changeBadge.textContent=String(w.modifiedCount||model.changes.length||0);
    const connected=c.state==='connected';
    byId('authenticate-button').hidden=!connected||!c.passwordRequired;
    byId('authenticate-button').disabled=state.busy;
    byId('connect-button').querySelector('span:last-child').textContent=connected?'断开连接':'连接设备';
    byId('connect-button').disabled=state.busy||c.state==='connecting';
    byId('read-button').disabled=!connected||state.busy||Boolean(c.passwordRequired);
    byId('read-button').title=c.passwordRequired?'请先输入设备密码完成认证':'读取本次设备配置';
    byId('write-button').disabled=state.busy||!hasWorkspace()||!Number(w.dirtyBytes||0);
    byId('write-button').title=Number(w.dirtyBytes||0)?'审阅具体修改后再确认写入':'当前工作区没有待写入修改';
    byId('import-button').disabled=state.busy;
    byId('footer-status').textContent=w.mode==='demo'?'演示工作区未连接任何实机':w.dirtyBytes?`${Number(w.dirtyBytes).toLocaleString('zh-CN')} 字节修改尚未写入设备`:'修改先保存在工作区';
    const progress=c.progress;
    byId('task-progress').hidden=!state.busy&&!progress;
    byId('task-progress-label').textContent=progress?.label||state.busyLabel||'正在处理';
    const total=Number(progress?.total||0),value=Number(progress?.value||0);
    byId('task-progress-count').textContent=total>0?`${Math.min(value,total).toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')}`:'';
    const bar=byId('task-progress-bar');
    if(total>0){bar.max=total;bar.value=Math.max(0,Math.min(value,total));}else bar.removeAttribute('value');
    byId('cancel-button').disabled=!state.busy;
    const pageActions=byId('page-actions');
    pageActions.replaceChildren();
    if(state.view==='channels') {
      pageActions.append(button('导出 CSV',()=>invoke('export',{format:'csv'}),{iconName:'table',disabled:state.busy||!hasWorkspace()}),
        button('编辑空信道',()=>invoke('add-channel'),{iconName:'plus',disabled:state.busy||!hasWorkspace()}));
    } else if(state.view==='si4732'||state.view==='bk1080') {
      const chip=state.view;
      pageActions.append(button('导出存台',()=>invoke('export',{format:'radio-csv',chip}),{iconName:'table',disabled:state.busy||!hasWorkspace()}),
        button('编辑空存台',()=>invoke('add-radio',{chip,band:state.radioBands[chip]==='all'?undefined:state.radioBands[chip]}),{iconName:'plus',disabled:state.busy||!hasWorkspace()}));
    } else if(state.view==='backup') {
      pageActions.append(button('载入写前快照',()=>invoke('restore-recovery'),{iconName:'clock',disabled:state.busy}),button('导入文件',importFile,{iconName:'import',disabled:state.busy}));
    } else if(state.view==='logs') {
      pageActions.append(button('重启设备',()=>invoke('reboot'),{iconName:'refresh',disabled:state.busy||!connected||!c.writable,title:'需要连接并核对目标设备；操作前另行确认'}),button('导出日志',()=>invoke('export',{format:'log'}),{iconName:'download',disabled:!model.logs.length}));
    }
  }

  function searchField(id,placeholder,value,onInput) {
    return element('label',{class:'search-field'},icon('search'),element('span',{class:'sr-only'},placeholder),
      element('input',{id,type:'search',placeholder,value,autocomplete:'off','data-preserve-focus':'true',on:{input:event=>onInput(event.target.value)}}));
  }

  function selectControl(label,options,value,onChange,extra={}) {
    const select=element('select',{class:'select-control','aria-label':label,value,on:{change:event=>onChange(event.target.value)},...extra});
    for(const option of options) select.append(element('option',{value:option.value,selected:String(option.value)===String(value)},option.label));
    return select;
  }

  function tableFooter({total,page,pageSize,onPage,onSize,totalSlots}) {
    const pages=Math.max(1,Math.ceil(total/pageSize));
    const start=total?page*pageSize+1:0,end=Math.min((page+1)*pageSize,total);
    return element('footer',{class:'table-footer'},element('span',{},`显示 ${start}–${end}，共 ${total} 条${totalSlots!=null&&totalSlots!==total?` · ${totalSlots} 个槽位`:''}`),
      element('div',{class:'pagination'},iconButton('chevronLeft','上一页',()=>onPage(Math.max(0,page-1)),page<=0),
        element('span',{class:'page-number'},`${page+1} / ${pages}`),iconButton('chevronRight','下一页',()=>onPage(Math.min(pages-1,page+1)),page>=pages-1),
        selectControl('每页记录数',[25,50,100].map(n=>({value:n,label:`${n} 条/页`})),pageSize,onSize,{class:'select-control page-size'})));
  }

  function renderChannels() {
    if(!hasWorkspace())return element('section',{class:'panel'},emptyState());
    const all=model.channels||[];
    let rows=all.filter(row=>state.channelFilter==='all'||(state.channelFilter==='active'?active(row):!active(row)));
    if(state.modeFilter!=='all')rows=rows.filter(row=>String(row.mode)===state.modeFilter);
    const query=state.query.trim().toLowerCase();
    if(query)rows=rows.filter(row=>[row.name,row.rxMHz,row.txMHz,row.mode,numberOf(row)].some(v=>String(v??'').toLowerCase().includes(query)));
    const {key,direction}=state.sort;
    rows=[...rows].sort((a,b)=>{
      const av=key==='number'?numberOf(a):a[key],bv=key==='number'?numberOf(b):b[key];
      if(key==='number'||key==='rxMHz'||key==='txMHz')return ((Number(av)||0)-(Number(bv)||0))*direction;
      return String(av??'').localeCompare(String(bv??''),'zh-CN')*direction;
    });
    state.page=Math.min(state.page,Math.max(0,Math.ceil(rows.length/state.pageSize)-1));
    const visible=rows.slice(state.page*state.pageSize,(state.page+1)*state.pageSize);
    const panel=element('section',{class:'panel'});
    const modes=[...new Set(all.filter(active).map(row=>row.mode).filter(Boolean))];
    panel.append(element('div',{class:'toolbar'},
      element('div',{class:'toolbar-left'},searchField('channel-search','搜索名称、频率或编号',state.query,value=>{state.query=value;state.page=0;renderView();})),
      element('div',{class:'toolbar-right'},element('span',{class:'filter-label'},'筛选'),
        selectControl('信道使用状态',[{value:'active',label:'已使用信道'},{value:'all',label:'所有信道'},{value:'empty',label:'空信道'}],state.channelFilter,value=>{state.channelFilter=value;state.page=0;renderView();}),
        selectControl('调制模式',[{value:'all',label:'全部模式'},...modes.map(mode=>({value:mode,label:mode}))],state.modeFilter,value=>{state.modeFilter=value;state.page=0;renderView();}))));
    if(state.selected.size)panel.append(element('div',{class:'selection-toolbar'},element('span',{},`已选择 ${state.selected.size} 个信道`),
      element('div',{},button('取消选择',()=>{state.selected.clear();renderView();},{tone:'quiet',small:true}),
        button('清空所选',()=>invoke('delete-channels',{indexes:[...state.selected]}),{tone:'danger-outline',small:true,iconName:'trash',disabled:state.busy}))));
    const pageChecked=visible.length>0&&visible.every(row=>state.selected.has(row.index));
    const selectAll=element('input',{type:'checkbox',checked:pageChecked,indeterminate:!pageChecked&&visible.some(row=>state.selected.has(row.index)),'aria-label':'选择本页所有信道',on:{change:event=>{
      visible.forEach(row=>event.target.checked?state.selected.add(row.index):state.selected.delete(row.index));renderView();
    }}});
    const columns=[['number','编号'],['name','信道名称'],['rxMHz','接收 / MHz'],['txMHz','发射 / MHz'],['mode','模式'],['power','功率'],['bandwidth','带宽']];
    const head=element('tr',{},element('th',{class:'cell-check',scope:'col'},selectAll));
    for(const [field,label]of columns)head.append(element('th',{scope:'col'},element('button',{type:'button',class:`table-sort${state.sort.key===field?' is-sorted':''}`,title:`按${label}排序`,on:{click:()=>{
      state.sort={key:field,direction:state.sort.key===field?-state.sort.direction:1};renderView();
    }}},label,icon('sort'))));
    head.append(element('th',{scope:'col',class:'cell-actions'},element('span',{class:'sr-only'},'操作')));
    const body=element('tbody');
    for(const row of visible){
      const tr=element('tr',{class:[state.selected.has(row.index)?'is-selected':'',!active(row)?'is-empty':'',row.modified?'is-modified':''].filter(Boolean).join(' ')});
      tr.append(element('td',{class:'cell-check'},element('input',{type:'checkbox',checked:state.selected.has(row.index),'aria-label':`选择信道 ${numberOf(row)}`,on:{change:event=>{event.target.checked?state.selected.add(row.index):state.selected.delete(row.index);renderView();}}})),
        element('td',{class:'cell-number mono'},numberOf(row)),element('td',{class:'cell-name',title:row.name||''},active(row)?display(row.name,'未命名'):element('span',{class:'empty-value'},'空信道')),
        element('td',{class:'cell-frequency'},active(row)?display(row.rxMHz):'—'),element('td',{class:'cell-frequency'},active(row)?display(row.txMHz):'—'),
        element('td',{},active(row)?pill(display(row.mode),'blue'):'—'),element('td',{},active(row)?display(row.power):'—'),element('td',{},active(row)?display(row.bandwidth):'—'),
        element('td',{class:'cell-actions'},iconButton('edit',`编辑信道 ${numberOf(row)}`,()=>invoke('edit-channel',{record:row,index:row.index}),state.busy)));
      body.append(tr);
    }
    panel.append(element('div',{class:'table-wrap'},element('table',{class:'data-table'},element('thead',{},head),body)));
    if(!visible.length)panel.append(element('div',{class:'no-matches'},query?'没有匹配的信道，请调整搜索条件。':'当前筛选没有记录，可切换为所有信道。'));
    panel.append(tableFooter({total:rows.length,page:state.page,pageSize:state.pageSize,totalSlots:all.length,onPage:value=>{state.page=value;renderView();},onSize:value=>{state.pageSize=Number(value);state.page=0;renderView();}}));
    return panel;
  }

  function renderRadio(chip) {
    if(!hasWorkspace())return element('section',{class:'panel'},emptyState({iconName:'radio',title:'载入广播存台数据',message:'导入 K10 Pro 备份或读取设备后，在这里管理对应接收芯片的存台。'}));
    const all=model.radio?.[chip]||[];
    const bands=[...new Set(all.map(row=>row.band).filter(Boolean))];
    let rows=all;
    if(state.radioBands[chip]!=='all')rows=rows.filter(row=>String(row.band)===state.radioBands[chip]);
    const query=state.radioQueries[chip].trim().toLowerCase();
    if(query)rows=rows.filter(row=>[row.name,row.frequency,row.band,row.mode,numberOf(row)].some(value=>String(value??'').toLowerCase().includes(query)));
    const pageSize=state.pageSize;
    state.radioPages[chip]=Math.min(state.radioPages[chip],Math.max(0,Math.ceil(rows.length/pageSize)-1));
    const page=state.radioPages[chip],visible=rows.slice(page*pageSize,(page+1)*pageSize);
    const panel=element('section',{class:'panel radio-panel'});
    panel.append(element('div',{class:'chip-tabs'},...['si4732','bk1080'].map(name=>element('button',{type:'button',class:`chip-tab${chip===name?' is-active':''}`,on:{click:()=>navigate(name)}},name==='si4732'?'Si4732 · 多波段':'BK1080 · FM'))));
    panel.append(element('div',{class:'toolbar'},element('div',{class:'toolbar-left'},searchField(`radio-search-${chip}`,'搜索存台、频率或波段',state.radioQueries[chip],value=>{state.radioQueries[chip]=value;state.radioPages[chip]=0;renderView();})),
      element('div',{class:'toolbar-right'},element('span',{class:'toolbar-count'},`${all.filter(active).length} 个有效记录`),selectControl('广播波段',[{value:'all',label:'全部波段'},...bands.map(band=>({value:band,label:String(band).toUpperCase()}))],state.radioBands[chip],value=>{state.radioBands[chip]=value;state.radioPages[chip]=0;renderView();}))));
    const headings=['编号','波段','名称','频率','模式',...(chip==='si4732'?['BFO 原值']:[]),'状态','操作'];
    const head=element('tr',{},...headings.map(label=>element('th',{scope:'col'},label)));
    const body=element('tbody');
    for(const row of visible){
      const isVfo=row.is_vfo===true||String(row.number).toLowerCase()==='vfo';
      const tr=element('tr',{class:[!active(row)?'is-empty':'',row.modified?'is-modified':''].filter(Boolean).join(' ')});
      tr.append(element('td',{class:'cell-number mono'},isVfo?'VFO':numberOf(row)),element('td',{},pill(display(row.band).toUpperCase(),'blue')),
        element('td',{class:'cell-name'},display(row.name,isVfo?'当前频率':'—')),element('td',{class:'cell-frequency'},active(row)?display(row.frequency):'—'),element('td',{},active(row)?display(row.mode):'—'));
      if(chip==='si4732')tr.append(element('td',{class:'mono'},active(row)?display(row.bfo):'—'));
      tr.append(element('td',{},pill(active(row)?(isVfo?'VFO':'已保存'):'空槽',active(row)?'green':'outline')),
        element('td',{class:'cell-actions'},iconButton('edit',`编辑 ${String(row.band||'')} ${isVfo?'VFO':`存台 ${numberOf(row)}`}`,()=>invoke('edit-radio',{chip,record:row,index:row.index}),state.busy)));
      body.append(tr);
    }
    panel.append(element('div',{class:'table-wrap'},element('table',{class:'data-table'},element('thead',{},head),body)));
    if(!visible.length)panel.append(element('div',{class:'no-matches'},all.length?'没有匹配的存台。':'当前工作区尚未载入这一接收芯片的存台区域。'));
    panel.append(tableFooter({total:rows.length,page,pageSize,onPage:value=>{state.radioPages[chip]=value;renderView();},onSize:value=>{state.pageSize=Number(value);state.radioPages[chip]=0;renderView();}}));
    panel.append(element('div',{class:'notice-line'},icon('info'),element('span',{},chip==='si4732'?'Si4732 各波段记录分开编辑；VFO 与存台记录明确区分。BFO 保留原始单位，由设备解释。':'BK1080 只提供 FM 存台编辑。选择此视图不会改变设备的接收芯片类型，也不表示已检测到该芯片。')));
    return panel;
  }

  function buildFields(fields,record={},prefix='field',draft={}) {
    const grid=element('div',{class:'form-grid'});
    let section='';
    fields.forEach((field,index)=>{
      if(field.section&&field.section!==section){section=field.section;grid.append(element('div',{class:'field-section'},section));}
      const id=`${prefix}-${index}`;
      const value=Object.hasOwn(draft,field.key)?draft[field.key]:(field.value!==undefined?field.value:record[field.key]);
      const box=element('div',{class:'form-field'});
      if(field.type==='textarea')box.style.gridColumn='1 / -1';
      const label=element('label',{class:'form-label',for:id},field.label||field.key,field.required?element('span',{class:'required','aria-hidden':'true'},'*'):null);
      const common={id,name:field.key,'data-field-key':field.key,'data-field-type':field.type||'text',disabled:Boolean(field.disabled),readOnly:Boolean(field.readonly),required:Boolean(field.required),'aria-describedby':field.help?`${id}-help`:null};
      let input;
      if(field.type==='action') {
        input=button(String(field.value||field.label||'打开'),()=>invoke(field.action),{tone:'outline',iconName:'edit',disabled:state.busy||Boolean(field.disabled||field.readonly)||!field.action});
        input.dataset.skipSubmit='true';input.dataset.action=field.action||'';
        box.append(label,input);
      } else if(field.type==='checkbox') {
        input=element('input',{...common,type:'checkbox',checked:Boolean(value),disabled:Boolean(field.disabled||field.readonly)});
        box.append(element('div',{class:'checkbox-field'},input,element('label',{for:id},field.label||field.key)));
      } else {
        box.append(label);
        if(field.type==='select') {
          input=element('select',{...common,class:'field-control select-control',disabled:Boolean(field.disabled||field.readonly)});
          const options=field.options||[];
          if(value!==undefined&&!options.some(option=>String(option.value)===String(value)))input.append(element('option',{value,selected:true},`保留原值 ${value}`));
          for(const option of options)input.append(element('option',{value:option.value,selected:String(option.value)===String(value),disabled:Boolean(option.disabled)},option.label??String(option.value)));
        } else if(field.type==='textarea')input=element('textarea',{...common,class:'field-control',rows:field.rows||4,placeholder:field.placeholder||'',value:display(value,''),maxlength:field.maxLength});
        else input=element('input',{...common,class:'field-control',type:field.type==='number'?'number':'text',value:display(value,''),placeholder:field.placeholder||'',min:field.min,max:field.max,step:field.step,pattern:field.pattern,maxlength:field.maxLength,autocomplete:'off',inputmode:field.type==='number'?'decimal':field.inputMode||field.inputmode});
        if(field.unit)box.append(element('div',{class:'field-unit'},input,element('span',{},field.unit)));else box.append(input);
      }
      if(field.readonly||field.disabled)input.dataset.skipSubmit='true';
      if(field.help)box.append(element('p',{class:'field-help',id:`${id}-help`},field.help));
      grid.append(box);
    });
    return grid;
  }

  function collectFields(form,{includeReadOnly=false}={}) {
    const values={};
    form.querySelectorAll('[data-field-key]').forEach(input=>{
      if(!includeReadOnly&&input.dataset.skipSubmit==='true')return;
      values[input.dataset.fieldKey]=input.dataset.fieldType==='checkbox'?input.checked:input.value;
    });
    return values;
  }

  function renderSettings() {
    const groups=model.settingsGroups||[];
    if(!hasWorkspace()||!groups.length)return element('section',{class:'panel'},emptyState({iconName:'sliders',title:hasWorkspace()?'尚未载入设置区域':'载入设备设置',message:'读取设备或导入备份后，显示对应 K10 Pro 布局的设置。未确认的字段不会被自动改写。',actions:!hasWorkspace()}));
    if(!groups.some(group=>group.id===state.settingsGroup))state.settingsGroup=groups[0].id;
    const current=groups.find(group=>group.id===state.settingsGroup);
    const layout=element('div',{class:'settings-layout'});
    const navigation=element('nav',{class:'settings-navigation','aria-label':'设置分组'});
    for(const group of groups)navigation.append(element('button',{type:'button',class:`settings-nav-button${group.id===current.id?' is-active':''}`,'aria-current':group.id===current.id?'page':null,on:{click:()=>{state.settingsGroup=group.id;state.settingsQuery='';renderView();}}},element('span',{},group.title||group.id),element('small',{},(group.fields||[]).length)));
    layout.append(navigation);
    const panel=element('section',{class:'panel'});
    panel.append(element('header',{class:'settings-header'},element('h2',{},current.title||current.id),current.description?element('p',{},current.description):null));
    const form=element('form',{class:'settings-form'});
    const query=state.settingsQuery.trim().toLowerCase();
    const fields=(current.fields||[]).filter(field=>!query||[field.key,field.label,field.help].some(value=>String(value||'').toLowerCase().includes(query)));
    form.append(searchField('settings-search','在本组查找设置',state.settingsQuery,value=>{state.settingsQuery=value;renderView();}));
    form.firstElementChild.classList.add('settings-search');
    if(current.warning)form.append(element('div',{class:'setting-warning'},current.warning));
    form.append(buildFields(fields,{},`settings-${current.id}`,state.settingsDrafts.get(current.id)||{}));
    if(!fields.length)form.append(element('div',{class:'no-matches'},'本组没有匹配的设置。'));
    const error=element('div',{class:'form-error',hidden:true,role:'alert'});
    const save=element('button',{type:'submit',class:'button button-primary','data-mutation':'true',disabled:state.busy||!fields.some(field=>field.type!=='action'&&!field.readonly&&!field.disabled),hidden:fields.length>0&&fields.every(field=>field.type==='action')},icon('check'),element('span',{},'应用到工作区'));
    form.append(error,element('div',{class:'form-actions'},element('span',{class:'field-help'},'应用后仍需在写入预览中确认设备写入'),save));
    form.addEventListener('input',()=>state.settingsDrafts.set(current.id,{...(state.settingsDrafts.get(current.id)||{}),...collectFields(form)}));
    form.addEventListener('change',()=>state.settingsDrafts.set(current.id,{...(state.settingsDrafts.get(current.id)||{}),...collectFields(form)}));
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(state.busy||!form.reportValidity())return;
      save.disabled=true;error.hidden=true;
      const values={...(state.settingsDrafts.get(current.id)||{}),...collectFields(form)};
      const result=await invoke('save-settings',{groupId:current.id,values});
      if(result.ok){state.settingsDrafts.delete(current.id);renderView();}
      else{error.textContent=result.error||'设置未应用，请检查输入。';error.hidden=false;save.disabled=false;}
    });
    panel.append(form);layout.append(panel);return layout;
  }

  function renderScans() {
    if(!hasWorkspace()||!model.scans.length)return element('section',{class:'panel'},emptyState({iconName:'scan',title:'载入扫描列表',message:'在普通信道的基础上组织扫描成员和优先信道。',actions:!hasWorkspace()}));
    const grid=element('section',{class:'scan-grid','aria-label':'扫描列表'});
    for(const row of model.scans){
      const members=Array.isArray(row.channels)?row.channels:[];
      grid.append(element('article',{class:'scan-card'},
        element('div',{class:'scan-heading'},element('div',{},element('span',{class:'scan-icon'},icon('scan')),element('h3',{},row.name||`扫描列表 ${numberOf(row)}`)),iconButton('edit',`编辑扫描列表 ${numberOf(row)}`,()=>invoke('edit-scan',{record:row,index:row.index}),state.busy)),
        element('div',{class:'scan-meta'},element('span',{},`${members.length} 个成员`),row.modified?pill('已修改','amber'):element('span',{},`列表 ${numberOf(row)}`)),
        element('div',{class:'scan-members'},members.length?[...members.slice(0,12).map(member=>element('span',{class:'scan-member'},`CH ${member}`)),members.length>12?element('span',{class:'scan-member'},`+${members.length-12}`):null]:element('span',{class:'field-help'},'尚未分配信道')),
        element('div',{class:'scan-priority'},element('span',{},`优先 1：${display(row.priority1,'无')}`),element('span',{},`优先 2：${display(row.priority2,'无')}`))));
    }
    return grid;
  }

  function renderRecords(view) {
    const configs={
      vfo:{key:'vfos',kind:'vfo',icon:'sliders',columns:[['band','频段'],['side','VFO'],['name','名称'],['rxMHz','接收 / MHz'],['txMHz','发射 / MHz'],['mode','模式'],['power','功率']]},
      contacts:{key:'contacts',kind:'contact',icon:'contacts',columns:[['number','编号'],['type','信令类型'],['name','名称'],['code','信令编码']]},
      messages:{key:'messages',kind:'message',icon:'message',columns:[['number','编号'],['name','名称 / 用途'],['text','文本内容']]},
    };
    const config=configs[view],all=model[config.key]||[];
    if(!hasWorkspace()||!all.length)return element('section',{class:'panel'},emptyState({iconName:config.icon,title:hasWorkspace()?'当前区域尚未载入':`载入${VIEW_META[view][0]}`,message:'读取设备或导入相应工作区数据后，可编辑这一组记录。',actions:!hasWorkspace()}));
    const query=state.recordQueries[view].trim().toLowerCase();
    const rows=query?all.filter(row=>config.columns.some(([key])=>String(key==='number'?numberOf(row):row[key]??'').toLowerCase().includes(query))):all;
    const size=state.pageSize;
    state.recordPages[view]=Math.min(state.recordPages[view],Math.max(0,Math.ceil(rows.length/size)-1));
    const page=state.recordPages[view],visible=rows.slice(page*size,(page+1)*size);
    const panel=element('section',{class:'panel'});
    panel.append(element('div',{class:'toolbar'},element('div',{class:'toolbar-left'},searchField(`records-search-${view}`,'搜索名称、编号或内容',state.recordQueries[view],value=>{state.recordQueries[view]=value;state.recordPages[view]=0;renderView();})),element('span',{class:'toolbar-count'},`${all.length} 个记录槽位`)));
    const table=element('table',{class:'data-table'}),body=element('tbody');
    table.append(element('thead',{},element('tr',{},...config.columns.map(([,label])=>element('th',{scope:'col'},label)),element('th',{scope:'col'},'操作'))));
    for(const row of visible){
      const tr=element('tr',{class:[!active(row)?'is-empty':'',row.modified?'is-modified':''].filter(Boolean).join(' ')});
      for(const[key]of config.columns){
        const value=key==='number'?numberOf(row):row[key];
        const cell=element('td',{class:key==='rxMHz'||key==='txMHz'?'cell-frequency':key==='number'||key==='code'?'mono':key==='name'?'cell-name':''},display(value));
        if(key==='text'){cell.style.whiteSpace='normal';cell.style.minWidth='230px';cell.style.maxWidth='560px';cell.style.overflowWrap='anywhere';}
        tr.append(cell);
      }
      tr.append(element('td',{class:'cell-actions'},iconButton('edit',`编辑记录 ${numberOf(row)}`,()=>invoke('edit-record',{kind:config.kind,record:row,index:row.index}),state.busy)));
      body.append(tr);
    }
    table.append(body);panel.append(element('div',{class:'table-wrap'},table));
    if(!visible.length)panel.append(element('div',{class:'no-matches'},'没有匹配的记录。'));
    panel.append(tableFooter({total:rows.length,page,pageSize:size,onPage:value=>{state.recordPages[view]=value;renderView();},onSize:value=>{state.pageSize=Number(value);state.recordPages[view]=0;renderView();}}));
    return panel;
  }

  function diffTable(changes,{limit=200}={}) {
    const table=element('table',{class:'data-table'},element('thead',{},element('tr',{},...['地址','区域 / 记录','长度','修改前','修改后'].map(title=>element('th',{scope:'col'},title)))));
    const body=element('tbody');
    for(const change of changes.slice(0,limit))body.append(element('tr',{},element('td',{class:'mono'},address(change.address)),
      element('td',{},element('div',{class:'cell-name'},display(change.label,change.region||'数据区')),change.label&&change.region?element('div',{class:'field-help'},change.region):null),
      element('td',{class:'mono'},`${display(change.length)} B`),byteCell(change.before,'before'),byteCell(change.after,'after')));
    table.append(body);
    return element('div',{class:'table-wrap'},table,changes.length>limit?element('div',{class:'notice-line'},icon('info'),`当前显示前 ${limit} 项，共 ${changes.length} 项；导出项目可保留完整修改。`):null);
  }

  function renderBackup() {
    const fragment=document.createDocumentFragment();
    if(!hasWorkspace()){fragment.append(element('section',{class:'panel'},emptyState({iconName:'folder',title:'保留一份可恢复的工作区',message:'先读取设备或导入二进制备份、工作区项目。CSV 会合并到已有工作区，在导入前保留原始数据。'})));return fragment;}
    const w=model.workspace;
    fragment.append(element('section',{class:'panel backup-info'},element('div',{class:'backup-info-icon'},icon('folder')),
      element('div',{class:'backup-info-copy'},element('h2',{},w.name||'未命名工作区'),element('p',{},`${formatByteCount(w.bytes)} · ${w.mode==='demo'?'合成演示输入':w.mode==='device'?'设备读取数据':'本地导入文件'}`),pill(w.complete?'完整存储覆盖':'局部区域覆盖',w.complete?'green':'blue')),
      element('div',{class:'backup-info-action'},button('导出工作区项目',()=>invoke('export',{format:'project'}),{tone:'primary',iconName:'download',disabled:state.busy}))));
    const cards=[
      ['file','二进制工作副本','保留当前已载入的数据与未修改字节，覆盖范围以工作区为准。','导出二进制','nor'],
      ['table','无损信道表','包含本项目的原始记录与属性字段，方便继续编辑并保留未知数据。','导出无损 CSV','csv'],
      ['table','官方 CPS 22 列','按 CPS 0.56 表格导出，只覆盖该表能表示的字段；不作为无损备份。','导出 CPS CSV','cps-csv'],
      ['layers','本次修改','审阅更改涉及的记录、地址和字节，再决定是否写入。','审阅写入差分','preview'],
    ];
    fragment.append(element('section',{class:'card-grid'},...cards.map(([glyph,title,message,label,format])=>element('article',{class:'tool-card'},element('div',{class:'tool-card-icon'},icon(glyph)),element('h3',{},title),element('p',{},message),button(label,()=>invoke(format==='preview'?'preview-write':'export',format==='preview'?{}:{format}),{small:true,disabled:state.busy||(format==='preview'&&!Number(w.dirtyBytes))})))));
    fragment.append(element('div',{class:'subsection-heading backup-heading'},element('div',{},element('h2',{},'字节差分',element('span',{class:'record-count-subtle'},`${model.changes.length} 项`)),element('p',{},'以导入或读取时的基线为参照。未知字段保持原样。')),
      button('撤销全部修改',()=>invoke('discard-changes'),{tone:'danger-outline',small:true,iconName:'refresh',disabled:state.busy||!Number(w.dirtyBytes)})));
    fragment.append(element('section',{class:'panel'},model.changes.length?diffTable(model.changes):emptyState({title:'当前没有修改',message:'编辑信道、存台或设置后，这里会显示具体的字节变化。',iconName:'check',actions:false,compact:true})));
    return fragment;
  }

  function renderLogs() {
    const fragment=document.createDocumentFragment();
    const all=model.logs||[],filtered=all.filter(row=>state.logFilter==='all'||row.level===state.logFilter),rows=filtered.slice(-500);
    const panel=element('section',{class:'panel log-panel'});
    panel.append(element('div',{class:'panel-header log-toolbar'},element('div',{class:'panel-title-group'},icon('terminal'),element('h2',{},'会话记录')),
      element('div',{class:'toolbar-right'},selectControl('日志级别',[{value:'all',label:'全部级别'},{value:'info',label:'信息'},{value:'success',label:'成功'},{value:'warning',label:'提示'},{value:'error',label:'错误'}],state.logFilter,value=>{state.logFilter=value;renderView();}),button('清空',()=>invoke('clear-log'),{small:true,disabled:!all.length}))));
    const output=element('div',{class:'log-output',role:'log','aria-label':'设备连接日志','aria-live':'polite'});
    for(const row of rows){const level=['info','success','warning','error'].includes(row.level)?row.level:'info';output.append(element('div',{class:`log-line log-${level}`},element('span',{class:'log-time'},display(row.time,'')),element('span',{class:'log-level'},level.toUpperCase()),element('span',{class:'log-message'},display(row.message,''))));}
    if(!rows.length)output.append(element('div',{class:'log-empty'},all.length?'当前筛选没有日志。':'尚未开始设备会话。连接或读写时的记录会出现在这里。'));
    panel.append(output);fragment.append(panel);
    const features=model.capabilities?.features?.length?model.capabilities.features:[
      {name:'Web Serial',supported:model.capabilities?.serial,detail:'通过浏览器选择串口与写频线。'},
      {name:'WebUSB',supported:model.capabilities?.usb,detail:'需要浏览器允许访问设备的 USB 接口。'},
      {name:'Web Bluetooth',supported:model.capabilities?.ble,detail:model.capabilities?.bleReason||'需要明确的服务与特征 UUID。'},
    ];
    fragment.append(element('div',{class:'subsection-heading'},element('div',{},element('h2',{},'浏览器连接能力'),element('p',{},'浏览器接口可用不代表目标设备已连接或验证。'))));
    fragment.append(element('section',{class:'capability-grid'},...features.map(feature=>element('article',{class:'capability-card'},element('div',{class:'capability-title'},element('span',{},feature.name),pill(feature.supported?'可用':'不可用',feature.supported?'green':'outline')),element('p',{},feature.detail||'')))));
    return fragment;
  }

  function renderView() {
    const focused=host.contains(document.activeElement)&&document.activeElement?.dataset.preserveFocus ? document.activeElement : null;
    const focusId=focused?.id,start=focused?.selectionStart,end=focused?.selectionEnd;
    host.replaceChildren();
    if(model.connection.state==='connected'&&model.connection.passwordRequired)host.append(element('div',{class:'info-banner warning'},icon('shield'),element('span',{},'设备要求密码认证。请使用上方“输入设备密码”完成正常认证，随后读取本次设备配置。密码不写入工作区或连接日志。')));
    if(model.workspace?.mode==='demo')host.append(element('div',{class:'demo-banner'},element('span',{},element('strong',{},'演示工作区'), ' · 当前记录由合成数据生成，可体验编辑与差分，不代表任何实机读数。'),button('导入自己的备份',importFile,{tone:'quiet',small:true,disabled:state.busy})));
    const views={channels:renderChannels,vfo:()=>renderRecords('vfo'),contacts:()=>renderRecords('contacts'),messages:()=>renderRecords('messages'),si4732:()=>renderRadio('si4732'),bk1080:()=>renderRadio('bk1080'),settings:renderSettings,scans:renderScans,backup:renderBackup,logs:renderLogs};
    host.append(views[state.view]());
    if(focusId){const replacement=document.getElementById(focusId);replacement?.focus({preventScroll:true});if(replacement?.setSelectionRange&&start!=null)replacement.setSelectionRange(start,end);}
  }

  function render(update={}) {
    model={...model,...update,workspace:{...model.workspace,...update.workspace},connection:{...model.connection,...update.connection},radio:{...model.radio,...update.radio},capabilities:{...model.capabilities,...update.capabilities}};
    // A partial workspace/connection update must not erase state such as the
    // target identity or writable gate. Callers normally provide full objects.
    model.workspace={mode:'empty',bytes:0,dirtyBytes:0,modifiedCount:0,...model.workspace};
    model.connection={state:'disconnected',writable:false,...model.connection};
    if((model.connection.state!=='connected'||!model.connection.passwordRequired)&&byId('authentication-dialog').open)byId('authentication-dialog').close();
    for(const name of ['channels','vfos','contacts','messages','settingsGroups','scans','changes','logs'])if(!Array.isArray(model[name]))model[name]=[];
    const nextId=model.workspace.id||`${model.workspace.mode}:${model.workspace.name}:${model.workspace.bytes}`;
    if(workspaceId!==nextId){workspaceId=nextId;state.selected.clear();state.settingsDrafts.clear();state.page=0;state.radioPages={si4732:0,bk1080:0};}
    const ids=new Set(model.channels.map(row=>row.index));
    for(const id of state.selected)if(!ids.has(id))state.selected.delete(id);
    renderChrome();renderView();
  }

  function openEditor(kind,record,fields=[]) {
    const dialog=byId('editor-dialog');
    const labels={channel:'编辑对讲信道',vfo:'编辑 VFO',si4732:'编辑 Si4732 存台',bk1080:'编辑 BK1080 存台',scan:'编辑扫描列表',contact:'编辑信令联系人',message:'编辑消息文本'};
    const label=labels[kind]||'编辑记录';
    const id=numberOf(record);
    dialog.replaceChildren();
    const isVfo=record.is_vfo||String(record.number).toLowerCase()==='vfo'||kind==='vfo';
    const titleBlock=element('div',{},element('div',{class:'editor-kicker'},kind==='channel'?'CHANNEL EDITOR':kind==='scan'?'SCAN EDITOR':kind==='contact'?'CONTACT EDITOR':kind==='message'?'MESSAGE EDITOR':kind==='vfo'?'VFO EDITOR':'BROADCAST EDITOR'),element('h2',{id:'editor-title'},label),element('div',{class:'editor-record-tag'},pill(record.title||`${isVfo?'VFO':`记录 ${id}`}${record.band?` · ${String(record.band).toUpperCase()}`:''}`,'blue')));
    dialog.append(element('header',{class:'modal-header'},titleBlock,iconButton('close','关闭编辑器',()=>dialog.close())));
    const form=element('form',{class:'editor-form'}),body=element('div',{class:'editor-body'});
    body.append(element('p',{class:'editor-description'},'保存会更新本地工作区。设备写入将在审阅差分后单独确认。'));
    const error=element('div',{class:'form-error',hidden:true,role:'alert'});
    body.append(buildFields(fields,record,'editor'),error);
    const save=element('button',{type:'submit',class:'button button-primary',disabled:state.busy||!fields.some(field=>field.type!=='action'&&!field.readonly&&!field.disabled)},icon('check'),element('span',{},'保存到工作区'));
    form.append(body,element('footer',{class:'modal-footer'},button('取消',()=>dialog.close(),{tone:'quiet'}),save));
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(state.busy||!form.reportValidity())return;
      error.hidden=true;save.disabled=true;
      const result=await invoke('save-editor',{kind,record,values:collectFields(form)});
      if(result.ok)dialog.close();else{error.textContent=result.error||'记录未保存，请检查输入。';error.hidden=false;save.disabled=false;}
    });
    dialog.append(form);show(dialog);
    const first=dialog.querySelector('input:not([disabled]):not([readonly]),select:not([disabled]),textarea:not([disabled]):not([readonly])');
    first?.focus();
  }

  function openConnection() {
    const dialog=byId('connection-dialog');
    dialog.replaceChildren(modalHeader('连接 UV-K10 Pro','connection-dialog-title','选择当前浏览器可用的连接方式。',dialog));
    const form=element('form'),body=element('div',{class:'modal-body'}),options=element('div',{class:'connection-options',role:'group','aria-label':'连接方式'});
    const available=model.capabilities||{};
    let transport=['serial','usb','ble'].find(key=>available[key])||'serial';
    const methods=[['serial','plug','串口写频','USB 写频线'],['usb','usb','原生 USB','USB CDC 接口'],['ble','bluetooth','蓝牙','明确的 GATT 配置']];
    const details=element('div');
    const modelConfirmed=element('input',{type:'checkbox',id:'connection-model-confirm',required:true});
    const submit=element('button',{type:'submit',class:'button button-primary'},icon('plug'),element('span',{},'选择设备并连接'));
    const fields={baudRate:'38400',serviceUuid:'',writeUuid:'',notifyUuid:'',writeMode:'withResponse',mtuPayload:'20',wireMode:'',responseChecksum:''};
    function updateSubmit(){submit.disabled=!available[transport]||state.busy||!modelConfirmed.checked;}
    modelConfirmed.addEventListener('change',updateSubmit);
    function choose(method){
      Object.assign(fields,collectFields(details));transport=method;
      options.querySelectorAll('button').forEach(el=>{el.classList.toggle('is-active',el.dataset.transport===transport);el.setAttribute('aria-pressed',String(el.dataset.transport===transport));});
      details.replaceChildren();updateSubmit();
      if(transport==='serial')details.append(buildFields([{key:'baudRate',label:'串口波特率',type:'select',value:fields.baudRate,options:[{value:38400,label:'38400 · 目标 CPS 默认'},{value:115200,label:'115200 · 高级配置'}],help:'选择与设备当前写频接口一致的速率。'}],{},'connect'));
      if(transport==='usb')details.append(element('div',{class:'info-banner'},icon('usb'),element('span',{},'浏览器将请求设备访问权限。USB 标识仅用于筛选，连接后仍需核对型号与固件回复。')));
      if(transport==='ble'){
        details.append(element('div',{class:'info-banner warning'},icon('info'),element('span',{},available.bleReason||'尚无已核实的 K10 Pro 默认 UUID。请使用同型号实测的服务与特征；此处不会填入其他产品的 UUID。')));
        details.append(buildFields([
          {key:'serviceUuid',label:'服务 UUID',type:'text',value:fields.serviceUuid,required:true,placeholder:'同型号确认的服务 UUID'},
          {key:'writeUuid',label:'写入特征 UUID',type:'text',value:fields.writeUuid,required:true},
          {key:'notifyUuid',label:'通知特征 UUID',type:'text',value:fields.notifyUuid,required:true},
          {key:'writeMode',label:'GATT 写入方式',type:'select',value:fields.writeMode,options:[{value:'withResponse',label:'带响应'},{value:'withoutResponse',label:'无响应'}]},
          {key:'mtuPayload',label:'单次写入负载 / B',type:'number',value:fields.mtuPayload,min:1,max:512,step:1,help:'传输分片长度必须与已核实的模块行为相符。'},
          {key:'wireMode',label:'帧体编码',type:'select',value:fields.wireMode,required:true,options:[{value:'',label:'请选择已核实的编码'},{value:'plain',label:'明文帧体'},{value:'xor',label:'XOR16 帧体'}],help:'必须来自同型号蓝牙链路证据，不沿用串口假设。'},
          {key:'responseChecksum',label:'响应校验方式',type:'select',value:fields.responseChecksum,required:true,options:[{value:'',label:'请选择已核实的校验'},{value:'placeholder',label:'FFFF 占位'},{value:'crc16-x25',label:'CRC16/X25'}]},
        ],{},'connect'));
      }
    }
    methods.forEach(([key,glyph,label,note])=>options.append(element('button',{type:'button',class:'connection-option','data-transport':key,disabled:!available[key],'aria-pressed':String(transport===key),on:{click:()=>choose(key)}},icon(glyph),element('strong',{},label),element('span',{},available[key]?note:'当前浏览器不可用'))));
    body.append(options,details,element('div',{class:'connection-details'},element('strong',{},'连接影响'),element('p',{},'目标协议的 HELLO 会同步设备 RTC。确认机型、核对固件回复并建立读取基线后，才开放设备写入。')),
      element('ul',{class:'connection-help-list'},element('li',{},'当前目标：UV-K10 Pro / ENG 8.02.16；USB VID/PID、固件字符串和参数版本均不能单独唯一确认机型。'),element('li',{},'需要 HTTPS 或 localhost，并由浏览器弹窗授权设备访问。')),
      element('label',{class:'preview-confirm model-confirm',for:'connection-model-confirm'},modelConfirmed,element('span',{},'我已核对设备本体型号，确认将连接的是 UV-K10 Pro。')));
    form.append(body,element('footer',{class:'modal-footer'},button('取消',()=>dialog.close(),{tone:'quiet'}),submit));
    form.addEventListener('submit',event=>{
      event.preventDefault();if(!form.reportValidity()||!modelConfirmed.checked||!available[transport]||state.busy)return;
      Object.assign(fields,collectFields(details));
      // Invoke synchronously inside the user's submit gesture so browser
      // device permission pickers retain transient user activation.
      const request=invoke('connect',{transport,selectedModel:'UV-K10 Pro',modelConfirmed:true,baudRate:Number(fields.baudRate),serviceUuid:fields.serviceUuid,writeUuid:fields.writeUuid,notifyUuid:fields.notifyUuid,writeMode:fields.writeMode,mtuPayload:Number(fields.mtuPayload),wireMode:fields.wireMode,responseChecksum:fields.responseChecksum});
      dialog.close();void request;
    });
    dialog.append(form);choose(transport);show(dialog);
  }

  function openAuthentication() {
    if(state.busy||model.connection.state!=='connected'||!model.connection.passwordRequired)return;
    const dialog=byId('authentication-dialog');
    dialog.replaceChildren(modalHeader('输入设备密码','authentication-title','使用设备当前设置的密码完成本次连接认证。',dialog));
    const form=element('form'),body=element('div',{class:'modal-body'});
    const password=element('input',{type:'password',id:'device-password',name:'device-password',class:'field-control',autocomplete:'current-password',autocapitalize:'none',spellcheck:false,required:true,'aria-describedby':'device-password-help'});
    const error=element('div',{class:'form-error',hidden:true,role:'alert'});
    const submit=element('button',{type:'submit',class:'button button-primary'},icon('shield'),element('span',{},'认证设备'));
    body.append(element('div',{class:'form-field'},element('label',{class:'form-label',for:'device-password'},'设备密码'),password,
      element('p',{class:'field-help',id:'device-password-help'},'密码仅用于当前认证；提交或关闭后清空，不写入工作区、浏览器本地存储或日志。')),error);
    form.append(body,element('footer',{class:'modal-footer'},button('取消',()=>dialog.close(),{tone:'quiet'}),submit));
    let submitting=false;
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(submitting||state.busy||model.connection.state!=='connected'||!model.connection.passwordRequired||!form.reportValidity())return;
      const credentials={password:password.value};
      password.value='';password.disabled=true;submit.disabled=true;error.hidden=true;submitting=true;
      try {
        const result=await invoke('authenticate',credentials);
        if(result.ok)dialog.close();
        else if(dialog.open){error.textContent=result.error||'认证未完成，请检查设备密码后重试。';error.hidden=false;}
      } finally {
        credentials.password='';password.value='';password.disabled=false;submit.disabled=false;submitting=false;
        if(dialog.open)password.focus();
      }
    });
    dialog.append(form);show(dialog);password.focus();
  }

  function openWritePreview({changes=model.changes,summary,canWrite=false,reason=''}={}) {
    const dialog=byId('preview-dialog');
    dialog.replaceChildren(modalHeader('审阅写入差分','preview-title','核对本次具体修改，再确认写入当前连接的设备。',dialog));
    const body=element('div',{class:'modal-body'});
    const details=typeof summary==='object'&&summary?summary:{};
    const totalBytes=details.bytes??changes.reduce((sum,change)=>sum+Number(change.length||0),0);
    body.append(element('div',{class:'preview-summary'},
      element('div',{},element('span',{},'目标设备'),element('strong',{},model.connection.label||'UV-K10 Pro')),
      element('div',{},element('span',{},'差分区段'),element('strong',{},`${changes.length} 项`)),
      element('div',{},element('span',{},'修改字节'),element('strong',{},`${Number(totalBytes).toLocaleString('zh-CN')} B`))));
    if(typeof summary==='string')body.append(element('div',{class:'info-banner'},icon('info'),element('span',{},summary)));
    if(details.message)body.append(element('div',{class:'info-banner'},icon('info'),element('span',{},details.message)));
    if(!canWrite)body.append(element('div',{class:'info-banner warning'},icon('info'),element('span',{},reason||'当前仅能审阅离线差分。连接并核对目标设备、读取完整基线后才能写入。')));
    else if(reason)body.append(element('div',{class:'info-banner'},icon('info'),element('span',{},reason)));
    body.append(changes.length?element('div',{class:'preview-diff-wrap'},diffTable(changes,{limit:500})):emptyState({title:'没有待写入修改',message:'工作区与读取基线一致。',iconName:'check',actions:false,compact:true}));
    const checkbox=element('input',{type:'checkbox',id:'write-review-confirm',disabled:!canWrite||!changes.length});
    body.append(element('label',{class:'preview-confirm',for:'write-review-confirm'},checkbox,element('span',{},'已核对目标设备和上述修改，确认将本次差分写入设备，并执行读回核对。')));
    const write=button('确认写入设备',async()=>{
      if(!canWrite||!checkbox.checked||state.busy)return;
      write.disabled=true;
      const result=await invoke('write');
      if(result.ok)dialog.close();else write.disabled=!checkbox.checked||state.busy;
    },{tone:'primary',iconName:'upload',disabled:true});
    checkbox.addEventListener('change',()=>{write.disabled=!canWrite||!checkbox.checked||state.busy||!changes.length;});
    dialog.append(body,element('footer',{class:'modal-footer'},element('span',{class:'modal-footer-note'},'收到 ACK 后仍需读回验证'),button('返回编辑',()=>dialog.close(),{tone:'quiet'}),write));
    show(dialog);
  }

  function confirm({title='确认操作',message='',confirmLabel='确认',danger=false}={}) {
    const dialog=byId('confirm-dialog');
    if(confirmResolve){confirmResolve(false);confirmResolve=null;}
    dialog.replaceChildren(modalHeader(title,'confirm-title','',dialog),element('div',{class:'modal-body'},element('p',{class:'confirm-message'},message)));
    const promise=new Promise(resolve=>{confirmResolve=resolve;});
    dialog.append(element('footer',{class:'modal-footer'},button('取消',()=>dialog.close(),{tone:'quiet'}),button(confirmLabel,()=>{const resolve=confirmResolve;confirmResolve=null;dialog.close();resolve?.(true);},{tone:danger?'danger':'primary'})));
    show(dialog);return promise;
  }

  function openHelp() {
    const dialog=byId('help-dialog');
    dialog.replaceChildren(modalHeader('使用说明与兼容性','help-title','面向 UV-K10 Pro 的浏览器本地写频工作区。',dialog));
    const content=element('div',{class:'modal-body help-content'});
    content.append(element('section',{},element('h3',{},'建议的操作顺序'),element('ol',{},element('li',{},'导入已有备份，或连接设备并读取配置。'),element('li',{},'导出一份工作区项目，保留修改前的来源和数据。'),element('li',{},'编辑信道、接收芯片存台、扫描列表和设置，并应用到工作区。'),element('li',{},'打开写入预览，核对具体差分；满足设备条件后再确认写入。'))),
      element('section',{},element('h3',{},'设备和软件范围'),element('p',{},'界面只采用 UV-K10 Pro / K8 的数据布局。Android 包中的 K82、UV5 配置不会用于此工作区。当前固定固件参考为 ENG 8.02.16；识别失败或版本不符时，设备写入应由控制器保持关闭。')),
      element('section',{},element('h3',{},'广播存台与音频器件'),element('p',{},'Si4732 的多波段存台与 BK1080 的 FM 存台分别编辑。切换视图不是更换设备芯片，也不证明芯片已焊装。4898 为用户补充的音频功放标记，功放本身不作为存台或频率调谐器。')),
      element('section',{},element('h3',{},'浏览器连接'),element('p',{},'Web Serial、WebUSB、Web Bluetooth 的可用性取决于浏览器、操作系统及设备授权。请使用 HTTPS 或 localhost；蓝牙连接需要同型号确认的 GATT UUID。'),element('p',{},'连接的 HELLO 流程会同步设备 RTC。USB 标识或参数版本值不能单独确认机型。')),
      element('section',{},element('h3',{},'数据来源'),element('p',{},'演示工作区由合成输入生成，并不来自实机。未知字段保留原始字节；只读或未确认字段不在通用表单中自动修正。写入结果需以读回核对为准。')));
    dialog.append(content,element('footer',{class:'modal-footer'},button('知道了',()=>dialog.close(),{tone:'primary'})));show(dialog);
  }

  listen(byId('connect-button'),'click',()=>model.connection.state==='connected'?invoke('disconnect'):openConnection());
  listen(byId('authenticate-button'),'click',openAuthentication);
  listen(byId('read-button'),'click',()=>invoke('read',{scope:'all'}));
  listen(byId('write-button'),'click',()=>invoke('preview-write'));
  listen(byId('import-button'),'click',importFile);
  listen(byId('import-file'),'change',event=>{const file=event.target.files?.[0];event.target.value='';if(file)void invoke('import',{file});});
  listen(byId('cancel-button'),'click',()=>invoke('cancel'));
  listen(byId('help-button'),'click',openHelp);
  listen(byId('menu-button'),'click',()=>{const open=byId('sidebar').classList.toggle('is-open');byId('mobile-scrim').hidden=!open;byId('menu-button').setAttribute('aria-expanded',String(open));});
  listen(byId('mobile-scrim'),'click',closeNavigation);
  document.querySelectorAll('.nav-item').forEach(el=>listen(el,'click',()=>navigate(el.dataset.view)));
  listen(byId('confirm-dialog'),'close',()=>{if(confirmResolve){confirmResolve(false);confirmResolve=null;}});
  listen(byId('authentication-dialog'),'close',()=>{const password=byId('authentication-dialog').querySelector('input[type="password"]');if(password)password.value='';});
  for(const dialog of dialogs)listen(dialog,'click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
  render();
  return {render,toast,openEditor,openWritePreview,closeDialog,setBusy,confirm,navigate,destroy(){abort.abort();for(const timer of timers)clearTimeout(timer);timers.clear();closeDialog();if(confirmResolve){confirmResolve(false);confirmResolve=null;}}};
}
