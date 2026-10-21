/** Operating-region editor state (Autonomous panel <-> map)
 *
 * The region polygon the operator draws is the boat's HALT line: the boat
 * works inside it, shrunk by the boat's region_margin (iWebSocket), and the
 * helm stops it on or just inside this line. Any shape is allowed as long as
 * its edges do not cross.
 *
 * Coordinates are [lon, lat], open ring (last corner != first).
 * ************************************/
import { Injectable, computed, signal } from '@angular/core';

export type RegionEditMode = 'idle' | 'drawing' | 'adjust';
export type LonLat = [number, number];

export interface RegionCheck {
  ok: boolean;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class RegionEditService {
  readonly mode = signal<RegionEditMode>('idle');
  readonly coords = signal<LonLat[]>([]);
  readonly cursor = signal<LonLat | null>(null);
  /** Signal K id of the region being edited; null = a new region */
  readonly editingId = signal<string | null>(null);
  readonly name = signal<string>('');

  readonly active = computed(() => this.mode() !== 'idle');
  readonly check = computed<RegionCheck>(() => checkRegion(this.coords()));

  /** start drawing a new region from scratch */
  startDrawing(name = '') {
    this.coords.set([]);
    this.editingId.set(null);
    this.name.set(name);
    this.cursor.set(null);
    this.mode.set('drawing');
  }

  /** open a shape (existing region, or one generated around a route) for adjusting */
  startAdjusting(coords: LonLat[], id: string | null, name: string) {
    this.coords.set(openRing(coords));
    this.editingId.set(id);
    this.name.set(name);
    this.cursor.set(null);
    this.mode.set('adjust');
  }

  addPoint(p: LonLat) {
    if (this.mode() !== 'drawing') return;
    const c = this.coords();
    const last = c[c.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) return;
    this.coords.set([...c, p]);
  }

  undo() {
    const c = this.coords();
    if (c.length === 0) return;
    this.coords.set(c.slice(0, -1));
    if (this.mode() === 'adjust' && c.length - 1 < 3) this.mode.set('drawing');
  }

  /** stop adding corners; the shape can still be adjusted */
  finish(): boolean {
    if (this.mode() !== 'drawing' || this.coords().length < 3) return false;
    this.cursor.set(null);
    this.mode.set('adjust');
    return true;
  }

  /** go back to adding corners at the end of the ring */
  continueDrawing() {
    if (this.mode() === 'adjust') this.mode.set('drawing');
  }

  movePoint(i: number, p: LonLat) {
    const c = [...this.coords()];
    if (i < 0 || i >= c.length) return;
    c[i] = p;
    this.coords.set(c);
  }

  /** remove one corner (keeps at least 3 once adjusting) */
  removePoint(i: number) {
    const c = [...this.coords()];
    if (i < 0 || i >= c.length || (this.mode() === 'adjust' && c.length <= 3)) return;
    c.splice(i, 1);
    this.coords.set(c);
  }

  cancel() {
    this.mode.set('idle');
    this.coords.set([]);
    this.cursor.set(null);
    this.editingId.set(null);
  }

  /** closed ring for a GeoJSON Polygon */
  closedRing(): LonLat[] {
    const c = this.coords();
    return c.length ? [...c, c[0]] : [];
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers (local metres around the first point; ample for a region)

const M_PER_DEG_LAT = 111320;

function toLocal(ring: LonLat[]): { x: number; y: number }[] {
  if (!ring.length) return [];
  const lat0 = ring[0][1];
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return ring.map((p) => ({ x: (p[0] - ring[0][0]) * kx, y: (p[1] - ring[0][1]) * M_PER_DEG_LAT }));
}

function openRing(c: LonLat[]): LonLat[] {
  const r = c.map((p) => [p[0], p[1]] as LonLat);
  while (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r;
}

function cross(o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segsCross(
  a: { x: number; y: number }, b: { x: number; y: number },
  c: { x: number; y: number }, d: { x: number; y: number }
): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p, q, r) =>
    Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 &&
    Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;
  if (Math.abs(d1) < 1e-9 && on(c, d, a)) return true;
  if (Math.abs(d2) < 1e-9 && on(c, d, b)) return true;
  if (Math.abs(d3) < 1e-9 && on(a, b, c)) return true;
  if (Math.abs(d4) < 1e-9 && on(a, b, d)) return true;
  return false;
}

export function ringSelfIntersects(ring: LonLat[]): boolean {
  const p = toLocal(openRing(ring));
  const n = p.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}

export function ringAreaM2(ring: LonLat[]): number {
  const p = toLocal(openRing(ring));
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a / 2);
}

/** Same checks the boat makes before it accepts a region. */
export function checkRegion(ring: LonLat[]): RegionCheck {
  const r = openRing(ring);
  if (r.length < 3) return { ok: false, message: `Add at least ${3 - r.length} more corner${r.length === 2 ? '' : 's'}` };
  if (ringSelfIntersects(r)) return { ok: false, message: 'Edges cross each other: move or remove a corner' };
  if (ringAreaM2(r) < 1) return { ok: false, message: 'The region has no area' };
  return { ok: true, message: '' };
}

/**
 * A region following a route: the route's centreline widened by halfWidthM
 * on each side (mitred corners, bevelled where very sharp; ends extended by
 * the half width). null if the route is too twisty for that width.
 */
export function regionAroundRoute(route: LonLat[], halfWidthM: number): LonLat[] | null {
  const pts = route.filter((p, i) => i === 0 || p[0] !== route[i - 1][0] || p[1] !== route[i - 1][1]);
  if (pts.length < 2 || !(halfWidthM > 0)) return null;
  const lat0 = pts[0][1], lon0 = pts[0][0];
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map((p) => ({ x: (p[0] - lon0) * kx, y: (p[1] - lat0) * M_PER_DEG_LAT }));
  const back = (q: { x: number; y: number }): LonLat => [lon0 + q.x / kx, lat0 + q.y / M_PER_DEG_LAT];

  // extend both ends by the half width so the ends are inside, not on the line
  const ext = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: a.x + ((a.x - b.x) / L) * halfWidthM, y: a.y + ((a.y - b.y) / L) * halfWidthM };
  };
  xy[0] = ext(xy[0], xy[1]);
  xy[xy.length - 1] = ext(xy[xy.length - 1], xy[xy.length - 2]);

