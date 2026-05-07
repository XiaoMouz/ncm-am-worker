export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;

  NCM_COOKIE: string;
  AM_DEVELOPER_TOKEN?: string;
  AM_USER_TOKEN: string;
  AM_ACCOUNT_LABEL?: string;
  AM_TEAM_ID?: string;
  AM_KEY_ID?: string;
  AM_PRIVATE_KEY?: string;
  SYNC_TOKEN: string;

  PLAYLIST_PREFIX?: string;
  KEEP_DAYS?: string;
  STOREFRONT?: string;
}

export interface NcmSong {
  id: number;
  name: string;
  artists: { id: number; name: string }[];
  album: { id: number; name: string };
  cover: string;
}

export interface NcmSongDisplay {
  id: number;
  name: string;
  artist: string;
  album: string;
  cover: string;
  ncmUrl: string;
}

export interface AmSong {
  id: string;
  name: string;
  artist: string;
  album?: string;
  contentRating?: string;
}

export interface AmCandidate extends AmSong {
  artworkUrl: string | null;
  url: string | null;
  score: number;
  source: 'catalog' | 'itunes';
}

export type SyncSource = 'manual' | 'cron';
export type SyncStatus = 'running' | 'done' | 'error' | 'cancelled';
export type SyncState =
  | 'collecting'
  | 'searching'
  | 'review_required'
  | 'creating_playlist'
  | 'adding_tracks'
  | 'cleaning_old_playlists'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type MatchStatus = 'pending' | 'matched' | 'needs_review' | 'skipped' | 'error';
export type MatchDecisionSource = 'automatic' | 'manual' | 'skipped' | null;

export interface SyncIssue {
  id: string;
  scope: 'session' | 'song';
  severity: 'error' | 'warning';
  phase: number;
  code: string;
  message: string;
  retryable: boolean;
  createdAt: number;
  ncmId?: number;
}

export interface SongMatch {
  ncmId: number;
  ncmName: string;
  ncmArtist: string;
  ncmAlbum: string;
  ncmCover: string;
  ncmUrl: string;
  query: string;
  status: MatchStatus;
  decisionSource: MatchDecisionSource;
  selectedCandidate: AmCandidate | null;
  candidates: AmCandidate[];
  issues: SyncIssue[];
}

export interface SyncSession {
  id: string;
  source: SyncSource;
  auto: boolean;
  createdAt: number;
  updatedAt: number;
  replacedBy: string | null;

  phase: number;
  state: SyncState;
  status: SyncStatus;

  date: string;
  storefront: string;
  accountLabel: string;

  ncmSongs: NcmSongDisplay[];
  ncmTotal: number;

  songMatches: SongMatch[];
  searchBatchIndex: number;
  searchBatchSize: number;

  playlistId: string | null;
  playlistName: string;
  addedCount: number;
  deletedPlaylists: string[];

  issues: SyncIssue[];
}

export interface PhaseSummary {
  phase: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail: string;
}

export interface SyncProgress {
  processed: number;
  total: number;
  matched: number;
  review: number;
  skipped: number;
  errors: number;
}

export interface SyncResponse {
  sessionId: string;
  currentPhase: number;
  status: SyncStatus;
  state: SyncState;
  source: SyncSource;
  auto: boolean;
  active: boolean;
  progress: SyncProgress;
  phaseSummary: PhaseSummary[];
  data: {
    createdAt: number;
    updatedAt: number;
    replacedBy: string | null;
    date: string;
    ncmSongs: NcmSongDisplay[];
    ncmTotal: number;
    songMatches: SongMatch[];
    storefront: string;
    accountLabel: string;
    playlistId: string | null;
    playlistName: string;
    addedCount: number;
    deletedPlaylists: string[];
  };
  issues: SyncIssue[];
}
