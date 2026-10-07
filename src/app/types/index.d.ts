// ** Resource Types **

import { Position, LineString, MultiLineString } from './resources/geojson';
import { FBCharts, FBRoute } from './resources/freeboard';
import {
  SKMeteo,
  SKSaR,
  SKAtoN,
  SKAircraft,
  SKVessel
} from '../modules/skresources/resource-classes';

export * from './resources/signalk';
export * from './resources/custom';
export * from './resources/geojson';
export * from './resources/freeboard';
export * from './stream';

export type ErrorList = Array<{ status: number; message: string }>;

export interface MOOSContact {
  // SKTargetBase properties
  id: string;
  name: string;
  mmsi: string;
  position: Position; // [longitude, latitude]
  state: string;
  type: { id: number; name: string };
  properties: { [key: string]: any };
  lastUpdated: Date;
  callsignVhf: string;
  callsignHf: string;
  orientation: number; // radians
  virtual: boolean;
  // SKVessel-like properties
  sog: number; // speed over ground (knots)
  heading: number; // degrees
  cog: number; // course over ground (degrees)
}

/**
 * One collision avoidance encounter, as measured by pColavEval and delivered
 * in the COLAV_METRICS JSON array.
 *
 * Numeric fields carry -1 for "has not happened yet" rather than null, so the
 * panel can render them uniformly. Ranges are metres, times seconds, angles
 * degrees.
 */
/**
 * What the collision avoidance behaviour is doing right now, phrased for the
 * box drawn over the boat on the chart. Derived from the COLREGS mode the
 * behaviour reports (BHV_AvdColregsV22's $[FULL_MODE]).
 */
export interface ColregsStatus {
  rule: string;        // 'Rule 16', or '' when the mode carries no COLREGS rule
  name: string;        // 'Give-way'
  action: string;      // what the boat is doing about it
  tone: 'act' | 'hold' | 'urgent';
  icon: string;        // material icon for the box
  target: string;      // contact name, AIS name when one is known
  detail: string;      // range and TCPA, formatted - the box has no pipes
  others: number;      // further contacts being avoided at the same time
  mode: string;        // raw $[FULL_MODE], e.g. "giveway:stern"
}

export interface ColavEncounter {
  id: string;
  cn: string;
  mmsi: number;
  test: boolean;                 // placed from the UI, vs. scenario traffic
  state: 'live' | 'past_cpa' | 'done';
  active: boolean;               // the behaviour is influencing the helm right now
  verdict: 'pending' | 'clear' | 'near_miss' | 'collision' | 'no_data';

  range: number;                 // live range to the contact
  minRange: number;              // closest actually achieved - ground truth
  cpaPred: number;               // predicted CPA at the moment of detection
  cpaLive: number;
  tcpa: number;

  rngDetect: number;             // range when the behaviour picked it up
  rngActive: number;             // range when it first influenced the helm
  reaction: number;              // seconds from detect to first influence
  pipeline: number;              // seconds from placement to detection
  duration: number;
  durActive: number;
  spans: number;                 // times it entered the ACTIVE state

  mode: string;                  // COLREGS mode, e.g. "giveway:bow"
  modes: string;                 // every distinct mode, in order
  apwtMax: number;

  deflection: number;            // max heading change since the behaviour took the helm
  desDeflection: number;
  deflectionValid: boolean;      // false if a waypoint change muddied it
  spdMin: number;

  ucdCpa: number;                // uFldCollisionDetect's independent CPA, -1 if absent
  postMortem: string;            // why the behaviour ended, from the helm
  endReason: string;
}

export interface SKApiResponse {
  state: 'FAILED' | 'COMPLETED' | 'PENDING';
  statusCode: number;
  message: string;
  requestId?: string;
  href?: string;
  token?: string;
}

