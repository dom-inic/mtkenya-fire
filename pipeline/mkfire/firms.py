"""
Active-fire hotspots from NASA FIRMS: VIIRS (S-NPP, NOAA-20, NOAA-21; 375 m)
and MODIS (Terra, Aqua; 1 km). Each satellite passes about twice a day, so
together they give a hotspot snapshot every few hours.

Uses the standard-processing (SP) archive where FIRMS has it for the dates,
otherwise the near-real-time (NRT) product.
"""

import csv
import io
import os
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone

import requests

from .config import CACHE
from .config import FIRMS_BBOX

API = "https://firms.modaps.eosdis.nasa.gov/api"
SENSORS = ["VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21", "MODIS"]
EAT = timezone(timedelta(hours=3))


def key():
    k = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not k:
        raise SystemExit("FIRMS_MAP_KEY is missing: add it to mtkenya-fire/.env")
    return k


def availability():
    text = requests.get(f"{API}/data_availability/csv/{key()}/ALL", timeout=60).text
    return {row["data_id"]: (row["min_date"], row["max_date"])
            for row in csv.DictReader(io.StringIO(text))}


def pick_source(sensor, start, end, avail):
    for suffix in ("SP", "NRT"):
        rng = avail.get(f"{sensor}_{suffix}")
        if rng and rng[0] <= start.isoformat() and end.isoformat() <= rng[1]:
            return f"{sensor}_{suffix}"
    return None


def fetch(source, start, end):
    """All detections for source in [start, end], in 5-day API chunks (cached)."""
    rows, day = [], start
    bbox = ",".join(str(v) for v in FIRMS_BBOX)
    while day <= end:
        span = min(5, (end - day).days + 1)
        path = CACHE / "firms" / f"{source}_{day}_{span}.csv"
        if not path.exists():
            r = requests.get(f"{API}/area/csv/{key()}/{source}/{bbox}/{span}/{day}", timeout=120)
            r.raise_for_status()
            if not r.text.startswith(("latitude", "country_id")):
                raise RuntimeError(f"FIRMS {source} {day}: {r.text[:200]}")
            path.parent.mkdir(exist_ok=True)
            path.write_text(r.text)
        rows += list(csv.DictReader(io.StringIO(path.read_text())))
        day += timedelta(days=span)
    return rows


def to_feature(row, source):
    hhmm = row["acq_time"].zfill(4)
    utc = datetime.strptime(f"{row['acq_date']} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
    viirs = source.startswith("VIIRS")
    conf = row["confidence"]
    if not viirs:  # MODIS confidence is 0-100; bucket it like VIIRS
        conf = "h" if int(conf) >= 80 else "n" if int(conf) >= 30 else "l"
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(row["longitude"]), float(row["latitude"])]},
            "properties": {
                "t": utc.astimezone(EAT).strftime("%Y-%m-%dT%H:%M"),
                "sensor": source.rsplit("_", 1)[0],
                "product": source.rsplit("_", 1)[1],
                "frp": float(row["frp"]),
                "conf": {"l": "low", "n": "nominal", "h": "high"}.get(conf, conf),
                "bt_k": float(row["bright_ti4"] if viirs else row["brightness"]),
                "pixel_m": round(float(row["scan"]) * 1000 if not viirs else float(row["scan"]) * 375),
                "day": row["daynight"] == "D",
            }}


def run(start=date(2026, 8, 28), end=date(2026, 9, 12)):
    avail = availability()
    features, used = [], {}
    for sensor in SENSORS:
        source = pick_source(sensor, start, end, avail)
        if not source:
            print(f"FIRMS: {sensor} has no data for {start}–{end}")
            continue
        rows = fetch(source, start, end)
        # Consecutive API windows overlap by a day; keep each detection once
        unique = {(r["latitude"], r["longitude"], r["acq_date"], r["acq_time"]): r for r in rows}
        used[sensor] = (source, len(unique))
        features += [to_feature(r, source) for r in unique.values()]
    features.sort(key=lambda f: f["properties"]["t"])
    print(f"FIRMS: {len(features)} detections {used}")
    return {"type": "FeatureCollection", "features": features}
