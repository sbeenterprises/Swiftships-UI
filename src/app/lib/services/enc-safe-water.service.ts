import { Injectable } from '@angular/core';
import MVT from 'ol/format/MVT';
import Feature from 'ol/Feature';
import { createXYZ } from 'ol/tilegrid';
import { toLonLat } from 'ol/proj';
import { AppFacade } from 'src/app/app.facade';
import { SKResourceService } from 'src/app/modules/skresources/resources.service';
import { SKChart } from 'src/app/modules/skresources/resource-classes';
import { PlannerLayer, PlannerPoly, PlannerWorld } from './route-planner.service';

export interface SafeWaterResult extends PlannerWorld {
  /** charts that contributed, most detailed first */
  charts: string[];
  /** things the operator must know before trusting a plan */
  warnings: string[];
}

/** S-57 object classes that are hazards regardless of depth */
const BLOCK_AREAS = ['LNDARE', 'PONTON', 'HULKES', 'DRYDOC', 'FLODOC'];
const BLOCK_POINTS = ['LNDARE', 'PILPNT', 'MORFAC'];
const BLOCK_LINES = ['SLCONS', 'COALNE', 'PONTON'];
/** hazards that are safe only when charted deeper than the safety depth */
const SOUNDED_HAZARDS = ['OBSTRN', 'WRECKS', 'UWTROC'];

const MAX_TILES_PER_CHART = 48;

/**
 * Reads the navigable water around a route straight from the S-57 vector
 * tiles the Signal K charts plugin serves (s57-tiler output), so planning uses
 * exactly the ENC data shown on the map. Only charts selected in the chart
 * list are used.
 *
 * Safe water: DEPARE / DRGARE whose DRVAL1 (shallowest depth in the area) is
 * at least the safety depth. Blocked: land, pontoons, hulks, docks; wrecks /
 * obstructions / rocks shallower than the safety depth or of unknown depth;
 * shoreline constructions and coastline as lines; piles and mooring dolphins.
 * Everything is kept per chart: where charts overlap, the most detailed one
 * covering a spot decides both its depth and its hazards.
 */
@Injectable({ providedIn: 'root' })
export class EncSafeWaterService {
  private format = new MVT<Feature>({ featureClass: Feature });
  private grid = createXYZ({ tileSize: 512 });

  constructor(
    private app: AppFacade,
    private skres: SKResourceService
  ) {}

  /** selected S-57 vector charts */
  encCharts(): SKChart[] {
    const sel = (this.app.config?.selections?.charts as string[]) || [];
    return this.skres
      .charts()
      .filter(
        (c) =>
          sel.includes(c[0]) &&
          `${c[1]?.type}`.toUpperCase() === 'S-57' &&
          `${c[1]?.format}`.toLowerCase() === 'pbf' &&
          !!c[1]?.url
      )
      .map((c) => c[1] as SKChart);
  }

