"""Sentinel-2 observations resampled onto the spread-model grid for calibration."""

import numpy as np
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import reproject

from .config import CACHE
from .config import S2_POSTS
from .terrain import GRID

S2_TIME = "10:40"  # local overpass time of both tiles


def on_sim_grid():
    """[(ISO time, burned-by-then mask)] for 4 Sep, 9 Sep, and the final scar."""
    o = np.load(CACHE / "observed.npz")
    src_t = Affine(*o["transform"])

    def resample(a):
        out = np.zeros(GRID.shape, np.uint8)
        reproject(a.astype(np.uint8), out, src_transform=src_t, src_crs=GRID.crs,
                  dst_transform=GRID.transform, dst_crs=GRID.crs, resampling=Resampling.mode)
        return out

    first, fire = resample(o["first"]), resample(o["fire"]).astype(bool)
    checks = []
    for i, d in enumerate(S2_POSTS[:3]):
        if i == 0:
            continue  # 1 Sep: fire only hours old
        checks.append((f"{d}T{S2_TIME}", (first >= 1) & (first <= i + 1)))
    checks.append((f"{S2_POSTS[-1]}T{S2_TIME}", fire))
    return checks
