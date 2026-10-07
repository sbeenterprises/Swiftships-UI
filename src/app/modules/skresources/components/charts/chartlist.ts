import {
  Component,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  effect,
  signal,
  input
} from '@angular/core';

import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatButtonModule } from '@angular/material/button';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { AppFacade } from 'src/app/app.facade';
import { SKResourceService, SKResourceType } from '../../resources.service';
import { ChartLayers } from './chart-layers.component';
import { ChartPropertiesDialog } from './chart-properties-dialog';
import { FBCharts, FBChart, Position } from 'src/app/types';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { WMTSDialog } from './wmts-dialog';
import { WMSDialog } from './wms-dialog';
import { JsonMapSourceDialog } from './jsonmapsource-dialog';
import { SignalKClient } from 'signalk-client-angular';
import { SKWorkerService } from 'src/app/modules/skstream/skstream.service';
import { ResourceListBase } from '../resource-list-baseclass';
import { fromLonLat, toLonLat } from 'ol/proj';
import { MapService } from 'src/app/modules/map/ol/lib/map.service';
import { SKChart } from '../../resource-classes';
import {
  GEOTIFF_CHART_TYPE,
  GeoTiffChartInfo,
  GeoTiffChartsService,
  GeoTiffImportItem,
  GeoTiffPosition,
  groupChartFiles
} from '../../geotiff';
import { ChartPositionDialog } from './chart-position-dialog';

/** Width (pixels) of the side panel covering the left of the map */
const PANEL_WIDTH = 315;

@Component({
  selector: 'chart-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chartlist.html',
  styleUrls: ['../resourcelist.css'],
  imports: [
    MatTooltipModule,
    MatIconModule,
    MatCardModule,
    MatCheckboxModule,
    MatButtonModule,
    FormsModule,
    MatInputModule,
    ScrollingModule,
    MatSlideToggle,
    MatMenuModule,
    MatProgressBarModule,
    ChartLayers
  ]
})
export class ChartListComponent extends ResourceListBase {
  @Output() closed: EventEmitter<void> = new EventEmitter();
  @Output() pan: EventEmitter<{ center: Position; zoomLevel: number }> =
    new EventEmitter();

  selectedCharts = input<string[]>();

  protected fullList: FBCharts = [];
  protected filteredList = signal<FBCharts>([]);

  displayChartLayers = false;

  constructor(
    protected app: AppFacade,
    private dialog: MatDialog,
    private signalk: SignalKClient,
    protected skres: SKResourceService,
    private worker: SKWorkerService,
    protected geotiff: GeoTiffChartsService,
    private mapService: MapService
  ) {
    super('charts', skres);
    // selection.charts changed
    effect(() => {
      if (this.selectedCharts()) {
        this.externalSelection();
      }
    });
    // resources delta handler
    effect(() => {
      if (this.worker.resourceUpdate().path.includes('resources.charts')) {
        this.initItems(true);
      }
    });
  }

  ngOnInit() {
    this.initItems();
  }

  /**
   * @description Close chart list
   */
  protected close() {
    this.app.data.chartBounds.show = false;
    this.app.data.chartBounds.charts = [];
    this.closed.emit();
  }

  /**
   * @description Initialise the chart list.
   * @param silent Do not show progress bar when true.
   */
  protected async initItems(silent?: boolean) {
    if (this.app.sIsFetching()) {
      this.app.debug('** isFetching() ... exit.');
      return;
    }
    this.app.sIsFetching.set(!(silent ?? false));
    try {
      this.fullList = await this.skres.listFromServer<FBChart>(
        this.collection as SKResourceType,
        undefined,
        true
      );
      this.fullList = this.skres.appendOSM(this.fullList);
      this.fullList = this.fullList.concat(await this.skres.listLocalCharts());
      this.app.sIsFetching.set(false);
      this.doFilter();
      // keep the selection of GeoTIFF charts stored in other browsers (shared settings)
      const otherBrowsers = (this.app.config.selections.charts ?? []).filter(
        (id: string) => this.geotiff.isGeoTiff(id) && !this.geotiff.get(id)
      );
      this.skres.selectionClean(
        this.collection,
        this.fullList.map((i) => i[0]).concat(otherBrowsers)
      );
    } catch (err) {
      this.app.sIsFetching.set(false);
      if (!(err?.status === 0 && err?.statusText === 'Not connected')) {
        this.app.parseHttpErrorResponse(err);
      }
      // charts stored in the browser do not need the server
      this.fullList = this.skres
        .appendOSM([])
        .concat(await this.skres.listLocalCharts());
      this.doFilter();
    }
    if (this.app.data.chartBounds.show) {
      this.app.data.chartBounds.charts = this.fullList;
    }
  }

  /**
   * @description Returns icon to display to indicate chart is served from local server.
   * @param url Chart url
   */
  protected isLocal(url: string): string {
    return url && url.indexOf(this.app.hostDef.name) !== -1
      ? 'map'
      : 'language';
  }

