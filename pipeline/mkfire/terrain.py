"""
Elevation, slope, aspect and fuels on the spread-model grid.

Elevation: Copernicus GLO-30 DEM. Land cover: ESA WorldCover 2021 (10 m),
turned into a handful of fuel types using elevation to tell the moorland
belts apart from the montane forest below them.
"""

import numpy as np
from rasterio.enums import Resampling
from scipy import ndimage as ndi

from .common import Grid
from .common import read_asset
from .common import stac_search
from .common import write_overlay
from .config import CACHE
from .config import SIM_BBOX
from .config import SIM_RES

GRID = Grid.from_bbox(SIM_BBOX, SIM_RES)

# code: (name, base rate of spread m/min at reference conditions, colour)
# Reference: dry-season afternoon, no wind, flat ground. Relative rates follow
# Scott & Burgan fuel models (GR/SH/TL groups); the spread model calibrates one
# overall multiplier against what Sentinel-2 saw burn.
FUELS = {
    0: ("Non-burnable (rock, water, ice)", 0.0, (120, 120, 120)),
    1: ("Afro-alpine tussock grass & groundsel (>3,600 m)", 0.9, (232, 197, 71)),
    2: ("Ericaceous heath / moorland shrub (3,000–3,600 m)", 2.2, (214, 131, 46)),
    3: ("Heath forest (Erica trees, >3,000 m)", 1.0, (150, 96, 45)),
    4: ("Montane & bamboo forest (<3,000 m)", 0.12, (46, 110, 64)),
    5: ("Farmland & settlements", 0.0, (190, 160, 200)),
    6: ("Lower-elevation grass & shrub", 0.8, (180, 200, 90)),
}


def mosaic(collection, asset, resampling, item_filter=lambda f: True):
    out = np.zeros(GRID.shape, np.float32)
    for item in stac_search(collection, SIM_BBOX):
        if item_filter(item):
            a = read_asset(item, asset, GRID, resampling, dtype="float32")
            out = np.where(out == 0, a, out)
    return out


def fuel_types(dem, cover):
    fuel = np.full(dem.shape, 6, np.uint8)
    high, upper = dem >= 3600, dem >= 3000
    grassy = np.isin(cover, [20, 30, 90, 100])  # shrub, grass, wetland, moss
    fuel[grassy & high] = 1
    fuel[grassy & upper & ~high] = 2
    fuel[(cover == 10) & upper] = 3
    fuel[(cover == 10) & ~upper] = 4
    fuel[np.isin(cover, [40, 50])] = 5
    fuel[np.isin(cover, [60, 70, 80]) | (dem >= 4600)] = 0
    return fuel


def run():
    path = CACHE / "terrain.npz"
    if path.exists():
        return dict(np.load(path))

    dem = mosaic("cop-dem-glo-30", "data", Resampling.bilinear)
    # WorldCover: majority of 10 m pixels per 60 m cell (mode resampling)
    cover = mosaic("esa-worldcover", "map", Resampling.mode,
                   lambda f: "2021" in f["id"])

    # Slope and the azimuth of the steepest *uphill* direction (0 = north, clockwise)
    smooth = ndi.gaussian_filter(dem, 1)
    dzdy, dzdx = np.gradient(smooth, GRID.res)  # rows run southward
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    upslope = (np.degrees(np.arctan2(dzdx, -dzdy)) + 360) % 360

    fuel = fuel_types(dem, cover)
    rgba = np.zeros(GRID.shape + (4,), np.uint8)
    for code, (_, _, colour) in FUELS.items():
        rgba[fuel == code] = (*colour, 255)
    corners = write_overlay("fuels.png", rgba, GRID)

    data = {"dem": dem, "slope": slope, "upslope": upslope, "cover": cover,
            "fuel": fuel, "corners": np.array(corners)}
    np.savez_compressed(path, **data)
    counts = {FUELS[c][0]: round(float((fuel == c).sum() * GRID.cell_ha)) for c in FUELS}
    print(f"Terrain: elevation {dem.min():.0f}–{dem.max():.0f} m; fuels (ha) {counts}")
    return data
