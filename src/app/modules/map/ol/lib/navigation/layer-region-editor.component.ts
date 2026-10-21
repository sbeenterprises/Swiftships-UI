import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EffectRef,
  Injector,
  Input,
  OnDestroy,
  OnInit,
  effect
} from '@angular/core';
import { Feature, MapBrowserEvent } from 'ol';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Stroke, Fill, Circle as CircleStyle, Text } from 'ol/style';
import { LineString, Point, Polygon } from 'ol/geom';
import { fromLonLat, toLonLat } from 'ol/proj';
import { EventsKey } from 'ol/events';
import { unByKey } from 'ol/Observable';
import { MapComponent } from '../map.component';
import { LonLat, RegionEditService } from '../../../region-edit.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MBE = MapBrowserEvent<any>;

/**
 * Operating-region editor on the map (state in RegionEditService):
 *  - drawing: each map click adds a corner (fb-map forwards the click), the
 *    shape and a rubber band to the cursor are shown; double-click or Enter
 *    finishes, Backspace removes the last corner, Esc cancels
 *  - drawing and adjusting: corners can be dragged
 * The line drawn here is the boat's HALT line.
 */
@Component({
  selector: 'ol-map > fb-region-editor',
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class RegionEditorComponent implements OnInit, OnDestroy {
  @Input() zIndex = 340;

  private layer: VectorLayer<VectorSource>;
  private source = new VectorSource();
  private keys: EventsKey[] = [];
  private dragIndex = -1;
  private renderEffect: EffectRef;
  private onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(
    protected changeDetectorRef: ChangeDetectorRef,
    protected mapComponent: MapComponent,
    private edit: RegionEditService,
    private injector: Injector
  ) {
    this.changeDetectorRef.detach();
  }

  ngOnInit() {
    const map = this.mapComponent.getMap();
    this.layer = new VectorLayer({ source: this.source, zIndex: this.zIndex });
    map?.addLayer(this.layer);
    if (map) {
      this.keys.push(
        map.on('pointermove', (e) => this.onPointerMove(e)),
        map.on('dblclick', (e) => this.onDoubleClick(e)),
        map.on('pointerdown' as never, (e: MBE) => this.onPointerDown(e)),
        map.on('pointerdrag', (e) => this.onPointerDrag(e)),
        map.on('pointerup' as never, () => this.onPointerUp())
      );
    }
    document.addEventListener('keydown', this.onKey);
    this.renderEffect = effect(
      () => {
        this.edit.mode();
        this.edit.coords();
        this.edit.cursor();
        this.render();
      },
      { injector: this.injector }
    );
  }

  ngOnDestroy() {
    unByKey(this.keys);
    document.removeEventListener('keydown', this.onKey);
    this.renderEffect?.destroy();
    this.mapComponent.getMap()?.removeLayer(this.layer);
  }

  // ---------------------------------------------------------------- events

  private onPointerMove(e: MBE) {
    if (this.edit.mode() !== 'drawing' || this.dragIndex >= 0) return;
    this.edit.cursor.set(toLonLat(e.coordinate) as LonLat);
  }

  private onDoubleClick(e: MBE): boolean {
    if (this.edit.mode() !== 'drawing') return true;
    this.edit.addPoint(toLonLat(e.coordinate) as LonLat);
    this.edit.finish();
    return false;   // no double-click zoom while drawing
  }

  private onPointerDown(e: MBE): boolean {
    if (!this.edit.active()) return true;
    const i = this.cornerAt(e.pixel);
    if (i < 0) return true;
    this.dragIndex = i;
    return false;   // the map does not pan while a corner is dragged
  }

  private onPointerDrag(e: MBE): boolean {
    if (this.dragIndex < 0) return true;
    this.edit.movePoint(this.dragIndex, toLonLat(e.coordinate) as LonLat);
    return false;
  }

  private onPointerUp() {
    this.dragIndex = -1;
  }

  private handleKey(e: KeyboardEvent) {
    if (!this.edit.active()) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Enter') {
      if (this.edit.finish()) e.preventDefault();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      this.edit.undo();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      this.edit.cancel();
      e.preventDefault();
    }
  }

  /** index of the corner under a pixel (within 12 px), else -1 */
  private cornerAt(pixel: number[]): number {
    const map = this.mapComponent.getMap();
    const c = this.edit.coords();
    for (let i = c.length - 1; i >= 0; i--) {
      const px = map.getPixelFromCoordinate(fromLonLat(c[i]));
      if (px && Math.hypot(px[0] - pixel[0], px[1] - pixel[1]) <= 12) return i;
    }
    return -1;
  }

  // ---------------------------------------------------------------- render

  private render() {
    this.source.clear();
    const mode = this.edit.mode();
    if (mode === 'idle') return;
    const c = this.edit.coords().map((p) => fromLonLat(p));
    const ok = this.edit.check().ok || c.length < 3;
    const lineColour = ok ? '#ff6b3d' : '#ff2d55';
    const feats: Feature[] = [];

    if (c.length >= 3) {
      const poly = new Feature(new Polygon([[...c, c[0]]]));
      poly.setStyle(
        new Style({
          fill: new Fill({ color: ok ? 'rgba(255, 107, 61, 0.12)' : 'rgba(255, 45, 85, 0.15)' }),
          stroke: new Stroke({ color: lineColour, width: 3 })
        })
      );
      feats.push(poly);
    } else if (c.length === 2) {
      const l = new Feature(new LineString(c));
      l.setStyle(new Style({ stroke: new Stroke({ color: lineColour, width: 3 }) }));
      feats.push(l);
    }

    const cur = this.edit.cursor();
    if (mode === 'drawing' && cur && c.length) {
      const pc = fromLonLat(cur);
      const band = new Feature(new LineString(c.length >= 2 ? [c[c.length - 1], pc, c[0]] : [c[0], pc]));
      band.setStyle(new Style({ stroke: new Stroke({ color: lineColour, width: 2, lineDash: [8, 6] }) }));
      feats.push(band);
    }

    c.forEach((p, i) => {
      const f = new Feature(new Point(p));
      f.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 7,
            fill: new Fill({ color: i === 0 ? '#ffffff' : lineColour }),
            stroke: new Stroke({ color: '#0d1a2c', width: 2 })
          }),
          text: new Text({
            text: `${i + 1}`,
            offsetY: -16,
            font: 'bold 11px sans-serif',
            fill: new Fill({ color: '#ffffff' }),
            stroke: new Stroke({ color: '#0d1a2c', width: 3 })
          })
        })
      );
      feats.push(f);
    });
    this.source.addFeatures(feats);
  }
}
