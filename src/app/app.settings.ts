import { FBAppData, IAppConfig, Position } from './types';
import { Convert } from './lib/convert';
import { SKVessel } from './modules';

// validate supplied settings against base config
export function validateConfig(settings: IAppConfig): boolean {
  let result = true;
  const skeys = Object.keys(settings);
  Object.keys(defaultConfig()).forEach((i) => {
    if (!skeys.includes(i)) {
      result = false;
    }
  });
  return result;
}

// clean loaded app config
export function cleanConfig(
  settings: IAppConfig,
  hostParams: { [key: string]: unknown }
) {
  /** v2 formatting */
  if (typeof settings.ui === 'undefined') {
    settings.ui = {
      mapNorthUp: (settings as any).map.northUp ?? true,
      mapMove: (settings as any).map.moveMap ?? false,
      mapConstrainZoom: (settings as any).map.limitZoom ?? false,
      invertColor: (settings as any).map.invertColor ?? false,
      toolbarButtons: (settings as any).toolBarButtons ?? true
    };
  }

  /**
   * v2 deprecations
   * @todo For removal (Applied 2.16.1)
   */
  if (typeof (settings as any).map.northUp !== 'undefined') {
    delete (settings as any).map.northUp;
  }
  if (typeof (settings as any).map.moveMap !== 'undefined') {
    delete (settings as any).map.moveMap;
  }
  if (typeof (settings as any).map.limitZoom !== 'undefined') {
    delete (settings as any).map.limitZoom;
  }
  if (typeof (settings as any).map.invertColor !== 'undefined') {
    delete (settings as any).map.invertColor;
  }
  if (typeof (settings as any).toolBarButtons !== 'undefined') {
    delete (settings as any).toolBarButtons;
  }

  /**
   *  Remove notes selections
   * @todo For removal (Applied 2.14.2)
   */
  if ((settings as any).selections.notes) {
    delete (settings as any).selections.notes;
  }

  if (typeof settings.fixedLocationMode === 'undefined') {
    settings.fixedLocationMode = false;
  }
  if (typeof settings.fixedPosition === 'undefined') {
    settings.fixedPosition = [0, 0];
  }
  if (typeof settings.muteSound === 'undefined') {
    settings.muteSound = false;
  }
  if (typeof settings.nightMode === 'undefined') {
    settings.nightMode = false;
  }

  if (typeof settings.selections === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (settings as any).selections = {};
  }

  if (typeof settings.selections.vessel === 'undefined') {
    settings.selections.vessel = {
      trail: true,
      windVectors: true,
      laylines: false,
      cogLine: 10,
      aisCogLine: 10,
      headingLineSize: -1,
      iconScale: 0.9
    };
  }
  if (typeof settings.selections.vessel.laylines === 'undefined') {
    settings.selections.vessel.laylines = false;
  }
  if (typeof settings.selections.vessel.aisCogLine === 'undefined') {
    settings.selections.vessel.aisCogLine = 10;
  }
  if (typeof settings.selections.vessel.iconScale === 'undefined') {
    settings.selections.vessel.iconScale = 0.9;
  }

  if (typeof settings.selections.aisShowTrack === 'undefined') {
    settings.selections.aisShowTrack = false;
  }

  if (typeof settings.selections.aisTargetTypes === 'undefined') {
    settings.selections.aisTargetTypes = [];
  }

  if (typeof settings.selections.aisFilterByShipType === 'undefined') {
    settings.selections.aisFilterByShipType = false;
  }

  if (typeof settings.selections.labelsMinZoom === 'undefined') {
    settings.selections.labelsMinZoom = 10;
  }

  if (typeof settings.selections.aisWindMinZoom === 'undefined') {
    settings.selections.aisWindMinZoom = 15;
  }
  if (typeof settings.selections.aisWindApparent === 'undefined') {
    settings.selections.aisWindApparent = false;
  }
  if (typeof settings.selections.notesMinZoom === 'undefined') {
    settings.selections.notesMinZoom = 10;
  }
  if (typeof settings.selections.preferredPaths === 'undefined') {
    settings.selections.preferredPaths = {
      tws: 'environment.wind.speedTrue',
      twd: 'environment.wind.directionTrue',
      heading: 'navigation.courseOverGroundTrue',
      course: 'navigation.courseGreatCircle'
    };
  }
  if (typeof settings.selections.preferredPaths.course === 'undefined') {
    settings.selections.preferredPaths.course = 'navigation.courseGreatCircle';
  }
  if (typeof settings.selections.pluginFavourites === 'undefined') {
    settings.selections['pluginFavourites'] = [];
  }
  if (typeof settings.selections.positionFormat === 'undefined') {
    settings.selections['positionFormat'] = 'XY';
  }
  if (typeof settings.selections.chartOrder === 'undefined') {
    settings.selections['chartOrder'] = [];
  }
  if (typeof settings.selections.tracks === 'undefined') {
    settings.selections.tracks = [];
  }
  if (typeof settings.selections.trailDuration === 'undefined') {
    settings.selections.trailDuration = 24;
  }
  if (typeof settings.selections.trailResolution === 'undefined') {
    settings.selections.trailResolution = {
      lastHour: '5s',
      next23: '1m',
      beyond24: '5m'
    };
  }
  if (typeof settings.selections.resourceSets === 'undefined') {
    settings.selections.resourceSets = {};
  }
  if (typeof settings.selections.aisMaxAge === 'undefined') {
    settings.selections.aisMaxAge = 540000;
  }
  if (typeof settings.selections.aisStaleAge === 'undefined') {
    settings.selections.aisStaleAge = 360000;
  }
  if (typeof settings.selections.aisProfile === 'undefined') {
    settings.selections.aisProfile = 0;
  }
  if (typeof settings.selections.aisState === 'undefined') {
    settings.selections.aisState = [];
  }
  if (typeof settings.selections.signalk === 'undefined') {
    settings.selections.signalk = {
      vessels: true,
      atons: true,
      aircraft: false,
      sar: false,
      meteo: true,
      maxRadius: 0,
      proxied: true
    };
  }
  // force proxied = true for stored config.
  settings.selections.signalk.proxied = true;

  if (typeof settings.selections.signalk.meteo === 'undefined') {
    settings.selections.signalk.meteo = true;
  }
  if (typeof settings.selections.wakeLock === 'undefined') {
    settings.selections.wakeLock = false;
  }

  if (typeof settings.selections.course === 'undefined') {
    settings.selections.course = {
      autoNextPointOnArrival: false,
      autoNextPointDelay: 5000,
      autoNextPointTrigger: 'perpendicularPassed'
    };
  } else {
    if (
      typeof settings.selections.course.autoNextPointTrigger === 'undefined'
    ) {
      settings.selections.course.autoNextPointTrigger = 'perpendicularPassed';
    }
  }

  if (typeof settings.selections.s57Options === 'undefined') {
    settings.selections.s57Options = {
      graphicsStyle: 'Paper',
      boundaries: 'Plain',
      colors: 4,
      shallowDepth: 2,
      safetyDepth: 3,
      deepDepth: 6
    };
  }

  if (typeof settings.map.lockMoveMap === 'undefined') {
    settings.map.lockMoveMap = false;
  }

  if (typeof settings.anchorRadius === 'undefined') {
    settings.anchorRadius = 40;
  }
  if (typeof settings.anchorSetRadius === 'undefined') {
    settings.anchorSetRadius = false;
  }
  if (typeof settings.anchorManualSet === 'undefined') {
    settings.anchorManualSet = false;
  }
  if (typeof settings.anchorRodeLength === 'undefined') {
    settings.anchorRodeLength = 50;
  }

  if (typeof settings.units.temperature === 'undefined') {
    settings.units.temperature = 'c';
  }

  if (typeof settings.plugins === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (settings as any).plugins = {};
  }
  if (typeof settings.plugins.parameters === 'undefined') {
    settings.plugins.parameters = null;
  }

  if (typeof settings.resources === 'undefined') {
    settings.resources = {
      fetchFilter:
        '?position=[%map:longitude%,%map:latitude%]&distance=%fetch:radius%',
      fetchRadius: 0,
      notes: {
        rootFilter:
          '?position=[%map:longitude%,%map:latitude%]&distance=%note:radius%',
        getRadius: 20,
        groupNameEdit: false,
        groupRequiresPosition: false
      },
      video: {
        enable: false,
        url: ''
      },
      paths: []
    };
  } else {
    if (typeof settings.resources.video === 'undefined') {
      settings.resources.video = { enable: false, url: '' };
    }
    if (typeof settings.resources.paths === 'undefined') {
      settings.resources.paths = [];
    }
    if (typeof settings.resources.fetchFilter === 'undefined') {
      settings.resources.fetchFilter =
        '?position=[%map:longitude%,%map:latitude%]&distance=%fetch:radius%';
    }
    if (typeof settings.resources.fetchRadius === 'undefined') {
      settings.resources.fetchRadius = 0;
    }
  }

  // apply url params
  if (typeof hostParams.northup !== 'undefined') {
    settings.ui.mapNorthUp = hostParams.northup === '0' ? false : true;
  }
  if (typeof hostParams.movemap !== 'undefined') {
    settings.ui.mapMove = hostParams.movemap === '0' ? false : true;
  }
  if (hostParams.zoom) {
    try {
      const z = parseInt(hostParams.zoom as string);
      if (!isNaN(z)) {
        settings.map.zoomLevel = z > 28 ? 28 : z < 1 ? 1 : z;
      }
    } catch (error) {
      console.warn(
        `Invalid zoom level parameter (${hostParams.zoom} supplied!`
      );
    }
  }

  //Remote Control Configs
  if (typeof settings.selections.remoteControl === 'undefined') {
    settings.selections.remoteControl = false;
  }

  //Autonomous Control Configs
  if (typeof settings.selections.autonomousControl === 'undefined') {
    settings.selections.autonomousControl = false;
  }

  //Service mode PID gains (upgrade of stored settings)
  if (typeof settings.selections.servicePid === 'undefined') {
    settings.selections.servicePid = {
      enabled: false,
      heading: { kp: 0.15, ki: 0, kd: 0.26 },
      speed: { kp: 0.16, ki: 0.003, kd: 0 }
    };
  }

  //Waypoint capture / slip radius circles (upgrade of stored settings)
  if (typeof settings.selections.showWaypointRadii === 'undefined') {
    settings.selections.showWaypointRadii = true;
  }

  //Collision avoidance test target defaults (upgrade of stored settings)
  if (typeof settings.selections.colavTarget === 'undefined') {
    settings.selections.colavTarget = {
      speed: 5,
      courseMode: 'at_usv',
      course: 218.7,
      vesselType: 'cargo',
      length: 25,
      beam: 9
    };
  }

  //Collision avoidance engagement distances (upgrade of stored settings)
  if (typeof settings.selections.colavDist === 'undefined') {
    settings.selections.colavDist = {
      outer: 300,
      inner: 150,
      completed: 1500,
      minCpa: 100,
      maxCpa: 300
    };
  }

  //AIS contact cap for collision avoidance (upgrade of stored settings)
  if (typeof settings.selections.aisLimit === 'undefined') {
    settings.selections.aisLimit = {
      enabled: false,
      radius: 500
    };
  }

  //Follow AIS contact defaults (upgrade of stored settings)
  if (typeof settings.selections.aisFollowRange === 'undefined') {
    settings.selections.aisFollowRange = 100;
  }
  if (typeof settings.selections.aisFollowAngle === 'undefined') {
    settings.selections.aisFollowAngle = 180;
  }

  // MOOS-IvP connection config
  if (typeof settings.moosIvP === 'undefined') {
    settings.moosIvP = {
      enabled: true,
      url: 'ws://127.0.0.1',
      port: 8000,
      autoConnect: true
    };
  }

  // Signal K server connection config
  if (typeof settings.signalk === 'undefined') {
    settings.signalk = {
      enabled: true,
      url: 'http://127.0.0.1',
      port: 3000,
      autoConnect: true
    };
  }

  // Radar (Mayara) server connection config
  if (typeof settings.radar === 'undefined') {
    settings.radar = {
      enabled: true,
      url: 'http://127.0.0.1',
      port: 3001,
      autoConnect: true
    };
  }

  // Mission replay recorder tuning (upgrade of stored settings)
  if (typeof settings.replay === 'undefined') {
    settings.replay = {
      chunkSeconds: 5,
      chunkBytes: 1048576
    };
  }
}

