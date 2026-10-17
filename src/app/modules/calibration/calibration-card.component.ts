/***********************************
  Route-tracking calibration card
  <calibration-card>

  Operator side of pRouteTuner. Shows the calibration state, live tracking
  error, lap scores and GNSS quality, and carries the only two commands the
  operator needs:

    Authorise  ->  CAL_AUTH=true#OPERATOR=<name>#SESSION=<id>
    Abort      ->  CAL_ABORT=true#REASON=operator

  The card never changes gains or routes itself. Authorise only permits the
  tuner to start; the tuner still runs its own PRECHECK. Abort is handled by
  iWebSocket directly (SERVICE_MODE=false), so it works even if the tuner is
  not running.

  Reads CAL_* and GPS_* from the same iWebSocket stream the rest of the app
  uses. Accepts both wire formats seen in the code base: the consolidated
  JSON object iWebSocket sends each Iterate, and KEY=VALUE lines.
***********************************/
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Output,
  computed,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { MoosIvpWebsocketService } from 'src/app/lib/moos-ivp-websocket.service';

/** States published by pRouteTuner in CAL_STATE, in strip order. */
export const CAL_STATES = [
  'PRECHECK',
  'BASELINE',
  'CALIBRATION',
  'CONTROLLED_TEST',
  'ANALYSIS',
  'APPLY_CANDIDATE',
  'VALIDATION',
  'ACCEPT_OR_ROLLBACK',
  'COMPLETE'
] as const;

const OPERATOR_KEY = 'calibrationCard.operator';
/** CAL_STATE older than this is shown as "no data from tuner". */
const STALE_MS = 5000;
const MAX_EVENTS = 6;

interface CalEvent {
  at: number;
  text: string;
}

