/// <reference lib="webworker" />
//
// Global route planner over the ENC navigable water. Self-contained (pure math,
// no imports) so it bundles cleanly as a web worker.
//
//   in : { viaPoints: [lon,lat][], rings: [lon,lat][][], resM?, clearanceM?, algorithm? }
//   out: { ok: boolean, route?: [lon,lat][], error?: string }
//
// Plans a path between each consecutive via-point, staying inside the navigable
// polygons. Two algorithms share the same grid + cost model:
//   • 'theta' (default) — Theta* any-angle search: straight-line legs at any
//     heading via line-of-sight to the parent, so no 45° grid staircase.
//   • 'astar' — classic 8-connected grid A* (legacy).
// To avoid hugging the shore it:
//   • erodes the free space by CLEARANCE metres (route keeps that far from any
//     land/shallow/hazard edge), and
//   • biases the cost toward the CHANNEL CENTRE (distance-to-edge), scaled by
//     metres travelled so it weighs single steps and long any-angle segments alike.
// If the clearance would disconnect a narrow channel, it falls back to the raw
// free space for that leg so a route is still produced.

type Pt = number[];

function pointInRing(x: number, y: number, r: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function inSafe(x: number, y: number, rings: Pt[][]): boolean {
  for (const r of rings) if (pointInRing(x, y, r)) return true;
  return false;
}

function planLeg(
  start: Pt,
  goal: Pt,
  rings: Pt[][],
  resM: number,
  clearanceM: number,
  theta: boolean,
  centreBias: boolean
): Pt[] | null {
  const marginDeg = 1200 / 111320; // ~1.2 km window pad
  const minLon = Math.min(start[0], goal[0]) - marginDeg;
  const maxLon = Math.max(start[0], goal[0]) + marginDeg;
  const minLat = Math.min(start[1], goal[1]) - marginDeg;
  const maxLat = Math.max(start[1], goal[1]) + marginDeg;
  const midLat = (minLat + maxLat) / 2;
  const mLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const dLon = resM / mLon, dLat = resM / 110540;
  const nx = Math.ceil((maxLon - minLon) / dLon);
  const ny = Math.ceil((maxLat - minLat) / dLat);
  if (nx * ny > 4_000_000 || nx < 1 || ny < 1) return null;
  const cx = (i: number) => minLon + (i + 0.5) * dLon;
  const cy = (j: number) => minLat + (j + 0.5) * dLat;
  const idx = (i: number, j: number) => j * nx + i;

  // occupancy: 1 = navigable water
  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) free[idx(i, j)] = inSafe(cx(i), cy(j), rings) ? 1 : 0;

  // distance transform: metres from each free cell to the nearest blocked cell
  const INF = 1e9;
  const dist = new Float32Array(nx * ny);
  for (let c = 0; c < nx * ny; c++) dist[c] = free[c] ? INF : 0;
  const dO = resM, dD = resM * Math.SQRT2;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = idx(i, j); if (dist[c] === 0) continue;
      let d = dist[c];
      if (i > 0) d = Math.min(d, dist[idx(i - 1, j)] + dO);
      if (j > 0) d = Math.min(d, dist[idx(i, j - 1)] + dO);
      if (i > 0 && j > 0) d = Math.min(d, dist[idx(i - 1, j - 1)] + dD);
      if (i < nx - 1 && j > 0) d = Math.min(d, dist[idx(i + 1, j - 1)] + dD);
      dist[c] = d;
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const c = idx(i, j); if (dist[c] === 0) continue;
      let d = dist[c];
      if (i < nx - 1) d = Math.min(d, dist[idx(i + 1, j)] + dO);
      if (j < ny - 1) d = Math.min(d, dist[idx(i, j + 1)] + dO);
      if (i < nx - 1 && j < ny - 1) d = Math.min(d, dist[idx(i + 1, j + 1)] + dD);
      if (i > 0 && j < ny - 1) d = Math.min(d, dist[idx(i - 1, j + 1)] + dD);
      dist[c] = d;
    }

  const toCell = (p: Pt): [number, number] => [
    Math.round((p[0] - minLon) / dLon - 0.5),
    Math.round((p[1] - minLat) / dLat - 0.5)
  ];

  // A* / Theta* over cells passable at the given clearance, with an optional centre bias.
  const attempt = (clear: number, centre: boolean): Pt[] | null => {
    const nav = (c: number) => free[c] === 1 && dist[c] >= clear;
    const nearestNav = (ci: number, cj: number): [number, number] | null => {
      if (ci >= 0 && cj >= 0 && ci < nx && cj < ny && nav(idx(ci, cj))) return [ci, cj];
      for (let r = 1; r < 100; r++)
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
            const i = ci + di, j = cj + dj;
            if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
            if (nav(idx(i, j))) return [i, j];
          }
      return null;
    };
    const s = nearestNav(...toCell(start));
    const g = nearestNav(...toCell(goal));
    if (!s || !g) return null;

    const gScore = new Float64Array(nx * ny).fill(Infinity);
    const came = new Int32Array(nx * ny).fill(-1);
    const gc = idx(g[0], g[1]);
    const H = (i: number, j: number) => Math.hypot((i - g[0]) * resM, (j - g[1]) * resM);

    const heap: Array<{ c: number; f: number }> = [];
    const push = (c: number, f: number) => {
      heap.push({ c, f });
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p].f <= heap[k].f) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop() as { c: number; f: number };
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = 2 * k + 2;
          let m = k;
          if (l < heap.length && heap[l].f < heap[m].f) m = l;
          if (r < heap.length && heap[r].f < heap[m].f) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };

    // centre bias: penalise travel that runs closer than comfortM to an edge,
    // scaled by the METRES travelled so it applies equally to a single grid step
    // and to a long any-angle segment.
    //
    // comfortM references the channel's OWN width — the widest finite clearance in
    // this window (≈ the thalweg / channel centre) — so the penalty falls from ~1
    // at the bank to ~0 at the centre and adapts to narrow vs wide water. A fixed
    // small comfortM stops biasing a few tens of metres off the bank, letting the
    // route (e.g. the run-in from an off-channel start) cut straight across a wide
    // channel instead of following the middle. Clamped so it stays sane.
    let maxDist = 0;
    for (let c = 0; c < nx * ny; c++)
      if (free[c] === 1 && dist[c] < 1e8 && dist[c] > maxDist) maxDist = dist[c];
    const comfortM = Math.min(400, Math.max(60, maxDist));
    const CK = 1.5;
    const centrePen = (minEdgeM: number, segM: number) =>
      centre ? CK * segM * Math.max(0, (comfortM - minEdgeM) / comfortM) : 0;

    // Line of sight (Theta*): can a straight line from cell (i0,j0) to (i1,j1)
    // stay navigable at this clearance? Returns the MEAN distance-to-edge along the
    // segment (the centre-bias reference), or -1 if the line leaves navigable
    // water. Mean, not min: with min, a segment whose endpoints sit near a bank is
    // fully penalised however far it bows into deep water, so the route never
    // steers to the channel centre. Mean rewards bowing toward the middle.
    // Half-cell sampling; clearance erosion has already thickened blockers so a
    // straight line cannot slip through a sub-cell gap.
    const los = (i0: number, j0: number, i1: number, j1: number): number => {
      const di = i1 - i0, dj = j1 - j0;
      const n = Math.max(Math.abs(di), Math.abs(dj));
      if (n === 0) return dist[idx(i0, j0)];
      const steps = n * 2;
      let sumD = 0, cnt = 0;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const i = Math.round(i0 + di * t), j = Math.round(j0 + dj * t);
        if (i < 0 || j < 0 || i >= nx || j >= ny) return -1;
        const c = idx(i, j);
        if (free[c] !== 1 || dist[c] < clear) return -1;
        sumD += dist[c];
        cnt++;
      }
      return sumD / cnt;
    };

    gScore[idx(s[0], s[1])] = 0;
    push(idx(s[0], s[1]), H(s[0], s[1]));
    const NB = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
    ];
    let found = false;
    while (heap.length) {
      const cur = pop();
      if (cur.c === gc) { found = true; break; }
      const cj = Math.floor(cur.c / nx), ci = cur.c - cj * nx;
      const cgs = gScore[cur.c];
      if (cur.f - H(ci, cj) > cgs + 1e-6) continue;
      // Theta*: parent of the current node — candidate straight-line anchor.
      const par = came[cur.c];
      let pi = -1, pj = -1;
      if (par !== -1) { pj = Math.floor(par / nx); pi = par - pj * nx; }
      for (const [di, dj, w] of NB) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nc = idx(ni, nj);
        if (!nav(nc)) continue;
        // Path 1 (A*): ordinary grid step from the current node.
        const stepM = w * resM;
        let ng = cgs + stepM + centrePen(dist[nc], stepM);
        let ncame = cur.c;
        // Path 2 (Theta*): if the neighbour is visible in a straight line from the
        // current node's PARENT, consider connecting it directly (any-angle, no
        // grid staircase). Take it only if it is actually CHEAPER — canonical
        // Theta* always prefers the LOS shortcut, which in open water collapses
        // every path to a straight line and defeats the centre bias. Comparing
        // both lets the centred grid path win when it pays, and keeps the clean
        // straight leg where centring costs nothing.
        if (theta && par !== -1) {
          const md = los(pi, pj, ni, nj);
          if (md >= 0) {
            const segM = Math.hypot(ni - pi, nj - pj) * resM;
            const ng2 = gScore[par] + segM + centrePen(md, segM);
            if (ng2 <= ng) {
              ng = ng2;
              ncame = par;
            }
          }
        }
        if (ng < gScore[nc]) {
          gScore[nc] = ng;
          came[nc] = ncame;
          push(nc, ng + H(ni, nj));
        }
      }
    }
    if (!found) return null;
    const path: Pt[] = [];
    for (let c = gc; c !== -1; c = came[c]) {
      const j = Math.floor(c / nx), i = c - j * nx;
      path.push([cx(i), cy(j)]);
    }
    return path.reverse();
  };

  // clearance + centre-bias first; fall back to raw free space if it disconnects.
  return attempt(clearanceM, centreBias) || attempt(0, false);
}

