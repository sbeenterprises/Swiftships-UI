/**
 * Projection of GeoTIFF charts: GeoTIFF GeoKeys -> proj4 definition registered
 * with OpenLayers.
 */
import proj4 from 'proj4';
import { register } from 'ol/proj/proj4.js';
import { get as getProjection, getTransform } from 'ol/proj';

/** Projection of a GeoTIFF chart */
export interface GeoTiffProjectionInfo {
  code: string; // OpenLayers projection code e.g. 'EPSG:3857' or 'GEOTIFF:<chart id>'
  proj4?: string; // proj4 definition when the code is not built into OpenLayers
  name: string; // human readable description
}

/** Projection error with a message that can be shown to the user */
export class GeoTiffProjectionError extends Error {}

/** Options for resolveProjection() */
export interface ResolveProjectionOptions {
  onlineLookup?: boolean; // look unknown EPSG codes up on epsg.io / spatialreference.org
  timeoutMs?: number; // online lookup timeout
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GeoKeys = Record<string, any>;

const USER_DEFINED = 32767;
const MODEL_PROJECTED = 1;
const MODEL_GEOGRAPHIC = 2;
const MODEL_GEOCENTRIC = 3;

const REPROJECT_HINT =
  'Reproject the chart first, e.g. gdalwarp -t_srs EPSG:3857 in.tif out.tif';

// ******** datums / geographic CRS ********

/** Geographic CRS: EPSG code -> [name, proj4 datum parameters] */
const GEOGRAPHIC_CRS: { [code: number]: [string, string] } = {
  4326: ['WGS 84', '+datum=WGS84'],
  4269: ['NAD83', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4267: ['NAD27', '+ellps=clrk66 +towgs84=-8,160,176,0,0,0,0'],
  4258: ['ETRS89', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4674: ['SIRGAS 2000', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4170: ['SIRGAS', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  // SAD69: IBGE parameters for Brazil (EPSG:1877), epsg.io uses the continental -57,1,-41
  4618: ['SAD69', '+ellps=aust_SA +towgs84=-67.35,3.88,-38.22,0,0,0,0'],
  4225: ['Corrego Alegre 1970-72', '+ellps=intl +towgs84=-206,172,-6,0,0,0,0'],
  4230: ['ED50', '+ellps=intl +towgs84=-87,-98,-121,0,0,0,0'],
  4277: [
    'OSGB36',
    '+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489'
  ],
  4283: ['GDA94', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  7844: ['GDA2020', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4167: ['NZGD2000', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4617: ['NAD83(CSRS)', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4619: ['SWEREF99', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4612: ['JGD2000', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  6668: ['JGD2011', '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'],
  4490: [
    'China Geodetic Coordinate System 2000',
    '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'
  ],
  4148: ['Hartebeesthoek94', '+datum=WGS84'],
  4322: ['WGS 72', '+ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263'],
  4202: [
    'AGD66',
    '+ellps=aust_SA +towgs84=-117.808,-51.536,137.784,0.303,0.446,0.234,-0.29'
  ],
  4203: ['AGD84', '+ellps=aust_SA +towgs84=-134,-48,149,0,0,0,0'],
  4272: [
    'NZGD49',
    '+ellps=intl +towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993'
  ],
  4301: ['Tokyo', '+ellps=bessel +towgs84=-146.414,507.337,680.507,0,0,0,0'],
  4314: [
    'DHDN',
    '+ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7'
  ],
  4312: [
    'MGI',
    '+ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232'
  ],
  4209: ['Arc 1950', '+ellps=clrk80 +towgs84=-143,-90,-294,0,0,0,0'],
  4210: ['Arc 1960', '+ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0'],
  4221: ['Campo Inchauspe', '+ellps=intl +towgs84=-148,136,90,0,0,0,0'],
  4248: ['PSAD56', '+ellps=intl +towgs84=-288,175,-376,0,0,0,0']
};

/** Geographic CRS that are WGS 84 within the accuracy of a chart (< 2 m) */
const WGS84_LIKE = [
  4326, 4269, 4258, 4674, 4170, 4283, 7844, 4167, 4617, 4619, 4612, 6668, 4490,
  4148
];

/** Ellipsoid: EPSG code -> proj4 parameters */
const ELLIPSOIDS: { [code: number]: string } = {
  7030: '+ellps=WGS84',
  7019: '+ellps=GRS80',
  7008: '+ellps=clrk66',
  7022: '+ellps=intl',
  7004: '+ellps=bessel',
  7001: '+ellps=airy',
  7043: '+ellps=WGS72',
  7003: '+ellps=aust_SA',
  7012: '+ellps=clrk80',
  7024: '+ellps=krass',
  7035: '+a=6371007 +b=6371007', // GRS 1980 authalic sphere
  7047: '+a=6370997 +b=6370997', // GRS 1980 authalic sphere (Clarke 1866)
  7059: '+a=6378137 +b=6378137' // popular visualisation sphere
};

/** Linear units: EPSG code -> metres per unit */
const LINEAR_UNITS: { [code: number]: number } = {
  9001: 1, // metre
  9002: 0.3048, // foot
  9003: 1200 / 3937, // US survey foot
  9030: 1852, // nautical mile
  9036: 1000, // kilometre
  9005: 0.3047972654, // Clarke's foot
  9014: 1.8288, // fathom
  9035: 1609.344 // statute mile
};

// ******** projected CRS ********

/** Codes of the Web Mercator projection */
const WEB_MERCATOR = [3857, 900913, 3785, 102100, 102113, 3587, 41001];

/** Projected CRS: EPSG code -> [name, proj4 definition] */
const PROJECTED_CRS: { [code: number]: [string, string] } = {
  3395: [
    'WGS 84 / World Mercator',
    '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  3832: [
    'WGS 84 / PDC Mercator',
    '+proj=merc +lon_0=150 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  3994: [
    'WGS 84 / Mercator 41',
    '+proj=merc +lon_0=100 +lat_ts=-41 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  5641: [
    'SIRGAS 2000 / Brazil Mercator',
    '+proj=merc +lon_0=-43 +lat_ts=-2 +x_0=5000000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  4087: [
    'WGS 84 / World Equidistant Cylindrical',
    '+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  32662: [
    'WGS 84 / Plate Carree',
    '+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  32661: [
    'WGS 84 / UPS North (N,E)',
    '+proj=stere +lat_0=90 +lat_ts=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs'
  ],
  32761: [
    'WGS 84 / UPS South (N,E)',
    '+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs'
  ],
  3413: [
    'WGS 84 / NSIDC Sea Ice Polar Stereographic North',
    '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  3995: [
    'WGS 84 / Arctic Polar Stereographic',
    '+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  3031: [
    'WGS 84 / Antarctic Polar Stereographic',
    '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  ],
  3035: [
    'ETRS89-extended / LAEA Europe',
    '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  3034: [
    'ETRS89-extended / LCC Europe',
    '+proj=lcc +lat_0=52 +lon_0=10 +lat_1=35 +lat_2=65 +x_0=4000000 +y_0=2800000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  2154: [
    'RGF93 v1 / Lambert-93',
    '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  27700: [
    'OSGB36 / British National Grid',
    '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs'
  ],
  2193: [
    'NZGD2000 / New Zealand Transverse Mercator 2000',
    '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  3067: [
    'ETRS89 / TM35FIN(E,N)',
    '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  5070: [
    'NAD83 / Conus Albers',
    '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  3577: [
    'GDA94 / Australian Albers',
    '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ],
  3338: [
    'NAD83 / Alaska Albers',
    '+proj=aea +lat_0=50 +lon_0=-154 +lat_1=55 +lat_2=65 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
  ]
};

/** UTM families: [first code, first zone, last zone, south, CRS name, datum] */
const UTM_FAMILIES: Array<[number, number, number, boolean, string, string]> = [
  [32601, 1, 60, false, 'WGS 84', '+datum=WGS84'],
  [32701, 1, 60, true, 'WGS 84', '+datum=WGS84'],
  [32201, 1, 60, false, 'WGS 72', GEOGRAPHIC_CRS[4322][1]],
  [32301, 1, 60, true, 'WGS 72', GEOGRAPHIC_CRS[4322][1]],
  [26901, 1, 23, false, 'NAD83', GEOGRAPHIC_CRS[4269][1]],
  [26701, 1, 22, false, 'NAD27', GEOGRAPHIC_CRS[4267][1]],
  [25828, 28, 38, false, 'ETRS89', GEOGRAPHIC_CRS[4258][1]],
  [23028, 28, 38, false, 'ED50', GEOGRAPHIC_CRS[4230][1]],
  [31965, 11, 22, false, 'SIRGAS 2000', GEOGRAPHIC_CRS[4674][1]],
  [31977, 17, 25, true, 'SIRGAS 2000', GEOGRAPHIC_CRS[4674][1]],
  [6210, 23, 24, false, 'SIRGAS 2000', GEOGRAPHIC_CRS[4674][1]],
  [5396, 26, 26, true, 'SIRGAS 2000', GEOGRAPHIC_CRS[4674][1]],
  [29168, 18, 22, false, 'SAD69', GEOGRAPHIC_CRS[4618][1]],
  [29187, 17, 25, true, 'SAD69', GEOGRAPHIC_CRS[4618][1]],
  [22521, 21, 25, true, 'Corrego Alegre 1970-72', GEOGRAPHIC_CRS[4225][1]],
  [28348, 48, 58, true, 'GDA94 / MGA', GEOGRAPHIC_CRS[4283][1]],
  [7846, 46, 59, true, 'GDA2020 / MGA', GEOGRAPHIC_CRS[7844][1]]
];

/**
 * @description proj4 definition of a projected CRS from the built in tables.
 * @param code EPSG code
 * @returns [name, proj4 definition] or undefined
 */
function builtInProjected(code: number): [string, string] | undefined {
  if (PROJECTED_CRS[code]) {
    return PROJECTED_CRS[code];
  }
  for (const [first, zone0, zone1, south, name, datum] of UTM_FAMILIES) {
    const zone = zone0 + (code - first);
    if (code >= first && zone <= zone1) {
      return [
        `${name} / UTM zone ${zone}${south ? 'S' : 'N'}`,
        `+proj=utm +zone=${zone}${
          south ? ' +south' : ''
        } ${datum} +units=m +no_defs`
      ];
    }
  }
  return undefined;
}

// ******** public API ********

/**
 * @description Determine the projection of a GeoTIFF from its GeoKeys (offline).
 * @param geoKeys GeoKeys object from geotiff.js image.getGeoKeys()
 * @param chartId Chart identifier, used to name user defined projections
 * @param bbox Image bounding box, used when the file has no GeoKeys
 * @returns Projection
 * @throws GeoTiffProjectionError when the projection is not supported / unknown
 */
export function projectionFromGeoKeys(
  geoKeys: GeoKeys | null | undefined,
  chartId: string,
  bbox?: number[]
): GeoTiffProjectionInfo {
  const keys = geoKeys ?? {};
  const model = keys.GTModelTypeGeoKey;
  const projected = keys.ProjectedCSTypeGeoKey;
  const geographic = keys.GeographicTypeGeoKey;

  if (model === MODEL_GEOCENTRIC) {
    throw new GeoTiffProjectionError(
      `Geocentric coordinates are not supported. ${REPROJECT_HINT}`
    );
  }

  // ** projected CRS identified by an EPSG code **
  if (projected && projected !== USER_DEFINED) {
    return epsgProjected(projected);
  }

  // ** user defined projected CRS **
  if (
    projected === USER_DEFINED ||
    (model === MODEL_PROJECTED &&
      (keys.ProjectionGeoKey || keys.ProjCoordTransGeoKey))
  ) {
    return userDefinedProjected(keys, chartId);
  }

  // ** geographic CRS **
  if (geographic || model === MODEL_GEOGRAPHIC) {
    return geographicCrs(keys, chartId);
  }

  if (model === MODEL_PROJECTED) {
    throw new GeoTiffProjectionError(
      `The chart projection is not described in the file. ${REPROJECT_HINT}`
    );
  }

  // ** no projection information: accept lon / lat coordinates **
  if (
    Array.isArray(bbox) &&
    bbox.length >= 4 &&
    bbox[0] >= -180.5 &&
    bbox[2] <= 360.5 &&
    bbox[1] >= -90.5 &&
    bbox[3] <= 90.5
  ) {
    return { code: 'EPSG:4326', name: 'WGS 84 (assumed)' };
  }
  throw new GeoTiffProjectionError(
    `The file has no projection information. ${REPROJECT_HINT}`
  );
}

/**
 * @description Determine the projection of a GeoTIFF from its GeoKeys, looking
 * up unknown EPSG codes online when allowed.
 * @param geoKeys GeoKeys object from geotiff.js image.getGeoKeys()
 * @param chartId Chart identifier, used to name user defined projections
 * @param bbox Image bounding box, used when the file has no GeoKeys
 * @param options Online lookup options
 * @returns Projection (with the proj4 definition to keep for offline use)
 * @throws GeoTiffProjectionError when the projection cannot be determined
 */
export async function resolveProjection(
  geoKeys: GeoKeys | null | undefined,
  chartId: string,
  bbox?: number[],
  options?: ResolveProjectionOptions
): Promise<GeoTiffProjectionInfo> {
  try {
    return projectionFromGeoKeys(geoKeys, chartId, bbox);
  } catch (err) {
    const code = (err as UnknownEpsgError).epsgCode;
    if (!code || !options?.onlineLookup) {
      throw err;
    }
    const def = await lookupEpsg(code, options.timeoutMs ?? 5000);
    if (!def) {
      throw err;
    }
    return { code: `EPSG:${code}`, proj4: def, name: `EPSG:${code}` };
  }
}

/**
 * @description Make the projection available to OpenLayers (idempotent).
 * @param p Projection
 * @returns true when OpenLayers can transform it to / from EPSG:3857 and EPSG:4326
 */
export function registerProjection(p: GeoTiffProjectionInfo): boolean {
  if (!p?.code) {
    return false;
  }
  try {
    if (p.proj4 && !proj4.defs(p.code)) {
      proj4.defs(p.code, p.proj4);
      register(proj4);
    } else if (p.proj4 && !getProjection(p.code)) {
      register(proj4);
    }
    const projection = getProjection(p.code);
    return (
      !!projection &&
      !!getTransform(projection, 'EPSG:3857') &&
      !!getTransform(projection, 'EPSG:4326')
    );
  } catch (err) {
    console.warn(`registerProjection(${p.code}):`, err);
    return false;
  }
}

// ******** implementation ********

/** Error raised for an EPSG code that is not built in (candidate for online lookup) */
class UnknownEpsgError extends GeoTiffProjectionError {
  constructor(public epsgCode: number, kind: string) {
    super(
      `The chart uses the ${kind} EPSG:${epsgCode} which is not known ` +
        `offline. ${REPROJECT_HINT}`
    );
  }
}

/** Projected CRS identified by an EPSG code */
function epsgProjected(code: number): GeoTiffProjectionInfo {
  if (WEB_MERCATOR.includes(code)) {
    return { code: 'EPSG:3857', name: 'WGS 84 / Pseudo-Mercator' };
  }
  const builtIn = builtInProjected(code);
  if (builtIn) {
    return { code: `EPSG:${code}`, proj4: builtIn[1], name: builtIn[0] };
  }
  throw new UnknownEpsgError(code, 'projection');
}

/** Geographic CRS (lon / lat coordinates) */
function geographicCrs(keys: GeoKeys, chartId: string): GeoTiffProjectionInfo {
  const code = keys.GeographicTypeGeoKey;
  if (code && code !== USER_DEFINED) {
    if (WGS84_LIKE.includes(code)) {
      return {
        code: 'EPSG:4326',
        name:
          code === 4326 ? 'WGS 84' : `${GEOGRAPHIC_CRS[code][0]} (as WGS 84)`
      };
    }
    if (GEOGRAPHIC_CRS[code]) {
      return {
        code: `EPSG:${code}`,
        proj4: `+proj=longlat ${GEOGRAPHIC_CRS[code][1]} +no_defs`,
        name: GEOGRAPHIC_CRS[code][0]
      };
    }
    throw new UnknownEpsgError(code, 'geographic coordinate system');
  }
  // user defined geographic CRS
  const datum = datumParameters(keys);
  if (datum.wgs84) {
    return { code: 'EPSG:4326', name: `${datum.name} (as WGS 84)` };
  }
  return {
    code: `GEOTIFF:${chartId}`,
    proj4: `+proj=longlat ${datum.proj4}${primeMeridian(keys)} +no_defs`,
    name: `${datum.name} (user defined)`
  };
}

/**
 * @description Datum / ellipsoid parameters of the geographic CRS on which a
 * user defined CRS is based.
 */
function datumParameters(keys: GeoKeys): {
  proj4: string;
  name: string;
  wgs84: boolean;
} {
  const gcs = keys.GeographicTypeGeoKey;
  if (gcs && gcs !== USER_DEFINED) {
    if (GEOGRAPHIC_CRS[gcs]) {
      return {
        proj4: GEOGRAPHIC_CRS[gcs][1],
        name: GEOGRAPHIC_CRS[gcs][0],
        wgs84: WGS84_LIKE.includes(gcs)
      };
    }
    throw new UnknownEpsgError(gcs, 'geographic coordinate system');
  }
  // datum code 6xxx <-> geographic CRS code 4xxx
  const datumCode = keys.GeogGeodeticDatumGeoKey;
  if (datumCode && datumCode !== USER_DEFINED) {
    const crs = datumCode - 2000;
    if (GEOGRAPHIC_CRS[crs]) {
      return {
        proj4: GEOGRAPHIC_CRS[crs][1],
        name: GEOGRAPHIC_CRS[crs][0],
        wgs84: WGS84_LIKE.includes(crs)
      };
    }
  }
  // ellipsoid
  let ellipsoid: string;
  const ellipsoidCode = keys.GeogEllipsoidGeoKey;
  if (ellipsoidCode && ellipsoidCode !== USER_DEFINED) {
    ellipsoid = ELLIPSOIDS[ellipsoidCode];
    if (!ellipsoid) {
      throw new GeoTiffProjectionError(
        `The chart uses the unknown ellipsoid EPSG:${ellipsoidCode}. ${REPROJECT_HINT}`
      );
    }
  } else if (keys.GeogSemiMajorAxisGeoKey) {
    const a = num(keys.GeogSemiMajorAxisGeoKey);
    const rf = num(keys.GeogInvFlatteningGeoKey);
    const b = num(keys.GeogSemiMinorAxisGeoKey);
    ellipsoid = rf
      ? `+a=${a} +rf=${rf}`
      : b
      ? `+a=${a} +b=${b}`
      : `+a=${a} +b=${a}`;
  } else {
    ellipsoid = ELLIPSOIDS[7030];
  }
  const wgs84Ellipsoid = [ELLIPSOIDS[7030], ELLIPSOIDS[7019]].includes(
    ellipsoid
  );
  let towgs84 = '+towgs84=0,0,0,0,0,0,0';
  const shift = keys.GeogTOWGS84GeoKey;
  if (shift && (shift.length === 3 || shift.length === 7)) {
    towgs84 = `+towgs84=${Array.from(shift as ArrayLike<number>).join(',')}`;
  }
  return {
    proj4: `${ellipsoid} ${towgs84}`,
    name: 'Datum',
    wgs84: wgs84Ellipsoid && towgs84 === '+towgs84=0,0,0,0,0,0,0'
  };
}

/** Prime meridian parameter (when not Greenwich) */
function primeMeridian(keys: GeoKeys): string {
  const pm = keys.GeogPrimeMeridianLongGeoKey;
  if (keys.GeogPrimeMeridianGeoKey === 8903) {
    return ' +pm=paris';
  }
  return pm ? ` +pm=${angle(keys, pm)}` : '';
}

/** Numeric value of a GeoKey */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(value: any): number {
  return typeof value === 'number' ? value : Number(value?.[0] ?? value);
}

/** Angular GeoKey value in degrees */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function angle(keys: GeoKeys, value: any): number {
  const v = num(value);
  switch (keys.GeogAngularUnitsGeoKey) {
    case 9101: // radian
      return (v * 180) / Math.PI;
    case 9105: // grad
      return v * 0.9;
    case 9110: {
      // sexagesimal DDD.MMSSsss
      const sign = v < 0 ? -1 : 1;
      const a = Math.abs(v);
      const d = Math.floor(a);
      const m = Math.floor(Math.round((a - d) * 1e6) / 1e4);
      const s = (a - d) * 1e4 - m * 100;
      return sign * (d + m / 60 + s / 3600);
    }
    default: // degree
      return v;
  }
}

/** Projected CRS defined in the GeoKeys */
function userDefinedProjected(
  keys: GeoKeys,
  chartId: string
): GeoTiffProjectionInfo {
  const datum = datumParameters(keys);
  const unitCode = keys.ProjLinearUnitsGeoKey;
  let toMeter = 1;
  if (unitCode === USER_DEFINED && keys.ProjLinearUnitSizeGeoKey) {
    toMeter = num(keys.ProjLinearUnitSizeGeoKey);
  } else if (unitCode) {
    toMeter = LINEAR_UNITS[unitCode];
    if (!toMeter) {
      throw new GeoTiffProjectionError(
        `The chart uses the unknown unit EPSG:${unitCode}. ${REPROJECT_HINT}`
      );
    }
  }
  const units = toMeter === 1 ? '+units=m' : `+to_meter=${toMeter}`;

  // UTM zone defined by the projection code (16001-16060 N, 16101-16160 S)
  const projection = keys.ProjectionGeoKey;
  if (
    projection &&
    ((projection >= 16001 && projection <= 16060) ||
      (projection >= 16101 && projection <= 16160))
  ) {
    const south = projection > 16100;
    const zone = projection - (south ? 16100 : 16000);
    return {
      code: `GEOTIFF:${chartId}`,
      proj4: `+proj=utm +zone=${zone}${south ? ' +south' : ''} ${
        datum.proj4
      } ${units} +no_defs`,
      name: `${datum.name} / UTM zone ${zone}${
        south ? 'S' : 'N'
      } (user defined)`
    };
  }

  const ct = keys.ProjCoordTransGeoKey;
  if (!ct) {
    throw new GeoTiffProjectionError(
      `The chart projection${
        projection && projection !== USER_DEFINED ? ` (EPSG:${projection})` : ''
      } is not supported. ${REPROJECT_HINT}`
    );
  }
  // parameters (angles in degrees, linear values in metres)
  const a = (name: string, fallback?: string): number | undefined => {
    const v = keys[name] ?? (fallback ? keys[fallback] : undefined);
    return v === undefined ? undefined : angle(keys, v);
  };
  const m = (name: string, fallback?: string): number => {
    const v = keys[name] ?? (fallback ? keys[fallback] : undefined);
    return v === undefined ? 0 : num(v) * toMeter;
  };
  const k = (name: string, fallback?: string): number => {
    const v = keys[name] ?? (fallback ? keys[fallback] : undefined);
    return v === undefined ? 1 : num(v);
  };
  const natLat = a('ProjNatOriginLatGeoKey', 'ProjCenterLatGeoKey') ?? 0;
  const natLon = a('ProjNatOriginLongGeoKey', 'ProjCenterLongGeoKey') ?? 0;
  const fe = m('ProjFalseEastingGeoKey', 'ProjCenterEastingGeoKey');
  const fn = m('ProjFalseNorthingGeoKey', 'ProjCenterNorthingGeoKey');
  const scale = k('ProjScaleAtNatOriginGeoKey', 'ProjScaleAtCenterGeoKey');
  const sp1 = a('ProjStdParallel1GeoKey');
  const sp2 = a('ProjStdParallel2GeoKey');
  const xy = `+x_0=${fe} +y_0=${fn}`;

  let def: string;
  let name: string;
  switch (ct) {
    case 1: // Transverse Mercator
      def = `+proj=tmerc +lat_0=${natLat} +lon_0=${natLon} +k=${scale} ${xy}`;
      name = 'Transverse Mercator';
      break;
    case 27: // Transverse Mercator (South Orientated)
      def = `+proj=tmerc +lat_0=${natLat} +lon_0=${natLon} +k=${scale} ${xy} +axis=wsu`;
      name = 'Transverse Mercator (south oriented)';
      break;
    case 7: {
      // Mercator: 2SP (latitude of true scale) or 1SP (scale factor)
      let latTs = sp1;
      if (latTs === undefined && natLat !== 0 && scale === 1) {
        // legacy writers store the latitude of true scale as origin latitude
        latTs = natLat;
      }
      def =
        latTs !== undefined
          ? `+proj=merc +lon_0=${natLon} +lat_ts=${latTs} ${xy}`
          : `+proj=merc +lon_0=${natLon} +k=${scale} ${xy}`;
      name =
        latTs !== undefined ? `Mercator (true scale at ${latTs}°)` : 'Mercator';
      break;
    }
    case 8: {
      // Lambert Conformal Conic (2SP)
      const lat0 = a('ProjFalseOriginLatGeoKey', 'ProjNatOriginLatGeoKey') ?? 0;
      const lon0 =
        a('ProjFalseOriginLongGeoKey', 'ProjNatOriginLongGeoKey') ?? 0;
      const x0 = m('ProjFalseOriginEastingGeoKey', 'ProjFalseEastingGeoKey');
      const y0 = m('ProjFalseOriginNorthingGeoKey', 'ProjFalseNorthingGeoKey');
      def = `+proj=lcc +lat_0=${lat0} +lon_0=${lon0} +lat_1=${
        sp1 ?? lat0
      } +lat_2=${sp2 ?? sp1 ?? lat0} +x_0=${x0} +y_0=${y0}`;
      name = 'Lambert Conformal Conic';
      break;
    }
    case 9: // Lambert Conformal Conic (1SP)
      def = `+proj=lcc +lat_1=${natLat} +lat_0=${natLat} +lon_0=${natLon} +k_0=${scale} ${xy}`;
      name = 'Lambert Conformal Conic';
      break;
    case 10: // Lambert Azimuthal Equal Area
      def = `+proj=laea +lat_0=${
        a('ProjCenterLatGeoKey', 'ProjNatOriginLatGeoKey') ?? 0
      } +lon_0=${
        a('ProjCenterLongGeoKey', 'ProjNatOriginLongGeoKey') ?? 0
      } ${xy}`;
      name = 'Lambert Azimuthal Equal Area';
      break;
    case 11: // Albers Equal Area
      def = `+proj=aea +lat_0=${
        a('ProjNatOriginLatGeoKey', 'ProjFalseOriginLatGeoKey') ?? 0
      } +lon_0=${
        a('ProjNatOriginLongGeoKey', 'ProjFalseOriginLongGeoKey') ?? 0
      } +lat_1=${sp1 ?? 0} +lat_2=${sp2 ?? sp1 ?? 0} +x_0=${m(
        'ProjFalseEastingGeoKey',
        'ProjFalseOriginEastingGeoKey'
      )} +y_0=${m('ProjFalseNorthingGeoKey', 'ProjFalseOriginNorthingGeoKey')}`;
      name = 'Albers Equal Area';
      break;
    case 12: // Azimuthal Equidistant
      def = `+proj=aeqd +lat_0=${
        a('ProjCenterLatGeoKey', 'ProjNatOriginLatGeoKey') ?? 0
      } +lon_0=${
        a('ProjCenterLongGeoKey', 'ProjNatOriginLongGeoKey') ?? 0
      } ${xy}`;
      name = 'Azimuthal Equidistant';
      break;
    case 13: // Equidistant Conic
      def = `+proj=eqdc +lat_0=${natLat} +lon_0=${natLon} +lat_1=${
        sp1 ?? natLat
      } +lat_2=${sp2 ?? sp1 ?? natLat} ${xy}`;
      name = 'Equidistant Conic';
      break;
    case 14: // Stereographic
      def = `+proj=stere +lat_0=${natLat} +lon_0=${natLon} +k=${scale} ${xy}`;
      name = 'Stereographic';
      break;
    case 15: {
      // Polar Stereographic (variant A: scale factor, variant B: latitude of true scale)
      const pole = natLat < 0 ? -90 : 90;
      const lon0 =
        a('ProjStraightVertPoleLongGeoKey', 'ProjNatOriginLongGeoKey') ?? 0;
      def =
        Math.abs(natLat) === 90 || natLat === 0
          ? `+proj=stere +lat_0=${pole} +lat_ts=${pole} +lon_0=${lon0} +k=${scale} ${xy}`
          : `+proj=stere +lat_0=${pole} +lat_ts=${natLat} +lon_0=${lon0} ${xy}`;
      name = 'Polar Stereographic';
      break;
    }
    case 16: // Oblique Stereographic
      def = `+proj=sterea +lat_0=${natLat} +lon_0=${natLon} +k=${scale} ${xy}`;
      name = 'Oblique Stereographic';
      break;
    case 17: // Equirectangular
      def = `+proj=eqc +lat_ts=${
        sp1 ?? natLat
      } +lat_0=0 +lon_0=${natLon} ${xy}`;
      name = 'Equirectangular';
      break;
    case 18: // Cassini-Soldner
      def = `+proj=cass +lat_0=${natLat} +lon_0=${natLon} ${xy}`;
      name = 'Cassini-Soldner';
      break;
    case 19: // Gnomonic
      def = `+proj=gnom +lat_0=${natLat} +lon_0=${natLon} ${xy}`;
      name = 'Gnomonic';
      break;
    case 20: // Miller Cylindrical
      def = `+proj=mill +lat_0=0 +lon_0=${natLon} ${xy}`;
      name = 'Miller Cylindrical';
      break;
    case 21: // Orthographic
      def = `+proj=ortho +lat_0=${natLat} +lon_0=${natLon} ${xy}`;
      name = 'Orthographic';
      break;
    case 22: // Polyconic
      def = `+proj=poly +lat_0=${natLat} +lon_0=${natLon} ${xy}`;
      name = 'Polyconic';
      break;
    case 23: // Robinson
      def = `+proj=robin +lon_0=${natLon} ${xy}`;
      name = 'Robinson';
      break;
    case 24: // Sinusoidal
      def = `+proj=sinu +lon_0=${natLon} ${xy}`;
      name = 'Sinusoidal';
      break;
    case 25: // Van der Grinten
      def = `+proj=vandg +lon_0=${natLon} ${xy}`;
      name = 'Van der Grinten';
      break;
    case 26: // New Zealand Map Grid
      def = `+proj=nzmg +lat_0=${natLat || -41} +lon_0=${natLon || 173} +x_0=${
        fe || 2510000
      } +y_0=${fn || 6023150}`;
      name = 'New Zealand Map Grid';
      break;
    case 3: {
      // Hotine Oblique Mercator
      const alpha = a('ProjAzimuthAngleGeoKey') ?? 0;
      const gamma = a('ProjRectifiedGridAngleGeoKey') ?? alpha;
      def = `+proj=omerc +lat_0=${
        a('ProjCenterLatGeoKey', 'ProjNatOriginLatGeoKey') ?? 0
      } +lonc=${
        a('ProjCenterLongGeoKey', 'ProjNatOriginLongGeoKey') ?? 0
      } +alpha=${alpha} +gamma=${gamma} +k=${k(
        'ProjScaleAtCenterGeoKey',
        'ProjScaleAtNatOriginGeoKey'
      )} ${xy}`;
      name = 'Oblique Mercator';
      break;
    }
    default:
      throw new GeoTiffProjectionError(
        `The chart projection (GeoTIFF coordinate transformation ${ct}) is ` +
          `not supported. ${REPROJECT_HINT}`
      );
  }
  return {
    code: `GEOTIFF:${chartId}`,
    proj4: `${def} ${datum.proj4}${primeMeridian(keys)} ${units} +no_defs`,
    name: `${name}, ${
      datum.name === 'Datum' ? 'user defined datum' : datum.name
    }`
  };
}

/**
 * @description Look an EPSG code up online.
 * @param code EPSG code
 * @param timeoutMs Request timeout (ms)
 * @returns proj4 definition or undefined
 */
async function lookupEpsg(
  code: number,
  timeoutMs: number
): Promise<string | undefined> {
  const urls = [
    `https://epsg.io/${code}.proj4`,
    `https://spatialreference.org/ref/epsg/${code}/proj4.txt`
  ];
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        const text = (await response.text()).trim();
        if (/^\+proj=/.test(text) && !/<html/i.test(text)) {
          const def = text.replace(/\s*\+type=crs\b/, '');
          // check proj4 can use it
          proj4(def, 'EPSG:4326');
          return def;
        }
      }
    } catch {
      // try the next source
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}
