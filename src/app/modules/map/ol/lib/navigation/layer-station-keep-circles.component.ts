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
import { Style, Stroke, Fill } from 'ol/style';
import { Circle } from 'ol/geom';
import { fromLonLat } from 'ol/proj';
import { MapComponent } from '../map.component';
import { Extent, Coordinate } from '../models';
import { mapifyRadius } from '../util';
import { AsyncSubject } from 'rxjs';

// ** Freeboard Station Keep Circles component **
@Component({
  selector: 'ol-map > fb-station-keep-circles',
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class StationKeepCirclesComponent implements OnInit, OnDestroy, OnChanges {
  protected layer: Layer;
  public source: VectorSource;
  protected features: Array<Feature>;

  /**
   * This event is triggered after the layer is initialized
   * Use this to have access to the layer and some helper functions
   */
  @Output() layerReady: AsyncSubject<Layer> = new AsyncSubject(); // AsyncSubject will only store the last value, and only publish it when the sequence is completed

  @Input() position: Coordinate;
  @Input() innerRadius: number;
  @Input() outerRadius: number;
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
        if (key === 'position' || key === 'innerRadius' || key === 'outerRadius') {
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


    if (this.position && this.innerRadius && this.outerRadius) {
      // Inner circle
      const innerFeature = new Feature({
        geometry: new Circle(
          fromLonLat(this.position),
          mapifyRadius(this.innerRadius, this.position)
        )
      });
      innerFeature.setStyle(this.buildInnerCircleStyle());
      fa.push(innerFeature);

      // Outer circle
      const outerFeature = new Feature({
        geometry: new Circle(
          fromLonLat(this.position),
          mapifyRadius(this.outerRadius, this.position)
        )
      });
      outerFeature.setStyle(this.buildOuterCircleStyle());
      fa.push(outerFeature);
    }

    this.features = fa;
  }

  // Build inner circle style
  buildInnerCircleStyle(): Style {
    return new Style({
      fill: new Fill({ color: 'rgba(0, 255, 0, 0.1)' }), // Light green fill
      stroke: new Stroke({
        color: 'rgba(0, 200, 0, 0.8)', // Green stroke
        width: 2,
        lineDash: [8, 4] // Dashed line
      })
    });
  }

  // Build outer circle style
  buildOuterCircleStyle(): Style {
    return new Style({
      fill: new Fill({ color: 'rgba(255, 165, 0, 0.1)' }), // Light orange fill
      stroke: new Stroke({
        color: 'rgba(255, 140, 0, 0.8)', // Orange stroke
        width: 2,
        lineDash: [12, 6] // Different dash pattern
      })
    });
  }
}