// initialise default configuration
export function defaultConfig(): IAppConfig {
  return {
    ui: {
      mapNorthUp: true,
      mapMove: false,
      mapConstrainZoom: false,
      toolbarButtons: true,
      invertColor: false // invert map feature label colors
    },
    chartApi: 1, // set by feature detection
    experiments: false,
    version: '',
    darkMode: { enabled: false, source: 0 }, // source: 0= browser default, 1= Signal K mode, -1=manual)
    nightMode: false, // auto set night mode based on environment.mode
    map: {
      // ** map config
      zoomLevel: 2,
      center: [0, 0],
      rotation: 0,
      lockMoveMap: true,
      animate: false
    },
    fixedLocationMode: false,
    fixedPosition: [0, 0],
    aisTargets: true, // display ais targets
    courseData: true, // show/hide course data
    notes: true, // display notes
    popoverMulti: false, // close popovers using cose button
    mapDoubleClick: false, // true=zoom
    muteSound: false,
    depthAlarm: { enabled: false, smoothing: 10000 },
    anchorRadius: 40, // most recent anchor radius setting
    anchorSetRadius: false,
    anchorManualSet: false, // checks manual set setting
    anchorRodeLength: 50, // rode length setting
    plugins: {
      instruments: '/@signalk/instrumentpanel',
      startOnOpen: true,
      parameters: null
    },
    units: {
      // ** display units
      distance: 'm',
      depth: 'm',
      speed: 'kn',
      temperature: 'c'
    },
    selections: {
      // ** saved selections
      routes: [],
      waypoints: [],
      tracks: null,
      charts: [],
      chartOrder: [], // chart layer ordering
      headingAttribute: 'navigation.headingTrue',
      preferredPaths: {
        tws: 'environment.wind.speedTrue',
        twd: 'environment.wind.directionTrue',
        heading: 'navigation.courseOverGroundTrue',
        course: 'navigation.courseGreatCircle'
      },
      vessel: {
        trail: false, // display trail
        windVectors: true, // display vessel TWD, AWD vectors
        laylines: false,
        cogLine: 10, // self COG line time (mins)
        aisCogLine: 10, // ais COG line time (mins)
        headingLineSize: -1, // mode for display of heading line -1 = default
        iconScale: 0.9
      },
      positionFormat: 'XY',
      aisTargets: null,
      aisTargetTypes: [],
      aisFilterByShipType: false,
      aisWindApparent: false,
      aisWindMinZoom: 15,
      aisShowTrack: false,
      aisMaxAge: 540000, // time since last update in ms (9 min)
      aisStaleAge: 360000, // time since last update in ms (6 min)
      aisProfile: 0, // ais display profile
      aisState: [], // list of ais state values used to filter targets
      notesMinZoom: 10,
      labelsMinZoom: 8,
      pluginFavourites: [],
      trailFromServer: false,
      trailDuration: 24, // number of hours of trail to fetch from server
      trailResolution: {
        // resolution of server trail at defined time horizons
        lastHour: '5s',
        next23: '1m',
        beyond24: '5m'
      },
      s57Options: {
        graphicsStyle: 'Paper',
        boundaries: 'Plain',
        colors: 4,
        shallowDepth: 2,
        safetyDepth: 3,
        deepDepth: 6
      },
      resourceSets: {}, // additional resources
      signalk: {
        // signal k connection options
        vessels: true,
        atons: true,
        aircraft: false,
        sar: false,
        meteo: true,
        maxRadius: 0, // max radius within which AIS targets are displayed
        proxied: true // server behind a proxy server
      },
      wakeLock: false,
      course: {
        autoNextPointOnArrival: false,
        autoNextPointDelay: 5000,
        autoNextPointTrigger: 'perpendicularPassed'
      },
      remoteControl: false,
      autonomousControl: false,
      radarControl: false,
      servicePid: {
        // PID gains calibrated from the UI - seeded with the planchaPID defaults
        enabled: false,
        heading: { kp: 0.15, ki: 0, kd: 0.26 },
        speed: { kp: 0.16, ki: 0.003, kd: 0 }
      },
      showWaypointRadii: true,
      colavTarget: {
        // Target placed by right-click > Put Target during a collision
        // avoidance test. Speed in knots, course either aimed at the USV or
        // held at a fixed bearing.
        speed: 5,
        courseMode: 'at_usv',
        course: 218.7,
        vesselType: 'cargo',
        length: 25,
        beam: 9
      },
      aisLimit: {
        // Range (m) inside which the collision avoidance engages a contact.
        // Off by default - the helm sees everything.
        enabled: false,
        radius: 500
      },
      colavDist: {
        // Distances the collision avoidance behaviour (avdcol_) engages with,
        // seeded with what alpha.bhv configures. Metres.
        outer: 300,
        inner: 150,
        completed: 1500,
        minCpa: 100,
        maxCpa: 300
      },
      aisFollowRange: 100,
      aisFollowAngle: 180
    },
    resources: {
      // ** resource options
      fetchFilter:
        '?position=[%map:longitude%,%map:latitude%]&distance=%fetch:radius%',
      fetchRadius: 0, // radius (NM/km) within which to return resources
      notes: {
        rootFilter:
          '?position=[%map:longitude%,%map:latitude%]&distance=%note:radius%', // param string to provide record filtering
        getRadius: 20, // radius (NM/km) within which to return notes
        groupNameEdit: false,
        groupRequiresPosition: true
      },
      video: {
        enable: false,
        url: null
      },
      paths: []
    },
    moosIvP: {
      enabled: true,
      url: 'ws://127.0.0.1',
      port: 8000,
      autoConnect: true
    },
    signalk: {
      enabled: true,
      url: 'http://127.0.0.1',
      port: 3000,
      autoConnect: true
    },
    radar: {
      enabled: true,
      url: 'http://127.0.0.1',
      port: 3001,
      autoConnect: true
    },
    replay: {
      chunkSeconds: 5,
      chunkBytes: 1048576
    }
  };
}

