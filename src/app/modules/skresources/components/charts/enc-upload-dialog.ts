import { Component } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AppFacade } from 'src/app/app.facade';
import { SignalKClient } from 'signalk-client-angular';

/**
 * EncUploadDialog — upload an S-57 (.zip) ENC exchange set. The server-side
 * freeboard-sk plugin unzips + tiles it with s57-tiler in the background; this
 * dialog uploads the file, polls the tiling job, and — on completion — reloads
 * the Signal K charts plugin so the new cell(s) appear in the chart list.
 */
@Component({
  selector: 'enc-upload-dialog',
  imports: [
    CommonModule,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatTooltipModule,
    MatProgressBarModule
  ],
  template: `
    <div class="_ap-enc" style="min-width:360px">
      <mat-toolbar style="background-color: transparent">
        <span class="dialog-icon"><mat-icon>upload_file</mat-icon></span>
        <span style="flex:1 1 auto; text-align:center">Upload ENC Chart</span>
        <span style="text-align:right">
          <button mat-icon-button (click)="cancel()">
            <mat-icon>close</mat-icon>
          </button>
        </span>
      </mat-toolbar>

      <mat-dialog-content>
        <!-- idle: pick a file -->
        <div *ngIf="!job">
          <p style="color:#607d8b; font-size:13px; margin-top:0">
            Select a NOAA S-57 ENC <b>.zip</b> — a single cell or a region bundle.
            It is unzipped and tiled on the server; nothing is decrypted (S-57 is
            already unencrypted; encrypted S-63 is not supported).
          </p>
          <input
            type="file"
            accept=".zip"
            (change)="onFile($event)"
            style="width:100%; margin:8px 0"
          />
          <div *ngIf="file" style="font-size:12px; color:#455a64">
            {{ file.name }} · {{ (file.size / 1048576).toFixed(1) }} MB
          </div>
        </div>

        <!-- running / done / error -->
        <div *ngIf="job">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
            <mat-icon
              [style.color]="
                job.status === 'done'
                  ? '#2e7d32'
                  : job.status === 'error'
                    ? '#c62828'
                    : '#1976d2'
              "
              >{{
                job.status === 'done'
                  ? 'check_circle'
                  : job.status === 'error'
                    ? 'error'
                    : 'sync'
              }}</mat-icon
            >
            <b>{{ job.message }}</b>
          </div>
          <mat-progress-bar
            *ngIf="job.status !== 'done' && job.status !== 'error'"
            mode="indeterminate"
          ></mat-progress-bar>
          <div
            *ngIf="job.cells?.length"
            style="font-size:12px; color:#455a64; margin-top:6px"
          >
            Cells: {{ job.cells.join(', ') }}
          </div>
          <div
            *ngIf="job.log?.length"
            style="margin-top:8px; max-height:120px; overflow:auto; background:#0d1a2c;
                   color:#9fb3c8; font:11px/1.4 monospace; padding:6px; border-radius:6px"
          >
            <div *ngFor="let l of job.log.slice(-8)">{{ l }}</div>
          </div>
        </div>
      </mat-dialog-content>

      <div mat-dialog-actions style="justify-content:flex-end; gap:8px; padding:0 16px 12px">
        <button
          *ngIf="!job || job.status === 'error'"
          mat-raised-button
          color="primary"
          [disabled]="!file || uploading"
          (click)="upload()"
        >
          <mat-icon>upload</mat-icon> Upload &amp; Tile
        </button>
        <button
          *ngIf="job?.status === 'done'"
          mat-raised-button
          color="primary"
          (click)="finish()"
        >
          <mat-icon>done</mat-icon> Done
        </button>
        <button mat-button (click)="cancel()">Cancel</button>
      </div>
    </div>
  `
})
export class EncUploadDialog {
  protected file: File | null = null;
  protected uploading = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected job: any = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private rescanned = false;

