# Mount Kenya Fire Analysis

A replay, analysis and planning tool for wildfire on Mount Kenya, built around
the moorland fire of 1–8 September 2026. It shows where and when that fire
burned (Sentinel-2), the satellite hotspots (NASA FIRMS), a calibrated
fire-spread model, and a 3D world of the mountain where you can start a fire
anywhere and plan the response.

The web app has three tabs:

- **Incident:** map replay of the September fire with a timeline, charts and
  the satellite evidence.
- **Drones:** a simulated drone fleet with EO/IR camera feeds.
- **Simulator:** a 3D world of the Mount Kenya forest ring (94 × 89 km) with
  two modes:
  - **Replay:** the September fire with vegetation, smoke and day/night
    lighting.
  - **What-if planner:** click to start a fire, forecast its spread, suggest
    control lines, and send helicopters, an air tanker and ground crews.

```text
pipeline/   Python: downloads and processes the data, calibrates the spread model
web/        Next.js 15 app (reads web/public/data)
.env        FIRMS_MAP_KEY, NEXT_PUBLIC_MAPBOX_TOKEN (copy .env.example)
```

The generated data in `web/public/data` (~14 MB) is committed, so the app runs
without re-running the pipeline.

## Run it

```bash
cp .env.example .env            # then fill in both keys

cd pipeline
uv sync
uv run python build.py          # downloads are cached in pipeline/cache
                                #   --no-firms   skip hotspots (no key)
                                #   --no-world   skip the 3D world data
                                #   --world-only rebuild only the 3D world data

cd ../web
pnpm install
pnpm dev                        # http://localhost:3000
```

A full first build takes about 25 minutes: roughly 10 for the incident data and
ignition search, and about 15 for the 3D world, mostly imagery and
OpenStreetMap. Re-runs use the cache and are much faster.

### Keys and map tiles

- `FIRMS_MAP_KEY`: free from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
  Used only by the pipeline.
- `NEXT_PUBLIC_MAPBOX_TOKEN`: a Mapbox public token. Mapbox renders the
  Incident and Drones maps and supplies label fonts. The satellite imagery is
  Esri World Imagery and the 3D relief is AWS Terrain Tiles (Terrarium), so
  the maps also work on accounts without Mapbox raster-tile access. The
  current account returns 429 for raster tiles.
- Browsers that block Canvas2D readback (for example Brave with strict
  fingerprinting protection) turn off Mapbox terrain. The drone camera falls
  back to flying at height above ground. The Simulator uses three.js and isn't
  affected.

## Findings for the September 2026 fire

- **Burned area:** 8,608 ha by Sentinel-2 dNBR, in line with the Mount Kenya
  Trust's 8,700 ha. Reported figures ranged from 3,000 to ~12,000 ha.
- **Progression:** burned east of Rutundu by 4 Sep, then south-west past Lake
  Alice toward Lake Ellis by 9 Sep, matching the Trust's timeline.
- **First satellite hotspot:** 2 Sep 01:31 EAT (VIIRS, NOAA-20) at 0.0371°S
  37.4841°E, within ~250 m of where the ignition search placed the start using
  Sentinel-2 alone. The start is estimated at about 19:31 on 1 Sep.
- **Hotspot counts:** 849 detections on the fire. Daily counts peak 4–6 Sep
  and collapse after rain on the afternoon of 6 Sep.
- **Model fit:** Sørensen agreement with what Sentinel-2 saw burned is 0.56 by
  4 Sep, 0.68 by 9 Sep and 0.74 for the final scar (0.66 overall).
- **Early growth:** the fire stayed under 50 ha for its first 24 hours, so an
  overnight initial attack could plausibly have held it with about half a
  kilometre of line.
- **Cause:** officially under investigation. Wild honey harvesting is
  suspected but not confirmed.

## What the pipeline does

| Step | Module | Source |
|---|---|---|
| Burned area, severity, dated progression | `sentinel.py` | Sentinel-2 L2A dNBR, pre 25 Aug vs six passes 1–24 Sep |
| Elevation, slope, fuels | `terrain.py` | Copernicus GLO-30 DEM, ESA WorldCover 2021 |
| Hourly weather at the fire | `weather.py` | ERA5 via Open-Meteo archive |
| Hotspots | `firms.py` | NASA FIRMS VIIRS (S-NPP, NOAA-20, NOAA-21) + MODIS |
| Spread model, ignition search, calibration | `simulate.py` | — |
| Map products (bands, fronts, path, rasters) | `export.py` | — |
| Simulated drone missions | `drones.py` | — |
| 3D world: heights, imagery, fuels, roads, lakes, airstrips | `world.py` | Copernicus DEM, Sentinel-2 Jul–Aug 2026 mosaic, WorldCover, OpenStreetMap |

Satellite rasters come from Microsoft Planetary Computer (no account needed).
OpenStreetMap features come from the Overpass API, which needs a User-Agent
header and returns 406 without one.

### Spread model in one paragraph

Minimum travel time on a 60 m grid, 16 directions, with rates that change every
hour: fuel base rate × wind (elliptical, from ERA5) × humidity × slope
(doubling per 10° uphill) × elevation damping, plus the reported rain and
containment on 6 and 8 Sep. The ignition point and time are found by searching
near the first FIRMS detection for the start that best reproduces the
Sentinel-2 burn. Three parameters are then calibrated against the 4 Sep, 9 Sep
and final burned areas (Sørensen score). Feeding hotspots back in as new
ignitions (hotspot assimilation) was tested and fit worse (0.63 vs 0.66), so
the replay uses the model alone.

