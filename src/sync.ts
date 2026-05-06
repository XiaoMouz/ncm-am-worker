     1|import { getDailySongs, songArtist, AuthError, refreshLoginRaw, checkLogin } from './ncm';
     2|import {
     3|  createDeveloperToken,
     4|  searchSong,
     5|  listPlaylists,
     6|  createPlaylist,
     7|  addSongsToPlaylist,
     8|  deletePlaylist,
     9|} from './apple-music';
    10|import type { Env, SyncResult } from './types';
    11|
    12|const PLAYLIST_PREFIX_DEFAULT = 'NCM Daily ';
    13|const KEEP_DAYS_DEFAULT = 3;
    14|
    15|/**
    16| * Get valid NCM cookie — check login, refresh if needed, save to KV.
    17| */
    18|async function getValidCookie(env: Env): Promise<string> {
    19|  let cookie = env.NCM_COOKIE;
    20|
    21|  // 1. Check current cookie
    22|  const status = await checkLogin(cookie);
    23|  if (status.ok) return cookie;
    24|
    25|  // 2. Cookie expired — try refresh
    26|  console.log('[NCM] Cookie expired, attempting refresh...');
    27|  const newCookie = await refreshLoginRaw(cookie);
    28|  if (newCookie) {
    29|    const recheck = await checkLogin(newCookie);
    30|    if (recheck.ok) {
    31|      console.log('[NCM] Refresh successful');
    32|      // Save new cookie to KV for next run
    33|      await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
    34|      return newCookie;
    35|    }
    36|  }
    37|
    38|  // 3. Refresh failed — check if we have a saved cookie in KV
    39|  const saved = await env.KV.get('ncm_cookie');
    40|  if (saved) {
    41|    const savedStatus = await checkLogin(saved);
    42|    if (savedStatus.ok) {
    43|      console.log('[NCM] Using saved cookie from KV');
    44|      return saved;
    45|    }
    46|  }
    47|
    48|  // 4. All failed — throw
    49|  throw new Error(
    50|    'NCM cookie expired and refresh failed. ' +
    51|    'Please re-login via QR code and update the NCM_COOKIE secret.'
    52|  );
    53|}
    54|
    55|/**
    56| * Main sync: NCM daily songs → Apple Music playlist
    57| */
    58|export async function sync(env: Env): Promise<SyncResult> {
    59|  const prefix = env.PLAYLIST_PREFIX || PLAYLIST_PREFIX_DEFAULT;
    60|  const keepDays = parseInt(env.KEEP_DAYS || String(KEEP_DAYS_DEFAULT), 10);
    61|  const storefront = env.STOREFRONT || 'cn';
    62|
    63|  // Time in UTC+8
    64|  const now = new Date(Date.now() + 8 * 3600 * 1000);
    65|  const dateStr = now.toISOString().slice(0, 10);
    66|  const playlistName = `${prefix}${dateStr}`;
    67|
    68|  const result: SyncResult = {
    69|    date: dateStr,
    70|    total: 0,
    71|    found: 0,
    72|    notFound: [],
    73|    playlistId: null,
    74|    deletedPlaylists: [],
    75|    errors: [],
    76|  };
    77|
    78|  // 1. Get Apple Music developer token (use existing or generate)
    79|  let developerToken: string;
    80|  if (env.AM_DEVELOPER_TOKEN) {
    81|    developerToken = env.AM_DEVELOPER_TOKEN;
    82|  } else {
    83|    try {
    84|      developerToken = await createDeveloperToken(
    85|        env.AM_TEAM_ID,
    86|        env.AM_KEY_ID,
    87|        env.AM_PRIVATE_KEY,
    88|      );
    89|    } catch (e: any) {
    90|      result.errors.push(`Failed to create developer token: ${e.message}`);
    91|      return result;
    92|    }
    93|  }
    94|
    95|  // 2. Get valid NCM cookie (auto-refresh if expired)
    96|  let cookie: string;
    97|  try {
    98|    cookie = await getValidCookie(env);
    99|  } catch (e: any) {
   100|    result.errors.push(`NCM auth failed: ${e.message}`);
   101|    return result;
   102|  }
   103|
   104|  // 3. Fetch NCM daily songs
   105|  let songs: Awaited<ReturnType<typeof getDailySongs>>['songs'];
   106|  try {
   107|    const r = await getDailySongs(cookie);
   108|    songs = r.songs;
   109|  } catch (e: any) {
   110|    if (e instanceof AuthError) {
   111|      // One more attempt: force refresh and retry
   112|      console.log('[NCM] Auth error on fetch, retrying after refresh...');
   113|      const newCookie = await refreshLoginRaw(cookie);
   114|      if (newCookie) {
   115|        await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
   116|        const r = await getDailySongs(newCookie);
   117|        songs = r.songs;
   118|      } else {
   119|        result.errors.push(`NCM auth expired and refresh failed`);
   120|        return result;
   121|      }
   122|    } else {
   123|      result.errors.push(`NCM fetch failed: ${e.message}`);
   124|      return result;
   125|    }
   126|  }
   127|
   128|  result.total = songs.length;
   129|  if (songs.length === 0) {
   130|    result.errors.push('No daily songs from NCM');
   131|    return result;
   132|  }
   133|
   134|  // 4. Search each song on Apple Music
   135|  const foundIds: string[] = [];
   136|  for (const song of songs) {
   137|    const artist = songArtist(song);
   138|    try {
   139|      const match = await searchSong(song.name, artist, storefront, developerToken);
   140|      if (match) {
   141|        foundIds.push(match.id);
   142|        result.found++;
   143|      } else {
   144|        result.notFound.push(`${song.name} — ${artist}`);
   145|      }
   146|    } catch (e: any) {
   147|      result.notFound.push(`${song.name} — ${artist} (error: ${e.message})`);
   148|    }
   149|  }
   150|
   151|  // 5. Check if playlist already exists
   152|  let existingPlaylists: { id: string; name: string }[];
   153|  try {
   154|    existingPlaylists = await listPlaylists(developerToken, env.AM_USER_TOKEN);
   155|  } catch (e: any) {
   156|    result.errors.push(`List playlists failed: ${e.message}`);
   157|    return result;
   158|  }
   159|
   160|  const existing = existingPlaylists.find((p) => p.name === playlistName);
   161|
   162|  // 6. Create or update playlist
   163|  if (foundIds.length > 0) {
   164|    try {
   165|      if (existing) {
   166|        await addSongsToPlaylist(existing.id, foundIds, developerToken, env.AM_USER_TOKEN);
   167|        result.playlistId = existing.id;
   168|      } else {
   169|        const plId = await createPlaylist(playlistName, developerToken, env.AM_USER_TOKEN);
   170|        await addSongsToPlaylist(plId, foundIds, developerToken, env.AM_USER_TOKEN);
   171|        result.playlistId = plId;
   172|      }
   173|    } catch (e: any) {
   174|      result.errors.push(`Playlist operation failed: ${e.message}`);
   175|    }
   176|  }
   177|
   178|  // 7. Clean up old playlists
   179|  const cutoffDate = new Date(now.getTime() - (keepDays - 1) * 86400000);
   180|  const cutoffStr = cutoffDate.toISOString().slice(0, 10);
   181|
   182|  for (const pl of existingPlaylists) {
   183|    if (!pl.name.startsWith(prefix)) continue;
   184|    const plDate = pl.name.slice(prefix.length);
   185|    if (/^\d{4}-\d{2}-\d{2}$/.test(plDate) && plDate < cutoffStr) {
   186|      try {
   187|        await deletePlaylist(pl.id, developerToken, env.AM_USER_TOKEN);
   188|        result.deletedPlaylists.push(pl.name);
   189|      } catch (e: any) {
   190|        result.errors.push(`Delete ${pl.name} failed: ${e.message}`);
   191|      }
   192|    }
   193|  }
   194|
   195|  return result;
   196|}
   197|
   198|/**
   199| * Format sync result as human-readable text
   200| */
   201|export function formatResult(r: SyncResult): string {
   202|  const lines = [
   203|    `🎵 网易云 → Apple Music 每日同步`,
   204|    `📅 ${r.date}`,
   205|    `✅ 已同步: ${r.found}/${r.total} 首`,
   206|  ];
   207|
   208|  if (r.playlistId) {
   209|    lines.push(`📋 歌单 ID: ${r.playlistId}`);
   210|  }
   211|
   212|  if (r.notFound.length > 0) {
   213|    lines.push(`\n❌ 未找到 (${r.notFound.length} 首):`);
   214|    for (const s of r.notFound) lines.push(`   • ${s}`);
   215|  }
   216|
   217|  if (r.deletedPlaylists.length > 0) {
   218|    lines.push(`\n🗑️ 已清理: ${r.deletedPlaylists.join(', ')}`);
   219|  }
   220|
   221|  if (r.errors.length > 0) {
   222|    lines.push(`\n⚠️ 错误:`);
   223|    for (const e of r.errors) lines.push(`   • ${e}`);
   224|  }
   225|
   226|  return lines.join('\n');
   227|}
   228|