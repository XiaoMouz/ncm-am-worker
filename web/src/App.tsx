import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bell,
  BellOff,
  Check,
  CircleAlert,
  CloudAlert,
  ExternalLink,
  ListMusic,
  Loader2,
  Music4,
  RefreshCw,
  Search,
  ShieldCheck,
  SkipForward,
  Sparkles,
} from 'lucide-react';
import type { NcmSongDisplay, SongMatch, SyncResponse } from './app-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';

type LogEntry = { id: string; tone: 'info' | 'success' | 'error'; message: string };

const STORAGE_TOKEN = 'ncm_am_token';
const STORAGE_SESSION = 'ncm_am_session';
const STORAGE_AUTO = 'ncm_am_auto';

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function formatStatus(payload: SyncResponse): string {
  if (payload.status === 'done') return '已完成';
  if (payload.status === 'error') return '失败';
  if (payload.status === 'cancelled') return '已取消';
  switch (payload.state) {
    case 'collecting':
      return '收集网易云日推中';
    case 'searching':
      return '搜索 Apple Music 中';
    case 'review_required':
      return '等待人工确认';
    case 'creating_playlist':
      return '创建歌单中';
    case 'adding_tracks':
      return '添加歌曲中';
    case 'cleaning_old_playlists':
      return '清理旧歌单中';
    default:
      return payload.state;
  }
}

function badgeVariant(status: SyncResponse['status'] | SongMatch['status']) {
  if (status === 'done' || status === 'matched') return 'success' as const;
  if (status === 'error') return 'destructive' as const;
  if (status === 'needs_review') return 'warning' as const;
  return 'outline' as const;
}

function percent(processed: number, total: number): number {
  if (!total) return 0;
  return Math.round((processed / total) * 100);
}

function SongArtwork({ song }: { song: Pick<NcmSongDisplay, 'cover' | 'name'> }) {
  if (!song.cover) {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-border bg-muted/60">
        <Music4 className="size-5 text-muted-foreground" />
      </div>
    );
  }
  return <img src={song.cover} alt={song.name} className="h-14 w-14 rounded-xl object-cover" />;
}

