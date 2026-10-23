/***********************************
  Engine Status Component: RPM dial, metric tiles and engine alerts
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
import { MatIconModule } from '@angular/material/icon';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { NotificationManager } from '../notification-manager';

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
  // Signal K only (propulsion.<id>.*, tanks, notifications.propulsion.<id>.*)
  engineId?: string;                // propulsion id, e.g. 'port'
  trim?: number;                    // % up
  alternatorVoltage?: number;       // V
  engineHours?: number;             // h
  fuelLevel?: number;               // % of tank
  alarms?: { name: string; state: string; message: string }[]; // not 'normal'
  lastUpdate?: number;              // ms epoch of the last engine reading (any source)
  running?: EngineRunState;         // set by EngineMonitor
}

export type EngineRunState = 'running' | 'stopped' | 'unknown';

type Tone = 'ok' | 'cool' | 'warn' | 'alarm';

interface Tile {
  label: string;
  value: string;
  unit: string;
  sub: string;
  status: string;
  tone: Tone;
  pct: number;   // marker position on the bar, 0-100
  bandL: number; // normal band start, %
  bandW: number; // normal band width, %
}

const RPM_MAX = 6000;
const RPM_REDLINE = 5500;
// dial geometry (viewBox 260 x 214)
const CX = 130;
const CY = 128;
const R = 104;

@Component({
  selector: 'engine-status',
  standalone: true,
  imports: [
    CommonModule,
    MatTooltipModule,
    MatButtonModule,
    MatIconModule,
    CdkDrag,
    CdkDragHandle
  ],
  styleUrls: ['./engine-status.component.css'],
  template: `
    <div class="engine-status-panel" cdkDrag>
      <div class="engine-card">
        <!-- Header (drag handle) -->
        <div class="engine-header" cdkDragHandle>
          <mat-icon class="engine-icon">engineering</mat-icon>
          <div class="engine-title">
            <div class="name">{{ engineName }}</div>
            <div class="source">{{ sourceLabel }}</div>
          </div>
          <div class="chips">
            <span class="run-state" [ngClass]="engineData.running ?? 'unknown'">
              <span class="run-dot"></span>{{ runStateLabel }}
            </span>
            @if (engineData.engineHours !== undefined) {
              <span class="chip">Hours <b>{{ engineData.engineHours | number: '1.1-1' }} h</b></span>
            }
          </div>
          <div class="header-right">
            <span class="updated">Updated <b>{{ updatedLabel }}</b></span>
            <button
              mat-icon-button
              class="close-button"
              (click)="handleClose()"
              matTooltip="Close"
              aria-label="Close engine panel"
            >
              <mat-icon>close</mat-icon>
            </button>
          </div>
        </div>

        <div class="engine-body">
          <!-- RPM dial -->
          <div class="hero">
            <div class="dial">
              <svg width="260" height="214" viewBox="0 0 260 214" aria-hidden="true">
                <path [attr.d]="dialTrack" class="dial-track"></path>
                <path [attr.d]="dialRedline" class="dial-redline"></path>
                <path [attr.d]="dialValue" class="dial-value" [ngClass]="rpmTone"></path>
                <path [attr.d]="dialTicks" class="dial-ticks"></path>
              </svg>
              @for (t of dialLabels; track t.label) {
                <div class="dial-label" [style.left.px]="t.x" [style.top.px]="t.y">{{ t.label }}</div>
              }
              <div class="dial-readout">
                <div class="rpm">{{ engineData.speed || 0 | number: '1.0-0' }}</div>
                <div class="rpm-unit">RPM</div>
              </div>
            </div>
            <div class="ratios">
              @for (r of ratios; track r.label) {
                <div class="ratio">
                  <div class="ratio-head">
                    <span>{{ r.label }}</span><b>{{ r.value | number: '1.0-0' }}%</b>
                  </div>
                  <div class="ratio-bar">
                    <div [ngClass]="r.tone" [style.width.%]="r.value"></div>
                  </div>
                </div>
              }
            </div>
          </div>

          <!-- Metric tiles -->
          <div class="tiles">
            @for (t of tiles; track t.label) {
              <div class="tile" [ngClass]="'tone-' + t.tone">
                <div class="tile-head">
                  <span class="tile-label">{{ t.label }}</span>
                  <span class="tile-status">{{ t.status }}</span>
                </div>
                <div class="tile-value">
                  <span>{{ t.value }}</span><span class="unit">{{ t.unit }}</span>
                </div>
                <div class="tile-sub">{{ t.sub }}</div>
                <div class="tile-bar">
                  <div class="band" [style.left.%]="t.bandL" [style.width.%]="t.bandW"></div>
                  <div class="marker" [style.left.%]="t.pct"></div>
                </div>
              </div>
            }
          </div>

          <!-- Engine alerts (same list as the alert panel) -->
          <div class="alarms" [class.active]="engineAlerts.length">
            <div class="alarms-head">
              <span>Engine alerts</span>
              <span class="badge">{{ engineAlerts.length }} active</span>
            </div>
            @for (a of engineAlerts; track a.path) {
              <button
                type="button"
                class="alarm-row"
                [ngClass]="a.priority"
                (click)="notiMgr.showAlertInfo(a.path)"
              >
                <span class="dot"></span>
                <span class="msg">{{ a.message }}</span>
                <span class="lvl">{{ a.priority }}</span>
              </button>
            } @empty {
              <div class="alarms-ok">
                <mat-icon>check_circle</mat-icon>
                <span>No engine alerts</span>
              </div>
            }
            <div class="alarms-foot">
              Engine alarm flags, shut-off during a mission, temperature, charging and fuel
            </div>
          </div>
        </div>
      </div>
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

  readonly dialTrack = arc(135, 405);
  readonly dialRedline = arc(angle(RPM_REDLINE), 405);
  readonly dialTicks = dialTicks();
  readonly dialLabels = dialLabels();

  constructor(protected notiMgr: NotificationManager) {}

  get engineName(): string {
    const id = this.engineData.engineId;
    return id ? `${id} engine` : 'Engine';
  }

  get sourceLabel(): string {
    return this.engineData.engineId ? 'NMEA 2000' : 'J1939 (MOOS)';
  }

  get runStateLabel(): string {
    return { running: 'Running', stopped: 'Shut off' }[this.engineData.running] ?? 'No data';
  }

  get updatedLabel(): string {
    const t = this.engineData.lastUpdate;
    return t ? new Date(t).toISOString().slice(11, 19) + ' UTC' : '—';
  }

  get dialValue(): string {
    return arc(135, angle(this.engineData.speed || 0));
  }

  get rpmTone(): Tone {
    const rpm = this.engineData.speed || 0;
    return rpm >= RPM_REDLINE ? 'alarm' : rpm >= 5000 ? 'warn' : 'ok';
  }

  get ratios() {
    const tone = (v: number): Tone => (v >= 90 ? 'alarm' : v >= 80 ? 'warn' : 'ok');
    const load = clamp(this.engineData.percentLoad || 0, 0, 100);
    const torque = clamp(this.engineData.percentTorque || 0, 0, 100);
    return [
      { label: 'Load', value: load, tone: tone(load) },
      { label: 'Torque', value: torque, tone: tone(torque) }
    ];
  }

  /** Tiles for the values this engine reports; optional ones only when present. */
  get tiles(): Tile[] {
    const e = this.engineData;
    const running = e.running === 'running';
    const tiles: Tile[] = [];

    const t = e.coolantTemp;
    tiles.push(
      tile('Engine temp', t.toFixed(1), '°C', 'Normal 50–95 °C',
        t >= 100 ? ['Overheat', 'alarm'] : t >= 95 ? ['High', 'warn'] : t < 50 ? ['Cool', 'cool'] : ['Normal', 'ok'],
        bar(t, 0, 120, 50, 95))
    );
    if (e.oilPressure > 0) {
      const p = e.oilPressure;
      tiles.push(
        tile('Oil pressure', p.toFixed(0), 'PSI', 'Normal above 20 PSI',
          p < 10 ? ['Low', 'alarm'] : p < 20 ? ['Low', 'warn'] : ['Normal', 'ok'],
          bar(p, 0, 80, 20, 80))
      );
    }
    if (e.oilTemp > 0) {
      const o = e.oilTemp;
      tiles.push(
        tile('Oil temp', o.toFixed(0), '°C', 'Normal below 110 °C',
          o >= 125 ? ['High', 'alarm'] : o >= 110 ? ['High', 'warn'] : ['Normal', 'ok'],
          bar(o, 0, 150, 0, 110))
      );
    }
    if (typeof e.alternatorVoltage === 'number') {
      const a = e.alternatorVoltage;
      tiles.push(
        tile('Alternator', a.toFixed(2), 'V', running ? 'Charging output' : 'Reading at rest',
          running && a < 12.8 ? ['Not charging', 'warn'] : ['Normal', 'ok'],
          bar(a, 10, 16, 13.2, 14.8))
      );
    }
    if (e.batteryVoltage > 0) {
      const v = e.batteryVoltage;
      tiles.push(
        tile('House battery', v.toFixed(2), 'V', 'Normal 12.4–14.8 V',
          v < 11.5 ? ['Low', 'alarm'] : v < 12.0 ? ['Low', 'warn'] : ['Normal', 'ok'],
          bar(v, 10, 16, 12.4, 14.8))
      );
    }
    tiles.push(
      tile('Fuel rate', e.fuelRate.toFixed(1), 'L/h',
        running ? `At ${Math.round(e.speed).toLocaleString('en-US')} rpm` : 'Engine not running',
        running ? ['Burning', 'ok'] : ['Idle', 'cool'],
        bar(e.fuelRate, 0, 50, 0, 40))
    );
    if (typeof e.fuelLevel === 'number') {
      const f = e.fuelLevel;
      tiles.push(
        tile('Fuel tank', f.toFixed(0), '%', 'Tank 1',
          f < 10 ? ['Critical', 'alarm'] : f < 20 ? ['Low', 'warn'] : ['Normal', 'ok'],
          bar(f, 0, 100, 20, 100))
      );
    }
    if (typeof e.trim === 'number') {
      const tr = e.trim;
      tiles.push(
        tile('Trim', tr.toFixed(0), '% up',
          tr < 10 ? 'Trimmed down' : tr > 60 ? 'Tilted up' : 'Running trim',
          ['Set', 'ok'], bar(tr, 0, 100, 10, 60))
      );
    }
    if (e.intakeManifoldPressure > 0) {
      const m = e.intakeManifoldPressure;
      tiles.push(
        tile('Boost (MAP)', m.toFixed(0), 'kPa', 'Normal below 180 kPa',
          m >= 220 ? ['High', 'alarm'] : m >= 180 ? ['High', 'warn'] : ['Normal', 'ok'],
          bar(m, 0, 300, 0, 180))
      );
    }
    return tiles;
  }

  /** Engine alerts from the alert panel (engine flags + EngineMonitor). */
  get engineAlerts() {
    return this.notiMgr
      .alerts()
      .filter(([, a]) => a.type === 'engine')
      .map(([, a]) => a);
  }

  protected handleClose(): void {
    this.closed.emit();
  }
}

