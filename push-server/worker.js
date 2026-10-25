/* AuraStudent push server: a tiny Cloudflare Worker.
   Stores each phone's push address plus the reminders the app sends it, and delivers them
   at the right minute using a cron trigger, so alerts arrive when the app is closed.
   Needs: a D1 database bound as DB, a cron trigger "* * * * *", and these settings:
   VAPID_PUBLIC (text), VAPID_PRIVATE (secret), TOKEN (secret), ALLOWED_ORIGIN (text). */

const enc = new TextEncoder();
const b64u = {
  enc: (buf) => { const u = new Uint8Array(buf); let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: (str) => { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const p = s + '='.repeat((4 - (s.length % 4)) % 4); const bin = atob(p); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; },
};
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let i = 0; for (const y of a) { o.set(y, i); i += y.length; } return o; };

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/* RFC 8291 message encryption (aes128gcm). `fixed` is only used by tests. */
async function encryptPayload(plain, p256dhB64, authB64, fixed) {
  const uaPub = b64u.dec(p256dhB64), auth = b64u.dec(authB64);
  let asPriv, asPubRaw;
  if (fixed) {
    const x = fixed.pub; asPubRaw = b64u.dec(x);
    asPriv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: fixed.priv, x: b64u.enc(asPubRaw.slice(1, 33)), y: b64u.enc(asPubRaw.slice(33, 65)), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPriv = kp.privateKey; asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPriv, 256));
  const salt = fixed ? b64u.dec(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(auth, secret, cat(enc.encode('WebPush: info\0'), uaPub, asPubRaw), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const data = cat(typeof plain === 'string' ? enc.encode(plain) : plain, new Uint8Array([2]));
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([asPubRaw.length]), asPubRaw, ct);
}

/* RFC 8292 VAPID header */
async function vapidHeader(endpoint, env) {
  const pub = b64u.dec(env.VAPID_PUBLIC);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://sanjanathogoti21-arch.github.io/aurastudent/' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims)));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function sendPush(sub, payload, env) {
  const body = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(sub.endpoint, env), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
    body,
  });
}

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS alerts (sid TEXT NOT NULL, seq TEXT NOT NULL, at INTEGER NOT NULL, title TEXT, msg TEXT, PRIMARY KEY (sid, seq))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS alerts_at ON alerts (at)'),
  ]);
  ready = true;
}

const cors = (env) => ({ 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });
const json = (env, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE || !env.TOKEN) return json(env, { error: 'The server is missing VAPID_PUBLIC, VAPID_PRIVATE or TOKEN.' }, 500);
  if (request.method === 'GET' && url.pathname === '/vapid') return json(env, { key: env.VAPID_PUBLIC });
  if (request.method === 'GET' && url.pathname === '/') return json(env, { ok: true, name: 'aurastudent-push' });
  if (request.method !== 'POST') return json(env, { error: 'Not found' }, 404);
  if (request.headers.get('Authorization') !== 'Bearer ' + env.TOKEN) return json(env, { error: 'Wrong access token.' }, 401);
  const raw = await request.text();
  if (raw.length > 200000) return json(env, { error: 'Too large.' }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json(env, { error: 'Bad JSON.' }, 400); }
  await ensure(env);

  if (url.pathname === '/subscribe') {
    const s = b && b.sub, k = s && s.keys;
    if (!s || !/^https:\/\//.test(str(s.endpoint, 2048)) || !k || !str(k.p256dh, 200) || !str(k.auth, 100)) return json(env, { error: 'Bad subscription.' }, 400);
    const id = await sha(s.endpoint);
    await env.DB.prepare('INSERT INTO subs (id, endpoint, p256dh, auth, created) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET p256dh = ?3, auth = ?4').bind(id, s.endpoint, k.p256dh, k.auth, Date.now()).run();
    return json(env, { id });
  }
  const id = str(b && b.id, 64);
  const sub = id && await env.DB.prepare('SELECT * FROM subs WHERE id = ?1').bind(id).first();
  if (!sub) return json(env, { error: 'Unknown device. Turn push alerts off and on again.' }, 404);

  if (url.pathname === '/schedule') {
    const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
    const stmts = [env.DB.prepare('DELETE FROM alerts WHERE sid = ?1').bind(id)];
    let n = 0;
    for (const it of items) {
      const at = Math.floor(Number(it && it.at));
      const seq = str(it && it.seq, 64);
      if (!seq || !(at > 1e12 && at < 4e12)) continue;
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO alerts (sid, seq, at, title, msg) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, seq, at, str(it.title, 120), str(it.msg, 300))); n++;
    }
    await env.DB.batch(stmts);
    return json(env, { ok: true, scheduled: n });
  }
  if (url.pathname === '/test') {
    const r = await sendPush(sub, { title: 'AuraStudent', body: 'Push alerts are working. Reminders will arrive even when the app is closed.', tag: 'test' }, env);
    if (r.status === 404 || r.status === 410) { await env.DB.batch([env.DB.prepare('DELETE FROM alerts WHERE sid = ?1').bind(id), env.DB.prepare('DELETE FROM subs WHERE id = ?1').bind(id)]); return json(env, { error: 'This device was unsubscribed. Turn push alerts off and on again.' }, 410); }
    return r.ok ? json(env, { ok: true }) : json(env, { error: 'The push service answered ' + r.status + '.' }, 502);
  }
  if (url.pathname === '/unsubscribe') {
    await env.DB.batch([env.DB.prepare('DELETE FROM alerts WHERE sid = ?1').bind(id), env.DB.prepare('DELETE FROM subs WHERE id = ?1').bind(id)]);
    return json(env, { ok: true });
  }
  return json(env, { error: 'Not found' }, 404);
}

async function deliverDue(env) {
  await ensure(env);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM alerts WHERE at < ?1').bind(now - 24 * 3600e3).run();
  const due = await env.DB.prepare('SELECT a.sid, a.seq, a.at, a.title, a.msg, s.endpoint, s.p256dh, s.auth FROM alerts a JOIN subs s ON s.id = a.sid WHERE a.at <= ?1 ORDER BY a.at LIMIT 40').bind(now).all();
  let sent = 0;
  for (const r of due.results || []) {
    let res;
    try { res = await sendPush(r, { title: r.title || 'AuraStudent', body: r.msg || '', tag: r.seq }, env); } catch { continue; }
    if (res.ok) { sent++; await env.DB.prepare('DELETE FROM alerts WHERE sid = ?1 AND seq = ?2').bind(r.sid, r.seq).run(); }
    else if (res.status === 404 || res.status === 410) await env.DB.batch([env.DB.prepare('DELETE FROM alerts WHERE sid = ?1').bind(r.sid), env.DB.prepare('DELETE FROM subs WHERE id = ?1').bind(r.sid)]);
    else if (res.status !== 429 && res.status < 500) await env.DB.prepare('DELETE FROM alerts WHERE sid = ?1 AND seq = ?2').bind(r.sid, r.seq).run();
  }
  return sent;
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); } catch (e) { return json(env, { error: 'Server error.' }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(deliverDue(env)); },
};
