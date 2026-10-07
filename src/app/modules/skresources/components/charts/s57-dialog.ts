import { Component, Inject } from '@angular/core';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA
} from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { AppFacade } from 'src/app/app.facade';
import { SKChart } from 'src/app/modules/skresources/resource-classes';
import { ChartProvider } from 'src/app/types';

/********* S57Dialog **********
  Add an S-57 (ENC) vector-tile chart source.
  Returns Array<ChartProvider> (or undefined when cancelled) matching
  the format expected by ChartListComponent.addChartSource().
***********************************/
@Component({
  selector: 's57-dialog',
  imports: [
    MatTooltipModule,
    MatIconModule,
    MatButtonModule,
    MatToolbarModule,
    MatDialogModule,
    MatInputModule,
    FormsModule
  ],
  template: `
    <div class="_ap-s57">
      <mat-toolbar style="background-color: transparent">
        <span class="dialog-icon"><mat-icon>map</mat-icon></span>
        <span style="flex: 1 1 auto; text-align: center"
          >Add S-57 ENC Source</span
        >
        <span style="text-align: right">
          <button mat-icon-button (click)="dialogRef.close()">
            <mat-icon>close</mat-icon>
          </button>
        </span>
      </mat-toolbar>
      <mat-dialog-content>
        <mat-form-field floatLabel="always" style="width: 100%">
          <mat-label>Name</mat-label>
          <input matInput required [(ngModel)]="chart.name" />
          <mat-hint>Name shown in the chart list.</mat-hint>
        </mat-form-field>

        <mat-form-field floatLabel="always" style="width: 100%">
          <mat-label>Description</mat-label>
          <input matInput [(ngModel)]="chart.description" />
        </mat-form-field>

        <mat-form-field floatLabel="always" style="width: 100%">
          <mat-label>Tile URL template</mat-label>
          <input
            matInput
            required
            [(ngModel)]="chart.url"
            placeholder="https://host/enc/&#123;z&#125;/&#123;x&#125;/&#123;y&#125;.pbf"
          />
          <mat-hint>
            MVT vector tiles. Must contain &#123;z&#125;/&#123;x&#125;/&#123;y&#125;.
          </mat-hint>
        </mat-form-field>

        <div style="display: flex; gap: 10px">
          <mat-form-field floatLabel="always" style="flex: 1 1 auto">
            <mat-label>Min zoom</mat-label>
            <input matInput type="number" [(ngModel)]="chart.minzoom" />
          </mat-form-field>
          <mat-form-field floatLabel="always" style="flex: 1 1 auto">
            <mat-label>Max zoom</mat-label>
            <input matInput type="number" [(ngModel)]="chart.maxzoom" />
          </mat-form-field>
          <mat-form-field floatLabel="always" style="flex: 1 1 auto">
            <mat-label>Scale</mat-label>
            <input matInput type="number" [(ngModel)]="chart.scale" />
          </mat-form-field>
        </div>

        <mat-form-field floatLabel="always" style="width: 100%">
          <mat-label>Bounds (optional)</mat-label>
          <input
            matInput
            [(ngModel)]="chart.bounds"
            placeholder="minLon,minLat,maxLon,maxLat"
          />
          <mat-hint>Comma-separated. Leave blank for worldwide.</mat-hint>
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions>
        <button
          mat-raised-button
          [disabled]="!isValid()"
          (click)="handleSave()"
        >
          Save
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      ._ap-s57 {
        min-width: 320px;
      }
    `
  ]
})
export class S57Dialog {
  protected chart = {
    name: '',
    description: '',
    url: '',
    minzoom: 8,
    maxzoom: 16,
    scale: 250000,
    bounds: ''
  };

  constructor(
    public app: AppFacade,
    public dialogRef: MatDialogRef<S57Dialog>,
    @Inject(MAT_DIALOG_DATA) public data: SKChart
  ) {}

  /** URL must be a tile template and a name is required */
  protected isValid(): boolean {
    return (
      this.chart.name.trim().length > 0 &&
      /\{z\}/.test(this.chart.url) &&
      /\{x\}/.test(this.chart.url) &&
      /\{y\}/.test(this.chart.url)
    );
  }

  /** Parse "minLon,minLat,maxLon,maxLat" -> number[] (or undefined) */
  private parseBounds(): number[] | undefined {
    if (!this.chart.bounds.trim()) {
      return undefined;
    }
    const parts = this.chart.bounds.split(',').map((v) => Number(v.trim()));
    return parts.length === 4 && parts.every((n) => !isNaN(n))
      ? parts
      : undefined;
  }

  handleSave() {
    const provider: ChartProvider = {
      name: this.chart.name.trim(),
      description: this.chart.description.trim(),
      type: 'S-57',
      format: 'pbf',
      url: this.chart.url.trim(),
      minzoom: Number(this.chart.minzoom),
      maxzoom: Number(this.chart.maxzoom),
      scale: Number(this.chart.scale)
    };
    const bounds = this.parseBounds();
    if (bounds) {
      provider.bounds = bounds;
    }
    this.dialogRef.close([provider]);
  }
}