// ** helpers **

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

function angle(rpm: number) {
  return 135 + 270 * clamp(rpm / RPM_MAX, 0, 1);
}

function pt(a: number, r: number): [number, number] {
  const t = (a * Math.PI) / 180;
  return [CX + r * Math.cos(t), CY + r * Math.sin(t)];
}

function arc(a0: number, a1: number): string {
  if (a1 - a0 < 0.5) {
    return '';
  }
  const [x0, y0] = pt(a0, R);
  const [x1, y1] = pt(a1, R);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

function dialTicks(): string {
  let d = '';
  for (let i = 0; i <= 12; i++) {
    const a = angle(i * 500);
    const [ox, oy] = pt(a, R - 12);
    const [ix, iy] = pt(a, R - (i % 2 === 0 ? 22 : 17));
    d += `M ${ox.toFixed(1)} ${oy.toFixed(1)} L ${ix.toFixed(1)} ${iy.toFixed(1)} `;
  }
  return d;
}

function dialLabels() {
  const labels = [];
  for (let k = 0; k <= RPM_MAX / 1000; k++) {
    const [x, y] = pt(angle(k * 1000), R - 34);
    labels.push({ label: String(k), x: Math.round(x - 12), y: Math.round(y - 8) });
  }
  return labels;
}

function bar(v: number, lo: number, hi: number, okLo: number, okHi: number) {
  const span = hi - lo;
  return {
    pct: clamp(((v - lo) / span) * 100, 0, 100),
    bandL: ((okLo - lo) / span) * 100,
    bandW: ((okHi - okLo) / span) * 100
  };
}

function tile(
  label: string,
  value: string,
  unit: string,
  sub: string,
  [status, tone]: [string, Tone] | string[],
  b: { pct: number; bandL: number; bandW: number }
): Tile {
  return { label, value, unit, sub, status, tone: tone as Tone, ...b };
}
