"""
Turn the spread model's arrival-time grid into what the web app draws:
hourly growth bands, 12-hourly fire-front lines, the head-of-fire path, an
arrival-time image and an hourly area series.
"""

from datetime import timedelta

import numpy as np
from scipy import ndimage as ndi
from shapely.geometry import shape

from .common import mask_to_geometry
from .common import write_json
from .common import write_overlay
from .terrain import GRID


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M")


def bands(arrival, start, hours):
    """One polygon per hour: the ground the model burns during that hour."""
    feats = []
    for h in range(hours):
        m = (arrival >= h * 60) & (arrival < (h + 1) * 60)
        if not m.any():
            continue
        geom = mask_to_geometry(m, GRID, simplify=GRID.res * 0.6)
        if geom:
            feats.append({"type": "Feature", "geometry": geom, "properties": {
                "h": h, "t": iso(start + timedelta(hours=h)),
                "ha": round(float(m.sum() * GRID.cell_ha), 1)}})
    return {"type": "FeatureCollection", "features": feats}


def isochrones(arrival, start, hours, every=12):
    """Outline of everything burned by each step, as lines with time labels."""
    feats = []
    for h in range(every, hours + 1, every):
        m = arrival <= h * 60
        if not m.any():
            continue
        geom = mask_to_geometry(ndi.binary_opening(m), GRID, simplify=GRID.res)
        if not geom:
            continue
        lines = shape(geom).boundary
        feats.append({"type": "Feature", "geometry": lines.__geo_interface__, "properties": {
            "h": h, "t": iso(start + timedelta(hours=h))}})
    return {"type": "FeatureCollection", "features": feats}


def head_path(arrival, start, hours, ignition, step=6):
    """
    Where the fire was growing fastest: every `step` hours, the centroid of the
    largest patch burned during that window. Joined up it shows the run of the fire.
    """
    pts = [{"t": iso(ignition[2]), "lat": ignition[0], "lon": ignition[1], "ha": 0}]
    for h in range(step, hours + 1, step):
        m = (arrival > (h - step) * 60) & (arrival <= h * 60)
        if m.sum() * GRID.cell_ha < 20:
            continue
        lab, n = ndi.label(m)
        big = lab == np.argmax(ndi.sum(m, lab, range(1, n + 1))) + 1
        r, c = ndi.center_of_mass(big)
        lat, lon = GRID.latlon(r, c)
        pts.append({"t": iso(start + timedelta(hours=h)), "lat": round(lat, 5),
                    "lon": round(lon, 5), "ha": round(float(m.sum() * GRID.cell_ha))})
    return pts


def series(arrival, start, hours):
    out = []
    for h in range(hours + 1):
        burned = float((arrival <= h * 60).sum() * GRID.cell_ha)
        grew = float(((arrival > (h - 1) * 60) & (arrival <= h * 60)).sum() * GRID.cell_ha) if h else 0
        out.append({"t": iso(start + timedelta(hours=h)), "burned_ha": round(burned),
                    "growth_ha_h": round(grew, 1)})
    return out


def arrival_image(arrival, hours):
    """Arrival time as colour: yellow (early) to deep purple (late)."""
    stops = np.array([[255, 236, 160], [255, 183, 77], [244, 81, 30], [183, 28, 28], [74, 20, 140]], float)
    burned = np.isfinite(arrival)
    f = np.clip(np.nan_to_num(arrival / (hours * 60), posinf=1), 0, 1) * (len(stops) - 1)
    i = np.minimum(f.astype(int), len(stops) - 2)
    frac = (f - i)[..., None]
    rgb = stops[i] * (1 - frac) + stops[i + 1] * frac
    rgba = np.zeros(arrival.shape + (4,), np.uint8)
    rgba[..., :3] = rgb.astype(np.uint8)
    rgba[..., 3] = np.where(burned, 230, 0)
    return write_overlay("sim_arrival.png", rgba, GRID)


def write_all(arrival, start, hours, ignition):
    write_json("sim_bands.geojson", bands(arrival, start, hours))
    write_json("sim_isochrones.geojson", isochrones(arrival, start, hours))
    return {"series": series(arrival, start, hours),
            "path": head_path(arrival, start, hours, ignition),
            "arrival_corners": arrival_image(arrival, hours)}
