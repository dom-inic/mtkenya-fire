"""
Burn scar, severity and dated progression from Sentinel-2 L2A (dNBR).

dNBR = NBR(before) - NBR(after), NBR = (NIR - SWIR2) / (NIR + SWIR2).
Every post-fire scene is compared with the clear 25 Aug scene; a pixel is
"seen burned" on the first date its dNBR passes 0.10 (cloud-free in both).
"""

from concurrent.futures import ThreadPoolExecutor

import numpy as np
from rasterio.enums import Resampling
from rasterio.transform import Affine
from scipy import ndimage as ndi

from .common import Grid
from .common import mask_to_geometry
from .common import read_asset
from .common import stac_search
from .common import write_json
from .common import write_overlay
from .config import CACHE
from .config import PLACES
from .config import S2_BBOX
from .config import S2_POSTS
from .config import S2_PRE
from .config import S2_RES
from .config import SIM_BBOX

GRID = Grid.from_bbox(S2_BBOX, S2_RES)
SCENES = CACHE / "s2"
CLEAR_SCL = [4, 5, 7]  # vegetation, bare soil, unclassified (not cloud, shadow, water)

SEVERITY = [  # USGS dNBR classes
    ("low", 0.10, 0.27, (255, 241, 118)),
    ("moderate-low", 0.27, 0.44, (255, 167, 38)),
    ("moderate-high", 0.44, 0.66, (229, 57, 53)),
    ("high", 0.66, 9.0, (106, 27, 154)),
]


def scene(date, items):
    """Both tiles for one date mosaicked on GRID; cached as .npz."""
    path = SCENES / f"scene_{date}.npz"
    if path.exists():
        z = np.load(path)
        return z["nbr"], z["ok"], z["fc"].astype(np.float32)

    tiles = {}
    for f in items:
        if f["properties"]["datetime"].startswith(date):
            tiles.setdefault(f["id"].split("_")[4], f)  # T37NCA / T37MCV
    bands = ("SCL", "B08", "B12", "B04")
    with ThreadPoolExecutor(8) as pool:
        jobs = {(t, b): pool.submit(
            read_asset, it, b, GRID,
            Resampling.nearest if b == "SCL" else Resampling.bilinear)
            for t, it in tiles.items() for b in bands}
        scl = np.zeros(GRID.shape, np.uint8)
        nir, swir, red = (np.zeros(GRID.shape, np.float32) for _ in range(3))
        for t in tiles:
            s = jobs[(t, "SCL")].result()
            fill = (scl == 0) & (s > 0)
            scl[fill] = s[fill]
            for arr, b in ((nir, "B08"), (swir, "B12"), (red, "B04")):
                arr[fill] = jobs[(t, b)].result()[fill]

    # Processing baseline >= 04.00 stores reflectance with a +1000 offset
    nir, swir, red = (np.clip(a - 1000, 0, None) / 10000 for a in (nir, swir, red))
    ok = np.isin(scl, CLEAR_SCL)
    nbr = (nir - swir) / np.maximum(nir + swir, 1e-6)
    fc = np.dstack([swir, nir, red])
    SCENES.mkdir(exist_ok=True)
    np.savez_compressed(path, nbr=nbr, ok=ok, scl=scl, fc=fc.astype(np.float16))
    return nbr, ok, fc


