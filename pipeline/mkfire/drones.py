"""
Simulated drone fleet. No drones flew this fire as far as reports say; these
missions show what a fleet would have done, flying against the *modelled*
fire. Positions every STEP minutes while deployed.
"""

import math
from datetime import datetime

import numpy as np
from scipy import ndimage as ndi
from shapely.geometry import shape

from .common import mask_to_geometry
from .config import PLACES
from .terrain import GRID

STEP = 3  # minutes
DEPLOY = ("2026-09-02T06:00", "2026-09-08T12:00")  # response began 2 Sep; ~contained 8 Sep

FLEET = [
    {"id": "KE-01", "name": "Kestrel", "aircraft": "Fixed-wing VTOL", "mission": "Perimeter mapping",
     "task": "Flies the current fire edge, re-mapping it every lap", "sensor": "EO/IR, 30x zoom",
     "agl": 450, "speed_kmh": 60},
    {"id": "KE-02", "name": "Harrier", "aircraft": "Heavy-lift quadcopter", "mission": "Head-fire watch",
     "task": "Circles where the fire is growing fastest", "sensor": "Radiometric thermal",
     "agl": 150, "speed_kmh": 35, "radius": 400},
    {"id": "KE-03", "name": "Swift", "aircraft": "Quadcopter", "mission": "Flank & spot watch",
     "task": "Circles the flank burned a few hours ago, watching for flare-ups", "sensor": "EO/IR",
     "agl": 120, "speed_kmh": 30, "radius": 300},
    {"id": "KE-04", "name": "Osprey", "aircraft": "Quadcopter", "mission": "Asset protection",
     "task": "Patrols Rutundu cabins and the track to them", "sensor": "EO/IR, spotlight",
     "agl": 120, "speed_kmh": 30, "radius": 350},
    {"id": "KE-05", "name": "Condor", "aircraft": "Fixed-wing", "mission": "Burn-severity survey",
     "task": "Lawnmower passes over burned ground for a severity map", "sensor": "Multispectral + LiDAR",
     "agl": 600, "speed_kmh": 70},
    {"id": "KE-06", "name": "Wren", "aircraft": "Quadcopter", "mission": "Comms relay",
     "task": "Holds on high ground relaying radio for ground crews", "sensor": "Mesh radio relay, EO",
     "agl": 120, "speed_kmh": 20, "radius": 150},
]

M_PER_DEG = 111_320


def ground(dem, lat, lon):
    r, c = GRID.rowcol(lat, lon)
    r = min(max(r, 0), GRID.height - 1)
    c = min(max(c, 0), GRID.width - 1)
    return float(dem[r, c])


def offset(lat, lon, north_m, east_m):
    return lat + north_m / M_PER_DEG, lon + east_m / (M_PER_DEG * math.cos(math.radians(lat)))


def orbit(center, radius, speed_kmh, minute):
    w = (speed_kmh * 1000 / 60) / radius  # rad per minute
    a = w * minute
    return offset(center[0], center[1], radius * math.cos(a), radius * math.sin(a))


def perimeter_ring(mask):
    geom = mask_to_geometry(ndi.binary_opening(mask, iterations=1), GRID, simplify=GRID.res)
    if not geom:
        return None
    g = shape(geom)
    poly = max(g.geoms, key=lambda p: p.area) if g.geom_type == "MultiPolygon" else g
    return poly.exterior


def along(ring, frac):
    p = ring.interpolate(frac % 1.0, normalized=True)
    return p.y, p.x


def patch_centroid(mask):
    if mask.sum() < 3:
        return None
    lab, n = ndi.label(mask)
    big = lab == np.argmax(ndi.sum(mask, lab, range(1, n + 1))) + 1
    r, c = ndi.center_of_mass(big)
    return GRID.latlon(r, c)


