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
  const ROLL_FRICTION = 150;  // constant deceleration
  const DRAG_COEF = 0.55;     // speed-proportional deceleration
  const SAND_MULT = 5;
  const STOP_SPEED = 8;
  const CAPTURE_SPEED = 560;  // faster than this and the ball lips out
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
  const canvas = document.getElementById('course');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');
  const banner = document.getElementById('banner');
  const menu = document.getElementById('menu');
  const results = document.getElementById('results');
  const cards = [...document.querySelectorAll('.player-card')];
  const nameInputs = [document.getElementById('name0'), document.getElementById('name1')];

  // ---------- State ----------
  const state = {
    phase: 'menu', // menu | aim | rolling | sinking | splash | over
    players: [makePlayer('Player 1'), makePlayer('Player 2')],
    turn: 0,
    starter: 0,
    shotFrom: null, // ball position before the current shot (for water / out of bounds)
    aim: null,      // { sx, sy, cx, cy } in world coords while dragging
    sinkT: 0,
    splashT: 0,
    time: 0,
  };

  function makePlayer(name) {
    return { name, strokes: 0, done: false, ball: { x: 0, y: 0, vx: 0, vy: 0 } };
  }

  function current() {
    return state.players[state.turn];
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

  // ---------- Game flow ----------
  function loadNames() {
    try {
      const saved = JSON.parse(localStorage.getItem('minigolf-names') || '[]');
      saved.forEach((n, i) => { if (nameInputs[i] && n) nameInputs[i].value = n; });
    } catch (e) { /* storage unavailable */ }
  }

  function saveNames(names) {
    try { localStorage.setItem('minigolf-names', JSON.stringify(names)); } catch (e) { /* ignore */ }
  }

  function startGame() {
    const names = nameInputs.map((inp, i) => inp.value.trim() || `Player ${i + 1}`);
    saveNames(nameInputs.map((inp) => inp.value.trim()));
    state.players = names.map(makePlayer);
    state.players.forEach((p) => resetBallToTee(p));
    state.turn = state.starter;
    state.aim = null;
    state.phase = 'aim';
    menu.classList.add('hidden');
    results.classList.add('hidden');
    updateHud();
    showBanner(`${current().name} tees off`, COLORS[state.turn]);
  }

  function resetBallToTee(p) {
    p.ball.x = COURSE.tee.x;
    p.ball.y = COURSE.tee.y;
    p.ball.vx = p.ball.vy = 0;
  }

  function shoot(power, dirX, dirY) {
    const p = current();
    p.strokes++;
    state.shotFrom = { x: p.ball.x, y: p.ball.y };
    const speed = power * MAX_SPEED;
    p.ball.vx = dirX * speed;
    p.ball.vy = dirY * speed;
    state.phase = 'rolling';
    updateHud();
    sound.hit(power);
  }

  function endShot() {
    const p = current();
    p.ball.vx = p.ball.vy = 0;
    if (!p.done && p.strokes >= MAX_STROKES) {
      p.done = true;
      showBanner(`${p.name}: max ${MAX_STROKES} strokes`, COLORS[state.turn]);
    }
    nextTurn();
  }

  function nextTurn() {
    updateHud();
    if (state.players.every((p) => p.done)) {
      state.phase = 'over';
      setTimeout(showResults, 900);
      return;
    }
    const other = 1 - state.turn;
    if (!state.players[other].done) state.turn = other;
    state.phase = 'aim';
    updateHud();
    const p = current();
    // Announce the next turn once any score / penalty banner has finished.
    const wait = Math.max(250, bannerEnd - performance.now());
    setTimeout(() => {
      if (state.phase === 'aim' && current() === p) showBanner(`${p.name}'s turn`, COLORS[state.turn]);
    }, wait);
  }

  function holeOut() {
    const p = current();
    p.done = true;
    state.phase = 'sinking';
    state.sinkT = 0;
    sound.sink();
    if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
    showBanner(`${p.name}: ${scoreName(p.strokes)}`, COLORS[state.turn], 1500);
  }

  function splash() {
    const p = current();
    state.phase = 'splash';
    state.splashT = 0;
    state.splashAt = { x: p.ball.x, y: p.ball.y };
    p.ball.vx = p.ball.vy = 0;
    p.strokes++; // penalty stroke
    sound.splash();
    showBanner('Splash! +1 stroke', '#3fa7e0', 1300);
    updateHud();
  }

  function scoreName(strokes) {
    if (strokes === 1) return 'Hole in one!';
    const names = { '-3': 'Albatross!', '-2': 'Eagle!', '-1': 'Birdie!', '0': 'Par', '1': 'Bogey', '2': 'Double bogey' };
    const rel = strokes - PAR;
    return names[rel] || `${strokes} strokes`;
  }

  function showResults() {
    const [a, b] = state.players;
    const title = document.getElementById('result-title');
    if (a.strokes === b.strokes) title.textContent = "It's a tie!";
    else title.textContent = `${(a.strokes < b.strokes ? a : b).name} wins!`;
    const best = Math.min(a.strokes, b.strokes);
    const rows = document.getElementById('result-rows');
    rows.innerHTML = '';
    state.players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = `result-row p${i}` + (p.strokes === best && a.strokes !== b.strokes ? ' winner' : '');
      const rel = p.strokes - PAR;
      row.innerHTML = '<span class="dot"></span><span class="name"></span><span class="score"></span><span class="rel"></span>';
      row.querySelector('.name').textContent = p.name;
      row.querySelector('.score').textContent = p.strokes;
      row.querySelector('.rel').textContent = rel === 0 ? 'E' : (rel > 0 ? `+${rel}` : `${rel}`);
      rows.appendChild(row);
    });
    results.classList.remove('hidden');
  }

  function updateHud() {
    state.players.forEach((p, i) => {
      const card = cards[i];
      card.querySelector('.name').textContent = p.name;
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
    if (!cancelled && power >= MIN_POWER && state.phase === 'aim') shoot(power, dirX, dirY);
  }
  canvas.addEventListener('pointerup', (e) => release(e, false));
  canvas.addEventListener('pointercancel', (e) => release(e, true));

  // Stop iOS from scrolling / zooming the page while playing.
  document.addEventListener('touchmove', (e) => {
    if (e.target === canvas) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  document.getElementById('start-btn').addEventListener('click', () => { sound.unlock(); startGame(); });
  document.getElementById('again-btn').addEventListener('click', () => {
    state.starter = 1 - state.starter; // alternate who tees off first
    startGame();
  });
  document.getElementById('menu-btn').addEventListener('click', () => {
    results.classList.add('hidden');
    menu.classList.remove('hidden');
    state.phase = 'menu';
    updateHud();
  });

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

  function physicsStep(dt) {
    const b = current().ball;
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

    // Hole: slow enough and it drops; too fast and it curls around the lip.
    const hx = COURSE.hole.x - b.x;
    const hy = COURSE.hole.y - b.y;
    const hd = Math.hypot(hx, hy);
    speed = Math.hypot(b.vx, b.vy);
    if (hd < HOLE_R) {
      if (speed < CAPTURE_SPEED) {
        holeOut();
        return;
      }
      const pull = 2600 * dt;
      b.vx += (hx / hd) * pull;
      b.vy += (hy / hd) * pull;
      b.vx *= 0.995;
      b.vy *= 0.995;
    }

    if (inWater(b)) {
      splash();
      return;
    }

    if (outOfBounds(b)) {
      // Safety net: should never happen, but never lose the ball.
      b.x = state.shotFrom.x;
      b.y = state.shotFrom.y;
      b.vx = b.vy = 0;
    }

    if (speed < STOP_SPEED) endShot();
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

  function drawSplash() {
    if (state.phase !== 'splash') return;
    const t = state.splashT / 0.8;
    const p = state.splashAt;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${1 - t})`;
    ctx.lineWidth = 3;
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 + (t + i * 0.3) * 22, 0, Math.PI * 2);
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

    // Other players' balls are ghosts (no collisions between balls).
    state.players.forEach((p, i) => {
      if (i === state.turn || p.done) return;
      drawBall(p.ball.x, p.ball.y, COLORS[i], 0.45);
    });

    const p = current();
    if (state.phase === 'sinking') {
      const t = Math.min(state.sinkT / 0.35, 1);
      const h = COURSE.hole;
      const x = p.ball.x + (h.x - p.ball.x) * t;
      const y = p.ball.y + (h.y - p.ball.y) * t;
      drawBall(x, y, COLORS[state.turn], 1 - t * 0.6, BALL_R * (1 - t * 0.5));
    } else if (state.phase === 'splash') {
      drawSplash();
    } else if (!p.done) {
      if (state.phase === 'aim' && !state.aim) drawIdleHint();
      drawBall(p.ball.x, p.ball.y, COLORS[state.turn], 1);
      drawAim();
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

    if (state.phase === 'rolling') {
      acc += dt;
      while (acc >= STEP && state.phase === 'rolling') {
        physicsStep(STEP);
        acc -= STEP;
      }
      if (state.phase !== 'rolling') acc = 0;
    } else if (state.phase === 'sinking') {
      state.sinkT += dt;
      if (state.sinkT > 0.6) nextTurn();
    } else if (state.phase === 'splash') {
      state.splashT += dt;
      if (state.splashT > 0.9) {
        const b = current().ball;
        b.x = state.shotFrom.x;
        b.y = state.shotFrom.y;
        endShot();
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
      sink: () => { tone(500, 0.12, 'sine', 0.35, 250); setTimeout(() => tone(700, 0.18, 'sine', 0.3, 1000), 140); },
      splash: () => noise(0.5, 0.35, 900),
    };
  })();

  // ---------- Boot ----------
  loadNames();
  resize();
  updateHud();
  requestAnimationFrame(frame);
})();
