"""
Grids, Planetary Computer access and output helpers shared by the steps.
"""

import json
import math
import time
from dataclasses import dataclass
from functools import cache

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import shapes
from rasterio.transform import Affine
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import reproject
from rasterio.warp import transform
from rasterio.warp import transform_bounds
from rasterio.warp import transform_geom
from shapely.geometry import mapping
from shapely.geometry import shape
from shapely.ops import unary_union

from .config import CRS
from .config import OUT

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"


@dataclass(frozen=True)
class Grid:
    transform: Affine
    width: int
    height: int
    res: float
    crs: str = CRS

    @classmethod
    def from_bbox(cls, bbox, res):
        left, bottom, right, top = transform_bounds("EPSG:4326", CRS, *bbox)
        return cls(from_origin(left, top, res, res),
                   int((right - left) / res), int((top - bottom) / res), res)

    @classmethod
    def lonlat(cls, bbox, width, height):
        """A lon/lat-aligned grid (EPSG:4326) of width x height over bbox."""
        dx = (bbox[2] - bbox[0]) / width
        dy = (bbox[3] - bbox[1]) / height
        return cls(Affine(dx, 0, bbox[0], 0, -dy, bbox[3]), width, height, dx, "EPSG:4326")

    @property
    def shape(self):
        return (self.height, self.width)

    @property
    def cell_ha(self):
        return self.res * self.res / 1e4

    def rowcol(self, lat, lon):
        xs, ys = transform("EPSG:4326", self.crs, [lon], [lat])
        col, row = ~self.transform * (xs[0], ys[0])
        return int(row), int(col)

    def latlon(self, row, col):
        x, y = self.transform * (col + 0.5, row + 0.5)
        lon, lat = transform(self.crs, "EPSG:4326", [x], [y])
        return lat[0], lon[0]


# --- Planetary Computer ------------------------------------------------------

@cache
def pc_token(account, container):
    """SAS token for one Planetary Computer storage container (reused for all its files)."""
    url = f"https://planetarycomputer.microsoft.com/api/sas/v1/token/{account}/{container}"
    for attempt in range(6):
        r = requests.get(url, timeout=60)
        if r.ok:
            return r.json()["token"]
        time.sleep(2 ** attempt)
    r.raise_for_status()


def pc_sign(href):
    """Signed URL for a Planetary Computer blob."""
    host, path = href.split("://", 1)[1].split("/", 1)
    return f"{href}?{pc_token(host.split('.')[0], path.split('/')[0])}"


def stac_search(collection, bbox, datetime=None, limit=200):
    body = {"collections": [collection], "bbox": list(bbox), "limit": limit}
    if datetime:
        body["datetime"] = datetime
    r = requests.post(f"{STAC}/search", json=body, timeout=120)
    r.raise_for_status()
    return r.json()["features"]


def read_asset(item, asset, grid, resampling=Resampling.bilinear, dtype=None,
               bands=1, overview=None):
    """
    Read one STAC asset warped onto `grid` (0 where the asset has no data).
    bands: a band index, or a list for a (bands, h, w) array. overview: read a
    reduced-resolution level of a COG instead of full resolution.
    """
    opts = {} if overview is None else {"overview_level": overview}
    with rasterio.open(pc_sign(item["assets"][asset]["href"]), **opts) as src, WarpedVRT(
        src, crs=grid.crs, transform=grid.transform, width=grid.width,
        height=grid.height, resampling=resampling, nodata=0,
    ) as vrt:
        return vrt.read(bands, out_dtype=dtype)


# --- Outputs for the web app ------------------------------------------------

def write_json(name, data):
    path = OUT / name
    path.write_text(json.dumps(data, separators=(",", ":")))
    return path


def mask_to_geometry(mask, grid, simplify=None):
    """Polygonise a boolean mask into a lon/lat GeoJSON geometry (or None)."""
    polys = [shape(g) for g, v in shapes(mask.astype(np.uint8), mask=mask,
                                         transform=grid.transform) if v == 1]
    if not polys:
        return None
    geom = unary_union(polys)
    geom = geom.simplify(simplify if simplify is not None else grid.res / 2)
    return transform_geom(grid.crs, "EPSG:4326", mapping(geom), precision=5)


def write_overlay(name, rgba, grid, res_deg=None):
    """
    Save an RGBA array as a PNG on a lon/lat grid and return its corners for a
    Mapbox image source. Near the equator lon/lat is close enough to linear in
    Web Mercator for the overlay to line up.
    """
    left, bottom, right, top = transform_bounds(
        grid.crs, "EPSG:4326",
        *rasterio.transform.array_bounds(grid.height, grid.width, grid.transform))
    res_deg = res_deg or grid.res / 111_320
    width = math.ceil((right - left) / res_deg)
    height = math.ceil((top - bottom) / res_deg)
    dst_transform = from_origin(left, top, res_deg, res_deg)
    out = np.zeros((4, height, width), np.uint8)
    for band in range(4):
        reproject(rgba[..., band], out[band], src_transform=grid.transform,
                  src_crs=grid.crs, dst_transform=dst_transform,
                  dst_crs="EPSG:4326", resampling=Resampling.nearest)
    Image.fromarray(np.moveaxis(out, 0, -1), "RGBA").save(OUT / name, optimize=True)
    return [[left, top], [right, top], [right, bottom], [left, bottom]]
