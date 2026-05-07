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


export function frontendHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NCM → Apple Music</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh}
.container{max-width:900px;margin:0 auto;padding:20px}
.auth{display:flex;align-items:center;justify-content:center;min-height:100vh}
.auth-card{background:#1a1a2e;border-radius:16px;padding:40px;max-width:400px;width:90%;text-align:center}
.auth-card h1{font-size:24px;margin-bottom:8px;color:#fff}
.auth-card p{font-size:14px;color:#888;margin-bottom:24px}
.auth input{width:100%;padding:12px;border-radius:8px;border:1px solid #333;background:#111;color:#fff;font-size:15px;margin-bottom:16px;outline:none}
.auth input:focus{border-color:#667eea}
.auth label{display:flex;align-items:center;gap:8px;font-size:13px;color:#888;margin-bottom:16px;cursor:pointer}
.btn{display:inline-block;padding:12px 32px;border-radius:8px;border:none;font-size:15px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;width:100%}
.btn-primary:hover{transform:scale(1.02)}
.btn-primary:disabled{background:#333;cursor:not-allowed;transform:none}
.btn-secondary{background:#2a2a3e;color:#ccc;border:1px solid #444}
.btn-secondary:hover{background:#3a3a4e}
.btn-danger{background:transparent;color:#ff6b6b;border:1px solid #ff6b6b}
.btn-sm{padding:8px 16px;font-size:13px}
.notifications{margin-top:20px;max-height:300px;overflow-y:auto}
.notify-item{padding:8px 12px;border-radius:8px;margin-bottom:6px;font-size:13px;display:flex;align-items:flex-start;gap:8px}
.notify-item.success{background:#1a3a1a;color:#4ade80}
.notify-item.error{background:#3a1a1a;color:#ff6b6b}
.notify-item.info{background:#1a1a3a;color:#60a5fa}
.notify-item .notify-time{font-size:11px;color:#666;flex-shrink:0}
.push-widget{margin-top:16px;padding:12px;border-radius:8px;background:#1a1a2e;display:flex;align-items:center;gap:12px;font-size:13px}
.push-widget button{padding:6px 14px;border-radius:6px;border:none;font-size:12px;cursor:pointer}
.push-sub{background:#667eea;color:#fff}
.push-unsub{background:transparent;color:#ff6b6b;border:1px solid #ff6b6b}
.push-status{color:#888;flex:1}
.steps{display:flex;gap:4px;margin-bottom:24px}
.step{flex:1;height:4px;border-radius:2px;background:#2a2a3e;transition:background .3s}
.step.active{background:#667eea}
.step.done{background:#4ade80}
.step.error{background:#ff6b6b}
.header{display:flex;align-items:center;justify-content:space-between;padding:16px 0;border-bottom:1px solid #1a1a2e;margin-bottom:20px}
.header h2{font-size:18px;color:#fff}
.header .badge{font-size:12px;padding:4px 10px;border-radius:12px;background:#1a3a1a;color:#4ade80}
.loading{display:flex;align-items:center;justify-content:center;padding:60px;gap:12px;color:#888}
.spinner{width:24px;height:24px;border:3px solid #333;border-top-color:#667eea;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.songs{display:grid;gap:8px}
.song{display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;background:#1a1a2e;transition:background .2s}
.song:hover{background:#222240}
.song img{width:48px;height:48px;border-radius:6px;object-fit:cover;flex-shrink:0}
.song .info{flex:1;min-width:0}
.song .name{font-size:14px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.song .artist{font-size:12px;color:#888;margin-top:2px}
.song a{color:#667eea;text-decoration:none;font-size:12px}
.song a:hover{text-decoration:underline}
.am-result{display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;background:#1a1a2e}
.am-result.found{border-left:3px solid #4ade80}
.am-result.not-found{border-left:3px solid #ff6b6b}
.am-result .am-name{font-size:14px;color:#fff}
.am-result .am-artist{font-size:12px;color:#888}
.am-result .ncm-side{flex:1;min-width:0}
.am-result .arrow{color:#555;font-size:20px;flex-shrink:0}
.am-result .am-side{flex:1;min-width:0}
.search-box{display:flex;gap:8px;margin-top:8px}
.search-box input{flex:1;padding:8px;border-radius:6px;border:1px solid #333;background:#111;color:#fff;font-size:13px;outline:none}
.search-box input:focus{border-color:#667eea}
.stats{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.stat{font-size:13px;padding:6px 12px;border-radius:8px;background:#1a1a2e}
.stat .num{font-weight:700;margin-right:4px}
.stat.green .num{color:#4ade80}
.stat.red .num{color:#ff6b6b}
.stat.blue .num{color:#60a5fa}
.actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.summary{background:#1a1a2e;border-radius:12px;padding:24px;margin:20px 0}
.summary h3{color:#fff;margin-bottom:16px;font-size:18px}
.summary-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #222;font-size:14px}
.summary-row:last-child{border:none}
.summary-row .label{color:#888}
.summary-row .value{color:#fff;font-weight:600}
.phase-card{background:#111;border:1px solid #222;border-radius:12px;padding:16px;margin-bottom:12px}
.phase-card .phase-title{font-size:15px;font-weight:600;color:#fff;margin-bottom:8px}
.phase-card .phase-detail{font-size:13px;color:#888;line-height:1.6}
.hidden{display:none!important}
</style>
</head>
<body>
<div id="auth-screen" class="auth">
  <div class="auth-card">
    <h1>🎵 NCM → AM</h1>
    <p>网易云音乐日推同步到 Apple Music</p>
    <input id="token-input" type="password" placeholder="输入 Sync Token" autofocus>
    <label><input id="auto-check" type="checkbox"> Automatic Skip Missing Songs</label>
    <button class="btn btn-primary" onclick="startSync()">开始同步</button>
    <div id="resume-box" class="hidden" style="margin-top:12px">
      <div style="font-size:13px;color:#888;margin-bottom:8px">发现未完成的会话</div>
      <button class="btn btn-secondary" style="width:100%" onclick="resumeSession()">继续上次同步</button>
    </div>
    <div id="auth-error" class="hidden" style="margin-top:12px;color:#ff6b6b;font-size:13px"></div>
  </div>
</div>
<div id="wizard-screen" class="container hidden">
  <div class="steps" id="steps">
    <div class="step" data-step="1"></div>
    <div class="step" data-step="2"></div>
    <div class="step" data-step="3"></div>
    <div class="step" data-step="4"></div>
    <div class="step" data-step="5"></div>
  </div>
  <div id="content"></div>
  <div id="phase-summaries"></div>
  <div id="notifications" class="notifications"></div>
  <div id="push-widget" class="push-widget hidden">
    <span>🔔 推送通知</span>
    <button id="btn-push-sub" class="push-sub" onclick="doPushSubscribe()">开启</button>
    <button id="btn-push-unsub" class="push-unsub hidden" onclick="doPushUnsubscribe()">取消</button>
    <span id="push-status" class="push-status"></span>
  </div>
</div>
<script>
const BASE = location.origin;
let TOKEN = '';
let SESSION = '';
let AUTO = false;
let VAPID_KEY = '';

function saveAuth() {
  localStorage.setItem('ncm_am_token', TOKEN);
  localStorage.setItem('ncm_am_session', SESSION);
  localStorage.setItem('ncm_am_auto', AUTO ? '1' : '0');
}
function loadAuth() {
  TOKEN = localStorage.getItem('ncm_am_token') || '';
  SESSION = localStorage.getItem('ncm_am_session') || '';
  AUTO = localStorage.getItem('ncm_am_auto') === '1';
  return !!TOKEN;
}
async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const resp = await fetch(BASE + path + sep + 'token=' + encodeURIComponent(TOKEN));
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return resp.json();
}
async function startSync() {
  TOKEN = document.getElementById('token-input').value.trim();
  AUTO = document.getElementById('auto-check').checked;
  if (!TOKEN) { showAuthError('请输入 Token'); return; }
  document.querySelector('#auth-screen .btn').disabled = true;
  document.querySelector('#auth-screen .btn').textContent = '连接中...';
  try {
    const s = await api('/sync?auto=' + (AUTO ? '1' : '0'));
    SESSION = s.id;
    saveAuth();
    showWizard();
    notify('info', '同步已启动' + (AUTO ? '（自动模式）' : ''));
    renderPhase(s);
    if (AUTO && s.phase === 2 && s.status === 'running') {
      notify('info', 'Phase 1 完成，开始搜索 Apple Music');
      setTimeout(() => runPhase(2), 500);
    }
  } catch (e) {
    notify('error', '❌ ' + e.message);
    showAuthError(e.message);
    document.querySelector('#auth-screen .btn').disabled = false;
    document.querySelector('#auth-screen .btn').textContent = '开始同步';
  }
}
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function showWizard() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('wizard-screen').classList.remove('hidden');
  document.getElementById('push-widget').classList.remove('hidden');
}
function updateSteps(phase, status) {
  document.querySelectorAll('.step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.className = 'step';
    if (status === 'error' && s === Math.ceil(phase)) el.classList.add('error');
    else if (s < Math.ceil(phase)) el.classList.add('done');
    else if (s === Math.ceil(phase)) el.classList.add('active');
  });
}
function renderPhase(s) {
  updateSteps(s.phase, s.status);
  const c = document.getElementById('content');
  if (s.status === 'error') { c.innerHTML = errorView(s); return; }
  switch (s.phase) {
    case 1: c.innerHTML = phase1View(s); break;
    case 2: c.innerHTML = phase2View(s); break;
    case 2.5: c.innerHTML = phase2ReviewView(s); break;
    case 3: case 4: case 5:
      appendPhaseSummary(s); break;
    default: c.innerHTML = '<p>Unknown phase</p>';
  }
}
function appendPhaseSummary(s) {
  const box = document.getElementById('phase-summaries');
  const found = (s.amResults || []).filter(r => r.status === 'found').length;
  const info = {
    3: { title: '📋 Phase 3 — 创建歌单', detail: '歌单: ' + esc(s.playlistName || '...') + (s.playlistId ? ' ✅' : ' ⏳') },
    4: { title: '➕ Phase 4 — 添加歌曲', detail: '已添加 ' + (s.addedCount || 0) + ' 首到歌单 ✅' },
    5: { title: '🎉 Phase 5 — 同步完成', detail: s.date + ' | ' + found + '/' + s.ncmTotal + ' 首已同步 | 歌单: ' + esc(s.playlistName || '') + (s.deletedPlaylists?.length ? ' | 清理: ' + s.deletedPlaylists.join(', ') : '') },
  }[s.phase];
  if (!info) return;
  const card = document.createElement('div');
  card.className = 'phase-card';
  card.innerHTML = '<div class="phase-title">' + info.title + '</div><div class="phase-detail">' + info.detail + '</div>';
  box.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function phase1View(s) {
  const songs = s.ncmSongs || [];
  return \`
    <div class="header">
      <h2>📀 Phase 1 — 网易云日推</h2>
      <span class="badge">共 \${songs.length} 首</span>
    </div>
    <div class="songs">
      \${songs.map(song => \`
        <div class="song">
          <img src="\${song.cover || ''}" alt="" onerror="this.style.display='none'">
          <div class="info">
            <div class="name">\${esc(song.name)}</div>
            <div class="artist">\${esc(song.artist)} — \${esc(song.album)}</div>
            <a href="\${song.ncmUrl}" target="_blank">网易云 ↗</a>
          </div>
        </div>
      \`).join('')}
    </div>
    <div class="actions">
      <button class="btn btn-primary" onclick="runPhase(2)">搜索 Apple Music →</button>
    </div>
  \`;
}
function phase2View(s) {
  const total = s.ncmTotal || 0;
  const processed = (s.amBatchIndex || 0) * (s.amBatchSize || 20);
  const results = s.amResults || [];
  const found = results.filter(r => r.status === 'found').length;
  const notFound = results.filter(r => r.status !== 'found').length;
  const done = s.amBatchIndex >= Math.ceil(total / (s.amBatchSize || 20));
  if (!done) {
    return \`
      <div class="header">
        <h2>🔍 Phase 2 — 搜索 Apple Music</h2>
        <span class="badge">\${s.storefront?.toUpperCase() || 'JP'} 区</span>
      </div>
      <div class="loading">
        <div class="spinner"></div>
        <span>搜索中... \${Math.min(processed, total)}/\${total} 首</span>
      </div>
      <div class="stats">
        <div class="stat green"><span class="num">\${found}</span>已找到</div>
        <div class="stat red"><span class="num">\${notFound}</span>未找到</div>
      </div>
    \`;
  }
  return phase2ReviewView(s);
}
function phase2ReviewView(s) {
  const results = s.amResults || [];
  const found = results.filter(r => r.status === 'found');
  const notFound = results.filter(r => r.status !== 'found');
  return \`
    <div class="header">
      <h2>🔍 Phase 2 — 搜索结果</h2>
      <span class="badge">\${s.storefront?.toUpperCase() || 'JP'} 区</span>
    </div>
    <div class="stats">
      <div class="stat green"><span class="num">\${found.length}</span>已找到</div>
      <div class="stat red"><span class="num">\${notFound.length}</span>未找到</div>
      <div class="stat blue"><span class="num">\${s.ncmTotal}</span>总计</div>
    </div>
    \${notFound.length > 0 ? \`
      <h3 style="color:#ff6b6b;margin:16px 0 8px;font-size:15px">❌ 未找到的歌曲</h3>
      <div class="songs">
        \${notFound.map(r => \`
          <div class="am-result not-found">
            <div class="ncm-side">
              <div class="name" style="font-size:13px">\${esc(r.ncmName)}</div>
              <div class="artist">\${esc(r.ncmArtist)}</div>
            </div>
            <div class="search-box" style="flex:1">
              <input placeholder="搜索 Apple Music..." id="search-\${r.ncmId}" onkeydown="if(event.key==='Enter')doSearch(\${r.ncmId})">
              <button class="btn btn-secondary btn-sm" onclick="doSearch(\${r.ncmId})">搜索</button>
            </div>
          </div>
        \`).join('')}
      </div>
    \` : ''}
    \${found.length > 0 ? \`
      <h3 style="color:#4ade80;margin:16px 0 8px;font-size:15px">✅ 已匹配</h3>
      <div class="songs">
        \${found.map(r => \`
          <div class="am-result found">
            <div class="ncm-side">
              <div class="name" style="font-size:13px">\${esc(r.ncmName)}</div>
              <div class="artist">\${esc(r.ncmArtist)}</div>
            </div>
            <div class="arrow">→</div>
            <div class="am-side">
              <div class="am-name">\${esc(r.amName || '')}</div>
              <div class="am-artist">\${esc(r.amArtist || '')}</div>
            </div>
          </div>
        \`).join('')}
      </div>
    \` : ''}
    <div class="actions">
      <button class="btn btn-primary" onclick="runPhase('2-skip')">跳过未找到，继续 →</button>
    </div>
  \`;
}

function errorView(s) {
  return \`
    <div class="header"><h2>❌ 出错了</h2></div>
    <div class="summary">
      \${s.errors.map(e => '<div style="color:#ff6b6b;padding:8px 0;font-size:14px">' + esc(e) + '</div>').join('')}
    </div>
    <div class="actions">
      <button class="btn btn-secondary" onclick="location.reload()">重试</button>
    </div>
  \`;
}
async function runPhase(phase) {
  const c = document.getElementById('content');
  const names = {1:'获取网易云日推',2:'搜索 Apple Music','2-skip':'跳过未匹配',3:'创建歌单',4:'添加歌曲',5:'清理旧歌单'};
  c.innerHTML = '<div class="loading"><div class="spinner"></div><span>' + (names[phase] || '处理中') + '...</span></div>';
  try {
    const s = await api('/sync?phase=' + phase + '&session=' + SESSION);
    renderPhase(s);
    // Phase 2 batch polling
    if (s.phase === 2 && s.status === 'running') {
      setTimeout(() => runPhase(2), 500);
      return;
    }
    // Auto-chain
    if (s.status === 'running') {
      const next = {2:3,3:4,4:5}[s.phase];
      if (next) {
        if (s.phase === 2 && !AUTO) return;
        notify('info', 'Phase ' + s.phase + ' 完成，继续 Phase ' + next);
        setTimeout(() => runPhase(next), 300);
      }
    }
    if (s.status === 'done') {
      const found = (s.amResults || []).filter(r => r.status === 'found').length;
      notify('success', '✅ 同步完成！' + found + '/' + s.ncmTotal + ' 首已同步');
      localStorage.removeItem('ncm_am_session');
    }
  } catch (e) {
    notify('error', '❌ ' + e.message);
    c.innerHTML = errorView({ errors: [e.message] });
  }
}
function notify(type, msg) {
  const box = document.getElementById('notifications');
  if (!box) return;
  const time = new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const div = document.createElement('div');
  div.className = 'notify-item ' + type;
  div.innerHTML = '<span class="notify-time">' + time + '</span><span>' + msg + '</span>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
async function doSearch(ncmId) {
  const input = document.getElementById('search-' + ncmId);
  const query = input.value.trim();
  if (!query) return;
  input.disabled = true;
  input.nextElementSibling.disabled = true;
  input.nextElementSibling.textContent = '搜索中...';
  try {
    const s = await api('/sync?phase=2.5&session=' + SESSION + '&ncmId=' + ncmId + '&query=' + encodeURIComponent(query));
    renderPhase(s);
  } catch (e) {
    alert('搜索失败: ' + e.message);
    input.disabled = false;
    input.nextElementSibling.disabled = false;
    input.nextElementSibling.textContent = '搜索';
  }
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function urlBase64ToUint8Array(b){const p='='.repeat((4-b.length%4)%4),a=(b+p).replace(/-/g,'+').replace(/_/g,'/'),d=atob(a);return Uint8Array.from(d,c=>c.charCodeAt(0))}
async function checkPushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const r = await navigator.serviceWorker.ready;
    const s = await r.pushManager.getSubscription();
    if (s) {
      document.getElementById('btn-push-sub').classList.add('hidden');
      document.getElementById('btn-push-unsub').classList.remove('hidden');
      document.getElementById('push-status').textContent = '✅ 已订阅';
    }
  } catch(e) {}
}
async function doPushSubscribe() {
  const btn = document.getElementById('btn-push-sub');
  btn.disabled = true; btn.textContent = '...';
  try {
    if (!VAPID_KEY) { const r = await api('/vapid-key'); VAPID_KEY = r.publicKey; }
    const p = await Notification.requestPermission();
    if (p !== 'granted') { document.getElementById('push-status').textContent = '❌ 权限被拒绝'; btn.disabled = false; btn.textContent = '开启'; return; }
    const r = await navigator.serviceWorker.ready;
    const s = await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(VAPID_KEY)});
    const resp = await fetch(BASE + '/subscribe?token=' + encodeURIComponent(TOKEN), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s.toJSON())});
    if (resp.ok) {
      document.getElementById('btn-push-sub').classList.add('hidden');
      document.getElementById('btn-push-unsub').classList.remove('hidden');
      document.getElementById('push-status').textContent = '✅ 已订阅';
    } else { document.getElementById('push-status').textContent = '❌ 订阅失败'; btn.disabled = false; btn.textContent = '开启'; }
  } catch (e) { document.getElementById('push-status').textContent = '❌ ' + e.message; btn.disabled = false; btn.textContent = '开启'; }
}
async function doPushUnsubscribe() {
  const r = await navigator.serviceWorker.ready;
  const s = await r.pushManager.getSubscription();
  if (s) { await fetch(BASE + '/subscribe?token=' + encodeURIComponent(TOKEN), {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:s.endpoint})}); await s.unsubscribe(); }
  document.getElementById('btn-push-sub').classList.remove('hidden');
  document.getElementById('btn-push-sub').disabled = false;
  document.getElementById('btn-push-unsub').classList.add('hidden');
  document.getElementById('push-status').textContent = '已取消';
}

(function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(checkPushStatus);
  if (loadAuth()) {
    document.getElementById('token-input').value = TOKEN;
    document.getElementById('auto-check').checked = AUTO;
    // Show resume option on auth screen
    document.getElementById('resume-box').classList.remove('hidden');
  }
})();

async function resumeSession() {
  document.querySelector('#resume-box .btn').disabled = true;
  document.querySelector('#resume-box .btn').textContent = '连接中...';
  try {
    const s = await api('/sync?phase=2&session=' + SESSION);
    showWizard();
    notify('info', '恢复会话: ' + SESSION.slice(0,8) + '...');
    renderPhase(s);
    if (s.phase === 2 && s.status === 'running') setTimeout(() => runPhase(2), 500);
  } catch (e) {
    localStorage.removeItem('ncm_am_session');
    SESSION = '';
    document.getElementById('resume-box').classList.add('hidden');
    showAuthError('会话已过期: ' + e.message);
  }
}
</script>
</body>
</html>`;
}
