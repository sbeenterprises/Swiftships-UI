import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges
} from '@angular/core';
import { Feature } from 'ol';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Stroke, Fill, Circle as CircleStyle } from 'ol/style';
import { LineString, MultiPolygon, Point } from 'ol/geom';
import { fromLonLat } from 'ol/proj';
import { MapComponent } from '../map.component';

/**
 * Autonomy planning overlay:
 *  - `route`: a safe route proposed by the ENC planner (dashed, not yet saved)
 *  - `corridor`: the route corridor sent to the boat (centreline + band)
 * Both are [lon,lat] polylines.
 */
@Component({
  selector: 'ol-map > fb-route-preview',
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class RoutePreviewComponent implements OnInit, OnDestroy, OnChanges {
  @Input() route: number[][] | null;
  @Input() corridor: { pts: number[][]; width: number } | null;
  @Input() zIndex = 330;

  private layer: VectorLayer<VectorSource>;
  private source = new VectorSource();

  constructor(
    protected changeDetectorRef: ChangeDetectorRef,
    protected mapComponent: MapComponent
  ) {
    this.changeDetectorRef.detach();
  }

  ngOnInit() {
    this.layer = new VectorLayer({ source: this.source, zIndex: this.zIndex });
    this.mapComponent.getMap()?.addLayer(this.layer);
    this.render();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (this.layer && (changes.route || changes.corridor)) this.render();
  }

  ngOnDestroy() {
    this.mapComponent.getMap()?.removeLayer(this.layer);
  }

  private render() {
    this.source.clear();
    if (this.corridor?.pts?.length > 1 && this.corridor.width > 0) {
      const band = new Feature(
        new MultiPolygon(corridorBand(this.corridor.pts, this.corridor.width / 2))
      );
      band.setStyle(
        new Style({
          fill: new Fill({ color: 'rgba(160, 120, 255, 0.18)' }),
          stroke: new Stroke({ color: 'rgba(160, 120, 255, 0.0)', width: 0 })
        })
      );
      const centre = new Feature(new LineString(this.corridor.pts.map((p) => fromLonLat(p))));
      centre.setStyle(
        new Style({ stroke: new Stroke({ color: 'rgba(160, 120, 255, 0.9)', width: 2 }) })
      );
      this.source.addFeatures([band, centre]);
    }
    if (this.route?.length > 1) {
      const line = new Feature(new LineString(this.route.map((p) => fromLonLat(p))));
      line.setStyle([
        new Style({ stroke: new Stroke({ color: 'rgba(13, 26, 44, 0.8)', width: 6 }) }),
        new Style({
          stroke: new Stroke({ color: '#e8912d', width: 3, lineDash: [10, 6] })
        })
      ]);
      const vertex = new Style({
        image: new CircleStyle({
          radius: 3,
          fill: new Fill({ color: '#e8912d' }),
          stroke: new Stroke({ color: '#0d1a2c', width: 1 })
        })
      });
      const pts = this.route.map((p) => {
        const f = new Feature(new Point(fromLonLat(p)));
        f.setStyle(vertex);
        return f;
      });
      this.source.addFeatures([line, ...pts]);
    }
  }
}

/**
 * Corridor band as one polygon per segment plus a disc at each vertex, all in
 * map coordinates with the same winding, so the band fills once where they
 * overlap. halfM is the half width in metres.
 */
function corridorBand(pts: number[][], halfM: number): number[][][][] {
  const xy = pts.map((p) => fromLonLat(p));
  // Web Mercator stretches distances by 1/cos(lat)
  const k = 1 / Math.cos((pts[0][1] * Math.PI) / 180);
  const h = halfM * k;
  const out: number[][][][] = [];
  for (let i = 0; i + 1 < xy.length; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[i + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * h;
    const ny = ((bx - ax) / len) * h;
    out.push([[
      [ax - nx, ay - ny],
      [bx - nx, by - ny],
      [bx + nx, by + ny],
      [ax + nx, ay + ny],
      [ax - nx, ay - ny]
    ]]);
  }
  for (const [x, y] of xy) {
    const ring: number[][] = [];
    for (let a = 0; a <= 24; a++) {
      const t = (a / 24) * 2 * Math.PI;
      ring.push([x + h * Math.cos(t), y + h * Math.sin(t)]);
    }
    out.push([ring]);
  }
  return out;
}
