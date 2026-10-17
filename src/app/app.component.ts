import { Component, ViewChild, effect, signal, OnDestroy } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { OverlayContainer } from '@angular/cdk/overlay';
import { Observable, Subject, Subscription, merge } from 'rxjs';

import { AppFacade } from './app.facade';
import { SettingsEventMessage } from './lib/services';
import {
  AboutDialog,
  LoginDialog,
  PlaybackDialog,
  GeoJSONImportDialog,
  Trail2RouteDialog,
  StationKeepDialog,
  StationKeepConfig,
  SingleSelectListDialog
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
  RadarDisplayComponent,
  EngineStatusComponent,
  ReplayService,
  ReplayBarComponent,
  ReplayListDialog,
  RecordingMeta
} from 'src/app/modules';

import { SignalKClient } from 'signalk-client-angular';
import { Convert } from 'src/app/lib/convert';
import { GeoUtils } from 'src/app/lib/geoutils';
import { RoutePlannerService } from 'src/app/lib/services/route-planner.service';
import * as semver from 'semver';
import { MoosIvpWebsocketService } from './lib/moos-ivp-websocket.service';
import {
  initAutonomousControlData,
  initEngineStatus,
  initMoosIvPData
} from './app.settings';

import {
  NotificationMessage,
  UpdateMessage,
  LineString,
  Polygon,
  FBRoute,
  Position,
  ErrorList,
  ColavEncounter,
  ColregsStatus
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
  @ViewChild('fbMapRef', { static: false }) fbMapRef;

  public display = {
    fullscreen: { active: false, enabled: document.fullscreenEnabled },
    leftMenuPanel: false,
    instrumentPanelOpen: true,
    instrumentAppActive: true,
    remoteControlPanelOpen: false,
    autonomousControlPanelOpen: false,
    stationKeepPanelOpen: false,
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
  /** while replaying, keep the live stream closed - onClose() always reopens otherwise */
  private replaySuppressReconnect = false;

  // Remote control data
  public remoteControl = {
    rudder: 0,    // -50 to 50
    thrust: 0,    // -100 to 100%
    gear: 'neutral',  // forward, neutral, reverse
    // What iCAN is really sending (CAN_TX_GEAR / |CAN_TX_THRUST_PCT|);
    // null until the boat first posts them.
    boatGear: null as 'forward' | 'neutral' | 'reverse' | null,
    boatThrust: null as number | null
  };
  /** 1 s keepalive while manual control is on: iWebSocket drops the
      link (boat -> neutral, 0 thrust) after 3 s without a message. */
  private manualKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // Engine trim (manual remote control only). Each TRIM=1 / TRIM=-1 is one
  // timed pulse that iCAN stops by itself; the UI never repeats it.
  // `state` mirrors CAN_TRIM_STATE from the boat (missing = idle). There is
  // no trim position feedback on these boats.
  public trimControl = {
    state: 'idle' as 'idle' | 'up' | 'down'
  };
  /** pending check that a trim click was answered by CAN_TRIM_STATE */
  private trimAckTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TRIM_ACK_MS = 1500;

  // Follow an AIS contact (BHV_Trail on the helm).
  //
  // `active` mirrors what pHelmIvP reports through TRAILING rather than what
  // this UI asked for, so a request that never lands does not leave the panel
  // claiming the boat is following something.
  public aisFollow = {
    active: false,
    mmsi: '',
    name: '',
    range: 100,   // metres astern
    angle: 180    // degrees relative to the contact's heading
  };

  // Autonomous control data. Mission-derived fields come from
  // initAutonomousControlData() so replay can rewind them; the user's own
  // selections and the send timer stay put.
  public autonomousControl = {
    selectedRoute: '',     // Selected route ID
    selectedRegion: '',    // Selected region ID
    waypointSendTimer: null as any,  // Timer for repeatedly sending waypoints
    ...initAutonomousControlData()
  } as {
    selectedRoute: string;
    selectedRegion: string;
    waypointSendTimer: any;
    speed: number;
    status: string;
    currentWaypoint: number;
    progress: number;
    remainingDistance: number;
    estimatedTimeArrival: number;
    repeatRoute: boolean;
    totalDistance: number;
    totalTimeOfArrival: number;
    ignoreStatusUpdates: boolean;
    lastStatus: string;
    canSend: boolean;
    ignoreCanSendUpdates: boolean;
    waypointActive: boolean;
    waypointRadii: { captureRadius: number, slipRadius: number } | null;
  };

  /** which tab of the Autonomous Control sidenav is showing */
  protected autonomousPanelTab: 'mission' | 'follow' | 'pid' | 'colav' | 'test' =
    'mission';

  // Service mode: live PID calibration from the UI.
  // Gains are pushed to planchaPID through iWebSocket (HEADING_K* / SPEED_K*)
  // and only replace the backend gain schedule while SERVICE_MODE is active.
  public servicePid = {
    enabled: false,
    heading: { kp: 0.15, ki: 0, kd: 0.26 },   // rudder loop
    speed: { kp: 0.16, ki: 0.003, kd: 0 },    // thrust loop
    // gains planchaPID reports it is actually applying (from PID_GAINS)
    applied: null as {
      serviceMode: boolean;
      heading: { kp: number; ki: number; kd: number };
      speed: { kp: number; ki: number; kd: number };
    } | null,
    ignoreModeUpdates: false, // ignore SERVICE_MODE echo right after a local toggle
    pendingConfirm: false     // waiting for planchaPID to confirm a toggle
  };

  // Collision avoidance test: place an AIS target from the map and measure what
  // BHV_AvdColregsV22 does about it.
  //
  // `enabled` is optimistic while a toggle is in flight, then follows
  // COLAV_TEST_ACK - the ack comes from pColavEval, so the switch only settles
  // ON if something is actually there to measure. Same handshake as servicePid.
  public colavTest = {
    enabled: false,
    speed: 5,                                        // knots
    courseMode: 'at_usv' as 'at_usv' | 'fixed',
    course: 218.7,                                   // used when courseMode is 'fixed'
    vesselType: 'cargo',
    length: 25,
    beam: 9,
    ignoreModeUpdates: false,
    pendingConfirm: false,
    targets: [] as string[],                         // placed, from TRAFFIC_TARGETS
    encounters: [] as ColavEncounter[],              // parsed from COLAV_METRICS
    lastError: ''                                    // refusal reason from the backend
  };

  // Vessel types pTrafficSim maps onto ITU ship-and-cargo codes
  protected readonly colavVesselTypes = [
    'cargo', 'tug', 'tanker', 'ferry', 'fishing', 'sailing', 'pleasure'
  ];

  // Engagement distances the collision avoidance behaviour is running with.
  // These are the BHV_AvdColregsV22 parameters of the avdcol_ block in
  // alpha.bhv; iWebSocket pushes them into the behaviour through its updates
  // variable (CONTACT_INFO) and widens the contact manager's alert range to
  // match, so the envelope can be trimmed on the water without editing the
  // .bhv and relaunching the mission.
  //
  // `applied` is what the backend reports is actually in force - everything
  // above it is only what the operator asked for until that echo arrives.
  public colavDist = {
    outer: 300,        // pwt_outer_dist
    inner: 150,        // pwt_inner_dist
    completed: 1500,   // completed_dist
    minCpa: 100,       // min_util_cpa_dist
    maxCpa: 300,       // max_util_cpa_dist
    applied: null as {
      outer: number;
      inner: number;
      completed: number;
      minCpa: number;
      maxCpa: number;
    } | null
  };

  // Rendered as two cards: the range envelope the behaviour engages in, and
  // the CPA band it grades an avoidance by. Each row is one BHV_AvdColregsV22
  // parameter - outer/inner/completed are pwt_outer_dist, pwt_inner_dist and
  // completed_dist; the CPA pair is min_util_cpa_dist / max_util_cpa_dist.
  protected readonly colavDistSpecs: Array<{
    key: 'outer' | 'inner' | 'completed' | 'minCpa' | 'maxCpa';
    group: 'envelope' | 'cpa';
    label: string;
    min: number;
    max: number;
    step: number;
  }> = [
      { key: 'outer', group: 'envelope', label: 'Engage at', min: 50, max: 1500, step: 10 },
      { key: 'inner', group: 'envelope', label: 'Full priority at', min: 20, max: 1500, step: 10 },
      { key: 'completed', group: 'envelope', label: 'Drop contact at', min: 100, max: 3000, step: 50 },
      { key: 'minCpa', group: 'cpa', label: 'Collision CPA', min: 5, max: 500, step: 5 },
      { key: 'maxCpa', group: 'cpa', label: 'All-clear CPA', min: 10, max: 1000, step: 10 }
    ];

  // The two cards above, in render order
  protected readonly colavDistGroups: Array<{
    id: 'envelope' | 'cpa';
    title: string;
    output: string;
  }> = [
      { id: 'envelope', title: 'Engagement envelope', output: 'range to contact' },
      { id: 'cpa', title: 'CPA band', output: 'closest point of approach' }
    ];

  // What alpha.bhv configures avdcol_ with - used by Reset
  private readonly colavDistDefaults = {
    outer: 300,
    inner: 150,
    completed: 1500,
    minCpa: 100,
    maxCpa: 300
  };

  // A slider drag emits continuously; only the settled set needs sending
  private colavDistSendTimer: any = null;

  // same debounce for the AIS contact cap, and the same mute window - the
  // backend's report is adopted, so it must not fight the operator's hand
  private aisLimitSendTimer: any = null;
  private aisLimitMuteUntil = 0;

  // Ignore the backend echo until this time: a round trip is slower than a
  // slider drag, and adopting a stale echo would fight the operator's hand.
  private colavDistMuteUntil = 0;

  // Slider bounds per gain: Ki needs a far finer range than Kp/Kd
  protected readonly pidGainSpecs: {
    [loop: string]: Array<{
      key: 'kp' | 'ki' | 'kd';
      label: string;
      min: number;
      max: number;
      step: number;
    }>;
  } = {
      heading: [
        { key: 'kp', label: 'Kp', min: 0, max: 2, step: 0.01 },
        { key: 'ki', label: 'Ki', min: 0, max: 0.2, step: 0.001 },
        { key: 'kd', label: 'Kd', min: 0, max: 2, step: 0.01 }
      ],
      speed: [
        { key: 'kp', label: 'Kp', min: 0, max: 2, step: 0.01 },
        { key: 'ki', label: 'Ki', min: 0, max: 0.05, step: 0.001 },
        { key: 'kd', label: 'Kd', min: 0, max: 1, step: 0.01 }
      ]
    };

  // The two loops planchaPID runs, rendered as one panel each
  protected readonly pidLoops: Array<{
    id: 'heading' | 'speed';
    title: string;
    output: string;
  }> = [
      { id: 'heading', title: 'Heading PID', output: 'rudder' },
      { id: 'speed', title: 'Speed PID', output: 'thrust' }
    ];

  // Values planchaPID starts with (mission .moos config) - used by Reset
  private readonly pidGainDefaults = {
    heading: { kp: 0.15, ki: 0, kd: 0.26 },
    speed: { kp: 0.16, ki: 0.003, kd: 0 }
  };

  // Per-gain send timers, so dragging a slider does not flood the websocket
  private pidSendTimers: { [key: string]: any } = {};

  // Station Keep control data
  public stationKeep = {
    innerRadius: 10,      // Inner radius in meters (1-100)
    outerRadius: 25,      // Outer radius in meters (inner+1 to 200)
    speed: 5,             // Speed to go to station in knots (0.5-25)
    status: 'standby',    // standby, active
    position: null        // Station keep position [lat, lon]
  };

  public hideStationKeepCircles = false;

  // Active waypoint station keep tracking
  public activeWaypointStationKeep = {
    active: false,
    innerRadius: 0,
    outerRadius: 0,
    timeToKeep: 0,
    timeRemaining: 0,
    position: null as [number, number] | null,
    timer: null as any
  };

  // Timer for updating Total TOA periodically
  private toaUpdateTimer: any = null;

  // Available routes for autonomous control
  public availableRoutes: [string, any, boolean][] = [];

  // Available regions for autonomous control
  public availableRegions: [string, any, boolean][] = [];

  // MOOS contact cleanup timer
  private moosContactCleanupTimer: any = null;
  private readonly MOOS_CONTACT_TIMEOUT = 5000; // 5 seconds

  // Engine status data from MOOS-IvP (ENGINE_*)
  public engineStatus = initEngineStatus();

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

  // ===== ENC autonomy planner state (ported from usv01 dev boat) =====
  // Station-keep hold telemetry (DIST_TO_STATION / STATIONING).
  public skHold = {
    holding: false,
    distToStation: null as number | null,
    holdElapsed: 0
  };
  private skHoldTimer: any = null;
  // Operating region (OpRegion) selection/activation.
  public operatingRegion = { selectedId: '', activeId: '' };
  // Route-relative safe corridor (CORRIDOR_STATUS / XTE_NOW driven).
  public corridor = {
    active: false,
    status: 'none' as 'none' | 'slow' | 'stop' | 'recovering',
    xte: null as number | null
  };
  // Boat held in comms-loss failsafe — needs explicit operator re-arm.
  protected awaitingRearm = false;
  private corridorAlertTimer: any = null;
  private corridorAlerted = false;
  // ENC safe navigable water rings + coverage hull (from loadSafeWater()).
  private safeWaterRings: number[][][] = [];
  private encCoverageHull: number[][] = [];
  // Global planner settings.
  protected planningRoute = false;
  protected plannerAlgorithm: 'theta' | 'astar' = 'theta';
  protected planClearanceM = 20;
  protected corridorWidthM = 60;
  protected planCentreBias = true;
  // Route report for the Plan phase.
  protected planReport: {
    distanceNm: number;
    turns: number;
    minClearanceM: number | null;
    outside: boolean;
  } | null = null;
  // Geofence/region status frames.
  public regionWarning = {
    status: 'ok' as 'ok' | 'route_outside',
    count: 0,
    total: 0
  };
  public regionBreach = { active: false };
  private regionWarnAudio: HTMLAudioElement | null = null;

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
    private moosWsService: MoosIvpWebsocketService,
    private routePlanner: RoutePlannerService,
    protected replay: ReplayService,
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

    // Watch for route changes and update availableRoutes when autonomous control panel is open
    effect(() => {
      const routes = this.skres.routes();
      if (this.display.autonomousControlPanelOpen && routes) {
        // Routes have changed, reload list from server (without sync to avoid loops)
        this.refreshAvailableRoutes();
      }
    });

    // Watch for region changes and update availableRegions when autonomous control panel is open
    effect(() => {
      const regions = this.skres.regions();
      if (this.display.autonomousControlPanelOpen && regions) {
        this.refreshAvailableRegions();
      }
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

    // ** ensure control buttons start deactivated **
    this.app.config.selections.remoteControl = false;
    this.app.config.selections.autonomousControl = false;

    // ** restore last calibrated PID gains (service mode)
    this.loadPidSettings();
    this.loadColavSettings();
    this.loadColavDistSettings();
    this.loadAisLimitSettings();
    this.showAisRing();
    this.aisFollow.range = this.app.config.selections.aisFollowRange ?? 100;
    this.aisFollow.angle = this.app.config.selections.aisFollowAngle ?? 180;

    // ** Start MOOS contact cleanup timer
    this.startMoosContactCleanup();

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
    // ** MISSION REPLAY **
    // a backward seek cannot un-apply accumulated MOOS state, so wipe it and
    // let the drain rebuild it from the start of the recording
    this.obsList.push(
      this.replay.resetRequest$.subscribe(() => this.resetMoosState())
    );
    // Keep the clock live while paused or scrubbing, when no delta arrives to
    // drive the update branch of onMessage(). Same format, so they agree.
    this.obsList.push(
      this.replay.rendered$.subscribe(() => {
        const started = Date.parse(this.replay.loadedMeta()?.startedAt ?? '');
        if (!isNaN(started)) {
          this.display.playback.time = this.formatPlaybackClock(
            new Date(started + this.replay.vt())
          );
        }
      })
    );

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

    // ** Start TOA update timer - updates every 2 seconds when route is selected
    this.toaUpdateTimer = setInterval(() => {
      // Only update if a route is selected
      if (this.autonomousControl.selectedRoute) {
        const selectedRoute = this.availableRoutes.find(r => r[0] === this.autonomousControl.selectedRoute);
        if (selectedRoute && selectedRoute[1].feature && selectedRoute[1].feature.geometry && selectedRoute[1].feature.geometry.coordinates) {
          const waypoints = selectedRoute[1].feature.geometry.coordinates;
          this.calculateDynamicTOA(waypoints);
        }
      }
    }, 2000); // Update every 2 seconds

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
    this.stopMoosContactCleanup();
    this.clearTrimAckTimer();
    this.stopManualKeepalive();

    // Clean up TOA update timer
    if (this.toaUpdateTimer) {
      clearInterval(this.toaUpdateTimer);
      this.toaUpdateTimer = null;
    }

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
        this.display.stationKeepPanelOpen = false;
        // Sync sliders from backend values
        this.syncRemoteControlFromMOOS();
      } else {
        // Closing panel - deactivate remote control
        this.setManualControl(false);
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
      this.display.stationKeepPanelOpen = false;
      this.app.saveConfig();
      // Sync sliders from backend values
      this.syncRemoteControlFromMOOS();
      this.setManualControl(true);
      this.app.showMessage('Remote Control Activated', false, 3000);
    }
    this.focusMap();
  }

  protected setAutonomousPanelTab(
    tab: 'mission' | 'follow' | 'pid' | 'colav' | 'test'
  ) {
    this.autonomousPanelTab = tab;
  }

  /** A right-side (end) control panel is open — shifts the floating nav bar
      left so it stays centred over the visible map (matches usv01). */
  public get rightPanelOpen(): boolean {
    return (
      this.display.autonomousControlPanelOpen ||
      this.display.remoteControlPanelOpen ||
      this.display.stationKeepPanelOpen
    );
  }

  // ===== ENC autonomy console (usv01 look) — GUARDED =====
  // The planner / corridor / ENC-gating UI is present and styled like the dev
  // boat, but full route planning, corridor enforcement and region gating need
  // the dev runtime-config + MOOS/ENC backend, which is not yet ported. These
  // keep the console safe: they act where self-contained, otherwise they tell
  // the operator the backend is unavailable instead of doing nothing silently.

  /** An ENC / depth-reference chart is on screen (any non-base-raster chart). */
  protected encDepthReferenceShown(): boolean {
    const sel = (this.app.config?.selections?.charts as string[]) || [];
    const BASE = ['openstreetmap', 'openseamap'];
    return sel.some((id) => !BASE.includes(id));
  }

  protected safeWaterEnforced(): boolean {
    return this.encDepthReferenceShown() && this.safeWaterRings.length > 0;
  }

  protected depthReferencePosture(): 'ok' | 'no-enc' | 'no-data' {
    if (!this.encDepthReferenceShown()) return 'no-enc';
    if (this.safeWaterRings.length === 0) return 'no-data';
    return 'ok';
  }

  /** Plan Safe Route — needs ENC safe-water data (loaded by the ENC backend). */
  protected async planSafeRoute(): Promise<void> {
    if (!this.autonomousControl.selectedRoute) {
      this.app.showMessage('Select a route to plan', true, 3000);
      return;
    }
    this.app.showMessage(
      'Safe-route planning needs ENC safe-water data — the ENC autonomy backend is not yet available.',
      true,
      4500
    );
  }

  /** Send the route corridor — needs the MOOS corridor backend. */
  protected sendCorridor(): void {
    this.app.showMessage(
      'Route corridor needs the MOOS corridor backend (not configured on this boat).',
      true,
      4000
    );
  }

  protected clearCorridor(): void {
    this.corridor.active = false;
    this.corridor.status = 'none';
    this.corridor.xte = null;
  }

  protected corridorStatusText(): string {
    switch (this.corridor.status) {
      case 'slow':
        return 'In corridor — slowing';
      case 'stop':
        return 'At corridor edge — holding';
      case 'recovering':
        return 'Outside corridor — recovering';
      default:
        return 'In corridor';
    }
  }

  protected toggleRepeatRoute(): void {
    this.updateRepeatRoute(!this.autonomousControl.repeatRoute);
  }

  /** Quick CAN enable/disable from the left toolbar — emergency actuator cut.
      Mirrors the per-panel toggles but acts on the master CAN_SEND flag so it
      works regardless of which control panel is open. */
  protected toggleCanSend(): void {
    const next = !this.app.data.moosIvPServer.canSend;
    const canValue = next ? 'true' : 'false';
    this.autonomousControl.ignoreCanSendUpdates = true;
    setTimeout(() => {
      this.autonomousControl.ignoreCanSendUpdates = false;
    }, 3000);
    if (
      this.app.data.moosIvPServer.connected &&
      this.app.data.moosIvPServer.socket
    ) {
      this.app.data.moosIvPServer.socket.send(`CAN_SEND=${canValue}`);
      this.app.data.moosIvPServer.canSend = next;
      this.autonomousControl.canSend = next;
      this.app.showMessage(
        `CAN Messages ${next ? 'Enabled' : 'Disabled'}`,
        false,
        2000
      );
    } else {
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
    }
  }

  protected toggleAutonomousControl() {
    if (this.app.config.selections.autonomousControl) {
      // If already active, toggle the panel and deactivate if closing
      this.display.autonomousControlPanelOpen = !this.display.autonomousControlPanelOpen;

      if (this.display.autonomousControlPanelOpen) {
        // Opening panel - close other panels
        this.display.instrumentPanelOpen = false;
        this.display.remoteControlPanelOpen = false;
        this.display.stationKeepPanelOpen = false;
        this.autonomousPanelTab = 'mission';
        // Load routes and regions for the dropdowns (sync will be called after routes are loaded)
        this.loadAvailableRoutes();
        this.loadAvailableRegions();
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
      this.display.stationKeepPanelOpen = false;
      this.autonomousPanelTab = 'mission';
      this.app.saveConfig();
      // Load routes and regions for the dropdowns (sync will be called after routes are loaded)
      this.loadAvailableRoutes();
      this.loadAvailableRegions();
      this.app.showMessage('Autonomous Control Activated', false, 3000);
    }
    this.focusMap();
  }

  // Sync autonomous control status from MOOS-IvP STATUS variable
  private syncAutonomousStatusFromMOOS() {
    const status = this.app.data.moosIvPServer.ivpHelmState;
    if (status === 'DRIVE') {
      // Mission is running
      this.autonomousControl.status = 'active';
      console.log('[AUTONOMOUS CONTROL] STATUS is DRIVE - setting mission status to active');
    } else {
      // Mission is not running (PARK or unknown)
      this.autonomousControl.status = 'standby';
      console.log(`[AUTONOMOUS CONTROL] STATUS is ${status || 'unknown'} - setting mission status to standby`);
    }

    // Sync speed control from DESIRED_SPEED received from MOOS-IvP (just once when opening)
    const desiredSpeed = this.app.data.moosIvPServer.desiredSpeed;
    if (desiredSpeed !== undefined && desiredSpeed > 0) {
      this.autonomousControl.speed = Math.max(0, Math.min(50, desiredSpeed));
      console.log('[AUTONOMOUS CONTROL] Synced speed from MOOS-IvP DESIRED_SPEED:', this.autonomousControl.speed);
    }

    // Check if ID_ROUTE is available and select the corresponding route
    const routeId = this.app.data.moosIvPServer.idRoute;
    if (routeId) {
      console.log('[AUTONOMOUS CONTROL] ID_ROUTE received:', routeId);
      // Check if this route exists in available routes
      const routeExists = this.availableRoutes.some(r => r[0] === routeId);
      if (routeExists) {
        // Select the route (this will trigger the selectRoute method)
        this.selectRoute(routeId);
        console.log('[AUTONOMOUS CONTROL] Automatically selected route:', routeId);
      } else {
        console.warn('[AUTONOMOUS CONTROL] Route ID from MOOS-IvP not found in available routes:', routeId);
      }
    }

    // Restore base position from BASE_COORDS received from MOOS-IvP (just once when opening)
    const baseCoords = this.app.data.moosIvPServer.baseCoords;
    if (baseCoords) {
      console.log('[AUTONOMOUS CONTROL] BASE_COORDS received:', baseCoords);
      // Parse BASE_COORDS format: "lat,lon"
      const coords = baseCoords.split(',').map(c => parseFloat(c.trim()));
      if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
        // Convert from "lat,lon" to Position format [lon, lat]
        this.app.data.map.basePosition = [coords[1], coords[0]];
        console.log('[AUTONOMOUS CONTROL] Restored base position from MOOS-IvP:', this.app.data.map.basePosition);
      } else {
        console.warn('[AUTONOMOUS CONTROL] Invalid BASE_COORDS format:', baseCoords);
      }
    }

    // Sync CAN_SEND state from MOOS-IvP (just once when opening)
    const canSend = this.app.data.moosIvPServer.canSend;
    if (canSend !== undefined) {
      this.autonomousControl.canSend = canSend;
      console.log('[AUTONOMOUS CONTROL] Synced CAN_SEND from MOOS-IvP:', canSend);
    }
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

      // After routes are loaded, sync status and route selection from MOOS-IvP
      this.syncAutonomousStatusFromMOOS();
    } catch (error) {
      console.error('Failed to load routes:', error);
      this.availableRoutes = [];
      this.app.showMessage('Failed to load routes', true, 3000);
    }
  }

  // Refresh available routes list without sync side effects (used by the effect watcher)
  private async refreshAvailableRoutes() {
    try {
      const routes = await this.skres.listFromServer<[string, any, boolean]>('routes');
      this.availableRoutes = routes.filter((route: [string, any, boolean]) =>
        route[1] && route[1].feature && route[1].feature.geometry
      );
    } catch (error) {
      console.error('Failed to refresh routes:', error);
    }
  }

  // Load available regions for autonomous control
  private async loadAvailableRegions() {
    try {
      console.log('Starting to load regions...');
      const regions = await this.skres.listFromServer<[string, any, boolean]>('regions');
      console.log('Raw regions from server:', regions);
      this.availableRegions = regions.filter((region: [string, any, boolean]) =>
        region[1] && region[1].feature && region[1].feature.geometry
      );
      console.log('Filtered available regions:', this.availableRegions);
      console.log('Total regions loaded:', this.availableRegions.length);

      // Sync region selection from MOOS-IvP state
      if (this.app.data.moosIvPServer?.regionActive) {
        // If MOOS-IvP has an active region, try to find and select it
        const regions = this.skres.regions();
        if (regions && regions.length > 0) {
          const firstRegion = regions[0];
          this.autonomousControl.selectedRegion = firstRegion[0];
          console.log('[REGION] Synced active region from MOOS-IvP:', firstRegion[0]);
        }
      }
    } catch (error) {
      console.error('Failed to load regions:', error);
      this.availableRegions = [];
      this.app.showMessage('Failed to load regions', true, 3000);
    }
  }

  // Refresh available regions list without sync side effects (used by the effect watcher)
  private async refreshAvailableRegions() {
    try {
      const regions = await this.skres.listFromServer<[string, any, boolean]>('regions');
      this.availableRegions = regions.filter((region: [string, any, boolean]) =>
        region[1] && region[1].feature && region[1].feature.geometry
      );
    } catch (error) {
      console.error('Failed to refresh regions:', error);
    }
  }

  // Select a region from the dropdown (does NOT activate it immediately)
  protected selectRegion(regionId: string) {
    this.autonomousControl.selectedRegion = regionId;

    if (regionId) {
      const selectedRegion = this.availableRegions.find(r => r[0] === regionId);
      if (selectedRegion) {
        // Filter map to show only this region
        if (this.fbMapRef) {
          this.fbMapRef.filterRegionId = regionId;
        }
        console.log('[REGION] Region selected (not yet activated):', regionId, selectedRegion[1].name);
      }
    } else {
      // Deselect region - hide all regions and deactivate if active
      if (this.fbMapRef) {
        this.fbMapRef.filterRegionId = '__none__';
        this.fbMapRef.activeRegionId = null;
      }
      this.onRegionDeactivated();
      console.log('[REGION] Region deselected');
    }
  }

  // Get region name by ID for display
  public getSelectedRegionName(): string {
    if (!this.autonomousControl.selectedRegion) {
      return 'None';
    }

    const region = this.availableRegions.find(r => r[0] === this.autonomousControl.selectedRegion);
    return region ? (region[1].name || 'Region ' + region[0]) : this.autonomousControl.selectedRegion;
  }

  // Handle STATUS changes from MOOS-IvP in real-time
  private handleStatusChange(status: string) {
    if (!status) return;

    const upperStatus = status.toUpperCase();

    // Track status transitions
    const previousStatus = this.autonomousControl.lastStatus;
    this.autonomousControl.lastStatus = upperStatus;

    // If ignoring status updates, only process DRIVE→PARK transition
    if (this.autonomousControl.ignoreStatusUpdates) {
      if (previousStatus === 'DRIVE' && upperStatus === 'PARK') {
        console.log('[STATUS CHANGE] DRIVE→PARK transition detected - Resuming STATUS monitoring');
        this.autonomousControl.ignoreStatusUpdates = false;
        // Process the PARK status normally below
      } else {
        // Ignore this status change
        return;
      }
    }

    if (upperStatus === 'PARK') {
      // Mission is complete - reset to standby and clear metrics
      if (this.autonomousControl.status !== 'standby') {
        console.log('[STATUS CHANGE] PARK detected - Mission complete, resetting to standby');
        this.autonomousControl.status = 'standby';
        this.autonomousControl.currentWaypoint = 0;
        this.autonomousControl.progress = 0;
        this.autonomousControl.totalDistance = 0;
        this.autonomousControl.totalTimeOfArrival = 0;
      }
    } else if (upperStatus === 'DRIVE') {
      // Mission is running
      if (this.autonomousControl.status === 'standby') {
        console.log('[STATUS CHANGE] DRIVE detected - Mission is running');
        this.autonomousControl.status = 'active';
      }
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

  protected toggleEngineStatus() {
    this.app.data.showEngineStatus = !this.app.data.showEngineStatus;
    this.focusMap();
  }

  /** Route-tracking calibration card (pRouteTuner operator controls). */
  protected toggleCalibration() {
    this.app.data.showCalibration = !this.app.data.showCalibration;
    this.focusMap();
  }

  // Remote control methods
  protected updateRudder(value: number) {
    this.remoteControl.rudder = Math.max(-50, Math.min(50, value));
    this.sendRudderData();
  }

  protected updateThrust(value: number) {
    this.remoteControl.thrust = Math.max(0, Math.min(100, value));
    this.sendThrustData();
  }

  /**
   * One DESIRED_GEAR=1|0|-1 per click. The boat resets its thrust to 0 on
   * every gear change, so the slider goes to 0 too (nothing is sent for it):
   * the operator applies throttle again after the shift.
   */
  protected updateGear(gear: 'forward' | 'neutral' | 'reverse') {
    const code = gear === 'forward' ? 1 : gear === 'reverse' ? -1 : 0;
    // Keep the model in step with the toggle the operator just pressed;
    // the "Boat:" readout shows whether the boat actually followed.
    this.remoteControl.gear = gear;
    this.remoteControl.thrust = 0;
    if (!this.sendMoos(`DESIRED_GEAR=${code}`)) {
      this.app.showMessage('MOOS-IvP not connected, gear not sent', true, 2000);
    }
  }

  /**
   * Manual control on/off. CONTROLE_MANUAL=true makes the SS UI the drive
   * owner in iCAN (gear from DESIRED_GEAR, lost-link failsafe armed) and the
   * boat starts in neutral at 0 thrust. CONTROLE_MANUAL=false hands the drive
   * back to the helm: iWebSocket zeroes rudder and thrust, and any mode flag
   * still set on the boat (WAYPOINT, TRAILING, REGION) resumes.
   */
  private setManualControl(on: boolean) {
    if (on) {
      this.resetManualGearAndThrust();
      if (!this.sendMoos('CONTROLE_MANUAL=true')) {
        this.app.showMessage('MOOS-IvP not connected, manual control not switched on', true, 3000);
      }
      this.startManualKeepalive();
    } else {
      this.stopManualKeepalive();
      this.sendMoos('CONTROLE_MANUAL=false');
    }
  }

  /** What the boat does on entering manual or after a lost link. */
  private resetManualGearAndThrust() {
    this.remoteControl.gear = 'neutral';
    this.remoteControl.thrust = 0;
  }

  private startManualKeepalive() {
    this.stopManualKeepalive();
    this.manualKeepaliveTimer = setInterval(
      () => this.sendMoos(`HEARTBEAT_PING=${Date.now()}`),
      1000
    );
  }

  private stopManualKeepalive() {
    if (this.manualKeepaliveTimer) {
      clearInterval(this.manualKeepaliveTimer);
      this.manualKeepaliveTimer = null;
    }
  }

  private sendRudderData() {
    // Send only rudder data to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      // Convert rudder angle from UI range (-50 to +50) to MOOS-IvP range (-100 to +100)
      const desiredRudder = this.remoteControl.rudder * 2;
      this.app.data.moosIvPServer.socket.send(`DESIRED_RUDDER=${desiredRudder}`);
      console.log(`Sent DESIRED_RUDDER=${desiredRudder} to MOOS-IvP (UI rudder: ${this.remoteControl.rudder})`);
    } else {
      console.log('MOOS-IvP not connected, cannot send rudder data');
    }
  }

  private sendThrustData() {
    // Throttle only (0..100): in manual control the gear comes from
    // DESIRED_GEAR. Thrust in neutral is ignored by the boat.
    if (!this.sendMoos(`DESIRED_THRUST=${this.remoteControl.thrust}`)) {
      console.log('MOOS-IvP not connected, cannot send thrust data');
    }
  }

  private sendRemoteControlData() {
    // Send other remote control data to MOOS-IvP (for gear, etc.)
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      console.log('MOOS-IvP not connected, cannot send remote control data:', this.remoteControl);
    } else {
      console.log('MOOS-IvP not connected, cannot send remote control data:', this.remoteControl);
    }
  }

  /** Sync remote control sliders from backend DESIRED_RUDDER/DESIRED_THRUST values (one-time on panel open) */
  private syncRemoteControlFromMOOS() {
    // Do not sync sliders when STATUS is DRIVE (autonomous control is active)
    const status = this.app.data.moosIvPServer?.ivpHelmState;
    if (status && status.toUpperCase() === 'DRIVE') {
      console.log('[Remote Control] STATUS is DRIVE - skipping slider sync from MOOS-IvP');
      return;
    }

    // Sync rudder: MOOS range (-100..100) → UI range (-50..50)
    const desiredRudder = this.app.data.moosIvPServer?.desiredRudder;
    if (desiredRudder !== undefined) {
      this.remoteControl.rudder = Math.max(-50, Math.min(50, desiredRudder / 2));
      console.log('[Remote Control] Synced rudder from MOOS-IvP:', desiredRudder, '→ UI:', this.remoteControl.rudder);
    }
    // Gear and thrust are not synced: the boat starts manual control in
    // neutral at 0 thrust, and the UI keeps the operator's own selection.
  }

  /**
   * Send one trim command: 1 = one trim-up pulse, -1 = one trim-down pulse,
   * 0 = stop. Exactly one message per click — never repeat or hold: trim-up
   * runs on into full tilt and trim-down onto the bottom stop, so the boat's
   * pulse limit is the only safety and the UI must not extend it.
   */
  protected sendTrim(dir: 1 | -1 | 0) {
    if (!this.app.data.moosIvPServer.canSend) {
      return;
    }
    this.clearTrimAckTimer();
    if (!this.sendMoos(`TRIM=${dir}`)) {
      this.app.showMessage('Trim not sent: MOOS-IvP not connected', false, 2000);
      return;
    }
    if (dir !== 0) {
      // No retry: if the boat never reports the pulse, just say so.
      this.trimAckTimer = setTimeout(() => {
        this.trimAckTimer = null;
        this.app.showMessage(
          'Trim not available on this boat or blocked by the helm.',
          false,
          3000
        );
      }, AppComponent.TRIM_ACK_MS);
    }
  }

  private clearTrimAckTimer() {
    if (this.trimAckTimer) {
      clearTimeout(this.trimAckTimer);
      this.trimAckTimer = null;
    }
  }

  /** CAN_TX_GEAR from iCAN: "fwd" | "neutral" | "rev" (what is really sent) */
  private updateBoatGear(value: unknown) {
    const g = String(value).trim().toLowerCase();
    this.remoteControl.boatGear =
      g === 'fwd' ? 'forward' : g === 'rev' ? 'reverse' : g === 'neutral' ? 'neutral' : null;
  }

  /** CAN_TX_THRUST_PCT from iCAN, negative in reverse; shown as a magnitude */
  private updateBoatThrust(value: unknown) {
    const t = Number(value);
    this.remoteControl.boatThrust = Number.isFinite(t) ? Math.abs(t) : null;
  }

  /** CAN_TRIM_STATE from iCAN: "up" | "down" | "idle" */
  private updateTrimState(value: unknown) {
    const state = String(value).trim().toLowerCase();
    this.trimControl.state =
      state === 'up' || state === 'down' ? state : 'idle';
    if (this.trimControl.state !== 'idle') {
      this.clearTrimAckTimer();
    }
  }

  protected closeRemoteControl() {
    this.clearTrimAckTimer();
    this.setManualControl(false);
    this.display.remoteControlPanelOpen = false;
    this.app.config.selections.remoteControl = false;
    this.app.saveConfig();
    this.app.showMessage('Remote Control Deactivated', false, 3000);
    this.focusMap();
  }

  // Autonomous control methods
  protected selectRoute(routeId: string) {
    // Hide all currently visible routes when autonomous control selects a route
    this.skres.routeRemove();

    // Stop any existing waypoint send timer
    if (this.autonomousControl.waypointSendTimer) {
      clearInterval(this.autonomousControl.waypointSendTimer);
      this.autonomousControl.waypointSendTimer = null;
      console.log('[WAYPOINT SENDER] Stopped previous timer');
    }

    this.autonomousControl.selectedRoute = routeId;
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;

    // Add only the newly selected route to map display
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

          // Calculate total route distance (fixed) and initial TOA
          this.calculateTotalRouteDistance(waypoints);
          this.calculateDynamicTOA(waypoints);

          // Send waypoints immediately
          this.sendWaypointsToMOOS(waypoints);

          // Start timer to send waypoints repeatedly every 2 seconds until MODE is 'clear'
          console.log('[WAYPOINT SENDER] Starting timer to send waypoints every 2 seconds until MODE is clear');
          this.autonomousControl.waypointSendTimer = setInterval(() => {
            // Check if MODE is 'clear'
            const currentMode = this.app.data.moosIvPServer.ivpHelmAllstop?.toLowerCase();
            console.log('[WAYPOINT SENDER] Current MODE:', currentMode);

            if (currentMode === 'clear') {
              // Stop sending waypoints
              console.log('[WAYPOINT SENDER] MODE is clear, stopping waypoint transmission');
              if (this.autonomousControl.waypointSendTimer) {
                clearInterval(this.autonomousControl.waypointSendTimer);
                this.autonomousControl.waypointSendTimer = null;
              }
            } else {
              // Continue sending waypoints
              console.log('[WAYPOINT SENDER] Sending waypoints (MODE not clear yet)');
              this.sendWaypointsToMOOS(waypoints);
            }
          }, 2000); // Send every 2 seconds
        }
      }
    } else {
      console.log('Route deselected');
    }
  }

  protected updateSpeed(speed: number) {
    this.autonomousControl.speed = Math.max(0, Math.min(50, speed));

    // Send speed to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send(`DESIRED_SPEED=${this.autonomousControl.speed}`);
      console.log(`Sent DESIRED_SPEED=${this.autonomousControl.speed} to MOOS-IvP`);
    }

    // Recalculate total time of arrival if we have a route selected (distance stays the same)
    if (this.autonomousControl.selectedRoute) {
      const selectedRoute = this.availableRoutes.find(r => r[0] === this.autonomousControl.selectedRoute);
      if (selectedRoute && selectedRoute[1].feature && selectedRoute[1].feature.geometry && selectedRoute[1].feature.geometry.coordinates) {
        const waypoints = selectedRoute[1].feature.geometry.coordinates;
        this.calculateDynamicTOA(waypoints);
      }
    }

    console.log('Speed updated:', this.autonomousControl.speed);
  }

  protected updateRepeatRoute(repeat: boolean) {
    this.autonomousControl.repeatRoute = repeat;

    // Send repeat count to MOOS-IvP: 1000 for continuous, 1 for single run
    const repeatValue = repeat ? 1000 : 1;
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send(`REPEAT=${repeatValue}`);
      console.log(`Sent REPEAT=${repeatValue} to MOOS-IvP (continuous: ${repeat})`);
    }

    console.log('Repeat route updated:', repeat ? 'continuous (1000x)' : 'once');
  }

  // CAN messages toggle for autonomous control
  protected toggleCanSendAutonomous() {
    this.autonomousControl.canSend = !this.autonomousControl.canSend;
    const canValue = this.autonomousControl.canSend ? 'true' : 'false';

    // Ignore incoming CAN_SEND updates for 3 seconds to avoid race conditions
    this.autonomousControl.ignoreCanSendUpdates = true;
    setTimeout(() => {
      this.autonomousControl.ignoreCanSendUpdates = false;
    }, 3000);

    // Send CAN_SEND to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send(`CAN_SEND=${canValue}`);
      console.log(`[Autonomous Control] Sent CAN_SEND=${canValue} to MOOS-IvP`);
      this.app.showMessage(`CAN Messages ${this.autonomousControl.canSend ? 'Enabled' : 'Disabled'}`, false, 2000);
    } else {
      console.log('MOOS-IvP not connected, cannot send CAN_SEND value');
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
    }
  }

  // ***************** SERVICE MODE (PID CALIBRATION) ******************

  /** send a KEY=value message to MOOS-IvP, returns false if not connected */
  /**
   * Single choke point for everything we transmit to MOOS-IvP.
   * Hard-blocked during replay: replayed WPT_INDEX changes reach
   * handleWaypointReached() -> startWaypointStationKeep(), which would otherwise
   * send real station-keep commands to the live vehicle.
   */
  private sendMoos(message: string): boolean {
    if (this.replay.isReplaying()) {
      this.app.debug(`[REPLAY] suppressed outbound MOOS: ${message}`);
      return false;
    }
    if (!this.app.data.moosIvPServer.connected || !this.app.data.moosIvPServer.socket) {
      return false;
    }
    this.app.data.moosIvPServer.socket.send(message);
    return true;
  }

  /**
   * Toggle service mode. While active planchaPID applies the Kp/Ki/Kd set here
   * instead of its built-in gain schedule, so the boat can be calibrated from
   * the UI without changing values in the backend.
   */
  protected toggleServiceMode(enabled: boolean) {
    this.servicePid.enabled = enabled;

    // ignore the SERVICE_MODE echo for a moment so the switch does not flick
    // back before the backend has caught up
    this.servicePid.ignoreModeUpdates = true;
    setTimeout(() => {
      this.servicePid.ignoreModeUpdates = false;
    }, 3000);

    if (!this.sendMoos(`SERVICE_MODE=${enabled ? 'true' : 'false'}`)) {
      console.log('MOOS-IvP not connected, cannot send SERVICE_MODE');
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
      return;
    }
    console.log(`[SERVICE MODE] Sent SERVICE_MODE=${enabled} to MOOS-IvP`);
    this.servicePid.pendingConfirm = true;

    if (enabled) {
      // push the displayed gains so the controller starts from what is shown
      this.sendAllPidGains();
      this.app.showMessage('Service mode ON - PID gains now come from the UI', false, 4000);
    } else {
      this.app.showMessage('Service mode OFF - gain scheduling restored', false, 3000);
    }

    this.savePidSettings();
  }

  /** update a gain from the slider/input and schedule the send to MOOS-IvP */
  protected updatePidGain(
    loop: 'heading' | 'speed',
    key: 'kp' | 'ki' | 'kd',
    value: number | string
  ) {
    const spec = this.pidGainSpecs[loop].find((s) => s.key === key);
    if (!spec) {
      return;
    }
    const parsed = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(parsed)) {
      return;
    }
    this.servicePid[loop][key] = Math.max(spec.min, Math.min(spec.max, parsed));

    // a slider drag emits continuously - only the settled value needs sending
    const timerKey = `${loop}.${key}`;
    clearTimeout(this.pidSendTimers[timerKey]);
    this.pidSendTimers[timerKey] = setTimeout(() => {
      this.sendPidGain(loop, key);
      this.savePidSettings();
    }, 150);
  }

  /** typed gain entry: clamps the value and reflects the clamp back in the field */
  protected onPidGainInput(
    loop: 'heading' | 'speed',
    key: 'kp' | 'ki' | 'kd',
    event: Event
  ) {
    const input = event.target as HTMLInputElement;
    this.updatePidGain(loop, key, input.value);
    input.value = String(this.servicePid[loop][key]);
  }

  /** step a gain by one increment (+/- buttons) */
  protected nudgePidGain(
    loop: 'heading' | 'speed',
    key: 'kp' | 'ki' | 'kd',
    direction: number
  ) {
    const spec = this.pidGainSpecs[loop].find((s) => s.key === key);
    if (!spec) {
      return;
    }
    // steps are fractional (0.001) so round away binary float noise
    const stepped = this.servicePid[loop][key] + direction * spec.step;
    this.updatePidGain(loop, key, Math.round(stepped * 1000) / 1000);
  }

  /** send a single gain to MOOS-IvP (HEADING_KP, SPEED_KI, ...) */
  private sendPidGain(loop: 'heading' | 'speed', key: 'kp' | 'ki' | 'kd') {
    const variable = `${loop.toUpperCase()}_${key.toUpperCase()}`;
    const value = this.servicePid[loop][key];
    if (this.sendMoos(`${variable}=${value}`)) {
      console.log(`[SERVICE MODE] Sent ${variable}=${value} to MOOS-IvP`);
    } else {
      console.log(`MOOS-IvP not connected, cannot send ${variable}`);
    }
  }

  /** push every gain to MOOS-IvP (on enabling service mode / manual re-send) */
  protected sendAllPidGains() {
    if (!this.app.data.moosIvPServer.connected) {
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
      return;
    }
    (['heading', 'speed'] as const).forEach((loop) => {
      this.pidGainSpecs[loop].forEach((spec) => this.sendPidGain(loop, spec.key));
    });
  }

  /** restore the gains planchaPID starts with and push them */
  protected resetPidGains() {
    this.servicePid.heading = { ...this.pidGainDefaults.heading };
    this.servicePid.speed = { ...this.pidGainDefaults.speed };
    if (this.servicePid.enabled) {
      this.sendAllPidGains();
    }
    this.savePidSettings();
    this.app.showMessage('PID gains reset to defaults', false, 2000);
  }

  /** gain currently applied by planchaPID, '--' until it reports */
  protected appliedPidGain(loop: 'heading' | 'speed', key: 'kp' | 'ki' | 'kd'): string {
    const applied = this.servicePid.applied;
    return applied ? applied[loop][key].toFixed(3) : '--';
  }

  /** right-click > Follow on an AIS target */
  protected followAisContact(vessel: SKVessel) {
    if (!vessel) {
      return;
    }
    // The MMSI is the only identity MOOS needs: pTrafficSim names its
    // NODE_REPORTs AIS<mmsi>, so no name lookup is involved on either side.
    const mmsi = vessel.mmsi || (vessel.id ?? '').split(':').pop();
    if (!mmsi) {
      this.app.showMessage('Contact has no MMSI - cannot follow.', false, 4000);
      return;
    }
    this.aisFollow.mmsi = mmsi;
    this.aisFollow.name = vessel.name || mmsi;
    this.sendFollowUpdate();
    this.app.showMessage(`Following ${this.aisFollow.name}...`, false, 3000);
  }

  /** distance to hold from the contact */
  protected updateFollowRange(range: number) {
    this.aisFollow.range = Math.max(20, Math.min(1000, Number(range)));
    this.app.config.selections.aisFollowRange = this.aisFollow.range;
    this.app.saveConfig();
    if (this.aisFollow.mmsi) {
      this.sendFollowUpdate();
    }
  }

  /** bearing to hold, relative to the contact's heading */
  protected updateFollowAngle(angle: number) {
    this.aisFollow.angle = Math.max(0, Math.min(359, Number(angle)));
    this.app.config.selections.aisFollowAngle = this.aisFollow.angle;
    this.app.saveConfig();
    if (this.aisFollow.mmsi) {
      this.sendFollowUpdate();
    }
  }

  /** release the helm */
  protected stopFollowAis() {
    this.sendMoos('TRAIL_FOLLOW=off');
    this.aisFollow.mmsi = '';
    this.aisFollow.name = '';
    // `active` is left to TRAILING - the helm decides when it has let go.
  }

  private sendFollowUpdate() {
    this.sendMoos(
      `TRAIL_FOLLOW=mmsi=${this.aisFollow.mmsi}` +
        `#range=${this.aisFollow.range}` +
        `#angle=${this.aisFollow.angle}`
    );
  }

  // ***************** COLLISION AVOIDANCE TEST ******************

  /**
   * Turn the test on or off.
   *
   * Off also clears any targets still out there: leaving simulated AIS traffic
   * running after the panel is closed is how a test target ends up being read
   * as real traffic. iWebSocket does the same on its side, so a UI that dies
   * mid-test does not strand contacts either.
   */
  protected toggleColavTest(enabled: boolean) {
    this.colavTest.enabled = enabled;
    this.colavTest.lastError = '';

    // Ignore the echo briefly so the switch does not flick back before
    // pColavEval has answered.
    this.colavTest.ignoreModeUpdates = true;
    setTimeout(() => {
      this.colavTest.ignoreModeUpdates = false;
    }, 3000);

    if (!this.sendMoos(`COLAV_TEST=${enabled ? 'true' : 'false'}`)) {
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
      this.colavTest.enabled = false;
      return;
    }
    this.colavTest.pendingConfirm = true;

    if (enabled) {
      this.app.showMessage(
        'Collision Avoidance Test ON - right-click the chart to put a target',
        false, 4000
      );
    } else {
      this.colavTest.targets = [];
      this.app.showMessage('Collision Avoidance Test OFF - targets cleared', false, 3000);
    }
  }

  /** persist the target parameters so a reload keeps the operator's setup */
  private saveColavSettings() {
    this.app.config.selections.colavTarget = {
      speed: this.colavTest.speed,
      courseMode: this.colavTest.courseMode,
      course: this.colavTest.course,
      vesselType: this.colavTest.vesselType,
      length: this.colavTest.length,
      beam: this.colavTest.beam
    };
    this.app.saveConfig();
  }

  private loadColavSettings() {
    const saved = this.app.config.selections.colavTarget;
    if (!saved) {
      return;
    }
    this.colavTest.speed = saved.speed ?? 5;
    this.colavTest.courseMode = saved.courseMode ?? 'at_usv';
    this.colavTest.course = saved.course ?? 218.7;
    this.colavTest.vesselType = saved.vesselType ?? 'cargo';
    this.colavTest.length = saved.length ?? 25;
    this.colavTest.beam = saved.beam ?? 9;
  }

  protected updateColavParam(key: 'speed' | 'course' | 'length' | 'beam', value: number | string) {
    const parsed = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(parsed)) {
      return;
    }
    if (key === 'speed')       this.colavTest.speed  = Math.max(0, Math.min(30, parsed));
    else if (key === 'course') this.colavTest.course = ((parsed % 360) + 360) % 360;
    else if (key === 'length') this.colavTest.length = Math.max(3, Math.min(400, parsed));
    else                       this.colavTest.beam   = Math.max(1, Math.min(80, parsed));
    this.saveColavSettings();
  }

  protected setColavCourseMode(mode: 'at_usv' | 'fixed') {
    this.colavTest.courseMode = mode;
    this.saveColavSettings();
  }

  protected setColavVesselType(type: string) {
    this.colavTest.vesselType = type;
    this.saveColavSettings();
  }

  /**
   * right-click > Put Target. The position comes from the map component, which
   * stashes it before emitting - the same handshake Station Keep uses.
   *
   * The course is sent as an intent ('at_usv') rather than a computed bearing:
   * pTrafficSim knows where the boat is at the instant it creates the contact,
   * and a heading worked out a websocket round trip earlier would be stale.
   */
  protected putColavTarget(pos: Position) {
    if (!pos) {
      return;
    }
    if (!this.colavTest.enabled) {
      return;
    }

    // avdcol_ carries condition = WAYPOINT = true, so with no mission running
    // the behaviour stays idle and nothing is measured. Say so rather than
    // letting the operator conclude the avoidance system is broken.
    if (!this.autonomousControl.waypointActive) {
      this.app.showMessage(
        'Start a route first - collision avoidance only runs during a mission.',
        true, 5000
      );
      return;
    }

    const course = this.colavTest.courseMode === 'at_usv'
      ? 'at_usv'
      : String(this.colavTest.course);

    const sent = this.sendMoos(
      `PUT_TARGET=lat=${pos[1].toFixed(6)}` +
      `#lon=${pos[0].toFixed(6)}` +
      `#course=${course}` +
      `#speed=${this.colavTest.speed}` +
      `#type=${this.colavTest.vesselType}` +
      `#length=${this.colavTest.length}` +
      `#beam=${this.colavTest.beam}`
    );
    if (!sent) {
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
      return;
    }
    // The target reaches the chart the long way round - AIVDM to Signal K and
    // back as an AIS vessel - so acknowledge the click straight away.
    this.app.showMessage('Target placed, waiting for AIS...', false, 2500);
  }

  /** remove every target this test placed */
  protected clearColavTargets() {
    if (!this.sendMoos('CLEAR_TARGETS=all')) {
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
      return;
    }
    this.colavTest.targets = [];
    this.app.showMessage('Targets cleared', false, 2000);
  }

  /** COLAV_METRICS is a JSON array; a malformed one must not kill the panel */
  private processColavMetrics(raw: string) {
    if (!raw) {
      this.colavTest.encounters = [];
      this.app.data.moosIvPServer.colregs = null;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      this.colavTest.encounters = Array.isArray(parsed) ? parsed : [];
      this.colregsSeenAt = Date.now();
      this.updateColregsStatus();
    } catch (e) {
      console.warn('[COLAV] could not parse COLAV_METRICS', e);
    }
  }

  /**
   * The ack is the authority: pColavEval echoing COLAV_TEST is what proves an
   * evaluator is running. Without it the toggle would happily sit ON against
   * nothing and report no encounters, which looks like a broken behaviour.
   */
  private syncColavTest(ack: boolean) {
    if (this.colavTest.pendingConfirm && (ack !== this.colavTest.enabled)) {
      this.app.showMessage(
        'No collision avoidance evaluator responded - is pColavEval running?',
        true, 5000
      );
    }
    this.colavTest.pendingConfirm = false;
    if (!this.colavTest.ignoreModeUpdates) {
      this.colavTest.enabled = ack;
    }
  }



  // ****************** LIMIT AIS CONTACTS ******************

  // Range around the boat inside which the collision avoidance engages a
  // contact. Everything beyond it is held off by iWebSocket through
  // pContactMgrV20's disable variable. With a dozen vessels in the picture the
  // helm is solving all of them at once and no single manoeuvre can be read
  // off the chart - pulling the ring in is what makes an encounter watchable.
  //
  // The same ring is drawn around the boat on the chart, so what is in play is
  // visible rather than inferred.
  //
  // `tracked` / `engaged` / `held` / `next` come back from the backend, which
  // is the only place that knows what is actually being heard.
  public aisLimit = {
    enabled: false,
    radius: 500,     // metres
    tracked: 0,
    engaged: 0,
    held: 0,
    next: -1,        // range of the nearest held contact, -1 when none
    waiting: false   // backend has no ownship position to range against
  };

  protected readonly aisLimitSpec = { min: 50, max: 3000, step: 50 };

  /** send the range, or 0 to let every contact through */
  protected sendAisLimit() {
    const value = this.aisLimit.enabled ? this.aisLimit.radius : 0;
    if (!this.sendMoos(`AIS_RADIUS=${value}`)) {
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
      return;
    }
    this.aisLimitMuteUntil = Date.now() + 3000;
    console.log(`[AIS LIMIT] sent AIS_RADIUS=${value}`);
  }

  protected toggleAisLimit(enabled: boolean) {
    this.aisLimit.enabled = enabled;
    this.showAisRing();
    this.sendAisLimit();
    this.saveAisLimitSettings();
    this.app.showMessage(
      enabled
        ? `Avoidance limited to contacts within ${this.aisLimit.radius} m`
        : 'Avoidance sees every contact again',
      false, 3000
    );
  }

  protected updateAisLimitMax(value: number | string) {
    const parsed = typeof value === 'string' ? parseInt(value, 10) : value;
    if (isNaN(parsed)) {
      return;
    }
    this.aisLimit.radius = Math.max(
      this.aisLimitSpec.min,
      Math.min(this.aisLimitSpec.max, Math.round(parsed))
    );
    this.showAisRing();

    clearTimeout(this.aisLimitSendTimer);
    this.aisLimitSendTimer = setTimeout(() => {
      if (this.aisLimit.enabled) {
        this.sendAisLimit();
      }
      this.saveAisLimitSettings();
    }, 250);
  }

  protected onAisLimitInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.updateAisLimitMax(input.value);
    input.value = String(this.aisLimit.radius);
  }

  protected nudgeAisLimit(direction: number) {
    this.updateAisLimitMax(this.aisLimit.radius + direction * this.aisLimitSpec.step);
  }

  /**
   * Put the ring on the chart straight away, without waiting for the backend
   * to echo it. The echo replaces this the moment it arrives, but a ring that
   * only appears once MOOS answers is a ring that silently does not appear at
   * all when the backend is older than the panel - which is exactly how this
   * looked the first time round.
   */
  private showAisRing() {
    this.app.data.moosIvPServer.aisRadius =
      this.aisLimit.enabled ? this.aisLimit.radius : 0;
  }

  private saveAisLimitSettings() {
    this.app.config.selections.aisLimit = {
      enabled: this.aisLimit.enabled,
      radius: this.aisLimit.radius
    };
    this.app.saveConfig();
  }

  private loadAisLimitSettings() {
    const saved = this.app.config.selections.aisLimit;
    if (!saved) {
      return;
    }
    this.aisLimit.enabled = !!saved.enabled;
    if (typeof saved.radius === 'number') {
      this.aisLimit.radius = saved.radius;
    }
  }

  /** AIS_RADIUS: what the backend reports it is actually holding off */
  private processAisLimit(raw: string) {
    if (!raw) {
      return;
    }
    const kv: { [k: string]: string } = {};
    String(raw).split(',').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) {
        kv[part.substring(0, i).trim()] = part.substring(i + 1).trim();
      }
    });
    if (kv['tracked'] === undefined) {
      return;
    }
    this.aisLimit.tracked = parseInt(kv['tracked'], 10) || 0;
    this.aisLimit.engaged = parseInt(kv['engaged'], 10) || 0;
    this.aisLimit.held = parseInt(kv['held'], 10) || 0;
    this.aisLimit.next = kv['next'] !== undefined ? parseFloat(kv['next']) : -1;
    this.aisLimit.waiting = kv['why'] === 'no_ownship_position';

    // The ring drawn on the chart is the one in force, not the one in the
    // panel: they differ for as long as a change is in flight, and the chart
    // must not claim a limit the helm is not applying yet.
    const radius = parseFloat(kv['radius']) || 0;
    this.app.data.moosIvPServer.aisRadius = radius;

    // The backend is the authority on what is actually in force. A panel
    // showing ON while nothing is being held off would be telling the
    // operator the avoidance is ignoring contacts when it is not - so the
    // switch follows the reported cap, not the stored preference.
    if (Date.now() < this.aisLimitMuteUntil) {
      return;
    }
    this.aisLimit.enabled = radius > 0;
    if (radius > 0) {
      this.aisLimit.radius = Math.round(radius);
    }
  }

  // ****************** COLREGS STATUS (chart box) ******************

  // The COLREGS mode BHV_AvdColregsV22 reports, as a rule the operator can
  // read off the chart. Rule numbers are the ones the behaviour itself cites
  // in its mode handlers: 13 overtaking, 14 head-on, 16 give-way, 17 stand-on.
  // "cpa" is the behaviour's unclassified fallback - it is avoiding on CPA
  // alone, with no COLREGS situation established, and saying so is more honest
  // than naming a rule it is not following.
  private readonly colregsRules: {
    [mode: string]: { rule: string; name: string; action: string; tone: 'act' | 'hold' | 'urgent' };
  } = {
      headon: { rule: 'Rule 14', name: 'Head-on', action: 'altering to starboard', tone: 'act' },
      overtaking: { rule: 'Rule 13', name: 'Overtaking', action: 'passing clear', tone: 'act' },
      giveway: { rule: 'Rule 16', name: 'Give-way', action: 'keeping out of the way', tone: 'act' },
      standon: { rule: 'Rule 17', name: 'Stand-on', action: 'holding course and speed', tone: 'hold' },
      standon_ot: { rule: 'Rule 17', name: 'Stand-on, being overtaken', action: 'holding course and speed', tone: 'hold' },
      cpa: { rule: '', name: 'Keep clear', action: 'no COLREGS situation - CPA only', tone: 'act' }
    };

  /** last time the encounter set actually changed, for expiring a stale box */
  private colregsSeenAt = 0;

  /**
   * Turn the encounter set into the one line the chart box shows.
   *
   * Only encounters the behaviour is ACTIVE on count: an open encounter means
   * the helm is watching a contact, an active one means it is steering around
   * it, and the box is there to say what the boat is doing. When more than one
   * is active the nearest wins and the rest are counted.
   */
  private updateColregsStatus() {
    const active = this.colavTest.encounters.filter(
      (e) => e.active && e.state !== 'done'
    );
    if (active.length === 0) {
      this.app.data.moosIvPServer.colregs = null;
      return;
    }

    const lead = active.reduce((a, b) => {
      const ra = a.range >= 0 ? a.range : Number.MAX_VALUE;
      const rb = b.range >= 0 ? b.range : Number.MAX_VALUE;
      return rb < ra ? b : a;
    });

    const mode = lead.mode || 'none';
    const base = mode.split(':')[0];
    const submode = mode.split(':')[1] ?? 'none';
    const rule = this.colregsRules[base];

    // Modes the behaviour has not classified yet ("none"), or has finished
    // with ("complete"). Neither should normally be seen while active, so say
    // what is known rather than inventing a rule.
    let status: ColregsStatus = rule
      ? { ...rule, icon: '', target: '', detail: '', others: 0, mode: mode }
      : {
        rule: '', name: 'Avoiding', action: 'classifying the encounter',
        tone: 'act', icon: '', target: '', detail: '', others: 0, mode: mode
      };

    // Submodes worth putting in front of the operator. The rest ("unsure",
    // "neither") are the behaviour still making its mind up and would only
    // add noise to a box that is meant to be read at a glance.
    if (base === 'giveway' && submode === 'stern') {
      status.action = 'crossing astern';
    } else if (base === 'giveway' && submode === 'bow') {
      status.action = 'crossing ahead';
    } else if (base === 'overtaking' && (submode === 'port' || submode === 'starboard')) {
      status.action = `passing to ${submode}`;
    } else if (base === 'standon' && submode === 'inextremis') {
      status = {
        ...status,
        rule: 'Rule 17(b)',
        name: 'Stand-on, in extremis',
        action: 'taking avoiding action',
        tone: 'urgent'
      };
    }

    status.icon = status.tone === 'urgent'
      ? 'priority_high'
      : status.tone === 'hold' ? 'arrow_upward' : 'near_me';
    status.target = this.colregsTargetName(lead);
    status.detail = this.colregsDetail(lead);
    status.others = active.length - 1;

    this.app.data.moosIvPServer.colregs = status;
  }

  /** range and time to CPA, as the box shows them */
  private colregsDetail(enc: ColavEncounter): string {
    const parts: string[] = [];
    if (enc.range >= 0) {
      parts.push(`${Math.round(enc.range)} m`);
    }
    // TCPA goes negative once the contact is opening again - it is only worth
    // showing while the boat is still closing on it.
    if (enc.tcpa >= 0) {
      parts.push(`TCPA ${Math.round(enc.tcpa)} s`);
    }
    return parts.join(' \u00b7 ');
  }

  /**
   * The helm knows a contact by the name in its NODE_REPORT (AIS<mmsi> for
   * simulated traffic). Trade it for the AIS vessel name when the chart has
   * one, so the box names the ship the operator can see.
   */
  private colregsTargetName(enc: ColavEncounter): string {
    if (enc.mmsi) {
      const mmsi = String(enc.mmsi);
      for (const v of this.app.data.vessels.aisTargets.values()) {
        if (v && v.mmsi === mmsi && v.name) {
          return v.name;
        }
      }
      return `MMSI ${mmsi}`;
    }
    return enc.cn || 'contact';
  }

  /**
   * Drop the box if the encounter set has stopped changing. iWebSocket echoes
   * its last COLAV_METRICS on every tick, so a pColavEval that has died looks
   * exactly like a quiet one from here - and a box left saying GIVE-WAY after
   * the evaluator is gone is worse than no box at all. A live encounter moves
   * its range and TCPA every post, so this cannot expire one that is real.
   */
  private expireStaleColregs() {
    if (!this.app.data.moosIvPServer.colregs) {
      return;
    }
    if (Date.now() - this.colregsSeenAt > 10000) {
      console.log('[COLREGS] no encounter update in 10s - clearing the chart box');
      this.app.data.moosIvPServer.colregs = null;
    }
  }

  /** pTrafficSim refuses a spawn with a reason - surface it, do not swallow it */
  private processTrafficSpawned(raw: string) {
    if (!raw) {
      return;
    }
    const kv: { [k: string]: string } = {};
    raw.split(',').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) {
        kv[p.substring(0, i)] = p.substring(i + 1);
      }
    });
    if (kv['ok'] === 'false') {
      const why: { [k: string]: string } = {
        disabled: 'traffic simulation is off in this mission',
        no_ownship: 'no position fix yet',
        out_of_range: 'too far from the boat',
        limit: 'too many targets already placed',
        bad_spec: 'malformed request',
        duplicate: 'that target already exists'
      };
      const reason = why[kv['why']] || kv['why'] || 'refused';
      this.colavTest.lastError = reason;
      this.app.showMessage(`Target not placed: ${reason}`, true, 5000);
    } else if (kv['ok'] === 'true') {
      this.colavTest.lastError = '';
    }
  }

  /** how many encounters are still open */
  protected get colavLiveCount(): number {
    return this.colavTest.encounters.filter((e) => e.state !== 'done').length;
  }

  /** format a metric that carries -1 for "not yet" */
  protected colavNum(value: number, digits = 1, suffix = ''): string {
    if (value === undefined || value === null || value < 0) {
      return '--';
    }
    return value.toFixed(digits) + suffix;
  }

  // ************ COLLISION AVOIDANCE DISTANCES (avdcol_) ************

  /** the rows of one card */
  protected colavDistSpecsFor(group: 'envelope' | 'cpa') {
    return this.colavDistSpecs.filter((s) => s.group === group);
  }

  /**
   * Keep the set consistent with the way BHV_AvdColregsV22 clamps it itself:
   * inner <= outer <= completed, and min_util_cpa <= max_util_cpa. The
   * behaviour silently drags the partner value when an update breaks one of
   * these, so doing the same here means the panel shows what the helm will
   * actually end up with rather than what was typed.
   */
  private normalizeColavDist(changed: 'outer' | 'inner' | 'completed' | 'minCpa' | 'maxCpa') {
    const d = this.colavDist;
    if (changed === 'inner') {
      if (d.inner > d.outer) { d.outer = d.inner; }
      if (d.outer > d.completed) { d.completed = d.outer; }
    } else if (changed === 'outer') {
      if (d.inner > d.outer) { d.inner = d.outer; }
      if (d.outer > d.completed) { d.completed = d.outer; }
    } else if (changed === 'completed') {
      if (d.outer > d.completed) { d.outer = d.completed; }
      if (d.inner > d.completed) { d.inner = d.completed; }
    } else if (changed === 'minCpa') {
      if (d.minCpa > d.maxCpa) { d.maxCpa = d.minCpa; }
    } else {
      if (d.minCpa > d.maxCpa) { d.minCpa = d.maxCpa; }
    }
  }

  /** update one distance from the slider/input and schedule the send */
  protected updateColavDist(
    key: 'outer' | 'inner' | 'completed' | 'minCpa' | 'maxCpa',
    value: number | string
  ) {
    const spec = this.colavDistSpecs.find((s) => s.key === key);
    if (!spec) {
      return;
    }
    const parsed = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(parsed)) {
      return;
    }
    this.colavDist[key] = Math.max(spec.min, Math.min(spec.max, Math.round(parsed)));
    this.normalizeColavDist(key);

    clearTimeout(this.colavDistSendTimer);
    this.colavDistSendTimer = setTimeout(() => {
      this.sendColavDist();
      this.saveColavDistSettings();
    }, 250);
  }

  /** typed entry: clamps the value and reflects the clamp back in the field */
  protected onColavDistInput(
    key: 'outer' | 'inner' | 'completed' | 'minCpa' | 'maxCpa',
    event: Event
  ) {
    const input = event.target as HTMLInputElement;
    this.updateColavDist(key, input.value);
    input.value = String(this.colavDist[key]);
  }

  /** step one distance by its increment (+/- buttons) */
  protected nudgeColavDist(
    key: 'outer' | 'inner' | 'completed' | 'minCpa' | 'maxCpa',
    direction: number
  ) {
    const spec = this.colavDistSpecs.find((s) => s.key === key);
    if (!spec) {
      return;
    }
    this.updateColavDist(key, this.colavDist[key] + direction * spec.step);
  }

  /**
   * Push the whole set at once. iWebSocket turns it into one update of the
   * behaviour's updates variable, so the helm never sees a half-applied
   * envelope with, say, a new outer range against the old inner one.
   */
  protected sendColavDist() {
    const d = this.colavDist;
    const sent = this.sendMoos(
      'COLAV_DIST=' +
      `pwt_outer_dist=${d.outer}` +
      `#pwt_inner_dist=${d.inner}` +
      `#completed_dist=${d.completed}` +
      `#max_util_cpa_dist=${d.maxCpa}` +
      `#min_util_cpa_dist=${d.minCpa}`
    );
    if (!sent) {
      this.app.showMessage('MOOS-IvP not connected', true, 2000);
      return;
    }
    // Do not let the backend echo overwrite the fields while the operator is
    // still working: the round trip is slower than a slider drag.
    this.colavDistMuteUntil = Date.now() + 3000;
    console.log('[COLAV DIST] sent', d);
  }

  /** back to what alpha.bhv configures avdcol_ with */
  protected resetColavDist() {
    Object.assign(this.colavDist, this.colavDistDefaults);
    this.sendColavDist();
    this.saveColavDistSettings();
    this.app.showMessage('Avoidance distances reset to the mission values', false, 2500);
  }

  /** one distance as the backend reports it is applying it, '--' until then */
  protected appliedColavDist(
    key: 'outer' | 'inner' | 'completed' | 'minCpa' | 'maxCpa'
  ): string {
    const applied = this.colavDist.applied;
    return applied ? String(Math.round(applied[key])) : '--';
  }

  /** does the helm disagree with what the panel is showing? */
  protected get colavDistPending(): boolean {
    const applied = this.colavDist.applied;
    if (!applied) {
      return false;
    }
    return (['outer', 'inner', 'completed', 'minCpa', 'maxCpa'] as const)
      .some((k) => Math.round(applied[k]) !== this.colavDist[k]);
  }

  private saveColavDistSettings() {
    this.app.config.selections.colavDist = {
      outer: this.colavDist.outer,
      inner: this.colavDist.inner,
      completed: this.colavDist.completed,
      minCpa: this.colavDist.minCpa,
      maxCpa: this.colavDist.maxCpa
    };
    this.app.saveConfig();
  }

  /**
   * Seed the panel from the last session. MOOS is still the authority: the
   * first COLAV_DIST echo replaces these with what the behaviour is really
   * running, which is what matters after a mission relaunch.
   */
  private loadColavDistSettings() {
    const saved = this.app.config.selections.colavDist;
    if (!saved) {
      return;
    }
    (['outer', 'inner', 'completed', 'minCpa', 'maxCpa'] as const).forEach((k) => {
      if (typeof saved[k] === 'number') {
        this.colavDist[k] = saved[k];
      }
    });
  }

  /**
   * COLAV_DIST: the distances iWebSocket reports it has pushed into avdcol_.
   * Adopted into the editable fields as well, so a second UI - or a relaunched
   * mission - shows the envelope actually in force rather than a stale one.
   */
  private processColavDist(raw: string) {
    if (!raw) {
      return;
    }
    const kv: { [k: string]: number } = {};
    String(raw).split(',').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) {
        const v = parseFloat(part.substring(i + 1));
        if (!isNaN(v)) {
          kv[part.substring(0, i).trim()] = v;
        }
      }
    });
    if (kv['pwt_outer_dist'] === undefined) {
      return;
    }
    this.colavDist.applied = {
      outer: kv['pwt_outer_dist'],
      inner: kv['pwt_inner_dist'] ?? 0,
      completed: kv['completed_dist'] ?? 0,
      minCpa: kv['min_util_cpa_dist'] ?? 0,
      maxCpa: kv['max_util_cpa_dist'] ?? 0
    };

    if (Date.now() < this.colavDistMuteUntil || !this.colavDistPending) {
      return;
    }
    const applied = this.colavDist.applied;
    (['outer', 'inner', 'completed', 'minCpa', 'maxCpa'] as const).forEach((k) => {
      this.colavDist[k] = Math.round(applied[k]);
    });
  }

  /** are the waypoint capture / slip radius circles drawn on the map? */
  protected get showWaypointRadii(): boolean {
    return this.app.config.selections.showWaypointRadii !== false;
  }

  /**
   * Show / hide the capture and slip radius circles around each route waypoint.
   * Display only - WPT_RADII keeps being parsed either way, so turning the
   * circles back on shows the values MOOS reported while they were hidden.
   */
  protected toggleWaypointRadii(show: boolean) {
    this.app.config.selections.showWaypointRadii = show;
    this.app.saveConfig();
  }

  /** persist calibrated gains so they survive a reload */
  private savePidSettings() {
    this.app.config.selections.servicePid = {
      enabled: this.servicePid.enabled,
      heading: { ...this.servicePid.heading },
      speed: { ...this.servicePid.speed }
    };
    this.app.saveConfig();
  }

  /** apply persisted gains at startup (MOOS telemetry overrides `enabled`) */
  private loadPidSettings() {
    const saved = this.app.config.selections.servicePid;
    if (!saved) {
      return;
    }
    this.servicePid.enabled = !!saved.enabled;
    if (saved.heading) {
      this.servicePid.heading = { ...this.servicePid.heading, ...saved.heading };
    }
    if (saved.speed) {
      this.servicePid.speed = { ...this.servicePid.speed, ...saved.speed };
    }
  }

  /**
   * Adopt the mode planchaPID reports. If it disagrees with what was just
   * requested, say so - a switch that silently flicks back looks like a UI bug
   * when it actually means the backend never took the command.
   */
  private syncServiceMode(active: boolean) {
    if (this.servicePid.ignoreModeUpdates) {
      return;
    }
    if (this.servicePid.pendingConfirm) {
      this.servicePid.pendingConfirm = false;
      if (active !== this.servicePid.enabled) {
        console.log(
          `[SERVICE MODE] planchaPID reports ${active} but ${this.servicePid.enabled} was requested`
        );
        this.app.showMessage('planchaPID did not accept the service mode change', true, 4000);
      }
    }
    this.servicePid.enabled = active;
  }

  /** PID_GAINS: gains planchaPID reports it is applying this cycle */
  private processPidGains(value: string) {
    try {
      const parts: { [key: string]: string } = {};
      String(value)
        .split(',')
        .forEach((part) => {
          const [key, val] = part.split('=', 2);
          if (key && val !== undefined) {
            parts[key.trim()] = val.trim();
          }
        });

      if (parts['heading_kp'] === undefined) {
        return;
      }

      const serviceMode = parts['service_mode'] === 'true';
      this.servicePid.applied = {
        serviceMode: serviceMode,
        heading: {
          kp: parseFloat(parts['heading_kp']) || 0,
          ki: parseFloat(parts['heading_ki']) || 0,
          kd: parseFloat(parts['heading_kd']) || 0
        },
        speed: {
          kp: parseFloat(parts['speed_kp']) || 0,
          ki: parseFloat(parts['speed_ki']) || 0,
          kd: parseFloat(parts['speed_kd']) || 0
        }
      };

      // planchaPID is the authority on whether service mode is active
      this.syncServiceMode(serviceMode);
    } catch (error) {
      console.error('[PID_GAINS] Error parsing PID_GAINS:', error, 'value:', value);
    }
  }

  protected startMission() {
    if (!this.autonomousControl.selectedRoute) {
      this.app.showMessage('Please select a route first', true, 3000);
      return;
    }
    this.autonomousControl.status = 'active';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;

    // Ignore STATUS updates until we see DRIVE→PARK transition (mission complete)
    this.autonomousControl.ignoreStatusUpdates = true;
    this.autonomousControl.lastStatus = '';
    console.log('[START MISSION] Ignoring STATUS updates until DRIVE→PARK transition');

    // Get waypoints from selected route
    const selectedRoute = this.availableRoutes.find(r => r[0] === this.autonomousControl.selectedRoute);
    if (selectedRoute && selectedRoute[1].feature && selectedRoute[1].feature.geometry && selectedRoute[1].feature.geometry.coordinates) {
      const waypoints = selectedRoute[1].feature.geometry.coordinates;

      // Format waypoints as lat1,lon1:lat2,lon2:lat3,lon3...
      const waypointString = waypoints.map(point => {
        const lat = point[1]; // Latitude is at index 1
        const lon = point[0]; // Longitude is at index 0
        return `${lat},${lon}`;
      }).join(':');

      // Send combined message: AUTONOMOUS_START=true#SPEED#WAYPOINTS#REPEAT=true/false#ID_ROUTE=route-id
      if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
        const repeatValue = this.autonomousControl.repeatRoute ? 'true' : 'false';
        const routeId = this.autonomousControl.selectedRoute;
        const message = `AUTONOMOUS_START=true#${this.autonomousControl.speed}#${waypointString}#REPEAT=${repeatValue}#ID_ROUTE=${routeId}`;
        this.app.data.moosIvPServer.socket.send(message);
        console.log(`[START MISSION] Sent combined message with ${waypoints.length} waypoints, speed ${this.autonomousControl.speed}, repeat ${repeatValue}, route ID ${routeId}`);
        console.log(`[START MISSION] Message: ${message.substring(0, 150)}...`);
      }
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
    // Stop waypoint send timer
    if (this.autonomousControl.waypointSendTimer) {
      clearInterval(this.autonomousControl.waypointSendTimer);
      this.autonomousControl.waypointSendTimer = null;
      console.log('[WAYPOINT SENDER] Timer stopped (path cleared)');
    }

    this.autonomousControl.selectedRoute = '';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;
    this.autonomousControl.status = 'standby';
    this.app.showMessage('Path Cleared', false, 3000);
    console.log('Path cleared');
  }

  protected returnToBase() {
    // Check if base position is defined
    if (!this.app.data.map.basePosition) {
      this.app.showMessage('Please define a base position first by right-clicking on the map', true, 3000);
      console.log('[RETURN TO BASE] No base position defined');
      return;
    }

    this.autonomousControl.status = 'returning';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;

    // Ignore STATUS updates until we see DRIVE→PARK transition (mission complete)
    this.autonomousControl.ignoreStatusUpdates = true;
    this.autonomousControl.lastStatus = '';
    console.log('[RETURN TO BASE] Ignoring STATUS updates until DRIVE→PARK transition');

    // Format base position as waypoint (lat,lon)
    const basePos = this.app.data.map.basePosition;
    const lat = basePos[1]; // Latitude is at index 1
    const lon = basePos[0]; // Longitude is at index 0
    const waypointString = `${lat},${lon}`;

    // Send AUTONOMOUS_START message with base position as the only waypoint
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      const message = `AUTONOMOUS_START=true#${this.autonomousControl.speed}#${waypointString}#REPEAT=false#ID_ROUTE=return_to_base`;
      this.app.data.moosIvPServer.socket.send(message);
      console.log(`[RETURN TO BASE] Sent AUTONOMOUS_START with base waypoint at ${waypointString}`);
      console.log(`[RETURN TO BASE] Message: ${message}`);
    } else {
      console.log('[RETURN TO BASE] MOOS-IvP not connected, cannot send command');
    }

    this.app.showMessage('Returning to Base', false, 3000);
    console.log('[RETURN TO BASE] Initiated return to base');
  }

  /**
   * Remove the return-to-base point. The boat is told too (empty BASE_COORDS),
   * otherwise its echo would restore the base the next time the panel opens.
   */
  protected deleteBase() {
    if (!this.app.data.map.basePosition) {
      return;
    }
    if (!this.sendMoos('BASE_COORDS=')) {
      this.app.showMessage('MOOS-IvP not connected, base not deleted', true, 3000);
      return;
    }
    this.app.data.map.basePosition = undefined;
    this.app.data.moosIvPServer.baseCoords = '';
    this.app.showMessage('Base deleted', false, 2000);
  }

  protected abortMission() {
    this.autonomousControl.status = 'aborted';
    this.autonomousControl.currentWaypoint = 0;
    this.autonomousControl.progress = 0;

    // Stop any active waypoint station keep (clear counter from map)
    if (this.activeWaypointStationKeep.active) {
      this.stopWaypointStationKeep();
    }

    // Send stop command to MOOS-IvP when aborting
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send('AUTONOMOUS_STOP=true');
      console.log('Sent AUTONOMOUS_STOP=true to MOOS-IvP (mission aborted)');
    }

    this.app.showMessage('Mission Aborted', true, 3000);
    console.log('Mission aborted');
  }

  protected closeAutonomousControl() {
    // Stop waypoint send timer
    if (this.autonomousControl.waypointSendTimer) {
      clearInterval(this.autonomousControl.waypointSendTimer);
      this.autonomousControl.waypointSendTimer = null;
      console.log('[WAYPOINT SENDER] Timer stopped (autonomous control closed)');
    }

    // Clear all routes and refresh to restore original visibility when closing autonomous control
    this.skres.routeRemove();
    this.skres.refreshRoutes();

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

  // Station Keep control methods
  protected updateStationKeepInnerRadius(value: number) {
    this.stationKeep.innerRadius = Math.max(1, Math.min(100, value));
    // Ensure outer radius is always greater than inner radius
    if (this.stationKeep.outerRadius <= this.stationKeep.innerRadius) {
      this.stationKeep.outerRadius = this.stationKeep.innerRadius + 5;
    }
  }

  protected updateStationKeepOuterRadius(value: number) {
    this.stationKeep.outerRadius = Math.max(this.stationKeep.innerRadius + 1, Math.min(200, value));
  }

  protected updateStationKeepSpeed(value: number) {
    this.stationKeep.speed = Math.max(0.5, Math.min(25, value));
  }

  protected startStationKeep() {
    console.log('Starting Station Keep...');
    console.log('stationKeep.position:', this.stationKeep.position);

    if (!this.stationKeep.position) {
      this.app.showMessage('Please set a Station Keep position first by right-clicking on the map', true, 3000);
      return;
    }

    this.stationKeep.status = 'active';

    // Send Station Keep command to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      const lat = this.stationKeep.position[1];
      const lon = this.stationKeep.position[0];
      const message = `STATION_KEEP=true#STATION_PT=${lat},${lon}#INNER_RADIUS=${this.stationKeep.innerRadius}#OUTER_RADIUS=${this.stationKeep.outerRadius}#SPEED=${this.stationKeep.speed}`;
      this.app.data.moosIvPServer.socket.send(message);
      console.log(`Sent ${message} to MOOS-IvP`);
    }

    this.app.showMessage(`Station Keep Started at ${this.formatPosition(this.stationKeep.position)}`, false, 3000);
    console.log('Station Keep started:', this.stationKeep);
  }

  protected stopStationKeep() {
    this.stationKeep.status = 'standby';

    // Send stop command to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      this.app.data.moosIvPServer.socket.send('STATION_KEEP=false');
      console.log('Sent STATION_KEEP=false to MOOS-IvP');
    }

    // Hide station keep circles
    this.hideStationKeepCircles = true;
    // Reset the flag to allow showing circles again next time
    setTimeout(() => {
      this.hideStationKeepCircles = false;
    }, 100);

    this.app.showMessage('Station Keep Stopped', false, 3000);
    console.log('Station Keep stopped');
  }

  protected setStationKeepPosition(position: [number, number]) {
    this.stationKeep.position = position;
    this.app.showMessage(`Station Keep position set to ${this.formatPosition(position)}`, false, 3000);
  }

  public formatPosition(position: [number, number]): string {
    if (!position) return 'Not set';
    const lat = position[1].toFixed(6);
    const lon = position[0].toFixed(6);
    return `${lat}, ${lon}`;
  }

  // Format time in seconds to readable format (HH:MM:SS or MM:SS)
  public formatTime(seconds: number): string {
    if (!seconds || seconds <= 0) {
      return '0s';
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  // Calculate total distance of the route (fixed, between waypoints only)
  private calculateTotalRouteDistance(waypoints: [number, number][]) {
    if (!waypoints || waypoints.length === 0) {
      this.autonomousControl.totalDistance = 0;
      return;
    }

    let totalDistance = 0;

    // Calculate distances between consecutive waypoints only
    for (let i = 0; i < waypoints.length - 1; i++) {
      const distance = GeoUtils.distanceTo(
        waypoints[i],           // [lon, lat]
        waypoints[i + 1]        // [lon, lat]
      );
      totalDistance += distance;
    }

    this.autonomousControl.totalDistance = totalDistance;
    console.log(`[ROUTE CALC] Total route distance (fixed): ${totalDistance.toFixed(0)}m`);
  }

  // Calculate dynamic time of arrival based on current vessel position
  private calculateDynamicTOA(waypoints: [number, number][]) {
    if (!waypoints || waypoints.length === 0) {
      this.autonomousControl.totalTimeOfArrival = 0;
      this.autonomousControl.progress = 0;
      return;
    }

    let totalDistance = 0;
    let remainingDistance = 0;

    // During active mission, use the remaining distance from WPT_STAT if available
    // This already includes distance to current waypoint + all remaining waypoints
    if (this.autonomousControl.status === 'active' && this.autonomousControl.remainingDistance > 0) {
      remainingDistance = this.autonomousControl.remainingDistance;

      // Calculate total route distance from first to last waypoint
      let totalRouteDistance = 0;
      for (let i = 0; i < waypoints.length - 1; i++) {
        totalRouteDistance += GeoUtils.distanceTo(waypoints[i], waypoints[i + 1]);
      }

      totalDistance = remainingDistance;

      // Progress is now driven by WPT_PCT_COMPLETE from MOOS-IvP
      const distanceTraveled = totalRouteDistance - remainingDistance;

      console.log(`[ROUTE CALC] Progress: ${this.autonomousControl.progress}% (from WPT_PCT_COMPLETE) (traveled: ${distanceTraveled.toFixed(0)}m / total: ${totalRouteDistance.toFixed(0)}m)`);
      console.log(`[ROUTE CALC] Using remaining distance from WPT_STAT: ${totalDistance.toFixed(0)}m`);
    } else {
      // When mission is not active or no WPT_STAT data, calculate from vessel position
      const vesselPosition = this.app.data.vessels.self.position;
      if (vesselPosition && vesselPosition.length >= 2) {
        // Calculate distance from vessel to first waypoint
        const distToFirst = GeoUtils.distanceTo(
          vesselPosition,         // [lon, lat]
          waypoints[0]            // [lon, lat]
        );
        totalDistance += distToFirst;
      }

      // Calculate distances between consecutive waypoints
      for (let i = 0; i < waypoints.length - 1; i++) {
        const distance = GeoUtils.distanceTo(
          waypoints[i],           // [lon, lat]
          waypoints[i + 1]        // [lon, lat]
        );
        totalDistance += distance;
      }

      // Progress is 0 when not active
      this.autonomousControl.progress = 0;

      console.log(`[ROUTE CALC] Calculated total distance from vessel position: ${totalDistance.toFixed(0)}m`);
    }

    // Calculate time of arrival using SOG (Speed Over Ground) from topbar
    // SOG is in m/s
    const sog = this.app.data.vessels.self.sog;
    if (sog && sog > 0) {
      this.autonomousControl.totalTimeOfArrival = totalDistance / sog;
      console.log(`[ROUTE CALC] Total TOA: ${this.autonomousControl.totalTimeOfArrival.toFixed(0)}s (${this.formatTime(this.autonomousControl.totalTimeOfArrival)}) at ${(sog / 0.514444).toFixed(2)} knots SOG for ${totalDistance.toFixed(0)}m`);
    } else {
      this.autonomousControl.totalTimeOfArrival = 0;
      console.log(`[ROUTE CALC] Total TOA: 0s (SOG is ${sog || 0} m/s - vessel not moving)`);
    }
  }

  protected closeStationKeep() {
    this.display.stationKeepPanelOpen = false;
    this.stationKeep.status = 'standby';

    // Send STATION_PT=false to MOOS-IvP to disable station keep
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      const message = 'STATION_PT=false';
      this.app.data.moosIvPServer.socket.send(message);
      console.log(`Sent ${message} to MOOS-IvP`);
    }

    // Hide station keep circles
    this.hideStationKeepCircles = true;
    // Reset the flag to allow showing circles again next time
    setTimeout(() => {
      this.hideStationKeepCircles = false;
    }, 100);

    this.app.showMessage('Station Keep Panel Closed', false, 3000);
    this.focusMap();
  }

  // recebe o índice do waypoint ALCANÇADO
  private async handleWaypointReached(reachedIndex: number) {
    const activeRouteId = this.autonomousControl.selectedRoute || this.app.data.activeRoute;
    if (!activeRouteId) {
      console.log('[STATION KEEP] No active route');
      return;
    }

    console.log('[STATION KEEP] =========================');
    console.log('[STATION KEEP] Reached waypoint index (arrived):', reachedIndex);
    console.log('[STATION KEEP] Active route ID:', activeRouteId);
    console.log('[STATION KEEP] From autonomous control:', !!this.autonomousControl.selectedRoute);

    try {
      const route = await this.skres.fromServer('routes', activeRouteId);
      if (!route) {
        console.log('[STATION KEEP] Route not found');
        return;
      }

      const routeData = route as any;
      const coords = routeData.feature?.geometry?.coordinates ?? [];
      const coordinatesMeta = routeData.feature?.properties?.coordinatesMeta ?? [];

      // Proteções de índice
      if (reachedIndex < 0 || reachedIndex >= coords.length) {
        console.log('[STATION KEEP] Reached index out of bounds:', reachedIndex, 'total points:', coords.length);
        return;
      }

      console.log('[STATION KEEP] Route data:', {
        name: routeData.name,
        totalPoints: coords.length,
        hasProperties: !!routeData.feature?.properties,
        hasCoordinatesMeta: !!routeData.feature?.properties?.coordinatesMeta
      });

      console.log('[STATION KEEP] Total coordinatesMeta entries:', coordinatesMeta.length);

      const pointMeta = coordinatesMeta[reachedIndex];
      if (!pointMeta) {
        console.log('[STATION KEEP] No metadata for reached index:', reachedIndex);
        return;
      }

      console.log('[STATION KEEP] Point metadata:', JSON.stringify(pointMeta, null, 2));

      if (pointMeta.stationKeep) {
        const position = coords[reachedIndex];
        console.log('[STATION KEEP] ✓ Waypoint HAS station keep config:', pointMeta.stationKeep);
        console.log('[STATION KEEP] Position:', position);

        this.startWaypointStationKeep(
          position,
          pointMeta.stationKeep.innerRadius,
          pointMeta.stationKeep.outerRadius,
          pointMeta.stationKeep.timeToKeep
        );
      } else {
        console.log('[STATION KEEP] ✗ Waypoint has NO station keep config');
      }
    } catch (err) {
      console.error('[STATION KEEP] Error checking waypoint:', err);
    }
  }


  // ** Start station keep at waypoint **
  private startWaypointStationKeep(
    position: [number, number],
    innerRadius: number,
    outerRadius: number,
    timeToKeep: number
  ) {
    // Stop any existing station keep timer
    if (this.activeWaypointStationKeep.timer) {
      clearInterval(this.activeWaypointStationKeep.timer);
    }

    // Set station keep configuration
    this.activeWaypointStationKeep.active = true;
    this.activeWaypointStationKeep.innerRadius = innerRadius;
    this.activeWaypointStationKeep.outerRadius = outerRadius;
    this.activeWaypointStationKeep.timeToKeep = timeToKeep;
    this.activeWaypointStationKeep.timeRemaining = timeToKeep;
    this.activeWaypointStationKeep.position = position;

    // Send command to MOOS-IvP with coordinates (lat,lon)
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      const lat = position[1]; // latitude
      const lon = position[0]; // longitude
      const message = `STATION_KEEP_WAYPOINT=TRUE#INNER_RADIUS=${innerRadius}#OUTER_RADIUS=${outerRadius}#COORDS=${lat},${lon}`;
      this.app.data.moosIvPServer.socket.send(message);
      console.log(`[STATION KEEP] Sent to MOOS-IvP: ${message}`);
    }

    // Start countdown timer (update every second)
    this.activeWaypointStationKeep.timer = setInterval(() => {
      this.activeWaypointStationKeep.timeRemaining--;

      if (this.activeWaypointStationKeep.timeRemaining <= 0) {
        this.stopWaypointStationKeep();
      }
    }, 1000);

    this.app.showMessage(
      `Station Keep started at waypoint for ${timeToKeep} seconds`,
      false,
      3000
    );
  }

  // ** Stop waypoint station keep **
  private stopWaypointStationKeep() {
    // Stop timer
    if (this.activeWaypointStationKeep.timer) {
      clearInterval(this.activeWaypointStationKeep.timer);
      this.activeWaypointStationKeep.timer = null;
    }

    // Send stop command to MOOS-IvP
    if (this.app.data.moosIvPServer.connected && this.app.data.moosIvPServer.socket) {
      const message = 'STATION_KEEP_WAYPOINT=FALSE';
      this.app.data.moosIvPServer.socket.send(message);
      console.log(`[STATION KEEP] Sent to MOOS-IvP: ${message}`);
    }

    // Reset station keep state
    this.activeWaypointStationKeep.active = false;
    this.activeWaypointStationKeep.timeRemaining = 0;

    this.app.showMessage('Station Keep completed', false, 3000);
  }

  // ** Debug: Inspect route station keep configuration **
  public async debugInspectRoute(routeId?: string) {
    const id = routeId || this.autonomousControl.selectedRoute || this.app.data.activeRoute;
    if (!id) {
      console.log('[DEBUG] No route ID provided and no active route');
      return;
    }

    try {
      const route = await this.skres.fromServer('routes', id);
      if (!route) {
        console.log('[DEBUG] Route not found:', id);
        return;
      }

      const routeData = route as any;
      console.log('[DEBUG] ========== ROUTE INSPECTION ==========');
      console.log('[DEBUG] Route ID:', id);
      console.log('[DEBUG] Route Name:', routeData.name);
      console.log('[DEBUG] Total Points:', routeData.feature.geometry.coordinates.length);

      const coordinatesMeta = routeData.feature.properties?.coordinatesMeta;
      if (coordinatesMeta) {
        console.log('[DEBUG] CoordinatesMeta Length:', coordinatesMeta.length);
        coordinatesMeta.forEach((meta: any, index: number) => {
          if (meta.stationKeep) {
            console.log(`[DEBUG] Point ${index} HAS Station Keep:`, meta.stationKeep);
          } else {
            console.log(`[DEBUG] Point ${index}: No station keep (name: ${meta.name || 'none'})`);
          }
        });
      } else {
        console.log('[DEBUG] No coordinatesMeta found');
      }
      console.log('[DEBUG] ====================================');
    } catch (err) {
      console.error('[DEBUG] Error inspecting route:', err);
    }
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
        : `${this.app.hostDef.url}${this.app.config.selections.pluginFavourites[this.selFavourite]
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
      case 'station_keep':
        this.openStationKeepPanel();
        break;
      case 'put_target':
        this.putColavTarget(this.app.data.map.colavTargetPosition);
        break;
    }
  }

  protected openStationKeepPanel() {
    console.log('Opening Station Keep panel...');
    console.log('app.data.map.stationKeepPosition:', this.app.data.map.stationKeepPosition);
    console.log('Current stationKeep.position:', this.stationKeep.position);

    // Set the position from the right-click location
    if (this.app.data.map.stationKeepPosition) {
      this.stationKeep.position = this.app.data.map.stationKeepPosition;
      console.log('Position set from map:', this.stationKeep.position);
    }
    // If no new position from right-click, keep the existing position

    this.display.stationKeepPanelOpen = true;
    this.display.instrumentPanelOpen = false;
    this.display.remoteControlPanelOpen = false;
    this.display.autonomousControlPanelOpen = false;

    console.log('Final stationKeep.position:', this.stationKeep.position);

    if (this.stationKeep.position) {
      this.app.showMessage(`Station Keep position set to ${this.formatPosition(this.stationKeep.position)}`, false, 3000);
    } else {
      this.app.showMessage('Station Keep panel opened. Right-click on map to set position.', false, 3000);
    }
    this.focusMap();
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

    // Use SignalK settings if enabled, otherwise fallback to hostDef
    let host = this.app.hostDef.name;
    let port = this.app.hostDef.port;
    let ssl = this.app.hostDef.ssl;

    if (this.app.config.signalk?.enabled) {
      // Parse URL to extract host
      const signalkUrl = this.app.config.signalk.url;
      if (signalkUrl) {
        try {
          const url = new URL(signalkUrl);
          host = url.hostname;
          ssl = url.protocol === 'https:';
        } catch (e) {
          // If URL parsing fails, treat as hostname
          host = signalkUrl.replace(/^https?:\/\//, '');
          ssl = signalkUrl.startsWith('https://');
        }
      }
      port = this.app.config.signalk.port;
    }

    this.signalk
      .connect(host, port, ssl)
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
    console.log('[MOOS-IvP CONNECTION] Starting connection via WebSocket service...');

    const wsUrl = `${this.app.config.moosIvP.url}:${this.app.config.moosIvP.port}`;
    console.log('[MOOS-IvP CONNECTION] Connecting to WebSocket URL:', wsUrl);
    this.app.data.moosIvPServer.url = wsUrl;

    // Subscribe to connection state changes
    this.moosWsService.connectionState$.subscribe((state) => {
      console.log('[MOOS-IvP CONNECTION] State changed to:', state);

      switch (state) {
        case 'connected':
          this.app.debug('MOOS-IvP WebSocket connection opened');
          this.app.data.moosIvPServer.connected = true;
          this.app.data.connectionState.moosIvP.connected = true;
          this.app.data.connectionState.moosIvP.connecting = false;
          this.app.showMessage('Mission Management System connection established', false, 3000);
          // A lost link leaves the boat in neutral at 0 thrust: match it,
          // and re-assert manual control if the operator still has it on.
          this.resetManualGearAndThrust();
          if (this.app.config.selections.remoteControl) {
            this.sendMoos('CONTROLE_MANUAL=true');
          }
          // Sync region state after a delay to ensure regions are loaded from Signal K
          setTimeout(() => this.syncRegionFromMOOS(), 5000);
          break;

        case 'connecting':
        case 'reconnecting':
          this.app.data.connectionState.moosIvP.connecting = true;
          this.app.data.connectionState.moosIvP.connected = false;
          if (state === 'reconnecting') {
            this.app.showMessage('Mission Management System connection lost. Reconnecting...', false, 3000);
          }
          break;

        case 'disconnected':
        case 'error':
          this.app.data.moosIvPServer.connected = false;
          this.app.data.connectionState.moosIvP.connected = false;
          this.app.data.connectionState.moosIvP.connecting = false;
          if (state === 'error') {
            this.app.showMessage(`Mission Management System connection failed: ${wsUrl}`, false, 5000);
          }
          break;
      }
    });

    // Only live traffic is recorded...
    this.moosWsService.messages$.subscribe((data) =>
      this.replay.recordMoos(data)
    );
    // ...but replayed lines are merged in here so they drive exactly the same
    // handlers as the live socket.
    merge(this.moosWsService.messages$, this.replay.moos$).subscribe((data) => {
      this.handleMoosIvPMessage(data);
    });

    // Deprecated: reference to old socket (kept for compatibility)
    // Components checking this.app.data.moosIvPServer.socket still work
    this.app.data.moosIvPServer.socket = {
      readyState: WebSocket.CONNECTING,
      // Every outbound MOOS message in this component funnels through here, so
      // this is the one place that has to block replay from transmitting.
      // Replayed WPT_INDEX changes reach startWaypointStationKeep(), which would
      // otherwise send real station-keep commands to the live vehicle.
      send: (msg: string) => {
        if (this.replay.isReplaying()) {
          this.app.debug(`[REPLAY] suppressed outbound MOOS: ${msg}`);
          return;
        }
        this.moosWsService.send(msg);
      },
      close: () => this.moosWsService.disconnect()
    } as any;

    // Connect using the service
    this.moosWsService.connect(wsUrl);
  }

  /** handle MOOS-IvP WebSocket message */
  private handleMoosIvPMessage(data: string) {
    try {
      this.app.data.moosIvPServer.lastMessage = data;

      // Try to parse as JSON first (new consolidated format)
      if (data.startsWith('{')) {
        try {
          const jsonData = JSON.parse(data);
          this.processMoosJsonMessage(jsonData);
          return;
        } catch (parseError) {
          // Not valid JSON, fall through to legacy parsing
          console.warn('[MOOS-IvP] Failed to parse as JSON, falling back to legacy format');
        }
      }

      // Legacy format: KEY=value lines
      const lines = data.split('\n');
      lines.forEach(line => {
        if (line.includes('=')) {
          const eqIndex = line.indexOf('=');
          const variable = line.substring(0, eqIndex).trim();
          const value = line.substring(eqIndex + 1).trim();
          this.processMoosVariable(variable, value);
        }
      });
    } catch (error) {
      console.error('[MOOS-IvP ERROR] Error processing message:', error);
      this.app.debug('Error processing MOOS-IvP message:', error);
    }
  }

  /** process individual MOOS variable */
  private processMoosVariable(variable: string, value: string) {
    switch (variable) {
      case 'IVPHELM_STATE':
        this.app.data.moosIvPServer.ivpHelmState = value;
        // Update mission status based on IVPHELM_STATE changes
        this.handleStatusChange(value);
        break;
      case 'IVPHELM_ALLSTOP':
        this.app.data.moosIvPServer.ivpHelmAllstop = value;
        break;
      // dentro de processMoosVariable(variable, value)
      case 'WPT_INDEX': {
        const newWptIndex = parseInt(value) || 0;
        const previousWptIndex = this.app.data.moosIvPServer.wptIndex;
        this.app.data.moosIvPServer.wptIndex = newWptIndex;

        // Se mudou, o ponto alcançado é o previousWptIndex
        if (newWptIndex !== previousWptIndex) {
          console.log('[WPT_INDEX] Waypoint changed from', previousWptIndex, 'to', newWptIndex);
          console.log('[WPT_INDEX] Checking for station keep...');
          this.handleWaypointReached(previousWptIndex);
        }
        break;
      }
      case 'WPT_DIST':
        this.app.data.moosIvPServer.wptDist = parseFloat(value) || 0;
        break;
      case 'WPT_ETA':
        this.app.data.moosIvPServer.wptEta = parseFloat(value) || 0;
        break;
      // Engine status variables
      case 'ENGINE_ACCELERATOR_PEDAL_POSITION':
        this.engineStatus.acceleratorPedalPosition = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Accelerator Pedal Position updated:', this.engineStatus.acceleratorPedalPosition);
        break;
      case 'ENGINE_PERCENT_LOAD':
        this.engineStatus.percentLoad = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Engine Load updated:', this.engineStatus.percentLoad);
        break;
      case 'ENGINE_SPEED':
        this.engineStatus.speed = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Engine Speed updated:', this.engineStatus.speed);
        break;
      case 'ENGINE_PERCENT_TORQUE':
        this.engineStatus.percentTorque = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Engine Torque updated:', this.engineStatus.percentTorque);
        break;
      case 'ENGINE_ACTIVE_DTCS':
        this.engineStatus.activeDtcs = 0; //Changed for a video
        // console.log('[ENGINE DEBUG] Active DTCs updated:', this.engineStatus.activeDtcs);
        break;
      case 'ENGINE_COOLANT_TEMP':
        this.engineStatus.coolantTemp = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Coolant Temperature updated:', this.engineStatus.coolantTemp);
        break;
      case 'ENGINE_OIL_TEMP':
        this.engineStatus.oilTemp = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Oil Temperature updated:', this.engineStatus.oilTemp);
        break;
      case 'ENGINE_OIL_PRESSURE':
        this.engineStatus.oilPressure = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Oil Pressure updated:', this.engineStatus.oilPressure);
        break;
      case 'ENGINE_FUEL_RATE':
        this.engineStatus.fuelRate = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Fuel Rate updated:', this.engineStatus.fuelRate);
        break;
      case 'ENGINE_INTAKE_MANIFOLD_PRESSURE':
        this.engineStatus.intakeManifoldPressure = parseFloat(value) || 0;
        // console.log('[ENGINE DEBUG] Intake Manifold Pressure updated:', this.engineStatus.intakeManifoldPressure);
        break;
      case 'ENGINE_BATTERY_VOLTAGE': {
        const voltage =
          this.app?.data?.vessels?.self?.electrical?.batteries?.House?.voltage;

        this.engineStatus.batteryVoltage =
          typeof voltage === 'number' ? voltage : 0;

        // Optional debug
        // console.log('[ENGINE] House battery voltage:', this.engineStatus.batteryVoltage);

        break;
      }
      case 'CONTACT_INFO':
        this.processContactInfo(value);
        break;
      case 'TRAILING':
        // What the helm reports, not what was requested.
        this.aisFollow.active = value === 'true';
        if (!this.aisFollow.active) {
          this.aisFollow.mmsi = '';
          this.aisFollow.name = '';
        }
        break;
      case 'TRAIL_UPDATES': {
        // contact=AIS366999001 # trail_range=150 # trail_angle=180
        const mmsi = String(value).match(/contact=AIS(\d+)/);
        if (mmsi) {
          this.aisFollow.mmsi = mmsi[1];
          if (!this.aisFollow.name) {
            this.aisFollow.name = mmsi[1];
          }
        }
        break;
      }
      case 'WPT_STAT': {
        // Parse WPT_STAT format: vname=alpha,behavior-name=waypt_survey,index=0,hits=0/0,cycles=0,dist=2565,eta=513
        // console.log('[WPT_STAT] Received WPT_STAT message:', value);
        try {
          const parts = value.split(',');
          const stats: { [key: string]: string } = {};

          parts.forEach(part => {
            const [key, val] = part.split('=', 2);
            if (key && val) {
              stats[key.trim()] = val.trim();
            }
          });

          // console.log('[WPT_STAT] Parsed stats object:', stats);
          // console.log('[WPT_STAT] dist value:', stats['dist'], 'eta value:', stats['eta']);

          // Extract current waypoint index
          if (stats['index']) {
            this.autonomousControl.currentWaypoint = parseInt(stats['index']) || 0;
          }

          // Extract dist to current waypoint and calculate TOTAL remaining distance to END of route
          if (stats['dist']) {
            const distToCurrentWaypoint = parseFloat(stats['dist']) || 0;

            // Calculate total remaining distance to the LAST waypoint in route
            if (this.autonomousControl.selectedRoute) {
              const selectedRoute = this.availableRoutes.find(r => r[0] === this.autonomousControl.selectedRoute);
              if (selectedRoute && selectedRoute[1].feature && selectedRoute[1].feature.geometry && selectedRoute[1].feature.geometry.coordinates) {
                const waypoints = selectedRoute[1].feature.geometry.coordinates as [number, number][];
                const currentWptIndex = this.autonomousControl.currentWaypoint;

                // Start with distance to current waypoint from MOOS
                let totalRemainingDistance = distToCurrentWaypoint;

                // Add distances between all remaining waypoints (from current to end)
                for (let i = currentWptIndex; i < waypoints.length - 1; i++) {
                  const distance = GeoUtils.distanceTo(
                    waypoints[i],     // [lon, lat]
                    waypoints[i + 1]  // [lon, lat]
                  );
                  totalRemainingDistance += distance;
                }

                this.autonomousControl.remainingDistance = totalRemainingDistance;
                console.log(`[WPT_STAT] Total remaining distance to LAST waypoint: ${totalRemainingDistance.toFixed(0)}m (to current waypoint #${currentWptIndex}: ${distToCurrentWaypoint.toFixed(0)}m + remaining route: ${(totalRemainingDistance - distToCurrentWaypoint).toFixed(0)}m)`);
              } else {
                // Fallback if route not found
                this.autonomousControl.remainingDistance = distToCurrentWaypoint;
              }
            } else {
              // Fallback if no route selected
              this.autonomousControl.remainingDistance = distToCurrentWaypoint;
            }
          }

          if (stats['eta']) {
            this.autonomousControl.estimatedTimeArrival = parseFloat(stats['eta']) || 0;
          }

          // console.log('[WPT_STAT] Distance:', this.autonomousControl.remainingDistance, 'ETA:', this.autonomousControl.estimatedTimeArrival);
        } catch (error) {
          console.error('[WPT_STAT] Error parsing WPT_STAT:', error, 'value:', value);
        }
        break;
      }
      case 'WPT_PCT_COMPLETE':
        this.autonomousControl.progress = Math.floor(parseFloat(value) || 0);
        break;
      case 'WPT_RADII': {
        try {
          let radii: any = {};
          if (typeof value === 'object') {
             radii = value;
          } else {
            const parts = String(value).split(',');
            parts.forEach(part => {
               const [key, val] = part.split('=');
               if (key && val) { radii[key.trim()] = parseFloat(val.trim()); }
            });
          }
          if (radii.capture_radius !== undefined && radii.slip_radius !== undefined) {
             const parsedRadii = {
               captureRadius: parseFloat(radii.capture_radius),
               slipRadius: parseFloat(radii.slip_radius)
             };
             this.autonomousControl.waypointRadii = parsedRadii;
             this.app.data.moosIvPServer.waypointRadii = parsedRadii;
          }
        } catch(e) {
          console.error('[WPT_RADII] error parsing:', e);
        }
        break;
      }
      case 'DESIRED_SPEED':
        this.app.data.moosIvPServer.desiredSpeed = parseFloat(value) || 0;
        //console.log('[DESIRED_SPEED] Received from MOOS-IvP:', this.app.data.moosIvPServer.desiredSpeed);
        break;
      case 'ID_ROUTE':
        this.app.data.moosIvPServer.idRoute = value;
        //console.log('[ID_ROUTE] Received route ID from MOOS-IvP:', value);
        break;
      case 'BASE_COORDS':
        this.app.data.moosIvPServer.baseCoords = value;
        //console.log('[BASE_COORDS] Received from MOOS-IvP:', value);
        break;
      case 'CAN_SEND':
        // Store on moosIvPServer and update UI controls (unless recently toggled by user)
        const canEnabled = value === 'true' || value === '1';
        this.app.data.moosIvPServer.canSend = canEnabled;
        if (!this.autonomousControl.ignoreCanSendUpdates) {
          this.autonomousControl.canSend = canEnabled;
        }
        console.log('[CAN_SEND] Received from MOOS-IvP:', value, '- Enabled:', canEnabled);
        break;
      case 'CAN_TRIM_STATE':
        this.updateTrimState(value);
        break;
      case 'CAN_TX_GEAR':
        this.updateBoatGear(value);
        break;
      case 'CAN_TX_THRUST_PCT':
        this.updateBoatThrust(value);
        break;
      case 'REGION':
        const regionEnabled = value === 'true' || value === '1';
        this.app.data.moosIvPServer.regionActive = regionEnabled;
        console.log('[REGION] Received from MOOS-IvP:', value, '- Active:', regionEnabled);
        break;
      case 'PID_GAINS':
        this.processPidGains(value);
        break;
      case 'SERVICE_MODE': {
        // iWebSocket's echo of the request. The switch itself follows PID_GAINS,
        // since planchaPID is what actually applies (or ignores) the mode.
        this.app.data.moosIvPServer.serviceMode = value === 'true' || value === '1';
        break;
      }
      default:
      // Handle other MOOS variables as needed
      // this.app.debug(`Unknown MOOS variable: ${variable} = ${value}`);
    }
  }

  /** Process consolidated JSON message from MOOS-IvP */
  private processMoosJsonMessage(data: any) {
    // String variables
    if (data.IVPHELM_STATE !== undefined) {
      this.app.data.moosIvPServer.ivpHelmState = data.IVPHELM_STATE;
      // Update mission status based on IVPHELM_STATE changes
      this.handleStatusChange(data.IVPHELM_STATE);
    }
    if (data.IVPHELM_ALLSTOP !== undefined) {
      this.app.data.moosIvPServer.ivpHelmAllstop = data.IVPHELM_ALLSTOP;
    }
    if (data.WPT_STAT !== undefined) {
      // Reuse existing WPT_STAT parser
      this.processMoosVariable('WPT_STAT', data.WPT_STAT);
    }
    if (data.ID_ROUTE !== undefined) {
      this.app.data.moosIvPServer.idRoute = data.ID_ROUTE;
    }

    // Numeric variables
    if (data.WPT_INDEX !== undefined) {
      const newWptIndex = data.WPT_INDEX;
      const previousWptIndex = this.app.data.moosIvPServer.wptIndex;
      this.app.data.moosIvPServer.wptIndex = newWptIndex;
      if (newWptIndex !== previousWptIndex) {
        console.log('[WPT_INDEX] Waypoint changed from', previousWptIndex, 'to', newWptIndex);
        this.handleWaypointReached(previousWptIndex);
      }
    }
    if (data.DESIRED_SPEED !== undefined) {
      this.app.data.moosIvPServer.desiredSpeed = data.DESIRED_SPEED;
    }
    if (data.DESIRED_RUDDER !== undefined) {
      this.app.data.moosIvPServer.desiredRudder = data.DESIRED_RUDDER;
    }
    if (data.DESIRED_THRUST !== undefined) {
      this.app.data.moosIvPServer.desiredThrust = data.DESIRED_THRUST;
    }
    if (data.BASE_COORDS !== undefined) {
      this.app.data.moosIvPServer.baseCoords = data.BASE_COORDS;
      //console.log('[BASE_COORDS] Received from MOOS-IvP (JSON):', data.BASE_COORDS);
    }
    if (data.CAN_SEND !== undefined) {
      //console.log('[CAN_SEND JSON] Raw value:', data.CAN_SEND, '- Type:', typeof data.CAN_SEND);
      const canSendEnabled = data.CAN_SEND === 'true' || data.CAN_SEND === '1' || data.CAN_SEND === true;
      this.app.data.moosIvPServer.canSend = canSendEnabled;
      if (!this.autonomousControl.ignoreCanSendUpdates) {
        this.autonomousControl.canSend = canSendEnabled;
      }
    }
    // Missing until iCAN first posts it: treat as idle.
    this.updateTrimState(data.CAN_TRIM_STATE ?? 'idle');
    if (data.CAN_TX_GEAR !== undefined) {
      this.updateBoatGear(data.CAN_TX_GEAR);
    }
    if (data.CAN_TX_THRUST_PCT !== undefined) {
      this.updateBoatThrust(data.CAN_TX_THRUST_PCT);
    }
    if (data.REGION !== undefined) {
      const regionEnabled = data.REGION === 'true' || data.REGION === '1' || data.REGION === true;
      this.app.data.moosIvPServer.regionActive = regionEnabled;
    }
    if (data.WAYPOINT !== undefined) {
      const waypointActive = data.WAYPOINT === 'true' || data.WAYPOINT === '1' || data.WAYPOINT === true;
      this.autonomousControl.waypointActive = waypointActive;
      this.app.data.moosIvPServer.waypointActive = waypointActive;
      // Derive mission status from WAYPOINT: true = behavior running = active, false = standby
      if (waypointActive) {
        this.autonomousControl.status = 'active';
      } else {
        this.autonomousControl.status = 'standby';
      }
      console.log('[WAYPOINT] Received from MOOS-IvP:', data.WAYPOINT, '→ waypointActive:', waypointActive, '→ status:', this.autonomousControl.status);
    }
    if (data.WPT_PCT_COMPLETE !== undefined) {
      this.autonomousControl.progress = Math.floor(parseFloat(data.WPT_PCT_COMPLETE) || 0);
    }
    if (data.WPT_RADII !== undefined) {
      this.processMoosVariable('WPT_RADII', data.WPT_RADII);
    }
    if (data.SERVICE_MODE !== undefined) {
      this.app.data.moosIvPServer.serviceMode =
        data.SERVICE_MODE === 'true' || data.SERVICE_MODE === '1' || data.SERVICE_MODE === true;
    }
    if (data.PID_GAINS !== undefined) {
      this.processPidGains(data.PID_GAINS);
    }
    if (data.COLAV_TEST !== undefined) {
      this.app.data.moosIvPServer.colavTest =
        data.COLAV_TEST === 'true' || data.COLAV_TEST === '1' || data.COLAV_TEST === true;
    }
    if (data.COLAV_TEST_ACK !== undefined) {
      const ack =
        data.COLAV_TEST_ACK === 'true' || data.COLAV_TEST_ACK === '1' || data.COLAV_TEST_ACK === true;
      this.app.data.moosIvPServer.colavTestAck = ack;
      this.syncColavTest(ack);
    }
    if (data.AIS_RADIUS !== undefined) {
      this.processAisLimit(data.AIS_RADIUS);
    }
    if (data.COLAV_DIST !== undefined) {
      this.app.data.moosIvPServer.colavDist = data.COLAV_DIST;
      this.processColavDist(data.COLAV_DIST);
    }
    // iWebSocket re-sends its cached COLAV_METRICS on every tick; parsing an
    // unchanged one 20 times a second buys nothing, and the change is also
    // what tells the COLREGS box the evaluator is still alive.
    if (data.COLAV_METRICS !== undefined &&
        data.COLAV_METRICS !== this.app.data.moosIvPServer.colavMetrics) {
      this.app.data.moosIvPServer.colavMetrics = data.COLAV_METRICS;
      this.processColavMetrics(data.COLAV_METRICS);
    }
    if (data.TRAFFIC_SPAWNED !== undefined &&
        data.TRAFFIC_SPAWNED !== this.app.data.moosIvPServer.trafficSpawned) {
      this.app.data.moosIvPServer.trafficSpawned = data.TRAFFIC_SPAWNED;
      this.processTrafficSpawned(data.TRAFFIC_SPAWNED);
    }
    if (data.TRAFFIC_TARGETS !== undefined) {
      this.app.data.moosIvPServer.trafficTargets = data.TRAFFIC_TARGETS;
      this.colavTest.targets = data.TRAFFIC_TARGETS
        ? String(data.TRAFFIC_TARGETS).split(',').filter((t: string) => t !== '')
        : [];
    }

    // Engine status (all numeric)
    if (data.ENGINE_ACCELERATOR_PEDAL_POSITION !== undefined) {
      this.engineStatus.acceleratorPedalPosition = data.ENGINE_ACCELERATOR_PEDAL_POSITION;
    }
    if (data.ENGINE_PERCENT_LOAD !== undefined) {
      this.engineStatus.percentLoad = data.ENGINE_PERCENT_LOAD;
    }
    if (data.ENGINE_SPEED !== undefined) {
      this.engineStatus.speed = data.ENGINE_SPEED;
    }
    if (data.ENGINE_PERCENT_TORQUE !== undefined) {
      this.engineStatus.percentTorque = data.ENGINE_PERCENT_TORQUE;
    }
    if (data.ENGINE_ACTIVE_DTCS !== undefined) {
      this.engineStatus.activeDtcs = 0; // Kept as 0 per existing code
    }
    if (data.ENGINE_COOLANT_TEMP !== undefined) {
      this.engineStatus.coolantTemp = data.ENGINE_COOLANT_TEMP;
    }
    if (data.ENGINE_OIL_TEMP !== undefined) {
      this.engineStatus.oilTemp = data.ENGINE_OIL_TEMP;
    }
    if (data.ENGINE_OIL_PRESSURE !== undefined) {
      this.engineStatus.oilPressure = data.ENGINE_OIL_PRESSURE;
    }
    if (data.ENGINE_FUEL_RATE !== undefined) {
      this.engineStatus.fuelRate = data.ENGINE_FUEL_RATE;
    }
    if (data.ENGINE_INTAKE_MANIFOLD_PRESSURE !== undefined) {
      this.engineStatus.intakeManifoldPressure = data.ENGINE_INTAKE_MANIFOLD_PRESSURE;
    }
    if (data.ENGINE_BATTERY_VOLTAGE !== undefined) {
      const voltage = this.app?.data?.vessels?.self?.electrical?.batteries?.House?.voltage;
      this.engineStatus.batteryVoltage = typeof voltage === 'number' ? voltage : 0;
    }

    // Contact info (nested object)
    if (data.CONTACT_INFO && data.CONTACT_INFO.NAME) {
      this.processContactInfoFromJson(
        data.CONTACT_INFO.NAME,
        data.CONTACT_INFO.LAT,
        data.CONTACT_INFO.LON,
        data.CONTACT_INFO.SPD,
        data.CONTACT_INFO.HDG
      );
    }
  }

  /** Process contact info from JSON format */
  private processContactInfoFromJson(name: string, lat: number, lon: number, speed: number, heading: number) {
    try {
      if (!name || isNaN(lat) || isNaN(lon)) {
        return;
      }

      const contactId = `moos-contact.${name}`;
      const moosContact = {
        id: contactId,
        name: name,
        mmsi: '',
        position: [lon, lat] as [number, number],
        state: '',
        type: { id: 30, name: 'MOOS Contact' },
        properties: {},
        lastUpdated: new Date(),
        callsignVhf: '',
        callsignHf: '',
        orientation: heading * (Math.PI / 180),
        virtual: false,
        sog: speed,
        heading: heading,
        cog: heading
      };

      this.app.data.moosContacts.set(contactId, moosContact);
      this.app.data.moosContactMgr.updateList = [contactId];
    } catch (error) {
      console.error('[MOOS CONTACT] Error processing JSON contact info:', error);
    }
  }

  /** process CONTACT_INFO message from MOOS-IvP */
  private processContactInfo(value: string) {
    try {
      // Parse format: NAME:target,LAT:<latitude>,LON:<longitude>,SPD:<speed>,HDG:<heading>
      const parts = value.split(',');
      const contact: any = {};

      parts.forEach(part => {
        const [key, val] = part.split(':');
        if (key && val) {
          contact[key.trim()] = val.trim();
        }
      });

      if (!contact.NAME) {
        // Only log if there's actual contact data (not empty/zero values)
        const hasData = contact.LAT || contact.LON || contact.SPD || contact.HDG;
        //if (hasData && contact.LAT !== '0.000000' && contact.LON !== '0.000000') {
        //  console.error('[MOOS CONTACT] Missing NAME in contact info:', value);
        //}
        return;
      }

      const name = contact.NAME;
      const lat = parseFloat(contact.LAT);
      const lon = parseFloat(contact.LON);
      const speed = parseFloat(contact.SPD) || 0;
      const heading = parseFloat(contact.HDG) || 0;

      if (isNaN(lat) || isNaN(lon)) {
        console.error('[MOOS CONTACT] Invalid coordinates for contact:', name, value);
        return;
      }

      // Create or update contact
      // Key must include context prefix for the layer component to find it
      const contactId = `moos-contact.${name}`;
      const moosContact = {
        // SKTargetBase properties
        id: contactId,
        name: name,
        mmsi: '', // MOOS contacts don't have MMSI
        position: [lon, lat] as [number, number], // SignalK format: [longitude, latitude]
        state: '',
        type: { id: 30, name: 'MOOS Contact' }, // Use AIS type 30 for generic vessel icon
        properties: {},
        lastUpdated: new Date(),
        callsignVhf: '',
        callsignHf: '',
        orientation: heading * (Math.PI / 180), // Convert to radians for map display
        virtual: false, // Not a virtual target
        // SKVessel-like properties for rendering
        sog: speed,
        heading: heading,
        cog: heading
      };

      this.app.data.moosContacts.set(contactId, moosContact);

      // Trigger map update by creating new array reference (Angular change detection)
      // Always include the updated contact ID
      this.app.data.moosContactMgr.updateList = [contactId];

      console.log('[MOOS CONTACT] Updated contact:', contactId, moosContact);
    } catch (error) {
      console.error('[MOOS CONTACT] Error processing contact info:', value, error);
    }
  }

  /** Start periodic cleanup of stale MOOS contacts */
  private startMoosContactCleanup() {
    // Run cleanup every 2 seconds
    this.moosContactCleanupTimer = setInterval(() => {
      this.cleanupStaleContacts();
      this.expireStaleColregs();
    }, 2000);
  }

  /** Stop MOOS contact cleanup timer */
  private stopMoosContactCleanup() {
    if (this.moosContactCleanupTimer) {
      clearInterval(this.moosContactCleanupTimer);
      this.moosContactCleanupTimer = null;
    }
  }

  /** Remove contacts that haven't been updated in MOOS_CONTACT_TIMEOUT ms */
  private cleanupStaleContacts() {
    const now = Date.now();
    const expiredContacts: string[] = [];

    this.app.data.moosContacts.forEach((contact, contactId) => {
      const timeSinceUpdate = now - contact.lastUpdated.getTime();
      if (timeSinceUpdate > this.MOOS_CONTACT_TIMEOUT) {
        expiredContacts.push(contactId);
      }
    });

    if (expiredContacts.length > 0) {
      expiredContacts.forEach(contactId => {
        this.app.data.moosContacts.delete(contactId);
        console.log('[MOOS CONTACT] Removed stale contact:', contactId);
      });

      // Notify map to remove the expired contacts
      this.app.data.moosContactMgr.removeList = [...expiredContacts];
    }
  }

  /** disconnect from MOOS-IvP server */
  private disconnectMoosIvPServer() {
    this.moosWsService.disconnect();
    this.app.data.moosIvPServer.colregs = null;
    this.app.data.moosIvPServer.socket = null;
    this.app.data.moosIvPServer.connected = false;
    this.app.data.connectionState.moosIvP.connected = false;
    this.app.data.connectionState.moosIvP.connecting = false;
  }

  /** send command to MOOS-IvP server */
  public sendMoosIvPCommand(command: string) {
    if (this.replay.isReplaying()) {
      this.app.debug(`[REPLAY] suppressed outbound MOOS: ${command}`);
      return;
    }
    if (this.moosWsService.isConnected()) {
      const success = this.moosWsService.send(command);
      if (!success) {
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
      this.app.data.moosIvPServer.connected &&
      this.app.data.moosIvPServer.socket
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
      const message = `AUTONOMOUS_WAYPOINTS=${waypointString}`;
      this.app.data.moosIvPServer.socket.send(message);
      console.log('[ROUTE SAVE] Sent AUTONOMOUS_WAYPOINTS to MOOS-IvP:', message);
    } else {
      console.error('[ROUTE SAVE] Mission Management System connection not available');
    }
  }

  /** send region polygon points to MOOS-IvP server */
  private sendRegionToMOOS(coordinates: any[]) {
    if (
      this.app.data.moosIvPServer &&
      this.app.data.moosIvPServer.connected &&
      this.app.data.moosIvPServer.socket
    ) {
      // Region coordinates: outer ring is coordinates[0]
      // SignalK stores as [longitude, latitude], send as lat,lon
      const ring = coordinates[0];
      const ptsString = ring.map(point => {
        const lat = point[1];
        const lon = point[0];
        return `${lat},${lon}`;
      }).join(':');

      const message = `REGION_UPDATES=core_poly=pts={${ptsString}}`;
      this.app.data.moosIvPServer.socket.send(message);
      console.log('[REGION] Sent REGION_UPDATES to MOOS-IvP:', message);
    } else {
      console.warn('[REGION] MOOS-IvP not connected, region not sent to backend');
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
      const currentUrl = `${this.app.config.moosIvP.url}:${this.app.config.moosIvP.port}`;
      const connectedUrl = this.app.data.moosIvPServer.url;

      if (this.app.config.moosIvP.enabled && this.app.config.moosIvP.autoConnect) {
        // Check if URL/port changed - if so, reconnect
        if (this.app.data.connectionState.moosIvP.connected && connectedUrl !== currentUrl) {
          this.app.showMessage(`MOOS-IvP URL changed, reconnecting to ${currentUrl}`, false, 3000);
          this.disconnectMoosIvPServer();
          // Reconnect after a brief delay
          setTimeout(() => this.connectMoosIvPServer(), 1000);
        } else if (!this.app.data.connectionState.moosIvP.connected && !this.app.data.connectionState.moosIvP.connecting) {
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
      this.display.stationKeepPanelOpen = false;
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

  // ** handle region activation from map **
  public onRegionActivated(event: { id: string, coordinates: any[] }) {
    console.log('[REGION] Region activated:', event.id);
    if (this.app.data.moosIvPServer?.connected && this.app.data.moosIvPServer?.socket) {
      // Build REGION_UPDATES string from coordinates
      const ring = event.coordinates[0];
      const ptsString = ring.map(point => {
        const lat = point[1];
        const lon = point[0];
        return `${lat},${lon}`;
      }).join(':');

      const message = `REGION=true#REGION_UPDATES=core_poly=pts={${ptsString}}`;
      this.app.data.moosIvPServer.socket.send(message);
      console.log('[REGION] Sent to MOOS-IvP:', message);
    }
  }

  // ** handle region deactivation from map **
  public onRegionDeactivated() {
    console.log('[REGION] Region deactivated');
    if (this.app.data.moosIvPServer?.connected && this.app.data.moosIvPServer?.socket) {
      this.app.data.moosIvPServer.socket.send('REGION=false');
      console.log('[REGION] Sent REGION=false to MOOS-IvP');
    }
  }

  // ** Sync region activation state from MOOS-IvP (on page refresh) **
  private syncRegionFromMOOS() {
    if (!this.app.data.moosIvPServer?.regionActive) {
      console.log('[REGION SYNC] REGION is false on backend, no re-activation needed');
      return;
    }

    console.log('[REGION SYNC] REGION is true on backend, attempting re-activation...');

    // Get the first available region from the cache
    const regions = this.skres.regions();
    if (!regions || regions.length === 0) {
      console.warn('[REGION SYNC] No regions available to activate');
      return;
    }

    // Activate the first region
    const firstRegion = regions[0];
    const regionId = firstRegion[0];
    const regionData = firstRegion[1];

    if (regionData?.feature?.geometry?.coordinates) {
      // Set activeRegionId on the map component for visual highlighting
      if (this.fbMapRef) {
        this.fbMapRef.activeRegionId = regionId;
        console.log('[REGION SYNC] Set activeRegionId on map:', regionId);
      }

      // Call the same handler as clicking Activate to send data to MOOS-IvP
      this.onRegionActivated({
        id: regionId,
        coordinates: regionData.feature.geometry.coordinates
      });
      console.log('[REGION SYNC] Re-activated region:', regionId, regionData.name);
    } else {
      console.warn('[REGION SYNC] First region has no valid geometry:', regionId);
    }
  }

  // ** Increment / decrement next active route point **
  public routeNextPoint(pointIndex: number) {
    this.course.coursePointIndex(pointIndex);
    this.focusMap();
  }

  // ** save station keep configuration to route metadata **
  private async saveStationKeepToRoute(
    routeId: string,
    pointIndex: number,
    config: StationKeepConfig
  ) {
    try {
      // Fetch the current route
      const route = await this.skres.fromServer('routes', routeId);
      if (!route) {
        return;
      }

      const routeData = route as any;

      // Initialize coordinatesMeta if it doesn't exist
      if (!routeData.feature.properties) {
        routeData.feature.properties = {};
      }
      if (!routeData.feature.properties.coordinatesMeta) {
        routeData.feature.properties.coordinatesMeta = [];
      }

      const coordsMeta = routeData.feature.properties.coordinatesMeta;

      // Ensure metadata array has entries for all points
      const coordinates = routeData.feature.geometry.coordinates;
      while (coordsMeta.length < coordinates.length) {
        // Add metadata with required 'name' property to satisfy schema
        coordsMeta.push({
          name: `Point ${coordsMeta.length + 1}`
        });
      }

      // Save station keep configuration to the point metadata
      if (!coordsMeta[pointIndex]) {
        coordsMeta[pointIndex] = {
          name: `Point ${pointIndex + 1}`
        };
      }

      // Preserve existing name if it exists
      if (!coordsMeta[pointIndex].name) {
        coordsMeta[pointIndex].name = `Point ${pointIndex + 1}`;
      }

      coordsMeta[pointIndex].stationKeep = {
        innerRadius: config.innerRadius,
        outerRadius: config.outerRadius,
        timeToKeep: config.timeToKeep
      };

      // Update the route with the new metadata
      this.skres.updateRouteCoords(
        routeId,
        coordinates,
        coordsMeta
      );

      // Refresh routes to show updated data
      this.skres.refreshRoutes();
    } catch (err) {
      this.app.parseHttpErrorResponse(err);
    }
  }

  // ** delete station keep configuration from route metadata **
  private async deleteStationKeepFromRoute(
    routeId: string,
    pointIndex: number
  ) {
    try {
      // Fetch the current route
      const route = await this.skres.fromServer('routes', routeId);
      if (!route) {
        return;
      }

      const routeData = route as any;
      const coordsMeta = routeData.feature.properties?.coordinatesMeta;

      if (!coordsMeta || !coordsMeta[pointIndex] || !coordsMeta[pointIndex].stationKeep) {
        this.app.showMessage('No Station Keep configuration found at this point', true, 3000);
        return;
      }

      // Remove station keep configuration from the point metadata
      delete coordsMeta[pointIndex].stationKeep;

      // Update the route with the modified metadata
      const coordinates = routeData.feature.geometry.coordinates;
      this.skres.updateRouteCoords(
        routeId,
        coordinates,
        coordsMeta
      );

      // Clear station keep circles from the map
      this.app.data.map.stationKeepPosition = null;
      this.hideStationKeepCircles = true;

      // Refresh routes to show updated data
      this.skres.refreshRoutes();

      this.app.showMessage(
        'Station Keep configuration deleted from route point',
        false,
        3000
      );
    } catch (err) {
      this.app.parseHttpErrorResponse(err);
    }
  }

  // ** show feature (vessel/AtoN/Aircraft/Route points) properties **
  public async featureProperties(e: { id: string; type: string }) {
    let v: FBRoute | SKVessel | SKSaR | SKAircraft | SKAtoN;
    if (e.type === 'route-stationkeep') {
      // Handle station keep for route - show route points selection
      try {
        this.app.sIsFetching.set(true);
        v = await this.skres.fromServer('routes', e.id);
        this.app.sIsFetching.set(false);
        if (v) {
          const route = v as any;
          const coordinates = route.feature.geometry.coordinates;
          const coordinatesMeta = route.feature.properties?.coordinatesMeta || [];

          if (coordinates && coordinates.length > 0) {
            // Create list of route points for selection
            const pointList = coordinates.map((coord: number[], index: number) => {
              const meta = coordinatesMeta[index] || {};
              const name = meta.name || `Point ${index + 1}`;
              const skMarker = meta.stationKeep ? ' [SK]' : '';
              return {
                id: index.toString(),
                name: `${name}${skMarker} (${coord[1].toFixed(6)}, ${coord[0].toFixed(6)})`
              };
            });

            // Show point selection dialog
            this.dialog
              .open(SingleSelectListDialog, {
                data: {
                  title: 'Select Route Point for Station Keep',
                  icon: { name: 'adjust' },
                  items: pointList
                }
              })
              .afterClosed()
              .subscribe((selectedPoint) => {
                if (selectedPoint) {
                  const pointIndex = parseInt(selectedPoint.id);
                  const position = coordinates[pointIndex];

                  // Get existing station keep config from route metadata if available
                  const existingConfig = coordinatesMeta[pointIndex]?.stationKeep;

                  // Show station keep configuration dialog
                  const config: StationKeepConfig = {
                    innerRadius: existingConfig?.innerRadius || 10,
                    outerRadius: existingConfig?.outerRadius || 25,
                    timeToKeep: existingConfig?.timeToKeep || 300, // Default 5 minutes (300 seconds)
                    position: position,
                    pointIndex: pointIndex
                  };

                  this.dialog
                    .open(StationKeepDialog, {
                      data: {
                        title: 'Configure Station Keep',
                        config: config,
                        hasExisting: !!existingConfig
                      }
                    })
                    .afterClosed()
                    .subscribe(async (result) => {
                      if (result && result.save) {
                        // Save the station keep configuration to route metadata
                        await this.saveStationKeepToRoute(
                          e.id,
                          pointIndex,
                          result.config
                        );

                        // Set the position to show the station keep circles on the map
                        this.app.data.map.stationKeepPosition = result.config.position;
                        // Update the station keep radii for display
                        this.stationKeep.innerRadius = result.config.innerRadius;
                        this.stationKeep.outerRadius = result.config.outerRadius;
                        // Toggle hideStationKeepCircles to trigger change detection and show circles
                        this.hideStationKeepCircles = true;
                        setTimeout(() => {
                          this.hideStationKeepCircles = false;
                        }, 0);

                        this.app.showMessage(
                          'Station Keep configuration saved to route',
                          false,
                          3000
                        );
                      } else if (result && result.delete) {
                        // Delete the station keep configuration from route metadata
                        await this.deleteStationKeepFromRoute(
                          e.id,
                          pointIndex
                        );
                      }
                    });
                }
              });
          }
        }
      } catch (err) {
        this.app.sIsFetching.set(false);
        this.app.parseHttpErrorResponse(err);
      }
    } else if (e.type === 'route') {
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

  // ******** MISSION REPLAY ************

  /** clock shown in the playback panel */
  private formatPlaybackClock(d: Date): string {
    return `${d.toDateString().slice(4)} ${d.toTimeString().slice(0, 8)}`;
  }

  /** toggle mission recording */
  public async toggleRecording() {
    // Finalising uploads the tail and closes the recording server-side, which
    // takes a moment. Ignore presses until it lands: a second press would either
    // claim a stop that has not happened yet or, once the state flips to idle,
    // silently start a new recording.
    if (this.replay.isFinalizing()) {
      return;
    }
    this.focusMap();
    if (this.replay.isRecording()) {
      await this.replay.stopRecording();
      this.app.showMessage('Recording stopped.', false, 3000);
    } else {
      await this.replay.startRecording();
      if (this.replay.isRecording()) {
        this.app.showMessage('Recording mission...', false, 3000);
      }
    }
  }

  /** pick a recording and enter replay mode */
  public showMissionReplay() {
    if (this.mode === SKSTREAM_MODE.PLAYBACK) {
      this.exitMissionReplay();
      return;
    }
    if (this.replay.isBusy()) {
      this.app.showAlert(
        'Stop the current recording before starting a replay.',
        'Recording in progress'
      );
      return;
    }
    this.dialog
      .open(ReplayListDialog, { data: {}, minWidth: '400px' })
      .afterClosed()
      .subscribe(async (selected: RecordingMeta) => {
        if (selected) {
          await this.enterMissionReplay(selected);
        }
        this.focusMap();
      });
  }

  private async enterMissionReplay(rec: RecordingMeta) {
    if (!(await this.replay.load(rec))) {
      return;
    }
    // Keep the live trail; the replay trail is derived from the recording.
    this.app.db.saveTrail('self', this.app.data.trail);
    this.app.data.trail = [];
    this.switchActiveVessel();
    this.resetMoosState();

    // Close the live sockets and keep them closed. onClose() would otherwise
    // reopen immediately (commanded) or after 5s (unexpected).
    this.replaySuppressReconnect = true;
    this.stream.replayActive = true;
    this.moosWsService.disconnect();
    this.mode = SKSTREAM_MODE.PLAYBACK;
    this.replay.enterReplay(rec.selfId ?? this.app.data.selfId);

    // queryAfterConnect() no longer runs, so routes/waypoints would be missing
    // and a replayed active route would have nothing to draw.
    this.fetchResources(true);

    this.app.showMessage(`Replaying: ${rec.name}`, false, 3000);
  }

  public exitMissionReplay() {
    this.stream.replayActive = false;
    this.resetMoosState();
    this.switchActiveVessel();
    this.mode = SKSTREAM_MODE.REALTIME;
    this.display.playback.time = null;
    this.app.db.getTrail('self').then((t) => {
      this.app.data.trail = t && t.value ? t.value : [];
    });

    // Prime the realtime reopen BEFORE tearing the replay down: replayStop makes
    // the worker post a commanded close, and onClose() is what actually reopens.
    // Opening here instead would race - the worker still holds the replay stream,
    // so openStream() would no-op and nothing would reconnect.
    this.streamOptions = { options: null, toMode: SKSTREAM_MODE.REALTIME };
    this.replaySuppressReconnect = false;
    this.replay.exitReplay();

    this.connectMoosIvPServer();
    this.focusMap();
  }

  /**
   * Wipes everything MOOS-derived. Needed before a backward seek, because none
   * of this state is re-derivable from a single delta - it accumulates.
   * Connection fields and the operator's own selections are preserved.
   */
  private resetMoosState() {
    Object.assign(this.app.data.moosIvPServer, initMoosIvPData());
    this.app.data.moosContacts.clear();
    this.app.data.moosContactMgr.updateList = [];
    this.app.data.moosContactMgr.removeList = [];

    Object.assign(this.autonomousControl, initAutonomousControlData());
    this.engineStatus = initEngineStatus();
    this.trimControl.state = 'idle';
    this.clearTrimAckTimer();
    this.remoteControl.boatGear = null;
    this.remoteControl.boatThrust = null;

    this.servicePid.enabled = false;
    this.servicePid.applied = null;
    this.servicePid.pendingConfirm = false;

    this.stationKeep.status = 'standby';
    this.stationKeep.position = null;

    if (this.activeWaypointStationKeep.timer) {
      clearInterval(this.activeWaypointStationKeep.timer);
    }
    this.activeWaypointStationKeep = {
      active: false,
      innerRadius: 0,
      outerRadius: 0,
      timeToKeep: 0,
      timeRemaining: 0,
      position: null,
      timer: null
    };

    // AIS tracks only ever shrink via removeList, so a rewind would otherwise
    // leave ghost tracks behind.
    this.app.data.vessels.aisTracks.clear();
    this.app.data.navData.pointIndex = -1;
    this.clearCourseData();
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
    // If drawing a route, ask user to choose polygon or circle
    if (f === 'route') {
      console.log('[DRAW FEATURE] Showing route type dialog...');
      this.app
        .showConfirm(
          'Choose route type:',
          'Draw Route',
          'Polygon',
          'Circle'
        )
        .subscribe((result) => {
          console.log('[DRAW FEATURE] Dialog result:', result);
          if (result?.ok) {
            // User chose Button 1 (Polygon)
            console.log('[DRAW FEATURE] Starting polygon route drawing');
            this.mapInteract.startDrawing('route');
          } else if (result === null) {
            // User chose Button 2 (Circle)
            console.log('[DRAW FEATURE] Starting circle route drawing');
            this.mapInteract.startDrawing('circle-route');
          } else {
            console.log('[DRAW FEATURE] Dialog cancelled or closed');
          }
        });
    } else {
      this.mapInteract.startDrawing(f);
    }
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
      case 'circle-route':
        // Handle circle route the same as a regular route
        this.skres.newRouteAt(e.coordinates as LineString);
        break;
      case 'region':
        const region = new SKRegion();
        region.feature.geometry.coordinates = [
          GeoUtils.normaliseCoords(e.coordinates as Polygon)
        ];
        const regionObs = this.skres.newRegion(region);
        if (regionObs) {
          regionObs.subscribe((r: { save: boolean; region: any }) => {
            if (r.save) {
              this.sendRegionToMOOS(r.region.feature.geometry.coordinates);
            }
          });
        }
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
            `Do you want to save the changes made to ${this.mapInteract.draw.forSave.id.split('.')[0]
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
                // Send updated waypoints to MOOS-IvP
                console.log('[ROUTE SAVE] Sending updated waypoints to MOOS-IvP:', this.mapInteract.draw.forSave.coords);
                this.sendWaypointsToMOOS(this.mapInteract.draw.forSave.coords);
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
                // Send updated region to MOOS-IvP
                this.sendRegionToMOOS(this.mapInteract.draw.forSave.coords);
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
    if (this.replaySuppressReconnect) {
      // mission replay owns the pipeline now - stay closed
      return;
    }
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
        this.display.playback.time = this.formatPlaybackClock(
          new Date(e.timestamp)
        );
        // This update carries the raw recorded fix, which is up to a full fix
        // interval behind the virtual clock. Put the vessel back on the
        // interpolated track before change detection renders the frame.
        this.replay.applyInterpolatedPosition();
      } else {
        this.display.playback.time = null;
        this.setDarkTheme();
      }

      // Sync battery voltage from Signal K to engine status
      const voltage = this.app?.data?.vessels?.self?.electrical?.batteries?.House?.voltage;
      this.engineStatus.batteryVoltage = typeof voltage === 'number' ? voltage : 0;

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
