export interface Env {
  // KV (single namespace)
  KV: KVNamespace;

  // Secrets (set via wrangler secret)
  NCM_COOKIE: string;             // MUSIC_U=xxx; __csrf=yyy (initial, auto-refreshed)
  AM_DEVELOPER_TOKEN?: string;    // Apple Music JWT (if pre-existing)
  AM_USER_TOKEN: string;          // media-user-token from cookie
  AM_TEAM_ID?: string;            // Apple Developer Team ID (if generating token)
  AM_KEY_ID?: string;             // MusicKit Key ID (if generating token)
  AM_PRIVATE_KEY?: string;        // MusicKit private key PEM (if generating token)

  // Optional
  PLAYLIST_PREFIX?: string;       // default "NCM Daily "
  KEEP_DAYS?: string;             // default "3"
  STOREFRONT?: string;            // default "cn"
}

export interface NcmSong {
  id: number;
  name: string;
  artists: { id: number; name: string }[];
  album: { id: number; name: string };
}

export interface AmSong {
  id: string;
  name: string;
  artist: string;
  album?: string;
  contentRating?: string;
}

export interface SyncResult {
  date: string;
  total: number;
  found: number;
  notFound: string[];
  playlistId: string | null;
  deletedPlaylists: string[];
  errors: string[];
}
