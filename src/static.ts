// Static assets inlined as strings (Workers can't read local files)

export const SW_JS = `// Service Worker for NCM→AM push notifications

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body || '',
    icon: '🎵',
    badge: '🎵',
    tag: data.tag || 'ncm-am-sync',
    data: data.url || '/',
    actions: [],
  };
  if (data.type === 'success') {
    options.actions = [{ action: 'open', title: '查看歌单' }];
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'NCM→AM 同步', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});
`;

export function subscribeHtml(vapidPublicKey: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NCM→AM 同步通知</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#1a1a2e;border-radius:16px;padding:32px;max-width:400px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
    .icon{font-size:48px;margin-bottom:16px}
    h1{font-size:20px;margin-bottom:8px;color:#fff}
    p{font-size:14px;color:#888;margin-bottom:24px;line-height:1.5}
    .btn{display:inline-block;padding:12px 32px;border-radius:8px;border:none;font-size:16px;font-weight:600;cursor:pointer;transition:all .2s;width:100%}
    .btn-sub{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
    .btn-sub:hover{transform:scale(1.02)}
    .btn-sub:disabled{background:#333;cursor:not-allowed;transform:none}
    .btn-unsub{background:transparent;color:#ff6b6b;border:1px solid #ff6b6b;margin-top:12px}
    .status{margin-top:16px;font-size:13px;padding:8px;border-radius:8px}
    .status.ok{background:#1a3a1a;color:#4ade80}
    .status.err{background:#3a1a1a;color:#ff6b6b}
    .status.info{background:#1a1a3a;color:#60a5fa}
    .hidden{display:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎵</div>
    <h1>NCM → AM 每日同步</h1>
    <p>订阅推送通知，每天同步完成后收到浏览器通知</p>
    <button id="btn-sub" class="btn btn-sub" onclick="doSubscribe()">开启通知</button>
    <button id="btn-unsub" class="btn btn-unsub hidden" onclick="doUnsubscribe()">取消订阅</button>
    <div id="status" class="status hidden"></div>
  </div>
  <script>
    const VAPID_PUBLIC_KEY='${vapidPublicKey}';
    function urlBase64ToUint8Array(b){const p='='.repeat((4-b.length%4)%4),a=(b+p).replace(/-/g,'+').replace(/_/g,'/'),d=atob(a);return Uint8Array.from(d,c=>c.charCodeAt(0))}
    function show(m,t){const e=document.getElementById('status');e.textContent=m;e.className='status '+t;e.classList.remove('hidden')}
    async function check(){if(!('serviceWorker'in navigator)||!('PushManager'in window)){show('浏览器不支持推送','err');document.getElementById('btn-sub').disabled=true;return}const r=await navigator.serviceWorker.ready,s=await r.pushManager.getSubscription();if(s){document.getElementById('btn-sub').classList.add('hidden');document.getElementById('btn-unsub').classList.remove('hidden');show('✅ 已订阅','ok')}}
    async function doSubscribe(){const b=document.getElementById('btn-sub');b.disabled=true;b.textContent='请求权限中...';try{const p=await Notification.requestPermission();if(p!=='granted'){show('❌ 通知权限被拒绝','err');b.disabled=false;b.textContent='开启通知';return}b.textContent='订阅中...';const r=await navigator.serviceWorker.ready,s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(VAPID_PUBLIC_KEY)});const resp=await fetch('/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s.toJSON())});if(resp.ok){show('✅ 订阅成功！每天同步后会推送通知','ok');document.getElementById('btn-sub').classList.add('hidden');document.getElementById('btn-unsub').classList.remove('hidden')}else{show('❌ 订阅失败','err');b.disabled=false;b.textContent='开启通知'}}catch(e){show('❌ '+e.message,'err');b.disabled=false;b.textContent='开启通知'}}
    async function doUnsubscribe(){const r=await navigator.serviceWorker.ready,s=await r.pushManager.getSubscription();if(s){await fetch('/subscribe',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:s.endpoint})});await s.unsubscribe()}document.getElementById('btn-sub').classList.remove('hidden');document.getElementById('btn-sub').disabled=false;document.getElementById('btn-unsub').classList.add('hidden');show('已取消订阅','info')}
    if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').then(check);
  </script>
</body>
</html>`;
}
