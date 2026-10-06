// Random hole generator.
//
// Each hole is built on a 5x8 grid of rectangular "cells". A single path of
// cells is walked from the tee (bottom) to the cup (top), a few neighbouring
// cells are added to widen it, and the walls are simply every cell edge that
// borders a non-fairway cell. Because every fairway cell is joined to that one
// path, there can never be a walled-off island. Obstacles are then sprinkled
// in, and the finished hole is flood-filled at ball size: if the cup can't be
// reached, or any open pocket can't be reached from the tee, the hole is thrown
// away and generated again.
//
// Everything here is driven by a seeded PRNG and avoids Math.sin/cos/hypot, so
// two phones given the same seed always build exactly the same holes.
(function (root) {
  'use strict';

  const W = 400;
  const H = 700;
  const BALL_R = 8;
  const HOLE_R = 12;
  const HOLES = 5;

  const COLS = 5;
  const ROWS = 8;
  const CW = 72;
  const CH = 82.5;
  const X0 = (W - COLS * CW) / 2;
  const Y0 = (H - ROWS * CH) / 2;

  // Per-hole difficulty settings, hole 1 (easiest) to hole 5 (hardest).
  const LEVELS = [
    { rows: 5, turns: [0, 1], widen: 0.5, bumpers: [1, 1], solids: [0, 1], wedges: [0, 1], sand: [0, 0], water: [0, 0], slopes: [0, 0] },
    { rows: 6, turns: [1, 2], widen: 0.4, bumpers: [1, 2], solids: [1, 2], wedges: [1, 1], sand: [0, 1], water: [0, 0], slopes: [1, 1] },
    { rows: 7, turns: [1, 3], widen: 0.3, bumpers: [1, 2], solids: [1, 2], wedges: [1, 2], sand: [0, 1], water: [0, 1], slopes: [1, 2] },
    { rows: 8, turns: [2, 3], widen: 0.25, bumpers: [2, 3], solids: [2, 3], wedges: [1, 2], sand: [1, 1], water: [1, 1], slopes: [1, 2] },
    { rows: 8, turns: [2, 4], widen: 0.2, bumpers: [2, 3], solids: [2, 4], wedges: [1, 2], sand: [0, 1], water: [1, 2], slopes: [2, 3] },
  ];

  // Rotations for obstacles as exact cos/sin pairs (no trig at runtime).
  const ROT = [
    [1, 0], [0.9659258262890683, 0.25881904510252074], [0.8660254037844387, 0.5],
    [0.7071067811865476, 0.7071067811865476], [0.5, 0.8660254037844387], [0.25881904510252074, 0.9659258262890683],
    [0, 1], [-0.25881904510252074, 0.9659258262890683], [-0.5, 0.8660254037844387],
    [-0.7071067811865476, 0.7071067811865476], [-0.8660254037844387, 0.5], [-0.9659258262890683, 0.25881904510252074],
  ];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRand(seed) {
    const next = mulberry32(seed);
    const r = () => next();
    r.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    r.range = (lo, hi) => lo + next() * (hi - lo);
    r.pick = (arr) => arr[Math.floor(next() * arr.length)];
    r.chance = (p) => next() < p;
    return r;
  }

  const cellRect = (r, c) => ({ x: X0 + c * CW, y: Y0 + r * CH, w: CW, h: CH });
  const cellCenter = (r, c) => ({ x: X0 + (c + 0.5) * CW, y: Y0 + (r + 0.5) * CH });

  // ---------- Layout ----------
  function buildLayout(rand, lv) {
    const grid = [];
    for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(false));
    const top = Math.floor((ROWS - lv.rows) / 2);
    const bottom = top + lv.rows - 1;
    const path = [];
    const add = (r, c) => {
      if (!grid[r][c]) {
        grid[r][c] = true;
      }
      path.push([r, c]);
    };
    // Pick how many sideways runs this hole gets, and on which rows.
    const turnRows = new Set();
    const wanted = rand.int(lv.turns[0], lv.turns[1]);
    while (turnRows.size < Math.min(wanted, lv.rows)) turnRows.add(rand.int(top, bottom));
    let col = rand.int(0, COLS - 1);
    add(bottom, col);
    for (let r = bottom; r >= top; r--) {
      if (r !== bottom) add(r, col);
      if (turnRows.has(r)) {
        let target = rand.int(0, COLS - 1);
        if (target === col) target = col === 0 ? COLS - 1 : (col === COLS - 1 ? 0 : (rand.chance(0.5) ? 0 : COLS - 1));
        const step = target > col ? 1 : -1;
        while (col !== target) {
          col += step;
          add(r, col);
        }
      }
    }

    const tee = path[0];
    const cup = path[path.length - 1];
    // Widen: add a neighbour next to some path cells (always joined to the path).
    for (const [r, c] of path) {
      if (!rand.chance(lv.widen)) continue;
      const opts = [[r, c - 1], [r, c + 1], [r - 1, c], [r + 1, c]].filter(([rr, cc]) =>
        rr >= top && rr <= bottom && cc >= 0 && cc < COLS && !grid[rr][cc]);
      if (opts.length) {
        const [rr, cc] = rand.pick(opts);
        grid[rr][cc] = true;
      }
    }
    return { grid, tee, cup, path };
  }

  function inGrid(grid, r, c) {
    return r >= 0 && r < ROWS && c >= 0 && c < COLS && grid[r][c];
  }

  // Wall segments: every cell edge that borders a non-fairway cell, merged
  // into long straight runs.
  function buildWalls(grid) {
    const hEdges = new Map();
    const vEdges = new Map();
    const push = (map, key, a, b) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push([a, b]);
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!grid[r][c]) continue;
        const { x, y, w, h } = cellRect(r, c);
        if (!inGrid(grid, r - 1, c)) push(hEdges, y, x, x + w);
        if (!inGrid(grid, r + 1, c)) push(hEdges, y + h, x, x + w);
        if (!inGrid(grid, r, c - 1)) push(vEdges, x, y, y + h);
        if (!inGrid(grid, r, c + 1)) push(vEdges, x + w, y, y + h);
      }
    }
    const segs = [];
    const merge = (map, horizontal) => {
      for (const [k, list] of map) {
        list.sort((p, q) => p[0] - q[0]);
        let [a, b] = list[0];
        for (let i = 1; i <= list.length; i++) {
          if (i < list.length && Math.abs(list[i][0] - b) < 1e-6) {
            b = list[i][1];
            continue;
          }
          segs.push(horizontal ? { ax: a, ay: k, bx: b, by: k } : { ax: k, ay: a, bx: k, by: b });
          if (i < list.length) [a, b] = list[i];
        }
      }
    };
    merge(hEdges, true);
    merge(vEdges, false);
    return segs;
  }

  // Corners of a cell where both adjacent sides are walls (for corner wedges).
  function outerCorners(grid, r, c) {
    const out = [];
    const up = inGrid(grid, r - 1, c);
    const down = inGrid(grid, r + 1, c);
    const left = inGrid(grid, r, c - 1);
    const right = inGrid(grid, r, c + 1);
    if (!up && !left) out.push([-1, -1]);
    if (!up && !right) out.push([1, -1]);
    if (!down && !left) out.push([-1, 1]);
    if (!down && !right) out.push([1, 1]);
    return out;
  }

  function polyFrom(cx, cy, local, rot) {
    const [co, si] = rot;
    return local.map(([x, y]) => [cx + x * co - y * si, cy + x * si + y * co]);
  }

  // ---------- Obstacles ----------
  function placeObstacles(rand, lv, layout, scale) {
    const { grid, tee, cup } = layout;
    const course = { solids: [], bumpers: [], sand: [], water: [], slopes: [] };
    const free = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] && !(r === tee[0] && c === tee[1]) && !(r === cup[0] && c === cup[1])) free.push([r, c]);
      }
    }
    const teePt = cellCenter(tee[0], tee[1]);
    teePt.y += 18;
    const cupCell = cellRect(cup[0], cup[1]);
    const cupPt = {
      x: cupCell.x + CW / 2 + rand.range(-10, 10),
      y: cupCell.y + CH / 2 + rand.range(-14, 6),
    };
    course.tee = teePt;
    course.hole = cupPt;
    if (!free.length) return course;

    const taken = [{ x: teePt.x, y: teePt.y, r: 30 }, { x: cupPt.x, y: cupPt.y, r: 34 }];
    const clear = (x, y, r) => taken.every((t) => {
      const dx = t.x - x;
      const dy = t.y - y;
      const min = t.r + r + 6;
      return dx * dx + dy * dy >= min * min;
    });
    const count = (pair) => Math.round(rand.int(pair[0], pair[1]) * scale);
    const tryPlace = (make) => {
      for (let i = 0; i < 14; i++) {
        const [r, c] = rand.pick(free);
        const o = make(r, c);
        if (o && clear(o.x, o.y, o.r)) {
          taken.push({ x: o.x, y: o.y, r: o.r });
          return o;
        }
      }
      return null;
    };
    const jitter = (r, c, jx, jy) => {
      const p = cellCenter(r, c);
      return { x: p.x + rand.range(-jx, jx), y: p.y + rand.range(-jy, jy) };
    };

    // Slopes fill a whole cell. Arrows point downhill (the way the ball is pushed).
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (let n = count(lv.slopes); n > 0; n--) {
      for (let i = 0; i < 10; i++) {
        const [r, c] = rand.pick(free);
        if (course.slopes.some((s) => s.r === r && s.c === c)) continue;
        const [dx, dy] = rand.pick(dirs);
        // Don't put two slopes facing each other side by side (the ball would rock in the dip).
        const clash = course.slopes.some((s) => Math.abs(s.r - r) + Math.abs(s.c - c) === 1 && s.dx === -dx && s.dy === -dy);
        if (clash) continue;
        const rect = cellRect(r, c);
        course.slopes.push({ r, c, ...rect, dx, dy, a: Math.round(rand.range(170, 290)) });
        break;
      }
    }

    for (let n = count(lv.water); n > 0; n--) {
      const o = tryPlace((r, c) => {
        const w = Math.round(rand.range(34, 50));
        const h = Math.round(rand.range(26, 38));
        const p = jitter(r, c, CW / 2 - w / 2 - 4, CH / 2 - h / 2 - 4);
        return { x: p.x, y: p.y, r: Math.max(w, h) / 2 + 2, w, h };
      });
      if (o) course.water.push({ x: o.x - o.w / 2, y: o.y - o.h / 2, w: o.w, h: o.h });
    }

    for (let n = count(lv.sand); n > 0; n--) {
      const o = tryPlace((r, c) => {
        const rad = Math.round(rand.range(20, 27));
        const p = jitter(r, c, 10, 14);
        return { x: p.x, y: p.y, r: rad };
      });
      if (o) course.sand.push({ x: o.x, y: o.y, r: o.r });
    }

    for (let n = count(lv.bumpers); n > 0; n--) {
      const o = tryPlace((r, c) => {
        // Never on a slope: the slope would keep rolling the ball back into it.
        if (course.slopes.some((s) => s.r === r && s.c === c)) return null;
        const p = jitter(r, c, 16, 20);
        return { x: p.x, y: p.y, r: 14 };
      });
      if (o) course.bumpers.push({ x: o.x, y: o.y, r: 14 });
    }

    for (let n = count(lv.solids); n > 0; n--) {
      const kind = rand.pick(['square', 'bar', 'bar', 'tri']);
      const o = tryPlace((r, c) => {
        const p = jitter(r, c, 12, 16);
        const rot = rand.pick(ROT);
        let local;
        if (kind === 'square') {
          const s = rand.range(11, 15);
          local = [[-s, -s], [s, -s], [s, s], [-s, s]];
        } else if (kind === 'bar') {
          const l = rand.range(20, 30);
          const t = 4;
          local = [[-l, -t], [l, -t], [l, t], [-l, t]];
        } else {
          const s = rand.range(14, 19);
          local = [[-s, s * 0.7], [s, s * 0.7], [-s, -s * 1.1]];
        }
        let rad = 0;
        local.forEach(([x, y]) => { rad = Math.max(rad, Math.sqrt(x * x + y * y)); });
        return { x: p.x, y: p.y, r: rad, pts: polyFrom(p.x, p.y, local, rot) };
      });
      if (o) course.solids.push({ pts: o.pts });
    }

    // Wedges tucked into outer corners give angled banks to play off.
    for (let n = count(lv.wedges); n > 0; n--) {
      for (let i = 0; i < 10; i++) {
        const [r, c] = rand.pick(free);
        const corners = outerCorners(grid, r, c);
        if (!corners.length) continue;
        const [sx, sy] = rand.pick(corners);
        const rect = cellRect(r, c);
        const cx = sx < 0 ? rect.x : rect.x + rect.w;
        const cy = sy < 0 ? rect.y : rect.y + rect.h;
        const lx = rand.range(26, 40);
        const ly = rand.range(26, 40);
        const mid = { x: cx - sx * lx / 3, y: cy - sy * ly / 3, r: Math.max(lx, ly) / 2 };
        if (!clear(mid.x, mid.y, mid.r)) continue;
        taken.push(mid);
        course.solids.push({ pts: [[cx, cy], [cx - sx * lx, cy], [cx, cy - sy * ly]] });
        break;
      }
    }
    return course;
  }

  // ---------- Validation ----------
  function segDist2(px, py, ax, ay, bx, by) {
    const ex = bx - ax;
    const ey = by - ay;
    let t = ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + ex * t);
    const dy = py - (ay + ey * t);
    return dx * dx + dy * dy;
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

  // Flood-fill the hole on a fine grid of ball-centre positions. Returns the
  // walking distance from tee to cup, or -1 if the hole is unfair.
  function validate(course) {
    const S = 6;
    const nx = Math.floor((COLS * CW) / S);
    const ny = Math.floor((ROWS * CH) / S);
    const clearance = BALL_R + 1;
    const c2 = clearance * clearance;
    const segs = course.segments;
    const ok = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = Y0 + (j + 0.5) * S;
      for (let i = 0; i < nx; i++) {
        const x = X0 + (i + 0.5) * S;
        const r = Math.floor((y - Y0) / CH);
        const c = Math.floor((x - X0) / CW);
        if (!course.grid[r][c]) continue;
        if (course.water.some((w) => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h)) continue;
        if (course.bumpers.some((b) => (x - b.x) * (x - b.x) + (y - b.y) * (y - b.y) < (b.r + clearance) * (b.r + clearance))) continue;
        if (course.solids.some((s) => pointInPolygon(x, y, s.pts))) continue;
        let blocked = false;
        for (const s of segs) {
          if (segDist2(x, y, s.ax, s.ay, s.bx, s.by) < c2) { blocked = true; break; }
        }
        if (!blocked) ok[j * nx + i] = 1;
      }
    }
    const idx = (p) => {
      const i = Math.min(nx - 1, Math.max(0, Math.floor((p.x - X0) / S)));
      const j = Math.min(ny - 1, Math.max(0, Math.floor((p.y - Y0) / S)));
      return j * nx + i;
    };
    const start = idx(course.tee);
    const goal = idx(course.hole);
    if (!ok[start] || !ok[goal]) return -1;
    const dist = new Int32Array(nx * ny).fill(-1);
    const queue = new Int32Array(nx * ny);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    dist[start] = 0;
    while (head < tail) {
      const k = queue[head++];
      const i = k % nx;
      const j = (k - i) / nx;
      const nbrs = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
      for (const n of nbrs) {
        if (n >= 0 && ok[n] && dist[n] < 0) {
          dist[n] = dist[k] + 1;
          queue[tail++] = n;
        }
      }
    }
    if (dist[goal] < 0) return -1;
    // Any open area the ball could sit in but never reach means a sealed pocket.
    let stranded = 0;
    for (let k = 0; k < ok.length; k++) if (ok[k] && dist[k] < 0) stranded++;
    if (stranded > 4) return -1;
    return dist[goal] * S;
  }

  // Add walls and collision segments, validate, and work out par.
  function finish(course, layout, index) {
    course.index = index;
    course.grid = layout.grid;
    course.cells = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (layout.grid[r][c]) course.cells.push(cellRect(r, c));
    course.walls = buildWalls(layout.grid);
    course.segments = course.walls.slice();
    for (const s of course.solids) {
      for (let i = 0; i < s.pts.length; i++) {
        const a = s.pts[i];
        const b = s.pts[(i + 1) % s.pts.length];
        course.segments.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1] });
      }
    }
    const d = validate(course);
    if (d < 0) return null;
    const hazards = course.water.length + course.slopes.length;
    course.par = Math.max(2, Math.min(5, 2 + Math.floor(d / 360) + (hazards >= 3 ? 1 : 0)));
    course.walk = d;
    return course;
  }

  // ---------- Public ----------
  function generateHole(seed, index) {
    const lv = LEVELS[index];
    const rand = makeRand((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    for (let attempt = 0; attempt < 80; attempt++) {
      const layout = buildLayout(rand, lv);
      if (!layout) continue;
      // After a lot of failed tries, ease off the obstacles so we always finish.
      const scale = attempt < 40 ? 1 : attempt < 60 ? 0.5 : 0;
      const course = finish(placeObstacles(rand, lv, layout, scale), layout, index);
      if (!course) continue;
      course.attempts = attempt + 1;
      return course;
    }
    // Practically never reached: fall back to a plain hole with no obstacles.
    const layout = buildLayout(rand, lv);
    return finish(placeObstacles(rand, lv, layout, 0), layout, index);
  }

  function generateRound(seed) {
    const holes = [];
    for (let i = 0; i < HOLES; i++) holes.push(generateHole(seed, i));
    return holes;
  }

  function inFairway(course, x, y) {
    const r = Math.floor((y - Y0) / CH);
    const c = Math.floor((x - X0) / CW);
    return r >= 0 && r < ROWS && c >= 0 && c < COLS && course.grid[r][c];
  }

  root.MiniGolfCourse = { generateRound, generateHole, inFairway, pointInPolygon, HOLES, W, H, BALL_R, HOLE_R };
})(typeof window !== 'undefined' ? window : globalThis);
