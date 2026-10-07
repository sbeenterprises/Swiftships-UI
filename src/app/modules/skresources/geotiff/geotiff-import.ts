/**
 * Load a GeoTIFF nautical chart: validate it and convert it into a pyramid of
 * PNG tiles (full resolution + reduced resolution levels) so that it can be
 * displayed quickly at every zoom level, whatever the layout of the file
 * (strips, tiles, overviews, compression, palette, ...).
 */
import { fromArrayBuffer, fromBlob, Pool, GeoTIFFImage } from 'geotiff';
import {
  fromLonLat,
  get as getProjection,
  transformExtent,
  transform
} from 'ol/proj';

import {
  GEOTIFF_TILE_SIZE,
  GeoTiffChartError,
  GeoTiffChartInfo,
  GeoTiffExtent,
  GeoTiffGeoreference,
  GeoTiffLevel,
  GeoTiffPosition,
  GeoTiffPositionRequiredError,
  GeoTiffSourceInfo
} from './geotiff-types';
import {
  GeoTiffProjectionError,
  GeoTiffProjectionInfo,
  registerProjection,
  resolveProjection
} from './geotiff-projection';
import {
  WorldFile,
  fileExtension,
  parseMoosInfo,
  parsePrj,
  parseWorldFile
} from './geotiff-sidecar';
import { encodePng } from './png-encoder';

const TILE = GEOTIFF_TILE_SIZE;
/** Largest image width / height accepted (pixels) */
const MAX_SIZE = 65536;
/** Largest image accepted (pixels) */
const MAX_PIXELS = 1000 * 1000 * 1000;
/** Pixels decoded per read (rounded to whole strips / tiles of the file) */
const CHUNK_PIXELS = 4 * 1024 * 1024;
/** Largest amount of decoded data read at once (bytes) */
const MAX_CHUNK_BYTES = 512 * 1024 * 1024;
/** Rows converted to RGBA at once */
const SLICE_ROWS = TILE;
/** Tiles kept in memory before being moved into a Blob (bytes) */
const BLOB_PART_BYTES = 16 * 1024 * 1024;
/** Files up to this size are read into memory at once (much faster than many small reads) */
const IN_MEMORY_MAX_BYTES = 256 * 1024 * 1024;

// TIFF constants
const PHOTOMETRIC = {
  WhiteIsZero: 0,
  BlackIsZero: 1,
  RGB: 2,
  Palette: 3,
  CMYK: 5,
  YCbCr: 6,
  CIELab: 8
};
const SAMPLE_FORMAT = { uint: 1, int: 2, float: 3 };
const EXTRA_SAMPLE = { associatedAlpha: 1, unassociatedAlpha: 2 };
const PIXEL_IS_POINT = 2;

const GDAL_HINT = 'e.g. gdalwarp -t_srs EPSG:3857 in.tif out.tif';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypedArray = any;

/** Result of importGeoTiffChart() */
export interface GeoTiffImportOutput {
  info: GeoTiffChartInfo;
  tiles: Blob;
}

/** Options of importGeoTiffChart() */
export interface GeoTiffImportOptions {
  onProgress?: (fraction: number) => void; // 0..1
  onlineLookup?: boolean; // allow looking unknown EPSG codes up online
  useWorkers?: boolean; // decode in web workers (default true)
  signal?: AbortSignal; // cancels the import (rejects with an AbortError)
  sidecars?: File[]; // companion files: .info, .tfw / .wld, .prj
  position?: GeoTiffPosition; // chart edges for an image without position information
}

// ******** decoder pool (shared, released when idle) ********

let pool: Pool;
let poolUsers = 0;
let poolTimer: ReturnType<typeof setTimeout>;

