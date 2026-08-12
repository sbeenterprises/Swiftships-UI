/** Mission Replay - transport bar
 *
 * Sits at the bottom of the map while a recording is loaded.
 * ************************************/

import { Component, EventEmitter, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { ReplayService } from '../replay.service';

@Component({
  selector: 'replay-bar',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatSliderModule,
    MatTooltipModule,
    MatMenuModule
  ],
  template: `
    <div class="replay-bar mat-app-background">
      <button
        mat-icon-button
        [matTooltip]="replay.playing() ? 'Pause' : 'Play'"
        (click)="replay.togglePlay()"
      >
        <mat-icon>{{ replay.playing() ? 'pause' : 'play_arrow' }}</mat-icon>
      </button>
      <button mat-icon-button matTooltip="Restart" (click)="replay.seek(0)">
        <mat-icon>skip_previous</mat-icon>
      </button>

      <div class="clock">{{ elapsed() }}</div>

      <mat-slider
        class="timeline"
        [min]="0"
        [max]="replay.durationMs()"
        [step]="100"
        [discrete]="false"
      >
        <input
          matSliderThumb
          [value]="replay.vt()"
          (input)="onScrub($any($event.target).value)"
          (change)="onCommit($any($event.target).value)"
        />
      </mat-slider>

      <div class="clock">{{ total() }}</div>

      <button mat-button [matMenuTriggerFor]="ratemenu" matTooltip="Speed">
        {{ replay.rate() }}x
      </button>
      <mat-menu #ratemenu="matMenu">
        @for(r of rates; track r) {
        <button mat-menu-item (click)="replay.setRate(r)">{{ r }}x</button>
        }
      </mat-menu>

      <button mat-icon-button matTooltip="Exit replay" (click)="exit.emit()">
        <mat-icon>close</mat-icon>
      </button>
    </div>
  `,
  styles: [
    `
      .replay-bar {
        position: absolute;
        bottom: 30px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 4902;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        width: min(760px, calc(100vw - 120px));
      }
      .replay-bar .timeline {
        flex: 1 1 auto;
        min-width: 120px;
      }
      .replay-bar .clock {
        font-family: monospace;
        font-size: 0.85em;
        white-space: nowrap;
        padding: 0 4px;
      }
    `
  ]
})
export class ReplayBarComponent {
  protected replay = inject(ReplayService);
  @Output() exit: EventEmitter<void> = new EventEmitter();

  protected readonly rates = [0.5, 1, 2, 5, 10, 20];

  /** dragging: cheap preview only (clock + trail), no state drain */
  protected onScrub(value: number) {
    this.replay.previewSeek(Number(value));
  }

  /** released: commit the seek, rewinding state if we went backwards */
  protected onCommit(value: number) {
    this.replay.seek(Number(value));
  }

  protected elapsed(): string {
    return this.hms(this.replay.vt());
  }

  protected total(): string {
    return this.hms(this.replay.durationMs());
  }

  private hms(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
}
