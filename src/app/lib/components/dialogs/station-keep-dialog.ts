/** Station Keep Configuration Dialog Component **
 ********************************/

import { Component, OnInit, Inject } from '@angular/core';

import {
  FormsModule,
  FormControl,
  Validators,
  ReactiveFormsModule
} from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSliderModule } from '@angular/material/slider';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA
} from '@angular/material/dialog';
import { AppFacade } from 'src/app/app.facade';

export interface StationKeepConfig {
  innerRadius: number;
  outerRadius: number;
  timeToKeep: number; // in seconds
  position: [number, number];
  pointIndex?: number;
}

/********* StationKeepDialog **********
  data: {
    title: <string> title text,
    config: <StationKeepConfig> Station keep configuration
  }
***********************************/
@Component({
  selector: 'ap-stationkeepdialog',
  imports: [
    FormsModule,
    MatInputModule,
    MatSelectModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatToolbarModule,
    MatSliderModule,
    MatDialogModule,
    ReactiveFormsModule
  ],
  template: `
    <div class="_ap-station-keep">
      <div style="display:flex;">
        <div style="padding: 15px 0 0 10px;">
          <mat-icon>adjust</mat-icon>
        </div>
        <div>
          <h1 mat-dialog-title>{{ data['title'] }}</h1>
        </div>
      </div>

      <mat-dialog-content>
        <div style="padding: 20px;">
          <!-- Position Display -->
          <div style="margin-bottom: 20px;">
            <div style="font-weight: bold; margin-bottom: 8px;">Position:</div>
            <div style="font-size: 14px;">{{ formatPosition(config.position) }}</div>
          </div>

          <!-- Inner Radius Control -->
          <div style="margin-bottom: 24px;">
            <div style="font-weight: bold; margin-bottom: 8px;">Inner Radius (m)</div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <button
                mat-icon-button
                (click)="updateInnerRadius(config.innerRadius - 1)"
                [disabled]="config.innerRadius <= 1"
              >
                <mat-icon>remove</mat-icon>
              </button>
              <mat-slider
                [min]="1"
                [max]="100"
                [step]="1"
                style="flex: 1;"
              >
                <input
                  matSliderThumb
                  [value]="config.innerRadius"
                  (input)="updateInnerRadius($any($event.target).value)"
                />
              </mat-slider>
              <button
                mat-icon-button
                (click)="updateInnerRadius(config.innerRadius + 1)"
                [disabled]="config.innerRadius >= 100"
              >
                <mat-icon>add</mat-icon>
              </button>
              <span style="min-width: 50px; text-align: right;">{{ config.innerRadius }}m</span>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <button mat-stroked-button (click)="updateInnerRadius(5)" style="flex: 1;">5m</button>
              <button mat-stroked-button (click)="updateInnerRadius(10)" style="flex: 1;">10m</button>
              <button mat-stroked-button (click)="updateInnerRadius(20)" style="flex: 1;">20m</button>
            </div>
          </div>

          <!-- Outer Radius Control -->
          <div style="margin-bottom: 24px;">
            <div style="font-weight: bold; margin-bottom: 8px;">Outer Radius (m)</div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <button
                mat-icon-button
                (click)="updateOuterRadius(config.outerRadius - 1)"
                [disabled]="config.outerRadius <= config.innerRadius + 1"
              >
                <mat-icon>remove</mat-icon>
              </button>
              <mat-slider
                [min]="config.innerRadius + 1"
                [max]="200"
                [step]="1"
                style="flex: 1;"
              >
                <input
                  matSliderThumb
                  [value]="config.outerRadius"
                  (input)="updateOuterRadius($any($event.target).value)"
                />
              </mat-slider>
              <button
                mat-icon-button
                (click)="updateOuterRadius(config.outerRadius + 1)"
                [disabled]="config.outerRadius >= 200"
              >
                <mat-icon>add</mat-icon>
              </button>
              <span style="min-width: 50px; text-align: right;">{{ config.outerRadius }}m</span>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <button mat-stroked-button (click)="updateOuterRadius(config.innerRadius + 10)" style="flex: 1;">+10m</button>
              <button mat-stroked-button (click)="updateOuterRadius(config.innerRadius + 25)" style="flex: 1;">+25m</button>
              <button mat-stroked-button (click)="updateOuterRadius(config.innerRadius + 50)" style="flex: 1;">+50m</button>
            </div>
          </div>

          <!-- Hold time: 0 = until the operator presses Resume -->
          <div style="margin-bottom: 24px;">
            <div style="font-weight: bold; margin-bottom: 4px;">Hold time (seconds)</div>
            <div style="font-size: 12px; opacity: 0.7; margin-bottom: 8px;">0 = hold until the operator resumes manually</div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <button
                mat-icon-button
                (click)="updateTimeToKeep(config.timeToKeep - 10)"
                [disabled]="config.timeToKeep <= 0"
              >
                <mat-icon>remove</mat-icon>
              </button>
              <mat-slider
                [min]="0"
                [max]="7200"
                [step]="10"
                style="flex: 1;"
              >
                <input
                  matSliderThumb
                  [value]="config.timeToKeep"
                  (input)="updateTimeToKeep($any($event.target).value)"
                />
              </mat-slider>
              <button
                mat-icon-button
                (click)="updateTimeToKeep(config.timeToKeep + 10)"
                [disabled]="config.timeToKeep >= 7200"
              >
                <mat-icon>add</mat-icon>
              </button>
              <span style="min-width: 70px; text-align: right;">{{ config.timeToKeep > 0 ? config.timeToKeep + ' sec' : 'Until resume' }}</span>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <button mat-stroked-button (click)="updateTimeToKeep(0)" style="flex: 1;"
                [class._ap-on]="config.timeToKeep === 0">Until resume</button>
              <button mat-stroked-button (click)="updateTimeToKeep(60)" style="flex: 1;">1min</button>
              <button mat-stroked-button (click)="updateTimeToKeep(300)" style="flex: 1;">5min</button>
              <button mat-stroked-button (click)="updateTimeToKeep(600)" style="flex: 1;">10min</button>
            </div>
          </div>
        </div>
      </mat-dialog-content>
      <mat-dialog-actions>
        <div style="display:flex;justify-content:center;align-items:center;width:100%;gap:8px;">
          <button mat-stroked-button color="primary" (click)="handleClose(true)">
            SAVE
          </button>
          @if(hasExisting) {
          <button mat-stroked-button color="warn" (click)="handleDelete()">
            <mat-icon>delete</mat-icon>
            REMOVE
          </button>
          }
          <button mat-stroked-button (click)="handleClose(false)">CANCEL</button>
        </div>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      ._ap-station-keep {
        min-width: 400px;
      }
      ._ap-on {
        background: rgba(25, 118, 210, 0.12);
      }
    `
  ]
})
export class StationKeepDialog implements OnInit {
  protected config: StationKeepConfig;
  protected hasExisting = false;