export interface IAppConfig {
  ui: {
    mapNorthUp: boolean;
    mapMove: boolean; // keep vessel centered
    mapConstrainZoom: boolean; // constrain zooming to map min / max values
    toolbarButtons: boolean; // show/hide toolbar buttons
    invertColor: boolean; // invert map feature label colors
  };
  chartApi: number; // temp: use v{1|2}/api/resources/charts
  experiments: boolean;
  version: string;
  darkMode: { enabled: boolean; source: 0 | 1 | -1 }; // source: 0= browser default, 1= Signal K mode, -1=manual)
  nightMode: boolean; // auto set night mode based on environment.mode
  map: {
    // ** map config
    zoomLevel: number;
    center: Position;
    rotation: number;
    lockMoveMap: boolean;
    animate: boolean;
  };
  fixedLocationMode: boolean;
  fixedPosition: Position;
  aisTargets: boolean; // display ais targets
  courseData: boolean; // show/hide course data
  notes: boolean; // display notes
  popoverMulti: boolean; // close popovers using cose button
  mapDoubleClick: boolean; // true=zoom
  muteSound: boolean;
  depthAlarm: { enabled: boolean; smoothing: number };
  anchorRadius: number; // most recent anchor radius setting
  anchorSetRadius: boolean; // checks inital anchor radius setting
  anchorManualSet: boolean; // checks manual set setting
  anchorRodeLength: number; // rode length setting
  plugins: {
    instruments: string;
    startOnOpen: boolean;
    parameters: string | null;
  };
  units: {
    // ** display units
    distance: 'm' | 'ft';
    depth: 'm' | 'ft';
    speed: 'kn' | 'msec' | 'kmh' | 'mph';
    temperature: 'c' | 'f';
  };
  selections: {
    // ** saved selections
    routes: string[];
    waypoints: string[];
    tracks: string[] | null;
    charts: string[];
    chartOrder: string[]; // chart layer ordering
    headingAttribute: 'navigation.headingTrue' | 'navigation.headingMagnetic';
    preferredPaths: {
      tws: string;
      twd: string;
      heading: string;
      course: string;
    };
    vessel: {
      trail: boolean; // display trail
      windVectors: boolean; // display vessel TWD, AWD vectors
      laylines: boolean;
      cogLine: number; // (minutes) length = cogLine * sog
      aisCogLine: number; // (minutes) length = cogLine * sog
      headingLineSize: number; // mode for display of heading line -1 = default
      iconScale: number; // scale to apply to self Vessel icon
    };
    positionFormat: 'XY' | 'SHDd' | 'HDd' | 'DMdH' | 'HDMS' | 'DHMS';
    aisTargets: string[];
    aisTargetTypes: number[];
    aisFilterByShipType: boolean;
    aisWindApparent: boolean;
    aisWindMinZoom: number;
    aisShowTrack: boolean;
    aisMaxAge: number; // time since last update in ms (9 min)
    aisStaleAge: number; // time since last update in ms (6 min)
    aisProfile: number; // ais display profile
    aisState: string[]; // list of ais state values used to filter targets
    notesMinZoom: number;
    labelsMinZoom: number;
    pluginFavourites: string[];
    trailFromServer: boolean;
    trailDuration: number; // number of hours of trail to fetch from server
    trailResolution: {
      // resolution of server trail at defined time horizons
      lastHour: string;
      next23: string;
      beyond24: string;
    };
    s57Options: {
      graphicsStyle: 'Simplified' | 'Paper';
      boundaries: 'Symbolized' | 'Plain';
      colors: 2 | 4;
      shallowDepth: number;
      safetyDepth: number;
      deepDepth: number;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resourceSets: { [key: string]: any }; // additional resources
    signalk: {
      // signal k connection options
      vessels: boolean;
      atons: boolean;
      aircraft: boolean;
      sar: boolean;
      meteo: boolean;
      maxRadius: number; // max radius within which AIS targets are displayed
      proxied: boolean; // server behind a proxy server
    };
    wakeLock: boolean;
    course: {
      autoNextPointOnArrival: boolean;
      autoNextPointDelay: number;
      autoNextPointTrigger: 'perpendicularPassed' | 'arrivalCircleEntered';
    };
    remoteControl: boolean;
    autonomousControl: boolean;
    radarControl: boolean;
    servicePid?: {
      // last PID gains calibrated from the UI (service mode)
      enabled: boolean;
      heading: { kp: number; ki: number; kd: number };
      speed: { kp: number; ki: number; kd: number };
    };
    // draw the capture / slip radius circles around each route waypoint
    showWaypointRadii?: boolean;
    // parameters for a target placed by right-click > Put Target during a
    // collision avoidance test
    colavTarget?: {
      speed: number;                        // knots
      courseMode: 'at_usv' | 'fixed';
      course: number;                       // degrees, when courseMode is fixed
      vesselType: string;
      length: number;
      beam: number;
    };
    // engagement distances last pushed into the collision avoidance
    // behaviour (BHV_AvdColregsV22 / avdcol_), all in metres
    colavDist?: {
      outer: number;        // pwt_outer_dist
      inner: number;        // pwt_inner_dist
      completed: number;    // completed_dist
      minCpa: number;       // min_util_cpa_dist
      maxCpa: number;       // max_util_cpa_dist
    };
    // last "Follow AIS contact" standoff distance (m) and relative angle (deg)
    aisFollowRange?: number;
    aisFollowAngle?: number;
  };
  resources: {
    // ** resource options
    fetchFilter: string; // param string to provide record filtering
    fetchRadius: number; // radius (NM/km) within which to return resources
    notes: {
      rootFilter: string; // param string to provide record filtering
      getRadius: number; // radius (NM/km) within which to return notes
      groupNameEdit: boolean;
      groupRequiresPosition: boolean;
    };
    video: {
      enable: boolean;
      url: string | null;
    };
    paths: string[];
  };
  moosIvP: {
    enabled: boolean;
    url: string;
    port: number;
    autoConnect: boolean;
  };
  signalk: {
    enabled: boolean;
    url: string;
    port: number;
    autoConnect: boolean;
  };
  radar: {
    enabled: boolean;
    url: string;
    port: number;
    autoConnect: boolean;
  };
  /** Mission replay recorder tuning */
  replay?: {
    /** seconds of capture buffered before a chunk is uploaded */
    chunkSeconds: number;
    /** bytes of capture buffered before a chunk is uploaded */
    chunkBytes: number;
  };
}

export interface FBAppData {
  n2kRoute: FBRoute;
  loginRequired: boolean;
  hasWakeLock: boolean;
  chartBounds: {
    show: boolean;
    charts: FBCharts;
  };
  selfId: string;
  activeRoute: string;
  activeRouteReversed: boolean;
  activeRouteCircular: boolean;
  activeRouteIsEditing: boolean;
  editingId: string;
  activeWaypoint: string;
  trail: LineString; // self vessel track / trail
  serverTrail: boolean; // trail received from server
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: { [key: string]: any }; // SK server info
  lastGet: Position; // map position of last resources GET
  map: {
    atClick: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      features: any[];
      lonlat: Position;
    };
    stationKeepPosition?: Position;
    basePosition?: Position;
    colavTargetPosition?: Position;
  };
  vessels: {
    // received vessel data
    showSelf: boolean;
    self: SKVessel;
    aisTargets: Map<string, SKVessel>;
    aisTracks: Map<string, MultiLineString>; // AIS targets track (tracks plugin)
    activeId: string;
    active: SKVessel;
    closest: string[];
    prefAvailablePaths: { [key: string]: string }; // preference paths available from source
    flagged: string[];
  };
  aircraft: Map<string, SKAircraft>; // received AIS aircraft data
  atons: Map<string, SKAtoN>; // received AIS AtoN data
  sar: Map<string, SKSaR>; // received AIS SaR data
  meteo: Map<string, SKMeteo>; // received AIS Meteo data
  moosContacts: Map<string, MOOSContact>; // MOOS-IvP contact reports
  aisMgr: {
    // manage aisTargets
    updateList: string[];
    staleList: string[];
    removeList: string[];
  };
  moosContactMgr: {
    // manage moosContacts
    updateList: string[];
    removeList: string[];
  };
  navData: {
    dtg: number;
    ttg: number;
    eta: Date;
    route: {
      dtg: number;
      ttg: number;
      eta: Date;
    };
    vmg: number;
    bearing: { value: number; type: string };
    bearingTrue: number;
    bearingMagnetic: number;
    xte: number;
    position: Position;
    pointIndex: number;
    pointTotal: number;
    arrivalCircle: number;
    startPosition: Position;
    pointNames: string[];
    activeRoutePoints: LineString;
    destPointName: string;
  };
  racing: {
    startLine: LineString;
  };
  moosIvPServer?: {
    socket: WebSocket;
    url: string;
    connected: boolean;
    lastMessage?: string;
    ivpHelmState?: string;
    ivpHelmAllstop?: string;
    wptIndex?: number;
    wptDist?: number;
    wptEta?: number;
    wptCompleted?: boolean;
    idRoute?: string;
    desiredSpeed?: number;
    desiredRudder?: number;
    desiredThrust?: number;
    baseCoords?: string;
    canSend?: boolean;
    regionActive?: boolean;
    waypointActive?: boolean;
    waypointRadii?: { captureRadius: number, slipRadius: number } | null;
    serviceMode?: boolean;
    // Collision avoidance test. colavTest is the request echo; colavTestAck is
    // pColavEval confirming it is actually running and measuring.
    colavTest?: boolean;
    colavTestAck?: boolean;
    colavMetrics?: string;
    // live COLREGS state for the box over the boat, null when the behaviour
    // is not avoiding anything
    colregs?: ColregsStatus | null;
    // distances iWebSocket reports it has pushed into avdcol_
    colavDist?: string;
    trafficSpawned?: string;
    trafficTargets?: string;
  };
  connectionState?: {
    signalK: {
      connected: boolean;
      connecting: boolean;
      lastAttempt: number;
    };
    moosIvP: {
      connected: boolean;
      connecting: boolean;
      lastAttempt: number;
    };
    radar?: {
      connected: boolean;
      connecting: boolean;
      lastAttempt: number;
    };
  };
  signalkConnecting?: boolean;
  showChecklist: boolean;
  showEngineStatus: boolean;
}
