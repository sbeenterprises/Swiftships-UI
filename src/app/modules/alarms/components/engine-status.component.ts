/***********************************
  Engine Status Component
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

export interface EngineData {
  acceleratorPedalPosition: number;
  percentLoad: number;
  speed: number;
  percentTorque: number;
  activeDtcs: number;
  coolantTemp: number;
  oilTemp: number;
  oilPressure: number;
  fuelRate: number;
  intakeManifoldPressure: number;
  batteryVoltage: number;
}

@Component({
  selector: 'engine-status',
  imports: [
    MatTooltipModule,
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    CdkDrag
  ],
  styleUrls: ['./engine-status.component.css'],
  template: `
    <div class="engine-status-panel" cdkDrag cdkDragHandle>
      <mat-card class="engine-status-card">
        <mat-card-header>
          <mat-card-title>
            <mat-icon>engineering</mat-icon>
            Engine Status
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
            <!-- Performance Section -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>speed</mat-icon>
                Performance
              </h4>
              <div class="status-grid">
                <div class="status-item">
                  <span class="status-label">Accelerator Position:</span>
                  <span class="status-value">{{ engineData.acceleratorPedalPosition }}%</span>
                </div>
                <div class="status-item">
                  <span class="status-label">Engine Load:</span>
                  <span class="status-value">{{ engineData.percentLoad }}%</span>
                </div>
                <div class="status-item">
                  <span class="status-label">Engine Speed:</span>
                  <span class="status-value">{{ engineData.speed }} RPM</span>
                </div>
                <div class="status-item">
                  <span class="status-label">Torque:</span>
                  <span class="status-value">{{ engineData.percentTorque }}%</span>
                </div>
              </div>
            </div>

            <!-- Temperatures Section -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>thermostat</mat-icon>
                Temperatures
              </h4>
              <div class="status-grid">
                <div class="status-item">
                  <span class="status-label">Coolant Temp:</span>
                  <span class="status-value" [class.status-warning]="engineData.coolantTemp > 90">
                    {{ engineData.coolantTemp }}°C
                  </span>
                </div>
                <div class="status-item">
                  <span class="status-label">Oil Temp:</span>
                  <span class="status-value" [class.status-warning]="engineData.oilTemp > 120">
                    {{ engineData.oilTemp }}°C
                  </span>
                </div>
              </div>
            </div>

            <!-- Pressures & Flow Section -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>compress</mat-icon>
                Pressures & Flow
              </h4>
              <div class="status-grid">
                <div class="status-item">
                  <span class="status-label">Oil Pressure:</span>
                  <span class="status-value" [class.status-warning]="engineData.oilPressure < 10">
                    {{ engineData.oilPressure }} PSI
                  </span>
                </div>
                <div class="status-item">
                  <span class="status-label">Fuel Rate:</span>
                  <span class="status-value">{{ engineData.fuelRate }} L/h</span>
                </div>
                <div class="status-item">
                  <span class="status-label">Manifold Pressure:</span>
                  <span class="status-value">{{ engineData.intakeManifoldPressure }} kPa</span>
                </div>
              </div>
            </div>

            <!-- Electrical & Diagnostics Section -->
            <div class="status-section">
              <h4 class="section-title">
                <mat-icon>electrical_services</mat-icon>
                Electrical & Diagnostics
              </h4>
              <div class="status-grid">
                <div class="status-item">
                  <span class="status-label">Battery Voltage:</span>
                  <span class="status-value" [class.status-warning]="engineData.batteryVoltage < 11">
                    {{ engineData.batteryVoltage }}V
                  </span>
                </div>
                <div class="status-item">
                  <span class="status-label">Active DTCs:</span>
                  <span class="status-value" [class.status-warning]="engineData.activeDtcs > 0">
                    {{ engineData.activeDtcs }}
                  </span>
                </div>
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

  protected handleClose(): void {
    this.closed.emit();
  }
}