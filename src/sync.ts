import { getDailySongs, AuthError, refreshLoginRaw, checkLogin } from './ncm';
import {
  createDeveloperToken,
  searchSongCandidates,
  listPlaylists,
  validateLibraryAccess,
  createPlaylist,
  addSongsToPlaylist,
  deletePlaylist,
} from './apple-music';
import type {
  AmCandidate,
  Env,
  NcmSong,
  NcmSongDisplay,
  PhaseSummary,
  SongMatch,
  SyncIssue,
  SyncProgress,
  SyncResponse,
  SyncSession,
  SyncSource,
} from './types';

const PLAYLIST_PREFIX_DEFAULT = 'NCM Daily ';
const KEEP_DAYS_DEFAULT = 3;
const STOREFRONT_DEFAULT = 'jp';
const ACTIVE_SESSION_KEY = 'active_session';
const SESSION_TTL = 86400;
const BATCH_SIZE = 10;
const AUTO_MATCH_MIN_SCORE = 13;
const AUTO_MATCH_MIN_GAP = 3;

function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function now(): number {
  return Date.now();
}

function maskUserToken(token: string): string {
  if (token.length <= 10) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function getAccountLabel(env: Env): string {
  if (env.AM_ACCOUNT_LABEL?.trim()) {
    return env.AM_ACCOUNT_LABEL.trim();
  }
  if (env.AM_USER_TOKEN?.trim()) {
    return `Music User Token ${maskUserToken(env.AM_USER_TOKEN)}`;
  }
  return 'Apple Music user token not configured';
}

function getMusicUserToken(env: Env): string {
  if (env.AM_USER_TOKEN?.trim()) {
    return env.AM_USER_TOKEN.trim();
  }
  throw new Error('Apple Music user token is not configured');
}

function formatAppleMusicAuthError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('AM API') && message.includes(': 401')) {
    return new Error(
      'Apple Music library authorization failed (401). Check AM_USER_TOKEN and AM_DEVELOPER_TOKEN, and make sure they belong to the same Apple Music account/team.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function createIssue(input: Omit<SyncIssue, 'id' | 'createdAt'>): SyncIssue {
  return {
    id: newSessionId().slice(0, 12),
    createdAt: now(),
    ...input,
  };
}

function createSongMatch(song: NcmSongDisplay): SongMatch {
  return {
    ncmId: song.id,
    ncmName: song.name,
    ncmArtist: song.artist,
    ncmAlbum: song.album,
    ncmCover: song.cover,
    ncmUrl: song.ncmUrl,
    query: `${song.name} ${song.artist}`.trim(),
    status: 'pending',
    decisionSource: null,
    selectedCandidate: null,
    candidates: [],
    issues: [],
  };
}

function emptySession(id: string, auto: boolean, source: SyncSource, accountLabel: string): SyncSession {
  const timestamp = now();
  return {
    id,
    source,
    auto,
    createdAt: timestamp,
    updatedAt: timestamp,
    replacedBy: null,
    phase: 1,
    state: 'collecting',
    status: 'running',
    date: '',
    storefront: '',
    accountLabel,
    ncmSongs: [],
    ncmTotal: 0,
    songMatches: [],
    searchBatchIndex: 0,
    searchBatchSize: BATCH_SIZE,
    amLibraryValidated: false,
    playlistId: null,
    playlistName: '',
    addedCount: 0,
    deletedPlaylists: [],
    issues: [],
  };
}

function isTerminal(session: SyncSession): boolean {
  return session.status === 'done' || session.status === 'error' || session.status === 'cancelled';
}

function addSessionIssue(session: SyncSession, issue: SyncIssue): void {
  session.issues = session.issues.filter(
    (existing) =>
      !(
        existing.phase === issue.phase &&
        existing.code === issue.code &&
        existing.message === issue.message &&
        existing.ncmId === issue.ncmId
      ),
  );
  session.issues.push(issue);
}

function clearRetryableSongIssues(song: SongMatch): void {
  song.issues = song.issues.filter((issue) => !(issue.phase === 2 && issue.retryable));
}

function addSongIssue(song: SongMatch, issue: SyncIssue): void {
  song.issues = song.issues.filter(
    (existing) =>
      !(
        existing.phase === issue.phase &&
        existing.code === issue.code &&
        existing.message === issue.message &&
        existing.ncmId === issue.ncmId
      ),
  );
  song.issues.push(issue);
}

function initializeSongMatches(session: SyncSession): void {
  if (session.songMatches.length > 0) return;
  session.songMatches = session.ncmSongs.map(createSongMatch);
}

function findSongMatch(session: SyncSession, ncmId: number): SongMatch {
  const match = session.songMatches.find((item) => item.ncmId === ncmId);
  if (!match) {
    throw new Error(`Song ${ncmId} not found in this session`);
  }
  return match;
}

function shouldAutoSelect(candidates: AmCandidate[]): boolean {
  const best = candidates[0];
  const next = candidates[1];
  if (!best) return false;
  if (best.score < AUTO_MATCH_MIN_SCORE) return false;
  if (!next) return true;
  return best.score - next.score >= AUTO_MATCH_MIN_GAP;
}

function applyCandidates(
  song: SongMatch,
  candidates: AmCandidate[],
  decisionSource: SongMatch['decisionSource'],
  forceBestCandidate = false,
): void {
  clearRetryableSongIssues(song);
  song.candidates = candidates;
  song.selectedCandidate = candidates[0] || null;
  song.query = song.query.trim();
  if (candidates.length === 0) {
    song.status = 'needs_review';
    song.decisionSource = null;
    song.selectedCandidate = null;
    return;
  }

  if (decisionSource === 'automatic' && (shouldAutoSelect(candidates) || forceBestCandidate)) {
    song.status = 'matched';
    song.decisionSource = 'automatic';
    song.selectedCandidate = candidates[0];
    return;
  }

  song.status = 'needs_review';
  song.decisionSource = null;
}

function buildProgress(session: SyncSession): SyncProgress {
  const matches = session.songMatches;
  return {
    processed: matches.filter((song) => song.status !== 'pending').length,
    total: session.ncmTotal,
    matched: matches.filter((song) => song.status === 'matched').length,
    review: matches.filter((song) => song.status === 'needs_review').length,
    skipped: matches.filter((song) => song.status === 'skipped').length,
    errors: matches.filter((song) => song.status === 'error').length,
  };
}

function buildPhaseSummary(session: SyncSession): PhaseSummary[] {
  const progress = buildProgress(session);
  const failedPhase = session.status === 'error' ? session.phase : null;
  const titles = [
    '',
    '收集网易云日推',
    '搜索 Apple Music',
    '创建播放列表',
    '添加歌曲',
    '删除旧歌单',
  ];

  return [1, 2, 3, 4, 5].map((phase) => {
    let status: PhaseSummary['status'] = 'pending';
    if (failedPhase === phase) {
      status = 'error';
    } else if (
      phase < session.phase ||
      (phase === 2 && (session.state === 'review_required' || session.phase > 2)) ||
      (phase === 5 && session.status === 'done')
    ) {
      status = 'done';
    } else if (
      (phase === 1 && session.state === 'collecting') ||
      (phase === 2 && (session.state === 'searching' || session.state === 'review_required')) ||
      (phase === 3 && session.state === 'creating_playlist') ||
      (phase === 4 && session.state === 'adding_tracks') ||
      (phase === 5 && session.state === 'cleaning_old_playlists')
    ) {
      status = 'running';
    }

    let detail = '';
    switch (phase) {
      case 1:
        detail = session.ncmTotal ? `已收集 ${session.ncmTotal} 首歌曲` : '等待开始收集歌曲';
        break;
      case 2:
        detail = `${progress.matched} 首已确认，${progress.review} 首待处理，${progress.errors} 首出错`;
        break;
      case 3:
        detail = session.playlistName ? `歌单：${session.playlistName}` : '等待创建 Apple Music 歌单';
        break;
      case 4:
        detail = `已添加 ${session.addedCount} 首歌曲`;
        break;
      case 5:
        detail = session.deletedPlaylists.length
          ? `已清理 ${session.deletedPlaylists.length} 个旧歌单`
          : '等待清理旧歌单';
        break;
    }

    return {
      phase,
      title: titles[phase],
      status,
      detail,
    };
  });
}

function collectIssues(session: SyncSession): SyncIssue[] {
  return [...session.issues, ...session.songMatches.flatMap((song) => song.issues)].sort(
    (left, right) => left.createdAt - right.createdAt,
  );
}

async function getActiveSessionId(env: Env): Promise<string | null> {
  return env.KV.get(ACTIVE_SESSION_KEY);
}

async function setActiveSessionId(env: Env, id: string): Promise<void> {
  await env.KV.put(ACTIVE_SESSION_KEY, id, { expirationTtl: SESSION_TTL });
}

async function clearActiveSessionIfMatches(env: Env, id: string): Promise<void> {
  const current = await getActiveSessionId(env);
  if (current === id) {
    await env.KV.delete(ACTIVE_SESSION_KEY);
  }
}

export async function getSession(env: Env, id: string): Promise<SyncSession | null> {
  const raw = await env.KV.get(`session:${id}`, 'json');
  return raw as SyncSession | null;
}

export async function getActiveSession(env: Env): Promise<SyncSession | null> {
  const activeId = await getActiveSessionId(env);
  if (!activeId) return null;
  return getSession(env, activeId);
}

export async function saveSession(env: Env, session: SyncSession): Promise<void> {
  session.updatedAt = now();
  await env.KV.put(`session:${session.id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
}

async function failSession(
  env: Env,
  session: SyncSession,
  phase: number,
  code: string,
  message: string,
): Promise<SyncSession> {
  session.phase = phase;
  session.state = 'failed';
  session.status = 'error';
  addSessionIssue(
    session,
    createIssue({
      scope: 'session',
      severity: 'error',
      phase,
      code,
      message,
      retryable: false,
    }),
  );
  await saveSession(env, session);
  await clearActiveSessionIfMatches(env, session.id);
  return session;
}

async function replaceActiveSession(env: Env, replacementId: string): Promise<void> {
  const active = await getActiveSession(env);
  if (!active || isTerminal(active)) {
    if (active) {
      await clearActiveSessionIfMatches(env, active.id);
    }
    return;
  }

  active.status = 'cancelled';
  active.state = 'cancelled';
  active.replacedBy = replacementId;
  addSessionIssue(
    active,
    createIssue({
      scope: 'session',
      severity: 'warning',
      phase: active.phase,
      code: 'session_replaced',
      message: `Session replaced by ${replacementId}`,
      retryable: false,
    }),
  );
  await saveSession(env, active);
}

async function getValidCookie(env: Env): Promise<string> {
  const savedCookie = await env.KV.get('ncm_cookie');
  const cookieCandidates = [savedCookie, env.NCM_COOKIE].filter(Boolean) as string[];

  for (const candidate of cookieCandidates) {
    const status = await checkLogin(candidate);
    if (status.ok) {
      return candidate;
    }
  }

  for (const candidate of cookieCandidates) {
    const refreshed = await refreshLoginRaw(candidate);
    if (!refreshed) continue;
    const recheck = await checkLogin(refreshed);
    if (recheck.ok) {
      await env.KV.put('ncm_cookie', refreshed, { expirationTtl: 86400 * 60 });
      return refreshed;
    }
  }

  throw new Error('NCM cookie expired and refresh failed. Please re-login via /login');
}

async function getDeveloperToken(env: Env): Promise<string> {
  if (env.AM_DEVELOPER_TOKEN) return env.AM_DEVELOPER_TOKEN;
  if (!env.AM_TEAM_ID || !env.AM_KEY_ID || !env.AM_PRIVATE_KEY) {
    throw new Error('Apple Music developer token is not configured');
  }
  return createDeveloperToken(env.AM_TEAM_ID, env.AM_KEY_ID, env.AM_PRIVATE_KEY);
}

function ensureMutableSession(session: SyncSession, activeId: string | null): void {
  if (session.status === 'cancelled') {
    throw new Error(`Session was replaced by ${session.replacedBy || 'another session'}`);
  }
  if (session.status !== 'running') {
    throw new Error(`Session is not active (${session.status})`);
  }
  if (activeId !== session.id) {
    throw new Error('Session is no longer the active session');
  }
}

export async function startManualSession(env: Env, auto: boolean): Promise<SyncSession> {
  const id = newSessionId();
  await replaceActiveSession(env, id);

  const session = emptySession(id, auto, 'manual', getAccountLabel(env));
  await saveSession(env, session);
  await setActiveSessionId(env, id);
  return session;
}

export async function startCronSession(env: Env): Promise<SyncSession | null> {
  const active = await getActiveSession(env);
  if (active && !isTerminal(active)) {
    return null;
  }
  if (active) {
    await clearActiveSessionIfMatches(env, active.id);
  }

  const id = newSessionId();
  const session = emptySession(id, true, 'cron', getAccountLabel(env));
  await saveSession(env, session);
  await setActiveSessionId(env, id);
  return session;
}

export async function getSessionResponse(env: Env, id?: string): Promise<SyncResponse | null> {
  const session = id ? await getSession(env, id) : await getActiveSession(env);
  if (!session) return null;
  const activeId = await getActiveSessionId(env);
  return toSyncResponse(session, activeId === session.id);
}

export async function getMutableSession(env: Env, id: string): Promise<SyncSession> {
  const session = await getSession(env, id);
  if (!session) {
    throw new Error('Session not found or expired');
  }
  const activeId = await getActiveSessionId(env);
  ensureMutableSession(session, activeId);
  return session;
}

function toSyncResponse(session: SyncSession, active: boolean): SyncResponse {
  return {
    sessionId: session.id,
    currentPhase: session.phase,
    status: session.status,
    state: session.state,
    source: session.source,
    auto: session.auto,
    active,
    progress: buildProgress(session),
    phaseSummary: buildPhaseSummary(session),
    data: {
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      replacedBy: session.replacedBy,
      date: session.date,
      ncmSongs: session.ncmSongs,
      ncmTotal: session.ncmTotal,
      songMatches: session.songMatches,
      storefront: session.storefront,
      accountLabel: session.accountLabel,
      playlistId: session.playlistId,
      playlistName: session.playlistName,
      addedCount: session.addedCount,
      deletedPlaylists: session.deletedPlaylists,
    },
    issues: collectIssues(session),
  };
}

export async function phase1(env: Env, session: SyncSession): Promise<SyncSession> {
  const nowDate = new Date(Date.now() + 8 * 3600 * 1000);
  session.phase = 1;
  session.state = 'collecting';
  session.status = 'running';
  session.date = nowDate.toISOString().slice(0, 10);

  try {
    const cookie = await getValidCookie(env);

    let songs: NcmSong[];
    try {
      const response = await getDailySongs(cookie);
      songs = response.songs;
    } catch (error) {
      if (!(error instanceof AuthError)) {
        throw error;
      }

      const refreshedCookie = await refreshLoginRaw(cookie);
      if (!refreshedCookie) {
        throw new Error('NCM auth expired and refresh failed');
      }

      await env.KV.put('ncm_cookie', refreshedCookie, { expirationTtl: 86400 * 60 });
      const response = await getDailySongs(refreshedCookie);
      songs = response.songs;
    }

    session.ncmSongs = songs.map((song: NcmSong) => ({
      id: song.id,
      name: song.name,
      artist: song.artists.map((artist) => artist.name).join(' / '),
      album: song.album.name,
      cover: song.cover || '',
      ncmUrl: `https://music.163.com/song?id=${song.id}`,
    }));
    session.ncmTotal = session.ncmSongs.length;
    session.songMatches = [];
    session.searchBatchIndex = 0;
    session.phase = 2;
    session.state = 'searching';
    await saveSession(env, session);
    return session;
  } catch (error) {
    return failSession(env, session, 1, 'phase1_failed', (error as Error).message);
  }
}

