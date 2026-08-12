/** Mission Replay - recorder + player
 *
 * RECORDING captures both of the streams that make up a mission: Signal K deltas
 * (tapped in skstream.worker) and MOOS-IvP variables (tapped in AppComponent).
 * Events go into an outbox that uploads serially with a sequence number, so a
 * retried chunk can never be appended twice.
 *
 * REPLAY loads a recording as one string plus typed-array indexes and pushes
 * events back through the very same pipelines the live data uses. Recorded
 * Signal K messages go to the worker's parseStreamMessage(); recorded MOOS lines
 * go to AppComponent.handleMoosIvPMessage() via moos$.
 * ************************************/

import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import {
  catchError,
  concatMap,
  delay,
  finalize,
  retryWhen,
  scan
} from 'rxjs/operators';
import { AppFacade } from 'src/app/app.facade';
import { SKWorkerService } from '../skstream/skstream.service';
import { ReplayApiService, RecordingMeta } from './replay-api.service';

/** kinds packed into the index's Uint8Array */
const KIND_SK = 0;
const KIND_MOOS = 1;

const TICK_MS = 100;
const MAX_TRAIL_POINTS = 5000;
/** longest gap between fixes still treated as movement rather than a dropout */
const MAX_INTERP_GAP_MS = 5000;
/** stop queuing rather than exhaust memory if the server is unreachable */
const MAX_OUTBOX_BYTES = 30 * 1024 * 1024;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

interface OutboxChunk {
  seq: number;
  lines: string;
  eventCount: number;
  durationMs: number;
}

export type RecorderState = 'idle' | 'recording' | 'degraded' | 'finalizing';

@Injectable({ providedIn: 'root' })
export class ReplayService {
  private app = inject(AppFacade);
  private api = inject(ReplayApiService);
  private worker = inject(SKWorkerService);

  // ---- recorder state -------------------------------------------------
  readonly recorderState = signal<RecorderState>('idle');
  readonly recordingMeta = signal<RecordingMeta | null>(null);
  readonly recordedEvents = signal<number>(0);
  readonly recordedMs = signal<number>(0);
  /** capturing right now - what the record button reflects */
  readonly isRecording = computed(() => {
    const s = this.recorderState();
    return s === 'recording' || s === 'degraded';
  });
  /** the tail is uploading and the recording is being closed out */
  readonly isFinalizing = computed(() => this.recorderState() === 'finalizing');
  /** any live recorder session - capture plus finalisation */
  readonly isBusy = computed(() => this.recorderState() !== 'idle');

  private t0 = 0;
  private nextSeq = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  private pendingCount = 0;
  private outbox = new Subject<OutboxChunk>();
  private outboxBytes = 0;
  private moosFlushTimer: ReturnType<typeof setInterval> | null = null;

  // ---- player state ---------------------------------------------------
  readonly isReplaying = signal<boolean>(false);
  readonly playing = signal<boolean>(false);
  readonly rate = signal<number>(1);
  /** virtual time within the recording, ms - what the UI displays */
  readonly vt = signal<number>(0);
  /**
   * Time that pipeline state has actually been drained to. Distinct from vt()
   * because dragging the timeline moves the display before anything is applied;
   * without it a preview would hide the fact that the commit is a rewind.
   */
  private appliedMs = 0;
  readonly durationMs = signal<number>(0);
  readonly loading = signal<boolean>(false);
  readonly loadedMeta = signal<RecordingMeta | null>(null);

  /** emits recorded MOOS lines; AppComponent merges this with the live socket */
  private moosSource = new Subject<string>();
  readonly moos$ = this.moosSource.asObservable();
  /** fires after every drain so the host can refresh derived state */
  private renderedSource = new Subject<void>();
  readonly rendered$ = this.renderedSource.asObservable();
  /** asks AppComponent to wipe MOOS-derived state before a backward seek */
  private resetSource = new Subject<void>();
  readonly resetRequest$ = this.resetSource.asObservable();

  // Index over the loaded recording. Holding the NDJSON as one string plus
  // offsets costs ~fileBytes + 13 bytes/event; holding parsed objects instead
  // would cost 6-12x that and blow up on a long mission.
  private raw = '';
  private off: Int32Array = new Int32Array(0);
  private evT: Float64Array = new Float64Array(0);
  private evKind: Uint8Array = new Uint8Array(0);
  private count = 0;
  private cursor = 0;
  private startEpoch = 0;

  // Self positions, extracted at load, so the trail is a pure function of vt.
  private trailT: Float64Array = new Float64Array(0);
  private trailLon: Float64Array = new Float64Array(0);
  private trailLat: Float64Array = new Float64Array(0);
  private trailCount = 0;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickWall = 0;

