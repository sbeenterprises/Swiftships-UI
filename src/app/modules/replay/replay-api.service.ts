/** Mission Replay - recordings REST client
 *
 * Talks to the endpoints the SwiftShips plugin mounts under
 * `/signalk/v1/api/swiftships/recordings` (helper/replay/recordings.ts).
 *
 * Uses HttpClient directly rather than SignalKClient because SignalKClient has
 * no delete(), rewrites `.` to `/` in every path, and always parses responses as
 * JSON - none of which work for this API.
 * ************************************/

import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { SignalKClient } from 'signalk-client-angular';
import { Observable } from 'rxjs';
import { AppFacade } from 'src/app/app.facade';

export type RecordingStatus = 'recording' | 'complete' | 'interrupted';

export interface RecordingMeta {
  id: string;
  name: string;
  notes?: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  eventCount: number;
  sizeBytes: number;
  selfId?: string;
  vesselName?: string;
  status: RecordingStatus;
  nextSeq: number;
}

@Injectable({ providedIn: 'root' })
export class ReplayApiService {
  private http = inject(HttpClient);
  private signalk = inject(SignalKClient);
  private app = inject(AppFacade);

  /** `http://host:port/signalk/v1/api/` -> `.../swiftships/recordings`.
   * Same source skstream.facade uses for the stream endpoint, so it honours
   * ?host=/?port= and config.signalk.url. */
  private base(): string {
    const ep = this.signalk.server?.endpoints?.['v1']?.['signalk-http'];
    return `${ep ?? '/signalk/v1/api/'}swiftships/recordings`;
  }

  /** mirrors SignalKHttp: bearer token when we have one, else session cookie */
  private opts(): { headers?: HttpHeaders; withCredentials?: boolean } {
    const token = this.app.getFBToken();
    return token
      ? { headers: new HttpHeaders({ Authorization: `JWT ${token}` }) }
      : { withCredentials: true };
  }

  list(): Observable<RecordingMeta[]> {
    return this.http.get<RecordingMeta[]>(this.base(), this.opts());
  }

  meta(id: string): Observable<RecordingMeta> {
    return this.http.get<RecordingMeta>(
      `${this.base()}/${id}/meta`,
      this.opts()
    );
  }

  create(seed: {
    name: string;
    startedAt: string;
    selfId?: string;
    vesselName?: string;
  }): Observable<RecordingMeta> {
    return this.http.post<RecordingMeta>(this.base(), seed, this.opts());
  }

  /** `lines` is a raw NDJSON blob; `seq` makes retries idempotent server-side */
  appendChunk(
    id: string,
    body: {
      seq: number;
      lines: string;
      eventCount: number;
      durationMs: number;
    }
  ): Observable<{ nextSeq: number; duplicate?: boolean }> {
    return this.http.post<{ nextSeq: number; duplicate?: boolean }>(
      `${this.base()}/${id}/chunk`,
      body,
      this.opts()
    );
  }

  finalize(
    id: string,
    body: { endedAt: string; durationMs: number; eventCount: number }
  ): Observable<RecordingMeta> {
    return this.http.post<RecordingMeta>(
      `${this.base()}/${id}/finalize`,
      body,
      this.opts()
    );
  }

  rename(
    id: string,
    body: { name?: string; notes?: string }
  ): Observable<RecordingMeta> {
    return this.http.post<RecordingMeta>(
      `${this.base()}/${id}/rename`,
      body,
      this.opts()
    );
  }

  /** the whole NDJSON body as text - never let Angular try to JSON.parse it */
  events(id: string): Observable<string> {
    return this.http.get(`${this.base()}/${id}/events`, {
      ...this.opts(),
      responseType: 'text'
    }) as Observable<string>;
  }

  /** POST, not DELETE: the server's own DELETE catch-all on /signalk/v1/api/*
   * (src/put.js) intercepts before the plugin router and 403s read-only sessions */
  remove(id: string): Observable<{ id: string; deleted: boolean }> {
    return this.http.post<{ id: string; deleted: boolean }>(
      `${this.base()}/${id}/delete`,
      {},
      this.opts()
    );
  }

  /** best-effort flush on page unload - fire and forget, no response */
  beacon(id: string, body: unknown): boolean {
    try {
      return navigator.sendBeacon(
        `${this.base()}/${id}/chunk`,
        new Blob([JSON.stringify(body)], { type: 'application/json' })
      );
    } catch (e) {
      return false;
    }
  }
}
