"""
Fire spread model: earliest arrival time of the fire at every 60 m cell.

Fire travels from cell to cell (16 directions) at a rate of spread

    R = base(fuel) * k * wind(θ, hour) * moisture(hour) * slope(θ, cell) * constraint(hour)

  base       per-fuel rate at reference conditions (terrain.FUELS)
  wind       elliptical fire shape: fastest downwind, slowest upwind. Head
             speed-up 1 + a·U^1.4; length-to-breadth from Alexander (1985)
  moisture   humid nights slow the fire: exp(-(RH - 40) / 25), 0 in rain
  elevation  colder, wetter ground higher up: exp(-(z - 3,200 m) / scale) above 3,200 m
  slope      doubles per 10° uphill, halves per 10° downhill (McArthur)
  constraint reported events the weather data misses (rain, containment)

Rates change every hour, so arrival times come from a time-dependent
Dijkstra search: for each direction we keep the cumulative "spread
potential" over time and invert it to get exact travel times through
hour boundaries. Spotting (embers jumping ahead) is not modelled.
"""

import bisect
import heapq
import math
from dataclasses import dataclass
from dataclasses import replace
from datetime import datetime
from datetime import timedelta

import numpy as np

from .terrain import FUELS
from .terrain import GRID

# 16 directions: 8 neighbours plus knight moves for smoother fire shapes
OFFSETS = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1),
           (-2, 1), (-1, 2), (1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1)]
# Azimuth of travel (0 = north, clockwise); rows run south
AZIMUTH = [math.degrees(math.atan2(dc, -dr)) % 360 for dr, dc in OFFSETS]
DIST = [math.hypot(dr, dc) * GRID.res for dr, dc in OFFSETS]


@dataclass(frozen=True)
class Params:
    k: float = 1.0           # overall rate multiplier (calibrated)
    wind_a: float = 0.06     # head-fire wind speed-up coefficient
    wind_mult: float = 1.3   # ERA5 10 m wind -> wind at the moorland surface
    rh_ref: float = 40.0
    rh_scale: float = 25.0
    rain_mm: float = 0.5     # hourly rain that stops spread
    elev_scale: float = 0.0  # metres for e-fold slow-down above 3,200 m (0 = off)


def parse(t):
    return datetime.fromisoformat(t)


def hourly_factors(weather, start, hours, p, constraints):
    """factor[h][dir]: everything in R except fuel and slope, for each hour."""
    by_time = {w["time"]: w for w in weather}
    out = []
    for h in range(hours):
        t = start + timedelta(hours=h)
        w = by_time[t.strftime("%Y-%m-%dT%H:%M")]
        u = w["wind_kmh"] * p.wind_mult
        to = (w["wind_from"] + 180) % 360
        head = 1 + p.wind_a * u ** 1.4
        lb = 1 + 8.729 * (1 - math.exp(-0.030 * u)) ** 2.155
        e = math.sqrt(1 - 1 / lb ** 2)
        moist = 0.0 if w["rain_mm"] >= p.rain_mm else min(
            max(math.exp(-(w["rh"] - p.rh_ref) / p.rh_scale), 0.05), 2.5)
        c = 1.0
        for when, mult in constraints:
            if t >= parse(when):
                c = mult
        out.append([p.k * head * (1 - e) / (1 - e * math.cos(math.radians(az - to))) * moist * c
                    for az in AZIMUTH])
    return out


