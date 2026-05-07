import type { AmCandidate, AmSong } from './types';

const AM_API = 'https://amp-api.music.apple.com/v1';
const CANDIDATE_LIMIT = 5;

export async function createDeveloperToken(
  teamId: string,
  keyId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId };
  const payload = {
    iss: teamId,
    iat: now,
    exp: now + 6 * 30 * 24 * 3600,
  };

  const enc = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${headerB64}.${payloadB64}`;

  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const derBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    derBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    enc.encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${signingInput}.${sigB64}`;
}

async function amFetch(
  path: string,
  developerToken: string,
  userToken?: string,
  options: { method?: string; body?: unknown } = {},
): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${developerToken}`,
    'Content-Type': 'application/json',
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
  };
  if (userToken) {
    headers['Media-User-Token'] = userToken;
  }

  const resp = await fetch(`${AM_API}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`AM API ${path}: ${resp.status} ${text.substring(0, 200)}`);
  }

  if (resp.status === 204) {
    return null;
  }

  return resp.json();
}

function uniqueQueries(queries: string[]): string[] {
  return Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean)));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'`·・:：,，.!！？?（）()\[\]\-_/]+/g, '');
}

function buildQueries(songName: string, artist: string, manualQuery?: string): string[] {
  if (manualQuery?.trim()) {
    return uniqueQueries([manualQuery]);
  }

  const cleanName = songName.replace(/\s*[\(（]feat\.?[^)）]*[)）]/gi, '').trim();
  const queries = [`${songName} ${artist}`, songName];

  if (cleanName && cleanName !== songName) {
    queries.push(`${cleanName} ${artist}`);
    queries.push(cleanName);
  }

  if (artist.includes('/')) {
    const firstArtist = artist.split('/')[0]?.trim();
    if (firstArtist) {
      queries.push(`${songName} ${firstArtist}`);
      if (cleanName && cleanName !== songName) {
        queries.push(`${cleanName} ${firstArtist}`);
      }
    }
  }

  return uniqueQueries(queries);
}

function normalizeArtworkUrl(url?: string): string | null {
  if (!url) return null;
  return url.replace('{w}', '240').replace('{h}', '240');
}

function normalizeCatalogCandidate(song: any, score: number): AmCandidate {
  return {
    id: String(song.id),
    name: song.attributes.name,
    artist: song.attributes.artistName,
    album: song.attributes.albumName || '',
    contentRating: song.attributes.contentRating || '',
    artworkUrl: normalizeArtworkUrl(song.attributes.artwork?.url),
    url: song.attributes.url || null,
    score,
    source: 'catalog',
  };
}

function normalizeItunesCandidate(song: any, score: number): AmCandidate {
  return {
    id: String(song.trackId),
    name: song.trackName,
    artist: song.artistName,
    album: song.collectionName || '',
    contentRating: song.contentRating || '',
    artworkUrl: song.artworkUrl100 || null,
    url: song.trackViewUrl || null,
    score,
    source: 'itunes',
  };
}

function scoreSong(
  song: any,
  songName: string,
  artist: string,
  manualQuery?: string,
  searchRank = 0,
): number {
  const cleanName = songName.replace(/\s*[\(（]feat\.?[^)）]*[)）]/gi, '').trim();
  const isLive = /[\(\[]live[\)\]]/i.test(songName) || /- live$/i.test(songName);
  const sName = normalizeSearchText(song.name || song.trackName || '');
  const sArtist = normalizeSearchText(song.artistName || song.artist || '');
  const songLower = normalizeSearchText(songName);
  const cleanLower = normalizeSearchText(cleanName);
  const artistLower = normalizeSearchText(artist);
  const manualLower = normalizeSearchText(manualQuery || '');
  let score = 0;

  if (sName === songLower || sName === cleanLower) score += 10;
  else if (cleanLower && (sName.includes(cleanLower) || cleanLower.includes(sName))) score += 5;

  if (sArtist === artistLower) score += 8;
  else if (artist.split('/').some((name) => sArtist.includes(name.trim().toLowerCase()))) score += 4;

  const sIsLive = /[\(\[]live[\)\]]/i.test(sName) || /- live/i.test(sName);
  if (!isLive && sIsLive) score -= 15;
  if (isLive && sIsLive) score += 2;

  if (song.contentRating === 'explicit') score += 3;

  if (manualLower) {
    if (sName.includes(manualLower)) score += 2;
    if (sArtist.includes(manualLower)) score += 1;
  }

  score += Math.max(CANDIDATE_LIMIT - searchRank, 0);

  return score;
}

