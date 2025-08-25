import { Component, ElementRef, ViewChild, OnInit, OnDestroy, Input } from '@angular/core';

export interface RadarSpoke {
  angle: number;
  bearing?: number;
  range: number;
  data: Uint8Array;
}

export interface RadarConfig {
  spokes: number;
  maxSpokeLen: number;
  legend: { [key: number]: { color: string } };
  range: number;
}

@Component({
  selector: 'app-radar-display',
  template: `
    <div class="radar-container" [style.width.px]="width" [style.height.px]="height">
      <canvas #backgroundCanvas class="radar-canvas"></canvas>
      <canvas #radarCanvas class="radar-canvas"></canvas>
    </div>
  `,
  styles: [`
    .radar-container {
      position: relative;
      background-color: #000;
    }
    .radar-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
  `]
})
export class RadarDisplayComponent implements OnInit, OnDestroy {
  @ViewChild('backgroundCanvas', { static: true }) backgroundCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('radarCanvas', { static: true }) radarCanvasRef!: ElementRef<HTMLCanvasElement>;

  @Input() width = 600;
  @Input() height = 600;
  @Input() boatHeading = 0; // Current boat heading in degrees

  private backgroundCtx!: CanvasRenderingContext2D;
  private radarCtx!: CanvasRenderingContext2D;
  private centerX!: number;
  private centerY!: number;
  private maxRadius!: number;
  private config!: RadarConfig;
  private legend: number[][] = [];

  // Range scale factor (similar to Mayara's RANGE_SCALE = 0.9)
  private readonly RANGE_SCALE = 0.9;

  ngOnInit() {
    this.initializeCanvases();
  }

  ngOnDestroy() {
    // Clean up any resources if needed
  }

  private initializeCanvases() {
    const backgroundCanvas = this.backgroundCanvasRef.nativeElement;
    const radarCanvas = this.radarCanvasRef.nativeElement;

    backgroundCanvas.width = this.width;
    backgroundCanvas.height = this.height;
    radarCanvas.width = this.width;
    radarCanvas.height = this.height;

    this.backgroundCtx = backgroundCanvas.getContext('2d')!;
    this.radarCtx = radarCanvas.getContext('2d')!;

    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.maxRadius = Math.min(this.centerX, this.centerY) * this.RANGE_SCALE;

    this.drawBackground();
  }

  setRadarConfig(config: RadarConfig) {
    this.config = config;
    this.expandLegend(config.legend);
    this.drawBackground();
  }