def spread(terrain, weather, ignitions, start, hours, p=Params(), constraints=()):
    """
    Arrival time (minutes after `start`) per cell; inf where the fire doesn't
    reach within `hours`. ignitions: [(lat, lon, datetime)].
    """
    H, W = GRID.shape
    base = np.array([FUELS[c][1] for c in range(len(FUELS))])[terrain["fuel"]]
    if p.elev_scale:
        base = base * np.exp(-np.clip(terrain["dem"] - 3200, 0, None) / p.elev_scale)
    base = base.ravel().tolist()
    slope = terrain["slope"].ravel().tolist()
    upslope = np.radians(terrain["upslope"]).ravel().tolist()
    az = [math.radians(a) for a in AZIMUTH]

    factors = hourly_factors(weather, start, hours, p, constraints)
    # Cumulative spread potential per direction at each hour boundary
    cum = []
    for d in range(len(OFFSETS)):
        acc, row = 0.0, [0.0]
        for h in range(hours):
            acc += factors[h][d] * 60
            row.append(acc)
        cum.append(row)
    t_end = hours * 60.0

    def potential(d, t):
        h = min(int(t // 60), hours - 1)
        return cum[d][h] + factors[h][d] * (t - 60 * h)

    def arrive(d, t0, need):
        """Time at which `need` spread potential has accumulated after t0."""
        target = potential(d, t0) + need
        h = bisect.bisect_left(cum[d], target) - 1
        if h >= hours:
            return math.inf
        h = max(h, 0)
        return 60 * h + (target - cum[d][h]) / factors[h][d]

    arrival = [math.inf] * (H * W)
    heap = []
    for lat, lon, when in ignitions:
        r, c = GRID.rowcol(lat, lon)
        t0 = (when - start).total_seconds() / 60
        i = r * W + c
        if t0 < arrival[i]:
            arrival[i] = t0
            heap.append((t0, i))
    heapq.heapify(heap)

    while heap:
        t, i = heapq.heappop(heap)
        if t > arrival[i] or t > t_end:
            continue
        r, c = divmod(i, W)
        for d, (dr, dc) in enumerate(OFFSETS):
            nr, nc = r + dr, c + dc
            if not (0 <= nr < H and 0 <= nc < W):
                continue
            j = nr * W + nc
            b = base[j]
            if b == 0:
                continue
            s = slope[j] * math.cos(az[d] - upslope[j])
            rate = b * min(max(math.exp(0.0693 * s), 0.25), 8.0)  # m/min per unit factor
            t1 = arrive(d, t, DIST[d] / rate)
            if t1 < arrival[j] and t1 <= t_end:
                arrival[j] = t1
                heapq.heappush(heap, (t1, j))
    return np.array(arrival, np.float32).reshape(H, W)


def f1(sim, obs):
    tp = (sim & obs).sum()
    return 2 * tp / max(sim.sum() + obs.sum(), 1)


def score(arrival, start, observed):
    """Mean Sørensen agreement with Sentinel-2 at each check time (and final)."""
    out = {}
    for when, obs in observed:
        minutes = (parse(when) - start).total_seconds() / 60
        out[when] = round(float(f1(arrival <= minutes, obs)), 3)
    return float(np.mean(list(out.values()))), out


def candidate_ignitions(region, spacing_cells=10):
    """Grid of points (lat, lon) inside a boolean region, `spacing_cells` apart."""
    rows, cols = np.nonzero(region[::spacing_cells, ::spacing_cells])
    return [GRID.latlon(r * spacing_cells, c * spacing_cells) for r, c in zip(rows, cols)]


def locate_ignition(terrain, weather, candidates, times, start, hours, observed, constraints,
                    p=Params(k=1.0, wind_a=0.06, elev_scale=600)):
    """
    Ignition inversion: which start point and time best reproduce what
    Sentinel-2 saw burned by 4 and 9 Sep? Returns (score, [(lat, lon, time)]).
    """
    early = observed[:2]
    best = None
    for when in times:
        for lat, lon in candidates:
            arr = spread(terrain, weather, [(lat, lon, when)], start, hours, p, constraints)
            s, _ = score(arr, start, early)
            if best is None or s > best[0]:
                best = (s, [(round(lat, 5), round(lon, 5), when)])
    print(f"  ignition {best[1]} early-score {best[0]:.3f} ({len(candidates) * len(times)} tried)")
    return best


def assimilate(terrain, weather, seeds, detections, start, hours, p, constraints,
               lead_min=60, gap_m=500, rounds=2):
    """
    Add hotspots the model can't explain as new ignitions: detections where the
    modelled fire arrives over an hour later and that lie more than `gap_m` from
    anything the model had burning then (a jump, e.g. spotting across a gorge).
    detections: [(lat, lon, datetime)]. Returns (arrival, added seeds).
    """
    from scipy import ndimage as ndi

    added = []
    arr = spread(terrain, weather, seeds, start, hours, p, constraints)
    for _ in range(rounds):
        new = []
        for lat, lon, when in detections:
            r, c = GRID.rowcol(lat, lon)
            if not (0 <= r < GRID.height and 0 <= c < GRID.width):
                continue
            t = (when - start).total_seconds() / 60
            if arr[r, c] <= t + lead_min:
                continue
            k = int(gap_m / GRID.res)
            win = arr[max(r - k, 0):r + k + 1, max(c - k, 0):c + k + 1]
            if (win <= t).any():
                continue
            new.append((lat, lon, when))
        if not new:
            break
        added += new
        arr = spread(terrain, weather, seeds + added, start, hours, p, constraints)
    return arr, added


def calibrate(terrain, weather, ignitions, start, hours, observed, constraints, grid=None):
    grid = grid or {"k": [0.5, 0.75, 1.0, 1.4], "wind_a": [0.03, 0.06, 0.1],
                    "elev_scale": [0.0, 400.0, 800.0]}
    best = None
    for k in grid["k"]:
        for wa in grid["wind_a"]:
            for es in grid["elev_scale"]:
                p = replace(Params(), k=k, wind_a=wa, elev_scale=es)
                arr = spread(terrain, weather, ignitions, start, hours, p, constraints)
                s, detail = score(arr, start, observed)
                print(f"  k={k:<4} wind_a={wa:<5} elev={es:<5} score={s:.3f} {detail}")
                if best is None or s > best[0]:
                    best = (s, p, arr, detail)
    return best