function mergeCandidates(candidateLists: AmCandidate[][]): AmCandidate[] {
  const merged = new Map<string, AmCandidate>();

  for (const list of candidateLists) {
    for (const candidate of list) {
      const existing = merged.get(candidate.id);
      if (!existing || candidate.score > existing.score) {
        merged.set(candidate.id, candidate);
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT);
}

export async function searchSongCandidates(
  songName: string,
  artist: string,
  storefront: string,
  developerToken: string,
  manualQuery?: string,
): Promise<AmCandidate[]> {
  const queries = buildQueries(songName, artist, manualQuery);
  const allLists: AmCandidate[][] = [];

  for (const query of queries) {
    try {
      const encoded = encodeURIComponent(query);
        const data = await amFetch(
          `/catalog/${storefront}/search?term=${encoded}&types=songs&limit=${CANDIDATE_LIMIT}`,
          developerToken,
        );
        const songs = data?.results?.songs?.data || [];
        allLists.push(
          songs.map((song: any, index: number) =>
            normalizeCatalogCandidate(song, scoreSong(song.attributes, songName, artist, manualQuery, index)),
          ),
        );
      } catch {
        // Fall through to iTunes for this query.
      }

    try {
      const encoded = encodeURIComponent(query);
      const resp = await fetch(
        `https://itunes.apple.com/search?term=${encoded}&entity=song&limit=${CANDIDATE_LIMIT}&country=${storefront}`,
      );
        if (resp.ok) {
          const data: any = await resp.json();
          const songs = data.results || [];
          allLists.push(
            songs.map((song: any, index: number) =>
              normalizeItunesCandidate(song, scoreSong(song, songName, artist, manualQuery, index)),
            ),
          );
        }
      } catch {
      // Ignore per-query iTunes failures too.
    }
  }

  return mergeCandidates(allLists);
}

export async function searchSong(
  songName: string,
  artist: string,
  storefront: string,
  developerToken: string,
): Promise<AmSong | null> {
  const candidates = await searchSongCandidates(songName, artist, storefront, developerToken);
  const first = candidates[0];
  if (!first) return null;
  return {
    id: first.id,
    name: first.name,
    artist: first.artist,
    album: first.album,
    contentRating: first.contentRating,
  };
}

export async function listPlaylists(
  developerToken: string,
  userToken: string,
): Promise<{ id: string; name: string }[]> {
  const playlists: { id: string; name: string }[] = [];
  let nextPath: string | null = '/me/library/playlists';

  while (nextPath) {
    const data = await amFetch(nextPath, developerToken, userToken);
    for (const playlist of data?.data || []) {
      playlists.push({
        id: playlist.id,
        name: playlist.attributes.name,
      });
    }

    nextPath = data?.next || null;
    if (nextPath?.startsWith(AM_API)) {
      nextPath = nextPath.slice(AM_API.length);
    }
  }

  return playlists;
}

export async function validateLibraryAccess(
  developerToken: string,
  userToken: string,
): Promise<void> {
  await amFetch('/me/library/playlists?limit=1', developerToken, userToken);
}

export async function createPlaylist(
  name: string,
  developerToken: string,
  userToken: string,
): Promise<string> {
  const data = await amFetch('/me/library/playlists', developerToken, userToken, {
    method: 'POST',
    body: { attributes: { name } },
  });
  const playlist = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (!playlist?.id) {
    throw new Error('AM API create playlist returned no playlist id');
  }
  return String(playlist.id);
}

export async function addSongsToPlaylist(
  playlistId: string,
  songIds: string[],
  developerToken: string,
  userToken: string,
): Promise<void> {
  const uniqueIds = Array.from(new Set(songIds));
  const batchSize = 50;

  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    await amFetch(
      `/me/library/playlists/${playlistId}/tracks`,
      developerToken,
      userToken,
      {
        method: 'POST',
        body: {
          data: batch.map((id) => ({ id, type: 'songs' })),
        },
      },
    );
  }
}

export async function deletePlaylist(
  playlistId: string,
  developerToken: string,
  userToken: string,
): Promise<void> {
  const resp = await fetch(`${AM_API}/me/library/playlists/${playlistId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${developerToken}`,
      'Media-User-Token': userToken,
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
    },
  });

  if (resp.status === 404) {
    return;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`AM API delete playlist: ${resp.status} ${text.substring(0, 200)}`);
  }
}