def lawnmower(bounds, spacing_m, speed_kmh, minute):
    """Back-and-forth east-west lines across bounds (min_lon, min_lat, max_lon, max_lat)."""
    w = (bounds[2] - bounds[0]) * M_PER_DEG
    h = (bounds[3] - bounds[1]) * M_PER_DEG
    lines = max(int(h // spacing_m), 1)
    total = lines * (w + spacing_m)
    d = (speed_kmh * 1000 / 60 * minute) % (2 * total)
    d = d if d < total else 2 * total - d  # fly the pattern back again
    i, x = divmod(d, w + spacing_m)
    i = int(i)
    east = min(x, w) if i % 2 == 0 else w - min(x, w)
    north = i * spacing_m + max(x - w, 0)
    return bounds[1] + north / M_PER_DEG, bounds[0] + east / M_PER_DEG


def high_point(dem, near, radius_m=4000):
    r0, c0 = GRID.rowcol(*near)
    rad = int(radius_m / GRID.res)
    win = dem[max(r0 - rad, 0):r0 + rad, max(c0 - rad, 0):c0 + rad]
    r, c = np.unravel_index(np.argmax(win), win.shape)
    return GRID.latlon(max(r0 - rad, 0) + r, max(c0 - rad, 0) + c)


def heading(a, b):
    dn = (b[0] - a[0]) * M_PER_DEG
    de = (b[1] - a[1]) * M_PER_DEG * math.cos(math.radians(a[0]))
    return round((math.degrees(math.atan2(de, dn)) + 360) % 360)


def run(arrival, start, terrain):
    dem = terrain["dem"]
    t0 = datetime.fromisoformat(DEPLOY[0])
    t1 = datetime.fromisoformat(DEPLOY[1])
    first_min = int((t0 - start).total_seconds() // 60)
    last_min = int((t1 - start).total_seconds() // 60)

    final = np.isfinite(arrival)
    rows, cols = np.nonzero(final)
    (lat_a, lon_a), (lat_b, lon_b) = GRID.latlon(rows.max(), cols.min()), GRID.latlon(rows.min(), cols.max())
    burned_bounds = (lon_a, lat_a, lon_b, lat_b)
    relay = high_point(dem, patch_centroid(final))

    # Hourly mission targets from the modelled fire
    hourly = {}
    for m in range(first_min - first_min % 60, last_min + 60, 60):
        burned = arrival <= m
        hourly[m] = {
            "ring": perimeter_ring(burned) if burned.sum() > 10 else None,
            "head": patch_centroid((arrival > m - 120) & (arrival <= m)),
            "flank": patch_centroid((arrival > m - 360) & (arrival <= m - 120)),
        }

    tracks, last_center = {}, {}
    for d in FLEET:
        pts, last = [], None
        for m in range(first_min, last_min + 1, STEP):
            h = hourly[m - m % 60]
            k = d["id"]
            if k == "KE-01":
                if h["ring"] is None:
                    continue
                lap_min = h["ring"].length * M_PER_DEG / (d["speed_kmh"] * 1000 / 60)
                pos = along(h["ring"], (m - first_min) / lap_min)
            elif k == "KE-02":
                c = h["head"] or last_center.get(k)
                if c is None:
                    continue
                pos = orbit(c, d["radius"], d["speed_kmh"], m)
            elif k == "KE-03":
                c = h["flank"] or h["head"]
                if c is None:
                    continue
                pos = orbit(c, d["radius"], d["speed_kmh"], m)
            elif k == "KE-04":
                pos = orbit(PLACES["Rutundu cabins"], d["radius"], d["speed_kmh"], m)
            elif k == "KE-05":
                pos = lawnmower(burned_bounds, 800, d["speed_kmh"], m - first_min)
            else:
                pos = orbit(relay, d["radius"], d["speed_kmh"], m)
            if k == "KE-02" and h["head"]:
                last_center[k] = h["head"]
            alt = ground(dem, *pos) + d["agl"]
            hd = heading(last, pos) if last else 0
            pts.append([m, round(pos[1], 5), round(pos[0], 5), round(alt), hd])
            last = pos
        tracks[d["id"]] = pts
    print(f"Drones: {sum(len(v) for v in tracks.values())} positions, relay at {relay}")
    return {"step_min": STEP, "start": start.strftime("%Y-%m-%dT%H:%M"),
            "deploy": list(DEPLOY), "fleet": FLEET, "tracks": tracks,
            "columns": ["minute", "lon", "lat", "alt_m", "heading"]}

