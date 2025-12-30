/***********************************
  Engine Status Component (all metrics as centered gauges)
  <engine-status>
***********************************/
import {
  Component,
  EventEmitter,
  Output,
  Input
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { CdkDrag } from '@angular/cdk/drag-drop';
import { NgxGaugeModule } from 'ngx-gauge';

export interface EngineData {
  acceleratorPedalPosition: number; // %
  percentLoad: number;              // %
  speed: number;                    // RPM
  percentTorque: number;            // %
  activeDtcs: number;               // count
  coolantTemp: number;              // °C
  oilTemp: number;                  // °C
  oilPressure: number;              // PSI
  fuelRate: number;                 // L/h
  intakeManifoldPressure: number;   // kPa
  batteryVoltage: number;           // V
}

@Component({
  selector: 'engine-status',
  standalone: true,
  imports: [
    CommonModule,
    MatTooltipModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    CdkDrag,
    NgxGaugeModule
  ],
  styleUrls: ['./engine-status.component.css'],
  template: `
    <div class="engine-status-panel" cdkDrag cdkDragHandle>
      <mat-card class="engine-status-card">
        <mat-card-header>
          <mat-card-title>
            <span style="display:flex;align-items:center;gap:8px;">
              <mat-icon>engineering</mat-icon>
              Engine Status
            </span>
            <button
              mat-icon-button
              class="close-button"
              (click)="handleClose()"
              matTooltip="Close"
            >
              <mat-icon>close</mat-icon>
            </button>
          </mat-card-title>
        </mat-card-header>

        <mat-card-content>
          <div class="status-sections">

            <!-- PERFORMANCE -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>speed</mat-icon> Performance
              </h4>

              <!-- Engine Load -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.percentLoad || 0"
                  [min]="0" [max]="100"
                  [label]="'Load %'"
                  [size]="gaugeSizeSm" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#4a6b8a'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="percentGenericThresholds">
                </ngx-gauge>
              </div>

              <!-- Engine Speed (RPM) -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.speed || 0"
                  [min]="0" [max]="rpmMax"
                  [label]="'RPM'"
                  [size]="gaugeSize" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#4a6b8a'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="rpmThresholds">
                </ngx-gauge>
              </div>

              <!-- Torque (%) -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.percentTorque || 0"
                  [min]="0" [max]="100"
                  [label]="'Torque %'"
                  [size]="gaugeSizeSm" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#a8d4ff'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="percentGenericThresholds">
                </ngx-gauge>
              </div>
            </div>

            <!-- TEMPERATURES -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>thermostat</mat-icon> Temperatures
              </h4>

              <!-- Coolant Temp -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.coolantTemp || 0"
                  [min]="0" [max]="120"
                  [label]="'Coolant °C'"
                  [size]="gaugeSize" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#ff6b6b'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="coolantThresholds">
                </ngx-gauge>
              </div>

              <!-- Oil Temp -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.oilTemp || 0"
                  [min]="0" [max]="150"
                  [label]="'Oil °C'"
                  [size]="gaugeSize" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#ffc107'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="oilTempThresholds">
                </ngx-gauge>
              </div>
            </div>

            <!-- PRESSURES & FLOW -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>compress</mat-icon> Pressures & Flow
              </h4>

              <!-- Oil Pressure -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.oilPressure || 0"
                  [min]="0" [max]="80"
                  [label]="'Oil PSI'"
                  [size]="gaugeSize" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#6bb6ff'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="oilPressureThresholds">
                </ngx-gauge>
              </div>

              <!-- Manifold Pressure (MAP) -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.intakeManifoldPressure || 0"
                  [min]="0" [max]="300"
                  [label]="'MAP kPa'"
                  [size]="gaugeSizeSm" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#4a6b8a'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="mapThresholds">
                </ngx-gauge>
              </div>
            </div>

            <!-- ELECTRICAL & DIAGNOSTICS -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>electrical_services</mat-icon> Electrical & Diagnostics
              </h4>

              <!-- Battery Voltage -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="engineData.batteryVoltage || 0"
                  [min]="10" [max]="16"
                  [label]="'Battery V'"
                  [size]="gaugeSize" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#a8d4ff'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="batteryThresholds">
                </ngx-gauge>
              </div>

              <!-- Active DTCs (visualized as % of nominal cap) -->
              <div class="gauge-center">
                <ngx-gauge
                  [type]="'semi'"
                  [value]="dtcPercent"
                  [min]="0" [max]="100"
                  [label]="'DTCs'"
                  [size]="gaugeSizeSm" [thick]="14" [cap]="'round'"
                  [foregroundColor]="'#ff6b6b'" [backgroundColor]="'#1e2d3e'"
                  [thresholds]="dtcThresholds">
                </ngx-gauge>
              </div>
            </div>

          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `
})
export class EngineStatusComponent {
  @Input() engineData: EngineData = {
    acceleratorPedalPosition: 0,
    percentLoad: 0,
    speed: 0,
    percentTorque: 0,
    activeDtcs: 0,
    coolantTemp: 0,
    oilTemp: 0,
    oilPressure: 0,
    fuelRate: 0,
    intakeManifoldPressure: 0,
    batteryVoltage: 0
  };

  @Output() closed = new EventEmitter<void>();

  // --- Gauge sizing (px) ---
  gaugeSize = 220;
  gaugeSizeSm = 180;

  // --- Domain assumptions / ranges ---
  rpmMax = 6000;

  // --- Threshold bands ---
  percentGenericThresholds = [
    { from: 0, color: '#4a6b8a' },
    { from: 70, color: '#ffc107' },
    { from: 90, color: '#ff6b6b' }
  ];

  rpmThresholds = [
    { from: 0, color: '#4a6b8a' },
    { from: 4000, color: '#ffc107' },
    { from: 5200, color: '#ff6b6b' }
  ];

  coolantThresholds = [
    { from: 0, color: '#4a6b8a' },
    { from: 95, color: '#ffc107' },
    { from: 100, color: '#ff6b6b' }
  ];

  oilTempThresholds = [
    { from: 0, color: '#4a6b8a' },
    { from: 110, color: '#ffc107' },
    { from: 125, color: '#ff6b6b' }
  ];

  oilPressureThresholds = [
    { from: 0, color: '#ff6b6b' }, // too low
    { from: 10, color: '#ffc107' }, // low
    { from: 20, color: '#6bb6ff' }  // ok+
  ];

  fuelRateThresholds = [
    { from: 0, color: '#4a6b8a' },
    { from: 40, color: '#ffc107' },
    { from: 50, color: '#ff6b6b' }
  ];

  mapThresholds = [
    { from: 0, color: '#4a6b8a' },
    { from: 180, color: '#ffc107' },
    { from: 220, color: '#ff6b6b' }
  ];

  batteryThresholds = [
    { from: 10.0, color: '#ff6b6b' }, // under-voltage
    { from: 12.0, color: '#ffc107' }, // low
    { from: 13.2, color: '#4a6b8a' }, // normal charging
    { from: 14.8, color: '#ffc107' }  // high
  ];

  dtcThresholds = [
    { from: 0, color: '#4a6b8a' },
    { from: 25, color: '#ffc107' },
    { from: 50, color: '#ff6b6b' }
  ];

  // Visualize DTCs as percent of a nominal cap (e.g., 8)
  get dtcPercent(): number {
    const cap = 8;
    const v = Math.min(this.engineData.activeDtcs, cap);
    return (v / cap) * 100;
  }

  protected handleClose(): void {
    this.closed.emit();
  }
}
