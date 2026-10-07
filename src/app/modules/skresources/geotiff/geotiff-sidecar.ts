/**
 * Companion files giving the position of TIFF chart images that have no
 * GeoTIFF tags: MOOS-IvP .info files (pMarineViewer background images) and GIS
 * world files (.tfw / .wld) with an optional .prj projection file.
 */
import { GeoTiffExtent, GeoTiffImportItem } from './geotiff-types';

/** Extensions of companion files */
export const SIDECAR_EXTENSIONS = [
  'info',
  'tfw',
  'tifw',
  'tiffw',
  'wld',
  'prj'
];

/** World file parameters (pixel centre of the top left pixel = c, f) */
export interface WorldFile {
  a: number; // pixel width
  d: number; // rotation
  b: number; // rotation
  e: number; // pixel height (negative for north up images)
  c: number; // x of the centre of the top left pixel
  f: number; // y of the centre of the top left pixel
}

/** @description Extension of a file name (lower case, without the dot). */
export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** @description File name without its extension (lower case). */
export function fileBaseName(name: string): string {
  const i = name.lastIndexOf('.');
  return (i < 0 ? name : name.slice(0, i)).toLowerCase();
}

/**
 * @description Group chart images with their companion files (same name with a
 * companion file extension, e.g. chart.tif + chart.info).
 * @param files Files selected / dropped by the user
 * @returns The images to load and the companion files without an image
 */
export function groupChartFiles(files: File[]): {
  items: GeoTiffImportItem[];
  unused: File[];
} {
  const sidecars = files.filter((f) =>
    SIDECAR_EXTENSIONS.includes(fileExtension(f.name))
  );
  const items: GeoTiffImportItem[] = files
    .filter((f) => !sidecars.includes(f))
    .map((f) => ({
      file: f,
      sidecars: sidecars.filter(
        (s) => fileBaseName(s.name) === fileBaseName(f.name)
      )
    }));
  const used = items.flatMap((i) => i.sidecars);
  return { items: items, unused: sidecars.filter((s) => !used.includes(s)) };
}

/**
 * @description Read the edges of the image from a MOOS-IvP .info file
 * (lat_north, lat_south, lon_east, lon_west).
 * @param text File content
 * @returns [west, south, east, north] or null when the file has no such values
 * (e.g. the old img_centx / img_centy / img_meters format)
 */
export function parseMoosInfo(text: string): GeoTiffExtent | null {
  const values: { [key: string]: number } = {};
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/(\/\/|#).*$/, '').trim();
    const m = content.match(
      /^([A-Za-z_]+)\s*[=:]?\s*(-?[\d.]+(?:e[-+]?\d+)?)$/i
    );
    if (m) {
      values[m[1].toLowerCase()] = parseFloat(m[2]);
    }
  }
  const north = values['lat_north'];
  const south = values['lat_south'];
  const west = values['lon_west'];
  let east = values['lon_east'];
  if (![north, south, east, west].every((v) => isFinite(v))) {
    return null;
  }
  if (east <= west) {
    east += 360; // crosses the 180 degree meridian
  }
  return [west, south, east, north];
}

/**
 * @description Read a world file (6 lines: A, D, B, E, C, F).
 * @param text File content
 * @returns World file parameters or null when the content is not a world file
 */
export function parseWorldFile(text: string): WorldFile | null {
  const values = text
    .trim()
    .split(/\s+/)
    .map((v) => Number(v));
  if (values.length < 6 || !values.slice(0, 6).every((v) => isFinite(v))) {
    return null;
  }
  const [a, d, b, e, c, f] = values;
  return { a: a, d: d, b: b, e: e, c: c, f: f };
}

/**
 * @description Read a .prj file (WKT coordinate system definition).
 * @param text File content
 * @returns The WKT and the coordinate system name, or null when it is not WKT
 */
export function parsePrj(text: string): { wkt: string; name: string } | null {
  const wkt = text.trim();
  if (
    !/^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|PROJECTEDCRS|GEODCRS)\s*\[/i.test(wkt)
  ) {
    return null;
  }
  const m = wkt.match(/^[A-Z]+\s*\[\s*"([^"]*)"/i);
  return { wkt: wkt, name: m ? m[1] : 'Coordinate system of the .prj file' };
}
