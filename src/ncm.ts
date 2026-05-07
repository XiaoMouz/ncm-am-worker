import { weapiEncrypt } from './crypto';
import type { NcmSong, Env } from './types';

const NCM_DOMAIN = 'https://music.163.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

/**
 * Call NCM weapi endpoint
 */
export async function ncmRequest(
  path: string,
  data: Record<string, unknown>,
  cookie: string,
): Promise<any> {
  const safeCookie = cookie || '';

  // Add csrf_token from cookie
  const csrfMatch = safeCookie.match(/__csrf=([^;]+)/);
  data.csrf_token = csrfMatch ? csrfMatch[1] : '';

  const encrypted = await weapiEncrypt(data);

  // weapi URL: /weapi/... (strip /api prefix)
  const weapiPath = '/weapi/' + path.substring(5);
  const url = NCM_DOMAIN + weapiPath;

  const body = new URLSearchParams({
    params: encrypted.params,
    encSecKey: encrypted.encSecKey,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: NCM_DOMAIN,
      Cookie: safeCookie,
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`NCM API ${path} failed: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

/**
 * Check login status — returns { ok, uid, nickname } or throws
 */
export async function checkLogin(
  cookie: string,
): Promise<{ ok: boolean; uid?: string; nickname?: string }> {
  const resp = await ncmRequest('/api/w/nuser/account/get', {}, cookie);
  if (resp.code === 200 && resp.account?.id) {
    return {
      ok: true,
      uid: String(resp.account.id),
      nickname: resp.profile?.nickname,
    };
  }
  return { ok: false };
}

/**
 * Refresh login session using existing cookie.
 * Returns new cookie string if successful, null otherwise.
 *
 * NCM uses `/api/login/token/refresh` (eapi) — but we can also try
 * the weapi variant which only needs the existing MUSIC_U cookie.
 */
export async function refreshLogin(
  cookie: string,
): Promise<string | null> {
  try {
    // Try weapi refresh first (same endpoint, weapi encryption)
    const resp = await ncmRequest('/api/login/token/refresh', {}, cookie);

    // code 200 = success, response includes new cookies in Set-Cookie headers
    if (resp.code === 200) {
      // The refresh endpoint returns updated cookie info in the body
      // But the actual new cookies come from Set-Cookie response headers
      // Since we used weapi (which strips cookie handling), we need to
      // extract cookies from the raw response instead.
      // For now, return the original cookie — the refresh itself keeps the session alive.
      return cookie;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Refresh login with full cookie extraction from response headers.
 * This uses a raw fetch to capture Set-Cookie headers.
 */
export async function refreshLoginRaw(
  cookie: string,
): Promise<string | null> {
  try {
    const csrfMatch = cookie.match(/__csrf=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    const encrypted = await weapiEncrypt({ csrf_token: csrf });

    const body = new URLSearchParams({
      params: encrypted.params,
      encSecKey: encrypted.encSecKey,
    });

    const resp = await fetch(`${NCM_DOMAIN}/weapi/login/token/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Referer: NCM_DOMAIN,
        Cookie: cookie,
      },
      body: body.toString(),
      redirect: 'manual',
    });

    // Extract Set-Cookie headers and merge into existing cookie
    const setCookies: string[] = [];
    resp.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        setCookies.push(value.split(';')[0]); // only name=value part
      }
    });

    if (setCookies.length === 0) return null;

    // Merge: start with existing cookie, overwrite with new values
    const cookieMap = new Map<string, string>();
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) cookieMap.set(k.trim(), v.join('='));
    }
    for (const part of setCookies) {
      const [k, ...v] = part.trim().split('=');
      if (k) cookieMap.set(k.trim(), v.join('='));
    }

    const merged = Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    return merged;
  } catch {
    return null;
  }
}

/**
 * Fetch daily recommended songs.
 * Returns { songs, newCookie? } — if newCookie is set, caller should save it.
 */
export async function getDailySongs(
  cookie: string,
): Promise<{ songs: NcmSong[]; newCookie?: string }> {
  const resp = await ncmRequest(
    '/api/v3/discovery/recommend/songs',
    {},
    cookie,
  );

  // Auth error: code 301 or -1 typically means cookie expired
  if (resp.code === 301 || resp.code === -1) {
    throw new AuthError(`NCM auth expired: code=${resp.code}`);
  }

  if (resp.code !== 200) {
    throw new Error(`NCM recommend_songs error: code=${resp.code} msg=${resp.message || ''}`);
  }

  const dailySongs = resp.data?.dailySongs || [];
  const songs: NcmSong[] = dailySongs.map((song: any) => ({
    id: song.id,
    name: song.name,
    artists: (song.ar || song.artists || []).map((a: any) => ({
      id: a.id,
      name: a.name,
    })),
    album: {
      id: song.al?.id || song.album?.id || 0,
      name: song.al?.name || song.album?.name || '',
    },
    cover: song.al?.picUrl || song.album?.picUrl || '',
  }));
  return { songs };
}

/**
 * Get artist string from NcmSong
 */
export function songArtist(song: NcmSong): string {
  return song.artists.map((a) => a.name).join(' / ');
}

/** Custom error for auth failures — triggers refresh flow */
export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthError';
  }
}

// ── QR Login Flow ─────────────────────────────────────────

/**
 * Step 1: Generate a QR login key
 * Returns the unikey used to build the QR URL
 */
export async function qrLoginCreateKey(): Promise<string> {
  const resp = await ncmRequest('/api/login/qrcode/unikey', { type: 3 }, '');
  if (resp.code !== 200 || !resp.unikey) {
    throw new Error(`Failed to create QR key: ${JSON.stringify(resp)}`);
  }
  return resp.unikey;
}

/**
 * Build the QR login URL from a key
 */
export function qrLoginUrl(key: string): string {
  return `https://music.163.com/login?codekey=${key}`;
}

/**
 * Step 2: Poll QR login status
 * Returns { code, cookie?, message }
 *   800 = expired, 801 = waiting scan, 802 = waiting confirm, 803 = success
 */
export async function qrLoginCheck(
  key: string,
): Promise<{ code: number; cookie?: string; message?: string }> {
  const resp = await ncmRequest(
    '/api/login/qrcode/client/login',
    { key, type: 3 },
    '',
  );

  const code = resp.code || 0;
  const result: { code: number; cookie?: string; message?: string } = {
    code,
    message: resp.message || resp.msg,
  };

  // code 803 = success, extract cookies
  if (code === 803 && resp.cookie) {
    result.cookie = resp.cookie;
  }

  return result;
}
