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
import { Style, Stroke, Fill, Circle as CircleStyle, Text, Icon } from 'ol/style';
import { Point } from 'ol/geom';
import { fromLonLat } from 'ol/proj';
import { MapComponent } from '../map.component';
import { Extent, Coordinate } from '../models';
import { AsyncSubject } from 'rxjs';

// ** Freeboard Base Marker component **
@Component({
    selector: 'ol-map > fb-base-marker',
    template: '<ng-content></ng-content>',
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: false
})
export class BaseMarkerComponent implements OnInit, OnDestroy, OnChanges {
    protected layer: Layer;
    public source: VectorSource;
    protected features: Array<Feature>;

    /**
     * This event is triggered after the layer is initialized
     * Use this to have access to the layer and some helper functions
     */
    @Output() layerReady: AsyncSubject<Layer> = new AsyncSubject();

    @Input() position: Coordinate;
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
                if (key === 'position') {
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

        if (this.position) {
            // Create point feature for base marker
            const baseFeature = new Feature({
                geometry: new Point(fromLonLat(this.position))
            });
            baseFeature.setStyle(this.buildBaseMarkerStyle());
            fa.push(baseFeature);
        }

        this.features = fa;
    }

    // Build base marker style - home icon
    buildBaseMarkerStyle(): Style {
        // SVG home icon (Material Design home icon)
        const homeSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path fill="#1976D2" stroke="white" stroke-width="0.5" d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
      </svg>
    `;
        const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(homeSvg);

        return new Style({
            image: new Icon({
                src: svgDataUrl,
                scale: 1.2,
                anchor: [0.5, 1],  // Center bottom of icon at position
                anchorXUnits: 'fraction',
                anchorYUnits: 'fraction',
                rotateWithView: false
            })
        });
    }
}