function markRemainingAsSkipped(session: SyncSession): void {
  for (const song of session.songMatches) {
    if (song.status === 'matched' || song.status === 'skipped') continue;
    song.status = 'skipped';
    song.decisionSource = 'skipped';
    song.selectedCandidate = null;
  }
}

export async function phase2(env: Env, session: SyncSession): Promise<SyncSession> {
  session.phase = 2;
  session.state = 'searching';
  session.status = 'running';
  session.storefront = env.STOREFRONT || STOREFRONT_DEFAULT;
  session.accountLabel = getAccountLabel(env);

  try {
    const developerToken = await getDeveloperToken(env);
    const userToken = getMusicUserToken(env);
    initializeSongMatches(session);

    if (!session.amLibraryValidated) {
      try {
        await validateLibraryAccess(developerToken, userToken);
        session.amLibraryValidated = true;
      } catch (error) {
        return failSession(
          env,
          session,
          2,
          'am_library_auth_failed',
          formatAppleMusicAuthError(error).message,
        );
      }
    }

    if (session.ncmTotal === 0) {
      session.phase = 3;
      session.state = 'creating_playlist';
      await saveSession(env, session);
      return session;
    }

    const totalBatches = Math.ceil(session.songMatches.length / BATCH_SIZE);
    if (session.searchBatchIndex >= totalBatches) {
      const unresolved = session.songMatches.filter(
        (song) => song.status === 'needs_review' || song.status === 'error',
      );
      if (session.auto) {
        markRemainingAsSkipped(session);
        session.phase = 3;
        session.state = 'creating_playlist';
      } else if (unresolved.length === 0) {
        session.phase = 3;
        session.state = 'creating_playlist';
      } else {
        session.state = 'review_required';
      }
      await saveSession(env, session);
      return session;
    }

    const start = session.searchBatchIndex * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, session.songMatches.length);

    for (let index = start; index < end; index += 1) {
      const song = session.songMatches[index];
      try {
        const candidates = await searchSongCandidates(
          song.ncmName,
          song.ncmArtist,
          session.storefront,
          developerToken,
          song.query,
        );
        applyCandidates(song, candidates, 'automatic', session.auto);
      } catch (error) {
        const issue = createIssue({
          scope: 'song',
          severity: 'error',
          phase: 2,
          code: 'search_failed',
          message: (error as Error).message,
          retryable: true,
          ncmId: song.ncmId,
        });
        song.status = 'error';
        song.candidates = [];
        song.selectedCandidate = null;
        addSongIssue(song, issue);
      }
    }

    session.searchBatchIndex += 1;

    if (session.searchBatchIndex >= totalBatches) {
      const unresolved = session.songMatches.filter(
        (song) => song.status === 'needs_review' || song.status === 'error',
      );
      if (session.auto) {
        markRemainingAsSkipped(session);
        session.phase = 3;
        session.state = 'creating_playlist';
      } else if (unresolved.length === 0) {
        session.phase = 3;
        session.state = 'creating_playlist';
      } else {
        session.state = 'review_required';
      }
    }

    await saveSession(env, session);
    return session;
  } catch (error) {
    return failSession(env, session, 2, 'phase2_failed', (error as Error).message);
  }
}

