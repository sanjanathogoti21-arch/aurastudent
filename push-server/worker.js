/* AuraStudent server: a tiny Cloudflare Worker shared by all users of the app.
   - Web Push: each phone sends its reminders ALREADY ENCRYPTED for itself. This server only stores the
     encrypted blobs and the delivery time, and sends each one at the right minute (cron trigger).
   - Sync: each device uploads its records encrypted with a key derived from the user's sync code.
     The server cannot read titles, dates or anything else.
   Needs: a D1 database bound as DB, a cron trigger "* * * * *", and the settings
   VAPID_PUBLIC (text), VAPID_PRIVATE (secret), ALLOWED_ORIGIN (text, optional). */

const enc = new TextEncoder();
const b64u = {
  enc: (buf) => { const u = new Uint8Array(buf); let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: (str) => { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const p = s + '='.repeat((4 - (s.length % 4)) % 4); const bin = atob(p); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; },
};
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let i = 0; for (const y of a) { o.set(y, i); i += y.length; } return o; };

/* RFC 8292 VAPID header */
async function vapidHeader(endpoint, env) {
  const pub = b64u.dec(env.VAPID_PUBLIC);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://sanjanathogoti21-arch.github.io/aurastudent/' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims)));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function sendRaw(endpoint, body, env) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(endpoint, env), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
    body,
  });
}


