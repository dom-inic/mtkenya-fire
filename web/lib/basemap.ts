import type { StyleSpecification } from "mapbox-gl";

/**
 * Imagery and elevation sources. Esri World Imagery for the satellite base
 * and the open AWS Terrain Tiles (Terrarium encoding) for 3D relief; Mapbox
 * renders, and supplies fonts for labels.
 */
export const IMAGERY = {
  type: "raster" as const,
  tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
  tileSize: 256,
  maxzoom: 18,
  attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
};

export const ELEVATION = {
  type: "raster-dem" as const,
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  encoding: "terrarium" as const,
  tileSize: 256,
  maxzoom: 15,
  attribution: "Elevation: Mapzen Terrain Tiles (SRTM, others)",
};

export const GLYPHS = "mapbox://fonts/mapbox/{fontstack}/{range}.pbf";

export function satelliteStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { imagery: IMAGERY, dem: ELEVATION },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#d9d2c5" } },
      { id: "imagery", type: "raster", source: "imagery", paint: { "raster-fade-duration": 150 } },
    ],
  };
}
