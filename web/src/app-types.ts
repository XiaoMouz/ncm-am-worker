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

export interface NcmSongDisplay {
  id: number;
  name: string;
  artist: string;
  album: string;
  cover: string;
  ncmUrl: string;
}

export interface AmCandidate {
  id: string;
  name: string;
  artist: string;
  album?: string;
  artworkUrl: string | null;
  url: string | null;
  score: number;
  source: 'catalog' | 'itunes';
}

export interface SongMatch {
  ncmId: number;
  ncmName: string;
  ncmArtist: string;
  ncmAlbum: string;
  ncmCover: string;
  ncmUrl: string;
  query: string;
  status: 'pending' | 'matched' | 'needs_review' | 'skipped' | 'error';
  decisionSource: 'automatic' | 'manual' | 'skipped' | null;
  selectedCandidate: AmCandidate | null;
  candidates: AmCandidate[];
  issues: SyncIssue[];
}

export interface PhaseSummary {
  phase: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail: string;
}

export interface SyncResponse {
  sessionId: string;
  currentPhase: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  state:
    | 'collecting'
    | 'searching'
    | 'review_required'
    | 'creating_playlist'
    | 'adding_tracks'
    | 'cleaning_old_playlists'
    | 'completed'
    | 'failed'
    | 'cancelled';
  source: 'manual' | 'cron';
  auto: boolean;
  active: boolean;
  progress: {
    processed: number;
    total: number;
    matched: number;
    review: number;
    skipped: number;
    errors: number;
  };
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
