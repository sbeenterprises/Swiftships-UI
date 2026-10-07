import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges
} from '@angular/core';
import { Layer } from 'ol/layer';
import { Feature } from 'ol';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Stroke, Fill, Text } from 'ol/style';
import { Circle, Point } from 'ol/geom';
import { fromLonLat } from 'ol/proj';
import { MapComponent } from '../map.component';
import { Extent, Coordinate } from '../models';
import { mapifyRadius } from '../util';
import { AsyncSubject } from 'rxjs';

/**
 * Range around the boat inside which collision avoidance engages a contact.
 *
 * Drawn because the limit is otherwise invisible: a vessel the boat sails
 * straight past is either outside this circle or a bug, and there is no way to
 * tell the two apart without seeing where the line is.
 */
@Component({
  selector: 'ol-map > fb-ais-range-circle',
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class AISRangeCircleComponent implements OnInit, OnDestroy, OnChanges {
  protected layer: Layer;
  public source: VectorSource;
  protected features: Array<Feature>;

  /** triggered once the layer is on the map */
  @Output() layerReady: AsyncSubject<Layer> = new AsyncSubject();

  @Input() position: Coordinate;
  @Input() radius: number; // metres
  @Input() label: string;
  @Input() opacity: number;
  @Input() visible: boolean;
  @Input() extent: Extent;
  @Input() zIndex: number;
  @Input() minResolution: number;
  @Input() maxResolution: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  @Input() layerProperties: { [index: string]: any };

  constructor(
    protected changeDetectorRef: ChangeDetectorRef,
    protected mapComponent: MapComponent
  ) {
    this.changeDetectorRef.detach();
  }

  ngOnInit() {
    this.parseValues();
    this.source = new VectorSource({ features: this.features });
    this.layer = new VectorLayer(
      Object.assign(this, { ...this.layerProperties })
    );

    const map = this.mapComponent.getMap();
    if (this.layer && map) {
      map.addLayer(this.layer);
      map.render();
      this.layerReady.next(this.layer);
      this.layerReady.complete();
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (this.layer) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const properties: { [index: string]: any } = {};

      for (const key in changes) {
        if (key === 'position' || key === 'radius' || key === 'label') {
          this.parseValues();
          if (this.source) {
            this.source.clear();
            this.source.addFeatures(this.features);
          }
        } else if (key === 'layerProperties') {
          this.layer.setProperties(properties, false);
        } else {
          properties[key] = changes[key].currentValue;
        }
      }
      this.layer.setProperties(properties, false);
    }
  }

  ngOnDestroy() {
    const map = this.mapComponent.getMap();
    if (this.layer && map) {
      map.removeLayer(this.layer);
      map.render();
      this.layer = null;
    }
  }

  parseValues() {
    const fa: Feature[] = [];

    if (this.position && this.radius > 0) {
      const centre = fromLonLat(this.position);
      const mapRadius = mapifyRadius(this.radius, this.position);

      const feature = new Feature({
        geometry: new Circle(centre, mapRadius)
      });
      feature.setStyle(this.buildCircleStyle());
      fa.push(feature);

      if (this.label) {
        // A Circle geometry draws its text at the centre, which is where the
        // boat is. The label goes on the rim instead, on its own point.
        const labelFeature = new Feature({
          geometry: new Point([centre[0], centre[1] + mapRadius])
        });
        labelFeature.setStyle(this.buildLabelStyle());
        fa.push(labelFeature);
      }
    }

    this.features = fa;
  }

  /**
   * No fill: this circle sits over the chart for the whole run, and a tint
   * that large would wash out the water underneath it.
   */
  buildCircleStyle(): Style {
    return new Style({
      fill: new Fill({ color: 'rgba(0, 0, 0, 0)' }),
      stroke: new Stroke({
        color: 'rgba(255, 183, 77, 0.9)',
        width: 2,
        lineDash: [10, 8]
      })
    });
  }

  buildLabelStyle(): Style {
    return new Style({
      text: new Text({
        text: this.label,
        font: 'bold 11px Roboto, sans-serif',
        fill: new Fill({ color: '#ffb74d' }),
        // Outlined rather than boxed: readable on a light chart and on an
        // inverted one, without another filled shape on the water.
        stroke: new Stroke({ color: 'rgba(18, 28, 38, 0.85)', width: 3 }),
        offsetY: -8,
        overflow: true
      })
    });
  }
}
