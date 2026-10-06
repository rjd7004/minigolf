(() => {
  'use strict';

  // ---------- Tuning ----------
  // The course is laid out in a fixed 400x700 "world" and scaled to fit the screen.
  const W = 400;
  const H = 700;
  const BALL_R = 8;
  const HOLE_R = 13;
  const MAX_SPEED = 1150;     // world units / second at full power
  const MAX_DRAG = 150;       // drag distance (world units) for full power
  const MIN_POWER = 0.05;     // shorter drags are treated as a cancel
  // Rolling resistance is mostly proportional to speed, so the ball slows
  // exponentially and glides to a stop instead of braking hard at the end.
  const ROLL_FRICTION = 20;   // small constant deceleration so it does finally stop
  const DRAG_COEF = 0.9;      // speed-proportional deceleration (per second)
  const SAND_MULT = 5;
  const STOP_SPEED = 4;
  // The cup: while the ball's centre is over it, the slope pulls the ball toward
  // the middle. Fast balls get bent around the rim and roll on; slow ones drop.
  const CAPTURE_SPEED = 480;  // max speed that drops when dead-centre; less toward the edge
  const RIM_PULL = 4200;      // how hard the lip bends the ball's path toward the cup centre
  const RIM_WIDTH = 3;        // the lip starts this far outside the cup edge
  const RIM_DRAG = 0.997;     // speed kept per physics step while riding the rim
  const RESTITUTION = 0.75;
  const MAX_STROKES = 10;
  const PAR = 3;
  const STEP = 1 / 240;       // fixed physics step (small enough to avoid tunnelling)

  const COLORS = ['#ff5a5f', '#3b82f6'];

  const COURSE = {
    // Outer wall, clockwise. A dogleg: start bottom-left, hole top-right.
    boundary: [[40, 660], [220, 660], [220, 420], [360, 420], [360, 60], [140, 60], [40, 160]],
    tee: { x: 130, y: 615 },
    hole: { x: 285, y: 125 },
    blocks: [
      [[150, 250], [262, 250], [262, 276], [150, 276]],
    ],
    bumpers: [
      { x: 130, y: 490, r: 15 },
      { x: 100, y: 345, r: 15 },
      { x: 305, y: 335, r: 15 },
    ],
    sand: [{ x: 300, y: 215, r: 32 }],
    water: [{ x: 58, y: 180, w: 72, h: 50 }],
  };

  // Precompute wall segments from the outer boundary and the blocks.
  const segments = [];
  function addPolygon(poly) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      segments.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1] });
    }
  }
  addPolygon(COURSE.boundary);
  COURSE.blocks.forEach(addPolygon);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('course');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const banner = $('banner');
  const menu = $('menu');
  const results = $('results');
  const sharePanel = $('share');
  const joinPanel = $('join');
  const waitBar = $('waitbar');
  const cards = [...document.querySelectorAll('.player-card')];
  const nameInputs = [$('name0'), $('name1')];

  // ---------- State ----------
  const state = {
    mode: 'link',   // link: each player on their own phone, turns sent as links | local: pass & play
    phase: 'menu',  // menu | join | aim | rolling | anim | share | over
    id: '',         // game id (link mode)
    seq: 0,         // bumps on every committed change so stale links can be detected
    me: 0,          // which player this device is (link mode)
    players: [makePlayer('Player 1'), makePlayer('Player 2')],
    turn: 0,
    starter: 0,
    lastShot: null, // { p, x, y, a, w }: the most recent shot, replayed for the other player
    roll: null,     // { ball, from, player, onEvent } while a ball is moving
    anim: null,     // { kind: 'sink' | 'splash', t, x, y, player, onDone }
    aim: null,      // { sx, sy, cx, cy } in world coords while dragging
    time: 0,
  };

  function makePlayer(name) {
    return { name, strokes: 0, done: false, ball: { x: COURSE.tee.x, y: COURSE.tee.y, vx: 0, vy: 0 } };
  }

  function current() {
    return state.players[state.turn];
  }

  function nameOf(i) {
    return state.players[i].name || (i === 1 ? 'Friend' : 'Player 1');
  }

  function isLink() {
    return state.mode === 'link';
  }

  // ---------- Layout ----------
  let scale = 1;
  let dpr = 1;

  function resize() {
    const rect = stage.getBoundingClientRect();
    const cs = getComputedStyle(stage);
    const availW = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    scale = Math.max(0.1, Math.min(availW / W, availH / H));
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.style.width = `${Math.floor(W * scale)}px`;
    canvas.style.height = `${Math.floor(H * scale)}px`;
    canvas.width = Math.floor(W * scale * dpr);
    canvas.height = Math.floor(H * scale * dpr);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));


  // ---------- Saved names ----------
  function loadNames() {
    try {
      const saved = JSON.parse(localStorage.getItem('minigolf-names') || '[]');
      saved.forEach((n, i) => { if (nameInputs[i] && n) nameInputs[i].value = n; });
    } catch (e) { /* storage unavailable */ }
  }

  function saveName(i, name) {
    try {
      const saved = JSON.parse(localStorage.getItem('minigolf-names') || '[]');
      saved[i] = name;
      localStorage.setItem('minigolf-names', JSON.stringify(saved));
    } catch (e) { /* ignore */ }
  }

  // ---------- Starting games ----------
  function newGame(mode, names, starter, me) {
    state.mode = mode;
    state.id = mode === 'link' ? randomId() : '';
    state.seq = 0;
    state.me = me;
    state.players = names.map(makePlayer);
    state.turn = starter;
    state.starter = starter;
    state.lastShot = null;
    state.roll = state.anim = state.aim = null;
    hideOverlays();
    if (isLink()) commit();
    else history.replaceState(null, '', location.pathname + location.search);
    routeTurn();
  }

  function startFromMenu() {
    sound.unlock();
    const mode = menu.dataset.mode;
    const n0 = nameInputs[0].value.trim();
    const n1 = nameInputs[1].value.trim();
    saveName(0, n0);
    if (mode === 'local') {
      saveName(1, n1);
      newGame('local', [n0 || 'Player 1', n1 || 'Player 2'], 0, 0);
    } else {
      // Your friend fills in their own name when they open the link.
      newGame('link', [n0 || 'Player 1', ''], 0, 0);
    }
  }

  function rematch() {
    const names = state.players.map((p) => p.name);
    newGame(state.mode, names, 1 - state.starter, state.me);
  }

  function randomId() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
  }

  // ---------- Turn flow ----------
  function shoot(power, angle) {
    const p = current();
    // Quantise so the replay on the other phone runs exactly the same numbers.
    power = Math.round(power * 1e4) / 1e4;
    angle = Math.round(angle * 1e4) / 1e4;
    p.strokes++;
    const from = { x: p.ball.x, y: p.ball.y };
    state.lastShot = { p: state.turn, x: from.x, y: from.y, a: angle, w: power };
    launch(p.ball, from, power, angle);
    state.roll = { ball: p.ball, from, player: state.turn, onEvent: resolveShot };
    state.phase = 'rolling';
    updateHud();
    sound.hit(power);
  }

  function launch(ball, from, power, angle) {
    ball.onRim = false;
    ball.x = from.x;
    ball.y = from.y;
    ball.vx = Math.cos(angle) * power * MAX_SPEED;
    ball.vy = Math.sin(angle) * power * MAX_SPEED;
  }

  function resolveShot(ev) {
    const i = state.turn;
    const p = current();
    const { ball, from } = state.roll;
    state.roll = null;
    if (ev === 'sink') {
      p.done = true;
      sound.sink();
      if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
      showBanner(`${isLink() && i === state.me ? 'You' : nameOf(i)}: ${scoreName(p.strokes)}`, COLORS[i], 1500);
      startAnim('sink', ball, i, afterShot);
    } else if (ev === 'water') {
      p.strokes++; // penalty stroke
      sound.splash();
      showBanner('Splash! +1 stroke', '#3fa7e0', 1300);
      updateHud();
      startAnim('splash', ball, i, () => {
        ball.x = from.x;
        ball.y = from.y;
        afterShot();
      });
    } else {
      afterShot();
    }
  }

  function afterShot() {
    const p = current();
    p.ball.vx = p.ball.vy = 0;
    p.ball.x = Math.round(p.ball.x * 100) / 100;
    p.ball.y = Math.round(p.ball.y * 100) / 100;
    if (!p.done && p.strokes >= MAX_STROKES) {
      p.done = true;
      showBanner(`${nameOf(state.turn)}: max ${MAX_STROKES} strokes`, COLORS[state.turn]);
    }
    const other = 1 - state.turn;
    if (!state.players[other].done) state.turn = other;
    if (isLink()) commit();
    routeTurn();
  }

  // Decide what happens next: game over, my shot, or hand the turn to my friend.
  function routeTurn() {
    updateHud();
    if (state.players.every((p) => p.done)) {
      state.phase = 'over';
      setTimeout(showResults, 900);
      return;
    }
    if (!isLink() || state.turn === state.me) {
      state.phase = 'aim';
      const i = state.turn;
      const text = isLink() ? 'Your turn' : `${nameOf(i)}'s turn`;
      const wait = Math.max(250, bannerEnd - performance.now());
      setTimeout(() => {
        if (state.phase === 'aim' && state.turn === i) showBanner(text, COLORS[i]);
      }, wait);
      return;
    }
    state.phase = 'share';
    setTimeout(() => { if (state.phase === 'share') showShare(); }, 700);
  }

  function startAnim(kind, ball, player, onDone) {
    state.anim = { kind, t: 0, x: ball.x, y: ball.y, player, onDone };
    state.phase = 'anim';
  }

  function scoreName(strokes) {
    if (strokes === 1) return 'Hole in one!';
    const names = { '-3': 'Albatross!', '-2': 'Eagle!', '-1': 'Birdie!', '0': 'Par', '1': 'Bogey', '2': 'Double bogey' };
    return names[strokes - PAR] || `${strokes} strokes`;
  }

  // ---------- Panels ----------
  function hideOverlays() {
    [menu, results, sharePanel, joinPanel].forEach((el) => el.classList.add('hidden'));
    waitBar.classList.add('hidden');
  }

  function showMenu() {
    hideOverlays();
    state.phase = 'menu';
    state.roll = state.anim = state.aim = null;
    menu.classList.remove('hidden');
    updateHud();
  }

  function setMenuMode(mode) {
    menu.dataset.mode = mode;
    menu.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('start-btn').textContent = mode === 'local' ? 'Tee off' : 'Start & take first shot';
    nameInputs[0].placeholder = mode === 'local' ? 'Player 1' : 'Your name';
    $('mode-help').textContent = mode === 'local'
      ? 'Two players, one phone. Pass it back and forth.'
      : "You take a shot, then text your friend a link. They play their shot on their phone and send one back.";
  }

  function showResults() {
    hideOverlays();
    const [a, b] = state.players;
    const winner = a.strokes === b.strokes ? -1 : (a.strokes < b.strokes ? 0 : 1);
    let title = winner < 0 ? "It's a tie!" : `${nameOf(winner)} wins!`;
    if (isLink() && winner >= 0) title = winner === state.me ? 'You win!' : `${nameOf(winner)} wins!`;
    $('result-title').textContent = title;
    const rows = $('result-rows');
    rows.innerHTML = '';
    state.players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = `result-row p${i}` + (i === winner ? ' winner' : '');
      const rel = p.strokes - PAR;
      row.innerHTML = '<span class="dot"></span><span class="name"></span><span class="score"></span><span class="rel"></span>';
      row.querySelector('.name').textContent = nameOf(i);
      row.querySelector('.score').textContent = p.strokes;
      row.querySelector('.rel').textContent = rel === 0 ? 'E' : (rel > 0 ? `+${rel}` : `${rel}`);
      rows.appendChild(row);
    });
    const send = $('send-result-btn');
    send.classList.toggle('hidden', !isLink());
    send.textContent = `Send result to ${nameOf(1 - state.me)}`;
    $('again-btn').textContent = isLink() ? 'Rematch' : 'Play again';
    $('again-btn').classList.toggle('secondary', isLink());
    $('menu-btn').textContent = isLink() ? 'New game' : 'Change players';
    results.classList.remove('hidden');
  }

  function showShare() {
    hideOverlays();
    const joined = !!state.players[1].name;
    const friend = joined ? nameOf(state.turn) : 'your friend';
    $('share-title').textContent = joined ? `${friend}'s turn` : 'Challenge a friend';
    $('share-text').textContent = state.lastShot
      ? `Send ${friend} the link. They'll watch your shot, then take theirs.`
      : `Send ${friend} the link so they can tee off.`;
    $('share-btn').textContent = joined ? `Send to ${friend}` : 'Send link';
    $('copy-btn').textContent = 'Copy link';
    sharePanel.classList.remove('hidden');
  }

  function showWaitBar() {
    hideOverlays();
    const friend = state.players[1].name ? nameOf(state.turn) : 'your friend';
    $('wait-text').textContent = `Waiting for ${friend}`;
    waitBar.classList.remove('hidden');
  }

  function showJoin() {
    hideOverlays();
    const host = nameOf(0);
    $('join-title').textContent = `${host} challenged you!`;
    $('join-text').textContent = state.lastShot
      ? `Enter your name, watch ${host}'s first shot, then take yours.`
      : 'Enter your name to tee off.';
    const saved = nameInputs[0].value.trim();
    $('join-name').value = saved && saved !== host ? saved : '';
    joinPanel.classList.remove('hidden');
  }

  function join() {
    sound.unlock();
    const name = $('join-name').value.trim() || 'Player 2';
    state.players[1].name = name;
    saveName(0, name); // on this phone, you're the one typing in the first box
    nameInputs[0].value = name;
    commit();
    hideOverlays();
    playReplayThenRoute();
  }

  function updateHud() {
    state.players.forEach((p, i) => {
      const card = cards[i];
      let name = nameOf(i);
      if (isLink() && state.phase !== 'menu' && i === state.me) name += ' (you)';
      card.querySelector('.name').textContent = name;
      card.querySelector('.strokes').textContent = p.strokes;
      const active = state.phase !== 'menu' && state.phase !== 'over' && i === state.turn && !p.done;
      card.classList.toggle('active', active);
      card.classList.toggle('done', p.done);
    });
  }

  let bannerTimer = 0;
  let bannerEnd = 0;
  function showBanner(text, color, ms = 1200) {
    bannerEnd = performance.now() + ms;
    banner.textContent = text;
    banner.style.color = color || '#1d2a1f';
    banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('show'), ms);
  }

  // ---------- Sharing turns as links ----------
  // The whole game lives in the URL fragment (#g=...), so no server is needed.
  // Each phone also remembers the newest state it has seen per game, so reopening
  // an old link can't be used to retake a shot.

  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function encodeGame() {
    const ls = state.lastShot;
    return b64urlEncode(JSON.stringify({
      v: 1,
      i: state.id,
      s: state.seq,
      t: state.turn,
      f: state.starter,
      p: state.players.map((p) => [p.name, p.strokes, p.done ? 1 : 0, p.ball.x, p.ball.y]),
      l: ls ? [ls.p, ls.x, ls.y, ls.a, ls.w] : 0,
    }));
  }

  function decodeGame(code) {
    try {
      const o = JSON.parse(b64urlDecode(code));
      const num = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
      if (o.v !== 1 || typeof o.i !== 'string' || !/^[a-z0-9]{1,16}$/.test(o.i)) return null;
      if (!num(o.s, 0, 1e6) || ![0, 1].includes(o.t) || ![0, 1].includes(o.f)) return null;
      if (!Array.isArray(o.p) || o.p.length !== 2) return null;
      const players = o.p.map((a) => {
        if (!Array.isArray(a) || typeof a[0] !== 'string' || !num(a[1], 0, 30)) return null;
        const p = makePlayer(a[0].slice(0, 12));
        p.strokes = Math.floor(a[1]);
        p.done = !!a[2];
        if (num(a[3], 0, W) && num(a[4], 0, H) && pointInPolygon(a[3], a[4], COURSE.boundary)) {
          p.ball.x = a[3];
          p.ball.y = a[4];
        }
        return p;
      });
      if (players.includes(null)) return null;
      let lastShot = null;
      if (Array.isArray(o.l)) {
        const [p, x, y, a, w] = o.l;
        if ([0, 1].includes(p) && num(x, 0, W) && num(y, 0, H) && num(a, -10, 10) && num(w, 0, 1)) {
          lastShot = { p, x, y, a, w };
        }
      }
      return { id: o.i, seq: o.s, turn: o.t, starter: o.f, players, lastShot };
    } catch (e) {
      return null;
    }
  }

  function loadStore() {
    try { return JSON.parse(localStorage.getItem('minigolf-games') || '{}') || {}; } catch (e) { return {}; }
  }

  function saveStore(store) {
    try {
      const ids = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
      ids.slice(30).forEach((id) => delete store[id]);
      localStorage.setItem('minigolf-games', JSON.stringify(store));
    } catch (e) { /* ignore */ }
  }

  function remember() {
    const store = loadStore();
    store[state.id] = { me: state.me, seq: state.seq, code: encodeGame(), at: Date.now() };
    saveStore(store);
  }

  // Record a new version of the game: bump seq, save it, and put it in the address bar.
  function commit() {
    state.seq++;
    remember();
    history.replaceState(null, '', gameUrl());
    currentCode = encodeGame();
  }

  function gameUrl() {
    return `${location.href.split('#')[0]}#g=${encodeGame()}`;
  }

  function shareMessage() {
    const [a, b] = state.players;
    const score = `${nameOf(0)} ${a.strokes} · ${nameOf(1)} ${b.strokes}`;
    if (state.players.every((p) => p.done)) {
      if (a.strokes === b.strokes) return `We tied at mini golf! ⛳ ${score}`;
      return `${nameOf(a.strokes < b.strokes ? 0 : 1)} wins at mini golf! ⛳ ${score}`;
    }
    if (!state.players[1].name) return `${nameOf(0)} challenged you to mini golf ⛳ Your turn!`;
    return `Your turn at mini golf ⛳ ${score}`;
  }

  async function sendLink(button) {
    const url = gameUrl();
    const text = shareMessage();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Mini Golf', text, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    copyLink(button);
  }

  async function copyLink(button) {
    const url = gameUrl();
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch (e) { /* fall through */ }
    if (ok) {
      const old = button.textContent;
      button.textContent = 'Link copied!';
      setTimeout(() => { button.textContent = old; }, 1600);
    } else {
      window.prompt('Copy this link and send it:', url);
    }
  }

  let currentCode = '';

  // Open a game from the address bar. Returns false if there's no (valid) game in it.
  function loadFromHash() {
    const m = location.hash.match(/^#g=([A-Za-z0-9_-]+)$/);
    if (!m) return false;
    if (m[1] === currentCode) return true;
    let g = decodeGame(m[1]);
    if (!g) {
      showMenu();
      showBanner("Couldn't read that game link", '#c0392b', 2500);
      return false;
    }
    const store = loadStore();
    const saved = store[g.id];
    let newer = false;
    if (saved && saved.seq > g.seq) {
      // This phone has already moved past this link (e.g. you reopened a link you already played).
      const g2 = decodeGame(saved.code);
      if (g2) { g = g2; newer = true; }
    }
    const seenBefore = saved && saved.seq >= g.seq;

    state.mode = 'link';
    state.id = g.id;
    state.seq = g.seq;
    state.turn = g.turn;
    state.starter = g.starter;
    state.players = g.players;
    state.lastShot = g.lastShot;
    state.roll = state.anim = state.aim = null;
    state.me = saved ? saved.me : (!g.players[1].name ? 1 : g.turn);
    currentCode = encodeGame();
    if (newer) history.replaceState(null, '', gameUrl());

    hideOverlays();
    updateHud();
    if (state.me === 1 && !state.players[1].name) {
      state.phase = 'join';
      showJoin();
      return true;
    }
    remember();
    if (seenBefore) routeTurn();
    else playReplayThenRoute();
    return true;
  }

  // Show the other player's last shot rolling, then carry on from the saved state.
  function playReplayThenRoute() {
    const ls = state.lastShot;
    if (!ls || ls.p === state.me) {
      routeTurn();
      return;
    }
    // Park the ball at the shot's start (input stays blocked) while the banner shows.
    const ball = { x: ls.x, y: ls.y, vx: 0, vy: 0 };
    const from = { x: ls.x, y: ls.y };
    state.phase = 'anim';
    state.roll = {
      ball,
      from,
      player: ls.p,
      onEvent: (ev) => {
        state.roll = null;
        const done = () => { state.anim = null; routeTurn(); };
        if (ev === 'sink') {
          sound.sink();
          showBanner(`${nameOf(ls.p)}: ${scoreName(state.players[ls.p].strokes)}`, COLORS[ls.p], 1500);
          startAnim('sink', ball, ls.p, done);
        } else if (ev === 'water') {
          sound.splash();
          showBanner(`${nameOf(ls.p)} splashed! +1`, '#3fa7e0', 1300);
          startAnim('splash', ball, ls.p, done);
        } else {
          done();
        }
      },
    };
    showBanner(`${nameOf(ls.p)}'s shot`, COLORS[ls.p], 1100);
    setTimeout(() => {
      if (!state.roll || state.roll.ball !== ball) return; // game changed meanwhile
      launch(ball, from, ls.w, ls.a);
      sound.hit(ls.w);
      state.phase = 'rolling';
    }, 900);
  }

  // ---------- Input ----------
  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  function aimVector() {
    const a = state.aim;
    // Drag back to shoot forward: the shot goes opposite to the drag.
    const dx = a.sx - a.cx;
    const dy = a.sy - a.cy;
    const len = Math.hypot(dx, dy);
    const power = Math.min(len / MAX_DRAG, 1);
    return { power, dirX: len ? dx / len : 0, dirY: len ? dy / len : 0 };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (state.phase !== 'aim' || state.aim) return;
    sound.unlock();
    const w = toWorld(e);
    state.aim = { id: e.pointerId, sx: w.x, sy: w.y, cx: w.x, cy: w.y };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.aim || e.pointerId !== state.aim.id) return;
    const w = toWorld(e);
    state.aim.cx = w.x;
    state.aim.cy = w.y;
    e.preventDefault();
  });

  function release(e, cancelled) {
    if (!state.aim || e.pointerId !== state.aim.id) return;
    const { power, dirX, dirY } = aimVector();
    state.aim = null;
    if (!cancelled && power >= MIN_POWER && state.phase === 'aim') shoot(power, Math.atan2(dirY, dirX));
  }
  canvas.addEventListener('pointerup', (e) => release(e, false));
  canvas.addEventListener('pointercancel', (e) => release(e, true));

  // Stop iOS from scrolling / zooming the page while playing.
  document.addEventListener('touchmove', (e) => {
    if (e.target === canvas) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  menu.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMenuMode(b.dataset.mode)));
  $('start-btn').addEventListener('click', startFromMenu);
  $('again-btn').addEventListener('click', rematch);
  $('menu-btn').addEventListener('click', showMenu);
  $('send-result-btn').addEventListener('click', (e) => sendLink(e.currentTarget));
  $('share-btn').addEventListener('click', (e) => sendLink(e.currentTarget));
  $('copy-btn').addEventListener('click', (e) => copyLink(e.currentTarget));
  $('view-btn').addEventListener('click', showWaitBar);
  $('resend-btn').addEventListener('click', showShare);
  $('join-btn').addEventListener('click', join);
  $('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('hole-info').addEventListener('click', () => {
    if (state.phase === 'menu') return;
    if (state.phase !== 'over' && !window.confirm('Leave this game and start a new one?')) return;
    showMenu();
  });
  window.addEventListener('hashchange', loadFromHash);

  // ---------- Physics ----------
  function inSand(b) {
    return COURSE.sand.some((s) => Math.hypot(b.x - s.x, b.y - s.y) < s.r);
  }

  function inWater(b) {
    return COURSE.water.some((w) => b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h);
  }

  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function outOfBounds(b) {
    return !pointInPolygon(b.x, b.y, COURSE.boundary) || COURSE.blocks.some((p) => pointInPolygon(b.x, b.y, p));
  }

  let lastWallSound = 0;
  function bounce(b, nx, ny) {
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    b.vx -= (1 + RESTITUTION) * vn * nx;
    b.vy -= (1 + RESTITUTION) * vn * ny;
    if (-vn > 60 && state.time - lastWallSound > 0.06) {
      lastWallSound = state.time;
      sound.wall(Math.min(-vn / MAX_SPEED, 1));
    }
  }

  function collideSegment(b, s) {
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const t = Math.max(0, Math.min(1, ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / (ex * ex + ey * ey)));
    const px = s.ax + ex * t;
    const py = s.ay + ey * t;
    const dx = b.x - px;
    const dy = b.y - py;
    const d = Math.hypot(dx, dy);
    if (d >= BALL_R || d === 0) return;
    const nx = dx / d;
    const ny = dy / d;
    b.x = px + nx * BALL_R;
    b.y = py + ny * BALL_R;
    bounce(b, nx, ny);
  }

  function collideBumper(b, c) {
    const dx = b.x - c.x;
    const dy = b.y - c.y;
    const d = Math.hypot(dx, dy);
    const min = BALL_R + c.r;
    if (d >= min || d === 0) return;
    const nx = dx / d;
    const ny = dy / d;
    b.x = c.x + nx * min;
    b.y = c.y + ny * min;
    bounce(b, nx, ny);
  }

  // Advance a moving ball by one fixed step. Returns 'sink', 'water', 'stop' or null.
  function physicsStep(b, from, dt) {
    let speed = Math.hypot(b.vx, b.vy);

    let decel = ROLL_FRICTION + speed * DRAG_COEF;
    if (inSand(b)) decel *= SAND_MULT;
    const newSpeed = Math.max(0, speed - decel * dt);
    if (speed > 0) {
      const k = newSpeed / speed;
      b.vx *= k;
      b.vy *= k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    for (const s of segments) collideSegment(b, s);
    for (const c of COURSE.bumpers) collideBumper(b, c);

    // Hole: slower than the capture speed for how far off-centre it is and it
    // drops. Otherwise the lip bends its path toward the cup (without adding
    // speed) and it rolls back out on a new line, like a ball riding a rim.
    const hx = COURSE.hole.x - b.x;
    const hy = COURSE.hole.y - b.y;
    const hd = Math.hypot(hx, hy);
    speed = Math.hypot(b.vx, b.vy);
    if (hd < HOLE_R && speed < CAPTURE_SPEED * Math.sqrt(1 - hd / HOLE_R)) return 'sink';
    if (hd < HOLE_R + RIM_WIDTH && hd > 0.01 && speed > 0) {
      b.vx += (hx / hd) * RIM_PULL * dt;
      b.vy += (hy / hd) * RIM_PULL * dt;
      const k = (speed * RIM_DRAG) / Math.hypot(b.vx, b.vy);
      b.vx *= k;
      b.vy *= k;
      if (!b.onRim) {
        b.onRim = true;
        sound.rim();
      }
    } else {
      b.onRim = false;
    }

    if (inWater(b)) return 'water';

    if (outOfBounds(b)) {
      // Safety net: should never happen, but never lose the ball.
      b.x = from.x;
      b.y = from.y;
      b.vx = b.vy = 0;
    }

    if (speed < STOP_SPEED) {
      b.vx = b.vy = 0;
      return 'stop';
    }
    return null;
  }

  // ---------- Rendering ----------
  function tracePoly(poly) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCourse() {
    // Rough
    ctx.fillStyle = '#2f6e36';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = 0; y < H; y += 22) {
      for (let x = (y / 22) % 2 ? 11 : 0; x < W; x += 22) ctx.fillRect(x, y, 3, 3);
    }

    // Wall: stroke wide, then fill the fairway over it so only the outer half shows.
    tracePoly(COURSE.boundary);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 22;
    ctx.strokeStyle = '#6b4423';
    ctx.stroke();
    ctx.lineWidth = 16;
    ctx.strokeStyle = '#a06a3a';
    ctx.stroke();

    // Fairway with mowing stripes
    ctx.save();
    tracePoly(COURSE.boundary);
    ctx.fillStyle = '#5cc04f';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let i = -H; i < W + H; i += 56) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 28, 0);
      ctx.lineTo(i + 28 + H, H);
      ctx.lineTo(i + H, H);
      ctx.closePath();
      ctx.fill();
    }
    // Inner shadow along the wall
    tracePoly(COURSE.boundary);
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.stroke();
    ctx.restore();

    // Tee mat
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(COURSE.tee.x - 22, COURSE.tee.y - 14, 44, 28, 6);
    ctx.fill();

    // Sand
    for (const s of COURSE.sand) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = '#ecd9a0';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#d2b978';
      ctx.stroke();
      ctx.fillStyle = 'rgba(160,130,70,0.35)';
      for (let i = 0; i < 14; i++) {
        const a = i * 2.4;
        const rr = (s.r - 6) * ((i * 37) % 10) / 10;
        ctx.fillRect(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr, 2, 2);
      }
    }

    // Water
    for (const w of COURSE.water) {
      roundRect(w.x - 3, w.y - 3, w.w + 6, w.h + 6, 14);
      ctx.fillStyle = '#2b7fb3';
      ctx.fill();
      roundRect(w.x, w.y, w.w, w.h, 12);
      ctx.fillStyle = '#4fb3ea';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const y = w.y + 12 + i * 14;
        const off = Math.sin(state.time * 1.5 + i) * 6;
        ctx.beginPath();
        ctx.moveTo(w.x + 10 + off, y);
        ctx.quadraticCurveTo(w.x + 20 + off, y - 4, w.x + 30 + off, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Blocks
    for (const poly of COURSE.blocks) {
      ctx.save();
      ctx.translate(0, 3);
      tracePoly(poly);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();
      ctx.restore();
      tracePoly(poly);
      ctx.fillStyle = '#a06a3a';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#6b4423';
      ctx.stroke();
    }

    // Bumpers
    for (const c of COURSE.bumpers) {
      ctx.beginPath();
      ctx.arc(c.x, c.y + 3, c.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fillStyle = '#f2c94c';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#c99a1a';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x - c.r * 0.3, c.y - c.r * 0.3, c.r * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fill();
    }

    // Hole
    const h = COURSE.hole;
    ctx.beginPath();
    ctx.arc(h.x, h.y, HOLE_R + 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(h.x, h.y, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#14281a';
    ctx.fill();
  }

  function drawFlag() {
    const h = COURSE.hole;
    const b = current().ball;
    // Fade the flag when a ball is near so it doesn't hide the putt.
    const near = state.phase !== 'menu' && Math.hypot(b.x - h.x, b.y - h.y) < 70;
    ctx.save();
    ctx.globalAlpha = near ? 0.35 : 1;
    ctx.strokeStyle = '#f5f5f5';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(h.x, h.y);
    ctx.lineTo(h.x, h.y - 52);
    ctx.stroke();
    const wave = Math.sin(state.time * 4) * 3;
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath();
    ctx.moveTo(h.x, h.y - 52);
    ctx.quadraticCurveTo(h.x + 14, h.y - 48 + wave, h.x + 28, h.y - 44);
    ctx.quadraticCurveTo(h.x + 14, h.y - 38 - wave, h.x, h.y - 34);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawBall(x, y, color, alpha, radius = BALL_R) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.ellipse(x + 2, y + 3, radius, radius * 0.8, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = radius * 0.45;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x - radius * 0.3, y - radius * 0.3, radius * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.restore();
  }

  function drawAim() {
    if (!state.aim) return;
    const b = current().ball;
    const { power, dirX, dirY } = aimVector();
    if (power < MIN_POWER) return;

    // Pull-back band behind the ball
    const pull = power * 50;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - dirX * pull, b.y - dirY * pull);
    ctx.stroke();

    // Dotted aim line, green -> yellow -> red with power
    const hue = 120 - power * 120;
    const color = `hsl(${hue}, 90%, 55%)`;
    const len = 40 + power * 170;
    ctx.fillStyle = color;
    for (let d = BALL_R + 8; d < len; d += 12) {
      const r = 3.2 * (1 - (d / len) * 0.5);
      ctx.beginPath();
      ctx.arc(b.x + dirX * d, b.y + dirY * d, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Arrow head
    const tx = b.x + dirX * len;
    const ty = b.y + dirY * len;
    ctx.beginPath();
    ctx.moveTo(tx + dirX * 10, ty + dirY * 10);
    ctx.lineTo(tx - dirY * 7, ty + dirX * 7);
    ctx.lineTo(tx + dirY * 7, ty - dirX * 7);
    ctx.closePath();
    ctx.fill();

    // Power ring around the ball
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R + 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R + 9, -Math.PI / 2, -Math.PI / 2 + power * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawIdleHint() {
    // Gentle pulse around the active ball so it's obvious whose turn it is.
    const b = current().ball;
    const t = (state.time * 1.2) % 1;
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.8;
    ctx.strokeStyle = COLORS[state.turn];
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R + 4 + t * 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }


  function drawAnim() {
    const a = state.anim;
    if (a.kind === 'sink') {
      const t = Math.min(a.t / 0.35, 1);
      const h = COURSE.hole;
      const x = a.x + (h.x - a.x) * t;
      const y = a.y + (h.y - a.y) * t;
      drawBall(x, y, COLORS[a.player], 1 - t * 0.6, BALL_R * (1 - t * 0.5));
      return;
    }
    const t = a.t / 0.8;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, 1 - t)})`;
    ctx.lineWidth = 3;
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4 + (t + i * 0.3) * 22, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function render() {
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    drawCourse();

    if (state.phase === 'menu') {
      drawFlag();
      return;
    }

    // The ball in focus is the one moving / animating, otherwise whoever's up.
    const focus = state.roll ? state.roll.player : state.anim ? state.anim.player : state.turn;

    // Other balls are ghosts (balls don't collide with each other).
    state.players.forEach((p, i) => {
      if (i === focus || p.done) return;
      drawBall(p.ball.x, p.ball.y, COLORS[i], 0.45);
    });

    if (state.roll) {
      drawBall(state.roll.ball.x, state.roll.ball.y, COLORS[focus], 1);
    } else if (state.anim) {
      drawAnim();
    } else if (!state.players[focus].done) {
      const b = state.players[focus].ball;
      const myShot = state.phase === 'aim';
      if (myShot && !state.aim) drawIdleHint();
      drawBall(b.x, b.y, COLORS[focus], myShot || state.phase === 'over' ? 1 : 0.75);
      if (myShot) drawAim();
    }

    drawFlag();
  }

  // ---------- Main loop ----------
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    state.time += dt;

    if (state.phase === 'rolling' && state.roll) {
      acc += dt;
      while (acc >= STEP && state.roll) {
        const r = state.roll;
        const ev = physicsStep(r.ball, r.from, STEP);
        acc -= STEP;
        if (ev) r.onEvent(ev);
      }
      if (state.phase !== 'rolling') acc = 0;
    } else if (state.phase === 'anim' && state.anim) {
      const a = state.anim;
      a.t += dt;
      if (a.t > (a.kind === 'sink' ? 0.6 : 0.9)) {
        state.anim = null;
        a.onDone();
      }
    }

    render();
    requestAnimationFrame(frame);
  }

  // ---------- Sound (tiny WebAudio synth, no assets) ----------
  const sound = (() => {
    let ac = null;
    function unlock() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
      }
      if (ac.state === 'suspended') ac.resume();
    }
    function tone(freq, dur, type, vol, slideTo) {
      if (!ac) return;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + dur);
    }
    function noise(dur, vol, freq) {
      if (!ac) return;
      const t = ac.currentTime;
      const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = freq;
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(ac.destination);
      src.start(t);
    }
    return {
      unlock,
      hit: (p) => { tone(900, 0.06, 'triangle', 0.25 + p * 0.3, 500); noise(0.04, 0.2, 3000); },
      wall: (p) => tone(320, 0.05, 'square', 0.04 + p * 0.12, 200),
      rim: () => tone(1400, 0.07, 'triangle', 0.12, 900),
      sink: () => { tone(500, 0.12, 'sine', 0.35, 250); setTimeout(() => tone(700, 0.18, 'sine', 0.3, 1000), 140); },
      splash: () => noise(0.5, 0.35, 900),
    };
  })();


  // ---------- Boot ----------
  loadNames();
  setMenuMode('link');
  resize();
  updateHud();
  if (!loadFromHash()) showMenu();
  requestAnimationFrame(frame);
})();
