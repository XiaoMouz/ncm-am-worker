import type { Env, SyncSession } from './types';
import {
  startManualSession,
  startCronSession,
  getSessionResponse,
  getMutableSession,
  phase1,
  phase2,
  searchPhase2Candidates,
  selectPhase2Candidate,
  skipPhase2Song,
  continuePhase2,
  phase3,
  phase4,
  phase5,
} from './sync';
import { checkLogin, refreshLoginRaw, qrLoginCreateKey, qrLoginUrl, qrLoginCheck } from './ncm';
import { searchSongCandidates } from './apple-music';
import { generateVapidKeys, sendPushNotification } from './web-push';
import { SW_JS, subscribeHtml } from './static';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders });
}

function checkToken(url: URL, env: Env): boolean {
  return url.searchParams.get('token') === env.SYNC_TOKEN;
}

function getErrorStatus(message: string): number {
  if (message.includes('Missing ?')) {
    return 400;
  }
  if (
    message.includes('not found') ||
    message.includes('Candidate not found')
  ) {
    return 404;
  }
  if (
    message.includes('Unauthorized') ||
    message.includes('Review phase is incomplete') ||
    message.includes('no longer the active session') ||
    message.includes('replaced') ||
    message.includes('not active')
  ) {
    return 409;
  }
  return 500;
}

async function getVapidKeys(env: Env): Promise<{ publicKey: string; privateKey: string }> {
  const existing = await env.KV.get('vapid_keys', 'json');
  if (existing) return existing as { publicKey: string; privateKey: string };
  const keys = await generateVapidKeys();
  await env.KV.put('vapid_keys', JSON.stringify(keys));
  return keys;
}

async function notifySubscribers(
  env: Env,
  title: string,
  body: string,
  type: 'success' | 'error',
  sessionId?: string,
): Promise<void> {
  const vapidKeys = await getVapidKeys(env);
  const subsRaw = await env.KV.get('push_subscriptions', 'json');
  const subscriptions: { endpoint: string; keys: { p256dh: string; auth: string } }[] =
    (subsRaw as any[]) || [];

  const payload = JSON.stringify({
    title,
    body,
    type,
    tag: 'ncm-am-sync',
    url: sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/',
  });

  const expired: string[] = [];
  for (const sub of subscriptions) {
    const ok = await sendPushNotification(sub, payload, vapidKeys.publicKey, vapidKeys.privateKey);
    if (!ok) expired.push(sub.endpoint);
  }

  if (expired.length > 0) {
    const remaining = subscriptions.filter((sub) => !expired.includes(sub.endpoint));
    await env.KV.put('push_subscriptions', JSON.stringify(remaining));
  }
}

function summarizeSession(session: SyncSession): { found: number; total: number } {
  const found = session.songMatches.filter((song) => song.status === 'matched').length;
  return { found, total: session.ncmTotal };
}

async function notifyManualSyncOutcome(env: Env, session: SyncSession): Promise<void> {
  if (session.source !== 'manual') return;

  const summary = summarizeSession(session);
  if (session.status === 'done') {
    await notifySubscribers(
      env,
      '🎵 同步完成',
      `${session.date}: ${summary.found}/${summary.total} 首已同步到 Apple Music`,
      'success',
      session.id,
    );
    return;
  }

  if (session.status === 'error') {
    await notifySubscribers(
      env,
      '⚠️ 同步异常',
      session.issues.at(-1)?.message || 'Unknown sync error',
      'error',
      session.id,
    );
  }
}

