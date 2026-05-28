/**
 * Shiftline — Web Push sender
 * Cloudflare Pages Function: POST /api/send-push
 *
 * Required environment variables (set in CF Pages → Settings → Environment variables):
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role JWT
 *   VAPID_PUBLIC_KEY           — VAPID public key (base64url, uncompressed 65-byte EC point)
 *   VAPID_PRIVATE_KEY          — VAPID private key (base64url, 32-byte EC scalar)
 *
 * Expected request body (JSON):
 *   { workerIds: string[], title: string, summary: string, weekStart: string }
 *
 * No npm dependencies — uses native CF Worker WebCrypto + fetch.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function b64uDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  return Uint8Array.from(atob(b64 + '='.repeat(pad)), c => c.charCodeAt(0));
}

function b64uEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const enc = str => new TextEncoder().encode(str);

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ─── HKDF wrapper (extract + expand in one step via WebCrypto) ────────────────

async function hkdf(keyMaterial, salt, info, bits) {
  const k = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HKDF' }, false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    k, bits
  ));
}

// ─── VAPID JWT (ES256) ────────────────────────────────────────────────────────
//
// JWT is scoped to the push endpoint's origin so it satisfies RFC 8292.
// Signed with the VAPID private key using ECDSA P-256 / SHA-256.
// WebCrypto outputs IEEE P1363 (r || s, 64 bytes) — exactly what JWT ES256 wants.

async function makeVapidJWT(endpoint, vapidPublicB64u, vapidPrivateB64u) {
  const { protocol, host } = new URL(endpoint);
  const audience = `${protocol}//${host}`;
  const now = Math.floor(Date.now() / 1000);

  const hdr = b64uEncode(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pld = b64uEncode(enc(JSON.stringify({
    aud: audience,
    exp: now + 43200,                          // 12 h
    sub: 'mailto:admin@shiftline.app',
  })));
  const sigInput = `${hdr}.${pld}`;

  // WebCrypto EC private key import requires JWK with x + y from the public key.
  // Our public key is uncompressed (04 || x[32] || y[32]), so slice accordingly.
  const pub = b64uDecode(vapidPublicB64u);
  const sigKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256',
      d: vapidPrivateB64u,
      x: b64uEncode(pub.slice(1, 33)),
      y: b64uEncode(pub.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    sigKey,
    enc(sigInput)
  );

  return `${sigInput}.${b64uEncode(new Uint8Array(sig))}`;
}

// ─── Web Push payload encryption (RFC 8291 + RFC 8188 "aes128gcm") ───────────
//
// Key derivation chain:
//   ecdhSecret  = ECDH(serverPriv, subscriberPub)
//   ikm         = HKDF(ecdhSecret, salt=authSecret, info="WebPush: info\0"||subPub||svrPub)
//   cek  (16 B) = HKDF(ikm,        salt=randomSalt, info="Content-Encoding: aes128gcm\0")
//   nonce(12 B) = HKDF(ikm,        salt=randomSalt, info="Content-Encoding: nonce\0")
//
// RFC 8188 record layout:
//   randomSalt(16) | rs(4 BE, = 4096) | idlen(1, = 65) | serverPub(65) | AES-GCM ciphertext
//
// Plaintext before encryption: payload bytes || 0x02  (no-padding delimiter)

async function encryptPush(payloadStr, p256dhB64u, authB64u) {
  const subPub    = b64uDecode(p256dhB64u);     // subscriber EC public key, 65 bytes
  const authBytes = b64uDecode(authB64u);        // auth secret, 16 bytes
  const plaintext = enc(payloadStr);

  // Ephemeral server key pair for ECDH
  const serverPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverPair.publicKey));

  // ECDH shared secret (256 bits = 32 bytes x-coordinate)
  const subPubKey = await crypto.subtle.importKey(
    'raw', subPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subPubKey }, serverPair.privateKey, 256
  ));

  // IKM
  const keyInfo = concat(enc('WebPush: info\0'), subPub, serverPubRaw);
  const ikm = await hkdf(ecdhSecret, authBytes, keyInfo, 256);

  // Random 16-byte salt for this record
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK and nonce (each needs its own importKey call — HKDF key is single-use in some runtimes)
  const cek   = await hkdf(ikm, salt, enc('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, enc('Content-Encoding: nonce\0'),     96);

  // AES-128-GCM encrypt
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    concat(plaintext, new Uint8Array([2]))   // 0x02 = no-padding delimiter (RFC 8188 §2)
  ));

  // Build RFC 8188 header
  const rsView = new DataView(new ArrayBuffer(4));
  rsView.setUint32(0, 4096, false);           // rs = 4096, big-endian

  return concat(salt, new Uint8Array(rsView.buffer), new Uint8Array([65]), serverPubRaw, ciphertext);
}

// ─── Send a single push notification ─────────────────────────────────────────

async function sendOnePush(subscription, payload, vapidPublicB64u, vapidPrivateB64u) {
  const { endpoint, keys } = subscription;

  const [jwt, body] = await Promise.all([
    makeVapidJWT(endpoint, vapidPublicB64u, vapidPrivateB64u),
    encryptPush(JSON.stringify(payload), keys.p256dh, keys.auth),
  ]);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${vapidPublicB64u}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type':     'application/octet-stream',
      'TTL':              '86400',
    },
    body,
  });

  // 201 (created) is success for FCM; 200 for some others
  if (res.status === 201 || res.status === 200) return { ok: true,  status: res.status };

  const text = await res.text().catch(() => '');
  return { ok: false, status: res.status, error: text.slice(0, 300) };
}

// ─── Cloudflare Pages Function handlers ──────────────────────────────────────

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const jsonHeaders = { ...CORS, 'Content-Type': 'application/json' };

  try {
    const { workerIds, title, summary, weekStart } = await request.json();

    // Validate input
    if (!Array.isArray(workerIds) || !workerIds.length) {
      return new Response(JSON.stringify({ error: 'workerIds must be a non-empty array' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    const SUPABASE_URL  = 'https://zqatducmyobthysrzvol.supabase.co';
    const SERVICE_KEY   = env.SUPABASE_SERVICE_ROLE_KEY;
    const VAPID_PUBLIC  = env.VAPID_PUBLIC_KEY;
    const VAPID_PRIVATE = env.VAPID_PRIVATE_KEY;

    if (!SERVICE_KEY || !VAPID_PUBLIC || !VAPID_PRIVATE) {
      return new Response(JSON.stringify({
        error: 'Missing env vars. Set SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY in CF Pages settings.',
      }), { status: 500, headers: jsonHeaders });
    }

    // Fetch push subscriptions from Supabase for these workers
    const ids = workerIds.map(id => `"${id}"`).join(',');
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?worker_id=in.(${ids})&select=worker_id,subscription`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );

    if (!subRes.ok) {
      throw new Error(`Supabase query failed (${subRes.status}): ${await subRes.text()}`);
    }

    const rows = await subRes.json();

    if (!Array.isArray(rows) || rows.length === 0) {
      return new Response(JSON.stringify({
        sent: 0, total: 0,
        note: 'No push subscriptions found. Workers need to open the PWA and grant notification permission first.',
      }), { headers: jsonHeaders });
    }

    // Payload sent to the service worker's push handler
    const payload = {
      title,
      body:  summary,
      data:  { weekStart, url: 'https://shiftline.pages.dev' },
      icon:  '/icon-192.png',
      badge: '/badge-72.png',
    };

    const results  = [];
    const staleIds = [];   // HTTP 410 means subscription is expired — clean up

    for (const row of rows) {
      try {
        const sub = typeof row.subscription === 'string'
          ? JSON.parse(row.subscription)
          : row.subscription;

        const r = await sendOnePush(sub, payload, VAPID_PUBLIC, VAPID_PRIVATE);
        results.push({ workerId: row.worker_id, ...r });

        if (r.status === 410) staleIds.push(row.worker_id);

      } catch (e) {
        console.error(`[send-push] worker ${row.worker_id}:`, e.message);
        results.push({ workerId: row.worker_id, ok: false, error: e.message });
      }
    }

    // Remove expired subscriptions from Supabase (best-effort, non-blocking)
    if (staleIds.length > 0) {
      const staleFilter = staleIds.map(id => `"${id}"`).join(',');
      fetch(
        `${SUPABASE_URL}/rest/v1/push_subscriptions?worker_id=in.(${staleFilter})`,
        { method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      ).catch(err => console.warn('[send-push] stale cleanup failed:', err.message));
    }

    return new Response(JSON.stringify({
      sent:    results.filter(r => r.ok).length,
      failed:  results.filter(r => !r.ok).length,
      stale:   staleIds.length,
      total:   rows.length,
      results,
    }), { headers: jsonHeaders });

  } catch (e) {
    console.error('[send-push] fatal:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: jsonHeaders,
    });
  }
}