const PUSH_HOST = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/;
const LIMITS = { subs: 5000, docs: 5000, alertsPerDev: 120, alertBody: 3000, doc: 700000 };

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS devs (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, sec TEXT NOT NULL, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS alerts2 (sid TEXT NOT NULL, seq TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (sid, seq))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS alerts2_at ON alerts2 (at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS docs (k TEXT PRIMARY KEY, rev INTEGER NOT NULL, body TEXT NOT NULL, updated INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS bu (code TEXT PRIMARY KEY, sec TEXT NOT NULL, name TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, updated INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS inv (id TEXT PRIMARY KEY, frm TEXT NOT NULL, tow TEXT NOT NULL, fname TEXT, topic TEXT, d TEXT, s TEXT, e TEXT, place TEXT, link TEXT, status TEXT NOT NULL, created INTEGER, updated INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS breq (id TEXT PRIMARY KEY, frm TEXT NOT NULL, tow TEXT NOT NULL, fname TEXT, status TEXT NOT NULL, created INTEGER, updated INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS breq_tow ON breq (tow, updated)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS breq_frm ON breq (frm, updated)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS inv_tow ON inv (tow, updated)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS inv_frm ON inv (frm, updated)'),
  ]);
  ready = true;
}

const cors = (env) => ({ 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });
const json = (env, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
// Tells the app WHY an AI call failed (for example the free daily limit) instead of a vague message.
function aiFail(env, e, fallback) {
  const m = String((e && e.message) || e || '');
  const quota = /4006|neurons|quota|daily|limit|capacity/i.test(m);
  return json(env, {
    error: quota ? 'The free AI allowance for today is used up. It resets around 5:30 am India time. Typing still works.' : fallback,
    detail: m.replace(/[\r\n]+/g, ' ').slice(0, 140)
  }, quota ? 429 : 502);
}
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/* best-effort rate limit per IP (resets when the worker restarts) */
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const now = Date.now(), k = bucket + '|' + ip, h = hits.get(k);
  if (!h || now - h.t > windowMs) { hits.set(k, { t: now, n: 1 }); if (hits.size > 5000) for (const [kk, v] of hits) if (now - v.t > windowMs) hits.delete(kk); return false; }
  return ++h.n > max;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return json(env, { error: 'The server is missing VAPID_PUBLIC or VAPID_PRIVATE.' }, 500);
  if (request.method === 'GET' && url.pathname === '/vapid') return json(env, { key: env.VAPID_PUBLIC });
  if (request.method === 'GET' && url.pathname === '/') return json(env, { ok: true, name: 'aurastudent-server', mode: 'shared' });
  if (request.method !== 'POST') return json(env, { error: 'Not found' }, 404);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (limited(ip, 'all', 240, 60000)) return json(env, { error: 'Too many requests. Wait a minute and try again.' }, 429);
  const isSync = url.pathname.startsWith('/sync/');
  const raw = await request.text();
  if (raw.length > (isSync ? LIMITS.doc * 1.5 : (url.pathname === '/stt' ? 900000 : 400000))) return json(env, { error: 'Too large.' }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json(env, { error: 'Bad JSON.' }, 400); }
  if (!b || typeof b !== 'object') return json(env, { error: 'Bad request.' }, 400);
  if (url.pathname === '/stt') {
    if (!env.AI && !env.WISPR_API_KEY) return json(env, { error: 'Speech recognition is not set up on the server yet.' }, 501);
    if (limited(ip, 'stt', 20, 60000) || limited(ip, 'sttday', 400, 86400e3)) return json(env, { error: 'Too many voice requests. Wait a minute and try again.' }, 429);
    const a = str(b.audio, 880000);
    if (a.length < 2000 || !/^[A-Za-z0-9+/=]+$/.test(a)) return json(env, { error: 'No audio received.' }, 400);
    const LANGS = ['en', 'hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur'];
    const lang = LANGS.includes(b.lang) ? b.lang : '';
    /* Wispr Flow Voice Interface API (speech to text + language detection only). Used when WISPR_API_KEY is set as a secret.
       If Wispr is not configured or fails, the existing Whisper path below answers, so voice never breaks. */
    let wisprNote = '';
    if (env.WISPR_API_KEY) {
      try {
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
        const body = { audio: a, context: {} };
        if (lang) body.language = [lang];            // one language forces it; leaving it out lets Wispr detect
        const wr = await fetch('https://platform-api.wisprflow.ai/api/v1/dash/api', {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.WISPR_API_KEY },
          body: JSON.stringify(body)
        });
        clearTimeout(tm);
        if (wr.ok) {
          const wj = await wr.json();
          const text = String((wj && wj.text) || '').trim().slice(0, 500);
          const dl = String((wj && wj.detected_language) || '').toLowerCase().slice(0, 2);
          if (text) return json(env, { text, language: LANGS.includes(dl) ? dl : (dl || ''), engine: 'wispr' });
          wisprNote = 'Wispr returned no text';
        } else wisprNote = 'Wispr answered ' + wr.status;
      } catch (e) { wisprNote = 'Wispr could not be reached'; }
    }
    try {
      const opts = { audio: a };
      if (lang) opts.language = lang;
      if (lang === 'en') opts.initial_prompt = 'Aura. Add task, schedule class, mark done, open tasks, what is on today, smart plan, tomorrow at 5 pm, physics lab, assignment, hackathon.';
      const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', opts);
      const wl = String((r && r.transcription_info && r.transcription_info.language) || '').toLowerCase().slice(0, 2);
      return json(env, { text: String((r && r.text) || '').trim().slice(0, 500), language: lang || (LANGS.includes(wl) ? wl : ''), engine: 'whisper', note: wisprNote });
    } catch (e) { return aiFail(env, e, 'The speech service failed. Try again.'); }
  }
  if (url.pathname === '/nlu') {
    if (!env.AI) return json(env, { error: 'Understanding is not set up on the server yet.' }, 501);
    if (limited(ip, 'nlu', 30, 60000) || limited(ip, 'nluday', 500, 86400e3)) return json(env, { error: 'Too many requests. Wait a minute and try again.' }, 429);
    const text = str(b.text, 600).trim();
    if (text.length < 2) return json(env, { error: 'No text.' }, 400);
    const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : '';
    const nowT = /^\d{2}:\d{2}$/.test(b.now) ? b.now : '';
    const wd = str(b.weekday, 12).replace(/[^A-Za-z]/g, '');
    if (!today) return json(env, { error: 'Missing date.' }, 400);
    const sys = `You turn ONE spoken sentence from a college student in India into ONE JSON object for a planner app. The student may speak English, Hindi, Telugu, Tamil, Kannada, Marathi, Bengali, or a mix (Hinglish). Understand loose, natural speech; they do not use fixed commands.
Today is ${wd} ${today}. The local time now is ${nowT || 'unknown'} (India). Resolve every relative date ("tomorrow", "Friday", "next week", "repu", "kal", "parso") to YYYY-MM-DD. Times are 24-hour HH:MM ("4 pm" = "16:00"; for an unclear am/pm pick the sensible daytime one).
Return ONLY JSON with these keys:
{"intent":"add_task|add_event|mark_done|update_task|delete_task|summary|open_view|clarify|none",
 "title":"short English title, max 60 chars, no date or time words",
 "date":"YYYY-MM-DD or empty", "time":"HH:MM start or empty", "end":"HH:MM or empty",
 "duration_min":number or 0, "type":"class|exam|study|hackathon|personal",
 "list":"task|event|hackathon|community|course", "milestone":"for hackathons: registration|team|submission|start",
 "priority":1|2|3, "hours":estimated hours of work for a task or 0,
 "query":"for mark_done: the task name", "view":"for open_view: tasks|calendar|plan|courses|hacks|insights|profile|assistant",
 "question":"for clarify: ONE short question",
 "new_date":"for update_task: the NEW date YYYY-MM-DD or empty", "new_time":"for update_task: NEW time HH:MM or empty", "new_title":"for update_task: the NEW wording of the task or empty",
 "status":"for delete_task: done if they mean completed tasks, else empty"}
Rules:
- A thing that happens at a clock time (class, meeting, hackathon round, exam, call, interview, study session at 4 pm) is add_event with time.
- Something to do, submit, finish, join, apply, revise, or prepare, with or without a deadline, is add_task. Put the deadline in date (and time if said).
- Anything about a HACKATHON (finding one, registering, forming a team, submitting, or the event itself, even a loose phrase like "schedule hackathon tomorrow") has list=hackathon. title is the hackathon's name if said, otherwise "Hackathon". milestone says which date it is: registration, team, submission, or start (default start). Put the date and time in date/time.
- Joining, applying to, or attending a club, community or group ("join the coding club", "community app join") has list=community and title is the group's name. If a date or time is said it is an event in that community.
- Learning something online or a course ("I want to do the React course", "enroll in Python on Coursera") has list=course, title is the course name, hours is hours per week if said.
- Everything else is list=task or list=event.
- If an event has no time, leave time empty. The app will pick a free slot.
- Changing something that already exists ("move my hackathon task to Friday", "change my Python course task to finish the advanced module", "reschedule the lab report to 5 pm", "push it to tomorrow") is update_task: query is the existing task's words, new_date/new_time/new_title carry only what changes. "it"/"that" as the task means query is empty.
- Removing something ("delete my completed hackathon task", "remove the physics quiz", "cancel it") is delete_task with query; status=done if they said completed or finished tasks.
- "I finished X", "X is done" is mark_done. "What is on today", "do I have anything tomorrow" is summary with date.
- If you truly cannot tell what they want, use clarify with one short question. If it is not about planning, use none.
- Never invent details the student did not say. Keep proper names as spoken.
JSON only, no commentary.`;
    const models = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
    const VIEWS_OK = ['tasks', 'calendar', 'plan', 'courses', 'hacks', 'insights', 'profile', 'assistant'];
    for (const m of models) {
      try {
        const r = await env.AI.run(m, { messages: [{ role: 'system', content: sys }, { role: 'user', content: text }], max_tokens: 380, temperature: 0 });
        let o = r && r.response;
        if (typeof o === 'string') { const mm = o.match(/\{[\s\S]*\}/); o = mm ? JSON.parse(mm[0]) : null; }
        if (!o || typeof o !== 'object') continue;
        const cmd = {
          intent: ['add_task', 'add_event', 'mark_done', 'update_task', 'delete_task', 'summary', 'open_view', 'clarify', 'none'].includes(o.intent) ? o.intent : 'none',
          title: String(o.title || '').replace(/[<>]/g, '').trim().slice(0, 80),
          date: /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : '',
          time: /^([01]\d|2[0-3]):[0-5]\d$/.test(o.time) ? o.time : '',
          end: /^([01]\d|2[0-3]):[0-5]\d$/.test(o.end) ? o.end : '',
          duration_min: Math.max(0, Math.min(720, Math.round(+o.duration_min || 0))),
          type: ['class', 'exam', 'study', 'hackathon', 'personal'].includes(o.type) ? o.type : 'personal',
          list: ['task', 'event', 'hackathon', 'community', 'course'].includes(o.list) ? o.list : '',
          milestone: ['registration', 'team', 'submission', 'start'].includes(o.milestone) ? o.milestone : '',
          priority: [1, 2, 3].includes(+o.priority) ? +o.priority : 2,
          hours: Math.max(0, Math.min(40, +o.hours || 0)),
          query: String(o.query || '').replace(/[<>]/g, '').trim().slice(0, 80),
          view: VIEWS_OK.includes(o.view) ? o.view : '',
          new_date: /^\d{4}-\d{2}-\d{2}$/.test(o.new_date) ? o.new_date : '',
          new_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(o.new_time) ? o.new_time : '',
          new_title: String(o.new_title || '').replace(/[<>]/g, '').trim().slice(0, 80),
          status: o.status === 'done' ? 'done' : '',
          question: String(o.question || '').replace(/[<>]/g, '').trim().slice(0, 140),
        };
        return json(env, { cmd });
      } catch (e) { /* try the next model */ }
    }
    return json(env, { error: 'The understanding service failed. Try again.' }, 502);
  }
  if (url.pathname === '/chat') {
    if (!env.AI) return json(env, { error: 'Chat is not set up on the server yet.' }, 501);
    if (limited(ip, 'chat', 20, 60000) || limited(ip, 'chatday', 300, 86400e3)) return json(env, { error: 'Too many chat messages. Wait a minute and try again.' }, 429);
    const text = str(b.text, 500).trim();
    if (text.length < 1) return json(env, { error: 'No text.' }, 400);
    const when = str(b.when, 60).replace(/[^A-Za-z0-9 ,:\-]/g, '');
    const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 25).map(t => str(t, 140).replace(/[\r\n]+/g, ' ')).filter(Boolean);
    const hist = (Array.isArray(b.history) ? b.history : []).slice(-6).map(h => ({ role: h && h.r === 'a' ? 'assistant' : 'user', content: str(h && h.t, 400) })).filter(h => h.content);
    const sys = `You are Aura, a warm, upbeat voice assistant inside a student planner app, talking with a college student in India. Talk like a supportive friend who plans their day: natural, short, encouraging, never robotic. This is spoken aloud, so use 1 to 3 short sentences, no lists, no markdown, no emojis. Reply in the same language the student used (English, Hindi, Telugu, or a mix).
The current date and time is ${when || 'unknown'} (India).
The student's open tasks (nearest deadline first) are:
${tasks.length ? tasks.map((t, i) => (i + 1) + '. ' + t).join('\n') : '(no open tasks)'}
Rules:
- Use ONLY the tasks listed above. Never invent a task, deadline, or time. If you do not know, say so.
- If they are stressed or overwhelmed, acknowledge the feeling in one sentence, then give ONE small next step based on their nearest deadline.
- If they ask what to do first, suggest an order using the deadlines above and say it is a suggestion. Do not guess how long things take.
- You cannot add, change, or finish tasks in this reply. If they want that, tell them to say it like "add task physics lab tomorrow at 4 pm" or "mark physics lab done".
- Never say you saved or changed anything.
- Stay on planning, studying and feeling organised. For anything else, answer briefly and kindly and steer back.`;
    const messages = [{ role: 'system', content: sys }].concat(hist, [{ role: 'user', content: text }]);
    for (const m of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct']) {
      try {
        const r = await env.AI.run(m, { messages, max_tokens: 160, temperature: 0.6 });
        const reply = String((r && (r.response || (r.result && r.result.response))) || '').replace(/[*_#`<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (reply) return json(env, { reply });
      } catch (e) { /* try the next model */ }
    }
    return json(env, { error: 'The chat service failed. Try again.' }, 502);
  }
  await ensure(env);

  if (isSync) {
    const key = str(b.key, 80);
    if (!/^[a-f0-9]{32,64}$/.test(key)) return json(env, { error: 'Bad sync key.' }, 400);
    const row = await env.DB.prepare('SELECT rev, body FROM docs WHERE k = ?1').bind(key).first();
    const rev = row ? row.rev : 0;
    const cur = () => (row ? JSON.parse(row.body) : {});
    if (url.pathname === '/sync/pull') return json(env, { rev, recs: cur() });
    if (url.pathname === '/sync/delete') { await env.DB.prepare('DELETE FROM docs WHERE k = ?1').bind(key).run(); return json(env, { ok: true }); }
    if (url.pathname !== '/sync/push') return json(env, { error: 'Not found' }, 404);
    const recs = b.recs;
    if (!recs || typeof recs !== 'object' || Array.isArray(recs)) return json(env, { error: 'Bad data.' }, 400);
    if (Number(b.rev) !== rev) return json(env, { error: 'conflict', rev, recs: cur() }, 409);
    if (!row) {
      if (limited(ip, 'newdoc', 5, 3600e3)) return json(env, { error: 'Too many new sync spaces from this network. Try later.' }, 429);
      const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM docs').first();
      if (n && n.c >= LIMITS.docs) return json(env, { error: 'The server is full right now.' }, 503);
    }
    const cutoff = Date.now() - 45 * 86400e3;
    for (const k of Object.keys(recs)) { const x = recs[k]; if (!x || typeof x !== 'object' || (x.d && x.t < cutoff)) delete recs[k]; }
    const body = JSON.stringify(recs);
    if (body.length > LIMITS.doc) return json(env, { error: 'Your data is too large to sync.' }, 413);
    const res = row
      ? await env.DB.prepare('UPDATE docs SET rev = ?2, body = ?3, updated = ?4 WHERE k = ?1 AND rev = ?5').bind(key, rev + 1, body, Date.now(), rev).run()
      : await env.DB.prepare('INSERT OR IGNORE INTO docs (k, rev, body, updated) VALUES (?1, 1, ?2, ?3)').bind(key, body, Date.now()).run();
    if (!res || !res.meta || res.meta.changes !== 1) { const again = await env.DB.prepare('SELECT rev, body FROM docs WHERE k = ?1').bind(key).first(); return json(env, { error: 'conflict', rev: again ? again.rev : 0, recs: again ? JSON.parse(again.body) : {} }, 409); }
    return json(env, { ok: true, rev: rev + 1 });
  }

  if (url.pathname === '/register') {
    const s = b.sub, secret = str(b.secret, 80);
    const ep = str(s && s.endpoint, 2048);
    let host = ''; try { host = new URL(ep).hostname; } catch {}
    if (!/^https:\/\//.test(ep) || !PUSH_HOST.test(host)) return json(env, { error: 'This browser\'s push service is not supported.' }, 400);
    if (secret.length < 16) return json(env, { error: 'Bad device secret.' }, 400);
    const id = await sha(ep), sec = await sha(secret);
    const row = await env.DB.prepare('SELECT sec FROM devs WHERE id = ?1').bind(id).first();
    if (row && row.sec !== sec) return json(env, { error: 'This device is already registered with a different secret.' }, 403);
    if (!row) {
      if (limited(ip, 'newdev', 20, 3600e3)) return json(env, { error: 'Too many registrations from this network. Try later.' }, 429);
      const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM devs').first();
      if (n && n.c >= LIMITS.subs) return json(env, { error: 'The server is full right now.' }, 503);
      await env.DB.prepare('INSERT OR IGNORE INTO devs (id, endpoint, sec, created) VALUES (?1, ?2, ?3, ?4)').bind(id, ep, sec, Date.now()).run();
    }
    return json(env, { id });
  }

  /* ---- study buddy invitations: stored readable by the server (needed to notify the other person) ---- */
  if (url.pathname.startsWith('/bu/') || url.pathname.startsWith('/inv/') || url.pathname.startsWith('/req/')) return buddyRoutes(url.pathname, b, env, ip);

  const id = str(b.id, 64), secret = str(b.secret, 80);
  const dev = id && secret && await env.DB.prepare('SELECT * FROM devs WHERE id = ?1').bind(id).first();
  if (!dev || dev.sec !== await sha(secret)) return json(env, { error: 'Unknown device. Turn alerts off and on again.' }, 404);

  if (url.pathname === '/schedule') {
    const items = Array.isArray(b.items) ? b.items.slice(0, LIMITS.alertsPerDev) : [];
    const stmts = [env.DB.prepare('DELETE FROM alerts2 WHERE sid = ?1').bind(id)];
    let n = 0;
    for (const it of items) {
      const at = Math.floor(Number(it && it.at)), seq = str(it && it.seq, 64), body = str(it && it.body, LIMITS.alertBody);
      if (!seq || !body || !(at > 1e12 && at < 4e12)) continue;
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO alerts2 (sid, seq, at, body) VALUES (?1, ?2, ?3, ?4)').bind(id, seq, at, body)); n++;
    }
    await env.DB.batch(stmts);
    return json(env, { ok: true, scheduled: n });
  }
  if (url.pathname === '/test') {
    if (limited(ip, 'test', 10, 60000)) return json(env, { error: 'Too many tests. Wait a minute.' }, 429);
    const body = b64u.dec(str(b.body, LIMITS.alertBody));
    const r = await sendRaw(dev.endpoint, body, env);
    if (r.status === 404 || r.status === 410) { await removeDev(env, id); return json(env, { error: 'This device was unsubscribed. Turn alerts off and on again.' }, 410); }
    return r.ok ? json(env, { ok: true }) : json(env, { error: 'The push service answered ' + r.status + '.' }, 502);
  }
  if (url.pathname === '/unregister') { await removeDev(env, id); return json(env, { ok: true }); }
  return json(env, { error: 'Not found' }, 404);
}

/* RFC 8291: encrypt a notification for one browser using the keys it registered. */
async function encPush(p256dh, auth, plain) {
  const ua = b64u.dec(p256dh), au = b64u.dec(auth);
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hk = async (sl, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sl, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const ikm = await hk(au, secret, cat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const cek = await hk(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hk(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']), cat(enc.encode(plain), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function notifyBuddy(env, code, title, body, tag, kind) {
  try {
    const u = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM bu WHERE code = ?1').bind(code).first();
    if (!u || !u.endpoint || !u.p256dh || !u.auth) return false;
    const r = await sendRaw(u.endpoint, await encPush(u.p256dh, u.auth, JSON.stringify({ title, body, tag, kind: kind || '' })), env);
    if (r.status === 404 || r.status === 410) await env.DB.prepare('UPDATE bu SET endpoint = NULL, p256dh = NULL, auth = NULL WHERE code = ?1').bind(code).run();
    return r.ok;
  } catch { return false; }
}
const CODE = /^[A-Z2-9]{10}$/;
const clean = (v, n) => str(v, n).replace(/[<>\u0000-\u001f]/g, '').trim();
const fmtD = (d) => { const t = new Date(d + 'T00:00:00Z'); return isNaN(t) ? d : t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
const rowOut = (r) => ({ id: r.id, from: r.frm, to: r.tow, fromName: r.fname, topic: r.topic, date: r.d, start: r.s, end: r.e, place: r.place, link: r.link, status: r.status, updated: r.updated });
async function buddyRoutes(path, b, env, ip) {
  const code = str(b.code, 20), secret = str(b.secret, 80);
  if (!CODE.test(code) || secret.length < 16) return json(env, { error: 'Bad buddy code.' }, 400);
  const sec = await sha(secret);
  const me = await env.DB.prepare('SELECT * FROM bu WHERE code = ?1').bind(code).first();
  if (path === '/bu/register') {
    if (me && me.sec !== sec) return json(env, { error: 'This buddy code belongs to someone else. Make a new one in the app.' }, 403);
    if (!me) {
      if (limited(ip, 'newbu', 20, 3600e3)) return json(env, { error: 'Too many new buddy codes from this network. Try later.' }, 429);
      const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM bu').first();
      if (n && n.c >= LIMITS.subs) return json(env, { error: 'The server is full right now.' }, 503);
    }
    const name = clean(b.name, 40) || 'A classmate';
    let ep = null, p = null, a = null;
    const s = b.sub;
    if (s && typeof s === 'object') {
      const e = str(s.endpoint, 2048); let host = ''; try { host = new URL(e).hostname; } catch {}
      if (/^https:\/\//.test(e) && PUSH_HOST.test(host) && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 60) { ep = e; p = s.keys.p256dh; a = s.keys.auth; }
    }
    if (me) await env.DB.prepare('UPDATE bu SET name = ?2, endpoint = COALESCE(?3, endpoint), p256dh = COALESCE(?4, p256dh), auth = COALESCE(?5, auth), updated = ?6 WHERE code = ?1').bind(code, name, ep, p, a, Date.now()).run();
    else await env.DB.prepare('INSERT INTO bu (code, sec, name, endpoint, p256dh, auth, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(code, sec, name, ep, p, a, Date.now()).run();
    return json(env, { ok: true, push: !!(ep || (me && me.endpoint)) });
  }
  if (!me || me.sec !== sec) return json(env, { error: 'Your buddy code is not registered yet. Open Study buddy and try again.' }, 404);
  if (path === '/inv/send') {
    if (limited(ip, 'invsend', 30, 3600e3)) return json(env, { error: 'Too many invitations. Try again later.' }, 429);
    const to = str(b.to, 20), id = str(b.id, 40);
    if (!CODE.test(to) || to === code) return json(env, { error: 'That buddy code is not valid.' }, 400);
    if (!/^[a-z0-9]{4,40}$/.test(id)) return json(env, { error: 'Bad invitation id.' }, 400);
    const topic = clean(b.topic, 80), d = str(b.date, 10), st = str(b.start, 5), en = str(b.end, 5), place = clean(b.place, 60);
    let link = str(b.link, 300); if (link && !/^https?:\/\/\S+$/i.test(link)) return json(env, { error: 'The meeting link must start with http:// or https://.' }, 400); link = link.replace(/[<>\u0000-\u001f]/g, '');
    if (!topic || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(en) || !place) return json(env, { error: 'The invitation is missing its subject, date, time or place.' }, 400);
    const rcpt = await env.DB.prepare('SELECT code FROM bu WHERE code = ?1').bind(to).first();
    if (!rcpt) return json(env, { error: 'Nobody has opened AuraStudent with that buddy code yet. Check the code with your friend.' }, 404);
    const now = Date.now();
    const res = await env.DB.prepare('INSERT OR IGNORE INTO inv (id, frm, tow, fname, topic, d, s, e, place, link, status, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, \'pending\', ?11, ?11)').bind(id, code, to, me.name || 'A classmate', topic, d, st, en, place, link, now).run();
    if (!res || !res.meta || res.meta.changes !== 1) return json(env, { ok: true, duplicate: true });
    const pushed = await notifyBuddy(env, to, `Study room invitation from ${me.name || 'A classmate'}`, `${topic} · ${fmtD(d)}, ${st} to ${en} · ${place}${link ? ' · ' + link : ''}`, 'inv-' + id, 'invite');
    return json(env, { ok: true, pushed });
  }
  if (path === '/bu/poll') {
    const since = Math.max(0, Math.floor(Number(b.since) || 0)), rsince = Math.max(0, Math.floor(Number(b.rsince) || 0));
    const [iv, rq] = await Promise.all([
      env.DB.prepare('SELECT * FROM inv WHERE (tow = ?1 OR frm = ?1) AND updated > ?2 ORDER BY updated LIMIT 100').bind(code, since).all(),
      env.DB.prepare('SELECT q.*, (SELECT name FROM bu WHERE code = q.tow) AS tname FROM breq q WHERE (q.tow = ?1 OR q.frm = ?1) AND q.updated > ?2 ORDER BY q.updated LIMIT 100').bind(code, rsince).all(),
    ]);
    return json(env, { now: Date.now(), invs: (iv.results || []).map(rowOut), reqs: (rq.results || []).map((r) => ({ id: r.id, from: r.frm, to: r.tow, fromName: r.fname, toName: r.tname || '', status: r.status, updated: r.updated })) });
  }
  if (path === '/inv/list') {
    const since = Math.max(0, Math.floor(Number(b.since) || 0));
    const rows = await env.DB.prepare('SELECT * FROM inv WHERE (tow = ?1 OR frm = ?1) AND updated > ?2 ORDER BY updated LIMIT 100').bind(code, since).all();
    return json(env, { now: Date.now(), invs: (rows.results || []).map(rowOut) });
  }
  if (path === '/inv/respond' || path === '/inv/cancel') {
    const id = str(b.id, 40), row = await env.DB.prepare('SELECT * FROM inv WHERE id = ?1').bind(id).first();
    if (!row) return json(env, { error: 'That invitation no longer exists.' }, 404);
    const cancel = path === '/inv/cancel', st = cancel ? 'cancelled' : (b.status === 'accepted' ? 'accepted' : b.status === 'declined' ? 'declined' : '');
    if (!st) return json(env, { error: 'Choose accept or decline.' }, 400);
    if (cancel ? row.frm !== code : row.tow !== code) return json(env, { error: 'You can not change this invitation.' }, 403);
    if (row.status !== 'pending') return json(env, { ok: true, status: row.status, unchanged: true });
    await env.DB.prepare('UPDATE inv SET status = ?2, updated = ?3 WHERE id = ?1').bind(id, st, Date.now()).run();
    const who = me.name || 'Your buddy', what = `${row.topic} · ${fmtD(row.d)}, ${row.s} to ${row.e}`;
    const pushed = cancel ? await notifyBuddy(env, row.tow, `${row.fname} cancelled a study room invitation`, what, 'inv-' + id, 'cancelled') : await notifyBuddy(env, row.frm, `${who} ${st} your study room invitation`, what, 'inv-' + id + '-' + st, st);
    return json(env, { ok: true, status: st, pushed });
  }
  /* ---- study buddy requests (like follow requests): nobody is added until the other person accepts ---- */
  if (path === '/req/send') {
    if (limited(ip, 'reqsend', 30, 3600e3)) return json(env, { error: 'Too many requests. Try again later.' }, 429);
    const to = str(b.to, 20), id = str(b.id, 40);
    if (!CODE.test(to) || to === code) return json(env, { error: 'That buddy code is not valid.' }, 400);
    if (!/^[a-z0-9]{4,40}$/.test(id)) return json(env, { error: 'Bad request id.' }, 400);
    const rcpt = await env.DB.prepare('SELECT code FROM bu WHERE code = ?1').bind(to).first();
    if (!rcpt) return json(env, { error: 'Nobody has opened AuraStudent with that buddy code yet. Check the code with your friend.' }, 404);
    const same = await env.DB.prepare("SELECT status FROM breq WHERE frm = ?1 AND tow = ?2 AND status IN ('pending','accepted') LIMIT 1").bind(code, to).first();
    if (same) return json(env, { error: same.status === 'pending' ? 'You already sent this person a request. It is still pending.' : 'You are already study buddies.', state: same.status }, 409);
    const back = await env.DB.prepare("SELECT status FROM breq WHERE frm = ?1 AND tow = ?2 AND status IN ('pending','accepted') LIMIT 1").bind(to, code).first();
    if (back) return json(env, { error: back.status === 'pending' ? 'This person already sent you a request. Accept it under Buddy requests.' : 'You are already study buddies.', state: 'incoming-' + back.status }, 409);
    const now = Date.now();
    const res = await env.DB.prepare("INSERT OR IGNORE INTO breq (id, frm, tow, fname, status, created, updated) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)").bind(id, code, to, me.name || 'A classmate', now).run();
    if (!res || !res.meta || res.meta.changes !== 1) return json(env, { ok: true, duplicate: true });
    const pushed = await notifyBuddy(env, to, `Study buddy request from ${me.name || 'A classmate'}`, `${me.name || 'A classmate'} wants to be your study buddy. Open Study buddy to accept or decline.`, 'req-' + id, 'request');
    return json(env, { ok: true, pushed });
  }
  if (path === '/req/list') {
    const since = Math.max(0, Math.floor(Number(b.since) || 0));
    const rows = await env.DB.prepare('SELECT q.*, (SELECT name FROM bu WHERE code = q.tow) AS tname FROM breq q WHERE (q.tow = ?1 OR q.frm = ?1) AND q.updated > ?2 ORDER BY q.updated LIMIT 100').bind(code, since).all();
    return json(env, { now: Date.now(), reqs: (rows.results || []).map((r) => ({ id: r.id, from: r.frm, to: r.tow, fromName: r.fname, toName: r.tname || '', status: r.status, updated: r.updated })) });
  }
  if (path === '/req/respond' || path === '/req/cancel') {
    const id = str(b.id, 40), row = await env.DB.prepare('SELECT * FROM breq WHERE id = ?1').bind(id).first();
    if (!row) return json(env, { error: 'That request no longer exists.' }, 404);
    const cancel = path === '/req/cancel', st = cancel ? 'cancelled' : (b.status === 'accepted' ? 'accepted' : b.status === 'declined' ? 'declined' : '');
    if (!st) return json(env, { error: 'Choose accept or decline.' }, 400);
    if (cancel ? row.frm !== code : row.tow !== code) return json(env, { error: 'You can not change this request.' }, 403);
    if (row.status !== 'pending') return json(env, { ok: true, status: row.status, unchanged: true });
    await env.DB.prepare('UPDATE breq SET status = ?2, updated = ?3 WHERE id = ?1').bind(id, st, Date.now()).run();
    const pushed = cancel ? false : await notifyBuddy(env, row.frm, `${me.name || 'Your buddy'} ${st} your study buddy request`, st === 'accepted' ? 'You are now study buddies. Open Study buddy to plan a room.' : 'They chose not to add you right now.', 'req-' + id + '-' + st, st);
    return json(env, { ok: true, status: st, pushed, name: me.name || '' });
  }
  return json(env, { error: 'Not found' }, 404);
}

const removeDev = (env, id) => env.DB.batch([env.DB.prepare('DELETE FROM alerts2 WHERE sid = ?1').bind(id), env.DB.prepare('DELETE FROM devs WHERE id = ?1').bind(id)]);

async function deliverDue(env) {
  await ensure(env);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM alerts2 WHERE at < ?1').bind(now - 24 * 3600e3).run();
  const due = await env.DB.prepare('SELECT a.sid, a.seq, a.body, d.endpoint FROM alerts2 a JOIN devs d ON d.id = a.sid WHERE a.at <= ?1 ORDER BY a.at LIMIT 40').bind(now).all();
  let sent = 0;
  for (const r of due.results || []) {
    let res;
    try { res = await sendRaw(r.endpoint, b64u.dec(r.body), env); } catch { continue; }
    if (res.ok) { sent++; await env.DB.prepare('DELETE FROM alerts2 WHERE sid = ?1 AND seq = ?2').bind(r.sid, r.seq).run(); }
    else if (res.status === 404 || res.status === 410) await removeDev(env, r.sid);
    else if (res.status !== 429 && res.status < 500) await env.DB.prepare('DELETE FROM alerts2 WHERE sid = ?1 AND seq = ?2').bind(r.sid, r.seq).run();
  }
  return sent;
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); } catch (e) { return json(env, { error: 'Server error.' }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(deliverDue(env)); },
};
