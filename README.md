# ncm-am-worker

Cloudflare Worker: 网易云音乐每日推荐 → Apple Music 多阶段同步

## 功能

- 网页驱动的 phase 1~5 同步流程：收集日推 → 搜索 Apple Music → 创建歌单 → 添加歌曲 → 清理旧歌单
- 前端已迁移到 **React + Tailwind + shadcn/ui 风格组件 + lucide-react 图标**
- phase 2 为每首未确认歌曲返回候选列表，支持重新搜索、手动点选、显式跳过
- 单 active session 模型：新网页会话会替换旧会话；cron 遇到进行中的会话会跳过
- 支持通过 `session` 恢复流程，读取状态不会重复执行 phase
- 创建 "NCM Daily YYYY-MM-DD" 歌单，自动清理旧歌单
- **NCM cookie 自动刷新** — session 过期时自动续期
- **QR 扫码重新登录** — `/login` 生成二维码
- **浏览器推送通知** — 同步完成/失败自动推送，并回跳到对应会话

## Endpoints

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | Web UI，同步和通知入口 |
| GET | `/status` | NCM 登录状态 + 当前 active session |
| GET | `/session?token=xxx[&session=yyy]` | 只读查询 session 状态 |
| GET | `/sync?token=xxx&auto=1` | 新建 session 并执行 phase 1 |
| GET | `/sync?token=xxx&session=yyy&phase=2` | 执行 phase 2 下一批搜索 |
| GET | `/sync?token=xxx&session=yyy&phase=2-search&ncmId=1&query=...` | 为单曲刷新候选列表 |
| GET | `/sync?token=xxx&session=yyy&phase=2-select&ncmId=1&candidateId=...` | 确认候选歌曲 |
| GET | `/sync?token=xxx&session=yyy&phase=2-skip-song&ncmId=1` | 显式跳过一首歌 |
| GET | `/sync?token=xxx&session=yyy&phase=2-continue` | 结束人工复核并进入 phase 3 |
| GET | `/sync?token=xxx&session=yyy&phase=3|4|5` | 执行后续阶段 |
| GET | `/login` | 获取 QR 扫码登录 URL |
| GET | `/login/check?key=xxx` | 轮询扫码状态 |
| GET | `/subscribe` | 订阅推送通知页面 |
| GET | `/vapid-key` | 获取 VAPID 公钥 |
| GET | `/search?token=xxx&q=...` | 返回 Apple Music 搜索候选（调试 / API 使用） |

## 推送通知

1. 访问 `https://your-worker.workers.dev/`
2. 点击「开启通知」→ 允许浏览器通知权限
3. 同步完成后自动推送，点击通知会回到对应会话：
   - ✅ 成功：`🎵 同步完成: 2026-05-07: 18/20 首`
   - ⚠️ 失败：`⚠️ 同步异常: 2026-05-07: 5/20, 2 错误`

## 部署

```bash
cd ncm-am-worker && npm install

# 构建 Worker 类型和前端资源
npm run build

# 创建 KV
wrangler kv namespace create NCM_AM
# 填入 wrangler.toml

# 设置 Secrets
wrangler secret put NCM_COOKIE
wrangler secret put AM_DEVELOPER_TOKEN
wrangler secret put AM_USER_TOKEN

# 部署
npm run deploy
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
web/
├── index.html       # Vite 入口
└── src/             # React UI (shadcn/ui 风格组件 + lucide-react)
```

## 环境变量 (可选)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PLAYLIST_PREFIX` | `NCM Daily ` | 歌单名前缀 |
| `KEEP_DAYS` | `3` | 保留最近几天 |
| `STOREFRONT` | `jp` | Apple Music 地区 |
| `AM_ACCOUNT_LABEL` | `Music User Token ******` | 前端展示的 Apple Music 账户标识 |