  /**
   * @param bbox [minLon, minLat, maxLon, maxLat] area to load
   * @param safetyDepth metres; shallower water is not navigable
   */
  async load(bbox: number[], safetyDepth: number): Promise<SafeWaterResult> {
    const res: SafeWaterResult = { layers: [], charts: [], warnings: [] };
    const charts = this.encCharts()
      .filter((c) => !c.bounds || intersects(c.bounds, bbox))
      .sort((a, b) => usageBand(b) - usageBand(a));
    if (!charts.length) {
      res.warnings.push('No selected ENC chart covers this route.');
      return res;
    }
    const seen = new Set<string>();
    const warn = new Set<string>();

    for (const chart of charts) {
      const name = chart.name || chart.identifier;
      const area = chart.bounds ? clip(bbox, chart.bounds) : bbox;
      const tiles = await this.pickTiles(chart, area);
      if (!tiles.length) continue;
      // hazards belong to the chart: a small-scale chart draws a narrow pass
      // as land, so only the chart that decides a spot may block it
      const layer: PlannerLayer = {
        chart: name,
        coverage: [],
        safe: [],
        blocked: [],
        blockedPts: [],
        blockedLines: []
      };
      const band = usageBand(chart);
      if (band > 0 && band <= 2) {
        warn.add(`${name} is an overview chart (usage band ${band}); it is not meant for navigation.`);
      }

      const buffers = await Promise.all(tiles.map((t) => this.fetchTile(chart, t)));
      buffers.forEach((buf, k) => {
        if (!buf) return;
        const extent = this.grid.getTileCoordExtent(tiles[k]);
        let feats: Feature[] = [];
        try {
          // featureProjection is what makes OL scale tile pixels to map units
          feats = this.format.readFeatures(buf, {
            extent,
            featureProjection: 'EPSG:3857'
          });
        } catch {
          return;
        }
        for (const f of feats) {
          const objl = f.get('layer') as string;
          const g = f.getGeometry();
          if (!g) continue;
          // the same feature is repeated in every tile it touches
          const key = `${name}|${objl}|${g.getType()}|${g.getExtent().map((v) => Math.round(v)).join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const type = g.getType();

          if (objl === 'M_COVR' && f.get('CATCOV') === 1) {
            layer.coverage.push(...polys(g));
          } else if (objl === 'DEPARE' || objl === 'DRGARE') {
            const d1 = num(f.get('DRVAL1'));
            if (d1 !== null && d1 >= safetyDepth) layer.safe.push(...polys(g));
          } else if (BLOCK_AREAS.includes(objl) && isArea(type)) {
            layer.blocked.push(...polys(g));
          } else if (SOUNDED_HAZARDS.includes(objl)) {
            const v = num(f.get('VALSOU'));
            if (v !== null && v >= safetyDepth) continue;
            if (isArea(type)) layer.blocked.push(...polys(g));
            else if (type.includes('Point')) layer.blockedPts.push(...points(g));
            else layer.blockedLines.push(...lines(g));
          } else if (BLOCK_POINTS.includes(objl) && type.includes('Point')) {
            layer.blockedPts.push(...points(g));
          } else if (BLOCK_LINES.includes(objl) && type.includes('LineString')) {
            layer.blockedLines.push(...lines(g));
          } else if (objl === 'M_QUAL') {
            const zoc = num(f.get('CATZOC'));
            if (zoc !== null && zoc >= 5) {
              warn.add(`${name}: survey quality ${zoc === 6 ? 'unassessed' : 'poor'} (CATZOC ${zoc}).`);
            }
          } else if (objl === 'CTNARE') {
            const inform = `${f.get('INFORM') ?? ''}`;
            if (/omitted|not support safe navigation/i.test(inform)) {
              warn.add(`${name}: chart caution — ${inform}`);
            }
          }
        }
      });

      // no coverage polygons in the tiles: fall back to the chart bounds
      if (!layer.coverage.length && chart.bounds) {
        const [w, s, e, n] = chart.bounds;
        layer.coverage.push([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
      }
      res.layers.push(layer);
      res.charts.push(name);
    }
    res.warnings.push(...warn);
    return res;
  }

  /** highest zoom with tiles for this chart, at most MAX_TILES_PER_CHART tiles */
  private async pickTiles(chart: SKChart, area: number[]): Promise<number[][]> {
    const zMax = Math.min(chart.maxZoom ?? 16, 16);
    const zMin = Math.max(chart.minZoom ?? 0, 0);
    for (let z = zMax; z >= zMin; z--) {
      const r = tileRange(area, z);
      const count = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
      if (count > MAX_TILES_PER_CHART) continue;
      // s57-tiler only writes the zooms that suit the chart's scale: probe
      const probe = [z, Math.floor((r.x0 + r.x1) / 2), Math.floor((r.y0 + r.y1) / 2)];
      if (!(await this.fetchTile(chart, probe))) continue;
      const out: number[][] = [];
      for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) out.push([z, x, y]);
      return out;
    }
    return [];
  }

  private tileCache = new Map<string, Promise<ArrayBuffer | null>>();

  private fetchTile(chart: SKChart, t: number[]): Promise<ArrayBuffer | null> {
    const url = chart.url
      .replace('{z}', `${t[0]}`)
      .replace('{x}', `${t[1]}`)
      .replace('{y}', `${t[2]}`);
    if (!this.tileCache.has(url)) {
      this.tileCache.set(
        url,
        fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null)
      );
      if (this.tileCache.size > 400) {
        this.tileCache.delete(this.tileCache.keys().next().value);
      }
    }
    return this.tileCache.get(url);
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Charts that decide the water under a route: for each point, sampled every
 * ~25 m, the first (most detailed) layer whose coverage contains it.
 */
export function chartsAlong(route: number[][], layers: PlannerLayer[]): string[] {
  const used = new Set<string>();
  const inRing = (x: number, y: number, r: number[][]) => {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  };
  const inPoly = (x: number, y: number, p: PlannerPoly) =>
    inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h));
  const visit = (x: number, y: number) => {
    const L = layers.find((l) => !l.coverage.length || l.coverage.some((c) => inPoly(x, y, c)));
    if (L) used.add(L.chart);
  };
  for (let i = 0; i + 1 < route.length; i++) {
    const [ax, ay] = route[i];
    const [bx, by] = route[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot((bx - ax) * 96000, (by - ay) * 111000) / 25));
    for (let s = 0; s <= n; s++) visit(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n);
  }
  return layers.map((l) => l.chart).filter((c) => used.has(c));
}

/** ENC usage band from the cell name (US5LA12M -> 5); 0 when unknown */
function usageBand(c: SKChart): number {
  const m = /^[A-Z0-9]{2}([1-6])/.exec(`${c.identifier || c.name || ''}`.toUpperCase());
  return m ? +m[1] : 0;
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(`${v}`);
  return Number.isFinite(n) ? n : null;
}
function isArea(type: string): boolean {
  return type === 'Polygon' || type === 'MultiPolygon';
}
function intersects(a: number[], b: number[]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
function clip(a: number[], b: number[]): number[] {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
function tileRange(bbox: number[], z: number) {
  const n = 2 ** z;
  const tx = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)));
  };
  return { x0: tx(bbox[0]), x1: tx(bbox[2]), y0: ty(bbox[3]), y1: ty(bbox[1]) };
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const ll = (ring: number[][]) => ring.map((c) => toLonLat(c));
function polys(g: any): PlannerPoly[] {
  const t = g.getType();
  if (t === 'Polygon') return [g.getCoordinates().map(ll)];
  if (t === 'MultiPolygon') return g.getCoordinates().map((p: number[][][]) => p.map(ll));
  return [];
}
function points(g: any): number[][] {
  const t = g.getType();
  if (t === 'Point') return [toLonLat(g.getCoordinates())];
  if (t === 'MultiPoint') return g.getCoordinates().map((c: number[]) => toLonLat(c));
  return [];
}
function lines(g: any): number[][][] {
  const t = g.getType();
  if (t === 'LineString') return [ll(g.getCoordinates())];
  if (t === 'MultiLineString') return g.getCoordinates().map(ll);
  if (t === 'Polygon') return g.getCoordinates().map(ll);
  if (t === 'MultiPolygon') return g.getCoordinates().flat().map(ll);
  return [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */
