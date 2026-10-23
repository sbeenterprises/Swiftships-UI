/***********************************
  Engine monitor: derives running / shut off / no data and raises engine
  alerts in the alert panel (UI side; the engine's own NMEA alarm flags
  arrive separately as notifications.propulsion.<id>.*).
***********************************/
import { Injectable } from '@angular/core';
import { ALARM_STATE } from '@signalk/server-api';
import { NotificationManager } from './notification-manager';
import {
  EngineData,
  EngineRunState
} from './components/engine-status.component';

type Level = 'warn' | 'alarm' | 'emergency' | null;

const RUNNING_RPM = 300; // below this the engine is shut off
const STALE_MS = 10000; // no reading for this long = no data
const OFF_HOLD_MS = 3000; // ignore RPM dropouts shorter than this
const CHARGE_HOLD_MS = 30000;

@Injectable({ providedIn: 'root' })
export class EngineMonitor {
  private levels = new Map<string, Level>();
  private since = new Map<string, number>(); // when a held condition began

  constructor(private notiMgr: NotificationManager) {}

  /**
   * @description Update run state on `e` and raise / clear engine alerts.
   * @param e engine panel data (MOOS and / or Signal K)
   * @param missionActive helm is in DRIVE
   */
  update(e: EngineData, missionActive: boolean, now = Date.now()) {
    const fresh = !!e.lastUpdate && now - e.lastUpdate < STALE_MS;
    const state: EngineRunState = !fresh
      ? 'unknown'
      : e.speed >= RUNNING_RPM
      ? 'running'
      : 'stopped';
    e.running = state;

    const id = e.engineId ?? 'main';
    const name = e.engineId
      ? `${e.engineId[0].toUpperCase()}${e.engineId.slice(1)} engine`
      : 'Engine';
    const set = (key: string, level: Level, message: string) =>
      this.set(`notifications.propulsion.${id}.monitor.${key}`, level, message);
    const held = (key: string, cond: boolean, ms: number) =>
      this.held(key, cond, ms, now);

    // ** mission **
    set(
      'shutOffInMission',
      held('off', missionActive && state === 'stopped', OFF_HOLD_MS)
        ? 'emergency'
        : null,
      `${name} SHUT OFF during mission`
    );
    set(
      'noDataInMission',
      missionActive && state === 'unknown' && !!e.lastUpdate ? 'warn' : null,
      `${name}: no engine data for ${Math.round((now - e.lastUpdate) / 1000)} s during mission`
    );

    if (!fresh) {
      return; // keep threshold alerts as they were until data returns
    }

    // ** temperature (hysteresis: clears 2 °C below the warn limit) **
    const t = e.coolantTemp;
    const tPrev = this.level('overheat', id);
    const tLevel: Level =
      t >= 100 ? 'alarm' : t >= 95 || (tPrev && t >= 93) ? 'warn' : null;
    set(
      'overheat',
      tLevel,
      tLevel === 'alarm'
        ? `${name} OVERHEATING: ${t.toFixed(0)} °C`
        : `${name} temperature high: ${t.toFixed(0)} °C`
    );

    // ** charging **
    const v = e.batteryVoltage;
    const vPrev = this.level('lowVoltage', id);
    set(
      'lowVoltage',
      v > 0 && v < 11.5
        ? 'alarm'
        : (v > 0 && v < 12.0) || (vPrev && v > 0 && v < 12.2)
        ? 'warn'
        : null,
      `House battery low: ${v.toFixed(2)} V`
    );
    const alt = e.alternatorVoltage;
    set(
      'notCharging',
      held(
        'charge',
        state === 'running' && typeof alt === 'number' && alt < 12.8,
        CHARGE_HOLD_MS
      )
        ? 'warn'
        : null,
      `${name} alternator not charging: ${alt?.toFixed(2)} V`
    );

    // ** fuel **
    const f = e.fuelLevel;
    const fPrev = this.level('lowFuel', id);
    set(
      'lowFuel',
      typeof f !== 'number'
        ? null
        : f < 10
        ? 'alarm'
        : f < 20 || (fPrev && f < 22)
        ? 'warn'
        : null,
      `Fuel low: ${f?.toFixed(0)} %`
    );
  }

  private level(key: string, id: string): Level {
    return this.levels.get(`notifications.propulsion.${id}.monitor.${key}`);
  }

  /** true once `cond` has held continuously for `ms` */
  private held(key: string, cond: boolean, ms: number, now: number): boolean {
    if (!cond) {
      this.since.delete(key);
      return false;
    }
    if (!this.since.has(key)) {
      this.since.set(key, now);
    }
    return now - this.since.get(key) >= ms;
  }

  private set(path: string, level: Level, message: string) {
    const prev = this.levels.get(path) ?? null;
    if (!level) {
      if (prev) {
        this.notiMgr.clearLocal(path);
        this.levels.delete(path);
      }
      return;
    }
    this.levels.set(path, level);
    this.notiMgr.raiseLocal(path, level as ALARM_STATE, message);
  }
}