function CandidateArtwork({ candidate }: { candidate: SongMatch['candidates'][number] }) {
  if (!candidate.artworkUrl) {
    return (
      <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-border bg-muted/50">
        <Music4 className="size-4 text-muted-foreground" />
      </div>
    );
  }
  return <img src={candidate.artworkUrl} alt={candidate.name} className="h-12 w-12 rounded-lg object-cover" />;
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/40 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

export default function App() {
  const querySession = useMemo(() => new URLSearchParams(window.location.search).get('session') || '', []);
  const pollTimer = useRef<number | null>(null);

  const [token, setToken] = useState('');
  const [auto, setAuto] = useState(false);
  const [payload, setPayload] = useState<SyncResponse | null>(null);
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bootToken, setBootToken] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [queries, setQueries] = useState<Record<number, string>>({});
  const [pushSupported, setPushSupported] = useState(true);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [vapidKey, setVapidKey] = useState('');

  const addLog = useCallback((tone: LogEntry['tone'], message: string) => {
    setLogs((current) => [{ id: makeId(), tone, message }, ...current].slice(0, 40));
  }, []);

  const saveAuth = useCallback(
    (nextToken: string, nextSession: string, nextAuto: boolean) => {
      localStorage.setItem(STORAGE_TOKEN, nextToken);
      if (nextSession) localStorage.setItem(STORAGE_SESSION, nextSession);
      else localStorage.removeItem(STORAGE_SESSION);
      localStorage.setItem(STORAGE_AUTO, nextAuto ? '1' : '0');
    },
    [],
  );

  const applyPayload = useCallback(
    (nextPayload: SyncResponse) => {
      setPayload(nextPayload);
      setQueries((current) => {
        const next = { ...current };
        for (const song of nextPayload.data.songMatches) {
          next[song.ncmId] = song.query;
        }
        return next;
      });
      saveAuth(token, nextPayload.sessionId, auto);
    },
    [auto, saveAuth, token],
  );

  const api = useCallback(
    async <T,>(path: string): Promise<T> => {
      const separator = path.includes('?') ? '&' : '?';
      const response = await fetch(`${window.location.origin}${path}${separator}token=${encodeURIComponent(token)}`);
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || response.statusText || 'Request failed');
      }
      return data as T;
    },
    [token],
  );

  const refreshPushState = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushSupported(false);
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setPushSubscribed(Boolean(subscription));
      setPushSupported(true);
    } catch {
      setPushSupported(false);
    }
  }, []);

  const restoreSession = useCallback(
    async (sessionId: string) => {
      if (!token) return;
      try {
        const nextPayload = await api<SyncResponse>(`/session?session=${encodeURIComponent(sessionId)}`);
        applyPayload(nextPayload);
        addLog('info', `已恢复会话 ${sessionId.slice(0, 8)}`);
        setAuthError('');
      } catch (error) {
        localStorage.removeItem(STORAGE_SESSION);
        setAuthError((error as Error).message);
        addLog('error', (error as Error).message);
      }
    },
    [addLog, api, applyPayload, token],
  );

  const restoreActiveSession = useCallback(async () => {
    if (!token) return;
    try {
      const nextPayload = await api<SyncResponse>('/session');
      applyPayload(nextPayload);
      addLog('info', '已恢复当前 active session');
      setAuthError('');
    } catch {
      // Ignore when there is no active session.
    }
  }, [addLog, api, applyPayload, token]);

  const runPhase = useCallback(
    async (phase: string) => {
      if (!payload) return;
      const nextPayload = await api<SyncResponse>(
        `/sync?phase=${encodeURIComponent(phase)}&session=${encodeURIComponent(payload.sessionId)}`,
      );
      applyPayload(nextPayload);
      return nextPayload;
    },
    [api, applyPayload, payload],
  );

  const startSync = useCallback(async () => {
    if (!token.trim()) {
      setAuthError('请输入 token');
      return;
    }

    try {
      setBusy(true);
      setAuthError('');
      const nextPayload = await api<SyncResponse>(`/sync?auto=${auto ? '1' : '0'}`);
      applyPayload(nextPayload);
      addLog('success', `Phase 1 完成，已收集 ${nextPayload.data.ncmTotal} 首歌曲`);
    } catch (error) {
      setAuthError((error as Error).message);
      addLog('error', (error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [addLog, api, applyPayload, auto, token]);

  const refreshSession = useCallback(async () => {
    if (!token) return;
    if (payload?.sessionId) {
      await restoreSession(payload.sessionId);
      return;
    }
    if (querySession) {
      await restoreSession(querySession);
      return;
    }
    await restoreActiveSession();
  }, [payload?.sessionId, querySession, restoreActiveSession, restoreSession, token]);

  const retrySearch = useCallback(
    async (song: SongMatch) => {
      try {
        const nextPayload = await api<SyncResponse>(
          `/sync?phase=2-search&session=${encodeURIComponent(payload!.sessionId)}&ncmId=${song.ncmId}&query=${encodeURIComponent(
            queries[song.ncmId] || song.query,
          )}`,
        );
        applyPayload(nextPayload);
        addLog('info', `已刷新 ${song.ncmName} 的候选列表`);
      } catch (error) {
        addLog('error', (error as Error).message);
      }
    },
    [addLog, api, applyPayload, payload, queries],
  );

  const selectCandidate = useCallback(
    async (song: SongMatch, candidateId: string) => {
      try {
        const nextPayload = await api<SyncResponse>(
          `/sync?phase=2-select&session=${encodeURIComponent(payload!.sessionId)}&ncmId=${song.ncmId}&candidateId=${encodeURIComponent(
            candidateId,
          )}`,
        );
        applyPayload(nextPayload);
        addLog('success', `已确认 ${song.ncmName}`);
      } catch (error) {
        addLog('error', (error as Error).message);
      }
    },
    [addLog, api, applyPayload, payload],
  );

  const skipSong = useCallback(
    async (song: SongMatch) => {
      try {
        const nextPayload = await api<SyncResponse>(
          `/sync?phase=2-skip-song&session=${encodeURIComponent(payload!.sessionId)}&ncmId=${song.ncmId}`,
        );
        applyPayload(nextPayload);
        addLog('info', `已跳过 ${song.ncmName}`);
      } catch (error) {
        addLog('error', (error as Error).message);
      }
    },
    [addLog, api, applyPayload, payload],
  );

  const continueReview = useCallback(async () => {
    if (!payload) return;
    try {
      const nextPayload = await api<SyncResponse>(
        `/sync?phase=2-continue&session=${encodeURIComponent(payload.sessionId)}`,
      );
      applyPayload(nextPayload);
      addLog('info', 'Phase 2 人工确认完成，继续后续流程');
    } catch (error) {
      addLog('error', (error as Error).message);
    }
  }, [addLog, api, applyPayload, payload]);

  const subscribePush = useCallback(async () => {
    if (!pushSupported || !token) return;
    try {
      let nextVapidKey = vapidKey;
      if (!nextVapidKey) {
        const response = await api<{ publicKey: string }>('/vapid-key');
        nextVapidKey = response.publicKey;
        setVapidKey(nextVapidKey);
      }
      if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('通知权限被拒绝');
      }
      const registration = await navigator.serviceWorker.ready;
      const pad = '='.repeat((4 - nextVapidKey.length % 4) % 4);
      const normalized = (nextVapidKey + pad).replace(/-/g, '+').replace(/_/g, '/');
      const applicationServerKey = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      const response = await fetch('/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error('订阅请求失败');
      await refreshPushState();
    } catch (error) {
      addLog('error', (error as Error).message);
    }
  }, [addLog, api, pushSupported, refreshPushState, token, vapidKey]);

  const unsubscribePush = useCallback(async () => {
    if (!pushSupported) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch('/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      await refreshPushState();
    } catch (error) {
      addLog('error', (error as Error).message);
    }
  }, [addLog, pushSupported, refreshPushState]);

  useEffect(() => {
    const savedToken = localStorage.getItem(STORAGE_TOKEN) || '';
    const savedAuto = localStorage.getItem(STORAGE_AUTO) === '1';
    setToken(savedToken);
    setBootToken(savedToken);
    setAuto(savedAuto);
  }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(refreshPushState).catch(() => setPushSupported(false));
    } else {
      setPushSupported(false);
    }
  }, [refreshPushState]);

  useEffect(() => {
    if (!token) return;
    saveAuth(token, payload?.sessionId || localStorage.getItem(STORAGE_SESSION) || '', auto);
  }, [auto, payload?.sessionId, saveAuth, token]);

  useEffect(() => {
    if (!bootToken || token !== bootToken) return;

    const savedSession = localStorage.getItem(STORAGE_SESSION) || '';
    const target = querySession || savedSession;
    if (target) {
      void restoreSession(target);
    } else {
      void restoreActiveSession();
    }
  }, [bootToken, querySession, restoreActiveSession, restoreSession, token]);

  useEffect(() => {
    if (pollTimer.current) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    if (!payload || payload.status !== 'running') return;

    let phase: string | null = null;
    if (payload.currentPhase === 2 && payload.state === 'searching') phase = '2';
    if (payload.currentPhase === 3 && payload.state === 'creating_playlist') phase = '3';
    if (payload.currentPhase === 4 && payload.state === 'adding_tracks') phase = '4';
    if (payload.currentPhase === 5 && payload.state === 'cleaning_old_playlists') phase = '5';
    if (!phase) return;

    pollTimer.current = window.setTimeout(() => {
      void runPhase(phase!).then((nextPayload) => {
        if (nextPayload?.status === 'done') {
          addLog('success', '同步完成');
        }
      });
    }, 450);

    return () => {
      if (pollTimer.current) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [addLog, payload, runPhase]);

  const unresolved = payload?.data.songMatches.filter((song) => song.status === 'needs_review' || song.status === 'error') || [];
  const matched = payload?.data.songMatches.filter((song) => song.status === 'matched') || [];
  const skipped = payload?.data.songMatches.filter((song) => song.status === 'skipped') || [];

  if (!payload) {
    return (
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-12">
        <Card className="w-full max-w-xl border-primary/20 bg-card/95 shadow-2xl shadow-primary/10 backdrop-blur">
          <CardHeader className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-primary/15 p-3 text-primary">
                <Sparkles className="size-6" />
              </div>
              <div>
                <CardTitle>NCM → Apple Music</CardTitle>
                <CardDescription>shadcn/ui 风格控制台，带 lucide 图标和多阶段同步状态。</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">Sync Token</label>
              <Input value={token} type="password" onChange={(event) => setToken(event.target.value)} placeholder="输入 token" />
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/30 p-4 text-sm">
              <Checkbox checked={auto} onChange={(event) => setAuto(event.target.checked)} />
              <span>
                <span className="font-medium">Automatic Skip Missing Songs</span>
                <span className="mt-1 block text-muted-foreground">
                  phase 2 中未确认的歌曲会直接跳过，并继续创建歌单。
                </span>
              </span>
            </label>
            {authError ? (
              <Alert variant="destructive">
                <AlertTitle>无法开始</AlertTitle>
                <AlertDescription>{authError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void startSync()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                开始同步
              </Button>
              {(querySession || localStorage.getItem(STORAGE_SESSION)) && token ? (
                <Button variant="secondary" onClick={() => void refreshSession()}>
                  <RefreshCw />
                  恢复会话
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 md:px-6 lg:px-8">
      <Card className="border-primary/20 bg-card/95 shadow-xl shadow-primary/5 backdrop-blur">
        <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-primary/15 p-3 text-primary">
                <Music4 className="size-6" />
              </div>
              <div>
                <CardTitle>会话 {payload.sessionId.slice(0, 8)}</CardTitle>
                <CardDescription>
                  {formatStatus(payload)} · {payload.data.storefront || '-'} 区 · {payload.data.accountLabel}
                </CardDescription>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={payload.source === 'cron' ? 'secondary' : 'outline'}>{payload.source === 'cron' ? 'CRON' : '网页触发'}</Badge>
              <Badge variant={payload.auto ? 'secondary' : 'outline'}>
                {payload.auto ? 'Automatic Skip Missing Songs' : '人工确认模式'}
              </Badge>
              {payload.active ? <Badge variant="success">Active Session</Badge> : null}
              {payload.state === 'review_required' ? <Badge variant="warning">需要选择歌曲</Badge> : null}
              {payload.status === 'done' ? <Badge variant="success">已完成</Badge> : null}
              {payload.status === 'error' ? <Badge variant="destructive">错误</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => void refreshSession()}>
              <RefreshCw />
              刷新状态
            </Button>
            <Button variant="default" onClick={() => void startSync()}>
              <Sparkles />
              新建会话
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <StatCard label="总歌曲" value={payload.data.ncmTotal} icon={<ListMusic className="size-4" />} />
          <StatCard label="已确认" value={payload.progress.matched} icon={<Check className="size-4" />} />
          <StatCard label="待处理" value={payload.progress.review} icon={<CircleAlert className="size-4" />} />
          <StatCard label="已跳过" value={payload.progress.skipped} icon={<SkipForward className="size-4" />} />
          <StatCard label="阶段" value={`Phase ${payload.currentPhase}`} icon={<Sparkles className="size-4" />} />
          <div className="xl:col-span-5">
            <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
              <span>处理进度</span>
              <span>
                {payload.progress.processed}/{payload.progress.total}
              </span>
            </div>
            <Progress value={percent(payload.progress.processed, payload.progress.total)} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_0.9fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>阶段进度</CardTitle>
              <CardDescription>Phase 1~5 的当前状态和结果摘要。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              {payload.phaseSummary.map((step) => (
                <div
                  key={step.phase}
                  className="rounded-xl border border-border/70 bg-muted/30 p-4 transition-colors data-[status=running]:border-primary/60 data-[status=done]:border-emerald-500/30 data-[status=error]:border-destructive/40"
                  data-status={step.status}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">
                      Phase {step.phase} · {step.title}
                    </div>
                    <Badge variant={step.status === 'done' ? 'success' : step.status === 'error' ? 'destructive' : step.status === 'running' ? 'secondary' : 'outline'}>
                      {step.status}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{step.detail}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {payload.issues.length ? (
            <Card>
              <CardHeader>
                <CardTitle>问题与提示</CardTitle>
                <CardDescription>后端返回的结构化错误和警告。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {payload.issues.map((issue) => (
                  <Alert key={issue.id} variant={issue.severity === 'error' ? 'destructive' : 'warning'}>
                    <AlertTitle>
                      Phase {issue.phase} · {issue.code}
                    </AlertTitle>
                    <AlertDescription>
                      {issue.message}
                      {issue.retryable ? '（可重试）' : ''}
                    </AlertDescription>
                  </Alert>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>当前内容</CardTitle>
              <CardDescription>
                {payload.currentPhase === 2 && payload.state === 'review_required'
                  ? '默认展示候选列表，点选即可确认歌曲；找不到就直接跳过。'
                  : '根据当前阶段展示同步内容和操作。'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {payload.status === 'done' ? (
                <div className="space-y-4">
                  <Alert variant="success">
                    <AlertTitle>同步完成</AlertTitle>
                    <AlertDescription>
                      {payload.data.date} 的歌单 <strong>{payload.data.playlistName || '-'}</strong> 已创建，已添加{' '}
                      {payload.data.addedCount} 首歌曲。
                    </AlertDescription>
                  </Alert>
                  <div className="grid gap-3 md:grid-cols-3">
                    <StatCard label="已确认" value={payload.progress.matched} icon={<Check className="size-4" />} />
                    <StatCard label="已跳过" value={payload.progress.skipped} icon={<SkipForward className="size-4" />} />
                    <StatCard label="已清理旧歌单" value={payload.data.deletedPlaylists.length} icon={<ListMusic className="size-4" />} />
                  </div>
                </div>
              ) : null}

              {payload.status === 'cancelled' ? (
                <Alert variant="warning">
                  <AlertTitle>当前会话已被替换</AlertTitle>
                  <AlertDescription>新的会话 ID：{payload.data.replacedBy || '-'}</AlertDescription>
                </Alert>
              ) : null}

              {payload.status === 'error' ? (
                <Alert variant="destructive">
                  <AlertTitle>流程中断</AlertTitle>
                  <AlertDescription>请先查看上方问题列表，然后重试或直接新建会话。</AlertDescription>
                </Alert>
              ) : null}

              {payload.currentPhase === 2 && payload.state === 'searching' ? (
                <div className="space-y-5">
                  <Alert>
                    <Loader2 className="mb-2 size-4 animate-spin" />
                    <AlertTitle>正在搜索 Apple Music</AlertTitle>
                    <AlertDescription>
                      Phase 1 已完成，正在为 {payload.progress.processed}/{payload.progress.total} 首歌曲生成候选列表。
                    </AlertDescription>
                  </Alert>
                  <div className="grid gap-3">
                    {payload.data.ncmSongs.map((song) => (
                      <div key={song.id} className="flex items-center gap-4 rounded-xl border border-border/70 bg-muted/20 p-4">
                        <SongArtwork song={song} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{song.name}</div>
                          <div className="truncate text-sm text-muted-foreground">
                            {song.artist} · {song.album}
                          </div>
                        </div>
                        <Button variant="ghost" size="icon" onClick={() => window.open(song.ncmUrl, '_blank', 'noopener,noreferrer')}>
                          <ExternalLink />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {payload.currentPhase === 2 && payload.state === 'review_required' ? (
                <div className="space-y-6">
                  <Alert variant="warning">
                    <AlertTitle>人工确认阶段</AlertTitle>
                    <AlertDescription>候选列表已经默认展示。点选目标歌曲即可确认，找不到就跳过，然后继续下一步。</AlertDescription>
                  </Alert>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => void continueReview()}>
                      <ArrowRight />
                      继续下一步
                    </Button>
                    <Badge variant="warning">{unresolved.length} 首待处理</Badge>
                    <Badge variant="success">{matched.length} 首已确认</Badge>
                    <Badge variant="outline">{skipped.length} 首已跳过</Badge>
                  </div>

                  {unresolved.length ? (
                    <section className="space-y-4">
                      <h3 className="text-base font-semibold">待处理歌曲</h3>
                      {unresolved.map((song) => (
                        <div key={song.ncmId} className="rounded-2xl border border-amber-500/20 bg-card/80 p-4">
                          <div className="mb-4 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                            <div className="flex items-start gap-4">
                              <SongArtwork song={{ cover: song.ncmCover, name: song.ncmName }} />
                              <div className="space-y-1">
                                <div className="text-lg font-semibold">{song.ncmName}</div>
                                <div className="text-sm text-muted-foreground">
                                  {song.ncmArtist} · {song.ncmAlbum}
                                </div>
                                <a className="inline-flex items-center gap-1 text-sm text-primary" href={song.ncmUrl} target="_blank" rel="noreferrer">
                                  网易云原曲 <ExternalLink className="size-3" />
                                </a>
                              </div>
                            </div>
                            <Badge variant={badgeVariant(song.status)}>{song.status}</Badge>
                          </div>

                          <div className="mb-4 flex flex-col gap-3 md:flex-row">
                            <Input
                              value={queries[song.ncmId] ?? song.query}
                              onChange={(event) => setQueries((current) => ({ ...current, [song.ncmId]: event.target.value }))}
                              placeholder="输入新的 Apple Music 搜索词"
                            />
                            <Button variant="secondary" onClick={() => void retrySearch(song)}>
                              <Search />
                              重新搜索
                            </Button>
                            <Button variant="outline" onClick={() => void skipSong(song)}>
                              <SkipForward />
                              跳过此首
                            </Button>
                          </div>

                          {song.issues.length ? (
                            <div className="mb-4 space-y-2">
                              {song.issues.map((issue) => (
                                <Alert key={issue.id} variant="destructive">
                                  <AlertTitle>{issue.code}</AlertTitle>
                                  <AlertDescription>{issue.message}</AlertDescription>
                                </Alert>
                              ))}
                            </div>
                          ) : null}

                          <div className="grid gap-3 md:grid-cols-2">
                            {song.candidates.length ? (
                              song.candidates.map((candidate) => {
                                const selected = song.selectedCandidate?.id === candidate.id && song.status === 'matched';
                                return (
                                  <button
                                    key={candidate.id}
                                    type="button"
                                    onClick={() => void selectCandidate(song, candidate.id)}
                                    className={`rounded-xl border p-3 text-left transition hover:border-primary/50 hover:bg-muted/40 ${
                                      selected ? 'border-primary/60 bg-primary/10' : 'border-border/70 bg-muted/20'
                                    }`}
                                  >
                                    <div className="flex gap-3">
                                      <CandidateArtwork candidate={candidate} />
                                      <div className="min-w-0 flex-1 space-y-1">
                                        <div className="truncate font-medium">{candidate.name}</div>
                                        <div className="truncate text-sm text-muted-foreground">
                                          {candidate.artist} · {candidate.album || '-'}
                                        </div>
                                        <div className="flex flex-wrap gap-2 pt-1">
                                          <Badge variant="outline">score {candidate.score}</Badge>
                                          <Badge variant="outline">{candidate.source}</Badge>
                                          {selected ? <Badge variant="success">已选择</Badge> : null}
                                        </div>
                                      </div>
                                    </div>
                                  </button>
                                );
                              })
                            ) : (
                              <Alert variant="warning">
                                <AlertTitle>暂无候选结果</AlertTitle>
                                <AlertDescription>请修改搜索词后重试，或者直接跳过这首歌。</AlertDescription>
                              </Alert>
                            )}
                          </div>
                        </div>
                      ))}
                    </section>
                  ) : null}

                  {matched.length ? (
                    <section className="space-y-3">
                      <h3 className="text-base font-semibold">已确认歌曲</h3>
                      <div className="grid gap-3 md:grid-cols-2">
                        {matched.map((song) => (
                          <div key={song.ncmId} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                            <div className="mb-3 flex items-start justify-between gap-3">
                              <div>
                                <div className="font-medium">{song.ncmName}</div>
                                <div className="text-sm text-muted-foreground">{song.ncmArtist}</div>
                              </div>
                              <Badge variant="success">{song.decisionSource === 'automatic' ? '自动匹配' : '人工确认'}</Badge>
                            </div>
                            {song.selectedCandidate ? (
                              <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-3">
                                <CandidateArtwork candidate={song.selectedCandidate} />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium">{song.selectedCandidate.name}</div>
                                  <div className="truncate text-sm text-muted-foreground">
                                    {song.selectedCandidate.artist} · {song.selectedCandidate.album || '-'}
                                  </div>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : null}

              {[3, 4, 5].includes(payload.currentPhase) && payload.status === 'running' ? (
                <Alert>
                  <Loader2 className="mb-2 size-4 animate-spin" />
                  <AlertTitle>
                    {payload.currentPhase === 3
                      ? '正在创建 Apple Music 歌单'
                      : payload.currentPhase === 4
                        ? '正在向歌单添加歌曲'
                        : '正在清理旧歌单'}
                  </AlertTitle>
                  <AlertDescription>
                    歌单：{payload.data.playlistName || '尚未创建'} · 已确认 {payload.progress.matched} 首 · 已跳过 {payload.progress.skipped} 首
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>通知</CardTitle>
              <CardDescription>通知入口保留在同一页面，完成后会回跳到对应会话。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/30 p-4">
                <div className="space-y-1">
                  <div className="font-medium">浏览器推送</div>
                  <div className="text-sm text-muted-foreground">
                    {pushSupported ? (pushSubscribed ? '当前浏览器已订阅通知。' : '当前浏览器尚未订阅通知。') : '当前浏览器不支持 Push API。'}
                  </div>
                </div>
                {pushSubscribed ? <Badge variant="success">已订阅</Badge> : <Badge variant="outline">未订阅</Badge>}
              </div>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void subscribePush()} disabled={!pushSupported || pushSubscribed}>
                  <Bell />
                  开启通知
                </Button>
                <Button variant="secondary" onClick={() => void unsubscribePush()} disabled={!pushSupported || !pushSubscribed}>
                  <BellOff />
                  取消通知
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>本次同步概览</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
                <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <ShieldCheck className="size-4" />
                  Apple Music 账户
                </div>
                <div className="font-medium">{payload.data.accountLabel || '-'}</div>
              </div>
              <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
                <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <ListMusic className="size-4" />
                  歌单
                </div>
                <div className="font-medium">{payload.data.playlistName || '尚未创建'}</div>
              </div>
              <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
                <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <CloudAlert className="size-4" />
                  删除的旧歌单
                </div>
                <div className="space-y-1 text-sm text-muted-foreground">
                  {payload.data.deletedPlaylists.length ? payload.data.deletedPlaylists.map((playlist) => <div key={playlist}>{playlist}</div>) : <div>暂无</div>}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>操作日志</CardTitle>
              <CardDescription>页面内的前端操作记录。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
                {logs.length ? (
                  logs.map((entry) => (
                    <div
                      key={entry.id}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        entry.tone === 'success'
                          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
                          : entry.tone === 'error'
                            ? 'border-destructive/20 bg-destructive/10 text-rose-100'
                            : 'border-border/70 bg-muted/20 text-muted-foreground'
                      }`}
                    >
                      {entry.message}
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                    暂无日志。
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Separator />
      <div className="flex flex-col gap-3 pb-8 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <div>UI 已迁移到 shadcn/ui 风格组件和 lucide-react 图标，Worker 继续负责 API、cron、push 和会话状态。</div>
        <div>
          最近更新时间：{new Date(payload.data.updatedAt).toLocaleString('zh-CN')}
        </div>
      </div>
    </div>
  );
}