function acquirePool(useWorkers: boolean): Pool {
  if (!useWorkers || typeof Worker === 'undefined') {
    return null;
  }
  clearTimeout(poolTimer);
  if (!pool) {
    const cpus =
      (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    try {
      pool = new Pool(Math.max(1, Math.min(4, cpus - 1)));
    } catch {
      return null;
    }
  }
  poolUsers++;
  return pool;
}

function releasePool(p: Pool) {
  if (!p) {
    return;
  }
  poolUsers--;
  if (poolUsers === 0) {
    poolTimer = setTimeout(() => {
      pool?.destroy();
      pool = null;
    }, 30000);
  }
}

// ******** import ********

/**
 * @description Read a GeoTIFF chart and convert it to a tile pyramid.
 * @param file GeoTIFF file
 * @param id Chart identifier
 * @param options Progress callback, online projection lookup, workers
 * @returns Chart metadata and the tile images
 * @throws GeoTiffChartError with a message for the user
 */
export async function importGeoTiffChart(
  file: Blob & { name?: string },
  id: string,
  options: GeoTiffImportOptions = {}
): Promise<GeoTiffImportOutput> {
  const fileName = file.name ?? 'chart.tif';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tiff: any;
  try {
    tiff =
      file.size <= IN_MEMORY_MAX_BYTES
        ? await fromArrayBuffer(await file.arrayBuffer())
        : await fromBlob(file as Blob);
  } catch (err) {
    throw new GeoTiffChartError(`Not a valid TIFF file (${errorText(err)}).`);
  }

  const decoderPool = acquirePool(options.useWorkers !== false);
  try {
    // ** images **
    const count: number = await tiff.getImageCount();
    const all: GeoTIFFImage[] = [];
    for (let i = 0; i < count; i++) {
      const img: GeoTIFFImage = await tiff.getImage(i);
      defaultBitsPerSample(img);
      all.push(img);
    }
    const masks = all.filter((img) => isMask(img));
    const images = all
      .filter((img) => !isMask(img))
      .sort((a, b) => b.getWidth() - a.getWidth());
    if (images.length === 0) {
      throw new GeoTiffChartError('The file does not contain an image.');
    }
    const image = images[0];
    const width = image.getWidth();
    const height = image.getHeight();
    if (!width || !height) {
      throw new GeoTiffChartError('The image has no size.');
    }
    if (width > MAX_SIZE || height > MAX_SIZE || width * height > MAX_PIXELS) {
      throw new GeoTiffChartError(
        `The image is too large (${width} × ${height} pixels, maximum ` +
          `${MAX_SIZE} × ${MAX_SIZE} and ${
            MAX_PIXELS / 1000000
          } megapixels). ` +
          'Reduce its size first, e.g. gdal_translate -outsize 50% 50% in.tif out.tif'
      );
    }

    // ** location **
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let geoKeys: Record<string, any>;
    try {
      geoKeys = image.getGeoKeys();
    } catch (err) {
      throw new GeoTiffChartError(
        `The GeoTIFF position information is invalid (${errorText(err)}).`
      );
    }
    const companions = await readCompanions(options.sidecars ?? []);
    let location: ChartLocation;
    if (hasAffineGeoreference(image)) {
      location = await geotiffLocation(image, geoKeys, id, companions, options);
    } else {
      location = externalLocation(
        options.position,
        companions,
        width,
        height,
        id
      );
      if (!location) {
        if ((await image.getTiePoints()).length > 1) {
          throw new GeoTiffChartError(
            'The chart is georeferenced with control points (GCPs) only. ' +
              `Warp it first, ${GDAL_HINT}`
          );
        }
        throw new GeoTiffPositionRequiredError(
          [
            'The image has no position information (no GeoTIFF tags, MOOS-IvP .info file or world file).',
            ...companions.problems
          ].join(' ')
        );
      }
    }
    const { extent, pixelSize, projection } = location;
    if (!registerProjection(projection)) {
      throw new GeoTiffChartError(
        `The chart projection (${projection.name}) is not supported. ${GDAL_HINT}`
      );
    }
    if (
      ['degrees', 'degree'].includes(getProjection(projection.code)?.getUnits())
    ) {
      // longitudes given as 0..360: move the chart to -180..180
      const shift = extent[0] >= 180 ? -360 : extent[2] <= -180 ? 360 : 0;
      extent[0] += shift;
      extent[2] += shift;
    }
    const bounds = transformExtent(
      extent,
      projection.code,
      'EPSG:4326',
      16
    ) as GeoTiffExtent;
    if (!validBounds(bounds)) {
      throw new GeoTiffChartError(
        'The georeferencing places the chart outside the world ' +
          `(projection ${projection.name}). Check the projection of the file.`
      );
    }
    const groundResolution = groundPixelSize(
      extent,
      pixelSize,
      projection.code
    );

    // ** pixels **
    const format = await pixelFormat(image);
    const mask = masks.find(
      (m) => m.getWidth() === width && m.getHeight() === height
    );
    if (format.needsRange) {
      format.range = await valueRange(
        images[images.length - 1],
        format,
        decoderPool
      );
    }

    // ** convert **
    const pyramid = new TilePyramid(width, height);
    const blockRows = image.getTileHeight() || height;
    const bytesPerRow =
      width *
      (format.readRGB ? 3 : format.samples.length) *
      Math.max(1, Math.ceil(image.getBitsPerSample(0) / 8));
    let chunkRows =
      blockRows * Math.max(1, Math.floor(CHUNK_PIXELS / width / blockRows));
    chunkRows = Math.min(chunkRows, height);
    if (bytesPerRow * Math.min(blockRows, height) > MAX_CHUNK_BYTES) {
      throw new GeoTiffChartError(
        'The image is stored in blocks that are too large to be loaded. ' +
          'Re-save it with tiles, e.g. gdal_translate -co TILED=YES in.tif out.tif'
      );
    }
    const rgba = new Uint8Array(width * SLICE_ROWS * 4);
    const signal = options.signal;
    for (let y0 = 0; y0 < height; y0 += chunkRows) {
      signal?.throwIfAborted();
      const y1 = Math.min(height, y0 + chunkRows);
      const window = [0, y0, width, y1];
      let bands: TypedArray[];
      let maskBand: TypedArray;
      try {
        bands = format.readRGB
          ? await image.readRGB({
              window: window,
              pool: decoderPool,
              interleave: false,
              signal: signal
            })
          : await image.readRasters({
              window: window,
              samples: format.samples,
              pool: decoderPool,
              interleave: false,
              signal: signal
            });
        if (mask) {
          maskBand = (
            await mask.readRasters({
              window: window,
              samples: [0],
              pool: decoderPool,
              interleave: false,
              signal: signal
            })
          )[0];
        }
      } catch (err) {
        signal?.throwIfAborted();
        throw new GeoTiffChartError(
          `The image data cannot be decoded (${errorText(err)}). ` +
            'Re-compress the chart, e.g. gdal_translate -co COMPRESS=DEFLATE in.tif out.tif'
        );
      }
      for (let r = 0; r < y1 - y0; r += SLICE_ROWS) {
        const rows = Math.min(SLICE_ROWS, y1 - y0 - r);
        const n = rows * width;
        format.convert(bands, r * width, n, rgba);
        if (maskBand) {
          applyMask(maskBand, r * width, n, rgba);
        }
        await pyramid.addRows(rgba.subarray(0, n * 4), rows);
        options.onProgress?.((y0 + r + rows) / height);
        signal?.throwIfAborted();
      }
    }
    const { levels, tiles } = await pyramid.finish();
    if (levels.every((l) => l.sizes.every((s) => s === 0))) {
      throw new GeoTiffChartError('The chart is fully transparent (no data).');
    }

    const source: GeoTiffSourceInfo = {
      bands: image.getSamplesPerPixel(),
      bitsPerSample: image.getBitsPerSample(0),
      sampleFormat: image.getSampleFormat(0) ?? SAMPLE_FORMAT.uint,
      photometric: format.photometric,
      compression: (await image.fileDirectory.loadValue('Compression')) ?? 1,
      overviews: images.length - 1,
      tiled: image.isTiled,
      nodata: image.getGDALNoData(),
      colorModel: format.description,
      georeference: location.georeference
    };
    const info: GeoTiffChartInfo = {
      id: id,
      name: fileName.replace(/\.tiff?$/i, ''),
      description: `${
        GEOREFERENCE_LABEL[location.georeference]
      } · ${width} × ${height} px · ${
        projection.code.startsWith('EPSG:') ? projection.code : projection.name
      }`,
      fileName: fileName,
      fileSize: file.size,
      storedSize: tiles.size,
      added: new Date().toISOString(),
      width: width,
      height: height,
      source: source,
      projection: projection,
      extent: extent,
      pixelSize: pixelSize,
      levels: levels,
      bounds: bounds,
      groundResolution: groundResolution,
      scale: Math.max(1, Math.round(groundResolution * 100)) * 100
    };
    return { info: info, tiles: tiles };
  } finally {
    releasePool(decoderPool);
  }
}

// ******** georeferencing ********

/** Kind of file, by origin of the position information */
const GEOREFERENCE_LABEL: { [key in GeoTiffGeoreference]: string } = {
  geotiff: 'GeoTIFF',
  'moos-info': 'TIFF + .info',
  'world-file': 'TIFF + world file',
  manual: 'TIFF'
};

/** Position of the chart image */
interface ChartLocation {
  extent: GeoTiffExtent;
  pixelSize: [number, number];
  projection: GeoTiffProjectionInfo;
  georeference: GeoTiffGeoreference;
}

/** Content of the companion files */
interface Companions {
  info?: GeoTiffExtent; // MOOS-IvP .info edges
  world?: WorldFile;
  prj?: { wkt: string; name: string };
  problems: string[]; // companion files that could not be used
}

/** @description Read the companion files of the image. */
async function readCompanions(files: File[]): Promise<Companions> {
  const companions: Companions = { problems: [] };
  for (const file of files) {
    const ext = fileExtension(file.name);
    const text = file.size < 1024 * 1024 ? await file.text() : '';
    if (ext === 'info') {
      companions.info = parseMoosInfo(text) ?? companions.info;
      if (!companions.info) {
        companions.problems.push(
          `${file.name} has no lat_north / lat_south / lon_east / lon_west values.`
        );
      }
    } else if (ext === 'prj') {
      companions.prj = parsePrj(text) ?? companions.prj;
      if (!companions.prj) {
        companions.problems.push(
          `${file.name} is not a WKT coordinate system definition.`
        );
      }
    } else {
      companions.world = parseWorldFile(text) ?? companions.world;
      if (!companions.world) {
        companions.problems.push(`${file.name} is not a world file.`);
      }
    }
  }
  return companions;
}

/** @description The file has GeoTIFF tags placing the image (affine transform). */
function hasAffineGeoreference(image: GeoTIFFImage): boolean {
  const fd = image.fileDirectory;
  return (
    fd.hasTag('ModelTransformation') ||
    (fd.hasTag('ModelPixelScale') && fd.hasTag('ModelTiepoint'))
  );
}

/** @description Position from the GeoTIFF tags (projection from the .prj when the file has none). */
async function geotiffLocation(
  image: GeoTIFFImage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  geoKeys: Record<string, any> | null,
  id: string,
  companions: Companions,
  options: GeoTiffImportOptions
): Promise<ChartLocation> {
  const { extent, pixelSize } = await georeference(image, geoKeys);
  let projection: GeoTiffProjectionInfo;
  if (companions.prj && (!geoKeys || Object.keys(geoKeys).length === 0)) {
    projection = {
      code: `GEOTIFF:${id}`,
      proj4: companions.prj.wkt,
      name: companions.prj.name
    };
  } else {
    try {
      projection = await resolveProjection(geoKeys, id, extent, {
        onlineLookup:
          options.onlineLookup ??
          (typeof navigator === 'undefined' || navigator.onLine),
        timeoutMs: 5000
      });
    } catch (err) {
      if (err instanceof GeoTiffProjectionError) {
        throw new GeoTiffChartError(err.message);
      }
      throw err;
    }
  }
  return {
    extent: extent,
    pixelSize: pixelSize,
    projection: projection,
    georeference: 'geotiff'
  };
}

/**
 * @description Position of an image without GeoTIFF tags: edges entered by the
 * user, world file or MOOS-IvP .info file.
 * @returns The position or null when there is none
 */
function externalLocation(
  position: GeoTiffPosition | undefined,
  companions: Companions,
  width: number,
  height: number,
  id: string
): ChartLocation | null {
  if (position) {
    return boundsLocation(
      position.bounds,
      position.projection,
      position.source,
      width,
      height
    );
  }
  if (companions.world) {
    return worldFileLocation(
      companions.world,
      companions.prj,
      width,
      height,
      id
    );
  }
  if (companions.info) {
    // pMarineViewer stretches the image linearly between the edges
    return boundsLocation(
      companions.info,
      'EPSG:4326',
      'moos-info',
      width,
      height
    );
  }
  return null;
}

/** @description Position of an image from the latitude / longitude of its edges. */
function boundsLocation(
  bounds: GeoTiffExtent,
  code: 'EPSG:3857' | 'EPSG:4326',
  source: GeoTiffGeoreference,
  width: number,
  height: number
): ChartLocation {
  const [west, south, east, north] = bounds;
  if (
    !bounds.every((v) => isFinite(v)) ||
    south < -90 ||
    north > 90 ||
    south >= north ||
    west >= east ||
    east - west > 360
  ) {
    throw new GeoTiffChartError(
      `The chart edges are invalid (north ${north}, south ${south}, west ${west}, east ${east}).`
    );
  }
  let extent: GeoTiffExtent;
  let projection: GeoTiffProjectionInfo;
  if (code === 'EPSG:3857') {
    if (south < -85.05 || north > 85.05) {
      throw new GeoTiffChartError(
        'A Mercator chart must lie between latitudes 85°S and 85°N.'
      );
    }
    const sw = fromLonLat([west, south]);
    const ne = fromLonLat([east, north]);
    extent = [sw[0], sw[1], ne[0], ne[1]];
    projection = { code: 'EPSG:3857', name: 'Mercator' };
  } else {
    extent = [west, south, east, north];
    projection = { code: 'EPSG:4326', name: 'Latitude / longitude grid' };
  }
  return {
    extent: extent,
    pixelSize: [
      (extent[2] - extent[0]) / width,
      (extent[3] - extent[1]) / height
    ],
    projection: projection,
    georeference: source
  };
}

/** @description Position of an image from a world file (and .prj). */
function worldFileLocation(
  world: WorldFile,
  prj: { wkt: string; name: string } | undefined,
  width: number,
  height: number,
  id: string
): ChartLocation {
  if (world.b !== 0 || world.d !== 0) {
    throw new GeoTiffChartError(
      `The chart image is rotated (world file). Warp it north up first, ${GDAL_HINT}`
    );
  }
  if (!(world.a > 0) || !(world.e < 0)) {
    throw new GeoTiffChartError(
      'The chart image is mirrored or flipped (world file).'
    );
  }
  // c, f: centre of the top left pixel
  const x0 = world.c - world.a / 2;
  const y0 = world.f - world.e / 2;
  const extent: GeoTiffExtent = [
    x0,
    y0 + height * world.e,
    x0 + width * world.a,
    y0
  ];
  let projection: GeoTiffProjectionInfo;
  if (prj) {
    projection = { code: `GEOTIFF:${id}`, proj4: prj.wkt, name: prj.name };
  } else if (
    extent[0] >= -180.5 &&
    extent[2] <= 360.5 &&
    extent[1] >= -90.5 &&
    extent[3] <= 90.5
  ) {
    projection = { code: 'EPSG:4326', name: 'WGS 84 (assumed, no .prj file)' };
  } else {
    throw new GeoTiffChartError(
      'The world file coordinates are not latitudes / longitudes: select the ' +
        '.prj file of the chart too.'
    );
  }
  return {
    extent: extent,
    pixelSize: [world.a, -world.e],
    projection: projection,
    georeference: 'world-file'
  };
}

/**
 * @description Extent (projection units) and pixel size of a north up image.
 * @throws GeoTiffChartError when the image is not georeferenced with a north up affine transform
 */
async function georeference(
  image: GeoTIFFImage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  geoKeys: Record<string, any> | null
): Promise<{ extent: GeoTiffExtent; pixelSize: [number, number] }> {
  const fd = image.fileDirectory;
  const width = image.getWidth();
  const height = image.getHeight();
  const transformation: number[] = await fd.loadValue('ModelTransformation');
  const scale: number[] = await fd.loadValue('ModelPixelScale');
  const tiePoints = await image.getTiePoints();
  let x0: number;
  let y0: number;
  let sx: number;
  let sy: number;
  if (transformation && transformation.length >= 8) {
    const [a, b, , d, e, f, , h] = transformation;
    if (b !== 0 || e !== 0) {
      throw new GeoTiffChartError(
        `The chart image is rotated. Warp it north up first, ${GDAL_HINT}`
      );
    }
    sx = a;
    sy = -f;
    x0 = d;
    y0 = h;
  } else if (scale && tiePoints.length >= 1) {
    const tp = tiePoints[0];
    sx = scale[0];
    sy = scale[1];
    x0 = tp.x - tp.i * sx;
    y0 = tp.y + tp.j * sy;
  } else if (tiePoints.length > 1) {
    throw new GeoTiffChartError(
      'The chart is georeferenced with control points (GCPs) only. ' +
        `Warp it first, ${GDAL_HINT}`
    );
  } else {
    throw new GeoTiffChartError(
      'The file is not georeferenced (no GeoTIFF position information). ' +
        'Georeference it first, e.g. gdal_translate -a_srs EPSG:4326 ' +
        '-a_ullr <west> <north> <east> <south> in.tif out.tif'
    );
  }
  if (!(sx > 0) || !(sy > 0)) {
    throw new GeoTiffChartError(
      `The chart image is mirrored or flipped. Warp it north up first, ${GDAL_HINT}`
    );
  }
  if (geoKeys?.GTRasterTypeGeoKey === PIXEL_IS_POINT) {
    // the tie point is the centre of the top left pixel
    x0 -= sx / 2;
    y0 += sy / 2;
  }
  const extent: GeoTiffExtent = [x0, y0 - height * sy, x0 + width * sx, y0];
  if (!extent.every((v) => isFinite(v))) {
    throw new GeoTiffChartError('The georeferencing of the file is invalid.');
  }
  return { extent: extent, pixelSize: [sx, sy] };
}

/** Bounds are a valid lon / lat rectangle */
function validBounds(b: number[]): boolean {
  return (
    b.every((v) => isFinite(v)) &&
    b[0] < b[2] &&
    b[1] < b[3] &&
    b[0] >= -540 &&
    b[2] <= 540 &&
    b[1] >= -90.001 &&
    b[3] <= 90.001
  );
}

/** Ground size (metres) of a full resolution pixel at the centre of the chart */
function groundPixelSize(
  extent: GeoTiffExtent,
  pixelSize: [number, number],
  code: string
): number {
  const cx = (extent[0] + extent[2]) / 2;
  const cy = (extent[1] + extent[3]) / 2;
  const a = transform([cx, cy], code, 'EPSG:4326');
  const b = transform([cx + pixelSize[0], cy], code, 'EPSG:4326');
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ******** pixel formats ********

/** How the samples of a file become RGBA pixels */
interface PixelFormat {
  photometric: number;
  description: string;
  samples: number[]; // 0-based samples read with readRasters()
  readRGB: boolean; // read with readRGB() instead (YCbCr, CMYK, CIELab)
  needsRange: boolean; // values are stretched between range.min / range.max
  range?: { min: number; max: number };
  /** convert pixels [offset, offset + count) of the bands to RGBA */
  convert(
    bands: TypedArray[],
    offset: number,
    count: number,
    out: Uint8Array
  ): void;
}

/**
 * @description BitsPerSample may be omitted for bilevel images (TIFF default 1)
 * but geotiff.js needs it to read the pixels.
 */
function defaultBitsPerSample(image: GeoTIFFImage) {
  const fd = image.fileDirectory;
  if (!fd.hasTag('BitsPerSample')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fd as any).actualizedFields?.set(
      258,
      new Uint16Array(image.getSamplesPerPixel()).fill(1)
    );
  }
}

/** Image is a transparency mask (NewSubfileType bit 2) */
function isMask(image: GeoTIFFImage): boolean {
  const type = image.fileDirectory.getValue('NewSubfileType') ?? 0;
  return (type & 4) === 4;
}

/**
 * @description Work out how to convert the pixels of the image to RGBA.
 * @throws GeoTiffChartError for unsupported pixel formats
 */
async function pixelFormat(image: GeoTIFFImage): Promise<PixelFormat> {
  const fd = image.fileDirectory;
  const bands = image.getSamplesPerPixel();
  const bits = image.getBitsPerSample(0);
  const sampleFormat = image.getSampleFormat(0) ?? SAMPLE_FORMAT.uint;
  const photometric: number =
    (await fd.loadValue('PhotometricInterpretation')) ??
    (bands >= 3 ? PHOTOMETRIC.RGB : PHOTOMETRIC.BlackIsZero);
  const nodata = image.getGDALNoData();
  const extraSamples = toArray(await fd.loadValue('ExtraSamples'));
  const baseBands =
    photometric === PHOTOMETRIC.CMYK
      ? 4
      : [PHOTOMETRIC.RGB, PHOTOMETRIC.YCbCr, PHOTOMETRIC.CIELab].includes(
          photometric
        )
      ? 3
      : 1;
  // alpha band: first extra sample flagged as alpha
  const alphaIndex = extraSamples.findIndex(
    (v) =>
      v === EXTRA_SAMPLE.associatedAlpha || v === EXTRA_SAMPLE.unassociatedAlpha
  );
  const alphaBand =
    alphaIndex >= 0 && baseBands + alphaIndex < bands
      ? baseBands + alphaIndex
      : -1;
  const premultiplied =
    alphaBand >= 0 && extraSamples[alphaIndex] === EXTRA_SAMPLE.associatedAlpha;
  const alphaMax =
    alphaBand >= 0 ? 2 ** image.getBitsPerSample(alphaBand) - 1 : 1;
  const nodataNaN = nodata !== null && isNaN(nodata);
  const isNodata = (v: number) =>
    nodata !== null && (nodataNaN ? isNaN(v) : v === nodata);
  const bitsText = `${bits} bit${
    sampleFormat === SAMPLE_FORMAT.float ? ' float' : ''
  }`;
  const alphaText = alphaBand >= 0 ? ' + alpha' : '';

  if (photometric === PHOTOMETRIC.Palette) {
    if (bits > 8 || sampleFormat !== SAMPLE_FORMAT.uint) {
      throw new GeoTiffChartError(
        `${bits} bit palette images are not supported. Expand the palette ` +
          'first, e.g. gdal_translate -expand rgba in.tif out.tif'
      );
    }
    const colorMap = await fd.loadValue('ColorMap');
    if (!colorMap) {
      throw new GeoTiffChartError(
        'The palette (ColorMap) of the image is missing.'
      );
    }
    const n = 2 ** bits;
    const lut = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      lut[i * 4] = colorMap[i] >> 8;
      lut[i * 4 + 1] = colorMap[n + i] >> 8;
      lut[i * 4 + 2] = colorMap[2 * n + i] >> 8;
      lut[i * 4 + 3] = isNodata(i) ? 0 : 255;
    }
    return lutFormat(
      photometric,
      `Palette (${bits} bit)${alphaText}`,
      lut,
      alphaBand,
      alphaMax
    );
  }

  if (
    photometric === PHOTOMETRIC.WhiteIsZero ||
    photometric === PHOTOMETRIC.BlackIsZero
  ) {
    const invert = photometric === PHOTOMETRIC.WhiteIsZero;
    if (sampleFormat === SAMPLE_FORMAT.uint && bits <= 8) {
      const n = 2 ** bits;
      const lut = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        let v = n === 1 ? 255 : Math.round((i * 255) / (n - 1));
        if (invert) {
          v = 255 - v;
        }
        lut[i * 4] = v;
        lut[i * 4 + 1] = v;
        lut[i * 4 + 2] = v;
        lut[i * 4 + 3] = isNodata(i) ? 0 : 255;
      }
      return lutFormat(
        photometric,
        `Grayscale (${bitsText})${alphaText}`,
        lut,
        alphaBand,
        alphaMax
      );
    }
    // 16 / 32 bit integers or floating point values: stretch to 0..255
    const format: PixelFormat = {
      photometric: photometric,
      description: `Grayscale (${bitsText}, stretched)${alphaText}`,
      samples: alphaBand >= 0 ? [0, alphaBand] : [0],
      readRGB: false,
      needsRange: true,
      convert(bandData, offset, count, out) {
        const v0 = bandData[0];
        const a0 = alphaBand >= 0 ? bandData[1] : null;
        const min = format.range.min;
        const scale = 255 / (format.range.max - min);
        for (let i = 0, o = 0; i < count; i++, o += 4) {
          const v = v0[offset + i];
          if (isNodata(v) || isNaN(v)) {
            out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
            continue;
          }
          let g = Math.max(0, Math.min(255, Math.round((v - min) * scale)));
          if (invert) {
            g = 255 - g;
          }
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = a0 ? Math.round((a0[offset + i] * 255) / alphaMax) : 255;
        }
      }
    };
    return format;
  }

  if (photometric === PHOTOMETRIC.RGB) {
    if (bands < 3) {
      throw new GeoTiffChartError(
        `RGB image with ${bands} band(s) is not supported.`
      );
    }
    if (sampleFormat === SAMPLE_FORMAT.float || ![8, 16].includes(bits)) {
      throw new GeoTiffChartError(
        `${bitsText} RGB images are not supported. Convert the chart to 8 bit ` +
          'first, e.g. gdal_translate -ot Byte -scale in.tif out.tif'
      );
    }
    const shift = bits === 16 ? 8 : 0;
    const samples = alphaBand >= 0 ? [0, 1, 2, alphaBand] : [0, 1, 2];
    return {
      photometric: photometric,
      description: `RGB (${bitsText})${alphaText}`,
      samples: samples,
      readRGB: false,
      needsRange: false,
      convert(bandData, offset, count, out) {
        const [rb, gb, bb, ab] = bandData;
        for (let i = 0, o = 0; i < count; i++, o += 4) {
          const p = offset + i;
          const r = rb[p];
          const g = gb[p];
          const b = bb[p];
          if (nodata !== null && isNodata(r) && isNodata(g) && isNodata(b)) {
            out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
            continue;
          }
          let a = 255;
          if (ab) {
            a = Math.round((ab[p] * 255) / alphaMax);
          }
          if (premultiplied && a > 0 && a < 255) {
            out[o] = Math.min(255, Math.round(((r >> shift) * 255) / a));
            out[o + 1] = Math.min(255, Math.round(((g >> shift) * 255) / a));
            out[o + 2] = Math.min(255, Math.round(((b >> shift) * 255) / a));
          } else {
            out[o] = r >> shift;
            out[o + 1] = g >> shift;
            out[o + 2] = b >> shift;
          }
          out[o + 3] = a;
        }
      }
    };
  }

  if (
    photometric === PHOTOMETRIC.YCbCr ||
    photometric === PHOTOMETRIC.CMYK ||
    photometric === PHOTOMETRIC.CIELab
  ) {
    if (bits !== 8) {
      throw new GeoTiffChartError(
        `${bitsText} ${photometricName(photometric)} images are not supported.`
      );
    }
    return {
      photometric: photometric,
      description: `${photometricName(photometric)} (8 bit)`,
      samples: [],
      readRGB: true,
      needsRange: false,
      convert(bandData, offset, count, out) {
        const [rb, gb, bb] = bandData;
        for (let i = 0, o = 0; i < count; i++, o += 4) {
          out[o] = rb[offset + i];
          out[o + 1] = gb[offset + i];
          out[o + 2] = bb[offset + i];
          out[o + 3] = 255;
        }
      }
    };
  }

  throw new GeoTiffChartError(
    `Unsupported image colour type (TIFF photometric interpretation ${photometric}).`
  );
}