async function runAutoSync(env: Env): Promise<void> {
  const session = await startCronSession(env);
  if (!session) {
    console.log(`[${new Date().toISOString()}] Cron skipped because an active session already exists`);
    return;
  }

  try {
    const s1 = await phase1(env, session);
    if (s1.status !== 'running') {
      await notifySubscribers(env, '⚠️ 自动同步失败', s1.issues.at(-1)?.message || 'Phase 1 failed', 'error', s1.id);
      return;
    }

    const s2 = await phase2(env, s1);
    if (s2.status !== 'running') {
      await notifySubscribers(env, '⚠️ 自动同步失败', s2.issues.at(-1)?.message || 'Phase 2 failed', 'error', s2.id);
      return;
    }

    const s3 = await phase3(env, s2);
    if (s3.status !== 'running') {
      await notifySubscribers(env, '⚠️ 自动同步失败', s3.issues.at(-1)?.message || 'Phase 3 failed', 'error', s3.id);
      return;
    }

    const s4 = await phase4(env, s3);
    if (s4.status !== 'running') {
      await notifySubscribers(env, '⚠️ 自动同步失败', s4.issues.at(-1)?.message || 'Phase 4 failed', 'error', s4.id);
      return;
    }

    const s5 = await phase5(env, s4);
    const summary = summarizeSession(s5);
    if (s5.status === 'done') {
      await notifySubscribers(
        env,
        '🎵 自动同步完成',
        `${s5.date}: ${summary.found}/${summary.total} 首已同步到 Apple Music`,
        'success',
        s5.id,
      );
    } else {
      await notifySubscribers(
        env,
        '⚠️ 自动同步异常',
        s5.issues.at(-1)?.message || 'Unknown sync error',
        'error',
        s5.id,
      );
    }
  } catch (error) {
    console.error('[AutoSync] Fatal error:', (error as Error).message);
    await notifySubscribers(env, '❌ 自动同步失败', (error as Error).message, 'error', session.id);
  }
}