@Component({
  selector: 'calibration-card',
  imports: [FormsModule, MatIconModule, MatTooltipModule, CdkDrag, CdkDragHandle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./calibration-card.component.css'],
  template: `
    <section
      class="cal-panel"
      cdkDrag
      cdkDragBoundary="body"
      aria-label="Route-tracking calibration"
    >
      <header class="cal-header" cdkDragHandle>
        <mat-icon class="cal-logo" aria-hidden="true">tune</mat-icon>
        <span class="cal-title">Route Calibration</span>
        <span
          class="cal-pill"
          [class.on]="connected() && !stale()"
          [class.off]="!connected() || stale()"
          [matTooltip]="linkTip()"
        >
          <i></i>{{ !connected() ? 'No link' : stale() ? 'No tuner' : 'Live' }}
        </span>
        <button
          type="button"
          class="cal-hbtn"
          (click)="close()"
          matTooltip="Close"
          aria-label="Close calibration card"
        >
          <mat-icon>close</mat-icon>
        </button>
      </header>

      <!-- State -->
      <div class="cal-state" [class.abort]="isAbort()">
        <div class="cal-state-name">{{ stateLabel() }}</div>
        <div class="cal-state-sub">
          {{ subLine() }}
        </div>
      </div>
      <ol class="cal-strip" aria-label="Calibration progress">
        @for (s of states; track s; let i = $index) {
        <li
          [class.done]="i < stateIndex()"
          [class.active]="i === stateIndex()"
          [attr.aria-current]="i === stateIndex() ? 'step' : null"
          [matTooltip]="s"
        ></li>
        }
      </ol>

      <!-- Live numbers -->
      <div class="cal-tiles">
        <div class="cal-tile">
          <span class="lbl">Cross-track</span>
          <span class="val" [class.bad]="xteBad()">{{ fmt(xte(), 1) }}<small> m</small></span>
        </div>
        <div class="cal-tile">
          <span class="lbl">Heading err</span>
          <span class="val">{{ fmt(hdgErr(), 1) }}<small> °</small></span>
        </div>
        <div class="cal-tile">
          <span class="lbl">Score base / cand</span>
          <span class="val small">
            {{ fmt(scoreBase(), 1) }} / <b [class.good]="candBetter()">{{ fmt(scoreCand(), 1) }}</b>
          </span>
        </div>
        <div class="cal-tile">
          <span class="lbl">GNSS</span>
          <span class="val small" [class.bad]="gpsBad()" [matTooltip]="gpsTip()">{{ gpsLine() }}</span>
        </div>
      </div>

      @if (abortReason()) {
      <div class="cal-alert" role="status">
        <mat-icon aria-hidden="true">report</mat-icon>
        <span>Aborted: {{ abortReason() }}</span>
      </div>
      }

      <!-- Authorisation -->
      @if (!authorised()) {
      <fieldset class="cal-auth" [disabled]="!connected()">
        <legend>Before authorising</legend>
        <label><input type="checkbox" [(ngModel)]="chkArea" /> Inside the approved test area</label>
        <label><input type="checkbox" [(ngModel)]="chkClear" /> No people, traffic or obstacles nearby</label>
        <label><input type="checkbox" [(ngModel)]="chkTakeover" /> E-stop and manual takeover checked</label>
        <label class="cal-op">
          Operator
          <input type="text" [(ngModel)]="operator" maxlength="32" autocomplete="off" />
        </label>
        <button
          type="button"
          class="cal-btn primary"
          [disabled]="!canAuthorise()"
          (click)="authorise()"
        >
          <mat-icon aria-hidden="true">verified_user</mat-icon> Authorise calibration
        </button>
      </fieldset>
      } @else {
      <div class="cal-authed">
        <mat-icon aria-hidden="true">verified_user</mat-icon>
        <span>Authorised by <b>{{ authBy() || 'operator' }}</b></span>
        <button type="button" class="cal-btn ghost" (click)="withdraw()">Withdraw</button>
      </div>
      }

      <!-- Abort is always available while connected, no confirmation step -->
      <button
        type="button"
        class="cal-btn abort"
        [disabled]="!connected()"
        (click)="abort()"
        aria-label="Abort calibration now"
      >
        <mat-icon aria-hidden="true">pan_tool</mat-icon> ABORT CALIBRATION
      </button>

      <!-- Recent events -->
      @if (events().length) {
      <ul class="cal-events" aria-label="Recent calibration events">
        @for (e of events(); track e.at) {
        <li><time>{{ clock(e.at) }}</time>{{ e.text }}</li>
        }
      </ul>
      }
    </section>
  `
})
export class CalibrationCardComponent {
  @Output() closed = new EventEmitter<void>();

  private readonly ws = inject(MoosIvpWebsocketService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly states = CAL_STATES;

  // ---- live values from the boat -------------------------------------
  protected readonly connected = signal(this.ws.isConnected());
  protected readonly calState = signal<string>('');
  protected readonly calStateAt = signal(0);
  protected readonly lapId = signal<string>('');
  protected readonly speedBand = signal<string>('');
  protected readonly xte = signal<number | null>(null);
  protected readonly hdgErr = signal<number | null>(null);
  protected readonly scoreBase = signal<number | null>(null);
  protected readonly scoreCand = signal<number | null>(null);
  protected readonly authorised = signal(false);
  protected readonly authBy = signal<string>('');
  protected readonly abortReason = signal<string>('');
  protected readonly gpsFix = signal<string>('');
  protected readonly gpsSats = signal<number | null>(null);
  protected readonly gpsHdop = signal<number | null>(null);
  protected readonly gpsAge = signal<number | null>(null);
  protected readonly events = signal<CalEvent[]>([]);
  private readonly now = signal(Date.now());

  // ---- operator inputs -----------------------------------------------
  protected chkArea = false;
  protected chkClear = false;
  protected chkTakeover = false;
  protected operator = this.loadOperator();

  // ---- derived -------------------------------------------------------
  protected readonly stale = computed(
    () => !this.calStateAt() || this.now() - this.calStateAt() > STALE_MS
  );
  protected readonly isAbort = computed(() => this.calState() === 'ABORT');
  protected readonly stateIndex = computed(() =>
    (CAL_STATES as readonly string[]).indexOf(this.calState())
  );
  protected readonly stateLabel = computed(() => {
    if (this.stale()) return 'IDLE';
    return this.calState().replace(/_/g, ' ') || 'IDLE';
  });
  protected readonly subLine = computed(() => {
    if (this.stale()) return 'pRouteTuner not reporting';
    const parts: string[] = [];
    if (this.lapId()) parts.push(`lap ${this.lapId()}`);
    if (this.speedBand()) parts.push(`${this.speedBand()} kn band`);
    return parts.join(' · ') || ' ';
  });
  protected readonly xteBad = computed(() => {
    const v = this.xte();
    return v !== null && Math.abs(v) > 5;
  });
  protected readonly candBetter = computed(() => {
    const b = this.scoreBase();
    const c = this.scoreCand();
    return b !== null && c !== null && c < b;
  });
  protected readonly gpsBad = computed(() => {
    const age = this.gpsAge();
    const sats = this.gpsSats();
    const hdop = this.gpsHdop();
    if (age === null || age < 0 || age > 2) return true;
    if (sats !== null && sats < 6) return true;
    if (hdop !== null && hdop > 2.5) return true;
    return false;
  });
  protected readonly gpsLine = computed(() => {
    const age = this.gpsAge();
    if (age === null) return 'no data';
    if (age < 0) return 'no fix';
    if (!this.gpsFix()) return `fix ${age.toFixed(1)} s`;
    const sats = this.gpsSats() ?? 0;
    const hdop = this.gpsHdop();
    return `${this.gpsFix()} ${sats} sats ${hdop !== null ? 'HDOP ' + hdop.toFixed(1) : ''}`;
  });

  constructor() {
    this.ws.connectionState$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((s) => this.connected.set(s === 'connected'));

    this.ws.messages$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((raw) => this.ingest(raw));

    // Tick once a second so "stale" and event times update without traffic.
    const t = setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => clearInterval(t));
  }

  // ---- commands --------------------------------------------------------
  protected canAuthorise(): boolean {
    return (
      this.connected() &&
      this.chkArea &&
      this.chkClear &&
      this.chkTakeover &&
      this.operator.trim().length > 0
    );
  }

  protected authorise(): void {
    if (!this.canAuthorise()) return;
    const op = this.sanitize(this.operator.trim());
    this.saveOperator(op);
    const session = this.newSession();
    this.ws.send(`CAL_AUTH=true#OPERATOR=${op}#SESSION=${session}`);
    // Optimistic UI is deliberately avoided: the card waits for the boat to
    // echo CAL_AUTH=true before showing "Authorised".
  }

  protected withdraw(): void {
    this.ws.send('CAL_AUTH=false');
    this.resetChecks();
  }

  protected abort(): void {
    this.ws.send('CAL_ABORT=true#REASON=operator');
    this.resetChecks();
  }

  protected close(): void {
    this.closed.emit();
  }

  // ---- inbound ---------------------------------------------------------
  private ingest(raw: string): void {
    const text = (raw || '').trim();
    if (!text) return;
    if (text.startsWith('{')) {
      try {
        const obj = JSON.parse(text) as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) {
          if (this.isOurs(k)) this.apply(k, v);
        }
      } catch {
        /* not JSON after all; ignore */
      }
      return;
    }
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.substring(0, eq).trim();
      if (this.isOurs(k)) this.apply(k, line.substring(eq + 1).trim());
    }
  }

  private isOurs(key: string): boolean {
    return key.startsWith('CAL_') || key.startsWith('GPS_');
  }

  private apply(key: string, value: unknown): void {
    const str = value === null || value === undefined ? '' : String(value);
    const num = typeof value === 'number' ? value : parseFloat(str);
    const n = Number.isFinite(num) ? num : null;

    switch (key) {
      case 'CAL_STATE':
        this.calState.set(str.toUpperCase());
        this.calStateAt.set(Date.now());
        // a new session clears the previous abort banner
        if (str.toUpperCase() === 'PRECHECK') this.abortReason.set('');
        break;
      case 'CAL_LAP_ID':
        this.lapId.set(str);
        break;
      case 'CAL_SPEED_BAND':
        this.speedBand.set(str);
        break;
      case 'CAL_XTE':
        this.xte.set(n);
        break;
      case 'CAL_HDG_ERR':
        this.hdgErr.set(n);
        break;
      case 'CAL_SCORE_BASELINE':
        this.scoreBase.set(n);
        break;
      case 'CAL_SCORE_CANDIDATE':
        this.scoreCand.set(n);
        break;
      case 'CAL_AUTH':
        this.authorised.set(str.toLowerCase() === 'true');
        break;
      case 'CAL_AUTH_BY':
        this.authBy.set(str);
        break;
      case 'CAL_ABORT_REASON':
        this.abortReason.set(str);
        break;
      case 'CAL_EVENT':
        this.pushEvent(str);
        break;
      case 'GPS_FIX_LABEL':
        this.gpsFix.set(str);
        break;
      case 'GPS_SATS':
        this.gpsSats.set(n);
        break;
      case 'GPS_HDOP':
        this.gpsHdop.set(n);
        break;
      case 'GPS_AGE':
        this.gpsAge.set(n);
        break;
    }
  }

  private pushEvent(text: string): void {
    if (!text) return;
    const list = this.events();
    // iWebSocket resends the last value every Iterate: keep one entry per change
    if (list.length && list[0].text === text) return;
    this.events.set([{ at: Date.now(), text }, ...list].slice(0, MAX_EVENTS));
  }

  // ---- helpers ---------------------------------------------------------
  protected fmt(v: number | null, digits: number): string {
    return v === null ? '--' : v.toFixed(digits);
  }

  protected clock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  }

  protected linkTip(): string {
    if (!this.connected()) return 'No connection to iWebSocket';
    if (this.stale()) return 'Connected, but pRouteTuner is not publishing CAL_STATE';
    return 'Receiving calibration data';
  }

  protected gpsTip(): string {
    const age = this.gpsAge();
    return age === null
      ? 'No GPS_* data. Needs the iDivisorNMEA GNSS update.'
      : `Last valid fix ${age < 0 ? 'never' : age.toFixed(1) + ' s ago'}. ` +
          'Precheck needs fix age under 2 s, 6+ satellites, HDOP 2.5 or less.';
  }

  /** '#' and '=' are frame separators on the wire. */
  private sanitize(s: string): string {
    return s.replace(/[#=\n\r]/g, ' ').trim();
  }

  private newSession(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: any = (globalThis as any).crypto;
      if (c?.randomUUID) return c.randomUUID();
    } catch {
      /* fall through */
    }
    return `cal${Date.now().toString(36)}`;
  }

  private resetChecks(): void {
    this.chkArea = false;
    this.chkClear = false;
    this.chkTakeover = false;
  }

  private loadOperator(): string {
    try {
      return localStorage.getItem(OPERATOR_KEY) || '';
    } catch {
      return '';
    }
  }

  private saveOperator(op: string): void {
    try {
      localStorage.setItem(OPERATOR_KEY, op);
    } catch {
      /* storage unavailable; not needed to work */
    }
  }
}
