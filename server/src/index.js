// Mini Golf sync server: a Cloudflare Worker with one Durable Object per game.
//
// The game state itself is the same encoded string the app puts in links; the
// server just stores the newest version, hands it out, and sends a push
// notification to the other player when it becomes their turn, unless their
// app has checked in during the last few seconds (meaning it's open).
//
//   GET  /api/vapid                    -> { publicKey }      key browsers subscribe with
//   GET  /api/game/:id?p=0|1           -> { code, seq, next } (also marks player p as "app open")
//   PUT  /api/game/:id                 { code, seq, notify?, from? } -> { ok, seq } or 409 with the newer state
//   POST /api/game/:id/subscribe       { p, subscription }
//   POST /api/game/:id/next            { next }               (rematch: points the old game at the new one)

import { generateVapidKeys, sendPush } from './webpush.js';

const ID_RE = /^[a-z0-9]{1,16}$/;
const PRESENCE_MS = 15000;   // an app that polled this recently counts as open
const MAX_CODE = 16000;
const MAX_SUBS = 4;          // per player per game
const SUBJECT = 'https://rjd7004.github.io/minigolf/';

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors({ 'Content-Type': 'application/json' }) });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return json({ error: 'not found' }, 404);

    if (parts[1] === 'vapid' && parts.length === 2 && req.method === 'GET') {
      const keys = env.GAMES.get(env.GAMES.idFromName('__keys__'));
      const res = await keys.fetch('https://do/internal/keys');
      const { publicKey } = await res.json();
      return json({ publicKey });
    }

    // Only these public routes reach a game; /internal/* is for server-to-server calls.
    if (parts[1] === 'game' && ID_RE.test(parts[2] || '') && parts.length <= 4) {
      const sub = parts[3] || '';
      if (!['', 'subscribe', 'next'].includes(sub)) return json({ error: 'not found' }, 404);
      const stub = env.GAMES.get(env.GAMES.idFromName(`game:${parts[2]}`));
      const res = await stub.fetch(new Request(`https://do/game/${parts[2]}/${sub}${url.search}`, req));
      return new Response(res.body, { status: res.status, headers: cors({ 'Content-Type': 'application/json' }) });
    }
    return json({ error: 'not found' }, 404);
  },
};

export class Game {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const store = this.state.storage;
    const body = async () => {
      try { return await req.json(); } catch (e) { return null; }
    };

    // ---- internal ----
    if (path === '/internal/keys') {
      let keys = await store.get('vapid');
      if (!keys) {
        keys = await generateVapidKeys();
        await store.put('vapid', keys);
      }
      return Response.json(keys);
    }
    if (path === '/internal/carry') {
      return Response.json({ subs: (await store.get('subs')) || [[], []], seen: (await store.get('seen')) || [0, 0] });
    }

    // ---- public: /game/:id/<sub> ----
    const [, , id, sub] = path.split('/');

    if (sub === '' && req.method === 'GET') {
      const p = url.searchParams.get('p');
      if (p === '0' || p === '1') {
        const seen = (await store.get('seen')) || [0, 0];
        seen[+p] = Date.now();
        await store.put('seen', seen);
      }
      const game = await store.get('game');
      if (!game) return json({ error: 'not found' }, 404);
      return json({ code: game.code, seq: game.seq, next: game.next || null });
    }

    if (sub === '' && req.method === 'PUT') {
      const b = await body();
      if (!b || typeof b.code !== 'string' || b.code.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(b.code)) return json({ error: 'bad code' }, 400);
      if (!Number.isInteger(b.seq) || b.seq < 0) return json({ error: 'bad seq' }, 400);
      const game = await store.get('game');
      if (game && b.seq <= game.seq) return json({ error: 'stale', code: game.code, seq: game.seq, next: game.next || null }, 409);
      await store.put('game', { code: b.code, seq: b.seq, next: game ? game.next : null, updated: Date.now() });

      // A rematch starts with the old game's notification subscriptions, and
      // knows whose app is open (they were just looking at the old game).
      if (!game && typeof b.from === 'string' && ID_RE.test(b.from)) {
        const old = this.env.GAMES.get(this.env.GAMES.idFromName(`game:${b.from}`));
        const carry = await (await old.fetch('https://do/internal/carry')).json();
        await store.put('subs', carry.subs);
        const seen = (await store.get('seen')) || [0, 0];
        await store.put('seen', [Math.max(seen[0], carry.seen[0]), Math.max(seen[1], carry.seen[1])]);
      }

      const n = b.notify;
      if (n && (n.to === 0 || n.to === 1) && typeof n.body === 'string') {
        const seen = (await store.get('seen')) || [0, 0];
        if (Date.now() - seen[n.to] > PRESENCE_MS) {
          const link = typeof n.url === 'string' && /^https?:\/\//.test(n.url) && n.url.length < 500 ? n.url : SUBJECT;
          this.state.waitUntil(this.notify(n.to, {
            title: 'Mini Golf',
            body: n.body.slice(0, 140),
            url: link,
            tag: `minigolf-${id}`,
          }));
        }
      }
      return json({ ok: true, seq: b.seq });
    }

    if (sub === 'subscribe' && req.method === 'POST') {
      const b = await body();
      const s = b && b.subscription;
      const okEndpoint = s && typeof s.endpoint === 'string' && s.endpoint.length < 1000 &&
        (s.endpoint.startsWith('https://') || (this.env.ALLOW_HTTP_PUSH === '1' && s.endpoint.startsWith('http://')));
      if (!(b && (b.p === 0 || b.p === 1) && okEndpoint && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string')) {
        return json({ error: 'bad subscription' }, 400);
      }
      const subs = (await store.get('subs')) || [[], []];
      const clean = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
      subs[b.p] = [clean, ...subs[b.p].filter((x) => x.endpoint !== s.endpoint)].slice(0, MAX_SUBS);
      // A device belongs to one player per game.
      subs[1 - b.p] = subs[1 - b.p].filter((x) => x.endpoint !== s.endpoint);
      await store.put('subs', subs);
      return json({ ok: true });
    }

    if (sub === 'next' && req.method === 'POST') {
      const b = await body();
      if (!b || typeof b.next !== 'string' || !ID_RE.test(b.next)) return json({ error: 'bad id' }, 400);
      const game = await store.get('game');
      if (!game) return json({ error: 'not found' }, 404);
      game.next = b.next;
      await store.put('game', game);
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }

  async notify(to, message) {
    const subs = (await store(this).get('subs')) || [[], []];
    if (!subs[to].length) return;
    const keysStub = this.env.GAMES.get(this.env.GAMES.idFromName('__keys__'));
    const keys = await (await keysStub.fetch('https://do/internal/keys')).json();
    const payload = JSON.stringify(message);
    const results = await Promise.all(subs[to].map((s) => sendPush(s, payload, keys, SUBJECT)));
    // Drop subscriptions the push service says are gone.
    const keep = subs[to].filter((s, i) => results[i] !== 404 && results[i] !== 410);
    if (keep.length !== subs[to].length) {
      subs[to] = keep;
      await store(this).put('subs', subs);
    }
  }
}

function store(game) {
  return game.state.storage;
}