def fire_mask(final):
    """
    The fire: moderate+ patches connected to the moorland scar around Lake
    Rutundu, grown into adjoining low-severity pixels. Harvested fields and
    cloud-edge artefacts further away drop out.
    """
    core = ndi.binary_closing(np.nan_to_num(final) > 0.27, iterations=2)
    lab, n = ndi.label(core)
    r0, c0 = GRID.rowcol(*PLACES["Lake Rutundu"])
    yy, xx = np.ogrid[:GRID.height, :GRID.width]
    near = (yy - r0) ** 2 + (xx - c0) ** 2 < (20_000 / GRID.res) ** 2
    sizes = ndi.sum(core, lab, range(1, n + 1))
    keep = [i + 1 for i in range(n)
            if sizes[i] * GRID.cell_ha >= 25 and near[lab == i + 1].any()]
    fire = np.isin(lab, keep)
    fire |= ndi.binary_dilation(fire, iterations=5) & (np.nan_to_num(final) > 0.10)
    fire = ndi.binary_fill_holes(ndi.binary_closing(fire, iterations=2))

    # Keep the main scar and lobes within 1.5 km of it
    lab, n = ndi.label(fire)
    main = lab == np.argmax(ndi.sum(fire, lab, range(1, n + 1))) + 1
    touching = np.unique(lab[ndi.binary_dilation(main, iterations=1500 // GRID.res) & fire])
    return np.isin(lab, touching)


def display_mask(mask, min_ha=5):
    """Outline-friendly version of a burn mask: holes filled, specks dropped."""
    m = ndi.binary_fill_holes(ndi.binary_closing(mask, iterations=2))
    lab, n = ndi.label(m)
    sizes = ndi.sum(m, lab, range(1, n + 1))
    return np.isin(lab, [i + 1 for i in range(n) if sizes[i] * GRID.cell_ha >= min_ha])


def crop_grid(bbox):
    """Window of GRID covering bbox, as (row slice, col slice, Grid)."""
    r0, c0 = GRID.rowcol(bbox[3], bbox[0])
    r1, c1 = GRID.rowcol(bbox[1], bbox[2])
    r0, c0 = max(r0, 0), max(c0, 0)
    r1, c1 = min(r1, GRID.height), min(c1, GRID.width)
    t = GRID.transform * Affine.translation(c0, r0)
    return slice(r0, r1), slice(c0, c1), Grid(t, c1 - c0, r1 - r0, GRID.res)


def run():
    items = stac_search("sentinel-2-l2a", S2_BBOX, f"{S2_PRE}/{S2_POSTS[-1]}T23:59:59Z")
    pre_nbr, pre_ok, _ = scene(S2_PRE, items)

    dnbr, clear = {}, {}
    for d in S2_POSTS:
        nbr, ok, fc = scene(d, items)
        clear[d] = pre_ok & ok
        dnbr[d] = np.where(clear[d], pre_nbr - nbr, np.nan)
        if d == "2026-09-19":
            post_fc = fc

    # Final severity: latest clear observation from 9 Sep on (scar fully formed)
    final = np.full(GRID.shape, np.nan, np.float32)
    for d in S2_POSTS[2:]:
        final = np.where(np.isfinite(dnbr[d]), dnbr[d], final)
    fire = fire_mask(final)

    first = np.zeros(GRID.shape, np.uint8)
    for i, d in enumerate(S2_POSTS):
        seen = fire & (first == 0) & (np.nan_to_num(dnbr[d]) > 0.10)
        first[seen] = i + 1

    features, progression = [], []
    for i, d in enumerate(S2_POSTS):
        cum = fire & (first >= 1) & (first <= i + 1)
        ha = round(float(cum.sum() * GRID.cell_ha))
        clear_pct = round(100 * float(clear[d][fire].mean()), 1)
        progression.append({"date": d, "seen_burned_ha": ha, "clear_pct": clear_pct})
        geom = mask_to_geometry(display_mask(cum), GRID, simplify=30)
        if geom:
            features.append({"type": "Feature", "geometry": geom, "properties": {
                "kind": "seen_burned_by", "date": d, "area_ha": ha, "clear_pct": clear_pct}})
    total = round(float(fire.sum() * GRID.cell_ha))
    features.append({"type": "Feature", "geometry": mask_to_geometry(fire, GRID, simplify=30),
                     "properties": {"kind": "final_perimeter", "area_ha": total}})
    write_json("observed_perimeters.geojson", {"type": "FeatureCollection", "features": features})

    severity_ha = {}
    rows, cols, crop = crop_grid(SIM_BBOX)
    sev_rgba = np.zeros(crop.shape + (4,), np.uint8)
    f, fl = fire[rows, cols], final[rows, cols]
    for name, lo, hi, colour in SEVERITY:
        m = fire & (final >= lo) & (final < hi)
        severity_ha[name] = round(float(m.sum() * GRID.cell_ha))
        mc = f & (fl >= lo) & (fl < hi)
        sev_rgba[mc] = (*colour, 255)
    severity_ha["unburned islands"] = round(float((fire & ~(final >= 0.10)).sum() * GRID.cell_ha))
    sev_corners = write_overlay("burn_severity.png", sev_rgba, crop)

    # Post-fire false colour (SWIR2 / NIR / red): burn scar shows dark red-brown
    fc = post_fc[rows, cols]
    img = np.zeros(fc.shape[:2] + (4,), np.uint8)
    for b in range(3):
        v = fc[..., b]
        lo, hi = np.nanpercentile(v[v > 0], (2, 98))
        img[..., b] = (np.clip((v - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
    img[..., 3] = np.where(fc[..., 1] > 0, 255, 0)
    fc_corners = write_overlay("s2_falsecolour_20260919.webp", img, crop)

    np.savez_compressed(CACHE / "observed.npz", fire=fire, first=first, final=final,
                        transform=np.array(GRID.transform)[:6])
    summary = {"final_area_ha": total, "severity_ha": severity_ha,
               "progression": progression, "pre_date": S2_PRE,
               "overlays": {"burn_severity": sev_corners, "s2_falsecolour": fc_corners}}
    print(f"Sentinel-2: {total:,} ha perimeter; {progression}")
    return summary