async function getDeveloperToken(env: Env): Promise<string> {
  if (env.AM_DEVELOPER_TOKEN) return env.AM_DEVELOPER_TOKEN;
  if (!env.AM_TEAM_ID || !env.AM_KEY_ID || !env.AM_PRIVATE_KEY) {
    throw new Error('Apple Music developer token is not configured');
  }
  const { createDeveloperToken } = await import('./apple-music');
  return createDeveloperToken(env.AM_TEAM_ID, env.AM_KEY_ID, env.AM_PRIVATE_KEY);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runAutoSync(env);
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === '/sw.js') {
      return new Response(SW_JS, {
        headers: { 'Content-Type': 'application/javascript', ...corsHeaders },
      });
    }

    if (path === '/subscribe' && request.method === 'GET') {
      const vapidKeys = await getVapidKeys(env);
      return new Response(subscribeHtml(vapidKeys.publicKey), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    if (path === '/vapid-key' && request.method === 'GET') {
      const keys = await getVapidKeys(env);
      return json({ publicKey: keys.publicKey });
    }

    if (path === '/subscribe' && request.method === 'POST') {
      try {
        const sub = (await request.json()) as any;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return json({ error: 'Invalid subscription' }, 400);
        }
        const existing: any[] = ((await env.KV.get('push_subscriptions', 'json')) as any[]) || [];
        const filtered = existing.filter((item) => item.endpoint !== sub.endpoint);
        filtered.push({ endpoint: sub.endpoint, keys: sub.keys });
        await env.KV.put('push_subscriptions', JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      } catch (error) {
        return json({ error: (error as Error).message }, 500);
      }
    }

    if (path === '/subscribe' && request.method === 'DELETE') {
      try {
        const { endpoint } = (await request.json()) as any;
        const existing: any[] = ((await env.KV.get('push_subscriptions', 'json')) as any[]) || [];
        const filtered = existing.filter((item) => item.endpoint !== endpoint);
        await env.KV.put('push_subscriptions', JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      } catch (error) {
        return json({ error: (error as Error).message }, 500);
      }
    }

    if (path === '/status' && request.method === 'GET') {
      let cookie = env.NCM_COOKIE || '';
      const savedCookie = await env.KV.get('ncm_cookie');
      if (savedCookie) cookie = savedCookie;

      let ncm: { ok: boolean; uid?: string; nickname?: string; error?: string };
      if (!cookie) {
        ncm = { ok: false, error: 'NCM cookie is not configured' };
      } else {
        try {
          ncm = await checkLogin(cookie);
        } catch (error) {
          ncm = { ok: false, error: (error as Error).message };
        }
      }

      let refreshed = false;
      if (!ncm.ok) {
        const refreshedCookie = await refreshLoginRaw(cookie);
        if (refreshedCookie) {
          const recheck = await checkLogin(refreshedCookie);
          if (recheck.ok) {
            refreshed = true;
            ncm = recheck;
            await env.KV.put('ncm_cookie', refreshedCookie, { expirationTtl: 86400 * 60 });
          }
        }
      }

      return json({
        ncm: { ...ncm, refreshed },
        push: { subscribers: (((await env.KV.get('push_subscriptions', 'json')) as any[]) || []).length },
        activeSession: await getSessionResponse(env),
      });
    }

    if (path === '/login' && request.method === 'GET') {
      try {
        const key = await qrLoginCreateKey();
        await env.KV.put(`qr_key:${key}`, 'pending', { expirationTtl: 300 });
        return json({ ok: true, key, qrUrl: qrLoginUrl(key) });
      } catch (error) {
        return json({ error: (error as Error).message }, 500);
      }
    }

    if (path === '/login/check' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'Missing ?key=' }, 400);

      try {
        const result = await qrLoginCheck(key);
        if (result.code === 803 && result.cookie) {
          await env.KV.put('ncm_cookie', result.cookie, { expirationTtl: 86400 * 60 });
          await env.KV.delete(`qr_key:${key}`);
          return json({ code: 803, status: 'success', message: '✅ 登录成功' });
        }
        return json({ code: result.code, message: result.message });
      } catch (error) {
        return json({ error: (error as Error).message }, 500);
      }
    }

    if (path === '/session' && request.method === 'GET') {
      if (!checkToken(url, env)) {
        return json({ error: 'Unauthorized — provide ?token=xxx' }, 401);
      }
      const sessionId = url.searchParams.get('session') || undefined;
      const response = await getSessionResponse(env, sessionId);
      if (!response) {
        return json({ error: 'Session not found' }, 404);
      }
      return json(response);
    }

    if (path === '/search' && request.method === 'GET') {
      if (!checkToken(url, env)) {
        return json({ error: 'Unauthorized — provide ?token=xxx' }, 401);
      }
      const query = url.searchParams.get('q');
      const songName = url.searchParams.get('song') || query || '';
      const artist = url.searchParams.get('artist') || '';
      if (!query && !songName) {
        return json({ error: 'Missing ?q=' }, 400);
      }

      try {
        const developerToken = await getDeveloperToken(env);
        const storefront = env.STOREFRONT || 'jp';
        const candidates = await searchSongCandidates(songName, artist, storefront, developerToken, query || undefined);
        return json({ query, storefront, candidates });
      } catch (error) {
        return json({ error: (error as Error).message }, 500);
      }
    }

    if (path === '/sync') {
      if (!checkToken(url, env)) {
        return json({ error: 'Unauthorized — provide ?token=xxx' }, 401);
      }

      const phase = url.searchParams.get('phase');
      const sessionId = url.searchParams.get('session');
      const auto = url.searchParams.get('auto') === '1';

      try {
        if (!phase) {
          const session = await startManualSession(env, auto);
          const result = await phase1(env, session);
          await notifyManualSyncOutcome(env, result);
          return json(await getSessionResponse(env, result.id));
        }

        if (!sessionId) {
          return json({ error: 'Missing ?session=xxx' }, 400);
        }

        const session = await getMutableSession(env, sessionId);
        let updated: SyncSession;

        switch (phase) {
          case '2':
            updated = await phase2(env, session);
            break;
          case '2-search': {
            const ncmId = parseInt(url.searchParams.get('ncmId') || '0', 10);
            const query = url.searchParams.get('query') || '';
            if (!ncmId || !query.trim()) {
              return json({ error: 'Missing ?ncmId= or ?query=' }, 400);
            }
            updated = await searchPhase2Candidates(env, session, ncmId, query);
            break;
          }
          case '2-select': {
            const ncmId = parseInt(url.searchParams.get('ncmId') || '0', 10);
            const candidateId = url.searchParams.get('candidateId') || '';
            if (!ncmId || !candidateId) {
              return json({ error: 'Missing ?ncmId= or ?candidateId=' }, 400);
            }
            updated = await selectPhase2Candidate(env, session, ncmId, candidateId);
            break;
          }
          case '2-skip-song': {
            const ncmId = parseInt(url.searchParams.get('ncmId') || '0', 10);
            if (!ncmId) {
              return json({ error: 'Missing ?ncmId=' }, 400);
            }
            updated = await skipPhase2Song(env, session, ncmId);
            break;
          }
          case '2-continue':
            updated = await continuePhase2(env, session);
            break;
          case '3':
            updated = await phase3(env, session);
            break;
          case '4':
            updated = await phase4(env, session);
            break;
          case '5':
            updated = await phase5(env, session);
            break;
          default:
            return json({ error: `Unknown phase: ${phase}` }, 400);
        }

        await notifyManualSyncOutcome(env, updated);

        return json(await getSessionResponse(env, updated.id));
      } catch (error) {
        const message = (error as Error).message;
        return json({ error: message }, getErrorStatus(message));
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