// initialise state data
/**
 * MOOS-IvP mission state, minus the connection fields (socket/url/connected).
 *
 * Split out of initData() so mission replay can rewind it on a backward seek
 * without touching the live connection, and so the field list lives in exactly
 * one place as new MOOS variables are added.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initMoosIvPData(): { [key: string]: any } {
  return {
    lastMessage: '',
    ivpHelmState: '',
    ivpHelmAllstop: '',
    wptIndex: 0,
    wptDist: 0,
    wptEta: 0,
    wptCompleted: false,
    desiredSpeed: 10,
    desiredRudder: 0,
    desiredThrust: 0,
    idRoute: '',
    baseCoords: null,
    canSend: false,
    regionActive: false,
    waypointActive: false,
    waypointRadii: null,
    colavTest: false,
    colavTestAck: false,
    colavMetrics: '',
    colregs: null,
    colavDist: '',
    aisRadius: 0,
    trafficSpawned: '',
    trafficTargets: ''
  };
}

/** Autonomous control panel state, minus the user's route/region selection. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initAutonomousControlData(): { [key: string]: any } {
  return {
    speed: 10,
    status: 'standby',
    currentWaypoint: 0,
    progress: 0,
    remainingDistance: 0,
    estimatedTimeArrival: 0,
    repeatRoute: false,
    totalDistance: 0,
    totalTimeOfArrival: 0,
    ignoreStatusUpdates: false,
    lastStatus: '',
    canSend: false,
    ignoreCanSendUpdates: false,
    waypointActive: false,
    waypointRadii: null
  };
}

/** Engine telemetry reported over MOOS (ENGINE_*). */
export function initEngineStatus() {
  return {
    acceleratorPedalPosition: 0,
    percentLoad: 0,
    speed: 0,
    percentTorque: 0,
    activeDtcs: 0,
    coolantTemp: 0,
    oilTemp: 0,
    oilPressure: 0,
    fuelRate: 0,
    intakeManifoldPressure: 0,
    batteryVoltage: 0
  };
}