  constructor() {
    // Serial upload: order matters, so concatMap - never mergeMap.
    this.outbox
      .pipe(
        concatMap((chunk) => {
          const id = this.recordingMeta()?.id;
          if (!id) {
            return of(null);
          }
          return this.api.appendChunk(id, chunk).pipe(
            retryWhen((errors) =>
              errors.pipe(
                scan((n) => n + 1, 0),
                concatMap((n) => {
                  if (n > RETRY_DELAYS.length) {
                    throw new Error('chunk upload failed');
                  }
                  this.recorderState.set('degraded');
                  return of(n).pipe(
                    delay(RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length - 1)])
                  );
                })
              )
            ),
            catchError(() => {
              this.recorderState.set('degraded');
              return of(null);
            }),
            // give back the queue budget whether it succeeded or was given up on
            finalize(() => this.releaseOutbox(chunk.lines.length))
          );
        })
      )
      .subscribe();

    this.worker.record$().subscribe((chunk) => {
      // isBusy, not isRecording: the worker's tail chunk arrives by postMessage
      // after the stop command, i.e. once the state is already 'finalizing'.
      if (!this.isBusy()) {
        return;
      }
      this.enqueue(chunk.lines, chunk.eventCount, chunk.durationMs);
    });

    window.addEventListener('beforeunload', () => this.flushOnUnload());
  }

  // ===================== RECORDER =====================

  async startRecording(name?: string): Promise<void> {
    if (this.isBusy() || this.isReplaying()) {
      return;
    }
    this.t0 = Date.now();
    this.nextSeq = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingCount = 0;
    this.outboxBytes = 0;
    this.recordedEvents.set(0);
    this.recordedMs.set(0);

    const seed = {
      name: name || `Mission ${new Date(this.t0).toLocaleString()}`,
      startedAt: new Date(this.t0).toISOString(),
      selfId: this.app.data.selfId,
      vesselName: this.app.data.vessels?.self?.name
    };

    try {
      const meta = await this.api.create(seed).toPromise();
      this.recordingMeta.set(meta);
    } catch (e) {
      this.app.showMessage(
        'Could not start recording on the server.',
        false,
        5000
      );
      return;
    }

    const tuning = this.app.config.replay ?? {
      chunkSeconds: 5,
      chunkBytes: 1048576
    };

    this.recorderState.set('recording');
    // start the worker-side Signal K tap on the same clock origin
    this.worker.postMessage({
      cmd: 'record',
      options: {
        start: true,
        t0: this.t0,
        flushMs: tuning.chunkSeconds * 1000,
        flushBytes: tuning.chunkBytes
      }
    });
    // MOOS lines arrive one at a time; batch them on the same cadence as the worker
    this.moosFlushTimer = setInterval(
      () => this.flushPending(),
      tuning.chunkSeconds * 1000
    );
  }

  /** called by AppComponent for every inbound MOOS message while recording */
  recordMoos(line: string): void {
    // Deliberately isRecording, not isBusy: MOOS traffic keeps flowing while the
    // recording is being finalised, and anything queued then would be flushed by
    // waitForOutbox's own poll - the outbox would never drain and every stop
    // would sit out the full timeout. Lines after the stop are not part of the
    // recording anyway; stopRecording() flushes everything up to that instant.
    if (!this.isRecording() || !line) {
      return;
    }
    this.pending.push(
      `{"t":${Date.now() - this.t0},"k":"moos","d":${JSON.stringify(line)}}`
    );
    this.pendingCount++;
    this.pendingBytes += line.length + 32;
    if (this.pendingBytes >= 256 * 1024) {
      this.flushPending();
    }
  }

  async stopRecording(): Promise<void> {
    const state = this.recorderState();
    if (state !== 'recording' && state !== 'degraded') {
      return;
    }
    this.recorderState.set('finalizing');
    this.worker.postMessage({ cmd: 'record', options: { start: false } });
    if (this.moosFlushTimer) {
      clearInterval(this.moosFlushTimer);
      this.moosFlushTimer = null;
    }
    this.flushPending();

    // The worker flushes its tail synchronously but delivers it by postMessage,
    // and finalize() does not go through the serial outbox - so wait for both to
    // land, or the last seconds of the mission would be appended after the
    // recording was already marked complete.
    await this.waitForOutbox(15000);

    const id = this.recordingMeta()?.id;
    const durationMs = Date.now() - this.t0;
    if (id) {
      try {
        await this.api
          .finalize(id, {
            endedAt: new Date().toISOString(),
            durationMs,
            eventCount: this.recordedEvents()
          })
          .toPromise();
      } catch (e) {
        // the server repairs unfinalised recordings on next list()
        this.app.debug('Could not finalize recording; server will repair it.');
      }
    }
    this.recorderState.set('idle');
    this.recordingMeta.set(null);
  }

  /** resolves once the upload queue drains, or on timeout if the server is down */
  private waitForOutbox(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        // one extra tick so a worker flush already in flight is counted
        this.flushPending();
        if (this.outboxBytes === 0 || Date.now() > deadline) {
          resolve();
          return;
        }
        setTimeout(poll, 200);
      };
      setTimeout(poll, 200);
    });
  }

  private flushPending() {
    if (this.pending.length === 0) {
      return;
    }
    const lines = this.pending.join('\n');
    const n = this.pendingCount;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingCount = 0;
    this.enqueue(lines, n, Date.now() - this.t0);
  }

  private enqueue(lines: string, eventCount: number, durationMs: number) {
    if (!lines) {
      return;
    }
    // Refusing to queue is bad, but silently ballooning memory until the tab
    // dies is worse - surface it instead.
    if (this.outboxBytes + lines.length > MAX_OUTBOX_BYTES) {
      this.recorderState.set('degraded');
      this.app.debug('Replay outbox full - dropping chunk.');
      return;
    }
    this.outboxBytes += lines.length;
    this.recordedEvents.update((n) => n + eventCount);
    this.recordedMs.set(durationMs);
    this.outbox.next({ seq: this.nextSeq++, lines, eventCount, durationMs });
  }

  private releaseOutbox(bytes: number) {
    this.outboxBytes = Math.max(0, this.outboxBytes - bytes);
    if (this.recorderState() === 'degraded' && this.outboxBytes === 0) {
      this.recorderState.set('recording');
    }
  }

  /** last-ditch attempt to not lose the tail when the tab closes */
  private flushOnUnload() {
    if (!this.isBusy()) {
      return;
    }
    const id = this.recordingMeta()?.id;
    if (!id || this.pending.length === 0) {
      return;
    }
    this.api.beacon(id, {
      seq: this.nextSeq++,
      lines: this.pending.join('\n'),
      eventCount: this.pendingCount,
      durationMs: Date.now() - this.t0
    });
    this.pending = [];
  }

  // ===================== PLAYER =====================

  /** downloads a recording and builds the in-memory indexes */
  async load(meta: RecordingMeta): Promise<boolean> {
    this.loading.set(true);
    try {
      const text = await this.api.events(meta.id).toPromise();
      this.buildIndex(text ?? '');
      this.loadedMeta.set(meta);
      this.startEpoch = Date.parse(meta.startedAt) || Date.now();
      this.durationMs.set(
        this.count > 0 ? this.evT[this.count - 1] : meta.durationMs
      );
      this.vt.set(0);
      this.cursor = 0;
      this.appliedMs = 0;
      return true;
    } catch (e) {
      this.app.showMessage('Could not load recording.', false, 5000);
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  private buildIndex(text: string) {
    this.raw = text;
    const len = text.length;
    // one pass to count lines, a second to fill - avoids growing arrays
    let n = 0;
    for (let i = 0; i < len; i++) {
      if (text.charCodeAt(i) === 10) {
        n++;
      }
    }
    if (len > 0 && text.charCodeAt(len - 1) !== 10) {
      n++;
    }

    const off = new Int32Array(n + 1);
    const evT = new Float64Array(n);
    const evKind = new Uint8Array(n);
    const trailT = new Float64Array(n);
    const trailLon = new Float64Array(n);
    const trailLat = new Float64Array(n);

    let idx = 0;
    let trail = 0;
    let from = 0;
    while (from < len) {
      let nl = text.indexOf('\n', from);
      if (nl === -1) {
        nl = len;
      }
      if (nl > from) {
        off[idx] = from;
        // Work on the sliced line: an unbounded indexOf over `text` would scan to
        // the end of the file on every miss, making this quadratic.
        const line = text.slice(from, nl);
        // Cheap field scrape - JSON.parsing the whole file at load time would
        // cost 6-12x the memory. Located by key rather than byte offset: a
        // positional read silently misfiles every event if the writer ever emits
        // different whitespace, and a MOOS line parsed as Signal K fails quietly.
        evT[idx] = this.scrapeNumber(line, '"t":');
        evKind[idx] =
          this.scrapeChar(line, '"k":"') === 109 ? KIND_MOOS : KIND_SK; // 'm'
        if (
          evKind[idx] === KIND_SK &&
          line.indexOf('navigation.position') !== -1
        ) {
          const pos = this.scrapePosition(line);
          if (pos) {
            trailT[trail] = evT[idx];
            trailLon[trail] = pos[0];
            trailLat[trail] = pos[1];
            trail++;
          }
        }
        idx++;
      }
      from = nl + 1;
    }
    off[idx] = len;

    this.off = off;
    this.evT = evT;
    this.evKind = evKind;
    this.count = idx;
    this.trailT = trailT;
    this.trailLon = trailLon;
    this.trailLat = trailLat;
    this.trailCount = trail;
  }

  /** number following `key` in a JSON line, tolerating whitespace; NaN -> 0 */
  private scrapeNumber(line: string, key: string): number {
    const at = line.indexOf(key);
    if (at === -1) {
      return 0;
    }
    const n = parseFloat(line.slice(at + key.length));
    return isNaN(n) ? 0 : n;
  }

  /** first char code of the string value following `key`, tolerating whitespace */
  private scrapeChar(line: string, key: string): number {
    let at = line.indexOf(key);
    if (at === -1) {
      // `"k": "moos"` - retry without the opening quote of the value
      const bare = key.slice(0, -1);
      at = line.indexOf(bare);
      if (at === -1) {
        return -1;
      }
      let i = at + bare.length;
      while (i < line.length && (line[i] === ' ' || line[i] === '"')) {
        i++;
      }
      return line.charCodeAt(i);
    }
    return line.charCodeAt(at + key.length);
  }

  /** pulls latitude/longitude out of a single NDJSON line without parsing it all */
  private scrapePosition(line: string): [number, number] | null {
    const latAt = line.indexOf('"latitude":');
    const lonAt = line.indexOf('"longitude":');
    if (latAt === -1 || lonAt === -1) {
      return null;
    }
    const lat = parseFloat(line.slice(latAt + '"latitude":'.length));
    const lon = parseFloat(line.slice(lonAt + '"longitude":'.length));
    if (isNaN(lat) || isNaN(lon)) {
      return null;
    }
    return [lon, lat];
  }

  /** hands control of the pipelines over to the recording */
  enterReplay(selfId: string) {
    this.isReplaying.set(true);
    this.playing.set(false);
    this.worker.postMessage({
      cmd: 'replayStart',
      options: {
        selfId,
        hello: {
          name: 'mission-replay',
          version: '1.0.0',
          self: selfId,
          roles: ['master', 'main'],
          timestamp: new Date(this.startEpoch).toISOString()
        }
      }
    });
  }

  exitReplay() {
    this.pause();
    this.isReplaying.set(false);
    this.loadedMeta.set(null);
    this.raw = '';
    this.off = new Int32Array(0);
    this.evT = new Float64Array(0);
    this.evKind = new Uint8Array(0);
    this.trailT = new Float64Array(0);
    this.trailLon = new Float64Array(0);
    this.trailLat = new Float64Array(0);
    this.count = 0;
    this.trailCount = 0;
    this.cursor = 0;
    this.appliedMs = 0;
    this.vt.set(0);
    this.worker.postMessage({ cmd: 'replayStop', options: {} });
  }

  play() {
    if (!this.isReplaying() || this.playing()) {
      return;
    }
    if (this.vt() >= this.durationMs()) {
      this.seek(0);
    }
    this.playing.set(true);
    this.lastTickWall = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  pause() {
    this.playing.set(false);
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  togglePlay() {
    this.playing() ? this.pause() : this.play();
  }

  setRate(r: number) {
    this.rate.set(r);
  }

  private tick() {
    const wall = Date.now();
    const advanced = (wall - this.lastTickWall) * this.rate();
    this.lastTickWall = wall;
    const next = Math.min(this.vt() + advanced, this.durationMs());
    this.drainTo(next, true);
    this.vt.set(next);
    if (next >= this.durationMs()) {
      this.pause();
    }
  }

  /** the timeline handle while being dragged: clock and trail only, no drain */
  previewSeek(target: number) {
    this.vt.set(Math.max(0, Math.min(target, this.durationMs())));
    this.updateTrail();
    this.renderedSource.next();
  }

  /** committed seek - rewinds state when going backwards */
  seek(target: number) {
    const t = Math.max(0, Math.min(target, this.durationMs()));
    if (t < this.appliedMs) {
      // Backward: accumulated state cannot be un-applied, so wipe it and
      // fast-forward from the start of the recording.
      this.worker.postMessage({
        cmd: 'replayReset',
        options: { now: this.startEpoch }
      });
      this.resetSource.next();
      this.cursor = 0;
      this.appliedMs = 0;
    }
    this.drainTo(t, false);
    this.vt.set(t);
    this.renderRequest();
  }

  /**
   * Pushes every event between the cursor and `to`. `live` batches per tick;
   * a seek passes false so the whole span is applied silently and rendered once.
   */
  private drainTo(to: number, live: boolean) {
    const deltas: unknown[] = [];
    const moos: string[] = [];
    this.appliedMs = to;
    while (this.cursor < this.count && this.evT[this.cursor] <= to) {
      const i = this.cursor++;
      const line = this.raw.slice(this.off[i], this.off[i + 1]);
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (this.evKind[i] === KIND_MOOS) {
        moos.push(ev.d);
      } else {
        deltas.push(ev.d);
      }
    }
    if (deltas.length !== 0) {
      this.worker.postMessage({
        cmd: 'replayDeltas',
        options: {
          deltas,
          now: this.startEpoch + to,
          render: live
        }
      });
    }
    moos.forEach((m) => this.moosSource.next(m));
    if (live) {
      this.updateTrail();
      this.renderedSource.next();
    }
  }

  /** after a silent drain, ask the worker for one frame */
  private renderRequest() {
    this.worker.postMessage({
      cmd: 'replayDeltas',
      options: { deltas: [], now: this.startEpoch + this.vt(), render: true }
    });
    this.updateTrail();
    this.renderedSource.next();
  }

  /**
   * The trail is derived from the position index rather than sampled on a timer,
   * so it stays exact at any playback rate and after a scrub in either direction.
   */
  private updateTrail() {
    const cut = this.upperBound(this.trailT, this.trailCount, this.vt());
    const stride = Math.max(1, Math.ceil(cut / MAX_TRAIL_POINTS));
    const out: Array<[number, number]> = [];
    for (let i = 0; i < cut; i += stride) {
      out.push([this.trailLon[i], this.trailLat[i]]);
    }
    // always include the most recent fix so the track meets the vessel
    if (cut > 0 && (cut - 1) % stride !== 0) {
      out.push([this.trailLon[cut - 1], this.trailLat[cut - 1]]);
    }
    // ...then the interpolated point, which is where the vessel actually is
    const pos = this.positionAt(this.vt());
    if (pos && cut > 0) {
      out.push(pos);
    }
    this.app.data.trail = out;
    this.applyInterpolatedPosition();
  }

  /**
   * Position at virtual time `t`, linearly interpolated between the two
   * recorded fixes bracketing it.
   *
   * Signal K carries navigation.position at whatever rate the source publishes
   * it - 1 Hz on this boat - so replaying fixes as they land makes the vessel
   * jump in one discrete step per second instead of moving. A recording, unlike
   * the live stream, already knows the *next* fix, so the gap can be filled in.
   */
  private positionAt(t: number): [number, number] | null {
    const n = this.trailCount;
    if (n === 0) {
      return null;
    }
    const hi = this.upperBound(this.trailT, n, t);
    if (hi === 0) {
      return [this.trailLon[0], this.trailLat[0]];
    }
    if (hi >= n) {
      return [this.trailLon[n - 1], this.trailLat[n - 1]];
    }
    const i = hi - 1;
    const span = this.trailT[hi] - this.trailT[i];
    // A long gap is a dropout, not slow movement - gliding across it would draw
    // a track the boat never sailed. Hold the last known fix instead.
    if (span <= 0 || span > MAX_INTERP_GAP_MS) {
      return [this.trailLon[i], this.trailLat[i]];
    }
    const f = (t - this.trailT[i]) / span;
    return [
      this.trailLon[i] + (this.trailLon[hi] - this.trailLon[i]) * f,
      this.trailLat[i] + (this.trailLat[hi] - this.trailLat[i]) * f
    ];
  }

  /**
   * Puts the vessel at the interpolated position for the current virtual time.
   * Public because the worker's update message lands asynchronously carrying the
   * raw fix; AppComponent re-applies this in the same task, or the boat would
   * snap backwards by up to a full fix interval every time one arrives.
   * Always a fresh array - `fb-vessel` redraws on the input reference changing.
   */
  applyInterpolatedPosition() {
    if (!this.isReplaying()) {
      return;
    }
    const pos = this.positionAt(this.vt());
    const self = this.app.data.vessels?.self;
    if (pos && self) {
      self.position = pos;
    }
  }

  /** index of the first element greater than `value` */
  private upperBound(arr: Float64Array, len: number, value: number): number {
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}
