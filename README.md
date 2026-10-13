# Documentation of the frontend code of the SwiftShips USV
# Swiftships-UI

|              |                        |
|:------------ |:---------------------- |
| FILE:        | Swiftships-UI/README.md |
| DATE:        | 2026            |
| DESCRIPTION: | Contains important information regarding the Swiftships-UI repository. |


# Introduction

The Swiftships-UI repository contains the frontend code used in the USV produced by SwiftShips. It is an Angular
application, derived from Freeboard-SK, that runs as a Signal K webapp and acts as the chart plotter, instrument
panel and autonomy console of the vehicle.

The UI talks to two backends at the same time:

- **Signal K server** (`http://127.0.0.1:3000`) - navigation data, AIS contacts, resources (routes, waypoints,
  regions, notes), alarms and charts. See the Signal K documentation (https://signalk.org/).
- **MOOS-IvP** (`ws://127.0.0.1:8000`) - the autonomy backend from the `moos-ivp-morgan-stern-drive-mercury`
  repository, reached through the `iWebSocket` app. See MIT documentation
  (https://oceanai.mit.edu/moos-ivp/pmwiki/pmwiki.php?n=Main.HomePage).

Optionally it also connects to a **Mayara radar server** (`http://127.0.0.1:3001`) for the radar overlay.
All three endpoints are configurable in the Settings dialog of the application.

# Directory Structure

The directory structure for the Swiftships-UI is described below:

| Directory        | Description                                 |
|:---------------- |:------------------------------------------- |
| angular.json     | Angular CLI configuration (build target outputs to `public`) |
| CHANGELOG.md     | History of the changes of the project       |
| e2e              | End to end (protractor) tests               |
| font_resources   | Source files for the icon fonts             |
| helper           | Signal K server plugin (compiled to `plugin`) |
| karma.conf.js    | Karma configuration used by the unit tests  |
| package.json     | npm dependencies and build scripts          |
| proxy.conf.json  | Dev server proxy that forwards `/signalk`, `/plugins` and `/skServer` to the Signal K server |
| public           | Directory for the generated build (served by Signal K) |
| README.md        | Contains helpful information - (this file). |
| src              | Directory for source code                   |
| webpack.config.js| Custom webpack configuration                |

Inside the src/app folder (That is one of the most important folder of the directory) you have the following:

| Directory / File            | Description                                 |
|:--------------------------- |:------------------------------------------- |
| app.component.ts / .html    | Main component: toolbar, side panels, remote control, station keep, autonomous control, PID calibration and collision avoidance panels, and the MOOS-IvP message handling |
| app.facade.ts               | Application state shared between the components |
| app.settings.ts             | Default configuration and upgrade of the settings stored in the browser (MOOS-IvP, Signal K and radar connections, waypoint radii, AIS follow, replay tuning) |
| lib/moos-ivp-websocket.service.ts | WebSocket client to the MOOS-IvP backend, with heartbeat and automatic reconnection |
| lib/components              | Reusable components and dialogs (station keep, playback, measurements, PiP, file input) |
| lib/services                | Local storage, IndexedDB and application state services |
| modules/alarms              | Notifications, anchor watch and alarm handling |
| modules/autopilot           | Autopilot console                           |
| modules/buddies             | Buddy (tracked vessel) list                 |
| modules/course              | Course / active route management            |
| modules/experiments         | Experimental features behind a toggle       |
| modules/gpx                 | Load and save of GPX files                  |
| modules/icons               | SVG icon sets (vessels, AtoNs, waypoints, OpenBridge) |
| modules/map                 | OpenLayers chart: map component, layers, popovers and map interaction |
| modules/radar               | Radar overlay fed by the Mayara radar server |
| modules/replay              | Mission recording and replay (transport bar and replay API) |
| modules/settings            | Settings dialog                             |
| modules/skresources         | Signal K resources (routes, waypoints, regions, notes, charts) and the GeoTIFF charts kept in the browser |
| modules/skstream            | Web worker that consumes the Signal K delta stream |
| modules/weather             | Weather data and forecast display           |

The `helper` folder is the Signal K server plugin side of the package:

| Directory        | Description                                 |
|:---------------- |:------------------------------------------- |
| helper/index.ts  | Plugin entry point and configuration schema |
| helper/alarms    | Alarm endpoints                             |
| helper/replay    | Mission recording storage endpoints         |
| helper/weather   | OpenWeather service integration             |
| helper/openApi.json | OpenAPI description of the plugin endpoints |

# MOOS-IvP Interface

The UI exchanges plain `VARIABLE=value` messages with the MOOS-IvP backend over the WebSocket.

Variables published by the UI (commands):

| Variable            | Description                                   |
|:------------------- |:--------------------------------------------- |
| DESIRED_RUDDER      | Rudder command in manual remote control        |
| DESIRED_THRUST      | Thrust command in manual remote control        |
| DESIRED_SPEED       | Speed of the autonomous mission                |
| TRIM                | Trim up (`1`) / down (`-1`)                    |
| CAN_SEND            | Enables/disables the transmission of CAN messages |
| REPEAT              | Repeat of the loaded route                     |
| REGION              | Region (polygon) sent to the helm              |
| STATION_KEEP / STATION_PT / STATION_KEEP_WAYPOINT | Station keep control and position |
| AUTONOMOUS_STOP     | Stops the autonomous mission (and a return to base) |
| BASE_COORDS         | Base set on the chart (`lat,lon`), where the USV returns if the link is lost |
| HEARTBEAT_PING      | Every 5 s while telemetry is arriving          |
| TRAIL_FOLLOW        | Follow of an AIS contact (range and angle)     |
| SERVICE_MODE        | Enables the live PID calibration mode          |
| COLAV_DIST          | Collision avoidance engagement distances       |
| COLAV_TEST / CLEAR_TARGETS | Collision avoidance test targets        |

Variables consumed by the UI (telemetry): `IVPHELM_STATE`, `IVPHELM_ALLSTOP`, `WPT_INDEX`, `WPT_DIST`, `WPT_ETA`,
`WPT_STAT`, `WPT_RADII`, `WPT_PCT_COMPLETE`, `DESIRED_SPEED`, `ID_ROUTE`, `REGION`, `BASE_COORDS`, `CONTACT_INFO`,
`TRAILING`, `TRAIL_UPDATES`, `SERVICE_MODE`, `PID_GAINS`, `CAN_SEND`, `COMMS_LOSS` and the `ENGINE_*` family coming from the
`iCANREC` application (RPM, oil pressure and temperature, coolant temperature, fuel rate, battery voltage, load,
torque, pedal position, intake manifold pressure and active DTCs).

# Comms-Loss Return to Base

The UI runs ashore and the USV is out on the water, so the link between them can drop. When the USV hears nothing
from any UI for 30 s, it returns to its base on its own and holds there - whenever pHelmIvP is in DRIVE (NothingToDo
included) or the boat is underway; with the helm in PARK and the boat idle it stays put unless configured otherwise.
This is done on the boat by `iWebSocket` and two helm behaviours; see the backend README for the configuration.

- **Base**: shown on the chart as the base marker. Right click > Define base moves it; the new base is sent to the USV
  (`BASE_COORDS`) and the chart only keeps it once the USV echoes it back. Without a link the base cannot be changed.
  The default base is 29.72282, -91.21539.
- **LINK** in the top bar: `OK`, `LOST n s` when no data has come from the USV for more than 3 s, or `ONE-WAY` when
  the data arrives but the USV reports it is not hearing this station.
- **Banner** over the chart while the link is in trouble - saying whether the USV will return to base or stay where it
  is - and while it is returning to base or holding there (with when the link was lost and for how long). Its Stop button ends the return; so does any mission, station
  keep, follow or rudder/thrust command.
- While the link is stale the UI does not send commands, so they cannot be delivered late, and it stops its
  heartbeat, so a link that only works towards the station still lets the USV come home.

# Chart Files (.tif)

Raster charts in TIFF format can be loaded from the Charts side menu (`+` > `Chart file (.tif)`, or by dropping .tif
files on the chart list) and shown / hidden like the other charts. The position of a chart comes from its GeoTIFF tags,
from a MOOS-IvP `.info` file (pMarineViewer background images: `lat_north`, `lat_south`, `lon_east`, `lon_west`) or a
world file (`.tfw` / `.wld` + `.prj`) selected together with the .tif file, or else from the edges entered by the user
when the chart is loaded. Each file is converted in the browser into a pyramid of 256 px PNG tiles that is kept in
IndexedDB (database `swiftships-charts`), so the charts persist across reloads and are displayed without the Signal K
server. The code is in `src/app/modules/skresources/geotiff`:

| File                       | Description                                 |
|:-------------------------- |:------------------------------------------- |
| geotiff-import.ts          | Reads the GeoTIFF (geotiff.js), validates the georeferencing, converts the pixels to RGBA and builds the tile pyramid |
| geotiff-projection.ts      | GeoTIFF GeoKeys to proj4 definition (EPSG tables, user defined projections, online lookup of unknown EPSG codes) |
| geotiff-sidecar.ts         | Companion files: MOOS-IvP .info, world files and .prj, grouping of the selected files |
| geotiff-charts.service.ts  | Storage of the charts, import / cancel / remove |
| geotiff-layer.ts           | OpenLayers tile layer that displays the stored tiles |

Charts georeferenced with control points only (e.g. converted from BSB/KAP) must be warped first, e.g.
`gdalwarp -t_srs EPSG:3857 chart.kap chart.tif`.

# Useful Commands

```bash
# Development server with proxy to the Signal K server (http://localhost:4200)
npm start

# Format the source code
npm run format:all

# Unit tests
npm test
```

# Build Instructions

#Before Building

Run:
```bash
   # Node.js 20 or later and the Angular CLI are required
   npm install
```

## Linux and Mac Users

Make a build version in the folder /public:

```bash
   $ ng build
```

To build the production bundle and the Signal K plugin, execute the following commands within this directory:

```bash
   $ npm run build:all
```

This runs `build:helper` (compiles `helper` into `plugin`) and `build:web` (production Angular build into
`public`). To install it in the Signal K server as a webapp:

```bash
   $ npm pack
   $ npm install -g <the generated tarball>
```
## Signal K data requirements

The top status bar reads these sources. If a field shows `--` or `UNKNOWN`, the source is missing.

| UI field | Source | Provided by |
|---|---|---|
| HDG | `navigation.headingTrue` | VectorNav via `signalk/plugins/signalk-vectornav-vnins` |
| SOG | `navigation.speedOverGround` | VectorNav plugin |
| LAT / LON | `navigation.position` | VectorNav plugin |
| Voltage | `electrical.batteries.House.voltage` | Victron VE.Direct plugin (Main Battery name = `House`) |
| Fuel Level | `tanks.fuel.0.currentLevel` | Fuel tank sender (NMEA 2000 PGN 127505) |
| STATUS | MOOS-IvP `IVPHELM_STATE` | MOOS-IvP autonomy stack |
| MODE | MOOS-IvP `IVPHELM_ALLSTOP` | MOOS-IvP autonomy stack |

### VectorNav heading

The VectorNav outputs proprietary `$VNINS` sentences, which the standard Signal K NMEA 0183 parser ignores. Install the `signalk-vectornav-vnins` plugin (see its README) and keep any NMEA 0183 data connection on the same serial port **disabled**.

### Signal K config location

Signal K runs as `root`, so its live config is `/root/.signalk`, not `~/.signalk`. Per-boat config snapshots are kept in `signalk/config/<boat>/`. Do not commit `security.json`.

# END of README