## Web app layout

```text
web/lib/engine.ts           spread model in TypeScript (port of simulate.py), crew travel, control lines
web/lib/suppression.ts      response: helicopters, air tanker, ground crews
web/lib/run.ts              forecast + response for one scenario
web/lib/scenario.ts         weather: live forecast, worst case, 4 Sep, custom
web/lib/world.ts            3D world data loading and coordinates
web/workers/fire.worker.ts  runs scenarios off the main thread
web/components/MapView.tsx, Timeline.tsx, Charts.tsx, SidePanel.tsx   Incident tab
web/components/DronePanel.tsx, DroneCam.tsx                            Drones tab
web/components/world/       Simulator: terrain, vegetation, smoke, labels, planner, response
```

## What-if planner (Simulator tab)

Click anywhere in the world to start a fire. The spread model runs in the
browser in a Web Worker: about 0.5 s for a 32 km window and under 1 s for the
11-run ensemble, plus 1–3 s when a response is sent.

- **Weather:** live Open-Meteo forecast for that spot, a dry-season worst case,
  the 4 Sep 2026 weather, or custom wind and humidity.
- **Chance of burning:** 11 runs with wind direction ±30° and speed ±25%,
  without the response.
- **Crew travel time:** from park gates, forest stations, airstrips and main
  roads. Drive on roads and tracks, walk elsewhere (Tobler's hiking function,
  slower with altitude and vegetation), no crossing lakes.
- **Suggested control lines** along the fire's predicted edge where crews
  arrive an hour ahead of it:
  - **Initial attack:** the first hour crews can reach 80% or more of the edge.
  - **Pinch point:** once the fire has outgrown initial attack, the shortest
    reachable edge.
- **Building a line**, or drawing a firebreak, re-runs the forecast with it in
  place and shows the area with and without it.

### Response (helicopters, air tanker, ground crews)

`web/lib/suppression.ts` puts units to work on the forecast fire. Every hour
each unit acts on the fire as it stands, then the fire is re-run with
everything done so far.

- **Helicopters** (AS350 from Nanyuki, Mi-17 type from Laikipia Air Base,
  Bell 205 type from Lewa):
  - They ferry to the lake nearest the ignition, then cycle: fill, fly to the
    most imminent edge, drop, return. Once crews are on the line, they drop
    next to the crews.
  - Bucket loads shrink with density altitude (elevation plus temperature). At
    ~4,700 m on a warm moorland afternoon an AS350 lifts ~300–350 L of its
    800 L bucket.
  - They refuel at the nearest airstrip and fly in daylight only (06:30–18:30).
  - A water drop holds one 60 m cell until it dries (~1–2 h, depending on load).
- **Air tanker** (illustrative, AT-802 type, Nanyuki): retardant along ~240 m
  of the edge, holding ~8 h.
- **Hand crews of 20** from the nearest park gates, forest stations or the
  Rutundu, Lewa and Nanyuki airstrips:
  - They travel the real tracks and footpaths and anchor where they reach the
    edge before the fire.
  - They cut line along it at fuel- and slope-dependent rates (grass 400,
    heath 220, Erica 120, forest 100 m/h; 70% at night), and relocate when the
    fire moves on.
- **In the 3D world:** aircraft fly their legs, water and retardant curtains
  fall at each drop, wet ground, retardant and cut line show on the terrain,
  and crews walk their routes. Click a unit in the results to follow it with
  the camera.

Example (worst-case weather, fire north of Rutundu, 24 h): no response 2,042 ha;
two helicopters, the air tanker and six crews 1,627 ha. Helicopters alone do
little at this altitude. Crews and early initial attack matter most.

## Known limits

**Model**

- No spotting (embers jumping ahead, e.g. across Kathita Gorge), so fires that
  jump gorges are under-predicted.
- One weather point for the whole fire; ERA5 cells are ~25 km and miss local
  storms.
- Fuels come from land cover, not field surveys.
- Sentinel-2 dates burning to the day (10:40 passes), and clouds hide parts of
  some passes.
- The September replay doesn't model the firefighting that actually happened;
  it applies the reported rain and containment as slow-downs.

**Planner**

- Fire, water drops and cut line work in 60 m cells, which look blocky up
  close.
- Each section of a suggested line assumes an hour of work. Helicopters use one
  lake per fire, the nearest to the ignition.
- Aircraft figures are indicative, not operator specifications, and the air
  tanker is illustrative, not a statement about what Kenya has available.

**Drones**

- Simulated; nothing in their feeds is recorded data.

## Data and credits

- Copernicus Sentinel-2 L2A and Copernicus GLO-30 DEM (ESA / EU Copernicus),
  via Microsoft Planetary Computer
- ESA WorldCover 2021 (CC BY 4.0)
- NASA FIRMS active fires (VIIRS, MODIS)
- ERA5 reanalysis and forecasts via Open-Meteo (CC BY 4.0)
- © OpenStreetMap contributors (ODbL)
- Esri World Imagery (Esri, Maxar, Earthstar Geographics); AWS Terrain Tiles
  (Mapzen, SRTM and others)
- Incident reports: Mount Kenya Trust (via Pulse Kenya, Capital FM /
  allAfrica), Daily Nation, Mwakilishi, Tourism Update, Africanews