function perp(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function simplify(
  pts: Pt[],
  tol: number,
  okSeg: (a: Pt, b: Pt) => boolean
): Pt[] {
  if (pts.length < 3) return pts.slice();
  let md = 0, mi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perp(pts[i], pts[0], pts[pts.length - 1]);
    if (d > md) { md = d; mi = i; }
  }
  // Split if the chord deviates too much OR if collapsing to the chord would run
  // across non-navigable water — Douglas-Peucker must not shortcut a corner into
  // land/shallow. Consecutive points of the input are safe by construction
  // (grid-adjacent for A*, line-of-sight-checked for Theta*), so recursion
  // always converges to a navigable polyline.
  if (md > tol || !okSeg(pts[0], pts[pts.length - 1]))
    return simplify(pts.slice(0, mi + 1), tol, okSeg)
      .slice(0, -1)
      .concat(simplify(pts.slice(mi), tol, okSeg));
  return [pts[0], pts[pts.length - 1]];
}

addEventListener('message', ({ data }) => {
  try {
    const via: Pt[] = data.viaPoints || [];
    const rings: Pt[][] = data.rings || [];
    const resM: number = data.resM || 25;
    const clearanceM: number = data.clearanceM ?? 20; // keep off the shore
    // 'theta' (default) = any-angle Theta*; 'astar' = 8-connected grid A*.
    const theta: boolean = (data.algorithm ?? 'theta') !== 'astar';
    // centre bias: keep to the channel centre (default on). Off = shortest path.
    const centreBias: boolean = data.centreBias ?? true;
    if (via.length < 2) {
      postMessage({ ok: false, error: 'Need at least 2 waypoints.' });
      return;
    }
    if (!rings.length) {
      postMessage({ ok: false, error: 'No navigable-water data loaded — is the ENC safe-water asset present?' });
      return;
    }
    let full: Pt[] = [];
    for (let k = 0; k < via.length - 1; k++) {
      const leg = planLeg(via[k], via[k + 1], rings, resM, clearanceM, theta, centreBias);
      if (!leg) {
        postMessage({
          ok: false,
          error: `No safe path for leg ${k + 1} (waypoint ${k + 1} → ${k + 2}) — it may cross land or leave navigable water.`
        });
        return;
      }
      full = k === 0 ? leg : full.concat(leg.slice(1));
    }
    // Simplify (Douglas-Peucker), but never collapse a segment that would run
    // outside navigable water — sample the candidate chord and require every
    // point to be in a safe ring.
    const cosLat = Math.cos((via[0][1] * Math.PI) / 180) || 1;
    const tolM = Math.max(4, clearanceM / 3);
    const stepDeg = 5 / 111320; // ~5 m — fine enough to catch a thin corner clip
    const okSeg = (a: Pt, b: Pt): boolean => {
      const lenDeg = Math.hypot((b[0] - a[0]) * cosLat, b[1] - a[1]);
      const steps = Math.max(2, Math.min(4000, Math.ceil(lenDeg / stepDeg)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        if (!inSafe(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, rings))
          return false;
      }
      return true;
    };
    postMessage({ ok: true, route: simplify(full, tolM / (111320 * cosLat), okSeg) });
  } catch (e) {
    postMessage({ ok: false, error: String(e) });
  }
});