/** Pixel format using a colour lookup table (palette, grey levels) */
function lutFormat(
  photometric: number,
  description: string,
  lut: Uint8Array,
  alphaBand: number,
  alphaMax: number
): PixelFormat {
  const maxIndex = lut.length / 4 - 1;
  return {
    photometric: photometric,
    description: description,
    samples: alphaBand >= 0 ? [0, alphaBand] : [0],
    readRGB: false,
    needsRange: false,
    convert(bandData, offset, count, out) {
      const v0 = bandData[0];
      const a0 = alphaBand >= 0 ? bandData[1] : null;
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        const l = Math.min(v0[offset + i], maxIndex) * 4;
        out[o] = lut[l];
        out[o + 1] = lut[l + 1];
        out[o + 2] = lut[l + 2];
        out[o + 3] =
          a0 && lut[l + 3]
            ? Math.round((a0[offset + i] * 255) / alphaMax)
            : lut[l + 3];
      }
    }
  };
}

/** Name of a photometric interpretation */
function photometricName(photometric: number): string {
  return photometric === PHOTOMETRIC.YCbCr
    ? 'YCbCr'
    : photometric === PHOTOMETRIC.CMYK
    ? 'CMYK'
    : 'CIELab';
}

/** Make the pixels hidden by the transparency mask transparent */
function applyMask(
  mask: TypedArray,
  offset: number,
  count: number,
  out: Uint8Array
) {
  for (let i = 0; i < count; i++) {
    if (!mask[offset + i]) {
      out[i * 4 + 3] = 0;
    }
  }
}