  const side = (sgn: number) => {
    const out: { x: number; y: number }[] = [];
    const n = xy.length;
    const off = (i: number) => {
      const a = xy[i], b = xy[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = (-(b.y - a.y) / L) * halfWidthM * sgn, ny = ((b.x - a.x) / L) * halfWidthM * sgn;
      return { a: { x: a.x + nx, y: a.y + ny }, b: { x: b.x + nx, y: b.y + ny } };
    };
    out.push(off(0).a);
    for (let i = 1; i < n - 1; i++) {
      const s1 = off(i - 1), s2 = off(i);
      const d1 = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
      const d2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
      const den = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(den) < 1e-9) { out.push(s1.b); continue; }
      const t = ((s2.a.x - s1.a.x) * d2.y - (s2.a.y - s1.a.y) * d2.x) / den;
      const m = { x: s1.a.x + t * d1.x, y: s1.a.y + t * d1.y };
      if (Math.hypot(m.x - xy[i].x, m.y - xy[i].y) > 2.5 * halfWidthM) {
        out.push(s1.b, s2.a);           // very sharp outer corner: bevel
      } else {
        out.push(m);
      }
    }
    out.push(off(n - 2).b);
    return out;
  };
  const left = side(1), right = side(-1);
  const ring = [...left, ...right.reverse()].map(back);
  return ringSelfIntersects(ring) ? null : ring;
}