  constructor(
    public dialogRef: MatDialogRef<EncUploadDialog>,
    private app: AppFacade,
    private http: HttpClient,
    private signalk: SignalKClient
  ) {}

  private base(): string {
    // Origin the UI was actually loaded from (e.g. https://sim.swiftships.com) so
    // upload / job-poll / charts-config requests go through the reverse proxy.
    // NOT hostDef.url — in a dev build that is https://localhost:3000, which a
    // remote browser can't reach (upload fails with "0 Unknown Error").
    return this.app.serverOrigin;
  }

  private headers(contentType?: string): HttpHeaders {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h: any = {};
    if (contentType) h['Content-Type'] = contentType;
    const t = this.signalk.authToken;
    if (t) h['Authorization'] = `Bearer ${t}`;
    return new HttpHeaders(h);
  }

  protected onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    this.file = input.files && input.files.length ? input.files[0] : null;
  }

  protected upload() {
    if (!this.file) return;
    this.uploading = true;
    this.rescanned = false;
    this.job = { status: 'uploading', message: 'Uploading…', log: [], cells: [] };
    const url = `${this.base()}/plugins/swiftships-ui/enc/upload?name=${encodeURIComponent(
      this.file.name
    )}`;
    this.http
      .post(url, this.file, { headers: this.headers('application/zip'), withCredentials: true })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .subscribe({
        next: (r: any) => {
          if (r?.jobId) this.startPoll(r.jobId);
          else {
            this.uploading = false;
            this.job = { status: 'error', message: 'No job id returned.', log: [] };
          }
        },
        error: (e) => {
          this.uploading = false;
          const detail =
            (typeof e?.error === 'string' && e.error) ||
            e?.error?.message ||
            e?.error?.error ||
            e?.message ||
            (e?.status ? `HTTP ${e.status} ${e.statusText || ''}`.trim() : '') ||
            'unknown error';
          this.job = {
            status: 'error',
            message: `Upload failed: ${detail}`,
            log: []
          };
        }
      });
  }

  private startPoll(jobId: string) {
    const url = `${this.base()}/plugins/swiftships-ui/enc/jobs/${jobId}`;
    this.pollTimer = setInterval(() => {
      this.http
        .get(url, { headers: this.headers(), withCredentials: true })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .subscribe({
          next: (j: any) => {
            this.job = j;
            if (j.status === 'done') {
              this.stopPoll();
              this.onDone();
            } else if (j.status === 'error') {
              this.stopPoll();
              this.uploading = false;
            }
          },
          error: () => {
            /* transient — keep polling */
          }
        });
    }, 2000);
  }

  private stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async onDone() {
    this.uploading = false;
    this.job.message = 'Tiled. Reloading charts…';
    await this.rescanCharts();
    this.job.message = this.rescanned
      ? `Tiled${this.job.cells?.length ? ' (' + this.job.cells.join(', ') + ')' : ''}. Charts reloaded — click Done.`
      : `Tiled. Reload the Charts plugin (Server → Plugin Config → Charts → Submit) to see it, then Done.`;
  }

  /** Reload the Signal K charts plugin so it re-scans chartPaths. */
  private async rescanCharts() {
    const cfgUrl = `${this.base()}/plugins/charts/config`;
    try {
      const cfg = await this.http
        .get(cfgUrl, { headers: this.headers(), withCredentials: true })
        .toPromise();
      await this.http
        .post(cfgUrl, cfg, {
          headers: this.headers('application/json'),
          withCredentials: true
        })
        .toPromise();
      // give the plugin a moment to restart + rescan
      await new Promise((r) => setTimeout(r, 2500));
      this.rescanned = true;
    } catch {
      this.rescanned = false;
    }
  }

  protected finish() {
    this.stopPoll();
    this.dialogRef.close({ ok: true, rescanned: this.rescanned });
  }

  protected cancel() {
    this.stopPoll();
    this.dialogRef.close();
  }
}
