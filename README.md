# ncm-am-worker

Cloudflare Worker: 网易云音乐每日推荐 → Apple Music 自动同步

## 功能

- 每天北京时间 06:10 自动触发同步
- 获取网易云音乐每日推荐歌曲 → Apple Music 搜索匹配
- 创建 "NCM Daily YYYY-MM-DD" 歌单，自动清理 3 天前旧歌单
- **NCM cookie 自动刷新** — session 过期时自动续期
- **QR 扫码重新登录** — `/login` 生成二维码
- **浏览器推送通知** — 同步完成/失败自动推送

## Endpoints

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务信息 |
| GET | `/status` | NCM 登录状态 + 最近同步结果 |
| POST | `/sync` | 手动触发同步 |
| GET | `/login` | 获取 QR 扫码登录 URL |
| GET | `/login/check?key=xxx` | 轮询扫码状态 |
| GET | `/subscribe` | 订阅推送通知页面 |
| GET | `/vapid-key` | 获取 VAPID 公钥 |

## 推送通知

1. 访问 `https://your-worker.workers.dev/subscribe`
2. 点击「开启通知」→ 允许浏览器通知权限
3. 每天同步完成后自动推送：
   - ✅ 成功：`🎵 同步完成: 2026-05-07: 18/20 首`
   - ⚠️ 失败：`⚠️ 同步异常: 2026-05-07: 5/20, 2 错误`

## 部署

```bash
cd ncm-am-worker && npm install

# 创建 KV
wrangler kv namespace create NCM_AM
# 填入 wrangler.toml

# 设置 Secrets
wrangler secret put NCM_COOKIE
wrangler secret put AM_DEVELOPER_TOKEN
wrangler secret put AM_USER_TOKEN

# 部署
wrangler deploy
```

## 文件结构

```
src/
├── index.ts         # 入口 (HTTP + cron + 推送)
├── types.ts         # 类型定义
├── crypto.ts        # NCM weapi 加密
├── ncm.ts           # 网易云 API + 登录 + 刷新
├── apple-music.ts   # Apple Music API
├── web-push.ts      # Web Push 实现 (VAPID + 加密)
└── sync.ts          # 同步逻辑
public/
├── subscribe.html   # 订阅页面
└── sw.js            # Service Worker
```

## 环境变量 (可选)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PLAYLIST_PREFIX` | `NCM Daily ` | 歌单名前缀 |
| `KEEP_DAYS` | `3` | 保留最近几天 |
| `STOREFRONT` | `cn` | Apple Music 地区 |
