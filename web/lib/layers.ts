export type LayerId =
  | "sim"
  | "fronts"
  | "path"
  | "observed"
  | "hotspots"
  | "severity"
  | "falsecolour"
  | "arrival"
  | "fuels"
  | "drones"
  | "places";

export interface LayerDef {
  id: LayerId;
  label: string;
  group: "Model" | "Satellite" | "Context";
  source: string;
  swatch: string;
  on: boolean;
  opacity: number;
  /** Whether the opacity slider applies */
  fades?: boolean;
}

export const LAYERS: LayerDef[] = [
  { id: "sim", label: "Fire spread (modelled)", group: "Model", source: "Calibrated spread model, hourly", swatch: "linear-gradient(90deg,#fff3b0,#fb5607,#9d0208)", on: true, opacity: 0.9, fades: true },
  { id: "fronts", label: "Fire fronts, 12-hourly", group: "Model", source: "Model isochrones", swatch: "#fde68a", on: true, opacity: 1 },
  { id: "path", label: "Spread path", group: "Model", source: "Where the model fire grew fastest", swatch: "#facc15", on: true, opacity: 1 },
  { id: "observed", label: "Burned area seen by Sentinel-2", group: "Satellite", source: "Sentinel-2 dNBR, 6 passes", swatch: "#60a5fa", on: true, opacity: 1 },
  { id: "hotspots", label: "Hotspots (VIIRS / MODIS)", group: "Satellite", source: "NASA FIRMS, last 24 h", swatch: "#ef4444", on: true, opacity: 1 },
  { id: "severity", label: "Burn severity (dNBR)", group: "Satellite", source: "Sentinel-2, 25 Aug vs 9–24 Sep", swatch: "linear-gradient(90deg,#fff176,#ffa726,#e53935,#6a1b9a)", on: false, opacity: 0.85, fades: true },
  { id: "falsecolour", label: "Post-fire image, 19 Sep", group: "Satellite", source: "Sentinel-2 SWIR / NIR / red", swatch: "linear-gradient(90deg,#6b2d1a,#3f7d3a)", on: false, opacity: 1, fades: true },
  { id: "arrival", label: "Arrival time (modelled)", group: "Model", source: "When the model fire reached each cell", swatch: "linear-gradient(90deg,#ffeca0,#f4511e,#4a148c)", on: false, opacity: 0.8, fades: true },
  { id: "fuels", label: "Fuels", group: "Context", source: "ESA WorldCover + elevation", swatch: "linear-gradient(90deg,#e8c547,#d6832e,#2e6e40)", on: false, opacity: 0.7, fades: true },
  { id: "drones", label: "Drone fleet (simulated)", group: "Context", source: "Simulated missions", swatch: "#22d3ee", on: true, opacity: 1 },
  { id: "places", label: "Places", group: "Context", source: "OpenStreetMap", swatch: "#ffffff", on: true, opacity: 1 },
];

export type LayerState = Record<LayerId, { on: boolean; opacity: number }>;

export const initialLayerState = (): LayerState =>
  Object.fromEntries(LAYERS.map((l) => [l.id, { on: l.on, opacity: l.opacity }])) as LayerState;
