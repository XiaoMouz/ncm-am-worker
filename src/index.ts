     1|import type { Env } from './types';
     2|import { sync, formatResult } from './sync';
     3|import {
     4|  checkLogin,
     5|  refreshLoginRaw,
     6|  qrLoginCreateKey,
     7|  qrLoginUrl,
     8|  qrLoginCheck,
     9|} from './ncm';
    10|
    11|const corsHeaders = {
    12|  'Access-Control-Allow-Origin': '*',
    13|  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    14|  'Access-Control-Allow-Headers': 'Content-Type',
    15|};
    16|
    17|function json(data: unknown, status = 200) {
    18|  return Response.json(data, { status, headers: corsHeaders });
    19|}
    20|
    21|export default {
    22|  // ── Cron trigger ──
    23|  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    24|    console.log(`[${new Date().toISOString()}] NCM→AM sync triggered by cron`);
    25|    const result = await sync(env);
    26|    const text = formatResult(result);
    27|    console.log(text);
    28|
    29|    // Save result to KV
    30|    await env.KV.put('last_sync', JSON.stringify(result), {
    31|      expirationTtl: 86400 * 4,
    32|    });
    33|    await env.KV.put('last_sync_text', text, {
    34|      expirationTtl: 86400 * 4,
    35|    });
    36|  },
    37|
    38|  // ── HTTP handler ──
    39|  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    40|    const url = new URL(request.url);
    41|    const path = url.pathname;
    42|
    43|    // CORS preflight
    44|    if (request.method === 'OPTIONS') {
    45|      return new Response(null, { headers: corsHeaders });
    46|    }
    47|
    48|    // ── GET / ──
    49|    if (path === '/' && request.method === 'GET') {
    50|      return json({
    51|        service: 'ncm-am-worker',
    52|        endpoints: {
    53|          'GET  /status':      'NCM 登录状态 + 最近同步结果',
    54|          'POST /sync':        '手动触发同步',
    55|          'GET  /login':       '获取 QR 登录 URL',
    56|          'GET  /login/check': '轮询 QR 扫码状态 (query: key=xxx)',
    57|        },
    58|      });
    59|    }
    60|
    61|    // ── GET /status ──
    62|    if (path === '/status' && request.method === 'GET') {
    63|      // Check NCM login
    64|      let cookie = env.NCM_COOKIE;
    65|      let savedCookie = await env.KV.get('ncm_cookie');
    66|      if (savedCookie) cookie = savedCookie;
    67|
    68|      let ncmStatus: { ok: boolean; uid?: string; nickname?: string; error?: string };
    69|      try {
    70|        ncmStatus = await checkLogin(cookie);
    71|      } catch (e: any) {
    72|        ncmStatus = { ok: false, error: e.message };
    73|      }
    74|
    75|      // Try refresh if not ok
    76|      let refreshed = false;
    77|      if (!ncmStatus.ok) {
    78|        const newCookie = await refreshLoginRaw(cookie);
    79|        if (newCookie) {
    80|          const recheck = await checkLogin(newCookie);
    81|          if (recheck.ok) {
    82|            await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
    83|            ncmStatus = recheck;
    84|            refreshed = true;
    85|          }
    86|        }
    87|      }
    88|
    89|      const lastSync = await env.KV.get('last_sync_text');
    90|
    91|      return json({
    92|        ncm: {
    93|          ...ncmStatus,
    94|          refreshed,
    95|          message: ncmStatus.ok
    96|            ? `✅ 登录正常 (${ncmStatus.nickname || ncmStatus.uid})`
    97|            : `❌ 登录已过期，请访问 /login 重新扫码`,
    98|        },
    99|        lastSync: lastSync || null,
   100|      });
   101|    }
   102|
   103|    // ── GET /login ──
   104|    // Start QR login flow: generate key, return QR URL
   105|    if (path === '/login' && request.method === 'GET') {
   106|      try {
   107|        const key = await qrLoginCreateKey();
   108|        const url = qrLoginUrl(key);
   109|
   110|        // Save key to KV for polling
   111|        await env.KV.put(`qr_key:${key}`, 'pending', { expirationTtl: 300 });
   112|
   113|        return json({
   114|          ok: true,
   115|          key,
   116|          qrUrl: url,
   117|          instructions: [
   118|            '1. 用网易云音乐 App 扫描 qrUrl 中的二维码',
   119|            '2. 在 App 中确认登录',
   120|            `3. 访问 GET /login/check?key=${key} 查看状态`,
   121|            '4. 状态变为 803 表示成功，cookie 自动保存',
   122|          ],
   123|        });
   124|      } catch (e: any) {
   125|        return json({ ok: false, error: e.message }, 500);
   126|      }
   127|    }
   128|
   129|    // ── GET /login/check?key=xxx ──
   130|    // Poll QR login status
   131|    if (path === '/login/check' && request.method === 'GET') {
   132|      const key = url.searchParams.get('key');
   133|      if (!key) {
   134|        return json({ error: 'Missing ?key= parameter' }, 400);
   135|      }
   136|
   137|      try {
   138|        const result = await qrLoginCheck(key);
   139|
   140|        // 803 = success
   141|        if (result.code === 803 && result.cookie) {
   142|          // Save new cookie
   143|          await env.KV.put('ncm_cookie', result.cookie, { expirationTtl: 86400 * 60 });
   144|          // Clean up QR key
   145|          await env.KV.delete(`qr_key:${key}`);
   146|
   147|          // Verify the new cookie works
   148|          const status = await checkLogin(result.cookie);
   149|
   150|          return json({
   151|            code: 803,
   152|            status: 'success',
   153|            message: '✅ 登录成功，cookie 已保存',
   154|            user: status.ok ? { uid: status.uid, nickname: status.nickname } : null,
   155|          });
   156|        }
   157|
   158|        // Map status codes
   159|        const statusMap: Record<number, string> = {
   160|          800: '❌ 二维码已过期，请重新访问 /login',
   161|          801: '⏳ 等待扫码...',
   162|          802: '⏳ 已扫码，等待确认...',
   163|        };
   164|
   165|        return json({
   166|          code: result.code,
   167|          status: statusMap[result.code] || `未知状态: ${result.code}`,
   168|          message: result.message,
   169|        });
   170|      } catch (e: any) {
   171|        return json({ ok: false, error: e.message }, 500);
   172|      }
   173|    }
   174|
   175|    // ── POST /sync ──
   176|    if (path === '/sync' && request.method === 'POST') {
   177|      try {
   178|        const result = await sync(env);
   179|        const text = formatResult(result);
   180|        await env.KV.put('last_sync', JSON.stringify(result), { expirationTtl: 86400 * 4 });
   181|        await env.KV.put('last_sync_text', text, { expirationTtl: 86400 * 4 });
   182|        return json(result);
   183|      } catch (e: any) {
   184|        return json({ error: e.message }, 500);
   185|      }
   186|    }
   187|
   188|    return json({ error: 'Not found' }, 404);
   189|  },
   190|};
   191|