export async function searchPhase2Candidates(
  env: Env,
  session: SyncSession,
  ncmId: number,
  query: string,
): Promise<SyncSession> {
  try {
    const developerToken = await getDeveloperToken(env);
    const song = findSongMatch(session, ncmId);
    song.query = query.trim() || `${song.ncmName} ${song.ncmArtist}`.trim();
    const candidates = await searchSongCandidates(
      song.ncmName,
      song.ncmArtist,
      session.storefront || env.STOREFRONT || STOREFRONT_DEFAULT,
      developerToken,
      song.query,
    );
    applyCandidates(song, candidates, null);
    session.phase = 2;
    session.state = 'review_required';
    await saveSession(env, session);
    return session;
  } catch (error) {
    const song = findSongMatch(session, ncmId);
    const issue = createIssue({
      scope: 'song',
      severity: 'error',
      phase: 2,
      code: 'manual_search_failed',
      message: (error as Error).message,
      retryable: true,
      ncmId,
    });
    song.status = 'error';
    addSongIssue(song, issue);
    await saveSession(env, session);
    return session;
  }
}

export async function selectPhase2Candidate(
  env: Env,
  session: SyncSession,
  ncmId: number,
  candidateId: string,
): Promise<SyncSession> {
  const song = findSongMatch(session, ncmId);
  const candidate = song.candidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error('Candidate not found for this song');
  }

  clearRetryableSongIssues(song);
  song.selectedCandidate = candidate;
  song.status = 'matched';
  song.decisionSource = 'manual';
  session.phase = 2;
  session.state = 'review_required';
  await saveSession(env, session);
  return session;
}

