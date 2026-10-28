"""
Hourly weather at the fire: ERA5 reanalysis via the Open-Meteo archive API
(no key), downscaled to the moorland's elevation.

ERA5 cells are ~25 km, so local mountain winds and the convective storm that
helped put the fire out on 6 Sep are smoothed away; the spread model takes
those from the reports instead.
"""

import json

import requests

from .config import CACHE
from .config import TZ

POINT = (-0.06, 37.45, 3300)  # lat, lon, elevation (m) at the centre of the scar
VARS = ["temperature_2m", "relative_humidity_2m", "wind_speed_10m",
        "wind_direction_10m", "wind_gusts_10m", "precipitation", "cloud_cover"]


def run(start="2026-08-30", end="2026-09-12"):
    path = CACHE / f"weather_{start}_{end}.json"
    if not path.exists():
        r = requests.get("https://archive-api.open-meteo.com/v1/archive", params={
            "latitude": POINT[0], "longitude": POINT[1], "elevation": POINT[2],
            "start_date": start, "end_date": end, "hourly": ",".join(VARS),
            "timezone": TZ, "wind_speed_unit": "kmh",
        }, timeout=120)
        r.raise_for_status()
        path.write_text(r.text)
    h = json.loads(path.read_text())["hourly"]
    hours = [{
        "time": t,
        "temp_c": h["temperature_2m"][i],
        "rh": h["relative_humidity_2m"][i],
        "wind_kmh": h["wind_speed_10m"][i],
        "wind_from": h["wind_direction_10m"][i],
        "gust_kmh": h["wind_gusts_10m"][i],
        "rain_mm": h["precipitation"][i],
        "cloud": h["cloud_cover"][i],
    } for i, t in enumerate(h["time"])]
    print(f"Weather: {len(hours)} hourly records {hours[0]['time']} – {hours[-1]['time']}")
    return hours
