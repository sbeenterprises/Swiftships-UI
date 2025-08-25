import {
  ChangeDetectionStrategy,
  Component,
  Input,
  Output,
  OnChanges,
  OnInit,
  SimpleChanges,
  ChangeDetectorRef,
  OnDestroy
} from '@angular/core';
import { Layer } from 'ol/layer';
import { AsyncSubject, BehaviorSubject, Subscription } from 'rxjs';
import ImageLayer from 'ol/layer/Image';
import ImageSource from 'ol/source/Image';
import { createLoader } from 'ol/source/static';
import { circular } from 'ol/geom/Polygon';
import { createEmpty } from 'ol/extent';
import { Coordinate } from 'ol/coordinate';
import { Position } from 'src/app/types';
import { RadarService, RadarSpoke, RadarConfig } from 'src/app/modules';
import { MapComponent } from '../map.component';

export interface ShipState {
  heading: number;
  location: Coordinate;
}

@Component({
  selector: 'ol-map > fb-radar',
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class RadarLayerComponent implements OnInit, OnChanges, OnDestroy {
  protected layer: ImageLayer<ImageSource>;
  private shipStateSubject = new BehaviorSubject<ShipState>({ 
    location: [0, 0], 
    heading: 0 
  });
  
  private subscriptions: Subscription[] = [];
  private radarCanvas: HTMLCanvasElement;
  private radarCtx: CanvasRenderingContext2D;
  private radarConfig: RadarConfig | null = null;
  private currentRange = 1852; // Default 1nm in meters
  private legend: number[][] = [];
  private updateExtentFunc: ((location: Coordinate, range: number) => void) | null = null;

  @Output() layerReady: AsyncSubject<Layer> = new AsyncSubject();
  @Input() position: Position = [0, 0];
  @Input() heading = 0;
  @Input() zIndex: number;
  @Input() visible = true;
  @Input() layerProperties: { [index: string]: any };

  constructor(
    private radarService: RadarService,
    protected mapComponent: MapComponent,
    protected changeDetectorRef: ChangeDetectorRef
  ) {
    this.changeDetectorRef.detach();
  }

  ngOnInit(): void {
    this.initializeRadarCanvas();
    this.setupRadarLayer();
    this.connectToRadarService();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.position || changes.heading) {
      const state: ShipState = {
        location: this.position,
        heading: this.heading * (180 / Math.PI) // Convert radians to degrees
      };
      this.shipStateSubject.next(state);
    }

    if (changes.visible && this.layer) {
      this.layer.setVisible(this.visible);
    }

    if (changes.zIndex && this.layer) {
      this.layer.setZIndex(this.zIndex);
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    
    const map = this.mapComponent.getMap();
    if (this.layer && map) {
      map.removeLayer(this.layer);
      map.render();
    }
    
    if (this.radarService.isConnected()) {
      this.radarService.disconnect();
    }
  }

  private initializeRadarCanvas(): void {
    this.radarCanvas = document.createElement('canvas');
    this.radarCanvas.width = 1024; // Default size, will be updated based on config
    this.radarCanvas.height = 1024;
    this.radarCtx = this.radarCanvas.getContext('2d')!;
  }

  private setupRadarLayer(): void {
    let radarExtent = createEmpty();
    
    const updateExtent = (location: Coordinate, range: number) => {
      const extent = circular(location, range)
        .transform('EPSG:4326', 'EPSG:3857')
        .getExtent();
      radarExtent[0] = extent[0];
      radarExtent[1] = extent[1]; 
      radarExtent[2] = extent[2];
      radarExtent[3] = extent[3];
    };
    
    // Store the function for later use
    this.updateExtentFunc = updateExtent;

    // Initialize extent
    updateExtent(this.position, this.currentRange);

    const imageSource = new ImageSource({
      loader: createLoader({
        imageExtent: radarExtent,
        url: "",
        load: () => Promise.resolve(this.radarCanvas)
      })
    });

    this.layer = new ImageLayer({
      source: imageSource,
      zIndex: this.zIndex,
      visible: this.visible,
      ...this.layerProperties
    });

    // Subscribe to position/range changes and update extent
    this.subscriptions.push(
      this.shipStateSubject.subscribe(state => {
        updateExtent(state.location, this.currentRange);
        this.refreshLayer();
      })
    );

    const map = this.mapComponent.getMap();
    if (this.layer && map) {
      map.addLayer(this.layer);
      map.render();
      this.layerReady.next(this.layer);
      this.layerReady.complete();
    }
  }

  private connectToRadarService(): void {
    // Subscribe to radar configuration
    this.subscriptions.push(
      this.radarService.radarConfig$.subscribe(config => {
        if (config) {
          this.radarConfig = config;
          this.currentRange = config.range;
          this.expandLegend(config.legend);
          this.updateRadarCanvas(config);
          // Update extent with new range
          if (this.updateExtentFunc) {
            const currentState = this.shipStateSubject.value;
            this.updateExtentFunc(currentState.location, this.currentRange);
          }
          this.refreshLayer();
        }
      })
    );

    // Subscribe to spoke data
    this.subscriptions.push(
      this.radarService.spokeData$.subscribe(spoke => {
        if (this.radarConfig) {
          this.drawSpoke(spoke);
          this.refreshLayer();
        }
      })
    );


    // Try to connect to radar
    if (!this.radarService.isConnected()) {
      this.radarService.connectToRadar().catch(error => {
        console.error('Failed to connect to radar service:', error);
      });
    }
  }

  private updateRadarCanvas(config: RadarConfig): void {
    if (config.maxSpokeLen > 0) {
      const size = 2 * config.maxSpokeLen;
      this.radarCanvas.width = size;
      this.radarCanvas.height = size;
      this.clearRadarCanvas();
    }
  }

  private expandLegend(legend: { [key: number]: { color: string } }): void {
    this.legend = [];
    for (let i = 0; i < 256; i++) {
      if (legend[i]) {
        const color = legend[i].color;
        this.legend.push(this.hexToRGBA(color));
      } else {
        this.legend.push([0, 0, 0, 0]); // Transparent for undefined colors
      }
    }
  }

  private hexToRGBA(hex: string): number[] {
    const rgba = [];
    for (let i = 1; i < hex.length; i += 2) {
      rgba.push(parseInt(hex.slice(i, i + 2), 16));
    }
    while (rgba.length < 4) {
      rgba.push(rgba.length === 3 ? 255 : 0);
    }
    return rgba;
  }

  private drawSpoke(spoke: RadarSpoke): void {
    if (!this.radarConfig || !this.legend.length) return;

    const centerX = this.radarCanvas.width / 2;
    const centerY = this.radarCanvas.height / 2;

    // Convert angle to radians and adjust for boat heading
    const adjustedAngle = (spoke.angle + (this.radarConfig.spokes * 3) / 4) % this.radarConfig.spokes;
    const angleRad = (2 * Math.PI * adjustedAngle) / this.radarConfig.spokes;
    
    // Apply boat heading correction
    const currentState = this.shipStateSubject.value;
    const headingRad = (currentState.heading * Math.PI) / 180;
    const finalAngle = angleRad - headingRad;

    const pixelsPerDataPoint = (Math.min(centerX, centerY) * 0.9) / spoke.data.length;
    const rangeScale = this.radarConfig.range ? spoke.range / this.radarConfig.range : 1;
    const scaledPixelsPerDataPoint = pixelsPerDataPoint * rangeScale;

    // Draw the spoke data
    this.radarCtx.save();
    this.radarCtx.translate(centerX, centerY);
    this.radarCtx.rotate(finalAngle);
    
    for (let i = 0; i < spoke.data.length; i++) {
      const value = spoke.data[i];
      const color = this.legend[Math.min(value, 255)];
      const distance = i * scaledPixelsPerDataPoint;
      
      if (color[3] > 0) { // Only draw if not transparent
        this.radarCtx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`;
        this.radarCtx.fillRect(distance, -0.5, scaledPixelsPerDataPoint, 1);
      }
    }
    
    this.radarCtx.restore();
  }

  private clearRadarCanvas(): void {
    this.radarCtx.clearRect(0, 0, this.radarCanvas.width, this.radarCanvas.height);
  }


  private refreshLayer(): void {
    if (this.layer && this.layer.getSource()) {
      this.layer.getSource().refresh();
    }
  }
}