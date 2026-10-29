"""
Build every data product the web app reads (web/public/data):

    uv run python build.py            # everything
    uv run python build.py --no-firms # skip hotspots (no FIRMS key)

Downloads are cached in pipeline/cache, so re-runs are quick.
"""

import argparse
import json
from datetime import datetime
from datetime import timedelta

import numpy as np
from shapely.geometry import Point
from shapely.geometry import shape

from mkfire import drones
from mkfire import export
from mkfire import firms
from mkfire import observed
from mkfire import sentinel
from mkfire import simulate
from mkfire import terrain
from mkfire import weather
from mkfire import world
from mkfire.common import write_json
from mkfire.config import INCIDENT_END
from mkfire.config import INCIDENT_START
from mkfire.config import KEY_EVENTS
from mkfire.config import OUT
from mkfire.config import PLACES
from mkfire.config import REPORTED_AREAS

# Reported events the hourly reanalysis misses: local rain + containment lines
# on the afternoon of 6 Sep, then ~85% suppressed by 8 Sep.
CONSTRAINTS = [("2026-09-06T14:00", 0.15), ("2026-09-08T12:00", 0.0)]


def tag_hotspots(fc, perimeter):
    """Mark detections on this fire (within 1 km of the satellite perimeter)."""
    zone = perimeter.buffer(0.009)
    for f in fc["features"]:
        f["properties"]["this_fire"] = zone.contains(Point(f["geometry"]["coordinates"]))
    return fc


def first_detection(hotspots):
    """Earliest overpass with hotspots on this fire: (time, [(lat, lon)]) or None."""
    on_fire = [f for f in (hotspots or {"features": []})["features"] if f["properties"]["this_fire"]]
    if not on_fire:
        return None
    t_first = min(f["properties"]["t"] for f in on_fire)
    pts = [tuple(reversed(f["geometry"]["coordinates"])) for f in on_fire if f["properties"]["t"] == t_first]
    return datetime.fromisoformat(t_first), pts


def find_ignition(terr, wx, hotspots, start, hours, obs):
    """
    Search for the ignition point and time. With FIRMS: points within 1.5 km
    of the first hotspots, starting 0-6 h before that overpass. Without: points
    in the ground Sentinel-2 saw burned by 4 Sep, starting during 1 Sep (the
    reported day).
    """
    first = first_detection(hotspots)
    if first:
        t, pts = first
        yy, xx = np.ogrid[:terrain.GRID.height, :terrain.GRID.width]
        region = np.zeros(terrain.GRID.shape, bool)
        for lat, lon in pts:
            r, c = terrain.GRID.rowcol(lat, lon)
            region |= (yy - r) ** 2 + (xx - c) ** 2 <= (1500 / terrain.GRID.res) ** 2
        candidates = simulate.candidate_ignitions(region, spacing_cells=4)
        # Reported on 1 Sep; the first hotspot can come many hours after ignition
        times = [t - timedelta(hours=h) for h in (18, 14, 10, 6, 3, 0)
                 if t - timedelta(hours=h) >= start]
        basis = f"first FIRMS detection {t:%d %b %H:%M} EAT"
    else:
        candidates = simulate.candidate_ignitions(obs[0][1], spacing_cells=10)
        times = [datetime.fromisoformat(f"2026-09-01T{h}") for h in ("03:00", "09:00", "15:00")]
        basis = "Sentinel-2 burn by 4 Sep; reported start 1 Sep"
    _, seeds = simulate.locate_ignition(terr, wx, candidates, times, start, hours, obs, CONSTRAINTS)
    return seeds, basis


