"""
Data for the 3D world: the whole Mount Kenya forest ring, with a sharper
inner zone around the north-east moorlands where the September fire burned.

Everything is on lon/lat-aligned grids so the web app can map any layer onto
the terrain with plain UV maths (near the equator a degree of longitude and
latitude are both ~111 km). Binary grids are written as raw little-endian
arrays the browser reads with fetch(), no image decoding needed.
"""

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image
from rasterio.enums import Resampling
from rasterio.warp import reproject
from shapely.geometry import LineString
from shapely.geometry import Polygon

from .common import Grid
from .common import read_asset
from .common import stac_search
from .config import CACHE
from .config import OUT
from .terrain import fuel_types

WORLD_BBOX = (36.95, -0.50, 37.80, 0.30)   # forest ring, Nanyuki to Meru to Embu
INNER_BBOX = (37.30, -0.20, 37.58, 0.06)   # NE moorlands and the 2026 fire

# Grid sizes: outer ~92 m heights / ~40 m imagery; inner 30 m heights / ~12 m imagery
OUTER_HEIGHTS = Grid.lonlat(WORLD_BBOX, 1024, 964)
INNER_HEIGHTS = Grid.lonlat(INNER_BBOX, 1040, 966)
OUTER_IMAGE = Grid.lonlat(WORLD_BBOX, 2400, 2259)
INNER_IMAGE = Grid.lonlat(INNER_BBOX, 2600, 2414)
OUTER_FUEL = Grid.lonlat(WORLD_BBOX, 1024, 964)
INNER_FUEL = Grid.lonlat(INNER_BBOX, 1040, 966)

IMAGERY_WINDOW = "2026-07-01/2026-08-31T23:59:59Z"  # dry season, before the fire
CLEAR = [2, 4, 5, 6, 7, 11]  # dark, vegetation, soil, water, unclassified, snow
WORLD = OUT / "world"


def write_bin(name, arr):
    WORLD.mkdir(parents=True, exist_ok=True)
    np.ascontiguousarray(arr).astype(arr.dtype.newbyteorder("<")).tofile(WORLD / name)


def mosaic_single(collection, asset, grid, resampling, keep=lambda f: True):
    out = np.zeros(grid.shape, np.float32)
    for item in stac_search(collection, WORLD_BBOX):
        if keep(item):
            a = read_asset(item, asset, grid, resampling, dtype="float32")
            out = np.where(out == 0, a, out)
    return out


def heights():
    dem_outer = mosaic_single("cop-dem-glo-30", "data", OUTER_HEIGHTS, Resampling.average)
    dem_inner = mosaic_single("cop-dem-glo-30", "data", INNER_HEIGHTS, Resampling.bilinear)
    # Decimetres in uint16: 0.1 m steps up to 6,553 m
    write_bin("heights_outer.u16", np.round(dem_outer * 10).astype(np.uint16))
    write_bin("heights_inner.u16", np.round(dem_inner * 10).astype(np.uint16))
    return dem_outer, dem_inner


def fuels(dem_outer, dem_inner):
    keep = lambda f: "2021" in f["id"]  # noqa: E731
    for grid, dem, name in ((OUTER_FUEL, dem_outer, "fuel_outer.u8"), (INNER_FUEL, dem_inner, "fuel_inner.u8")):
        cover = mosaic_single("esa-worldcover", "map", grid, Resampling.mode, keep)
        write_bin(name, fuel_types(dem, cover).astype(np.uint8))


