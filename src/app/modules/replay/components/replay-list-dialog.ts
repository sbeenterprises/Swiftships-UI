/** Mission Replay - recording picker
 ********************************/

import { Component, OnInit, Inject, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA
} from '@angular/material/dialog';
import { AppFacade } from 'src/app/app.facade';
import { ReplayApiService, RecordingMeta } from '../replay-api.service';

/********* ReplayListDialog *********
 * data: {}
 * returns: the selected RecordingMeta, or undefined
 */
@Component({
  selector: 'ap-replaylistdialog',
  imports: [
    FormsModule,
    MatInputModule,
    MatFormFieldModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatListModule,
    MatTooltipModule,
    MatProgressBarModule
  ],
  template: `
    <div class="_ap-replaylist">
      <div style="display:flex;">
        <div style="padding: 15px 0 0 10px;">
          <mat-icon>video_library</mat-icon>
        </div>
        <div style="flex: 1 1 auto;">
          <h1 mat-dialog-title>Mission Replay</h1>
        </div>
        <div style="width:50px;padding: 15px 0 0 10px;">
          <button mat-icon-button (click)="handleClose()">
            <mat-icon>close</mat-icon>
          </button>
        </div>
      </div>

      @if(loading()) {
      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
      }

      <mat-dialog-content style="padding-top: 5px;">
        @if(!loading() && recordings().length === 0) {
        <div class="empty">
          No recordings yet. Press the record button on the map toolbar during a
          mission.
        </div>
        } @for(r of recordings(); track r.id) {
        <div class="row">
          @if(editingId() === r.id) {
          <mat-form-field class="pick" subscriptSizing="dynamic">
            <input
              matInput
              [(ngModel)]="editingName"
              (keyup.enter)="commitRename(r)"
              (keyup.escape)="editingId.set(null)"
            />
          </mat-form-field>
          <button mat-icon-button matTooltip="Save" (click)="commitRename(r)">
            <mat-icon>check</mat-icon>
          </button>
          <button
            mat-icon-button
            matTooltip="Cancel"
            (click)="editingId.set(null)"
          >
            <mat-icon>close</mat-icon>
          </button>
          } @else {
          <button
            class="pick"
            mat-button
            [matTooltip]="tooltipFor(r)"
            (click)="handleClose(r)"
          >
            <div class="title">
              {{ r.name }}
              @if(r.status === 'interrupted') {
              <mat-icon class="warn-icon" matTooltip="Recording was interrupted"
                >warning</mat-icon
              >
              }
            </div>
            <div class="sub">
              {{ formatDate(r.startedAt) }} &middot;
              {{ formatDuration(r.durationMs) }} &middot;
              {{ formatSize(r.sizeBytes) }}
            </div>
          </button>
          <button mat-icon-button matTooltip="Rename" (click)="startRename(r)">
            <mat-icon>edit</mat-icon>
          </button>
          <button mat-icon-button matTooltip="Delete" (click)="handleDelete(r)">
            <mat-icon>delete</mat-icon>
          </button>
          }
        </div>
        }
      </mat-dialog-content>
    </div>
  `,
  styles: [
    `
      ._ap-replaylist {
        min-width: 420px;
      }
      ._ap-replaylist .empty {
        padding: 20px 10px;
        opacity: 0.7;
        text-align: center;
      }
      ._ap-replaylist .row {
        display: flex;
        align-items: center;
        border-bottom: 1px solid rgba(128, 128, 128, 0.25);
      }
      ._ap-replaylist .pick {
        flex: 1 1 auto;
        text-align: left;
        height: auto;
        padding: 8px 10px;
      }
      ._ap-replaylist .title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
      }
      ._ap-replaylist .sub {
        font-size: 0.8em;
        opacity: 0.7;
      }
      ._ap-replaylist .warn-icon {
        font-size: 16px;
        height: 16px;
        width: 16px;
      }
    `
  ]
})
export class ReplayListDialog implements OnInit {
  private api = inject(ReplayApiService);
  private app = inject(AppFacade);

  protected recordings = signal<RecordingMeta[]>([]);
  protected loading = signal<boolean>(true);
  protected editingId = signal<string | null>(null);
  protected editingName = '';

  constructor(
    private dialogRef: MatDialogRef<ReplayListDialog>,
    @Inject(MAT_DIALOG_DATA)
    public data: Record<string, never>
  ) {}

  ngOnInit() {
    this.refresh();
  }

  private refresh() {
    this.loading.set(true);
    this.api.list().subscribe(
      (r) => {
        this.recordings.set(r);
        this.loading.set(false);
      },
      () => {
        this.loading.set(false);
        this.app.showMessage('Could not load recordings.', false, 5000);
      }
    );
  }

  protected tooltipFor(r: RecordingMeta): string {
    return `${r.eventCount.toLocaleString()} events${
      r.vesselName ? ' · ' + r.vesselName : ''
    }`;
  }

  protected formatDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.valueOf()) ? '-' : d.toLocaleString();
  }

  protected formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  protected formatSize(bytes: number): string {
    if (bytes > 1024 * 1024) {
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${Math.round(bytes / 1024)} KB`;
  }

  protected startRename(r: RecordingMeta) {
    this.editingName = r.name;
    this.editingId.set(r.id);
  }

  protected commitRename(r: RecordingMeta) {
    const name = (this.editingName ?? '').trim();
    this.editingId.set(null);
    if (!name || name === r.name) {
      return;
    }
    this.api.rename(r.id, { name }).subscribe(
      () => this.refresh(),
      () => this.app.showMessage('Could not rename recording.', false, 5000)
    );
  }

  protected handleDelete(r: RecordingMeta) {
    this.app
      .showConfirm(`Delete "${r.name}"?`, 'Delete Recording')
      .subscribe((ok: boolean) => {
        if (ok) {
          this.api.remove(r.id).subscribe(
            () => this.refresh(),
            () =>
              this.app.showMessage('Could not delete recording.', false, 5000)
          );
        }
      });
  }

  protected handleClose(sel?: RecordingMeta) {
    this.dialogRef.close(sel);
  }
}
