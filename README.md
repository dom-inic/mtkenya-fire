# Mount Kenya Fire Analysis

A replay and analysis of the moorland fire on Mount Kenya, 1–8 September 2026:
where it burned and when (Sentinel-2), satellite hotspots (NASA FIRMS), a
calibrated fire-spread model, and a simulated drone fleet, on a 3D map.

The app has three tabs: **Incident** (map replay, charts, satellite evidence),
**Drones** (simulated fleet and thermal feeds) and **Simulator** (a 3D world of
the Mount Kenya forest ring, 94 × 89 km, where the September fire replays
with vegetation, smoke and day/night lighting).

```
pipeline/   Python: downloads and processes the data, runs the spread model
web/        Next.js 15 app that replays it (reads web/public/data)
.env        FIRMS_MAP_KEY, NEXT_PUBLIC_MAPBOX_TOKEN (copy .env.example)
```

## Run it

```bash
cp .env.example .env            # then fill in both keys

cd pipeline
uv sync
uv run python build.py          # ~3 min; downloads are cached in pipeline/cache
                                # --no-firms skips hotspots if there's no key

cd ../web
pnpm install
pnpm dev                        # http://localhost:3000
```

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

The world step is the slow one (~15 min the first time, mostly imagery and
OpenStreetMap); rebuild it alone with `uv run python build.py --world-only`,
or skip it with `--no-world`.

Satellite rasters come from Microsoft Planetary Computer (no account needed).

### Spread model in one paragraph

Minimum travel time on a 60 m grid, 16 directions, with rates that change every
hour: fuel base rate × wind (elliptical, from ERA5) × humidity × slope
(doubling per 10° uphill) × elevation damping, plus the reported rain and
containment on 6 and 8 Sep. The ignition point and time are found by searching
for the start that best reproduces the Sentinel-2 burn, then three parameters
are calibrated against the 4 Sep, 9 Sep and final burned areas (Sørensen
score). With FIRMS data, hotspots are also fed back in as ignitions, and that
run is kept if it fits better.

## What-if planner (Simulator tab)

Click anywhere in the world to start a fire. The spread model runs in the
browser (`web/lib/engine.ts`, a port of `simulate.py` in a Web Worker; about
0.5 s for a 32 km window, under 1 s for the 11-run ensemble) with:

- **Weather:** live Open-Meteo forecast for that spot, a dry-season worst case,
  the 4 Sep 2026 weather, or custom wind and humidity.
- **Chance of burning:** 11 runs with wind direction ±30° and speed ±25%.
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
  - They ferry to the lake nearest the fire, then cycle: fill, fly to the most
    imminent edge, drop, return. Once crews are on the line, they drop next to
    the crews.
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

Aircraft figures are indicative, not operator specifications.

## Known limits

- No spotting (embers jumping ahead) in the physics; hotspot assimilation stands in for it.
- One weather point for the whole fire; ERA5 cells are ~25 km and miss local storms.
- Fuels come from land cover, not field surveys. No firefighting lines are modelled.
- Sentinel-2 dates burning to the day (10:40 passes), and clouds hide parts of some passes.
- Drones are simulated; nothing in their feeds is recorded data.
