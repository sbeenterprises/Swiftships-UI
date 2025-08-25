import { Component, ViewChild, effect, signal, OnDestroy } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { OverlayContainer } from '@angular/cdk/overlay';
import { Observable, Subject, Subscription } from 'rxjs';

import { AppFacade } from './app.facade';
import { SettingsEventMessage } from './lib/services';
import {
  AboutDialog,
  LoginDialog,
  PlaybackDialog,
  GeoJSONImportDialog,
  Trail2RouteDialog
} from 'src/app/lib/components/dialogs';

import {
  AISPropertiesModal,
  AtoNPropertiesModal,
  AircraftPropertiesModal,
  ActiveResourcePropertiesModal,
  ResourceImportDialog,
  ResourceSetModal,
  ResourceSetFeatureModal,
  SettingsDialog,
  SKStreamFacade,
  SKSTREAM_MODE,
  StreamOptions,
  AnchorFacade,
  SKResourceService,
  SKVessel,
  SKSaR,
  SKAircraft,
  SKAtoN,
  SKOtherResources,
  SKRegion,
  WeatherForecastModal,
  CourseSettingsModal,
  NotificationManager,
  GPXImportDialog,
  GPXExportDialog,
  CourseService,
  RadarService,
  RadarDisplayComponent
} from 'src/app/modules';

import { SignalKClient } from 'signalk-client-angular';
import { Convert } from 'src/app/lib/convert';
import { GeoUtils } from 'src/app/lib/geoutils';
import * as semver from 'semver';

import {
  NotificationMessage,
  UpdateMessage,
  LineString,
  Polygon,
  FBRoute,
  Position,
  ErrorList
} from './types';
import { Feature } from 'ol';
import {
  DrawFeatureType,
  FBMapInteractService,
  DrawFeatureInfo
} from './modules/map/fbmap-interact.service';

interface DrawEndEvent {
  coordinates: LineString | Position | Polygon;
  enabled: boolean;
  features: Feature[];
  forSave: boolean;
  mode: string;
  modify: false;
  properties: { [key: string]: unknown };
  type: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  standalone: false
})
export class AppComponent implements OnDestroy {
  @ViewChild('sideright', { static: false }) sideright;

  public display = {
    fullscreen: { active: false, enabled: document.fullscreenEnabled },
    leftMenuPanel: false,
    instrumentPanelOpen: true,
    instrumentAppActive: true,
    remoteControlPanelOpen: false,
    autonomousControlPanelOpen: false,
    routeList: false,
    waypointList: false,
    chartList: false,
    noteList: false,
    trackList: false,
    aisList: false,
    resourceGroups: signal<boolean>(false),
    anchorWatch: false,
    navDataPanel: {
      show: false,
      nextPointCtrl: false,
      apModeColor: '',
      apModeText: ''
    },
    playback: { time: null },
    map: { center: [0, 0] },
    audio: { state: '' }
  };

  // APP features / mode
  public features = { playbackAPI: true };
  public mode: SKSTREAM_MODE = SKSTREAM_MODE.REALTIME; // current mode

  // Remote control data
  public remoteControl = {
    rudder: 0,    // -50 to 50
    thrust: 0,    // 0 to 100%
    gear: 'neutral'  // forward, neutral, reverse
  };

  // Autonomous control data
  public autonomousControl = {
    selectedRoute: '',     // Selected route ID
    speed: 10,            // Speed in knots (0-35)
    status: 'standby',    // standby, active, paused, returning, aborted
    currentWaypoint: 0,   // Current waypoint index
    progress: 0          // Mission progress percentage
  };

  // Available routes for autonomous control
  public availableRoutes: [string, any, boolean][] = [];

  private timers = [];

  // external resources
  private lastInstUrl: string;
  private lastInstParams: string;
  public instUrl: SafeResourceUrl;
  private lastVideoUrl: string;
  private selFavourite = -1;
  public vidUrl: SafeResourceUrl;

  public convert = Convert;
  private obsList = []; // observables array
  private streamOptions = { options: null, toMode: null };
  private radarSubscriptions: Subscription[] = [];

  protected mapSetFocus = signal<string>('');

  protected isInteracting = false; // map interaction flag

  constructor(
    protected app: AppFacade,
    protected mapInteract: FBMapInteractService,
    protected anchor: AnchorFacade,
    protected notiMgr: NotificationManager,
    protected course: CourseService,
    protected stream: SKStreamFacade,
    protected skres: SKResourceService,
    protected skresOther: SKOtherResources,
    protected signalk: SignalKClient,
    protected radarService: RadarService,
    private dom: DomSanitizer,
    private overlayContainer: OverlayContainer,
    private bottomSheet: MatBottomSheet,
    private dialog: MatDialog
  ) {
    // set self to active vessel
    this.app.data.vessels.active = this.app.data.vessels.self;

    // handle skAuthChange signal
    effect(() => {
      this.app.debug('** skAuthChange Event:', this.app.skAuthChange());
      this.handleSKAuthChange();
    });
    // handle kioskMode signal
    effect(() => {
      this.app.debug('** kioskMode Event:', this.app.kioskMode());
      this.toggleSuppressContextMenu(this.app.kioskMode());
    });
    /** handle interaction signals */
    effect(() => {
      this.app.debug(
        '** interaction state Event:',
        this.mapInteract.isMeasuring(),
        this.mapInteract.isDrawing(),
        this.mapInteract.isModifying()
      );
      this.isInteracting =
        this.mapInteract.isMeasuring() ||
        this.mapInteract.isDrawing() ||
        this.mapInteract.isModifying();
      this.app.debug('** isInteracting:', this.isInteracting);
    });
  }

  // ********* LIFECYCLE ****************

  ngAfterViewInit() {
    setTimeout(() => {
      const wr = this.app.showWelcome();
      if (wr) {
        wr.afterClosed().subscribe((r) => {
          if (r) this.openSettings();
        });
      }
    }, 500);
  }

  enableAudio() {
    if (this.app.audio.context) {
      this.app.audio.context.resume();
    }
  }

  handleHasWakeLock(value: boolean) {
    setTimeout(() => (this.app.data.hasWakeLock = value), 500);
  }

  handleWakelockChange(value: boolean) {
    this.app.config.selections.wakeLock = value;
    this.app.saveConfig();
  }

  ngOnInit() {
    // ** audio context handing **
    this.display.audio.state = this.app.audio.context.state;
    this.app.debug('audio state:', this.display.audio.state);
    this.app.audio.context.onstatechange = () => {
      this.app.debug('audio statechange:', this.app.audio.context.state);
      this.display.audio.state = this.app.audio.context.state;
    };

    // ** apply loaded app config
    this.display.map.center = this.app.config.map.center;
    if (this.app.config.plugins.startOnOpen) {
      this.display.instrumentAppActive = false;
    }

    // overlay dark-theme
    this.setDarkTheme();

    this.lastInstUrl = this.app.config.plugins.instruments;
    this.lastInstParams = this.app.config.plugins.parameters;
    this.instUrl = this.dom.bypassSecurityTrustResourceUrl(
      this.formatInstrumentsUrl()
    );
    this.lastVideoUrl = this.app.config.resources.video.url;
    this.vidUrl = this.dom.bypassSecurityTrustResourceUrl(
      `${this.app.config.resources.video.url}`
    );

    // ** connect to signalk server and intialise
    this.connectSignalKServer();

    // ** connect to MOOS-IvP server if enabled
    if (this.app.config.moosIvP.enabled && this.app.config.moosIvP.autoConnect) {
      this.connectMoosIvPServer();
    }

    // ********************* SUBSCRIPTIONS *****************
    // ** SIGNAL K STREAM **
    this.obsList.push(
      this.stream
        .delta$()
        .subscribe((msg: NotificationMessage | UpdateMessage) =>
          this.onMessage(msg)
        )
    );
    this.obsList.push(
      this.stream
        .connect$()
        .subscribe((msg: NotificationMessage | UpdateMessage) =>
          this.onConnect(msg)
        )
    );
    this.obsList.push(
      this.stream
        .close$()
        .subscribe((msg: NotificationMessage | UpdateMessage) =>
          this.onClose(msg)
        )
    );
    this.obsList.push(
      this.stream
        .error$()
        .subscribe((msg: NotificationMessage | UpdateMessage) =>
          this.onError(msg)
        )
    );
    // ** TRAIL$ update event
    this.obsList.push(
      this.stream.trail$().subscribe((msg) => this.handleTrailUpdate(msg))
    );
    // ** SETTINGS$ - handle settings events
    this.obsList.push(
      this.app.settings$.subscribe((value: SettingsEventMessage) =>
        this.handleSettingsEvent(value)
      )
    );

    // fullscreen event handlers
    document.addEventListener('fullscreenchange', () => {
      //console.log(document.fullscreenElement)
      if (document.fullscreenElement) {
        this.display.fullscreen.active = true;
      } else {
        this.display.fullscreen.active = false;
      }
    });
    document.addEventListener('fullscreenerror', (e) => {
      console.warn(e);
      this.display.fullscreen.active = false;
    });
  }