/**
 * @description Range of the values of a single band image (nodata excluded).
 * @param image Image to scan (the smallest overview is enough)
 */
async function valueRange(
  image: GeoTIFFImage,
  format: PixelFormat,
  decoderPool: Pool
): Promise<{ min: number; max: number }> {
  const width = image.getWidth();
  const height = image.getHeight();
  const nodata = image.getGDALNoData();
  const blockRows = image.getTileHeight() || height;
  const chunkRows = Math.min(
    height,
    blockRows * Math.max(1, Math.floor(CHUNK_PIXELS / width / blockRows))
  );
  let min = Infinity;
  let max = -Infinity;
  for (let y0 = 0; y0 < height; y0 += chunkRows) {
    const y1 = Math.min(height, y0 + chunkRows);
    let band: TypedArray;
    try {
      band = (
        await image.readRasters({
          window: [0, y0, width, y1],
          samples: [format.samples[0]],
          pool: decoderPool,
          interleave: false
        })
      )[0];
    } catch (err) {
      throw new GeoTiffChartError(
        `The image data cannot be decoded (${errorText(err)}).`
      );
    }
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (v !== nodata && !isNaN(v)) {
        if (v < min) {
          min = v;
        }
        if (v > max) {
          max = v;
        }
      }
    }
  }
  if (!isFinite(min)) {
    return { min: 0, max: 1 };
  }
  return { min: min, max: max > min ? max : min + 1 };
}

