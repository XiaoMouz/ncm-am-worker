import type { Env } from './types';
import { sync, formatResult } from './sync';
import {
  checkLogin,
  refreshLoginRaw,
  qrLoginCreateKey,
  qrLoginUrl,
  qrLoginCheck,
} from './ncm';
import { generateVapidKeys, sendPushNotification } from './web-push';
import { SW_JS, subscribeHtml } from './static';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

/**
 * Get or create VAPID keys, stored in KV
 */
async function getVapidKeys(env: Env): Promise<{ publicKey: string; privateKey: string }> {
  const existing = await env.KV.get('vapid_keys', 'json');
  if (existing) return existing as { publicKey: string; privateKey: string };

  const keys = await generateVapidKeys();
  await env.KV.put('vapid_keys', JSON.stringify(keys));
  return keys;
}

/**
 * Send push to all subscribers
 */
async function notifySubscribers(
  env: Env,
  title: string,
  body: string,
  type: 'success' | 'error',
) {
  const vapidKeys = await getVapidKeys(env);
  const subsRaw = await env.KV.get('push_subscriptions', 'json');
  const subs: { endpoint: string; keys: { p256dh: string; auth: string } }[] =
    (subsRaw as any[]) || [];

  const payload = JSON.stringify({
    title,
    body,
    type,
    tag: 'ncm-am-sync',
    url: '/status',
  });

  const expired: string[] = [];
  for (const sub of subs) {
    const ok = await sendPushNotification(sub, payload, vapidKeys.publicKey, vapidKeys.privateKey);
    if (!ok) expired.push(sub.endpoint);
  }

  // Remove expired subscriptions
  if (expired.length > 0) {
    const remaining = subs.filter((s) => !expired.includes(s.endpoint));
    await env.KV.put('push_subscriptions', JSON.stringify(remaining));
  }
}

