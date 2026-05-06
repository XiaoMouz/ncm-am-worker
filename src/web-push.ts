// ── Web Push implementation for Cloudflare Workers ──
// Uses SubtleCrypto — no external dependencies

const VAPID_CLAIMS = { sub: 'mailto:push@ncm-am-worker' };

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr;
}

function uint8ArrayToUrlBase64(arr: Uint8Array): string {
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate VAPID key pair
 * Returns { publicKey, privateKey } in urlBase64 format
 */
export async function generateVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

  return {
    publicKey: uint8ArrayToUrlBase64(new Uint8Array(pubRaw)),
    privateKey: privJwk.d!,
  };
}

/**
 * Create VAPID Authorization header
 */
async function createVapidAuth(
  audience: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
): Promise<string> {
  const header = { alg: 'ES256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: VAPID_CLAIMS.sub,
  };

  const enc = new TextEncoder();
  const h = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const p = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${h}.${p}`;

  // Import private key for signing
  const privKeyBytes = urlBase64ToUint8Array(vapidPrivateKey);
  const pubKeyBytes = urlBase64ToUint8Array(vapidPublicKey);

  // Build uncompressed public key (04 + x + y)
  const fullPubKey = new Uint8Array(65);
  fullPubKey[0] = 0x04;
  fullPubKey.set(pubKeyBytes, 1);

  // Import as JWK
  const x = uint8ArrayToUrlBase64(pubKeyBytes.slice(0, 32));
  const y = uint8ArrayToUrlBase64(pubKeyBytes.slice(32, 64));
  const d = vapidPrivateKey;

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    enc.encode(signingInput),
  );

  const sigB64 = uint8ArrayToUrlBase64(new Uint8Array(sig));
  return `vapid t=${signingInput}.${sigB64}, k=${vapidPublicKey}`;
}

/**
 * Encrypt payload for Web Push
 * RFC 8291 implementation
 */
async function encryptPayload(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
): Promise<{ body: Uint8Array | null; contentEncoding: string }> {
  if (!payload) return { body: null, contentEncoding: 'aesgcm' };

  const enc = new TextEncoder();
  const p256dh = urlBase64ToUint8Array(subscription.keys.p256dh);
  const auth = urlBase64ToUint8Array(subscription.keys.auth);
  const plaintext = enc.encode(payload);

  // Generate ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );

  // Import client's public key
  const clientPubKey = await crypto.subtle.importKey(
    'raw',
    p256dh,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // Derive shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPubKey },
    localKeyPair.privateKey,
    256,
  );

  // Export local public key
  const localPubKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', localKeyPair.publicKey),
  );

  // HKDF to derive PRK
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK = HKDF-Extract(salt=auth, IKM=sharedSecret)
  const prkKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveBits'],
  );

  // Derive content encryption key
  const prk = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: auth,
      info: enc.encode('Content-Encoding: auth\0'),
    },
    prkKey,
    256,
  );

  // Derive nonce and key
  const nonceInfo = enc.encode('Content-Encoding: nonce\0');
  const keyInfo = enc.encode('Content-Encoding: aesgcm\0');

  const nonceKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  const contentKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);

  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo },
      nonceKey,
      96,
    ),
  );

  const key = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: keyInfo },
      contentKey,
      128,
    ),
  );

  // Pad plaintext (2-byte padding length + padding + plaintext)
  const padding = new Uint8Array(2 + plaintext.length);
  padding.set(plaintext, 2);

  // AES-GCM encrypt
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      aesKey,
      padding,
    ),
  );

  // Body = salt (16) + local public key length (1 byte) + local public key (65) + ciphertext
  const body = new Uint8Array(1 + 16 + 65 + ciphertext.length);
  body.set(salt, 0);
  // RS field (record size) - 4 bytes, big-endian 4096
  // Actually for aesgcm: salt(16) + rs(4) + idlen(1) + id(65) + ciphertext
  // Let me restructure...
  const result = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.length);
  result.set(salt, 0);
  // Record size = 4096 (big-endian)
  result[16] = 0x00;
  result[17] = 0x00;
  result[18] = 0x10;
  result[19] = 0x00;
  result[20] = 65; // key length
  result.set(localPubKeyRaw, 21);
  result.set(ciphertext, 21 + 65);

  return { body: result, contentEncoding: 'aesgcm' };
}

/**
 * Send a Web Push notification
 */
export async function sendPushNotification(
  subscription: { endpoint: string; keys?: { p256dh: string; auth: string } },
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
): Promise<boolean> {
  try {
    const audience = new URL(subscription.endpoint).origin;
    const authHeader = await createVapidAuth(audience, vapidPublicKey, vapidPrivateKey);

    const headers: Record<string, string> = {
      TTL: '86400',
      Authorization: authHeader,
    };

    let body: Uint8Array | null = null;
    if (subscription.keys && payload) {
      const encrypted = await encryptPayload(subscription, payload);
      body = encrypted.body;
      headers['Content-Encoding'] = encrypted.contentEncoding;
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = String(body?.length || 0);
    }

    const resp = await fetch(subscription.endpoint, {
      method: 'POST',
      headers,
      body,
    });

    // 2xx = success, 404/410 = subscription expired (should delete)
    if (resp.status === 404 || resp.status === 410) {
      return false; // subscription expired
    }
    return resp.ok;
  } catch {
    return false;
  }
}
