/**
 * OpenLayers layer for the GeoTIFF charts stored in the browser.
 */
import ImageTile from 'ol/ImageTile';
import Tile from 'ol/Tile';
import BaseLayer from 'ol/layer/Base';
import TileLayer from 'ol/layer/Tile';
import TileImage from 'ol/source/TileImage';
import TileGrid from 'ol/tilegrid/TileGrid';

import { GEOTIFF_TILE_SIZE, GeoTiffChartRecord } from './geotiff-types';
import { registerProjection } from './geotiff-projection';

/** Layer property marking a GeoTIFF chart layer */
const GEOTIFF_LAYER = 'geotiffChart';

/**
 * @description Create the layer that displays a GeoTIFF chart from its stored tiles.
 * @param chart Stored chart
 * @param zIndex Layer zIndex
 * @returns Tile layer or undefined if the chart projection is not available
 */
export function createGeoTiffChartLayer(
  chart: GeoTiffChartRecord,
  zIndex: number
): TileLayer<TileImage> {
  if (!registerProjection(chart.projection)) {
    console.warn(
      `GeoTIFF chart ${chart.name}: projection ${chart.projection.code} unavailable!`
    );
    return undefined;
  }
  const levels = chart.levels;
  const top = levels.length - 1; // zoom level (z) of the full resolution tiles
  const [sx, sy] = chart.pixelSize;
  // tiles are square in pixels; non square pixels make them rectangular on the map
  const ratio = sy / sx;
  const tileGrid = new TileGrid({
    extent: chart.extent,
    origin: [chart.extent[0], chart.extent[3]],
    resolutions: levels.map((l, i) => sx * 2 ** (top - i)),
    tileSize:
      Math.abs(ratio - 1) < 1e-9
        ? GEOTIFF_TILE_SIZE
        : [GEOTIFF_TILE_SIZE, GEOTIFF_TILE_SIZE * ratio]
  });

  /** index of a tile in its level, or -1 when there is no tile */
  const tileIndex = (z: number, x: number, y: number): number => {
    const level = levels[top - z];
    if (!level || x < 0 || y < 0 || x >= level.tilesX || y >= level.tilesY) {
      return -1;
    }
    const i = y * level.tilesX + x;
    return level.sizes[i] ? i : -1;
  };

  const source = new TileImage({
    projection: chart.projection.code,
    tileGrid: tileGrid,
    interpolate: true,
    wrapX: false,
    tileUrlFunction: (tileCoord) =>
      tileIndex(tileCoord[0], tileCoord[1], tileCoord[2]) < 0
        ? undefined
        : `${tileCoord[0]}/${tileCoord[1]}/${tileCoord[2]}`,
    tileLoadFunction: (tile: Tile, src: string) => {
      const [z, x, y] = src.split('/').map((v) => Number(v));
      const i = tileIndex(z, x, y);
      const image = (tile as ImageTile).getImage() as HTMLImageElement;
      if (i < 0) {
        image.src = '';
        return;
      }
      const level = levels[top - z];
      const url = URL.createObjectURL(
        chart.tiles.slice(
          level.offsets[i],
          level.offsets[i] + level.sizes[i],
          'image/png'
        )
      );
      let revoked = false;
      const revoke = () => {
        if (!revoked) {
          revoked = true;
          URL.revokeObjectURL(url);
        }
      };
      image.addEventListener('load', revoke, { once: true });
      image.addEventListener('error', revoke, { once: true });
      // a tile load can be abandoned without load / error event
      setTimeout(revoke, 30000);
      image.src = url;
    }
  });

  const layer = new TileLayer({
    source: source,
    preload: 0,
    zIndex: zIndex
  });
  layer.set(GEOTIFF_LAYER, true);
  return layer;
}

/** @description Layer was created by createGeoTiffChartLayer() */
export function isGeoTiffChartLayer(layer: BaseLayer): boolean {
  return !!layer?.get(GEOTIFF_LAYER);
}

/**
 * @description Release the resources (cached tile images) of a GeoTIFF chart
 * layer after it has been removed from the map.
 */
export function disposeGeoTiffChartLayer(layer: BaseLayer) {
  if (isGeoTiffChartLayer(layer)) {
    layer.dispose();
  }
}
