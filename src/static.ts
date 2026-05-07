export const SW_JS = `self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body || '',
    icon: '🎵',
    badge: '🎵',
    tag: data.tag || 'ncm-am-sync',
    data: data.url || '/',
  };
  event.waitUntil(self.registration.showNotification(data.title || 'NCM → AM 同步', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});`;

export function subscribeHtml(vapidPublicKey: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NCM → AM 推送通知</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#0b1020;color:#e6edf7;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{width:min(420px,92vw);background:#121a2b;border:1px solid #253149;border-radius:18px;padding:28px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
    h1{margin:0 0 8px;font-size:22px}.desc{color:#98a2b3;margin:0 0 18px}.btn{width:100%;border:0;border-radius:10px;padding:12px 16px;font-weight:600;cursor:pointer}
    .primary{background:#4f46e5;color:#fff}.secondary{margin-top:10px;background:transparent;color:#fda4af;border:1px solid #7f1d1d}.status{margin-top:14px;padding:10px 12px;border-radius:10px;background:#111827;color:#cbd5e1}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔔 浏览器推送通知</h1>
    <p class="desc">同步完成或失败后，在当前浏览器接收通知。</p>
    <button id="sub" class="btn primary">开启通知</button>
    <button id="unsub" class="btn secondary" style="display:none">取消通知</button>
    <div id="status" class="status">等待操作</div>
  </div>
  <script>
    const PUBLIC_KEY = ${JSON.stringify(vapidPublicKey)};
    const statusEl = document.getElementById('status');
    function msg(text){statusEl.textContent=text;}
    function b64(input){const pad='='.repeat((4-input.length%4)%4);const base=(input+pad).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(base),c=>c.charCodeAt(0));}
    async function refresh(){
      const ready = await navigator.serviceWorker.ready;
      const sub = await ready.pushManager.getSubscription();
      document.getElementById('sub').style.display = sub ? 'none' : 'block';
      document.getElementById('unsub').style.display = sub ? 'block' : 'none';
      msg(sub ? '✅ 已订阅通知' : '未订阅通知');
    }
    document.getElementById('sub').onclick = async () => {
      try{
        if (Notification.permission !== 'granted') {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') throw new Error('通知权限被拒绝');
        }
        const ready = await navigator.serviceWorker.ready;
        const sub = await ready.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(PUBLIC_KEY)});
        const resp = await fetch('/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub.toJSON())});
        if(!resp.ok) throw new Error('订阅请求失败');
        await refresh();
      }catch(error){msg('❌ '+error.message);}
    };
    document.getElementById('unsub').onclick = async () => {
      const ready = await navigator.serviceWorker.ready;
      const sub = await ready.pushManager.getSubscription();
      if (sub) {
        await fetch('/subscribe',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});
        await sub.unsubscribe();
      }
      await refresh();
    };
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(refresh);
  </script>
</body>
</html>`;
}