  /**
   * @description Returns icon to display to indicate the chart source.
   * @param chart Chart
   */
  protected chartIcon(chart: SKChart): string {
    return chart.type === GEOTIFF_CHART_TYPE
      ? 'image'
      : this.isLocal(chart.url);
  }

  /** Handle selection change triggered externally */
  protected externalSelection() {
    this.fullList.forEach(
      (cht: FBChart) => (cht[2] = this.selectedCharts().includes(cht[0]))
    );
    this.doFilter();
  }

  /**
   * @description Toggle selections on / off
   * @param checked Determines if all checkboxes are checked or unchecked
   */
  protected toggleAll(checked: boolean) {
    super.toggleAll(checked);
    if (checked) {
      this.skres.chartAddFromServer();
    } else {
      this.skres.chartRemove();
    }
  }

  /**
   * @description Handle chart entry check / uncheck
   * @param checked Value indicating entry is checked / unchecked
   * @param id Chart identifier
   */
  protected itemSelect(checked: boolean, id: string) {
    const idx = this.toggleItem(checked, id);
    // update cache
    if (idx !== -1) {
      if (checked) {
        this.skres.chartAdd([this.filteredList()[idx]]);
      } else {
        this.skres.chartRemove([this.filteredList()[idx][0]]);
      }
    }
  }

  /**
   * @description Show chart properties
   * @param id Chart identifier
   */
  protected itemProperties(id: string) {
    const chart = this.fullList.find((cht: FBChart) => cht[0] === id);
    if (chart) {
      this.dialog.open(ChartPropertiesDialog, { data: chart[1] });
    }
  }

  /**
   * @description Show delete chart dialog
   * @param id Chart identifier
   */
  protected itemDelete(id: string) {
    if (this.geotiff.isGeoTiff(id)) {
      this.deleteGeoTiff(id);
    } else {
      this.skres.deleteChart(id);
    }
  }

  /**
   * @description Confirm and remove a GeoTIFF chart from the browser storage.
   * @param id Chart identifier
   */
  private deleteGeoTiff(id: string) {
    const chart = this.fullList.find((c: FBChart) => c[0] === id);
    this.app
      .showConfirm(
        `Do you want to remove the chart "${
          chart ? chart[1].name : id
        }" from this browser?\n`,
        'Remove Chart:',
        'YES',
        'NO'
      )
      .subscribe(async (result: { ok: boolean }) => {
        if (!result?.ok) {
          return;
        }
        try {
          await this.geotiff.remove(id);
        } catch (err) {
          this.app.showAlert(
            'Remove Chart',
            `The chart could not be removed (${
              err?.message ?? err?.target?.error?.message ?? err
            }).`
          );
          return;
        }
        this.skres.chartRemove([id]);
        const order = this.app.config.selections.chartOrder;
        if (Array.isArray(order) && order.includes(id)) {
          order.splice(order.indexOf(id), 1);
        }
        this.app.saveConfig();
        this.initItems(true);
      });
  }

  /**
   * @description Load TIFF chart files into the browser storage and display them.
   * Images without position information (no GeoTIFF tags, .info or world file)
   * are loaded once the user has entered the position of their edges.
   * @param files Files selected or dropped by the user (images + companion files)
   */
  protected async importGeoTiff(files: FileList | File[]) {
    // copy now: the FileList of the input is emptied when its value is reset
    const list = Array.from(files ?? []);
    if (list.length === 0 || this.geotiff.importProgress()) {
      return;
    }
    const { items, unused } = groupChartFiles(list);
    const messages = unused.map(
      (f) =>
        `${f.name}:\nselect it together with the .tif file of the same name.`
    );
    let firstId: string;
    let persistent = true;
    let pending: GeoTiffImportItem[] = items;
    while (pending.length !== 0) {
      const result = await this.geotiff.import(pending);
      if (result.imported.length !== 0) {
        firstId = firstId ?? result.imported[0].id;
        persistent = persistent && result.persistent;
        await this.showImportedCharts(result.imported);
      }
      messages.push(
        ...result.errors.map((e) => `${e.fileName}:\n${e.message}`)
      );
      pending = [];
      if (result.cancelled) {
        break;
      }
      // images without position information: ask for the position of their edges
      for (const missing of result.needPosition) {
        const position = await this.askPosition(
          missing.item.file.name,
          missing.message
        );
        if (position) {
          pending.push({ ...missing.item, position: position });
        }
      }
    }
    if (firstId) {
      this.zoomToChart(firstId);
    }
    if (!persistent) {
      messages.push(
        'The browser storage is not available: the loaded charts will be ' +
          'lost when the page is reloaded.'
      );
    }
    if (messages.length !== 0) {
      this.app.showAlert('Load Chart Files', messages.join('\n\n'));
    }
  }