  ngOnDestroy() {
    // ** clean up
    this.stopTimers();
    this.stream.terminate();
    this.signalk.disconnect();
    this.disconnectMoosIvPServer();
    this.cleanupRadarSubscriptions();
    this.radarService.disconnect();
    this.obsList.forEach((i) => i.unsubscribe());
  }

  // ********* DISPLAY / APPEARANCE ****************

  // ** return the map orientation **
  getOrientation() {
    return this.app.uiConfig().mapNorthUp
      ? 'rotate(' + 0 + 'deg)'
      : 'rotate(' + (0 - this.app.data.vessels.active.orientation) + 'rad)';
  }

  /** TOOLBAR ACTIONS */

  protected toggleMoveMap(exit = false) {
    this.app.uiConfig.update((current) => {
      const mm = exit ? false : !current.mapMove;
      return Object.assign({}, current, { mapMove: mm });
    });
    this.focusMap();
  }

  protected toggleNorthUp() {
    this.app.uiConfig.update((current) => {
      return Object.assign({}, current, { mapNorthUp: !current.mapNorthUp });
    });
    this.focusMap();
  }

  protected toggleRemoteControl() {
    if (this.app.config.selections.remoteControl) {
      // If already active, toggle the panel and deactivate if closing
      this.display.remoteControlPanelOpen = !this.display.remoteControlPanelOpen;
      
      if (this.display.remoteControlPanelOpen) {
        // Opening panel - close other panels
        this.display.instrumentPanelOpen = false;
        this.display.autonomousControlPanelOpen = false;
      } else {
        // Closing panel - deactivate remote control
        this.app.config.selections.remoteControl = false;
        this.app.saveConfig();
        this.app.showMessage('Remote Control Deactivated', false, 3000);
      }
    } else {
      // Activate remote control and open panel
      this.app.config.selections.remoteControl = true;
      this.display.remoteControlPanelOpen = true;
      this.display.instrumentPanelOpen = false;
      this.display.autonomousControlPanelOpen = false;
      this.app.saveConfig();
      this.app.showMessage('Remote Control Activated', false, 3000);
    }
    this.focusMap();
  }

  protected toggleAutonomousControl() {
    if (this.app.config.selections.autonomousControl) {
      // If already active, toggle the panel and deactivate if closing
      this.display.autonomousControlPanelOpen = !this.display.autonomousControlPanelOpen;
      
      if (this.display.autonomousControlPanelOpen) {
        // Opening panel - close other panels
        this.display.instrumentPanelOpen = false;
        this.display.remoteControlPanelOpen = false;
        // Load routes for the dropdown
        this.loadAvailableRoutes();
      } else {
        // Closing panel - deactivate autonomous control
        this.app.config.selections.autonomousControl = false;
        this.autonomousControl.status = 'standby';
        this.app.saveConfig();
        this.app.showMessage('Autonomous Control Deactivated', false, 3000);
      }
    } else {
      // Activate autonomous control and open panel
      this.app.config.selections.autonomousControl = true;
      this.display.autonomousControlPanelOpen = true;
      this.display.instrumentPanelOpen = false;
      this.display.remoteControlPanelOpen = false;
      this.autonomousControl.status = 'standby';
      this.app.saveConfig();
      // Load routes for the dropdown
      this.loadAvailableRoutes();
      this.app.showMessage('Autonomous Control Activated', false, 3000);
    }
    this.focusMap();
  }

  // Load available routes for autonomous control
  private async loadAvailableRoutes() {
    try {
      console.log('Starting to load routes...');
      const routes = await this.skres.listFromServer<[string, any, boolean]>('routes');
      console.log('Raw routes from server:', routes);
      // Show all routes that have valid geometry/data (not just visible ones)
      this.availableRoutes = routes.filter((route: [string, any, boolean]) => 
        route[1] && route[1].feature && route[1].feature.geometry
      );
      console.log('Filtered available routes:', this.availableRoutes);
      console.log('Total routes loaded:', this.availableRoutes.length);
    } catch (error) {
      console.error('Failed to load routes:', error);
      this.availableRoutes = [];
      this.app.showMessage('Failed to load routes', true, 3000);
    }
  }

  // Get route name by ID for display
  public getSelectedRouteName(): string {
    if (!this.autonomousControl.selectedRoute) {
      return 'None';
    }
    
    const route = this.availableRoutes.find(r => r[0] === this.autonomousControl.selectedRoute);
    return route ? (route[1].name || 'Route ' + route[0]) : this.autonomousControl.selectedRoute;
  }

  protected toggleRadarDisplay() {
    this.app.config.selections.radarControl = !this.app.config.selections.radarControl;
    this.app.saveConfig();
    
    if (this.app.config.selections.radarControl) {
      this.connectToRadar();
    } else {
      this.disconnectFromRadar();
    }
    
    this.app.showMessage(
      this.app.config.selections.radarControl
        ? 'Radar Display Enabled'
        : 'Radar Display Disabled',
      false,
      3000
    );
    this.focusMap();
  }

  private async connectToRadar() {
    try {
      await this.radarService.connectToRadar();
      this.app.showMessage('Connected to radar server', false, 2000);
      this.setupRadarSubscriptions();
    } catch (error) {
      console.error('Failed to connect to radar:', error);
      this.app.showAlert('Radar Connection Failed', 'Failed to connect to radar server. Make sure the Mayara server is running.');
      this.app.config.selections.radarControl = false;
      this.app.saveConfig();
    }
  }

  private setupRadarSubscriptions() {
    // Clear any existing subscriptions
    this.cleanupRadarSubscriptions();

    // Subscribe to radar errors
    this.radarSubscriptions.push(
      this.radarService.error$.subscribe(error => {
        console.error('Radar error:', error);
        this.app.showAlert('Radar Error', error);
      })
    );
  }

  private cleanupRadarSubscriptions() {
    this.radarSubscriptions.forEach(sub => sub.unsubscribe());
    this.radarSubscriptions = [];
  }

  private disconnectFromRadar() {
    this.cleanupRadarSubscriptions();
    this.radarService.disconnect();
    this.app.showMessage('Disconnected from radar server', false, 2000);
  }


  protected toggleChecklist() {
    this.app.data.showChecklist = !this.app.data.showChecklist;
    this.focusMap();
  }

  // Remote control methods
  protected updateRudder(value: number) {
    this.remoteControl.rudder = Math.max(-50, Math.min(50, value));
    this.sendRemoteControlData();
  }

  protected updateThrust(value: number) {
    this.remoteControl.thrust = Math.max(0, Math.min(100, value));
    this.sendRemoteControlData();
  }

  protected updateGear(gear: 'forward' | 'neutral' | 'reverse') {
    this.remoteControl.gear = gear;
    this.sendRemoteControlData();
  }

  private sendRemoteControlData() {
    // TODO: Send remote control data to SignalK server or MOOS-IvP
    console.log('Remote Control Data:', this.remoteControl);
  }

  protected closeRemoteControl() {
    this.display.remoteControlPanelOpen = false;
    this.app.config.selections.remoteControl = false;
    this.app.saveConfig();
    this.app.showMessage('Remote Control Deactivated', false, 3000);
    this.focusMap();
  }