export async function skipPhase2Song(
  env: Env,
  session: SyncSession,
  ncmId: number,
): Promise<SyncSession> {
  const song = findSongMatch(session, ncmId);
  song.status = 'skipped';
  song.decisionSource = 'skipped';
  song.selectedCandidate = null;
  session.phase = 2;
  session.state = 'review_required';
  await saveSession(env, session);
  return session;
}

export async function continuePhase2(env: Env, session: SyncSession): Promise<SyncSession> {
  markRemainingAsSkipped(session);
  session.phase = 3;
  session.state = 'creating_playlist';
  session.status = 'running';
  await saveSession(env, session);
  return session;
}

export async function phase3(env: Env, session: SyncSession): Promise<SyncSession> {
  session.phase = 3;
  session.state = 'creating_playlist';
  session.status = 'running';
  session.playlistName = `${env.PLAYLIST_PREFIX || PLAYLIST_PREFIX_DEFAULT}${session.date}`;

  if (session.songMatches.some((song) => song.status === 'needs_review' || song.status === 'error')) {
    throw new Error('Review phase is incomplete');
  }

  try {
    const developerToken = await getDeveloperToken(env);
    const userToken = getMusicUserToken(env);
    const playlists = await listPlaylists(developerToken, userToken);
    const existing = playlists.find((playlist) => playlist.name === session.playlistName);

    session.playlistId = existing
      ? existing.id
      : await createPlaylist(session.playlistName, developerToken, userToken);
    session.phase = 4;
    session.state = 'adding_tracks';
    await saveSession(env, session);
    return session;
  } catch (error) {
    return failSession(env, session, 3, 'phase3_failed', formatAppleMusicAuthError(error).message);
  }
}

