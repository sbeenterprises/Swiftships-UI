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
  
  // Mayara-style optimizations
  private patternCanvas: HTMLCanvasElement;
  private patternCtx: CanvasRenderingContext2D;
  private imageData: ImageData;
  private renderPending = false;

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
    
    // Create pattern canvas like Mayara (for efficient spoke rendering)
    this.patternCanvas = document.createElement('canvas');
    this.patternCanvas.width = 2048; // Match Mayara's pattern size
    this.patternCanvas.height = 1;
    this.patternCtx = this.patternCanvas.getContext('2d')!;
    this.imageData = this.patternCtx.createImageData(2048, 1);
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
      this.radarCtx.clearRect(0, 0, this.radarCanvas.width, this.radarCanvas.height);
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

    // Clear the old spoke area before drawing the new one
    this.clearSpokeArea(spoke);
    
    // Render the new spoke
    this.renderSpokeMayaraStyle(spoke);
    
    // Schedule layer refresh (batched using requestAnimationFrame)
    if (!this.renderPending) {
      this.renderPending = true;
      requestAnimationFrame(() => {
        this.refreshLayer();
        this.renderPending = false;
      });
    }
  }

  private renderSpokeMayaraStyle(spoke: RadarSpoke): void {
    const centerX = this.radarCanvas.width / 2;
    const centerY = this.radarCanvas.height / 2;
    const beamLength = Math.min(centerX, centerY) * 0.9;
    
    // Calculate angle (same logic as Mayara)
    const adjustedAngle = (spoke.angle + (this.radarConfig!.spokes * 3) / 4) % this.radarConfig!.spokes;
    const angleRad = (2 * Math.PI * adjustedAngle) / this.radarConfig!.spokes;
    
    // Apply heading correction
    const currentState = this.shipStateSubject.value;
    const headingRad = (currentState.heading * Math.PI) / 180;
    const finalAngle = angleRad - headingRad;
    
    // Calculate pixels per data point
    let pixelsPerItem = (beamLength * 0.9) / spoke.data.length;
    if (this.radarConfig!.range && spoke.range) {
      pixelsPerItem = (pixelsPerItem * spoke.range) / this.radarConfig!.range;
    }
    
    // Mayara's transform approach
    const cosA = Math.cos(finalAngle) * pixelsPerItem;
    const sinA = Math.sin(finalAngle) * pixelsPerItem;
    
    // Fill ImageData with spoke colors (reuse same ImageData object like Mayara)
    for (let i = 0, idx = 0; i < spoke.data.length && i < 2048; i++, idx += 4) {
      const value = spoke.data[i];
      const color = this.legend[Math.min(value, 255)] || [0, 0, 0, 0];
      
      this.imageData.data[idx] = color[0];     // Red
      this.imageData.data[idx + 1] = color[1]; // Green  
      this.imageData.data[idx + 2] = color[2]; // Blue
      this.imageData.data[idx + 3] = color[3]; // Alpha
    }
    
    // Put ImageData to pattern canvas
    this.patternCtx.putImageData(this.imageData, 0, 0);
    
    // Create pattern and draw (Mayara's approach)
    const pattern = this.radarCtx.createPattern(this.patternCanvas, 'repeat-x');
    const arcAngle = (2 * Math.PI) / this.radarConfig!.spokes;
    
    this.radarCtx.setTransform(cosA, sinA, -sinA, cosA, centerX, centerY);
    this.radarCtx.fillStyle = pattern!;
    this.radarCtx.beginPath();
    this.radarCtx.moveTo(0, 0);
    this.radarCtx.arc(0, 0, spoke.data.length, 0, arcAngle);
    this.radarCtx.closePath();
    this.radarCtx.fill();
    
    // Reset transform
    this.radarCtx.setTransform(1, 0, 0, 1, 0, 0);
  }



  private clearSpokeArea(spoke: RadarSpoke): void {
    if (!this.radarConfig) return;
    
    const centerX = this.radarCanvas.width / 2;
    const centerY = this.radarCanvas.height / 2;
    const beamLength = Math.min(centerX, centerY) * 0.9;
    
    // Calculate angle (same logic as renderSpokeMayaraStyle)
    const adjustedAngle = (spoke.angle + (this.radarConfig.spokes * 3) / 4) % this.radarConfig.spokes;
    const angleRad = (2 * Math.PI * adjustedAngle) / this.radarConfig.spokes;
    
    // Apply heading correction
    const currentState = this.shipStateSubject.value;
    const headingRad = (currentState.heading * Math.PI) / 180;
    const finalAngle = angleRad - headingRad;
    
    // Calculate spoke width for clearing
    const spokeWidth = (2 * Math.PI) / this.radarConfig.spokes;
    const clearWidth = spokeWidth * 1.5; // Slightly wider to ensure complete clearing
    
    // Clear the wedge-shaped area for this spoke
    this.radarCtx.save();
    this.radarCtx.translate(centerX, centerY);
    
    this.radarCtx.beginPath();
    this.radarCtx.moveTo(0, 0);
    this.radarCtx.arc(0, 0, beamLength, finalAngle - clearWidth/2, finalAngle + clearWidth/2);
    this.radarCtx.closePath();
    this.radarCtx.clip();
    
    // Clear the entire clipped area
    this.radarCtx.clearRect(-beamLength, -beamLength, beamLength * 2, beamLength * 2);
    
    this.radarCtx.restore();
  }

  private refreshLayer(): void {
    if (this.layer && this.layer.getSource()) {
      this.layer.getSource().refresh();
    }
  }
}