def imagery(grid, overview, name):
    """
    Cloud-masked true-colour mosaic: for each pixel, the clearest dry-season
    pass, preferring dates closest to 25 Aug (just before the fire).
    """
    path = CACHE / f"world_{name}.npz"
    if path.exists():
        return np.load(path)["rgb"]
    items = stac_search("sentinel-2-l2a", WORLD_BBOX if grid is OUTER_IMAGE else INNER_BBOX,
                        IMAGERY_WINDOW, limit=300)
    items = [f for f in items if f["properties"]["eo:cloud_cover"] < 25]
    items.sort(key=lambda f: (f["properties"]["eo:cloud_cover"] > 8,
                              abs(int(f["properties"]["datetime"][5:10].replace("-", "")) - 825)))
    rgb = np.zeros((3,) + grid.shape, np.uint8)
    fallback = np.zeros_like(rgb)
    done = np.zeros(grid.shape, bool)
    scl_overview = None if overview is None else max(overview - 1, 0)

    def load(item):
        tci = read_asset(item, "visual", grid, Resampling.bilinear, bands=[1, 2, 3], overview=overview)
        scl = read_asset(item, "SCL", grid, Resampling.nearest, overview=scl_overview)
        return tci, scl

    with ThreadPoolExecutor(4) as pool:
        for item, (tci, scl) in zip(items[:16], pool.map(load, items[:16])):
            has = tci.any(axis=0)
            ok = has & np.isin(scl, CLEAR) & ~done
            rgb[:, ok] = tci[:, ok]
            done |= ok
            fill = has & ~fallback.any(axis=0)
            fallback[:, fill] = tci[:, fill]
            print(f"  {name}: {item['id'][:44]} → {100 * done.mean():.1f}% clear")
            if done.mean() > 0.995:
                break
    rgb[:, ~done] = fallback[:, ~done]
    np.savez_compressed(path, rgb=rgb)
    return rgb


def save_image(rgb, name):
    WORLD.mkdir(parents=True, exist_ok=True)
    # Lift the shadows a little: TCI is stretched for print, dark in 3D lighting
    img = np.moveaxis(rgb, 0, -1).astype(np.float32) / 255
    img = np.clip(img ** 0.85 * 1.05, 0, 1)
    Image.fromarray((img * 255).astype(np.uint8)).save(WORLD / name, quality=82, method=6)


OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]


HEADERS = {"User-Agent": "mtkenya-fire/0.1 (Mount Kenya wildfire analysis prototype)", "Accept": "application/json"}


def overpass(query):
    for attempt in range(6):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=240)
            if r.ok and r.text.startswith("{"):
                return r.json()["elements"]
        except requests.RequestException:
            pass
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass failed: {query[:80]}")


def osm():
    """Roads, tracks, lakes, airstrips and named places from OpenStreetMap."""
    path = CACHE / "world_osm.json"
    if not path.exists():
        s, w, n, e = WORLD_BBOX[1], WORLD_BBOX[0], WORLD_BBOX[3], WORLD_BBOX[2]
        b = f"({s},{w},{n},{e})"
        parts = [
            f'way["highway"~"^(trunk|primary|secondary|tertiary)$"]{b};',
            f'way["highway"="unclassified"]{b};',
            f'way["highway"="track"]{b};',
            f'way["highway"="path"]{b};',
            f'way["natural"="water"]{b}; relation["natural"="water"]{b};',
            f'way["aeroway"~"^(runway|aerodrome)$"]{b}; node["aeroway"="aerodrome"]{b};',
            f'nwr["place"~"^(town|village)$"]{b}; nwr["tourism"~"^(alpine_hut|camp_site|wilderness_hut)$"]{b};'
            f' nwr["name"~"Gate|Forest Station|Ranger|Air Base",i]{b};',
        ]
        elements = []
        for part in parts:
            elements += overpass(f"[out:json][timeout:180];({part});out geom tags;")
        path.write_text(json.dumps({"elements": elements}))
    els = json.loads(path.read_text())["elements"]

    def line(e):
        return [[round(p["lon"], 5), round(p["lat"], 5)] for p in e.get("geometry", [])]

    def centre(e):
        if "lat" in e:
            return [round(e["lon"], 5), round(e["lat"], 5)]
        if "center" in e:
            return [round(e["center"]["lon"], 5), round(e["center"]["lat"], 5)]
        g = line(e) or [m for mem in e.get("members", []) for m in line(mem)]
        return [round(float(np.mean([p[0] for p in g])), 5), round(float(np.mean([p[1] for p in g])), 5)] if g else None

    roads, lakes, runways, pois = [], [], [], []
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "way" and "highway" in t:
            roads.append({"kind": t["highway"], "name": t.get("name"), "line": line(e)})
        elif t.get("natural") == "water":
            ring = line(e) if e["type"] == "way" else max(
                ([line(m) for m in e.get("members", []) if m.get("role") == "outer"] or [[]]), key=len)
            if len(ring) > 3:
                lakes.append({"name": t.get("name"), "ring": ring})
        elif t.get("aeroway") == "runway" and e["type"] == "way":
            runways.append({"name": t.get("ref"), "line": line(e)})
        else:
            c = centre(e)
            if not c or not t.get("name"):
                continue
            kind = ("airstrip" if t.get("aeroway") == "aerodrome" else
                    t.get("place") or t.get("tourism") or
                    ("gate" if "gate" in t["name"].lower() else
                     "airbase" if "air base" in t["name"].lower() else "station"))
            pois.append({"name": t["name"], "kind": kind, "lon": c[0], "lat": c[1]})

    # Keep the file small: simplify to ~15 m, drop short farm lanes, tiny ponds
    # and places that only matched "gate" by accident (shops, schools, ...)
    def simplify(coords, tol=0.00014):
        g = LineString(coords).simplify(tol)
        return [[round(x, 5), round(y, 5)] for x, y in g.coords]

    def length_m(coords):
        return LineString(coords).length * 111_320

    roads = [{**r, "line": simplify(r["line"])} for r in roads
             if len(r["line"]) > 1 and not (r["kind"] == "unclassified" and length_m(r["line"]) < 1500)]
    lakes = [{**lk, "ring": simplify(lk["ring"], 0.00008)} for lk in lakes
             if Polygon(lk["ring"]).area * 111_320 ** 2 > 20_000 or lk.get("name")]
    junk = re.compile(r"pizza|weld|door|club|hotel|school|health|shop|church|primary|secondary", re.I)
    pois = [p for p in pois if not junk.search(p["name"])
            and (p["kind"] != "gate" or re.search(r"\bgate\b", p["name"], re.I))]
    print(f"OSM: {len(roads)} roads/tracks, {len(lakes)} lakes, {len(runways)} runways, {len(pois)} places")
    return {"roads": roads, "lakes": lakes, "runways": runways, "pois": pois}