export function initData(): FBAppData {
  return {
    n2kRoute: null,
    loginRequired: false,
    hasWakeLock: false,
    chartBounds: {
      show: false,
      charts: []
    },
    selfId: null,
    activeRoute: null,
    activeRouteReversed: false,
    activeRouteCircular: false,
    activeRouteIsEditing: false,
    editingId: null,
    activeWaypoint: null,
    trail: [], // self vessel track / trail
    serverTrail: false, // trail received from server
    server: null,
    lastGet: null, // map position of last resources GET
    map: {
      atClick: {
        features: [],
        lonlat: [0, 0]
      }
    },
    vessels: {
      // received vessel data
      showSelf: false,
      self: new SKVessel(),
      aisTargets: new Map(),
      aisTracks: new Map(), // AIS targets track (tracks plugin)
      activeId: null,
      active: null,
      closest: [],
      prefAvailablePaths: {}, // preference paths available from source,
      flagged: [] // flagged ais targets
    },
    aircraft: new Map(), // received AIS aircraft data
    atons: new Map(), // received AIS AtoN data
    sar: new Map(), // received AIS SaR data
    meteo: new Map(), // received AIS Meteo data
    moosContacts: new Map(), // MOOS-IvP contact reports
    aisMgr: {
      // manage aisTargets
      updateList: [],
      staleList: [],
      removeList: []
    },
    moosContactMgr: {
      // manage moosContacts
      updateList: [],
      removeList: []
    },
    navData: {
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
      position: null,
      pointIndex: -1,
      pointTotal: 0,
      arrivalCircle: null,
      startPosition: null,
      pointNames: [],
      activeRoutePoints: [],
      destPointName: ''
    },
    racing: {
      startLine: []
    },
    moosIvPServer: {
      socket: null,
      url: '',
      connected: false,
      ...initMoosIvPData()
    },
    connectionState: {
      signalK: {
        connected: false,
        connecting: false,
        lastAttempt: 0
      },
      moosIvP: {
        connected: false,
        connecting: false,
        lastAttempt: 0
      }
    },
    showChecklist: false,
    showEngineStatus: false,
    showCalibration: false
  };
}

// process url tokens from settings
export const processUrlTokens = (s: string, config: IAppConfig): string => {
  if (!s) {
    return s;
  }
  const ts = s.split('%');
  if (ts.length > 1) {
    const uts = ts.map((i) => {
      if (i === 'map:latitude') {
        return config.map.center[1];
      } else if (i === 'map:longitude') {
        return config.map.center[0];
      } else if (i === 'map:zoom') {
        return Math.floor(config.map.zoomLevel);
      } else if (i === 'note:radius') {
        const dist =
          config.units.distance === 'm'
            ? config.resources.notes.getRadius
            : Math.floor(
                Convert.nauticalMilesToKm(config.resources.notes.getRadius)
              );
        return dist * 1000;
      } else if (i === 'fetch:radius') {
        const dist =
          config.units.distance === 'm'
            ? config.resources.notes.getRadius
            : Math.floor(
                Convert.nauticalMilesToKm(config.resources.fetchRadius)
              );
        return dist * 1000;
      } else {
        return i;
      }
    });
    s = uts.join('');
  }
  return s;
};
