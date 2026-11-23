// Independent opt-in test page: no app.js, model configuration, or chat database imports.
(()=>{
 const $=id=>document.getElementById(id),store=HaishenPushStore;
 let registration,config,backend,device,busy=false,connected=false;
 const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const capable=isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 const status=m=>{$('status').textContent=m;};
 const keyBytes=s=>{const raw=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0));};
 function controls(){
  $('connect').disabled=busy;
  $('subscribe').disabled=busy||!connected||!registration||!capable||(ios&&!standalone)||!!device;
  for(const id of ['send-now','send-later','revoke'])$(id).disabled=busy||!connected||!device;
  $('check-job').disabled=busy||!connected||!device||(!device.lastJob&&!device.lastRequest);
  $('device-state').textContent=device?`已配对本机 ID：${device.deviceId}。凭证七天有效；这不是模型密钥。`:'还没有设备凭证。';
 }
 async function api(path,{method='GET',body,authenticated=true}={}){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';
  if(authenticated){if(!device)throw new Error('请先配对本机');headers.Authorization=`Bearer ${device.deviceId}.${device.token}`;}
  const r=await fetch(backend+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(12000)});
  let data;try{data=await r.json();}catch{throw new Error('后台响应格式错误，请检查 Worker 地址与部署');}
  if(!r.ok){const e=new Error(data.error||'请求失败');e.httpStatus=r.status;throw e;}return data;
 }
 async function perform(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){status(e.name==='NotAllowedError'?'通知未获允许。请从主屏幕打开，并在 iOS 设置中检查通知权限。':e.message||'操作未完成');}finally{busy=false;controls();}}
 async function connect(){
  let u;try{u=new URL($('worker-url').value.trim());}catch{throw new Error('请填写自己部署的 Worker HTTPS 地址');}
  const local=['localhost','127.0.0.1'].includes(u.hostname);
  if((u.protocol!=='https:'&&!(local&&u.protocol==='http:'))||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('只填写 Worker HTTPS 域名，不要加接口路径、密钥或参数');
  backend=u.origin;connected=false;config=null;device=null;
  const saved=await store.get('device');if(saved?.backend===backend)device=saved;
  config=await api('/v1/config',{authenticated:false});
  if(config.version!==1||typeof config.publicKey!=='string'||keyBytes(config.publicKey).length!==65)throw new Error('后台公钥配置无效');
  await store.set('backend',backend);connected=true;status('后台已连接。只有点击“允许通知并注册本机”才申请权限。');
 }
 $('connect').addEventListener('click',()=>perform(connect));
 $('subscribe').addEventListener('click',()=>{
  if(busy||!connected||!registration||!capable||(ios&&!standalone))return;
  const code=$('pairing-code').value.trim();if(!/^[A-Za-z0-9_-]{43}$/.test(code)){status('请先填入管理员生成的一次性配对码');return;}
  // Permission-bearing call is made directly within this click, before any await.
  let pending;try{pending=registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(config.publicKey)});}catch(e){status(e.message);return;}
  perform(async()=>{
   const subscription=await pending;
   const value=await api('/v1/pair',{method:'POST',body:{code,subscription:subscription.toJSON()},authenticated:false});
   const candidate={...value,backend};
   try{await store.set('device',candidate);}catch{device=candidate;status('设备已注册，但本机凭证保存失败。请先注销，再处理浏览器存储问题。');return;}
   device=candidate;$('pairing-code').value='';status('本机配对完成。现在可以发送真实 Web Push 测试。');
  });
 });
 async function send(delaySeconds){
  const requestId=crypto.randomUUID();device.lastRequest=requestId;device.lastJob=null;await store.set('device',device);
  const job=await api('/v1/test',{method:'POST',body:{requestId,delaySeconds}});device.lastJob=job.jobId;await store.set('device',device);
  $('job-state').textContent=`${job.notice} 任务：${job.jobId}`;
  status(delaySeconds===15?'已提交一次性延迟测试。现在请离开 App 并锁屏；稍后回来查询发送状态。':job.notice);
 }
 $('send-now').addEventListener('click',()=>perform(()=>send(0)));
 $('send-later').addEventListener('click',()=>perform(()=>send(15)));
 $('check-job').addEventListener('click',()=>perform(async()=>{
  const path=device.lastJob?'/v1/jobs/'+device.lastJob:'/v1/requests/'+device.lastRequest;
  const j=await api(path);device.lastJob=j.jobId;await store.set('device',device);
  $('job-state').textContent=`${j.notice} 状态：${j.state}${j.httpStatus?'（HTTP '+j.httpStatus+'）':''}`;await renderNotices();
 }));
 $('revoke').addEventListener('click',()=>perform(async()=>{
  try{await api('/v1/device',{method:'DELETE'});}catch(e){if(e.httpStatus!==401)throw e;}
  await store.forgetDevice();device=null;
  const sub=await registration?.pushManager.getSubscription();if(sub)await sub.unsubscribe();
  status('服务端本机凭证已注销或已失效。本地订阅已取消；聊天、留言和测试接收记录均未清空。');
 }));
 async function renderNotices(){
  const records=await store.notices(),list=$('notices');list.replaceChildren();
  if(!records.length){const li=document.createElement('li');li.textContent='暂时没有本机接收记录。推送服务接受不等于本机已显示。';list.append(li);}
  for(const r of records.sort((a,b)=>b.receivedAt-a.receivedAt)){const li=document.createElement('li');li.textContent=`${r.title}\n${r.body}\n${new Date(r.receivedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · 北京时间`;list.append(li);}
  const id=new URL(location.href).searchParams.get('notice');if(id&&/^[0-9a-f-]{36}$/i.test(id))$('clicked-notice').textContent=`当前打开测试来信：${id}。固定正文为“老婆，今天也想你了。🐟💗”。`;
 }
 async function boot(){
  $('capabilities').textContent=!capable?'此环境暂不具备标准 Web Push 能力。iPhone 请使用支持的 iOS 版本并添加到主屏幕。':ios&&!standalone?'请先添加到主屏幕，再从“海神来信”图标打开后授权。':`标准 Web Push 可用；当前通知权限：${Notification.permission}。`;
  const savedBackend=await store.get('backend');if(savedBackend)$('worker-url').value=savedBackend;device=await store.get('device');backend=device?.backend||savedBackend;
  if(capable){
   const script=new URL('sw-push-v3.js',location.href),scope=new URL('./',location.href);
   const current=await navigator.serviceWorker.getRegistration(scope.href);
   if(current?.active&&current.active.scriptURL!==script.href)throw new Error('本路径已有其他 Service Worker；为避免覆盖，请先检查作用范围');
   registration=await navigator.serviceWorker.register(script.href,{scope:scope.href,updateViaCache:'none'});
   const worker=registration.installing||registration.waiting;
   if(!registration.active&&worker)await new Promise((resolve,reject)=>{if(worker.state==='activated'){resolve();return;}const timer=setTimeout(()=>reject(new Error('Service Worker 激活超时，请刷新重试')),10000);worker.addEventListener('statechange',()=>{if(worker.state==='activated'){clearTimeout(timer);resolve();}if(worker.state==='redundant'){clearTimeout(timer);reject(new Error('Service Worker 安装失败'));}});});
  }
  await renderNotices();controls();
 }
 boot().catch(e=>{status(e.message||'测试页面初始化失败');controls();});
})();
