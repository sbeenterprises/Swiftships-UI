/**
 * GeoTIFF charts loaded from files and kept in the browser (IndexedDB).
 */
import { Injectable, NgZone, signal } from '@angular/core';
import { v4 as uuidv4 } from 'uuid';

import { IndexedDB } from 'src/app/lib/services';
import { FBChart } from 'src/app/types';
import { SKChart } from '../resource-classes';
import {
  GEOTIFF_CHART_TYPE,
  GEOTIFF_ID_PREFIX,
  GeoTiffChartError,
  GeoTiffChartInfo,
  GeoTiffChartRecord,
  GeoTiffImportItem,
  GeoTiffImportProgress,
  GeoTiffImportResult,
  GeoTiffPositionRequiredError
} from './geotiff-types';
import { registerProjection } from './geotiff-projection';

const DB_NAME = 'swiftships-charts';
const DB_VERSION = 1;
const STORE = 'geotiff';

@Injectable({
  providedIn: 'root'
})
export class GeoTiffChartsService {
  private db = new IndexedDB(DB_NAME, DB_VERSION);
  private dbAvailable = false;
  private records = new Map<string, GeoTiffChartRecord>();
  private initialised: Promise<void>;
  private persistRequested = false;

  private chartsSignal = signal<GeoTiffChartInfo[]>([]);
  /** Metadata of the stored charts */
  readonly charts = this.chartsSignal.asReadonly();

  private progressSignal = signal<GeoTiffImportProgress | null>(null);
  /** Progress of the running import (null when no import is running) */
  readonly importProgress = this.progressSignal.asReadonly();
  private importAbort: AbortController;

  constructor(private zone: NgZone) {
    this.initialised = this.init();
  }

  /**
   * @description Resolves when the stored charts have been loaded (never rejects).
   */
  public ready(): Promise<void> {
    return this.initialised;
  }

  /**
   * @description Returns true if the chart identifier belongs to a GeoTIFF chart.
   * @param id Chart identifier
   */
  public isGeoTiff(id: string): boolean {
    return typeof id === 'string' && id.startsWith(GEOTIFF_ID_PREFIX);
  }

  /**
   * @description Stored chart (metadata and tiles).
   * @param id Chart identifier
   */
  public get(id: string): GeoTiffChartRecord | undefined {
    return this.records.get(id);
  }

  /**
   * @description Chart list entry for a GeoTIFF chart.
   * @param info Chart metadata
   * @param selected Chart is selected for display
   */
  public toFBChart(info: GeoTiffChartInfo, selected: boolean): FBChart {
    return [
      info.id,
      new SKChart({
        identifier: info.id,
        name: info.name,
        description: info.description,
        bounds: info.bounds.slice(),
        format: 'png',
        type: GEOTIFF_CHART_TYPE,
        scale: info.scale,
        minzoom: 0,
        maxzoom: 24
      }),
      selected
    ];
  }

  /**
   * @description Load TIFF chart files and keep them in the browser storage.
   * Only one import runs at a time (see importProgress).
   * @param items Files to load (with their companion files / position)
   * @returns The loaded charts, the files that could not be loaded and the
   * images that need a position
   */
  public async import(
    items: GeoTiffImportItem[]
  ): Promise<GeoTiffImportResult> {
    const result: GeoTiffImportResult = {
      imported: [],
      errors: [],
      needPosition: [],
      persistent: this.dbAvailable,
      cancelled: false
    };
    if (this.progressSignal() || items.length === 0) {
      return result;
    }
    const progress = (index: number, fraction: number) =>
      this.progressSignal.set({
        fileName: items[index].file.name,
        index: index,
        count: items.length,
        fraction: fraction
      });
    progress(0, 0);
    this.importAbort = new AbortController();
    const signal = this.importAbort.signal;
    try {
      await this.ready();
      result.persistent = this.dbAvailable;
      this.requestPersistence();
      for (let index = 0; index < items.length && !signal.aborted; index++) {
        progress(index, 0);
        await this.importFile(items[index], index, result, signal, progress);
      }
    } finally {
      result.cancelled = signal.aborted;
      this.importAbort = undefined;
      this.progressSignal.set(null);
      this.publish();
    }
    return result;
  }