// ******** tile pyramid ********

/** State of one resolution level while the pyramid is built */
class PyramidLevel {
  readonly tilesX: number;
  readonly tilesY: number;
  readonly buffer: Uint8Array; // one row of tiles
  bufferRows = 0;
  tileRow = 0;
  rowsDone = 0;
  readonly offsets: number[];
  readonly sizes: number[];

  constructor(public readonly width: number, public readonly height: number) {
    this.tilesX = Math.ceil(width / TILE);
    this.tilesY = Math.ceil(height / TILE);
    this.buffer = new Uint8Array(width * TILE * 4);
    this.offsets = new Array(this.tilesX * this.tilesY).fill(0);
    this.sizes = new Array(this.tilesX * this.tilesY).fill(0);
  }
}

/**
 * Builds the tile pyramid from the full resolution rows (top to bottom).
 * Each level halves the size of the previous one (2 x 2 box filter) until the
 * whole image fits in one tile.
 */
class TilePyramid {
  private levels: PyramidLevel[] = [];
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private position = 0;

  constructor(width: number, height: number) {
    let w = width;
    let h = height;
    for (;;) {
      this.levels.push(new PyramidLevel(w, h));
      if (w <= TILE && h <= TILE) {
        break;
      }
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
  }

  /**
   * @description Add rows (RGBA) of the full resolution image.
   * @param rgba Pixels of the rows
   * @param rows Number of rows
   */
  addRows(rgba: Uint8Array, rows: number): Promise<void> {
    return this.add(0, rgba, rows);
  }

  /**
   * @description Write the remaining rows of every level.
   * @returns The levels and the tile images
   */
  async finish(): Promise<{ levels: GeoTiffLevel[]; tiles: Blob }> {
    for (let i = 0; i < this.levels.length; i++) {
      await this.flush(i);
      const level = this.levels[i];
      if (level.rowsDone !== level.height) {
        throw new Error(
          `Tile pyramid level ${i}: ${level.rowsDone} rows of ${level.height}`
        );
      }
    }
    if (this.pending.length) {
      this.parts.push(new Blob(this.pending as BlobPart[]));
    }
    return {
      levels: this.levels.map((l) => ({
        width: l.width,
        height: l.height,
        tilesX: l.tilesX,
        tilesY: l.tilesY,
        offsets: l.offsets,
        sizes: l.sizes
      })),
      tiles: new Blob(this.parts, { type: 'application/octet-stream' })
    };
  }

  /** Add rows to a level, writing each completed row of tiles */
  private async add(index: number, rgba: Uint8Array, rows: number) {
    const level = this.levels[index];
    const rowBytes = level.width * 4;
    let src = 0;
    while (src < rows) {
      const n = Math.min(rows - src, TILE - level.bufferRows);
      level.buffer.set(
        rgba.subarray(src * rowBytes, (src + n) * rowBytes),
        level.bufferRows * rowBytes
      );
      level.bufferRows += n;
      src += n;
      if (level.bufferRows === TILE) {
        await this.flush(index);
      }
    }
  }

  /** Write the buffered row of tiles of a level and pass it down to the next level */
  private async flush(index: number) {
    const level = this.levels[index];
    if (level.bufferRows === 0) {
      return;
    }
    if (level.tileRow >= level.tilesY) {
      throw new Error(`Tile pyramid level ${index}: too many rows`);
    }
    await this.writeTileRow(level);
    const rows = level.bufferRows;
    level.rowsDone += rows;
    level.bufferRows = 0;
    level.tileRow++;
    if (index + 1 < this.levels.length) {
      const next = this.levels[index + 1];
      await this.add(
        index + 1,
        downsample(level.buffer, level.width, rows, next.width),
        Math.ceil(rows / 2)
      );
    }
  }

  /** Encode the tiles of the buffered row of a level */
  private async writeTileRow(level: PyramidLevel) {
    const rows = level.bufferRows;
    const pngs: Array<Promise<Uint8Array> | null> = [];
    // encodePng() copies the pixels before returning, the buffer can be reused
    const tile = new Uint8Array(TILE * TILE * 4);
    for (let tx = 0; tx < level.tilesX; tx++) {
      const x0 = tx * TILE;
      const cols = Math.min(TILE, level.width - x0);
      if (cols < TILE || rows < TILE) {
        tile.fill(0); // transparent padding
      }
      for (let r = 0; r < rows; r++) {
        const s = (r * level.width + x0) * 4;
        tile.set(level.buffer.subarray(s, s + cols * 4), r * TILE * 4);
      }
      let empty = true;
      let opaque = cols === TILE && rows === TILE;
      for (let i = 3; i < tile.length && (empty || opaque); i += 4) {
        const a = tile[i];
        if (a !== 0) {
          empty = false;
        }
        if (a !== 255) {
          opaque = false;
        }
      }
      pngs.push(empty ? null : encodePng(tile, TILE, TILE, !opaque));
    }
    const encoded = await Promise.all(pngs);
    for (let tx = 0; tx < level.tilesX; tx++) {
      const png = encoded[tx];
      if (png) {
        const i = level.tileRow * level.tilesX + tx;
        level.offsets[i] = this.position;
        level.sizes[i] = png.length;
        this.append(png);
      }
    }
  }

  /** Append bytes to the tile data */
  private append(bytes: Uint8Array) {
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    this.position += bytes.length;
    if (this.pendingBytes >= BLOB_PART_BYTES) {
      this.parts.push(new Blob(this.pending as BlobPart[]));
      this.pending = [];
      this.pendingBytes = 0;
    }
  }
}

/**
 * @description Halve the size of RGBA rows (2 x 2 box filter, weighted by alpha).
 * @param src Pixels
 * @param width Width of the rows
 * @param rows Number of rows
 * @param outWidth Width of the result (ceil(width / 2))
 */
function downsample(
  src: Uint8Array,
  width: number,
  rows: number,
  outWidth: number
): Uint8Array {
  const outRows = Math.ceil(rows / 2);
  const out = new Uint8Array(outWidth * outRows * 4);
  for (let oy = 0; oy < outRows; oy++) {
    const ya = oy * 2;
    const yb = Math.min(ya + 1, rows - 1);
    for (let ox = 0; ox < outWidth; ox++) {
      const xa = ox * 2;
      const xb = Math.min(xa + 1, width - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const i = (y * width + x) * 4;
          const pa = src[i + 3];
          r += src[i] * pa;
          g += src[i + 1] * pa;
          b += src[i + 2] * pa;
          a += pa;
          n++;
        }
      }
      if (a > 0) {
        const o = (oy * outWidth + ox) * 4;
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

// ******** helpers ********

/** Value of a TIFF tag as an array */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toArray(value: any): number[] {
  if (value === undefined || value === null) {
    return [];
  }
  return typeof value === 'number' ? [value] : Array.from(value);
}

/** Message of an error */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorText(err: any): string {
  return err?.message ?? String(err);
}
