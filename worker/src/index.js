// 週期 — 提醒通知小服務（Cloudflare Worker）
// 只保存「哪天要提醒這支手機、提醒寫什麼字」，不保存任何生理期紀錄。

const ALLOWED_ORIGINS = ['https://kuanyinyu-art.github.io', 'http://localhost:8765'];
const MAX_REMINDERS = 10;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    try {
      if (url.pathname === '/vapid' && request.method === 'GET') {
        return json({ publicKey: env.VAPID_PUBLIC });
      }
      if (request.method !== 'POST') return json({ error: 'not found' }, 404);

      const body = await request.json().catch(() => null);
      if (!body || typeof body.secret !== 'string' || body.secret.length < 20 || body.secret.length > 100) {
        return json({ error: 'bad request' }, 400);
      }
      const key = 'd:' + await sha256(body.secret);

      if (url.pathname === '/sync') {
        const sub = body.subscription;
        if (!validSubscription(sub, env)) return json({ error: 'bad subscription' }, 400);
        const reminders = (Array.isArray(body.reminders) ? body.reminders : [])
          .filter(r => r && Number.isFinite(r.at) && typeof r.body === 'string')
          .slice(0, MAX_REMINDERS)
          .map(r => ({ at: r.at, title: String(r.title || '週期').slice(0, 40), body: r.body.slice(0, 120), tag: String(r.tag || '').slice(0, 30) }));
        await env.KV.put(key, JSON.stringify({ sub, reminders, updated: Date.now() }));
        return json({ ok: true, count: reminders.length });
      }
      if (url.pathname === '/test') {
        const rec = await env.KV.get(key, 'json');
        if (!rec) return json({ error: 'not registered' }, 404);
        const res = await sendPush(env, rec.sub, { title: '週期', body: '🌙 測試通知，看到就代表成功了', tag: 'test' });
        return json({ ok: res.ok, status: res.status });
      }
      if (url.pathname === '/remove') {
        await env.KV.delete(key);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
  },

  // 每 15 分鐘檢查一次有沒有到時間的提醒
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env));
  },
};

export async function runDue(env, now = Date.now()) {
  let cursor;
  const results = [];
  do {
    const page = await env.KV.list({ prefix: 'd:', cursor });
    for (const { name } of page.keys) {
      const rec = await env.KV.get(name, 'json');
      if (!rec) continue;
      const due = rec.reminders.filter(r => r.at <= now);
      if (!due.length) continue;
      // 同時有好幾則到期時只發最新的一則，避免手機關機很久後一次跳很多則
      const latest = due.sort((a, b) => b.at - a.at)[0];
      const stale = now - latest.at > 2 * 24 * 3600 * 1000; // 過期超過兩天就不發了
      let gone = false;
      if (!stale) {
        const res = await sendPush(env, rec.sub, latest);
        results.push(res.status);
        gone = res.status === 404 || res.status === 410; // 手機已取消訂閱
      }
      if (gone) await env.KV.delete(name);
      else {
        rec.reminders = rec.reminders.filter(r => r.at > now);
        await env.KV.put(name, JSON.stringify(rec));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return results;
}

function validSubscription(s, env) {
  const okScheme = /^https:\/\//.test(s && s.endpoint) || (env && env.DEV_ALLOW_HTTP === '1');
  return s && typeof s.endpoint === 'string' && okScheme && s.endpoint.length < 1000 &&
    s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}

/* ---------------- Web Push（RFC 8291 加密 + RFC 8292 VAPID 簽章） ---------------- */

const enc = new TextEncoder();
const b64u = {
  encode(buf) {
    const b = new Uint8Array(buf); let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
async function sha256(text) {
  return b64u.encode(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

export async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

export async function vapidHeader(env, endpoint) {
  const pub = b64u.decode(env.VAPID_PUBLIC);
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d: env.VAPID_PRIVATE,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://kuanyinyu-art.github.io/cycle/',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u.encode(sig)}, k=${env.VAPID_PUBLIC}`;
}

export async function sendPush(env, subscription, message) {
  const body = await encryptPayload(subscription, JSON.stringify(message));
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidHeader(env, subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(2 * 24 * 3600),
      'Urgency': 'normal',
    },
    body,
  });
}