def fire_arrival():
    """The September model run (arrival minutes) resampled onto the inner fuel grid."""
    from .terrain import GRID as SIM

    arr = np.load(CACHE / "arrival.npy")
    out = np.full(INNER_FUEL.shape, np.nan, np.float32)
    reproject(arr, out, src_transform=SIM.transform, src_crs=SIM.crs, src_nodata=np.inf,
              dst_transform=INNER_FUEL.transform, dst_crs="EPSG:4326", dst_nodata=np.nan,
              resampling=Resampling.nearest)
    minutes = np.where(np.isfinite(out), np.clip(out, 0, 65534), 65535).astype(np.uint16)
    write_bin("fire_arrival_inner.u16", minutes)


def bbox_json(b):
    return {"west": b[0], "south": b[1], "east": b[2], "north": b[3]}


def run():
    dem_outer, dem_inner = heights()
    fuels(dem_outer, dem_inner)
    save_image(imagery(OUTER_IMAGE, 1, "outer"), "imagery_outer.webp")
    save_image(imagery(INNER_IMAGE, None, "inner"), "imagery_inner.webp")
    if (CACHE / "arrival.npy").exists():
        fire_arrival()
    features = osm()
    (WORLD / "features.json").write_text(json.dumps(features, separators=(",", ":")))
    meta = {
        "world": bbox_json(WORLD_BBOX), "inner": bbox_json(INNER_BBOX),
        "heights": {"outer": [OUTER_HEIGHTS.width, OUTER_HEIGHTS.height],
                    "inner": [INNER_HEIGHTS.width, INNER_HEIGHTS.height], "scale": 0.1},
        "fuel": {"outer": [OUTER_FUEL.width, OUTER_FUEL.height], "inner": [INNER_FUEL.width, INNER_FUEL.height]},
        "fire": {"grid": [INNER_FUEL.width, INNER_FUEL.height], "units": "minutes after incident start; 65535 = unburned"},
        "imagery": {"outer": "imagery_outer.webp", "inner": "imagery_inner.webp",
                    "source": "Copernicus Sentinel-2 L2A, Jul–Aug 2026, cloud-masked mosaic"},
        "elevation": {"min": float(dem_outer[dem_outer > 0].min()), "max": float(dem_outer.max())},
    }
    (WORLD / "world.json").write_text(json.dumps(meta, indent=1))
    print(f"World: elevation {meta['elevation']['min']:.0f}–{meta['elevation']['max']:.0f} m")
    return meta