  constructor(
    protected app: AppFacade,
    protected dialogRef: MatDialogRef<StationKeepDialog>,
    @Inject(MAT_DIALOG_DATA)
    protected data: {
      title: string;
      config: StationKeepConfig;
      hasExisting?: boolean;
    }
  ) { }

  ngOnInit() {
    // Create a copy of the config to work with
    this.config = { ...this.data.config };
    this.hasExisting = !!this.data.hasExisting;
  }

  updateInnerRadius(value: number) {
    this.config.innerRadius = Math.max(1, Math.min(100, Number(value)));
    // Ensure outer radius is always greater than inner radius
    if (this.config.outerRadius <= this.config.innerRadius) {
      this.config.outerRadius = this.config.innerRadius + 5;
    }
  }

  updateOuterRadius(value: number) {
    this.config.outerRadius = Math.max(
      this.config.innerRadius + 1,
      Math.min(200, Number(value))
    );
  }

  updateTimeToKeep(value: number) {
    // 0 = hold until the operator presses Resume
    this.config.timeToKeep = Math.max(0, Math.min(7200, Number(value) || 0));
  }

  formatPosition(position: [number, number]): string {
    if (!position) return 'Not set';
    const lat = position[1].toFixed(6);
    const lon = position[0].toFixed(6);
    return `${lat}, ${lon}`;
  }

  handleClose(save: boolean) {
    if (save) {
      this.dialogRef.close({ save: true, config: this.config });
    } else {
      this.dialogRef.close({ save: false });
    }
  }

  handleDelete() {
    this.dialogRef.close({ save: false, delete: true });
  }
}
