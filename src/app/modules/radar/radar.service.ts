import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { RadarSpoke, RadarConfig } from './radar-display.component';
import { AppFacade } from '../../app.facade';

declare const protobuf: any;

export interface RadarServerInfo {
  id: string;
  name: string;
  streamUrl: string;
  controlUrl: string;
  spokes: number;
  maxSpokeLen: number;
  legend: { [key: number]: { color: string } };
  controls: any;
}

@Injectable({
  providedIn: 'root'
})
export class RadarService {
  private webSocket: WebSocket | null = null;
  private RadarMessage: any;

  // Observables
  public connected$ = new BehaviorSubject<boolean>(false);
  public connecting$ = new BehaviorSubject<boolean>(false);
  public radarConfig$ = new BehaviorSubject<RadarConfig | null>(null);
  public spokeData$ = new Subject<RadarSpoke>();
  public error$ = new Subject<string>();

  private currentRadar: RadarServerInfo | null = null;

  constructor(private app: AppFacade) {
    this.loadProtobuf();
    // Mirror the connection state into app data, where the settings dialog
    // reads it (connectionState.radar).
    this.connected$.subscribe(() => this.publishState());
    this.connecting$.subscribe(() => this.publishState());
  }

  private publishState() {
    const data: any = this.app.data;
    if (!data) {
      return;
    }
    if (!data.connectionState) {
      data.connectionState = {};
    }
    data.connectionState.radar = {
      connected: this.connected$.value,
      connecting: this.connecting$.value,
      lastAttempt: Date.now()
    };
  }

  /** Radar server base URL from settings, e.g. http://192.168.22.11:3001 */
  private baseUrl(): string {
    const radarConfig = this.app.config.radar;
    return radarConfig?.enabled
      ? `${String(radarConfig.url).replace(/\/+$/, '')}:${radarConfig.port}`
      : 'http://localhost:3001';
  }

  /**
   * Discover radars. Mayara 3.x serves the Signal K Radar API
   * (/signalk/v2/api/vessels/self/radars + /{id}/capabilities); older
   * mayara builds (2025) served /v1/api/radars with spokes / maxSpokeLen /
   * legend / streamUrl inline. Both are mapped to RadarServerInfo.
   */
  private async discoverRadars(baseUrl: string): Promise<{ [id: string]: Omit<RadarServerInfo, 'id'> }> {
    const v2 = `${baseUrl}/signalk/v2/api/vessels/self/radars`;
    const res = await fetch(v2);
    if (res.ok) {
      const body = await res.json();
      const list = body?.radars ?? {};
      const out: { [id: string]: Omit<RadarServerInfo, 'id'> } = {};
      const wsBase = baseUrl.replace(/^http/, 'ws');
      for (const id of Object.keys(list)) {
        const capsRes = await fetch(`${v2}/${encodeURIComponent(id)}/capabilities`);
        if (!capsRes.ok) {
          throw new Error(`capabilities for ${id}: HTTP ${capsRes.status}`);
        }
        const caps = await capsRes.json();
        // Legend: array of { color: '#rrggbbaa' } indexed by pixel value.
        const legend: { [key: number]: { color: string } } = {};
        (caps?.legend?.pixels ?? []).forEach((px: any, i: number) => {
          if (px?.color) {
            legend[i] = { color: px.color };
          }
        });
        out[id] = {
          name: list[id]?.name ?? id,
          streamUrl: `${wsBase}/signalk/v2/api/vessels/self/radars/${encodeURIComponent(id)}/spokes`,
          controlUrl: `${v2}/${encodeURIComponent(id)}/controls`,
          spokes: caps.spokesPerRevolution,
          maxSpokeLen: caps.maxSpokeLength,
          legend,
          controls: caps.controls
        };
      }
      return out;
    }
    if (res.status !== 404) {
      throw new Error(`${v2}: HTTP ${res.status}`);
    }
    // Legacy mayara
    const legacy = await fetch(`${baseUrl}/v1/api/radars`);
    if (!legacy.ok) {
      throw new Error(`${baseUrl}/v1/api/radars: HTTP ${legacy.status}`);
    }
    return legacy.json();
  }