  // Autonomous control methods
  protected selectRoute(routeId: string) {
    // Remove previously selected route from map (if any)
    if (this.autonomousControl.selectedRoute) {
      this.skres.routeRemove([this.autonomousControl.selectedRoute]);
    }
    
    this.autonomousControl.selectedRoute = routeId;
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;
    
    // Add newly selected route to map display
    if (routeId) {
      const selectedRoute = this.availableRoutes.find(r => r[0] === routeId);
      if (selectedRoute) {
        // Create a copy with visibility flag set to true (like the checkbox does)
        const visibleRoute: [string, any, boolean] = [selectedRoute[0], selectedRoute[1], true];
        this.skres.routeAdd([visibleRoute]);
        console.log('Route selected and added to map:', routeId, selectedRoute[1].name);
        
        // Extract waypoints and send to MOOS-IvP
        if (selectedRoute[1].feature && selectedRoute[1].feature.geometry && selectedRoute[1].feature.geometry.coordinates) {
          const waypoints = selectedRoute[1].feature.geometry.coordinates;
          this.sendWaypointsToMOOS(waypoints);
        }
      }
    } else {
      console.log('Route deselected');
    }
  }

  protected updateSpeed(speed: number) {
    this.autonomousControl.speed = Math.max(0, Math.min(35, speed));
    
    // Send speed to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send(`DESIRED_SPEED=${this.autonomousControl.speed}`);
      console.log(`Sent DESIRED_SPEED=${this.autonomousControl.speed} to MOOS-IvP`);
    }
    
