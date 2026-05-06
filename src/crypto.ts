// ── weapi encryption for Netease Cloud Music ──
// Ported from @neteasecloudmusicapienhanced/api/util/crypto.js

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function padEnd(s: string, len: number, char: string): string {
  while (s.length < len) s += char;
  return s;
}

// AES-CBC encrypt using Web Crypto
async function aesCbcEncrypt(
  plaintext: string,
  key: string,
  iv: string,
): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(key);
  const ivBytes = enc.encode(iv);
  const dataBytes = enc.encode(plaintext);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: ivBytes },
    cryptoKey,
    dataBytes,
  );

  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// RSA raw encrypt (no padding) using BigInt
// NCM uses forge.encrypt(str, 'NONE') = raw RSA: c = m^e mod n
function rsaEncrypt(message: string, modulusHex: string, exponent: number): string {
  const msgBytes = new TextEncoder().encode(message);
  const msgHex = bytesToHex(msgBytes);
  const n = BigInt('0x' + modulusHex);
  const e = BigInt(exponent);
  const m = BigInt('0x' + msgHex);

  // RSA: c = m^e mod n
  let result = BigInt(1);
  let base = m % n;
  let exp = e;
  while (exp > 0) {
    if (exp & BigInt(1)) {
      result = (result * base) % n;
    }
    base = (base * base) % n;
    exp >>= BigInt(1);
  }

  return result.toString(16).padStart(modulusHex.length, '0');
}

/**
 * weapi encrypt: double AES-CBC + RSA
 * Returns { params, encSecKey } for URL-encoded POST body
 */
export async function weapiEncrypt(data: Record<string, unknown>): Promise<{
  params: string;
  encSecKey: string;
}> {
  const text = JSON.stringify(data);

  // Generate random 16-char base62 key
  let secretKey = '';
  for (let i = 0; i < 16; i++) {
    secretKey += BASE62[Math.floor(Math.random() * 62)];
  }

  // Double AES-CBC encryption
  const firstPass = await aesCbcEncrypt(text, PRESET_KEY, IV);
  const params = await aesCbcEncrypt(firstPass, secretKey, IV);

  // RSA encrypt the reversed secret key
  const reversedKey = secretKey.split('').reverse().join('');
  const encSecKey = rsaEncrypt(reversedKey, getRsaModulus(), 65537);

  return { params, encSecKey };
}

// Decode the RSA public key modulus from the PEM in the NCM source
let _rsaModulus: string | null = null;
function getRsaModulus(): string {
  if (_rsaModulus) return _rsaModulus;

  // The actual modulus from: MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
  // This is a standard RSA 1024-bit public key in SubjectPublicKeyInfo DER format
  // The modulus starts after the header bytes
  const derB64 =
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX' +
    '/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9sn' +
    'QXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45' +
    'wIDAQAB';
  const der = Uint8Array.from(atob(derB64), (c) => c.charCodeAt(0));

  // Parse ASN.1: SEQUENCE > SEQUENCE(OID,NULL) > BITSTRING(00) > SEQUENCE > INTEGER(modulus) > INTEGER(exponent)
  // Outer SEQUENCE(0x30 0x81 0x9f) > AlgoId(0x30 0x0d, 13 bytes) > BITSTRING(0x03 0x81 0x8d, 0x00 padding)
  //   > Inner SEQUENCE(0x30 0x81 0x89) > Modulus INTEGER(0x02 0x81 0x81, leading 0x00)
  // Modulus is 129 bytes at offset 28 (includes leading 00), actual value is bytes 29-156
  const modBytes = der.slice(29, 29 + 128); // offset 28 = 0x00 prefix, 29 = actual modulus start
  _rsaModulus = bytesToHex(modBytes);
  return _rsaModulus;
}