  /**
   * @description Cancel the running import (the charts already loaded are kept).
   */
  public cancelImport() {
    this.importAbort?.abort();
  }

  /** Load one file of an import */
  private async importFile(
    item: GeoTiffImportItem,
    index: number,
    result: GeoTiffImportResult,
    signal: AbortSignal,
    progress: (index: number, fraction: number) => void
  ) {
    try {
      // loaded on demand: keeps the GeoTIFF decoder out of the main bundle
      const { importGeoTiffChart } = await import('./geotiff-import');
      const id = GEOTIFF_ID_PREFIX + uuidv4();
      // outside the Angular zone: the import is thousands of async steps that
      // would each trigger change detection of the whole application
      const { info, tiles } = await this.zone.runOutsideAngular(() =>
        importGeoTiffChart(item.file, id, {
          onProgress: (fraction) =>
            this.zone.run(() => progress(index, fraction)),
          signal: signal,
          sidecars: item.sidecars,
          position: item.position
        })
      );
      if (signal.aborted) {
        return;
      }
      const record: GeoTiffChartRecord = { ...info, tiles: tiles };
      if (this.dbAvailable) {
        await this.db.update(STORE, record).catch((err) => {
          throw new GeoTiffChartError(storageErrorMessage(err));
        });
      }
      this.records.set(id, record);
      result.imported.push(info);
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      if (err instanceof GeoTiffPositionRequiredError && !item.position) {
        result.needPosition.push({ item: item, message: err.message });
        return;
      }
      if (!(err instanceof GeoTiffChartError)) {
        console.error(`GeoTIFF import (${item.file.name}):`, err);
      }
      result.errors.push({
        fileName: item.file.name,
        message:
          err instanceof GeoTiffChartError
            ? err.message
            : `Unexpected error: ${err?.message ?? err}`
      });
    }
  }

  /**
   * @description Remove a chart from the browser storage.
   * @param id Chart identifier
   */
  public async remove(id: string): Promise<void> {
    await this.ready();
    if (this.dbAvailable) {
      await this.db.delete(STORE, id);
    }
    this.records.delete(id);
    this.publish();
  }

  /** Open the database and load the stored charts */
  private async init() {
    try {
      await this.db.openDatabase(DB_VERSION, (evt) => {
        const db: IDBDatabase = evt.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      });
      this.dbAvailable = true;
      const records: GeoTiffChartRecord[] = await this.db.getAll(STORE);
      records.forEach((r) => {
        if (!registerProjection(r.projection)) {
          console.warn(
            `GeoTIFF chart ${r.name}: projection ${r.projection?.code} unavailable!`
          );
        }
        this.records.set(r.id, r);
      });
    } catch (err) {
      console.warn(
        'GeoTIFF charts: browser storage unavailable, charts will not be kept!',
        err
      );
    }
    this.publish();
  }

  /** Update the charts signal from the records */
  private publish() {
    this.chartsSignal.set(
      Array.from(this.records.values()).map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { tiles, ...info } = r;
        return info;
      })
    );
  }

  /** Ask the browser not to evict the stored charts under storage pressure */
  private requestPersistence() {
    if (this.persistRequested) {
      return;
    }
    this.persistRequested = true;
    navigator.storage?.persist?.().catch(() => undefined);
  }
}

/** User message for an IndexedDB write failure */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function storageErrorMessage(err: any): string {
  const error = err?.target?.error ?? err;
  if (error?.name === 'QuotaExceededError') {
    return 'Not enough browser storage space to keep the chart.';
  }
  return `The chart could not be saved in the browser storage (${
    error?.message ?? error?.name ?? error
  }).`;
}