    console.log('Speed updated:', this.autonomousControl.speed);
  }

  protected startMission() {
    if (!this.autonomousControl.selectedRoute) {
      this.app.showMessage('Please select a route first', true, 3000);
      return;
    }
    this.autonomousControl.status = 'active';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;
    
    // Send start command to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send('AUTONOMOUS_START=true');
      console.log('Sent AUTONOMOUS_START=true to MOOS-IvP');
    }
    
    this.app.showMessage('Mission Started', false, 3000);
    console.log('Mission started:', this.autonomousControl);
  }

  protected stopMission() {
    this.autonomousControl.status = 'paused';
    
    // Send stop command to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send('AUTONOMOUS_STOP=true');
      console.log('Sent AUTONOMOUS_STOP=true to MOOS-IvP');
    }
    
    this.app.showMessage('Mission Stopped', false, 3000);
    console.log('Mission stopped');
  }

  protected clearPath() {
    this.autonomousControl.selectedRoute = '';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;
    this.autonomousControl.status = 'standby';
    this.app.showMessage('Path Cleared', false, 3000);
    console.log('Path cleared');
  }

  protected returnToBase() {
    this.autonomousControl.status = 'returning';
    this.app.showMessage('Returning to Base', false, 3000);
    console.log('Returning to base');
  }

  protected abortMission() {
    this.autonomousControl.status = 'aborted';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;
    
    // Send stop command to MOOS-IvP when aborting
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send('AUTONOMOUS_STOP=true');
      console.log('Sent AUTONOMOUS_STOP=true to MOOS-IvP (mission aborted)');
    }
    
    this.app.showMessage('Mission Aborted', true, 3000);
    console.log('Mission aborted');
  }

  protected closeAutonomousControl() {
    // Remove selected route from map when closing autonomous control
    if (this.autonomousControl.selectedRoute) {
      this.skres.routeRemove([this.autonomousControl.selectedRoute]);
    }
    
    this.display.autonomousControlPanelOpen = false;
    this.app.config.selections.autonomousControl = false;
    this.autonomousControl.status = 'standby';
    this.autonomousControl.selectedRoute = '';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;
    this.app.saveConfig();
    this.app.showMessage('Autonomous Control Deactivated', false, 3000);
    this.focusMap();
  }

  protected toggleToolbarButtons() {
    this.app.uiConfig.update((current) => {
      return Object.assign({}, current, {
        toolbarButtons: !current.toolbarButtons
      });
    });
    this.focusMap();
  }

  protected toggleConstrainMapZoom() {
    this.app.uiConfig.update((current) => {
      return Object.assign({}, current, {
        mapConstrainZoom: !current.mapConstrainZoom
      });
    });
    this.skres.setMapZoomRange();
    this.focusMap();
  }

  protected invertFeatureLabelColor() {
    this.app.uiConfig.update((current) => {
      return Object.assign({}, current, { invertColor: !current.invertColor });
    });
    this.focusMap();
  }

  protected toggleAlertList(show: boolean) {
    this.app.uiCtrl.update((current) => {
      return Object.assign({}, current, { alertList: show });
    });
  }

  protected toggleAutopilotConsole(show: boolean) {
    this.app.uiCtrl.update((current) => {
      return Object.assign({}, current, { autopilotConsole: show });
    });
  }

  protected toggleRouteBuilderConsole(show: boolean) {
    this.app.uiCtrl.update((current) => {
      return Object.assign({}, current, { routeBuilder: show });
    });
  }

  protected toggleSuppressContextMenu(value: boolean) {
    this.app.uiCtrl.update((current) => {
      return Object.assign({}, current, { suppressContextMenu: value });
    });
  }

  protected toggleFullscreen() {
    const docel = document.documentElement;
    const fscreen =
      docel.requestFullscreen ||
      docel['webkitRequestFullScreen'] ||
      docel['mozRequestFullscreen'] ||
      docel['msRequestFullscreen'];
    if (fscreen) {
      if (!document.fullscreenElement) {
        fscreen.call(docel);
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
      this.focusMap();
    }
  }

  /** ************* */

  private setDarkTheme() {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    if (
      (this.app.config.darkMode.source === 0 && mq.matches) ||
      (this.app.config.darkMode.source === 1 &&
        this.app.data.vessels.self.environment.mode === 'night') ||
      this.app.config.darkMode.source === -1
    ) {
      this.overlayContainer.getContainerElement().classList.add('dark-theme');
      this.app.config.darkMode.enabled = true;
    } else {
      this.overlayContainer
        .getContainerElement()
        .classList.remove('dark-theme');
      this.app.config.darkMode.enabled = false;
    }
  }

  private formatInstrumentsUrl() {
    const url = `${this.app.hostDef.url}${this.app.config.plugins.instruments}`;
    const params = this.app.config.plugins.parameters
      ? this.app.config.plugins.parameters.length > 0 &&
        this.app.config.plugins.parameters[0] !== '?'
        ? `?${this.app.config.plugins.parameters}`
        : this.app.config.plugins.parameters
      : '';
    return params ? `${url}/${params}` : url;
  }

  // ** select prev/next favourite plugin **
  public selectPlugin(next = false) {
    if (next) {
      if (this.selFavourite === -1) {
        this.selFavourite = 0;
      } else if (
        this.selFavourite ===
        this.app.config.selections.pluginFavourites.length - 1
      ) {
        this.selFavourite = -1;
      } else {
        this.selFavourite++;
      }
    } else {
      if (this.selFavourite === -1) {
        this.selFavourite =
          this.app.config.selections.pluginFavourites.length - 1;
      } else if (this.selFavourite === 0) {
        this.selFavourite = -1;
      } else {
        this.selFavourite--;
      }
    }
    const url =
      this.selFavourite === -1
        ? this.formatInstrumentsUrl()
        : `${this.app.hostDef.url}${
            this.app.config.selections.pluginFavourites[this.selFavourite]
          }`;

    this.instUrl = this.dom.bypassSecurityTrustResourceUrl(url);
  }

  // ** handle map context menu selections **
  public handleContextMenuSelection(action: string) {
    switch (action) {
      case 'cleartrail':
        this.clearTrail(this.app.data.serverTrail);
        break;
      case 'trail2route':
        this.trailToRoute();
        break;
      case 'cleardestination':
        this.clearDestination();
        break;
      case 'anchor':
        this.displayLeftMenu('anchorWatch', true);
        break;
      case 'weather_forecast':
        this.showWeather('forecast');
        break;
    }
  }
  // ** create route from vessel trail **
  public trailToRoute() {
    this.dialog
      .open(Trail2RouteDialog, {
        disableClose: true,
        data: { trail: this.app.data.trail }
      })
      .afterClosed()
      .subscribe((r) => {
        if (r.result) {
          this.skres.newRouteAt(r.data);
        }
        this.focusMap();
      });
  }

  public showWeather(mode: string) {
    if (mode === 'forecast') {
      this.bottomSheet
        .open(WeatherForecastModal, {
          disableClose: true,
          data: { title: 'Forecast' }
        })
        .afterDismissed()
        .subscribe(() => {
          this.focusMap();
        });
    }
  }

  // display selected experiment UI
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public openExperiment(e: { choice: string; value?: any }) {
    switch (e.choice) {
      case 'debugCapture':
        if (window.isSecureContext) {
          navigator.clipboard.writeText(
            JSON.stringify({
              data: this.app.data,
              config: this.app.config
            })
          );
          this.app.showMessage('Debug data catpured to clipboard.');
        } else {
          this.app.showAlert(
            'Feature Unavailable',
            'This feature is only available in a secure context!\n e.g. https, http://localhost, http://127.0.0.1'
          );
        }
        break;
      default:
        // resource set
        if (this.app.config.resources.paths.includes(e.choice)) {
          this.bottomSheet
            .open(ResourceSetModal, {
              disableClose: true,
              data: { path: e.choice }
            })
            .afterDismissed()
            .subscribe(() => {
              this.focusMap();
            });
        }
    }
  }

  // ** display course settings screen **
  public openCourseSettings() {
    this.bottomSheet
      .open(CourseSettingsModal, {
        disableClose: true,
        data: { title: 'Course Settings' }
      })
      .afterDismissed()
      .subscribe(() => {
        this.focusMap();
      });
  }

  // ************************************************
  /** Handle SignalK Auth token value change */
  handleSKAuthChange() {
    this.signalk.getLoginStatus().subscribe((r) => {
      this.app.data.loginRequired = r.authenticationRequired ?? false;
      this.app.isLoggedIn.update(() =>
        r.status === 'loggedIn' ? true : false
      );
      // ** Request using cached auth token and display badge
      this.signalk.get('/plugins/swiftships-ui').subscribe(
        () => {
          this.app.debug('User Authenticated');
          this.app.isLoggedIn.set(true);
        },
        (err: HttpErrorResponse) => {
          if (err.status === 401) {
            this.app.debug('User NOT Authenticated');
            this.app.isLoggedIn.set(false);
          }
        }
      );
    });
  }

  /** establish connection to server */
  private connectSignalKServer() {
    this.app.data.selfId = null;
    this.app.data.server = null;
    this.signalk.proxied = this.app.config.selections.signalk.proxied;
    this.signalk
      .connect(
        this.app.hostDef.name,
        this.app.hostDef.port,
        this.app.hostDef.ssl
      )
      .subscribe(
        () => {
          this.signalk.authToken = this.app.getFBToken();
          this.app.watchSKLogin();
          this.app.loadSettingsfromServer();
          this.getFeatures();
          this.app.data.server = this.signalk.server.info;
          this.openSKStream();
        },
        () => {
          this.app.showMessage(
            'Unable to contact Signal K server! (Retrying in 5 secs)',
            false,
            5000
          );
          setTimeout(() => this.connectSignalKServer(), 5000);
        }
      );
  }

  /** establish connection to MOOS-IvP server */
  private connectMoosIvPServer() {
    if (this.app.data.connectionState.moosIvP.connecting) {
      return; // already connecting
    }

    this.app.data.connectionState.moosIvP.connecting = true;
    this.app.data.connectionState.moosIvP.lastAttempt = Date.now();
    
    const wsUrl = `${this.app.config.moosIvP.url}:${this.app.config.moosIvP.port}`;
    this.app.data.moosIvPServer.url = wsUrl;

    try {
      const socket = new WebSocket(wsUrl);
      this.app.data.moosIvPServer.socket = socket;

      socket.onopen = () => {
        this.app.debug('MOOS-IvP WebSocket connection opened');
        this.app.data.moosIvPServer.connected = true;
        this.app.data.connectionState.moosIvP.connected = true;
        this.app.data.connectionState.moosIvP.connecting = false;
        this.app.showMessage('MOOS-IvP connection established', false, 3000);
      };

      socket.onmessage = (event) => {
        this.handleMoosIvPMessage(event.data);
      };

      socket.onclose = (event) => {
        this.app.debug('MOOS-IvP WebSocket connection closed', event);
        this.app.data.moosIvPServer.connected = false;
        this.app.data.connectionState.moosIvP.connected = false;
        this.app.data.connectionState.moosIvP.connecting = false;
        
        if (!event.wasClean) {
          this.app.showMessage('MOOS-IvP connection lost. Retrying...', false, 3000);
          // Auto-retry connection after 5 seconds
          setTimeout(() => {
            if (this.app.config.moosIvP.enabled && this.app.config.moosIvP.autoConnect) {
              this.connectMoosIvPServer();
            }
          }, 5000);
        }
      };

      socket.onerror = (error) => {
        this.app.debug('MOOS-IvP WebSocket error:', error);
        this.app.data.connectionState.moosIvP.connecting = false;
        this.app.showMessage('MOOS-IvP connection failed', false, 3000);
      };

    } catch (error) {
      this.app.debug('Failed to create MOOS-IvP WebSocket:', error);
      this.app.data.connectionState.moosIvP.connecting = false;
      this.app.showMessage('Failed to connect to MOOS-IvP server', false, 3000);
    }
  }

  /** handle MOOS-IvP WebSocket message */
  private handleMoosIvPMessage(data: string) {
    try {
      this.app.data.moosIvPServer.lastMessage = data;
      // this.app.debug('MOOS-IvP message received:', data);
      
      // Parse MOOS variable updates (format: VAR=value)
      const lines = data.split('\n');
      lines.forEach(line => {
        if (line.includes('=')) {
          const [variable, value] = line.split('=', 2);
          this.processMoosVariable(variable.trim(), value.trim());
        }
      });
    } catch (error) {
      this.app.debug('Error processing MOOS-IvP message:', error);
    }
  }

  /** process individual MOOS variable */
  private processMoosVariable(variable: string, value: string) {
    switch (variable) {
      case 'IVPHELM_STATE':
        this.app.data.moosIvPServer.ivpHelmState = value;
        break;
      case 'IVPHELM_ALLSTOP':
        this.app.data.moosIvPServer.ivpHelmAllstop = value;
        break;
      case 'WPT_INDEX':
        this.app.data.moosIvPServer.wptIndex = parseInt(value) || 0;
        break;
      case 'WPT_DIST':
        this.app.data.moosIvPServer.wptDist = parseFloat(value) || 0;
        break;
      case 'WPT_ETA':
        this.app.data.moosIvPServer.wptEta = parseFloat(value) || 0;
        break;
      case 'WPT_COMPLETED':
        this.app.data.moosIvPServer.wptCompleted = value.toLowerCase() === 'true';
        break;
      default:
        // Handle other MOOS variables as needed
        // this.app.debug(`Unknown MOOS variable: ${variable} = ${value}`);
    }
  }

  /** disconnect from MOOS-IvP server */
  private disconnectMoosIvPServer() {
    if (this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.close();
      this.app.data.moosIvPServer.socket = null;
      this.app.data.moosIvPServer.connected = false;
      this.app.data.connectionState.moosIvP.connected = false;
      this.app.data.connectionState.moosIvP.connecting = false;
    }
  }

  /** send command to MOOS-IvP server */
  public sendMoosIvPCommand(command: string) {
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      try {
        this.app.data.moosIvPServer.socket.send(command);
        this.app.debug(`Sent MOOS-IvP command: ${command}`);
      } catch (error) {
        this.app.debug('Error sending MOOS-IvP command:', error);
        this.app.showMessage('Failed to send command to MOOS-IvP', false, 3000);
      }
    } else {
      this.app.showMessage('MOOS-IvP not connected', false, 3000);
    }
  }

  /** public method to manually connect to MOOS-IvP */
  public connectToMoosIvP() {
    if (!this.app.data.connectionState.moosIvP.connected && !this.app.data.connectionState.moosIvP.connecting) {
      this.connectMoosIvPServer();
    }
  }

  /** public method to manually disconnect from MOOS-IvP */
  public disconnectFromMoosIvP() {
    this.disconnectMoosIvPServer();
  }

  /** send waypoints to MOOS-IvP server */
  private sendWaypointsToMOOS(waypoints: any[]) {
    if (
      this.app.data.moosIvPServer &&
      this.app.data.moosIvPServer.socket &&
      this.app.data.moosIvPServer.socket.readyState === WebSocket.OPEN
    ) {
      // Format waypoints as lat1,lon1:lat2,lon2:lat3,lon3...
      // Note that waypoints in SignalK are stored as [longitude, latitude]
      // but we need to send as latitude,longitude format
      const waypointString = waypoints.map(point => {
        // Extract lat and lon from the point and format
        const lat = point[1]; // Latitude is at index 1
        const lon = point[0]; // Longitude is at index 0
        return `${lat},${lon}`;
      }).join(':');
      
      // Send the formatted waypoint string
      this.app.data.moosIvPServer.socket.send(`AUTONOMOUS_WAYPOINTS=${waypointString}`);
      console.log('Sent waypoints to MOOS-IvP:', waypointString);
    } else {
      console.error('MOOS-IvP connection not available');
    }
  }

  // ** discover server features **
  private getFeatures() {
    // check server features
    const ff = {
      anchorApi: false,
      autopilotApi: false,
      weatherApi: false,
      buddyList: false
    };
    this.signalk.get('/signalk/v2/features?enabled=1').subscribe(
      (res: {
        apis: string[];
        plugins: Array<{ id: string; version: string }>;
      }) => {
        // detect apis
        ff.weatherApi = res.apis.includes('weather');
        ff.autopilotApi = res.apis.includes('autopilot');

        // detect plugins
        const hasPlugin = {
          charts: false,
          pmTiles: false
        };

        res.plugins.forEach((p: { id: string; version: string }) => {
          // anchor alarm
          if (p.id === 'anchoralarm') {
            this.app.debug('*** found anchoralarm plugin');
            ff.anchorApi = true;
          }
          // buddy list
          if (p.id === 'signalk-buddylist-plugin') {
            this.app.debug('*** found buddylist plugin');
            ff.buddyList = semver.satisfies(p.version, '>1.2.0') ? true : false;
          }
          // charts v2 api support
          if (p.id === 'charts') {
            this.app.debug('*** found charts plugin');
            hasPlugin.charts = true;
            if (
              semver.satisfies(p.version, '>=3.0.0') &&
              this.app.config.chartApi === 1
            ) {
              this.app.config.chartApi = 2;
            }
          }
          // PMTiles support
          if (p.id === 'signalk-pmtiles-plugin') {
            this.app.debug('*** found PMTiles plugin');
            hasPlugin.pmTiles = true;
          }
        });
        // finalise
        if (hasPlugin.pmTiles && !hasPlugin.charts) {
          this.app.config.chartApi = 2;
        }
        this.app.featureFlags.update((current) => {
          const n = Object.assign(current, ff);
          return n;
        });
      },
      () => {
        this.app.debug('*** Features API not present!');
      }
    );

    // check for resource groups
    this.signalk.api.get(this.app.skApiVersion, 'resources/groups').subscribe(
      () => {
        this.app.featureFlags.update((current) => {
          current.resourceGroups = true;
          return current;
        });
      },
      () => {
        this.app.debug('*** Features API not present!');
        this.app.featureFlags.update((current) => {
          current.resourceGroups = false;
          return current;
        });
      }
    );
  }

  // ** start trail / AIS timers
  private startTimers() {
    // ** start trail logging interval timer
    this.app.debug(`Starting Trail logging timer...`);
    this.timers.push(
      setInterval(() => {
        this.processTrail();
      }, 5000)
    );
  }
  // ** stop timers
  private stopTimers() {
    this.app.debug(`Stopping timers:`);
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }

  // ** process local vessel trail **
  private processTrail(trailData?) {
    if (!this.app.config.selections.vessel.trail) {
      return;
    }
    // ** update vessel trail **
    const t = this.app.data.trail.slice(-1);
    if (this.app.data.vessels.showSelf) {
      if (t.length === 0) {
        this.app.data.trail.push(this.app.data.vessels.self.position);
        return;
      }
      if (
        this.app.data.vessels.self.position[0] !== t[0][0] ||
        this.app.data.vessels.self.position[1] !== t[0][1]
      ) {
        this.app.data.trail.push(this.app.data.vessels.self.position);
      }
    }
    if (!trailData || trailData.length === 0) {
      // no server trail data supplied
      if (this.app.data.trail.length % 60 === 0 && this.app.data.serverTrail) {
        if (this.app.config.selections.trailFromServer) {
          this.app.fetchTrailFromServer(); // request trail from server
        }
      }
      this.app.data.trail = this.app.data.trail.slice(-5000);
    } else {
      // use server trail data, keep minimal local trail data
      const lastseg = trailData.slice(-1);
      const lastpt =
        lastseg.length !== 0
          ? lastseg[0].slice(-1)
          : trailData.length > 1
          ? trailData[trailData.length - 2].slice(-1)
          : [];
      this.app.data.trail = lastpt;
    }
    const trailId = this.mode === SKSTREAM_MODE.PLAYBACK ? 'history' : 'self';
    this.app.db.saveTrail(trailId, this.app.data.trail);
  }

  // ** Trail$ event handlers **
  private handleTrailUpdate(e) {
    // ** trail retrieved from server **
    if (e.action === 'get' && e.mode === 'trail') {
      this.processTrail(e.data);
    }
  }

  /** SETTINGS event handler (Save)
   * @todo load action review
   */
  private handleSettingsEvent(e: SettingsEventMessage) {
    this.app.debug(`AppComponent: settings.update$`);
    if (e.action === 'save') {
      this.setDarkTheme(); // **  set theme **
      if (
        this.app.sTrueMagChoice() !==
        this.app.config.selections.headingAttribute
      ) {
        this.app.debug('True / Magnetic selection changed..');
        this.app.data.vessels.self.heading = this.app.useMagnetic
          ? this.app.data.vessels.self.headingMagnetic
          : this.app.data.vessels.self.headingTrue;
        this.app.data.vessels.self.cog = this.app.useMagnetic
          ? this.app.data.vessels.self.cogMagnetic
          : this.app.data.vessels.self.cogTrue;
        this.app.data.vessels.self.wind.direction = this.app.useMagnetic
          ? this.app.data.vessels.self.wind.mwd
          : this.app.data.vessels.self.wind.twd;

        this.app.data.vessels.aisTargets.forEach((v) => {
          v.heading = this.app.useMagnetic ? v.headingMagnetic : v.headingTrue;
          v.cog = this.app.useMagnetic ? v.cogMagnetic : v.cogTrue;
          v.wind.direction = this.app.useMagnetic ? v.wind.mwd : v.wind.twd;
        });
        this.app.sTrueMagChoice.set(
          this.app.config.selections.headingAttribute
        );
      }

      if (
        this.lastInstUrl !== this.app.config.plugins.instruments ||
        this.lastInstParams !== this.app.config.plugins.parameters
      ) {
        this.lastInstUrl = this.app.config.plugins.instruments;
        this.lastInstParams = this.app.config.plugins.parameters;
        this.instUrl = this.dom.bypassSecurityTrustResourceUrl(
          this.formatInstrumentsUrl()
        );
      }
      if (this.lastVideoUrl !== this.app.config.resources.video.url) {
        this.lastVideoUrl = this.app.config.resources.video.url;
        this.vidUrl = this.dom.bypassSecurityTrustResourceUrl(
          `${this.app.config.resources.video.url}`
        );
      }
      // ** trail **
      if (this.app.config.selections.vessel.trail) {
        // show trail
        if (this.app.config.selections.trailFromServer) {
          this.app.fetchTrailFromServer();
        } else {
          this.app.data.serverTrail = false;
        }
      }

      // ** MOOS-IvP connection settings changed
      if (this.app.config.moosIvP.enabled && this.app.config.moosIvP.autoConnect) {
        if (!this.app.data.connectionState.moosIvP.connected && !this.app.data.connectionState.moosIvP.connecting) {
          this.connectMoosIvPServer();
        }
      } else if (!this.app.config.moosIvP.enabled && this.app.data.connectionState.moosIvP.connected) {
        this.disconnectMoosIvPServer();
      }
    }
    // update instrument app state
    if (this.app.config.plugins.startOnOpen) {
      if (!this.display.instrumentPanelOpen) {
        this.display.instrumentAppActive = false;
      }
    } else {
      this.display.instrumentAppActive = true;
    }
  }

  // ** trigger focus of the map so keyboard controls work
  public focusMap() {
    this.mapSetFocus.update(() => Date().valueOf());
  }

  // ********* SIDENAV ACTIONS *************

  public rightSideNavAction(e: boolean) {
    this.display.instrumentPanelOpen = e;
    if (e) {
      // Opening instrument panel - close other right-side panels
      this.display.remoteControlPanelOpen = false;
      this.display.autonomousControlPanelOpen = false;
    }
    if (this.app.config.plugins.startOnOpen) {
      this.display.instrumentAppActive = e;
    }
    if (!e) {
      this.focusMap();
    } // set when closed
  }

  public displayLeftMenu(menulist = '', show = false) {
    this.display.leftMenuPanel = show;
    this.display.routeList = false;
    this.display.waypointList = false;
    this.display.chartList = false;
    this.display.noteList = false;
    this.display.trackList = false;
    this.display.aisList = false;
    this.display.anchorWatch = false;
    switch (menulist) {
      case 'routeList':
        this.display.routeList = show;
        break;
      case 'waypointList':
        this.display.waypointList = show;
        break;
      case 'chartList':
        this.display.chartList = show;
        break;
      case 'noteList':
        this.display.noteList = show;
        break;
      case 'trackList':
        this.display.trackList = show;
        break;
      case 'anchorWatch':
        this.display.anchorWatch = show;
        break;
      case 'aisList':
        this.display.aisList = show;
        break;
      case 'resourceGroups':
        this.display.resourceGroups.set(show);
        break;
      default:
        this.display.leftMenuPanel = false;
    }
    if (!show) {
      this.focusMap();
    }
  }

  // ********* MAIN MENU ACTIONS *************

  // ** open about dialog **
  public openAbout() {
    this.dialog
      .open(AboutDialog, {
        disableClose: false,
        data: {
          name: this.app.name,
          version: this.app.version,
          description: this.app.description,
          logo: this.app.logo,
          url: this.app.url
        }
      })
      .afterClosed()
      .subscribe(() => this.focusMap());
  }

  // ** open settings dialog **
  public openSettings() {
    this.dialog
      .open(SettingsDialog, {
        disableClose: true,
        data: {},
        maxWidth: '90vw',
        minHeight: '80vh'
      })
      .afterClosed()
      .subscribe(() => {
        this.focusMap();
      });
  }

  /** GPX / GeoJSON imports */
  public importFile(f: { data: string | ArrayBuffer; name: string }) {
    if ((f.data as string).indexOf('<gpx ') !== -1) {
      this.processGPX(f);
    } else if (
      (f.data as string).indexOf(`"type": "FeatureCollection",`) !== -1
    ) {
      this.processGeoJSON(f);
    } else {
      this.app.showAlert('Import', 'File format not supported!');
    }
    this.focusMap();
  }

  /** process GPX file */
  public processGPX(f: { data: string | ArrayBuffer; name: string }) {
    this.dialog
      .open(GPXImportDialog, {
        disableClose: true,
        data: {
          fileData: f.data,
          fileName: f.name
        }
      })
      .afterClosed()
      .subscribe((res: { errCount: number; errList: ErrorList }) => {
        if (typeof res.errCount === 'undefined' || res.errCount < 0) {
          // cancelled
          this.focusMap();
          return;
        }
        this.fetchResources();
        if (res.errCount === 0) {
          this.app.showMsgBox(
            'GPX Load',
            'GPX file resources loaded successfully.'
          );
        } else {
          this.app.showErrorList(res.errList);
        }
        this.focusMap();
      });
  }

  /** Export resources to GPX file */
  public exportToGPX() {
    this.dialog
      .open(GPXExportDialog, {
        disableClose: true,
        data: {
          routes: this.skres.routes(),
          tracks: [this.app.data.trail]
        }
      })
      .afterClosed()
      .subscribe((errCount) => {
        if (errCount < 0) {
          // cancelled
          this.focusMap();
          return;
        }
        if (errCount === 0) {
          this.app.showMsgBox(
            'GPX Save',
            'Resources saved to GPX file successfully.'
          );
        } else {
          this.app.showAlert('GPX Save', 'Error saving resources to GPX file!');
        }
        this.focusMap();
      });
  }

  /** process GeoJSON file */
  processGeoJSON(f: { data: string | ArrayBuffer; name: string }) {
    this.dialog
      .open(GeoJSONImportDialog, {
        disableClose: true,
        data: {
          fileData: f.data,
          fileName: f.name
        }
      })
      .afterClosed()
      .subscribe((errCount) => {
        if (errCount < 0) {
          return;
        } // cancelled
        this.fetchResources();
        if (errCount === 0) {
          this.app.showMsgBox(
            'GeoJSON Load',
            'GeoJSON features loaded successfully.'
          );
        } else {
          this.app.showAlert(
            'GeoJSON Load',
            'Completed with errors!\nNot all features were loaded.'
          );
        }
        this.focusMap();
      });
  }

  /** Import ResourceSet */
  importResourceSet() {
    this.dialog
      .open(ResourceImportDialog, {
        disableClose: true,
        data: {}
      })
      .afterClosed()
      .subscribe((res) => {
        if (!res) {
          return;
        } // cancelled
        try {
          const d = JSON.parse(res.data);
          this.skres.postToServer(res.path as any, d);
        } catch (err) {
          this.app.showAlert(
            'Load Resource',
            'Resources were not loaded!\nInvalid JSON.'
          );
        }
        this.focusMap();
      });
  }

  // ** show login dialog **
  public showLogin(
    message?: string,
    cancelWarning = true,
    onConnect?: boolean
  ): Observable<boolean> {
    const lis: Subject<boolean> = new Subject();
    this.dialog
      .open(LoginDialog, {
        disableClose: true,
        data: { message: message || 'Login to Signal K server.' }
      })
      .afterClosed()
      .subscribe((res) => {
        if (!res.cancel) {
          this.signalk.login(res.user, res.pwd).subscribe(
            (r) => {
              // ** authenticated
              this.app.persistToken(r['token']);
              this.app.loadSettingsfromServer();
              if (onConnect) {
                this.queryAfterConnect();
              }
              this.app.isLoggedIn.set(true);
              lis.next(true);
            },
            () => {
              // ** auth failed
              this.app.persistToken(null);
              this.signalk.isLoggedIn().subscribe((r) => {
                this.app.isLoggedIn.set(r);
              });
              if (onConnect) {
                this.app
                  .showConfirm(
                    'Invalid Username or Password.',
                    'Authentication Failed:',
                    'Try Again'
                  )
                  .subscribe(() => {
                    this.showLogin(null, false, true);
                  });
              } else {
                this.app
                  .showConfirm(
                    'Invalid Username or Password.\nNote: Choosing CLOSE may make operations requiring authentication unavailable.',
                    'Authentication Failed:',
                    'Try Again',
                    'Close'
                  )
                  .subscribe((r) => {
                    if (r) {
                      this.showLogin();
                    }
                  });
              }
            }
          );
        } else {
          this.app.hasAuthToken.set(false); // show login menu item
          this.signalk.isLoggedIn().subscribe((r: boolean) => {
            this.app.isLoggedIn.set(r);
          });
          if (onConnect) {
            this.showLogin(null, false, true);
          } else {
            if (cancelWarning) {
              this.app.showAlert(
                'Login Cancelled:',
                `Update operations are NOT available until you have authenticated to the Signal K server.`
              );
            }
            lis.next(false);
          }
        }
        this.focusMap();
      });
    return lis.asObservable();
  }

  public showPlaybackSettings() {
    this.dialog
      .open(PlaybackDialog, {
        disableClose: false
      })
      .afterClosed()
      .subscribe((r) => {
        if (r.result) {
          // OK: switch to playback mode
          this.switchMode(SKSTREAM_MODE.PLAYBACK, r.query);
        } else {
          // cancel: restarts realtime mode
          this.switchMode(SKSTREAM_MODE.REALTIME);
        }
        this.focusMap();
      });
  }

  // ***** OPTIONS MENU ACTONS *******

  public centerResource(position: [number, number], zoomTo?: number) {
    position[0] += 0.0000000000001;
    this.display.map.center = position;
    if (typeof zoomTo === 'number') {
      this.app.config.map.zoomLevel = zoomTo;
    }
  }

  public centerVessel() {
    const t = this.app.data.vessels.active.position;
    t[0] += 0.0000000000001;
    this.display.map.center = t;
  }

  public toggleAisTargets() {
    this.app.config.aisTargets = !this.app.config.aisTargets;
    if (this.app.config.aisTargets) {
      this.processAIS(true);
    }
    this.app.saveConfig();
  }

  public toggleCourseData() {
    this.app.config.courseData = !this.app.config.courseData;
    this.app.saveConfig();
  }

  public toggleNotes() {
    this.app.config.notes = !this.app.config.notes;
    this.app.saveConfig();
  }

  // ** delete vessel trail **
  public clearTrail(noprompt = false) {
    if (noprompt) {
      if (!this.app.data.serverTrail) {
        this.app.data.trail = [];
      } else {
        if (this.app.config.selections.trailFromServer) {
          this.app.fetchTrailFromServer(); // request trail from server
        }
      }
    } else {
      if (!this.app.data.serverTrail)
        this.app
          .showConfirm(
            'Clear Vessel Trail',
            'Do you want to delete the vessel trail?'
          )
          .subscribe((res) => {
            if (res) {
              if (!this.app.data.serverTrail) {
                this.app.data.trail = [];
              } else {
                if (this.app.config.selections.trailFromServer) {
                  this.app.fetchTrailFromServer(); // request trail from server
                }
              }
            }
          });
    }
  }

  // ** clear course / navigation data **
  public clearCourseData() {
    const idx = this.app.data.navData.pointIndex;
    this.app.data.navData = {
      dtg: null,
      ttg: null,
      eta: null,
      route: {
        dtg: null,
        ttg: null,
        eta: null
      },
      bearing: { value: null, type: null },
      bearingTrue: null,
      bearingMagnetic: null,
      xte: null,
      vmg: null,
      position: [null, null],
      pointIndex: idx,
      pointTotal: 0,
      arrivalCircle: null,
      startPosition: [null, null],
      pointNames: [],
      activeRoutePoints: null,
      destPointName: ''
    };
  }

  // ** clear active destination **
  public clearDestination() {
    this.course.clearCourse();
  }

  // ********** MAP / UI ACTIONS **********

  // ** set active route **
  public activateRoute(id: string) {
    this.course.activateRoute(id);
  }

  // ** Increment / decrement next active route point **
  public routeNextPoint(pointIndex: number) {
    this.course.coursePointIndex(pointIndex);
    this.focusMap();
  }

  // ** show feature (vessel/AtoN/Aircraft/Route points) properties **
  public async featureProperties(e: { id: string; type: string }) {
    let v: FBRoute | SKVessel | SKSaR | SKAircraft | SKAtoN;
    if (e.type === 'route') {
      try {
        this.app.sIsFetching.set(true);
        v = await this.skres.fromServer('routes', e.id);
        this.app.sIsFetching.set(false);
        if (v) {
          this.bottomSheet
            .open(ActiveResourcePropertiesModal, {
              disableClose: true,
              data: {
                title: 'Route Properties',
                resource: [e.id, v, false],
                type: e.type
              }
            })
            .afterDismissed()
            .subscribe((deactivate: boolean) => {
              if (deactivate) {
                this.clearDestination();
              }
              this.focusMap();
            });
        }
      } catch (err) {
        this.app.sIsFetching.set(false);
        this.app.parseHttpErrorResponse(err);
      }
    } else if (e.type === 'aton' || e.type === 'meteo') {
      let title: string;
      let icon: string;
      let atonType: string;
      if (e.type === 'meteo') {
        v = this.app.data.meteo.get(e.id);
        title = 'Meteo Properties';
        icon = 'air';
        atonType = e.type;
      } else if (e.id.slice(0, 3) === 'sar') {
        v = this.app.data.sar.get(e.id);
        title = 'SaR Properties';
        icon = 'tour';
        atonType = 'sar';
      } else {
        v = this.app.data.atons.get(e.id);
        title = 'AtoN Properties';
        icon = 'beenhere';
        atonType = 'aton';
      }
      if (v) {
        this.bottomSheet
          .open(AtoNPropertiesModal, {
            disableClose: true,
            data: {
              title: title,
              target: v,
              id: e.id,
              icon: icon,
              type: atonType
            }
          })
          .afterDismissed()
          .subscribe(() => this.focusMap());
      }
    } else if (e.type === 'aircraft') {
      v = this.app.data.aircraft.get(e.id);
      if (v) {
        this.bottomSheet
          .open(AircraftPropertiesModal, {
            disableClose: true,
            data: {
              title: 'Aircraft Properties',
              target: v,
              id: e.id
            }
          })
          .afterDismissed()
          .subscribe(() => this.focusMap());
      }
    } else if (e.type === 'alarm') {
      this.notiMgr.showAlertInfo(e.id);
    } else if (e.type === 'rset') {
      v = this.skresOther.fromCache(e.id);
      if (v) {
        this.bottomSheet
          .open(ResourceSetFeatureModal, {
            disableClose: true,
            data: { id: e.id, item: v }
          })
          .afterDismissed()
          .subscribe(() => {
            this.focusMap();
          });
      }
    } else {
      // vessel
      const id =
        e.type === 'self'
          ? e.type
          : e.id.includes('vessels.')
          ? e.id.split('.')[1]
          : e.id;
      try {
        this.app.sIsFetching.set(true);
        v = await this.skres.vesselFromServer(id);
        this.app.sIsFetching.set(false);
        if (v) {
          this.bottomSheet
            .open(AISPropertiesModal, {
              disableClose: true,
              data: {
                title: 'Vessel Properties',
                target: v
              }
            })
            .afterDismissed()
            .subscribe(() => this.focusMap());
        }
      } catch (err) {
        this.app.sIsFetching.set(false);
        this.app.parseHttpErrorResponse(err);
      }
    }
  }

  // ** handle drag and drop of files onto map container**
  public mapDragOver(e: DragEvent) {
    e.preventDefault();
  }

  public mapDrop(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.files) {
      if (e.dataTransfer.files.length > 1) {
        this.app.showAlert(
          'Load Resources',
          'Multiple files provided!\nPlease select only one file for processing.'
        );
      } else {
        const reader = new FileReader();
        reader.onerror = () => {
          this.app.showAlert(
            'File Load error',
            `There was an error reading the file contents!`
          );
        };
        if (!e.dataTransfer.files[0].name) {
          return;
        }
        const fname = e.dataTransfer.files[0].name;
        reader.onload = () => {
          this.processGPX({ name: fname, data: reader.result });
        };
        reader.readAsText(e.dataTransfer.files[0]);
      }
    }
  }

  // ** process / cleanup AIS targets
  private processAIS(toggled?: boolean) {
    if (!this.app.config.aisTargets && !toggled) {
      return;
    }
    if (toggled) {
      // ** re-populate list after hide
      this.app.data.vessels.aisTargets.forEach((v, k) => {
        this.app.data.aisMgr.updateList.push(k);
      });
    }
  }

  // ********* MODE ACTIONS *************

  // ** set the active vessel to the supplied UUID **
  public switchActiveVessel(uuid: string = null) {
    this.app.data.vessels.activeId = uuid;
    if (!uuid) {
      this.app.data.vessels.active = this.app.data.vessels.self;
    } else {
      const av = this.app.data.vessels.aisTargets.get(uuid);
      if (!av) {
        this.app.data.vessels.active = this.app.data.vessels.self;
        this.app.data.vessels.activeId = null;
      } else {
        this.app.data.vessels.active = av;
        // if instrument panel open - close it
        this.sideright.close();
      }
    }
    this.app.data.activeRoute = null;
    this.clearCourseData();
    this.app.debug(`** Active vessel: ${this.app.data.vessels.activeId} `);
    this.app.debug(this.app.data.vessels.active);
  }

  // ** switch between realtime and history playback modes
  public switchMode(toMode: SKSTREAM_MODE, options?: StreamOptions) {
    this.app.debug(`switchMode from: ${this.mode} to ${toMode}`);
    if (toMode === SKSTREAM_MODE.PLAYBACK) {
      // ** history playback
      this.app.db.saveTrail('self', this.app.data.trail);
      this.app.data.trail = [];
    } else {
      // ** realtime data
      this.app.db.getTrail('self').then((t) => {
        this.app.data.trail = t && t.value ? t.value : [];
      });
    }
    this.switchActiveVessel();
    this.openSKStream(options, toMode, true);
  }

  // ** show select mode dialog
  public showSelectMode() {
    if (this.mode === SKSTREAM_MODE.REALTIME) {
      // request history playback
      this.app
        .showConfirm(
          'Do you want to change to History Playback mode?',
          'Switch Mode'
        )
        .subscribe((r) => {
          if (r) {
            this.showPlaybackSettings();
          }
        });
    } else {
      // request realtime
      this.app
        .showConfirm(
          'Do you want to exit History Playback mode?',
          'Exit History Playback'
        )
        .subscribe((r) => {
          if (r) {
            this.switchMode(SKSTREAM_MODE.REALTIME);
          }
        });
    }
  }

  // ******** DRAW / EDIT EVENT HANDLERS ************

  /**
   * Start feature drawing mode
   * @param f type of feature to draw
   */
  protected drawFeature(f: DrawFeatureType) {
    this.mapInteract.startDrawing(f);
  }

  /** Handle feature DrawEnded event and prompt to save */
  protected handleDrawEnded(e: DrawFeatureInfo) {
    this.mapInteract.isDrawing();
    switch (this.mapInteract.draw.resourceType) {
      case 'note':
        const params = { position: e.coordinates };
        if (this.mapInteract.draw.properties['group']) {
          params['group'] = this.mapInteract.draw.properties['group'];
        }
        this.skres.showNoteEditor(params);
        break;
      case 'waypoint':
        this.skres.newWaypointAt(e.coordinates as Position);
        break;
      case 'route':
        this.skres.newRouteAt(e.coordinates as LineString);
        break;
      case 'region':
        const region = new SKRegion();
        region.feature.geometry.coordinates = [
          GeoUtils.normaliseCoords(e.coordinates as Polygon)
        ];
        this.skres.newRegion(region);
        break;
    }
  }

  /** End interaction mode */
  protected closeInteraction() {
    if (this.mapInteract.isMeasuring()) {
      this.mapInteract.stopMeasuring();
    }
    if (this.mapInteract.isDrawing()) {
      this.mapInteract.stopDrawing();
    }
    if (this.mapInteract.isModifying()) {
      this.mapInteract.stopModifying();
      this.app.data.activeRouteIsEditing = false;

      if (this.mapInteract.draw.forSave?.id) {
        // anchor moved
        if (this.mapInteract.draw.forSave.id === 'anchor') {
          this.mapInteract.draw.forSave = null;
          this.focusMap();
          return;
        }

        // save changes
        this.app
          .showConfirm(
            `Do you want to save the changes made to ${
              this.mapInteract.draw.forSave.id.split('.')[0]
            }?`,
            'Save Changes'
          )
          .subscribe((result) => {
            const r = this.mapInteract.draw.forSave.id.split('.');
            if (result) {
              // save changes
              if (r[0] === 'route') {
                this.skres.updateRouteCoords(
                  r[1],
                  this.mapInteract.draw.forSave.coords,
                  this.mapInteract.draw.forSave.coordsMetadata
                );
              }
              if (r[0] === 'waypoint') {
                this.skres.updateWaypointPosition(
                  r[1],
                  this.mapInteract.draw.forSave.coords
                );
                // if waypoint the target destination update nextPoint
                if (r[1] === this.app.data.activeWaypoint) {
                  this.course.setDestination({
                    latitude: this.mapInteract.draw.forSave.coords[1],
                    longitude: this.mapInteract.draw.forSave.coords[0]
                  });
                }
              }
              if (r[0] === 'note') {
                this.skres.updateNotePosition(
                  r[1],
                  this.mapInteract.draw.forSave.coords
                );
              }
              if (r[0] === 'region') {
                this.skres.updateRegionCoords(
                  r[1],
                  this.mapInteract.draw.forSave.coords
                );
              }
            } else {
              // do not save
              if (r[0] === 'route') {
                this.skres.refreshRoutes();
              }
              if (r[0] === 'waypoint') {
                this.skres.refreshWaypoints();
              }
              if (r[0] === 'note' || r[0] === 'region') {
                this.skres.refreshNotes();
              }
            }
            this.mapInteract.draw.forSave = null;
            this.focusMap();
          });
      }
    }
  }

  // ******** SIGNAL K STREAM *************

  /** fetch resource types from server */
  fetchResources(allTypes = false) {
    this.skres.refreshRoutes();
    this.skres.refreshWaypoints();
    this.skres.refreshCharts();
    this.skres.refreshNotes(); // calling refreshNotes() also refreshes Regions
    if (allTypes) {
      this.fetchOtherResources();
    }
  }

  /** fetch non-standard resources from server */
  fetchOtherResources() {
    this.skres.refreshTracks();
    this.skresOther.refreshInBoundsItems();
  }

  /** open WS Stream */
  private openSKStream(
    options: StreamOptions = null,
    toMode: SKSTREAM_MODE = SKSTREAM_MODE.REALTIME,
    restart = false
  ) {
    if (restart) {
      this.streamOptions = { options: options, toMode: toMode };
      this.stream.close();
      return;
    }
    this.stream.open(options);
  }

  /** query server for current values */
  private queryAfterConnect() {
    if (this.signalk.server.info.version.split('.')[0] === '1') {
      this.app.showAlert(
        'Unsupported Server Version:',
        'The connected Signal K server is not supported by this version of Freeboard-SK.\n Signal K server version 2 or later is required!'
      );
    }
    this.app.alignCustomResourcesPaths();
    this.signalk.api.getSelf().subscribe(
      (r) => {
        this.stream.post({
          cmd: 'vessel',
          options: { context: 'self', name: r['name'] }
        });
        this.fetchResources(true); // ** fetch all resource types from server
        if (this.app.config.selections.trailFromServer) {
          this.app.fetchTrailFromServer(); // request trail from server
        }
        // ** query anchor alarm status
        this.anchor.queryAnchorStatus(
          undefined,
          this.app.data.vessels.self.position
        );
      },
      (err: HttpErrorResponse) => {
        if (err.status && err.status === 401) {
          this.showLogin(null, false, true);
        }
        this.app.debug('No vessel data available!');
      }
    );
  }

  /** handle connection established */
  private onConnect(e?: NotificationMessage | UpdateMessage) {
    this.app.showMessage('Connection Open.', false, 2000);
    this.app.debug(e);
    // ** query server for status
    this.queryAfterConnect();
    // ** start trail timer
    this.startTimers();
  }

  // ** handle connection closure
  private onClose(e?: NotificationMessage | UpdateMessage) {
    this.app.debug('onClose: STREAM connection closed...');
    this.app.debug(e);
    this.stopTimers();
    if (e.result) {
      // closed by command then restart
      this.openSKStream(this.streamOptions.options, this.streamOptions.toMode);
    } else {
      const data = {
        title: 'Connection Closed:',
        buttonText: 'Re-connect',
        message: ''
      };
      if (e.playback) {
        data.buttonText = 'OK';
        data.message = 'Unable to open Playback connection.';

        this.app
          .showAlert(data.message, data.title, data.buttonText)
          .subscribe(() => {
            if (this.mode === SKSTREAM_MODE.REALTIME) {
              this.switchMode(this.mode);
            } else {
              this.showPlaybackSettings();
            }
          });
      } else {
        if (!this.reconnecting) {
          this.reconnecting = true;
          setTimeout(() => {
            this.reconnecting = false;
            this.openSKStream(this.streamOptions.options, this.mode);
          }, 5000);
        }
      }
    }
  }

  private reconnecting = false;

  // ** handle error message
  private onError(e?: NotificationMessage | UpdateMessage) {
    this.app.showMessage('Connection Error!', false, 2000);
    console.warn('Stream Error!', e);
  }

  // ** handle delta message received
  private onMessage(e: NotificationMessage | UpdateMessage) {
    if (e.action === 'hello') {
      // ** hello message
      this.app.debug(e);
      if (e.playback) {
        this.mode = SKSTREAM_MODE.PLAYBACK;
      } else {
        this.mode = SKSTREAM_MODE.REALTIME;
        this.stream.subscribe();
      }
      this.app.data.selfId = e.self;
      return;
    } else if (e.action === 'update') {
      // delta message
      if (this.mode === SKSTREAM_MODE.PLAYBACK) {
        const d = new Date(e.timestamp);
        this.display.playback.time = `${d.toDateString().slice(4)} ${d
          .toTimeString()
          .slice(0, 8)}`;
      } else {
        this.display.playback.time = null;
        this.setDarkTheme();
      }
      this.updateNavPanel();
    }
  }

  // ** Update NavData Panel display **
  private updateNavPanel() {
    this.display.navDataPanel.show =
      this.app.data.activeRoute ||
      this.app.data.activeWaypoint ||
      this.app.data.navData.position
        ? true
        : false;

    this.display.navDataPanel.nextPointCtrl = this.app.data.activeRoute
      ? true
      : false;

    //autopilot
    if (this.app.data.vessels.self.autopilot.enabled) {
      this.display.navDataPanel.apModeColor = 'primary';
    } else {
      this.display.navDataPanel.apModeColor = '';
    }

    this.display.navDataPanel.apModeText = this.app.data.vessels.self.autopilot
      .default
      ? 'Autopilot: ' + this.app.data.vessels.self.autopilot.default
      : '';
  }
}