  private async loadProtobuf() {
    try {
      // Load protobuf library
      if (typeof protobuf === 'undefined') {
        const script = document.createElement('script');
        script.src = 'assets/protobuf.min.js';
        script.onload = () => {
          this.initializeProtobuf();
        };
        document.head.appendChild(script);
      } else {
        this.initializeProtobuf();
      }
    } catch (error) {
      this.error$.next('Failed to load protobuf library');
    }
  }

  private initializeProtobuf() {
    protobuf.load('assets/RadarMessage.proto', (err: any, root: any) => {
      if (err) {
        this.error$.next('Failed to load RadarMessage.proto');
        return;
      }
      this.RadarMessage = root.lookupType('RadarMessage');
    });
  }

  async connectToRadar(radarId?: string): Promise<void> {
    if (this.connecting$.value || this.connected$.value) {
      return;
    }

    this.connecting$.next(true);

    try {
      // Fetch available radars (new Signal K Radar API, or legacy mayara)
      const radars = await this.discoverRadars(this.baseUrl());

      // If no specific radar ID provided, use the first available radar
      if (!radarId) {
        const availableRadarIds = Object.keys(radars);
        if (availableRadarIds.length === 0) {
          throw new Error('No radars available');
        }
        radarId = availableRadarIds[0];
      }

      if (!radars[radarId]) {
        const availableIds = Object.keys(radars).join(', ');
        throw new Error(`Radar ${radarId} not found. Available radars: ${availableIds}`);
      }

      this.currentRadar = {
        id: radarId,
        ...radars[radarId]
      };

      // Set initial configuration
      const config: RadarConfig = {
        spokes: this.currentRadar.spokes,
        maxSpokeLen: this.currentRadar.maxSpokeLen,
        legend: this.currentRadar.legend,
        range: 1852 // Default 1nm, will be updated by range control
      };
      
      this.radarConfig$.next(config);

      // Connect to WebSocket
      await this.connectWebSocket();

    } catch (error) {
      this.connecting$.next(false);
      this.error$.next(`Failed to connect to radar: ${error}`);
      throw error;
    }
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.currentRadar) {
        reject('No radar configuration');
        return;
      }

      this.webSocket = new WebSocket(this.currentRadar.streamUrl);
      this.webSocket.binaryType = 'arraybuffer';

      this.webSocket.onopen = () => {
        console.log('Radar WebSocket connection opened');
        this.connected$.next(true);
        this.connecting$.next(false);
        resolve();
      };

      this.webSocket.onclose = (event) => {
        console.log('Radar WebSocket connection closed:', event);
        this.connected$.next(false);
        this.connecting$.next(false);
        
        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
          if (this.currentRadar) {
            this.connectToRadar(this.currentRadar.id);
          }
        }, 5000);
      };

      this.webSocket.onerror = (error) => {
        console.error('Radar WebSocket error:', error);
        this.connecting$.next(false);
        this.error$.next('WebSocket connection error');
        reject(error);
      };

      this.webSocket.onmessage = (event) => {
        this.handleRadarMessage(event.data);
      };

      // Timeout for connection
      setTimeout(() => {
        if (this.connecting$.value) {
          this.connecting$.next(false);
          reject('Connection timeout');
        }
      }, 10000);
    });
  }

  private handleRadarMessage(data: ArrayBuffer) {
    if (!this.RadarMessage) {
      return;
    }

    try {
      const bytes = new Uint8Array(data);
      const message = this.RadarMessage.decode(bytes);

      if (message.spokes) {
        for (const spoke of message.spokes) {
          const radarSpoke: RadarSpoke = {
            angle: spoke.angle,
            bearing: spoke.bearing,
            range: spoke.range,
            data: spoke.data
          };
          this.spokeData$.next(radarSpoke);
        }
      }
    } catch (error) {
      console.error('Error decoding radar message:', error);
      this.error$.next('Error decoding radar data');
    }
  }

  updateRange(range: number) {
    const currentConfig = this.radarConfig$.value;
    if (currentConfig) {
      this.radarConfig$.next({
        ...currentConfig,
        range: range
      });
    }
  }

  disconnect() {
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = null;
    }
    this.connected$.next(false);
    this.connecting$.next(false);
    this.currentRadar = null;
  }

  isConnected(): boolean {
    return this.connected$.value;
  }

  isConnecting(): boolean {
    return this.connecting$.value;
  }
}