def main(use_firms=True, use_world=True):
    s2 = sentinel.run()
    terr = terrain.run()
    wx = weather.run()

    observed_fc = json.loads((OUT / "observed_perimeters.geojson").read_text())
    perimeter = shape(next(f["geometry"] for f in observed_fc["features"]
                           if f["properties"]["kind"] == "final_perimeter"))

    hotspots = None
    if use_firms:
        hotspots = tag_hotspots(firms.run(), perimeter)
        write_json("hotspots.geojson", hotspots)

    start = datetime.fromisoformat(INCIDENT_START)
    hours = int((datetime.fromisoformat(INCIDENT_END) - start).total_seconds() // 3600)
    obs = observed.on_sim_grid()
    seeds, basis = find_ignition(terr, wx, hotspots, start, hours, obs)
    print("Ignition:", seeds, "from", basis)
    score, params, arrival, detail = simulate.calibrate(terr, wx, seeds, start, hours, obs, CONSTRAINTS)
    print(f"Best: {params} score {score:.3f} {detail}")

    # Hotspot assimilation: every FIRMS detection on this fire also starts fire
    # at its overpass time, so jumps the model can't produce (spotting across
    # Kathita Gorge) still happen. Kept only if it fits Sentinel-2 better.
    model_only = {"score": round(score, 3), "detail": detail}
    assimilated = None
    # VIIRS only (375 m pixels; MODIS is 1 km), nominal/high confidence
    detections = [
        (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0], datetime.fromisoformat(f["properties"]["t"]))
        for f in (hotspots or {"features": []})["features"]
        if f["properties"]["this_fire"] and f["properties"]["sensor"].startswith("VIIRS")
        and f["properties"]["conf"] != "low" and INCIDENT_START <= f["properties"]["t"] < INCIDENT_END
    ]
    if detections:
        arr2, added = simulate.assimilate(terr, wx, seeds, detections, start, hours, params, CONSTRAINTS)
        s_a, d_a = simulate.score(arr2, start, obs)
        assimilated = {"score": round(s_a, 3), "detail": d_a, "detections": len(added),
                       "candidates": len(detections),
                       "seeds": [{"lat": round(a, 5), "lon": round(b, 5), "t": t.strftime("%Y-%m-%dT%H:%M")}
                                 for a, b, t in added]}
        print(f"Assimilated {len(added)} of {len(detections)} VIIRS hotspots as jumps: score {s_a:.3f} {d_a}")
        if s_a > score:
            score, arrival, detail = s_a, arr2, d_a

    np.save(sentinel.CACHE / "arrival.npy", arrival)
    sim = export.write_all(arrival, start, hours, seeds[0])
    fleet = drones.run(arrival, start, terr)
    write_json("drones.json", fleet)

    window = [w for w in wx if INCIDENT_START <= w["time"] < INCIDENT_END]
    on_fire = [f for f in (hotspots or {"features": []})["features"] if f["properties"]["this_fire"]]
    incident = {
        "meta": {
            "name": "Mount Kenya Moorland Fire",
            "id": "KE-MTK-2026-09",
            "location": "Mount Kenya National Park, NE moorlands (Meru / Tharaka-Nithi)",
            "start": INCIDENT_START, "end": INCIDENT_END,
            "first_reported": "2026-09-01",
            "area_ha": s2["final_area_ha"],
            "cause": "Under investigation; wild honey harvesting suspected, not confirmed",
            "status": "Contained (rain 6 Sep, ~85% suppressed 8 Sep)",
            "reported_areas": REPORTED_AREAS,
        },
        "places": [{"name": n, "lat": la, "lon": lo} for n, (la, lo) in PLACES.items()],
        "events": KEY_EVENTS,
        "weather": window,
        "sentinel": s2,
        "fuels": [{"code": c, "name": n, "base_ros": r, "colour": col}
                  for c, (n, r, col) in terrain.FUELS.items()],
        "fuels_corners": terr["corners"].tolist(),
        "hotspots": {"count": len(on_fire), "first": min((f["properties"]["t"] for f in on_fire), default=None),
                     "available": hotspots is not None},
        "sim": {
            "params": params.__dict__, "score": round(score, 3), "score_detail": detail,
            "constraints": CONSTRAINTS,
            "ignitions": [{"lat": la, "lon": lo, "t": t.strftime("%Y-%m-%dT%H:%M")} for la, lo, t in seeds],
            "ignition_basis": basis,
            "model_only": model_only,
            "assimilated": assimilated,
            "uses_assimilation": bool(assimilated) and assimilated["score"] > model_only["score"],
            "final_ha": round(float(np.isfinite(arrival).sum() * terrain.GRID.cell_ha)),
            **sim,
        },
    }
    write_json("incident.json", incident)
    if use_world:
        world.run()
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-firms", action="store_true")
    ap.add_argument("--no-world", action="store_true", help="skip the 3D world data")
    ap.add_argument("--world-only", action="store_true", help="only rebuild the 3D world data")
    args = ap.parse_args()
    if args.world_only:
        world.run()
    else:
        main(use_firms=not args.no_firms, use_world=not args.no_world)
