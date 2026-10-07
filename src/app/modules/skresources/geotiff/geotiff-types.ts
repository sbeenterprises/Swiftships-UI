import type { GeoTiffProjectionInfo } from './geotiff-projection';

export type { GeoTiffProjectionInfo };

/** Identifier prefix of the GeoTIFF charts stored in the browser */
export const GEOTIFF_ID_PREFIX = 'geotiff-';

/** Chart type value used for GeoTIFF charts (SKChart.type) */
export const GEOTIFF_CHART_TYPE = 'geotiff';

/** Error with a message that can be shown to the user */
export class GeoTiffChartError extends Error {}

/** The file has no position information: the chart edges must be provided */
export class GeoTiffPositionRequiredError extends GeoTiffChartError {}

/** How the position of a chart is known */
export type GeoTiffGeoreference =
  | 'geotiff' // GeoTIFF tags in the file
  | 'moos-info' // MOOS-IvP .info file (lat_north, lat_south, lon_east, lon_west)
  | 'world-file' // .tfw / .wld world file (+ optional .prj)
  | 'manual'; // edges entered by the user

/** Chart edges provided by the user (or read from a MOOS-IvP .info file) */
export interface GeoTiffPosition {
  bounds: GeoTiffExtent; // WGS84 [west, south, east, north] of the image edges
  // EPSG:3857: rows spaced like a Mercator chart, EPSG:4326: rows evenly spaced in latitude
  projection: 'EPSG:3857' | 'EPSG:4326';
  source: 'moos-info' | 'manual';
}

/** A chart file to load, with its optional companion files */
export interface GeoTiffImportItem {
  file: File; // .tif / .tiff image
  sidecars?: File[]; // .info, .tfw / .tifw / .wld, .prj files with the same name
  position?: GeoTiffPosition; // chart edges, for images without position information
}

/** Size (pixels) of the tiles the charts are stored in */
export const GEOTIFF_TILE_SIZE = 256;

/** Extent as [minx, miny, maxx, maxy] */
export type GeoTiffExtent = [number, number, number, number];

/**
 * One resolution level of the stored tile pyramid.
 * Tiles are PNG images stored back to back in the chart `tiles` blob, row by row
 * from the top left corner of the chart.
 */
export interface GeoTiffLevel {
  width: number; // level size (pixels)
  height: number;
  tilesX: number; // number of tile columns
  tilesY: number; // number of tile rows
  offsets: number[]; // byte offset of each tile in the tiles blob
  sizes: number[]; // byte size of each tile (0 = empty / fully transparent tile)
}

/** Description of the GeoTIFF file the chart was loaded from */
export interface GeoTiffSourceInfo {
  bands: number; // samples per pixel
  bitsPerSample: number;
  sampleFormat: number; // TIFF SampleFormat (1 = uint, 2 = int, 3 = float)
  photometric: number; // TIFF PhotometricInterpretation
  compression: number; // TIFF Compression
  overviews: number; // internal reduced resolution images
  tiled: boolean;
  nodata: number | null; // GDAL_NODATA
  colorModel: string; // e.g. 'Palette (8 bit)', 'RGB (8 bit) + alpha'
  georeference?: GeoTiffGeoreference; // absent for charts loaded before it was recorded
}

/** Chart metadata derived from the GeoTIFF file when it is loaded */
export interface GeoTiffChartInfo {
  id: string;
  name: string;
  description: string;
  fileName: string;
  fileSize: number; // bytes (original file)
  storedSize: number; // bytes (stored tiles)
  added: string; // ISO 8601 timestamp of the import
  width: number; // full resolution image size (pixels)
  height: number;
  source: GeoTiffSourceInfo;
  projection: GeoTiffProjectionInfo;
  extent: GeoTiffExtent; // full image extent in projection units
  pixelSize: [number, number]; // full resolution pixel size in projection units (x, y)
  levels: GeoTiffLevel[]; // [0] = full resolution
  bounds: GeoTiffExtent; // WGS84 [west, south, east, north]
  groundResolution: number; // full resolution pixel size (metres, at the chart centre)
  scale: number; // estimated chart scale (254 dpi raster)
}

/** Stored chart: metadata plus the tile images */
export interface GeoTiffChartRecord extends GeoTiffChartInfo {
  tiles: Blob;
}

/** Progress of a GeoTIFF import */
export interface GeoTiffImportProgress {
  fileName: string;
  index: number; // 0-based index of the file being loaded
  count: number; // number of files being loaded
  fraction: number; // 0..1 progress of the current file
}

/** Result of a GeoTIFF import */
export interface GeoTiffImportResult {
  imported: GeoTiffChartInfo[];
  errors: Array<{ fileName: string; message: string }>;
  // images without position information: load them again with a position
  needPosition: Array<{ item: GeoTiffImportItem; message: string }>;
  persistent: boolean; // false when the charts could not be kept in the browser storage
  cancelled: boolean; // the import was cancelled (remaining files not loaded)
}
