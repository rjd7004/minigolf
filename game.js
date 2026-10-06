(() => {
  'use strict';

  const Gen = window.MiniGolfCourse;

  // ---------- Tuning ----------
  // Holes are laid out in a fixed 400x700 "world" and scaled to fit the screen.
  const W = Gen.W;
  const H = Gen.H;
  const BALL_R = Gen.BALL_R;
  const HOLE_R = Gen.HOLE_R;
  const HOLES = Gen.HOLES;
  const MAX_SPEED = 950;      // world units / second at full power
  const MAX_DRAG = 150;       // drag distance (world units) for full power
  const MIN_POWER = 0.05;     // shorter drags are treated as a cancel
  // Rolling resistance: a speed-squared term bleeds off hard shots quickly, a
  // speed-proportional term gives the long gentle roll-out, and a small constant
  // term makes sure the ball does finally stop.
  const ROLL_FRICTION = 20;
  const DRAG_COEF = 0.9;      // per second
  const DRAG_QUAD = 0.001;    // per world unit
  const SAND_MULT = 5;
  const STOP_SPEED = 4;
  const SLOPE_SETTLE = 0.3;   // on a slope, the ball must stay this slow this long to count as stopped
  // The cup: while the ball's centre is over it, the slope pulls the ball toward
  // the middle. Fast balls get bent around the rim and roll on; slow ones drop.
  const CAPTURE_SPEED = 290;  // max speed that drops when dead-centre; less toward the edge
  const CAPTURE_EDGE = 0.15;  // share of CAPTURE_SPEED that still drops right at the edge
  const RIM_PULL = 4200;      // how hard the lip bends the ball's path toward the cup centre
  const RIM_TURN = 5;         // max turn rate (radians / second) for slow balls
  const RIM_WIDTH = 0;        // the lip starts this far outside the cup edge
  // Cup "magnet": a slow ball whose edge is over the cup gets drawn in, so a
  // ball never comes to rest sitting on top of the hole.
  const MAGNET_R = HOLE_R + 7;  // reach, measured to the ball's centre
  const MAGNET_SPEED = 70;      // only balls slower than this feel it
  const MAGNET_PULL = 700;      // acceleration toward the cup centre
  const RIM_DRAG = 0.997;     // speed kept per physics step while riding the rim
  const SINK_TIME = 0.45;     // seconds for the ball to drop out of sight
  const RESTITUTION = 0.75;
  const SLOPE_BOUNCE = 0.3;   // wall bounce when a slope is pushing the ball into that wall
  // Bumpers fire the ball back out, adding speed like a pinball bumper.
  const BUMPER_RESTITUTION = 0.95;
  const BUMPER_KICK = 380;    // extra speed added away from the bumper on every hit
  const MAX_SHOTS_SENT = 24;  // shots carried in a link for the other phone to replay
  const STEP = 1 / 240;       // fixed physics step (small enough to avoid tunnelling)
  const SPINNER_RESTITUTION = 0.6;
  const SPINNER_HUB = Gen.SPINNER_HUB;
  const SPINNER_SPOKE = Gen.SPINNER_SPOKE;

  const COLORS = ['#ff5a5f', '#3b82f6'];

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
  const boardPanel = $('board');
  const cards = [...document.querySelectorAll('.player-card')];
  const nameInputs = [$('name0'), $('name1')];

  // ---------- State ----------
  const state = {
    mode: 'link',   // link: each player on their own phone, turns sent as links | local: pass & play
    phase: 'menu',  // menu | join | aim | rolling | anim | share | over
    id: '',         // game id (link mode)
    seq: 0,         // bumps on every committed change so stale links can be detected
    me: 0,          // which player this device is (link mode)
    seed: 0,        // the 5 holes are generated from this
    holes: [],      // generated holes for this round
    hole: 0,        // index of the hole being played
    view: 0,        // index of the hole on screen (differs while replaying an earlier hole)
    holeStarter: 0, // who teed off the current hole (keeps the honour on a tied hole)
    players: [makePlayer('Player 1'), makePlayer('Player 2')],
    turn: 0,
    starter: 0,     // who teed off hole 1 (alternates on rematch)
    replayQueue: [], // the other player's shots waiting to be replayed here
    shots: [],      // my shots since the turn came to me (link mode): [{ p, h, x, y, a, w }]
    introPending: false, // show the "Hole N · Par P" banner before the next turn
    roll: null,     // { ball, from, player, onEvent } while a ball is moving
    anim: null,     // { kind: 'sink' | 'splash', t, x, y, player, onDone }
    aim: null,      // { sx, sy, cx, cy } in world coords while dragging
    time: 0,
    spinT: 0,       // spinner clock (seconds); each shot records it so replays line up
  };

  function makePlayer(name) {
    return { name, scores: [], strokes: 0, done: false, ball: { x: 0, y: 0, vx: 0, vy: 0 } };
  }

  function course() {
    return state.holes[state.view];
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

  function total(p) {
    return p.scores.reduce((a, b) => a + b, 0) + (p.scores.length > state.hole ? 0 : p.strokes);
  }

  function roundOver() {
    return state.players.every((p) => p.scores.length === HOLES);
  }

  function toTee(p) {
    const t = state.holes[state.hole].tee;
    p.ball.x = t.x;
    p.ball.y = t.y;
    p.ball.vx = p.ball.vy = 0;
  }

  let roundCache = { seed: null, holes: null };
  function holesFor(seed) {
    if (roundCache.seed !== seed) roundCache = { seed, holes: Gen.generateRound(seed) };
    return roundCache.holes;
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
  function newGame(mode, names, starter, me, rematchOf) {
    state.mode = mode;
    state.id = randomId(); // also keys the leaderboard, so a game is only counted once
    state.seq = 0;
    state.me = me;
    state.seed = randomSeed();
    state.holes = holesFor(state.seed);
    state.hole = state.view = 0;
    state.players = names.map(makePlayer);
    state.players.forEach(toTee);
    state.turn = state.starter = state.holeStarter = starter;
    state.shots = [];
    state.introPending = true;
    state.roll = state.anim = state.aim = null;
    hideOverlays();
    syncFailed = false;
    if (isLink()) {
      commit(rematchOf ? { from: rematchOf } : undefined);
      attachPush();
    } else {
      history.replaceState(null, '', baseUrl());
    }
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
    const oldId = state.id;
    const wasOnline = online();
    newGame(state.mode, names, 1 - state.starter, state.me, wasOnline ? oldId : null);
    // Point the old game at the new one so your friend's app can follow you there.
    if (wasOnline) api(`/api/game/${oldId}/next`, { method: 'POST', body: JSON.stringify({ next: state.id }) });
  }

  function randomId() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
  }

  function randomSeed() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0];
  }

  // ---------- Turn flow ----------
  function shoot(power, angle) {
    const p = current();
    // Quantise so the replay on the other phone runs exactly the same numbers.
    power = Math.round(power * 1e4) / 1e4;
    angle = Math.round(angle * 1e4) / 1e4;
    p.strokes++;
    const from = { x: p.ball.x, y: p.ball.y };
    // Spinners are where the clock says; the replay restarts the clock from here.
    state.spinT = Math.round((state.spinT % 3600) * 1000) / 1000;
    if (isLink()) {
      state.shots.push({ p: state.turn, h: state.hole, x: from.x, y: from.y, a: angle, w: power, t: state.spinT });
      if (state.shots.length > MAX_SHOTS_SENT) state.shots.shift();
    }
    launch(p.ball, from, power, angle);
    state.roll = { ball: p.ball, from, player: state.turn, onEvent: resolveShot };
    state.phase = 'rolling';
    updateHud();
    sound.hit(power);
  }

  function launch(ball, from, power, angle) {
    ball.onRim = false;
    ball.slowT = 0;
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
    if (state.players.every((q) => q.done)) {
      finishHole();
    } else {
      const other = 1 - state.turn;
      if (!state.players[other].done) state.turn = other;
    }
    if (isLink()) commit();
    routeTurn();
  }

  // Both players are in: record the hole and set up the next one.
  function finishHole() {
    const [a, b] = state.players;
    state.players.forEach((p) => p.scores.push(p.strokes));
    if (state.hole === HOLES - 1) return; // round over
    // Honours: whoever won the hole tees off next; a tie keeps the same order.
    if (a.strokes !== b.strokes) state.holeStarter = a.strokes < b.strokes ? 0 : 1;
    state.hole++;
    state.view = state.hole;
    state.players.forEach((p) => {
      p.strokes = 0;
      p.done = false;
      toTee(p);
    });
    state.turn = state.holeStarter;
    state.introPending = true;
  }

  // Decide what happens next: game over, my shot, or hand the turn to my friend.
  function routeTurn() {
    state.view = state.hole;
    updateHud();
    if (roundOver()) {
      state.phase = 'over';
      setTimeout(showResults, 900);
      return;
    }
    if (!isLink() || state.turn === state.me) {
      state.phase = 'aim';
      const i = state.turn;
      const text = isLink() ? 'Your turn' : `${nameOf(i)}'s turn`;
      let wait = Math.max(250, bannerEnd - performance.now());
      if (state.introPending) {
        state.introPending = false;
        const c = course();
        setTimeout(() => showBanner(`Hole ${state.hole + 1} · Par ${c.par}`, '#1d2a1f', 1400), wait);
        wait += 1500;
      }
      setTimeout(() => {
        if (state.phase === 'aim' && state.turn === i) showBanner(text, COLORS[i]);
      }, wait);
      return;
    }
    state.introPending = false;
    state.phase = 'share';
    setTimeout(() => {
      if (state.phase !== 'share') return;
      // Online, once your friend has joined, the turn goes to them by itself.
      if (online() && state.players[1].name && !syncFailed) showWaitBar();
      else showShare();
    }, 700);
  }

  function startAnim(kind, ball, player, onDone) {
    state.anim = { kind, t: 0, x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, player, onDone };
    state.phase = 'anim';
  }

  function scoreName(strokes) {
    if (strokes === 1) return 'Hole in one!';
    const names = { '-3': 'Albatross!', '-2': 'Eagle!', '-1': 'Birdie!', '0': 'Par', '1': 'Bogey', '2': 'Double bogey' };
    return names[strokes - course().par] || `${strokes} strokes`;
  }

  // ---------- Panels ----------
  function hideOverlays() {
    [menu, results, sharePanel, joinPanel, boardPanel].forEach((el) => el.classList.add('hidden'));
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
      ? 'Two players, one phone. Pass it back and forth. 5 new holes every round.'
      : (SERVER
        ? 'Text your friend a link once. After that, turns go back and forth by themselves, with a notification when it\'s your turn. 5 new holes every round.'
        : 'You take a shot, then text your friend a link. They play their shot on their phone and send one back. 5 new holes every round.');
  }

  function relPar(n) {
    return n === 0 ? 'E' : (n > 0 ? `+${n}` : `${n}`);
  }

  function showResults() {
    hideOverlays();
    const totals = state.players.map(total);
    const winner = totals[0] === totals[1] ? -1 : (totals[0] < totals[1] ? 0 : 1);
    recordResult(winner);
    let title = winner < 0 ? "It's a tie!" : `${nameOf(winner)} wins!`;
    if (isLink() && winner >= 0) title = winner === state.me ? 'You win!' : `${nameOf(winner)} wins!`;
    $('result-title').textContent = title;
    const parTotal = state.holes.reduce((a, h) => a + h.par, 0);

    // Scorecard: one column per hole, then the total.
    const table = document.createElement('table');
    table.className = 'scorecard';
    const head = table.insertRow();
    head.insertCell().textContent = '';
    state.holes.forEach((h, i) => { head.insertCell().textContent = i + 1; });
    head.insertCell().textContent = 'Tot';
    const parRow = table.insertRow();
    parRow.className = 'par';
    parRow.insertCell().textContent = 'Par';
    state.holes.forEach((h) => { parRow.insertCell().textContent = h.par; });
    parRow.insertCell().textContent = parTotal;
    state.players.forEach((p, i) => {
      const row = table.insertRow();
      row.className = `p${i}` + (i === winner ? ' winner' : '');
      const name = row.insertCell();
      name.innerHTML = '<span class="dot"></span><span class="name"></span>';
      name.querySelector('.name').textContent = nameOf(i);
      p.scores.forEach((s, h) => {
        const cell = row.insertCell();
        cell.textContent = s;
        const rel = s - state.holes[h].par;
        if (rel < 0) cell.className = 'under';
        else if (rel > 0) cell.className = 'over';
      });
      const tot = row.insertCell();
      tot.className = 'tot';
      tot.innerHTML = `${totals[i]}<small>${relPar(totals[i] - parTotal)}</small>`;
    });
    const rows = $('result-rows');
    rows.innerHTML = '';
    rows.appendChild(table);

    const send = $('send-result-btn');
    send.classList.toggle('hidden', !isLink());
    send.textContent = `Send result to ${nameOf(1 - state.me)}`;
    $('again-btn').textContent = isLink() ? 'Rematch' : 'Play again';
    $('again-btn').classList.toggle('secondary', isLink());
    $('menu-btn').textContent = isLink() ? 'New game' : 'Change players';
    const board = loadBoard();
    $('result-wins').textContent = 'All-time wins: ' + state.players
      .map((p, i) => { const e = board.people[personKey(nameOf(i))]; return `${nameOf(i)} ${e ? e.wins : 0}`; })
      .join(' · ');
    results.classList.remove('hidden');
  }

  // ---------- Leaderboard ----------
  // Every name is its own person (capitals and spaces don't matter). Results
  // are kept on this phone; each game is counted once, by its id.
  function personKey(name) {
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function loadBoard() {
    try {
      const b = JSON.parse(localStorage.getItem('minigolf-board') || 'null');
      if (b && b.people && Array.isArray(b.counted)) return b;
    } catch (e) { /* fall through */ }
    return { people: {}, counted: [] };
  }

  function saveBoard(b) {
    try {
      b.counted = b.counted.slice(-500);
      localStorage.setItem('minigolf-board', JSON.stringify(b));
    } catch (e) { /* ignore */ }
  }

  function recordResult(winner) {
    if (!state.id) return;
    const b = loadBoard();
    if (b.counted.includes(state.id)) return;
    b.counted.push(state.id);
    state.players.forEach((p, i) => {
      const name = nameOf(i).trim();
      const key = personKey(name);
      if (!key) return;
      const e = b.people[key] || (b.people[key] = { name, wins: 0, played: 0, ties: 0 });
      e.name = name; // keep the most recent spelling
      e.played++;
      if (winner === i) e.wins++;
      if (winner < 0) e.ties++;
    });
    saveBoard(b);
  }

  let boardReturn = null;
  function showBoard(from) {
    boardReturn = from;
    [menu, results].forEach((el) => el.classList.add('hidden'));
    const b = loadBoard();
    const people = Object.values(b.people).sort((x, y) =>
      y.wins - x.wins || (y.wins / y.played) - (x.wins / x.played) || y.played - x.played || x.name.localeCompare(y.name));
    const list = $('board-rows');
    list.innerHTML = '';
    if (!people.length) {
      list.innerHTML = '<p class="sub">No finished games yet. Play a round!</p>';
    } else {
      const table = document.createElement('table');
      table.className = 'scorecard board';
      const head = table.insertRow();
      ['', 'Wins', 'Played', 'Win %'].forEach((t) => { head.insertCell().textContent = t; });
      people.forEach((e, i) => {
        const row = table.insertRow();
        const name = row.insertCell();
        name.innerHTML = '<span class="rank"></span><span class="name"></span>';
        name.querySelector('.rank').textContent = i + 1;
        name.querySelector('.name').textContent = e.name;
        row.insertCell().textContent = e.wins;
        row.insertCell().textContent = e.played;
        row.insertCell().textContent = `${Math.round((100 * e.wins) / e.played)}%`;
        if (i === 0 && e.wins > 0) row.className = 'winner';
      });
      list.appendChild(table);
    }
    boardPanel.classList.remove('hidden');
  }

  function closeBoard() {
    boardPanel.classList.add('hidden');
    (boardReturn === 'results' ? results : menu).classList.remove('hidden');
  }

  function resetBoard() {
    if (!window.confirm('Clear the leaderboard on this phone?')) return;
    const b = loadBoard();
    b.people = {}; // keep the counted ids so old result links aren't re-counted
    saveBoard(b);
    showBoard(boardReturn);
  }

  function showShare() {
    hideOverlays();
    const joined = !!state.players[1].name;
    const friend = joined ? nameOf(state.turn) : 'your friend';
    $('share-title').textContent = joined ? `${friend}'s turn` : 'Challenge a friend';
    $('share-text').textContent = state.shots.length
      ? `Send ${friend} the link. They'll watch your shot${state.shots.length > 1 ? 's' : ''}, then take theirs.`
      : `Send ${friend} the link so they can tee off.`;
    if (online() && !joined) {
      $('share-text').textContent = `Send your friend the link to join. After that, turns go back and forth by themselves${pushSupported() || isIos() ? ' and you each get a notification when it\'s your turn' : ''}.`;
    } else if (online() && syncFailed) {
      $('share-text').textContent = `Couldn't reach the game server. Send ${friend} the link instead.`;
    }
    $('share-btn').textContent = joined ? `Send to ${friend}` : 'Send link';
    $('copy-btn').textContent = 'Copy link';
    refreshNotifyUi();
    sharePanel.classList.remove('hidden');
  }

  function showWaitBar() {
    hideOverlays();
    const friend = state.players[1].name ? nameOf(state.turn) : 'your friend';
    $('wait-text').textContent = `Waiting for ${friend}…`;
    $('resend-btn').textContent = online() ? 'Link' : 'Send link';
    refreshNotifyUi();
    waitBar.classList.remove('hidden');
  }

  function showJoin() {
    hideOverlays();
    const host = nameOf(0);
    $('join-title').textContent = `${host} challenged you!`;
    $('join-text').textContent = state.replayQueue && state.replayQueue.length
      ? `5 holes. Enter your name, watch ${host}'s first shot, then take yours.`
      : '5 holes. Enter your name to tee off.';
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
    attachPush();
    hideOverlays();
    playReplaysThenRoute();
  }

  function updateHud() {
    const inGame = state.phase !== 'menu';
    state.players.forEach((p, i) => {
      const card = cards[i];
      let name = nameOf(i);
      if (isLink() && inGame && i === state.me) name += ' (you)';
      card.querySelector('.name').textContent = name;
      // While an earlier hole is being replayed, the live numbers would spoil it.
      const showing = state.view === state.hole;
      card.querySelector('.strokes').textContent = inGame && showing ? p.strokes : (inGame ? '–' : 0);
      card.querySelector('.total').textContent = inGame ? `Total ${total(p)}` : '';
      const active = inGame && state.phase !== 'over' && showing && i === state.turn && !p.done;
      card.classList.toggle('active', active);
      card.classList.toggle('done', inGame && showing && p.done);
    });
    const c = course();
    $('hole-label').textContent = inGame ? `Hole ${state.view + 1}/${HOLES}` : `${HOLES} holes`;
    $('par-label').textContent = inGame && c ? `Par ${c.par}` : 'Mini Golf';
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
  // The 5 holes aren't in the link: both phones rebuild them from the seed.
  // Each phone also remembers the newest state it has seen per game, so
  // reopening an old link can't be used to retake a shot.

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
    return b64urlEncode(JSON.stringify({
      v: 3,
      i: state.id,
      s: state.seq,
      k: state.seed,
      h: state.hole,
      o: state.holeStarter,
      t: state.turn,
      f: state.starter,
      p: state.players.map((p) => [p.name, p.scores, p.strokes, p.done ? 1 : 0, p.ball.x, p.ball.y]),
      l: state.shots.map((s) => [s.p, s.h, s.x, s.y, s.a, s.w, s.t]),
    }));
  }

  // Returns the decoded game, null if it's garbage, or 'old' for a v1 (single hole) link.
  function decodeGame(code) {
    try {
      const o = JSON.parse(b64urlDecode(code));
      if (o && (o.v === 1 || o.v === 2)) return 'old'; // holes were built differently before spinners
      const num = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
      const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
      const bit = (n) => n === 0 || n === 1;
      if (o.v !== 3 || typeof o.i !== 'string' || !/^[a-z0-9]{1,16}$/.test(o.i)) return null;
      if (!int(o.s, 0, 1e6) || !int(o.k, 0, 4294967295) || !int(o.h, 0, HOLES - 1)) return null;
      if (!bit(o.o) || !bit(o.t) || !bit(o.f)) return null;
      if (!Array.isArray(o.p) || o.p.length !== 2) return null;
      const holes = holesFor(o.k);
      const players = o.p.map((a) => {
        if (!Array.isArray(a) || typeof a[0] !== 'string' || !Array.isArray(a[1])) return null;
        const scores = a[1];
        const n = scores.length;
        if (!(n === o.h || (o.h === HOLES - 1 && n === HOLES)) || !scores.every((s) => int(s, 1, 9999))) return null;
        if (!int(a[2], 0, 9999)) return null;
        const p = makePlayer(a[0].slice(0, 12));
        p.scores = scores;
        p.strokes = a[2];
        p.done = !!a[3];
        const c = holes[o.h];
        if (num(a[4], 0, W) && num(a[5], 0, H) && Gen.inFairway(c, a[4], a[5])) {
          p.ball.x = a[4];
          p.ball.y = a[5];
        } else {
          p.ball.x = c.tee.x;
          p.ball.y = c.tee.y;
        }
        return p;
      });
      if (players.includes(null)) return null;
      const shots = [];
      if (Array.isArray(o.l)) {
        for (const s of o.l.slice(-MAX_SHOTS_SENT)) {
          if (!Array.isArray(s)) continue;
          const [p, h, x, y, a, w, t] = s;
          if (bit(p) && int(h, 0, o.h) && num(x, 0, W) && num(y, 0, H) && num(a, -10, 10) && num(w, 0, 1) && num(t, 0, 3600)) {
            shots.push({ p, h, x, y, a, w, t });
          }
        }
      }
      return { id: o.i, seq: o.s, seed: o.k, hole: o.h, holeStarter: o.o, turn: o.t, starter: o.f, players, shots };
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
  function commit(extra) {
    state.seq++;
    remember();
    setUrl();
    currentCode = encodeGame();
    syncUp(extra);
  }

  function baseUrl() {
    return location.href.split(/[?#]/)[0];
  }

  // The link you send to invite someone (the whole game is in it).
  function gameUrl() {
    return `${baseUrl()}#g=${encodeGame()}`;
  }

  // What's shown in the address bar. Online games use ?game=<id>&p=<me> so a
  // Home Screen icon (or a notification tap) can find the game on the server.
  function setUrl() {
    if (!isLink()) return;
    history.replaceState(null, '', online() ? `${baseUrl()}?game=${state.id}&p=${state.me}` : gameUrl());
  }

  function shareMessage() {
    const [a, b] = state.players;
    const score = `${nameOf(0)} ${total(a)} · ${nameOf(1)} ${total(b)}`;
    if (roundOver()) {
      if (total(a) === total(b)) return `We tied at mini golf! ⛳ ${score}`;
      return `${nameOf(total(a) < total(b) ? 0 : 1)} wins at mini golf! ⛳ ${score}`;
    }
    if (!state.players[1].name) return `${nameOf(0)} challenged you to 5 holes of mini golf ⛳ Your turn!`;
    return `Your turn at mini golf ⛳ Hole ${state.hole + 1}/${HOLES} · ${score}`;
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
    const g = decodeGame(m[1]);
    if (!g || g === 'old') {
      showMenu();
      showBanner(g === 'old' ? 'That link is from an older version. Start a new game!' : "Couldn't read that game link", '#c0392b', 3000);
      return false;
    }
    applyGame(g);
    // The server may already be further along than this link.
    if (online()) poll(true);
    return true;
  }

  // Take over a game state (from a link, or from the server) and carry on from it.
  function applyGame(g, meHint) {
    const store = loadStore();
    const saved = store[g.id];
    let newer = false;
    if (saved && saved.seq > g.seq) {
      // This phone has already moved past this state (e.g. you reopened a link you already played).
      const g2 = decodeGame(saved.code);
      if (g2 && g2 !== 'old') { g = g2; newer = true; }
    }
    const seenBefore = saved && saved.seq >= g.seq;

    state.mode = 'link';
    state.id = g.id;
    state.seq = g.seq;
    state.seed = g.seed;
    state.holes = holesFor(g.seed);
    state.hole = state.view = g.hole;
    state.holeStarter = g.holeStarter;
    state.turn = g.turn;
    state.starter = g.starter;
    state.players = g.players;
    state.roll = state.anim = state.aim = null;
    if (saved) state.me = saved.me;
    else if (meHint === 0 || meHint === 1) state.me = meHint;
    else state.me = !g.players[1].name ? 1 : g.turn;
    // Shots by the other player get replayed here; my own stay queued for the next link.
    state.shots = g.shots.filter((s) => s.p === state.me);
    state.replayQueue = seenBefore ? [] : g.shots.filter((s) => s.p !== state.me);
    state.introPending = false;
    currentCode = encodeGame();
    if (newer || online()) setUrl();

    hideOverlays();
    updateHud();
    if (state.me === 1 && !state.players[1].name) {
      state.phase = 'join';
      showJoin();
      return;
    }
    remember();
    attachPush();
    playReplaysThenRoute();
  }

  // Show the other player's shots rolling (switching to earlier holes if
  // needed), then carry on from the saved state.
  function playReplaysThenRoute() {
    const queue = state.replayQueue || [];
    state.replayQueue = [];
    // If any of the shots were on an earlier hole, announce the new hole afterwards.
    const crossed = queue.some((s) => s.h !== state.hole);
    const next = () => {
      const shot = queue.shift();
      if (!shot) {
        state.view = state.hole;
        state.anim = null;
        if (crossed) state.introPending = true;
        routeTurn();
        return;
      }
      replayShot(shot, next);
    };
    next();
  }

  function replayShot(shot, onDone) {
    const changedHole = state.view !== shot.h;
    state.view = shot.h;
    updateHud();
    // Park the ball at the shot's start (input stays blocked) while the banner shows.
    const ball = { x: shot.x, y: shot.y, vx: 0, vy: 0 };
    const from = { x: shot.x, y: shot.y };
    state.phase = 'anim';
    state.anim = null;
    state.roll = {
      ball,
      from,
      player: shot.p,
      onEvent: (ev) => {
        state.roll = null;
        const done = () => { state.anim = null; onDone(); };
        if (ev === 'sink') {
          sound.sink();
          showBanner(`${nameOf(shot.p)} holed out!`, COLORS[shot.p], 1300);
          startAnim('sink', ball, shot.p, done);
        } else if (ev === 'water') {
          sound.splash();
          showBanner(`${nameOf(shot.p)} splashed! +1`, '#3fa7e0', 1300);
          startAnim('splash', ball, shot.p, done);
        } else {
          setTimeout(done, 350);
        }
      },
    };
    const label = changedHole ? `Hole ${shot.h + 1}: ${nameOf(shot.p)}'s shot` : `${nameOf(shot.p)}'s shot`;
    showBanner(label, COLORS[shot.p], 1000);
    setTimeout(() => {
      if (!state.roll || state.roll.ball !== ball) return; // game changed meanwhile
      state.spinT = shot.t;
      launch(ball, from, shot.w, shot.a);
      sound.hit(shot.w);
      state.phase = 'rolling';
    }, changedHole ? 1100 : 800);
  }

  // ---------- Online sync (optional) ----------
  // With a sync server configured (config.js), link games are stored on the
  // server: each finished turn is uploaded, the waiting phone checks for the
  // other player's move every few seconds while it's open, and the server sends
  // a push notification ("Alex played you back!") when it's your turn and your
  // app isn't open. Without a server, everything works by sending links.
  const SERVER = (window.MINIGOLF_SERVER || '').replace(/\/+$/, '');
  const POLL_MS = 4000;
  let syncFailed = false;

  function online() {
    return isLink() && !!SERVER && !!state.id;
  }

  async function api(path, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(SERVER + path, { ...opts, signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } });
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      return { status: res.status, data };
    } catch (e) {
      return { status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // Upload the current state. If it's now the other player's move, ask the
  // server to notify them (it skips that if their app is open).
  let uploads = Promise.resolve();
  function syncUp(extra) {
    if (!online()) return;
    const id = state.id;
    const body = { code: encodeGame(), seq: state.seq, ...(extra || {}) };
    const other = 1 - state.me;
    if (state.players[1].name) {
      const me = nameOf(state.me);
      let text = null;
      if (roundOver()) text = `${me} finished the round. See who won!`;
      else if (state.turn === other) text = body.from ? `${me} wants a rematch! You're up.` : `${me} played you back!`;
      if (text) body.notify = { to: other, body: text, url: `${baseUrl()}?game=${id}&p=${other}` };
    }
    uploads = uploads.then(async () => {
      const r = await api(`/api/game/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (state.id !== id) return;
      if (r.status === 200) {
        syncFailed = false;
      } else if (r.status === 409 && r.data && r.data.code) {
        // The server is further along than this phone: take its version.
        const g = decodeGame(r.data.code);
        if (g && g !== 'old' && g.id === id && r.data.seq > state.seq) applyGame(g);
      } else {
        syncFailed = true;
        if (state.phase === 'share') showShare(); // fall back to sending the link
      }
    });
  }

  // While waiting (or on the results screen, for rematches), check the server
  // for the other player's move. These checks also tell the server this app is
  // open, so it doesn't send a notification you'd see on top of the game.
  let polling = false;
  async function poll(force) {
    if (!online() || polling || document.visibilityState !== 'visible') return;
    if (!force && state.phase !== 'share' && state.phase !== 'over') return;
    polling = true;
    const id = state.id;
    const r = await api(`/api/game/${id}?p=${state.me}`);
    polling = false;
    if (state.id !== id) return;
    if (r.status === 200 && r.data) {
      if (r.data.seq > state.seq) {
        const g = decodeGame(r.data.code);
        if (g && g !== 'old' && g.id === id) applyGame(g);
      } else if (r.data.next && state.phase === 'over') {
        followRematch(r.data.next);
      }
    } else if (r.status === 404 && state.seq > 0) {
      syncUp(); // the server never got this game (e.g. it was offline): send it now
    }
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

  async function followRematch(nextId) {
    const r = await api(`/api/game/${nextId}?p=${state.me}`);
    if (r.status !== 200 || !r.data) return;
    const g = decodeGame(r.data.code);
    if (!g || g === 'old' || g.id !== nextId) return;
    const who = nameOf(1 - state.me);
    applyGame(g, state.me);
    showBanner(`${who} started a rematch!`, COLORS[1 - state.me], 1500);
  }

  // Open ?game=<id>&p=<me> (from a notification tap or the Home Screen icon).
  async function loadFromServer(id, p) {
    showBanner('Loading game…', '#1d2a1f', 8000);
    const r = await api(`/api/game/${id}?p=${p}`);
    banner.classList.remove('show');
    const g = r.status === 200 && r.data ? decodeGame(r.data.code) : null;
    if (!g || g === 'old' || g.id !== id) {
      showMenu();
      showBanner(g === 'old' ? 'That game is from an older version. Start a new game!' : "Couldn't load that game", '#c0392b', 3000);
      return;
    }
    applyGame(g, p === '0' ? 0 : p === '1' ? 1 : undefined);
  }

  // ---------- Push notifications ----------
  let swReg = null;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').then((reg) => { swReg = reg; refreshNotifyUi(); }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'sync') poll(true);
      if (m.type === 'open' && m.url) {
        const id = new URL(m.url).searchParams.get('game');
        if (id && id !== state.id) location.href = m.url;
        else poll(true);
      }
    });
  }

  function pushSupported() {
    return !!SERVER && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function isIos() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function standalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  // Show "Notify me" when notifications are possible but not on yet, or the
  // Home Screen tip on iPhones (where web apps only get notifications from there).
  function refreshNotifyUi() {
    const can = online() && pushSupported() && Notification.permission === 'default';
    const needsInstall = online() && !!SERVER && isIos() && !standalone() && !pushSupported();
    document.querySelectorAll('.notify-btn').forEach((b) => b.classList.toggle('hidden', !can));
    document.querySelectorAll('.install-hint').forEach((h) => h.classList.toggle('hidden', !needsInstall));
  }

  function b64urlToBytes(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      refreshNotifyUi();
      if (perm !== 'granted') {
        showBanner('Notifications are off', '#c0392b', 2000);
        return;
      }
      const reg = swReg || await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const r = await api('/api/vapid');
        if (!r.data || !r.data.publicKey) throw new Error('no key');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(r.data.publicKey) });
      }
      attachedTo = '';
      await attachPush();
      showBanner("You'll get a notification when it's your turn", '#1f8a3a', 2200);
    } catch (e) {
      showBanner("Couldn't turn on notifications", '#c0392b', 2500);
    }
  }

  // Tell this game's server which device to notify for my player.
  let attachedTo = '';
  async function attachPush() {
    refreshNotifyUi();
    if (!online() || !pushSupported() || Notification.permission !== 'granted') return;
    const key = `${state.id}:${state.me}`;
    if (attachedTo === key) return;
    try {
      const reg = swReg || await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (!sub) return;
      const r = await api(`/api/game/${state.id}/subscribe`, { method: 'POST', body: JSON.stringify({ p: state.me, subscription: sub.toJSON() }) });
      if (r.status === 200) attachedTo = key;
    } catch (e) { /* not fatal */ }
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
  $('board-btn').addEventListener('click', () => showBoard('menu'));
  $('result-board-btn').addEventListener('click', () => showBoard('results'));
  $('board-close').addEventListener('click', closeBoard);
  $('board-reset').addEventListener('click', resetBoard);
  $('send-result-btn').addEventListener('click', (e) => sendLink(e.currentTarget));
  $('share-btn').addEventListener('click', (e) => sendLink(e.currentTarget));
  $('copy-btn').addEventListener('click', (e) => copyLink(e.currentTarget));
  $('view-btn').addEventListener('click', showWaitBar);
  $('resend-btn').addEventListener('click', showShare);
  $('join-btn').addEventListener('click', join);
  document.querySelectorAll('.notify-btn').forEach((b) => b.addEventListener('click', enablePush));
  document.querySelectorAll('.install-hint').forEach((h) => h.addEventListener('click', () => {
    showBanner('Tap Share, then "Add to Home Screen"', '#1d2a1f', 3500);
  }));
  $('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('hole-info').addEventListener('click', () => {
    if (state.phase === 'menu') return;
    if (state.phase !== 'over' && !window.confirm('Leave this game and start a new one?')) return;
    showMenu();
  });
  window.addEventListener('hashchange', loadFromHash);


  // ---------- Physics ----------
  function inSand(c, b) {
    return c.sand.some((s) => (b.x - s.x) * (b.x - s.x) + (b.y - s.y) * (b.y - s.y) < s.r * s.r);
  }

  function inWater(c, b) {
    return c.water.some((w) => b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h);
  }

  function outOfBounds(c, b) {
    return !Gen.inFairway(c, b.x, b.y) || c.solids.some((s) => Gen.pointInPolygon(b.x, b.y, s.pts));
  }

  let lastWallSound = 0;
  // Downhill push of the slope the ball is on this step (0,0 if none).
  let slopePush = { x: 0, y: 0 };
  function bounce(b, nx, ny) {
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    // A slope pushing the ball into this wall soaks up most of the bounce,
    // so a ball that runs down a slope settles instead of rocking for ages.
    const e = slopePush.x * nx + slopePush.y * ny < 0 ? SLOPE_BOUNCE : RESTITUTION;
    b.vx -= (1 + e) * vn * nx;
    b.vy -= (1 + e) * vn * ny;
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

  // Bumpers kick the ball back out faster than it came in.
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
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    const out = -vn * BUMPER_RESTITUTION + BUMPER_KICK;
    b.vx += (out - vn) * nx;
    b.vy += (out - vn) * ny;
    c.hitAt = state.time;
    sound.bump();
  }

  function spokeAngle(sp, k) {
    return sp.phase + (sp.rpm * Math.PI / 30) * state.spinT + (k * 2 * Math.PI) / sp.spokes;
  }

  // Spinners: a fixed hub, plus spokes that hit the ball with their own
  // speed, so a spoke sweeping into the ball bats it along.
  function collideSpinner(b, sp) {
    const dx = b.x - sp.x;
    const dy = b.y - sp.y;
    const reach = sp.len + BALL_R + SPINNER_SPOKE;
    if (dx * dx + dy * dy > reach * reach) return;
    const hd = Math.hypot(dx, dy);
    const hubMin = SPINNER_HUB + BALL_R;
    if (hd < hubMin && hd > 0) {
      b.x = sp.x + (dx / hd) * hubMin;
      b.y = sp.y + (dy / hd) * hubMin;
      bounce(b, dx / hd, dy / hd);
    }
    const w = (sp.rpm * Math.PI) / 30; // radians per second
    const min = BALL_R + SPINNER_SPOKE;
    for (let k = 0; k < sp.spokes; k++) {
      const ang = spokeAngle(sp, k);
      const ex = Math.cos(ang) * sp.len;
      const ey = Math.sin(ang) * sp.len;
      const t = Math.max(0, Math.min(1, ((b.x - sp.x) * ex + (b.y - sp.y) * ey) / (sp.len * sp.len)));
      const px = sp.x + ex * t;
      const py = sp.y + ey * t;
      const qx = b.x - px;
      const qy = b.y - py;
      const d = Math.hypot(qx, qy);
      if (d >= min || d === 0) continue;
      const nx = qx / d;
      const ny = qy / d;
      b.x = px + nx * min;
      b.y = py + ny * min;
      const svx = -w * (py - sp.y); // spoke surface velocity at the contact point
      const svy = w * (px - sp.x);
      const vn = (b.vx - svx) * nx + (b.vy - svy) * ny;
      if (vn < 0) {
        b.vx -= (1 + SPINNER_RESTITUTION) * vn * nx;
        b.vy -= (1 + SPINNER_RESTITUTION) * vn * ny;
        sp.hitAt = state.time;
        if (-vn > 40 && state.time - lastWallSound > 0.06) {
          lastWallSound = state.time;
          sound.wall(Math.min(-vn / MAX_SPEED, 1));
        }
      }
    }
  }

  // A ball never rests inside a spinner's sweep: slide it straight out from
  // the hub to just past the spokes. (Spinners always have room around them.)
  function clearOfSpinners(c, b) {
    for (const sp of c.spinners) {
      const dx = b.x - sp.x;
      const dy = b.y - sp.y;
      const d = Math.hypot(dx, dy);
      const need = sp.len + BALL_R + SPINNER_SPOKE + 1;
      if (d >= need) continue;
      const ux = d > 0.01 ? dx / d : 0;
      const uy = d > 0.01 ? dy / d : 1;
      b.x = sp.x + ux * need;
      b.y = sp.y + uy * need;
    }
  }

  // Advance a moving ball by one fixed step. Returns 'sink', 'water', 'stop' or null.
  function physicsStep(b, from, dt) {
    const c = course();
    state.spinT += dt;
    const x0 = b.x;
    const y0 = b.y;

    // Slopes push the ball downhill.
    let onSlope = false;
    slopePush = { x: 0, y: 0 };
    for (const s of c.slopes) {
      if (b.x >= s.x && b.x < s.x + s.w && b.y >= s.y && b.y < s.y + s.h) {
        b.vx += s.dx * s.a * dt;
        b.vy += s.dy * s.a * dt;
        slopePush = { x: s.dx, y: s.dy };
        onSlope = true;
      }
    }

    let speed = Math.hypot(b.vx, b.vy);
    let decel = ROLL_FRICTION + speed * DRAG_COEF + speed * speed * DRAG_QUAD;
    if (inSand(c, b)) decel *= SAND_MULT;
    const newSpeed = Math.max(0, speed - decel * dt);
    if (speed > 0) {
      const k = newSpeed / speed;
      b.vx *= k;
      b.vy *= k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    for (const s of c.segments) collideSegment(b, s);
    for (const bump of c.bumpers) collideBumper(b, bump);
    for (const sp of c.spinners) collideSpinner(b, sp);

    // Hole: slower than the capture speed for how far off-centre it is and it
    // drops. Otherwise the lip bends its path toward the cup (without adding
    // speed) and it rolls back out on a new line, like a ball riding a rim.
    const hx = c.hole.x - b.x;
    const hy = c.hole.y - b.y;
    const hd = Math.hypot(hx, hy);
    speed = Math.hypot(b.vx, b.vy);
    const capture = CAPTURE_SPEED * (CAPTURE_EDGE + (1 - CAPTURE_EDGE) * (1 - hd / HOLE_R));
    if (hd < HOLE_R && speed < capture) return 'sink';
    const magnet = hd < MAGNET_R && hd > 0.01 && speed < MAGNET_SPEED;
    if (magnet) {
      b.vx += (hx / hd) * MAGNET_PULL * dt;
      b.vy += (hy / hd) * MAGNET_PULL * dt;
    }
    if (hd < HOLE_R + RIM_WIDTH && hd > 0.01 && speed > 0) {
      // Turn the velocity toward the cup centre. Fast balls are bent by a fixed
      // pull (so less the faster they go); slow balls are capped at RIM_TURN so
      // the cup can't steer a dribbling ball straight into the middle.
      const turn = Math.min(RIM_TURN, RIM_PULL / speed) * dt;
      const side = Math.sign(b.vx * hy - b.vy * hx); // which way the centre is
      const co = Math.cos(turn * side);
      const si = Math.sin(turn * side);
      const vx = b.vx * co - b.vy * si;
      const vy = b.vx * si + b.vy * co;
      b.vx = vx * RIM_DRAG;
      b.vy = vy * RIM_DRAG;
      if (!b.onRim) {
        b.onRim = true;
        sound.rim();
      }
    } else {
      b.onRim = false;
    }

    if (inWater(c, b)) return 'water';

    if (outOfBounds(c, b)) {
      // Safety net: should never happen, but never lose the ball.
      b.x = from.x;
      b.y = from.y;
      b.vx = b.vy = 0;
    }

    // Judge "stopped" by how far the ball really moved too: a ball wedged in a
    // corner with a slope pushing it in keeps a little velocity but goes nowhere.
    const moved = Math.hypot(b.x - x0, b.y - y0) / dt;
    if (Math.min(speed, moved) < STOP_SPEED && !magnet) {
      // On a slope the ball only counts as stopped once it's settled (e.g.
      // against a wall), not at the top of its roll back down.
      b.slowT = (b.slowT || 0) + dt;
      if (!onSlope || b.slowT > SLOPE_SETTLE) {
        b.vx = b.vy = 0;
        clearOfSpinners(c, b);
        return inWater(c, b) ? 'water' : 'stop';
      }
    } else {
      b.slowT = 0;
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


  function strokeSegments(segs) {
    ctx.beginPath();
    for (const s of segs) {
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
    }
    ctx.stroke();
  }

  function traceCells(cells) {
    ctx.beginPath();
    // Overlap cells by a hair so there are no seams between them.
    for (const r of cells) ctx.rect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
  }

  // A slope: shaded light (high side) to dark (low side), with chevrons that
  // point downhill and drift slowly that way.
  function drawSlope(s) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.w, s.h);
    ctx.clip();
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const half = Math.abs(s.dx) ? s.w / 2 : s.h / 2;
    const g = ctx.createLinearGradient(cx - s.dx * half, cy - s.dy * half, cx + s.dx * half, cy + s.dy * half);
    const k = (s.a - 150) / 150; // steeper slopes are shaded harder
    g.addColorStop(0, `rgba(255,255,255,${0.22 + 0.1 * k})`);
    g.addColorStop(1, `rgba(0,40,10,${0.34 + 0.14 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(s.x, s.y, s.w, s.h);

    // Chevrons, pointing downhill.
    const along = Math.abs(s.dx) ? s.w : s.h;
    const gap = 26;
    const drift = (state.time * s.a * 0.12) % gap;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const px = -s.dy;
    const py = s.dx;
    for (let d = -along / 2 - gap + drift; d < along / 2 + gap; d += gap) {
      for (const off of [-16, 16]) {
        const tipX = cx + s.dx * (d + 5) + px * off;
        const tipY = cy + s.dy * (d + 5) + py * off;
        ctx.beginPath();
        ctx.moveTo(tipX - s.dx * 8 + px * 9, tipY - s.dy * 8 + py * 9);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(tipX - s.dx * 8 - px * 9, tipY - s.dy * 8 - py * 9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawBumper(b) {
    const since = b.hitAt === undefined ? 1 : state.time - b.hitAt;
    const pop = since < 0.15 ? 1 + 0.18 * (1 - since / 0.15) : 1;
    const r = b.r * pop;
    ctx.beginPath();
    ctx.arc(b.x, b.y + 3, b.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = since < 0.15 ? '#fff3a6' : '#f5cd2f';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#c99a1a';
    ctx.stroke();
    // Little arrows pointing outward: "this pushes you away".
    ctx.fillStyle = '#8a6a0e';
    for (let i = 0; i < 8; i++) {
      const ang = (i * Math.PI) / 4;
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      const tip = r * 0.78;
      const base = r * 0.45;
      ctx.beginPath();
      ctx.moveTo(b.x + ux * tip, b.y + uy * tip);
      ctx.lineTo(b.x + ux * base - uy * 3, b.y + uy * base + ux * 3);
      ctx.lineTo(b.x + ux * base + uy * 3, b.y + uy * base - ux * 3);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(b.x, b.y, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSpinner(sp) {
    // Faint ring showing how far the spokes reach.
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, sp.len + SPINNER_SPOKE, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    const flash = sp.hitAt !== undefined && state.time - sp.hitAt < 0.12;
    for (const pass of ['shadow', 'spoke']) {
      for (let k = 0; k < sp.spokes; k++) {
        const ang = spokeAngle(sp, k);
        const ux = Math.cos(ang);
        const uy = Math.sin(ang);
        const oy = pass === 'shadow' ? 3 : 0;
        const base = SPINNER_SPOKE + 1.5;
        const tip = sp.len + SPINNER_SPOKE;
        // A spike: wide at the hub, tapering to a point.
        ctx.beginPath();
        ctx.moveTo(sp.x - uy * base, sp.y + ux * base + oy);
        ctx.lineTo(sp.x + ux * (tip - 9) - uy * SPINNER_SPOKE, sp.y + uy * (tip - 9) + ux * SPINNER_SPOKE + oy);
        ctx.lineTo(sp.x + ux * tip, sp.y + uy * tip + oy);
        ctx.lineTo(sp.x + ux * (tip - 9) + uy * SPINNER_SPOKE, sp.y + uy * (tip - 9) - ux * SPINNER_SPOKE + oy);
        ctx.lineTo(sp.x + uy * base, sp.y - ux * base + oy);
        ctx.closePath();
        if (pass === 'shadow') {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fill();
          continue;
        }
        ctx.fillStyle = flash ? '#8a929c' : '#5b636d';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#2f343a';
        ctx.stroke();
        // Red spike tip
        ctx.beginPath();
        ctx.moveTo(sp.x + ux * (tip - 9) - uy * SPINNER_SPOKE, sp.y + uy * (tip - 9) + ux * SPINNER_SPOKE);
        ctx.lineTo(sp.x + ux * tip, sp.y + uy * tip);
        ctx.lineTo(sp.x + ux * (tip - 9) + uy * SPINNER_SPOKE, sp.y + uy * (tip - 9) - ux * SPINNER_SPOKE);
        ctx.closePath();
        ctx.fillStyle = '#e5484d';
        ctx.fill();
      }
    }
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, SPINNER_HUB, 0, Math.PI * 2);
    ctx.fillStyle = '#2b2f33';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, SPINNER_HUB * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#b8c0c8';
    ctx.fill();
  }

  function drawCourse() {
    const c = course();

    // Rough
    ctx.fillStyle = '#2f6e36';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = 0; y < H; y += 22) {
      for (let x = (y / 22) % 2 ? 11 : 0; x < W; x += 22) ctx.fillRect(x, y, 3, 3);
    }
    if (!c) return;

    // Walls: a drop shadow, then a thick white stroke along every wall. The
    // fairway is filled over it afterwards so only the outer half shows.
    ctx.lineCap = 'square';
    ctx.save();
    ctx.translate(0, 3);
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    strokeSegments(c.walls);
    ctx.restore();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#ffffff';
    strokeSegments(c.walls);

    // Fairway with mowing stripes
    ctx.save();
    traceCells(c.cells);
    ctx.fillStyle = '#4fb046';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = -H; i < W + H; i += 56) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 28, 0);
      ctx.lineTo(i + 28 + H, H);
      ctx.lineTo(i + H, H);
      ctx.closePath();
      ctx.fill();
    }
    for (const s of c.slopes) drawSlope(s);
    // Inner shadow along the walls
    ctx.lineCap = 'butt';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    strokeSegments(c.walls);
    ctx.restore();

    // Tee mat
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    roundRect(c.tee.x - 20, c.tee.y - 12, 40, 24, 6);
    ctx.fill();

    // Sand
    for (const s of c.sand) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = '#ecd9a0';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#d2b978';
      ctx.stroke();
      ctx.fillStyle = 'rgba(160,130,70,0.35)';
      for (let i = 0; i < 12; i++) {
        const a = i * 2.4;
        const rr = (s.r - 6) * ((i * 37) % 10) / 10;
        ctx.fillRect(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr, 2, 2);
      }
    }

    // Water
    for (const w of c.water) {
      roundRect(w.x - 3, w.y - 3, w.w + 6, w.h + 6, 12);
      ctx.fillStyle = '#2b7fb3';
      ctx.fill();
      roundRect(w.x, w.y, w.w, w.h, 10);
      ctx.fillStyle = '#4fb3ea';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const y = w.y + 9 + i * 11;
        const off = Math.sin(state.time * 1.5 + i) * 5;
        ctx.beginPath();
        ctx.moveTo(w.x + 8 + off, y);
        ctx.quadraticCurveTo(w.x + 16 + off, y - 4, w.x + 24 + off, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Solid obstacles (white, like the walls)
    for (const s of c.solids) {
      ctx.save();
      ctx.translate(0, 3);
      tracePoly(s.pts);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fill();
      ctx.restore();
      tracePoly(s.pts);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#dfe5dc';
      ctx.stroke();
    }

    for (const b of c.bumpers) drawBumper(b);
    for (const sp of c.spinners) drawSpinner(sp);

    // Hole
    const h = c.hole;
    ctx.beginPath();
    ctx.arc(h.x, h.y, HOLE_R + 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(h.x, h.y, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#14281a';
    ctx.fill();
  }

  function drawFlag(focusBall) {
    const h = course().hole;
    // Fade the flag when a ball is near so it doesn't hide the putt.
    const near = focusBall && Math.hypot(focusBall.x - h.x, focusBall.y - h.y) < 70;
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

  function render() {
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    drawCourse();
    if (!course()) return;

    if (state.phase === 'menu') {
      drawFlag(null);
      return;
    }

    // The ball in focus is the one moving / animating, otherwise whoever's up.
    const focus = state.roll ? state.roll.player : state.anim ? state.anim.player : state.turn;
    const live = state.view === state.hole; // false while replaying an earlier hole

    // Other balls are ghosts (balls don't collide with each other).
    if (live) {
      state.players.forEach((p, i) => {
        if (i === focus || p.done) return;
        drawBall(p.ball.x, p.ball.y, COLORS[i], 0.45);
      });
    }

    let focusBall = null;
    if (state.roll) {
      focusBall = state.roll.ball;
      drawBall(focusBall.x, focusBall.y, COLORS[focus], 1);
    } else if (state.anim) {
      drawAnim();
    } else if (live && !state.players[focus].done) {
      const b = state.players[focus].ball;
      focusBall = b;
      const myShot = state.phase === 'aim';
      if (myShot && !state.aim) drawIdleHint();
      drawBall(b.x, b.y, COLORS[focus], myShot || state.phase === 'over' ? 1 : 0.75);
      if (myShot) drawAim();
    }

    drawFlag(focusBall);
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


  function sinkRadius(p) {
    return BALL_R * (1 - 0.35 * p);
  }

  // Keep the dropping ball moving the way it was going, slowing fast and
  // knocking off the back of the cup instead of being sucked to the centre.
  function updateSink(a, dt) {
    const k = Math.exp(-7 * dt);
    a.vx *= k;
    a.vy *= k;
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    const h = course().hole;
    const dx = a.x - h.x;
    const dy = a.y - h.y;
    const d = Math.hypot(dx, dy);
    const p = Math.min(a.t / SINK_TIME, 1);
    const lim = HOLE_R - sinkRadius(p) * p; // starts at the rim, tightens as it drops
    if (d > lim && d > 0) {
      const nx = dx / d;
      const ny = dy / d;
      a.x = h.x + nx * lim;
      a.y = h.y + ny * lim;
      const vn = a.vx * nx + a.vy * ny;
      if (vn > 0) {
        a.vx -= 1.3 * vn * nx;
        a.vy -= 1.3 * vn * ny;
      }
    }
  }

  function drawAnim() {
    const a = state.anim;
    if (a.kind === 'sink') {
      // The ball drops where it went in: it shrinks and darkens, and anything
      // outside the cup edge is clipped so it looks like it's below the rim.
      const p = Math.min(a.t / SINK_TIME, 1);
      const h = course().hole;
      ctx.save();
      ctx.beginPath();
      ctx.arc(h.x, h.y, HOLE_R + BALL_R * (1 - p) * 1.2, 0, Math.PI * 2);
      ctx.clip();
      const r = sinkRadius(p);
      drawBall(a.x, a.y, COLORS[a.player], 1, r);
      ctx.beginPath();
      ctx.arc(a.x, a.y, r + 0.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(10,25,15,${0.75 * p})`;
      ctx.fill();
      ctx.restore();
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
  // ---------- Main loop ----------
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    state.time += dt;
    if (!(state.phase === 'rolling' && state.roll)) state.spinT = (state.spinT + dt) % 3600;

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
      if (a.kind === 'sink') updateSink(a, dt);
      if (a.t > (a.kind === 'sink' ? SINK_TIME + 0.25 : 0.9)) {
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
      bump: () => { tone(260, 0.12, 'square', 0.12, 520); tone(520, 0.1, 'triangle', 0.15, 1040); },
      sink: () => { tone(220, 0.14, 'sine', 0.45, 110); noise(0.06, 0.25, 1200); setTimeout(() => tone(160, 0.12, 'sine', 0.3, 90), 120); },
      splash: () => noise(0.5, 0.35, 900),
    };
  })();


  // ---------- Boot ----------
  loadNames();
  setMenuMode('link');
  // A sample hole sits behind the menu.
  state.holes = [Gen.generateHole(20261006, 2)];
  resize();
  updateHud();
  const params = new URLSearchParams(location.search);
  if (params.get('game') && SERVER && /^[a-z0-9]{1,16}$/.test(params.get('game'))) {
    loadFromServer(params.get('game'), params.get('p'));
  } else if (!loadFromHash()) {
    showMenu();
  }
  requestAnimationFrame(frame);
})();