export default {
  // ── Cron trigger ──
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[${new Date().toISOString()}] NCM→AM sync triggered by cron`);
    const result = await sync(env);
    const text = formatResult(result);
    console.log(text);

    await env.KV.put('last_sync', JSON.stringify(result), { expirationTtl: 86400 * 4 });
    await env.KV.put('last_sync_text', text, { expirationTtl: 86400 * 4 });

    // Push notification
    if (result.errors.length === 0 && result.found > 0) {
      await notifySubscribers(
        env,
        '🎵 同步完成',
        `${result.date}: ${result.found}/${result.total} 首已同步`,
        'success',
      );
    } else {
      await notifySubscribers(
        env,
        '⚠️ 同步异常',
        `${result.date}: ${result.found}/${result.total} 首, ${result.errors.length} 个错误`,
        'error',
      );
    }
  },

  // ── HTTP handler ──
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── GET / ──
    if (path === '/' && request.method === 'GET') {
      return json({
        service: 'ncm-am-worker',
        endpoints: {
          'GET  /':            '本页',
          'GET  /status':      'NCM 登录状态 + 最近同步结果',
          'POST /sync':        '手动触发同步',
          'GET  /login':       '获取 QR 登录 URL',
          'GET  /login/check': '轮询 QR 扫码状态',
          'GET  /subscribe':   '订阅推送通知页面',
          'POST /subscribe':   '保存推送订阅',
          'GET  /vapid-key':   '获取 VAPID 公钥',
        },
      });
    }

    // ── GET /subscribe ── (serve HTML page)
    if (path === '/subscribe' && request.method === 'GET') {
      const vapidKeys = await getVapidKeys(env);
      return new Response(subscribeHtml(vapidKeys.publicKey), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // ── GET /sw.js ── (service worker)
    if (path === '/sw.js') {
      return new Response(SW_JS, {
        headers: { 'Content-Type': 'application/javascript', ...corsHeaders },
      });
    }

    // ── GET /vapid-key ──
    if (path === '/vapid-key' && request.method === 'GET') {
      const keys = await getVapidKeys(env);
      return json({ publicKey: keys.publicKey });
    }

    // ── POST /subscribe ── (save push subscription)
    if (path === '/subscribe' && request.method === 'POST') {
      try {
        const sub = await request.json() as any;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return json({ error: 'Invalid subscription' }, 400);
        }

        // Get existing subscriptions
        const existing: any[] = ((await env.KV.get('push_subscriptions', 'json')) as any[]) || [];

        // Deduplicate by endpoint
        const filtered = existing.filter((s) => s.endpoint !== sub.endpoint);
        filtered.push({ endpoint: sub.endpoint, keys: sub.keys });

        await env.KV.put('push_subscriptions', JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ── DELETE /subscribe ── (unsubscribe)
    if (path === '/subscribe' && request.method === 'DELETE') {
      try {
        const { endpoint } = await request.json() as any;
        const existing: any[] = ((await env.KV.get('push_subscriptions', 'json')) as any[]) || [];
        const filtered = existing.filter((s) => s.endpoint !== endpoint);
        await env.KV.put('push_subscriptions', JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /status ──
    if (path === '/status' && request.method === 'GET') {
      let cookie = env.NCM_COOKIE;
      let savedCookie = await env.KV.get('ncm_cookie');
      if (savedCookie) cookie = savedCookie;

      let ncmStatus: { ok: boolean; uid?: string; nickname?: string; error?: string };
      try {
        ncmStatus = await checkLogin(cookie);
      } catch (e: any) {
        ncmStatus = { ok: false, error: e.message };
      }

      let refreshed = false;
      if (!ncmStatus.ok) {
        const newCookie = await refreshLoginRaw(cookie);
        if (newCookie) {
          const recheck = await checkLogin(newCookie);
          if (recheck.ok) {
            await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
            ncmStatus = recheck;
            refreshed = true;
          }
        }
      }

      const lastSync = await env.KV.get('last_sync_text');
      const subs: any[] = ((await env.KV.get('push_subscriptions', 'json')) as any[]) || [];

      return json({
        ncm: {
          ...ncmStatus,
          refreshed,
          message: ncmStatus.ok
            ? `✅ 登录正常 (${ncmStatus.nickname || ncmStatus.uid})`
            : `❌ 登录已过期，请访问 /login 重新扫码`,
        },
        push: { subscribers: subs.length },
        lastSync: lastSync || null,
      });
    }

    // ── GET /login ──
    if (path === '/login' && request.method === 'GET') {
      try {
        const key = await qrLoginCreateKey();
        const qrUrl = qrLoginUrl(key);
        await env.KV.put(`qr_key:${key}`, 'pending', { expirationTtl: 300 });

        return json({
          ok: true,
          key,
          qrUrl,
          instructions: [
            '1. 用网易云音乐 App 扫描 qrUrl 中的二维码',
            '2. 在 App 中确认登录',
            `3. 访问 GET /login/check?key=${key} 查看状态`,
            '4. 状态变为 803 表示成功，cookie 自动保存',
          ],
        });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /login/check?key=xxx ──
    if (path === '/login/check' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'Missing ?key= parameter' }, 400);

      try {
        const result = await qrLoginCheck(key);

        if (result.code === 803 && result.cookie) {
          await env.KV.put('ncm_cookie', result.cookie, { expirationTtl: 86400 * 60 });
          await env.KV.delete(`qr_key:${key}`);

          const status = await checkLogin(result.cookie);
          return json({
            code: 803,
            status: 'success',
            message: '✅ 登录成功，cookie 已保存',
            user: status.ok ? { uid: status.uid, nickname: status.nickname } : null,
          });
        }

        const statusMap: Record<number, string> = {
          800: '❌ 二维码已过期，请重新访问 /login',
          801: '⏳ 等待扫码...',
          802: '⏳ 已扫码，等待确认...',
        };

        return json({
          code: result.code,
          status: statusMap[result.code] || `未知状态: ${result.code}`,
          message: result.message,
        });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── POST /sync ──
    if (path === '/sync') {
      try {
        const result = await sync(env);
        const text = formatResult(result);
        await env.KV.put('last_sync', JSON.stringify(result), { expirationTtl: 86400 * 4 });
        await env.KV.put('last_sync_text', text, { expirationTtl: 86400 * 4 });

        // Push notification
        if (result.errors.length === 0 && result.found > 0) {
          await notifySubscribers(env, '🎵 同步完成', `${result.date}: ${result.found}/${result.total} 首`, 'success');
        } else {
          await notifySubscribers(env, '⚠️ 同步异常', `${result.date}: ${result.found}/${result.total}, ${result.errors.length} 错误`, 'error');
        }

        return json(result);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
