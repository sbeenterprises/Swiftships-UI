import { Component, Inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
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
import { MatRadioModule } from '@angular/material/radio';
import {
  GeoTiffPosition,
  parseMoosInfo
} from 'src/app/modules/skresources/geotiff';

/********* ChartPositionDialog **********
 * Ask for the edges of a chart image that has no position information.
	data: { fileName: string, message: string }
  returns: GeoTiffPosition or undefined (skipped)
***********************************/
@Component({
  selector: 'ap-chart-position-dialog',
  imports: [
    FormsModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonModule,
    MatToolbarModule,
    MatDialogModule,
    MatInputModule,
    MatRadioModule
  ],
  template: `
    <div class="_ap-chartposition">
      <mat-toolbar style="background-color: transparent">
        <span class="dialog-icon"><mat-icon>place</mat-icon></span>
        <span style="flex: 1 1 auto; text-align: center">Chart Position</span>
        <span style="text-align: right">
          <button mat-icon-button (click)="dialogRef.close()">
            <mat-icon>close</mat-icon>
          </button>
        </span>
      </mat-toolbar>
      <mat-dialog-content>
        <div class="file-name">{{ data.fileName }}</div>
        <div class="info">
          {{ data.message }}<br />
          Enter the latitude and longitude of the edges of the image (decimal
          degrees, negative for South and West) or read them from its MOOS-IvP
          .info file.
        </div>
        <div class="edges">
          <mat-form-field floatLabel="always">
            <mat-label>North (latitude)</mat-label>
            <input
              matInput
              type="number"
              step="any"
              [(ngModel)]="north"
              (ngModelChange)="edited()"
            />
          </mat-form-field>
          <mat-form-field floatLabel="always">
            <mat-label>South (latitude)</mat-label>
            <input
              matInput
              type="number"
              step="any"
              [(ngModel)]="south"
              (ngModelChange)="edited()"
            />
          </mat-form-field>
          <mat-form-field floatLabel="always">
            <mat-label>West (longitude)</mat-label>
            <input
              matInput
              type="number"
              step="any"
              [(ngModel)]="west"
              (ngModelChange)="edited()"
            />
          </mat-form-field>
          <mat-form-field floatLabel="always">
            <mat-label>East (longitude)</mat-label>
            <input
              matInput
              type="number"
              step="any"
              [(ngModel)]="east"
              (ngModelChange)="edited()"
            />
          </mat-form-field>
        </div>
        <mat-radio-group class="projection" [(ngModel)]="projection">
          <mat-radio-button value="EPSG:3857">
            Mercator (nautical chart, web map)
          </mat-radio-button>
          <mat-radio-button value="EPSG:4326">
            Latitude / longitude grid (MOOS-IvP image)
          </mat-radio-button>
        </mat-radio-group>
        @if (error) {
        <div class="error">{{ error }}</div>
        }
      </mat-dialog-content>
      <mat-dialog-actions>
        <input
          #infoinput
          type="file"
          accept=".info"
          hidden
          (change)="readInfo(infoinput.files); infoinput.value = ''"
        />
        <button
          mat-button
          (click)="infoinput.click()"
          matTooltip="Read the edges from a MOOS-IvP .info file"
        >
          <mat-icon>upload_file</mat-icon>
          Read .info file
        </button>
        <span style="flex: 1 1 auto"></span>
        <button mat-button (click)="dialogRef.close()">Skip</button>
        <button mat-raised-button (click)="load()">Load</button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      ._ap-chartposition {
        max-width: 560px;
      }
      ._ap-chartposition .file-name {
        font-weight: 500;
        overflow-wrap: anywhere;
      }
      ._ap-chartposition .info {
        font-size: 10pt;
        padding: 4px 0 12px 0;
      }
      ._ap-chartposition .edges {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0 12px;
      }
      ._ap-chartposition .projection {
        display: flex;
        flex-direction: column;
      }
      ._ap-chartposition .error {
        color: #f44336;
        font-size: 10pt;
        padding-top: 6px;
      }
    `
  ]
})
export class ChartPositionDialog {
  protected north: number;
  protected south: number;
  protected west: number;
  protected east: number;
  protected projection: 'EPSG:3857' | 'EPSG:4326' = 'EPSG:3857';
  protected error = '';
  private fromInfo = false;

  constructor(
    public dialogRef: MatDialogRef<ChartPositionDialog, GeoTiffPosition>,
    @Inject(MAT_DIALOG_DATA)
    public data: { fileName: string; message: string }
  ) {}

  /** values typed by the user */
  protected edited() {
    this.fromInfo = false;
  }

  /**
   * @description Fill the edges from a MOOS-IvP .info file.
   * @param files Selected file
   */
  protected async readInfo(files: FileList) {
    const file = files?.[0];
    if (!file) {
      return;
    }
    const bounds = parseMoosInfo(await file.text());
    if (!bounds) {
      this.error = `${file.name} has no lat_north / lat_south / lon_east / lon_west values.`;
      return;
    }
    [this.west, this.south, this.east, this.north] = bounds;
    // pMarineViewer stretches the image linearly between the edges
    this.projection = 'EPSG:4326';
    this.fromInfo = true;
    this.error = '';
  }

  /** @description Validate the edges and close the dialog with the position. */
  protected load() {
    // empty fields are null: they must not count as 0
    const [n, s, w, e] = [this.north, this.south, this.west, this.east].map(
      (v) => (v === null || v === undefined ? NaN : Number(v))
    );
    if (![n, s, w, e].every((v) => isFinite(v))) {
      this.error = 'Enter the four edges of the image.';
    } else if (n > 90 || s < -90 || n <= s) {
      this.error =
        'Latitudes must be between -90 and 90, North greater than South.';
    } else if (w < -180 || e > 360 || e <= w) {
      this.error =
        'Longitudes must be between -180 and 180, East greater than West.';
    } else if (this.projection === 'EPSG:3857' && (n > 85.05 || s < -85.05)) {
      this.error = 'A Mercator chart must lie between latitudes 85°S and 85°N.';
    } else {
      this.dialogRef.close({
        bounds: [w, s, e, n],
        projection: this.projection,
        source: this.fromInfo ? 'moos-info' : 'manual'
      });
    }
  }
}