  private expandLegend(legend: { [key: number]: { color: string } }) {
    this.legend = [];
    for (let i = 0; i < 256; i++) {
      if (legend[i]) {
        const color = legend[i].color;
        this.legend.push(this.hexToRGBA(color));
      } else {
        this.legend.push([0, 0, 0, 0]); // Transparent for undefined colors
      }
    }
    // Make background color visible
    if (this.legend[0]) {
      this.legend[0][3] = 255;
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

  drawSpoke(spoke: RadarSpoke) {
    if (!this.config || !this.legend.length) return;

    // Convert angle to radians, adjusting for boat-centered display
    // In Mayara: angle 0 = front of boat, we add 3/4 rotation to make north up
    const adjustedAngle = (spoke.angle + (this.config.spokes * 3) / 4) % this.config.spokes;
    const angleRad = (2 * Math.PI * adjustedAngle) / this.config.spokes;

    // Apply boat heading correction to keep boat centered with heading up
    const headingRad = (this.boatHeading * Math.PI) / 180;
    const finalAngle = angleRad - headingRad;

    const pixelsPerDataPoint = (this.maxRadius * this.RANGE_SCALE) / spoke.data.length;
    const rangeScale = this.config.range ? spoke.range / this.config.range : 1;
    const scaledPixelsPerDataPoint = pixelsPerDataPoint * rangeScale;

    const cosAngle = Math.cos(finalAngle) * scaledPixelsPerDataPoint;
    const sinAngle = Math.sin(finalAngle) * scaledPixelsPerDataPoint;

    // Create image data for this spoke
    const spokeLength = spoke.data.length;
    const imageData = this.radarCtx.createImageData(spokeLength, 1);

    for (let i = 0; i < spokeLength; i++) {
      const value = spoke.data[i];
      const colorIdx = Math.min(value, 255);
      const color = this.legend[colorIdx];

      const pixelIdx = i * 4;
      imageData.data[pixelIdx] = color[0];     // Red
      imageData.data[pixelIdx + 1] = color[1]; // Green  
      imageData.data[pixelIdx + 2] = color[2]; // Blue
      imageData.data[pixelIdx + 3] = color[3]; // Alpha
    }

    // Draw the spoke data as a line from center outward
    this.radarCtx.save();
    this.radarCtx.translate(this.centerX, this.centerY);
    this.radarCtx.rotate(finalAngle);
    
    // Draw each data point along the spoke
    for (let i = 0; i < spokeLength; i++) {
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

  private drawBackground() {
    this.backgroundCtx.clearRect(0, 0, this.width, this.height);
    
    // Set styles for range rings
    this.backgroundCtx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    this.backgroundCtx.fillStyle = 'white';
    this.backgroundCtx.font = '12px Arial';
    this.backgroundCtx.lineWidth = 1;

    // Draw range rings (4 rings like in Mayara)
    for (let i = 1; i <= 4; i++) {
      const radius = (i * this.maxRadius) / 4;
      
      this.backgroundCtx.beginPath();
      this.backgroundCtx.arc(this.centerX, this.centerY, radius, 0, 2 * Math.PI);
      this.backgroundCtx.stroke();
      
      // Draw range labels
      if (this.config && this.config.range) {
        const rangeValue = (this.config.range * i) / 4;
        const text = this.formatRange(rangeValue);
        
        // Position label at 45 degrees (top-right)
        const labelX = this.centerX + radius * Math.cos(-Math.PI / 4);
        const labelY = this.centerY + radius * Math.sin(-Math.PI / 4);
        
        this.backgroundCtx.fillText(text, labelX + 5, labelY - 5);
      }
    }

    // Draw center crosshairs
    this.backgroundCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    this.backgroundCtx.beginPath();
    // Vertical line
    this.backgroundCtx.moveTo(this.centerX, this.centerY - 10);
    this.backgroundCtx.lineTo(this.centerX, this.centerY + 10);
    // Horizontal line
    this.backgroundCtx.moveTo(this.centerX - 10, this.centerY);
    this.backgroundCtx.lineTo(this.centerX + 10, this.centerY);
    this.backgroundCtx.stroke();

    // Draw boat icon in center (simple triangle pointing up)
    this.backgroundCtx.fillStyle = 'yellow';
    this.backgroundCtx.beginPath();
    this.backgroundCtx.moveTo(this.centerX, this.centerY - 8);
    this.backgroundCtx.lineTo(this.centerX - 4, this.centerY + 6);
    this.backgroundCtx.lineTo(this.centerX + 4, this.centerY + 6);
    this.backgroundCtx.closePath();
    this.backgroundCtx.fill();
  }

  private formatRange(rangeInMeters: number): string {
    // Convert to nautical miles if > 1852m (1 nm)
    if (rangeInMeters >= 1852) {
      const nm = rangeInMeters / 1852;
      if (nm === Math.floor(nm)) {
        return `${nm} nm`;
      } else {
        return `${nm.toFixed(1)} nm`;
      }
    } else if (rangeInMeters >= 1000) {
      return `${(rangeInMeters / 1000).toFixed(1)} km`;
    } else {
      return `${Math.round(rangeInMeters)} m`;
    }
  }

  clearDisplay() {
    this.radarCtx.clearRect(0, 0, this.width, this.height);
  }
}