export async function phase4(env: Env, session: SyncSession): Promise<SyncSession> {
  session.phase = 4;
  session.state = 'adding_tracks';
  session.status = 'running';

  if (!session.playlistId) {
    return failSession(env, session, 4, 'playlist_missing', 'No playlist ID — run phase 3 first');
  }

  try {
    const developerToken = await getDeveloperToken(env);
    const userToken = getMusicUserToken(env);
    const foundIds = session.songMatches
      .filter((song) => song.status === 'matched' && song.selectedCandidate?.id)
      .map((song) => song.selectedCandidate!.id);

    session.addedCount = foundIds.length;
    if (foundIds.length > 0) {
      await addSongsToPlaylist(session.playlistId, foundIds, developerToken, userToken);
    }

    session.phase = 5;
    session.state = 'cleaning_old_playlists';
    await saveSession(env, session);
    return session;
  } catch (error) {
    return failSession(env, session, 4, 'phase4_failed', formatAppleMusicAuthError(error).message);
  }
}

export async function phase5(env: Env, session: SyncSession): Promise<SyncSession> {
  session.phase = 5;
  session.state = 'cleaning_old_playlists';
  session.status = 'running';
  session.deletedPlaylists = [];

  try {
    const developerToken = await getDeveloperToken(env);
    const userToken = getMusicUserToken(env);
    const playlists = await listPlaylists(developerToken, userToken);
    const keepDays = parseInt(env.KEEP_DAYS || String(KEEP_DAYS_DEFAULT), 10);
    const prefix = env.PLAYLIST_PREFIX || PLAYLIST_PREFIX_DEFAULT;

    const nowDate = new Date(Date.now() + 8 * 3600 * 1000);
    const cutoffDate = new Date(nowDate.getTime() - (keepDays - 1) * 86400000);
    const cutoff = cutoffDate.toISOString().slice(0, 10);

    for (const playlist of playlists) {
      if (!playlist.name.startsWith(prefix)) continue;
      const playlistDate = playlist.name.slice(prefix.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(playlistDate) || playlistDate >= cutoff) continue;
      await deletePlaylist(playlist.id, developerToken, userToken);
      session.deletedPlaylists.push(playlist.name);
    }

    session.status = 'done';
    session.state = 'completed';
    await saveSession(env, session);
    await clearActiveSessionIfMatches(env, session.id);
    return session;
  } catch (error) {
    return failSession(env, session, 5, 'phase5_failed', formatAppleMusicAuthError(error).message);
  }
}

export { toSyncResponse };