  /**
   * @description Display charts that have just been loaded (selected, on top of the others).
   * @param charts Loaded charts
   */
  private async showImportedCharts(charts: GeoTiffChartInfo[]) {
    const ids = charts.map((c) => c.id);
    const order: string[] = Array.isArray(this.app.config.selections.chartOrder)
      ? this.app.config.selections.chartOrder
      : [];
    this.app.config.selections.chartOrder = order
      .filter((i) => !ids.includes(i))
      .concat(ids);
    this.skres.chartAdd(charts.map((c) => this.geotiff.toFBChart(c, true)));
    this.app.saveConfig();
    await this.initItems(true);
  }

  /**
   * @description Ask the user for the edges of an image without position information.
   * @param fileName Image file name
   * @param message Why the position is needed
   * @returns The position or undefined when the user skipped the image
   */
  private askPosition(
    fileName: string,
    message: string
  ): Promise<GeoTiffPosition | undefined> {
    return new Promise((resolve) =>
      this.dialog
        .open(ChartPositionDialog, {
          disableClose: true,
          data: { fileName: fileName, message: message }
        })
        .afterClosed()
        .subscribe((position: GeoTiffPosition) => resolve(position))
    );
  }

  /**
   * @description Cancel the GeoTIFF files being loaded.
   */
  protected cancelImport() {
    this.geotiff.cancelImport();
  }

  /**
   * @description Accept files dragged over the chart list.
   */
  protected dragOver(e: DragEvent) {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  /**
   * @description Load the GeoTIFF files dropped on the chart list.
   */
  protected drop(e: DragEvent) {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      this.importGeoTiff(e.dataTransfer.files);
    }
  }

  /**
   * @description Pan and zoom the map to show the whole chart (beside this panel).
   * @param id Chart identifier
   */
  protected zoomToChart(id: string) {
    const b = this.fullList.find((c: FBChart) => c[0] === id)?.[1].bounds;
    if (!Array.isArray(b) || b.length !== 4) {
      return;
    }
    const sw = fromLonLat([b[0], b[1]]);
    const ne = fromLonLat([b[2], b[3]]);
    const size = this.mapService.getMaps()[0]?.getSize() ?? [
      window.innerWidth,
      window.innerHeight
    ];
    const width = Math.max(200, size[0] - PANEL_WIDTH);
    const height = Math.max(200, size[1]);
    const fit = Math.max((ne[0] - sw[0]) / width, (ne[1] - sw[1]) / height);
    // EPSG:3857 resolution at zoom 0 (256 pixel tiles)
    const zoom = Math.max(
      1,
      Math.min(20, Math.floor(Math.log2(156543.03392804097 / (fit * 1.1))))
    );
    const resolution = 156543.03392804097 / 2 ** zoom;
    // centre the chart in the part of the map not covered by this panel
    const center = toLonLat([
      (sw[0] + ne[0]) / 2 - (PANEL_WIDTH / 2) * resolution,
      (sw[1] + ne[1]) / 2
    ]);
    this.pan.emit({
      center: [center[0], center[1]],
      zoomLevel: zoom
    });
  }

  /**
   * @description Show chart boundaries on map.
   */
  toggleChartBoundaries() {
    this.app.data.chartBounds.show = !this.app.data.chartBounds.show;
    if (this.app.data.chartBounds.show) {
      this.app.data.chartBounds.charts = this.fullList;
    }
  }

  addChartSource(type: 'wms' | 'wmts' | 'json') {
    let dref: MatDialogRef<WMTSDialog | WMSDialog | JsonMapSourceDialog>;

    if (type === 'wmts') {
      dref = this.dialog.open(WMTSDialog, {
        disableClose: true,
        data: {}
      });
    }
    if (type === 'wms') {
      dref = this.dialog.open(WMSDialog, {
        disableClose: true,
        data: {}
      });
    }
    if (type === 'json') {
      dref = this.dialog.open(JsonMapSourceDialog, {
        disableClose: true,
        data: {}
      });
    }
    if (!dref) {
      this.app.showAlert(
        'Message',
        `Invalid Chart source type (${type}) provided! `
      );
      return;
    }
    dref.afterClosed().subscribe((sources) => {
      if (sources && sources.length !== 0) {
        const req = [];
        sources.forEach((cs) => {
          req.push(
            this.signalk.api.post(
              this.app.skApiVersion,
              `/resources/charts?provider=resources-provider`,
              cs
            )
          );
        });

        const r = forkJoin(req).pipe(catchError((error) => of(error)));
        r.subscribe((r) => {
          if (r.error) {
            this.app.showAlert(
              'Add Chart Sources',
              `Error saving chart source!\n(${r.error.statusCode}: ${r.error.message})`
            );
          } else {
            this.app.showAlert(
              'Add Chart Sources',
              'Chart sources added successfully.'
            );
            this.initItems();
          }
        });
      }
    });
  }

  /**
   * @description Control the display of the re-order chart screen
   * @param show Display Chart Order component when true
   */
  showChartLayers(show = false) {
    this.displayChartLayers = show;
  }
}
