"""
Shared settings: study area, grids, dates and named places for the
September 2026 Mount Kenya fire.
"""

from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "pipeline" / "cache"
OUT = ROOT / "web" / "public" / "data"
CACHE.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
load_dotenv(ROOT / ".env")

# Working CRS: UTM 37S (metres). Mount Kenya straddles the equator, and one
# CRS for both Sentinel-2 tiles (T37NCA north, T37MCV south) keeps maths simple.
CRS = "EPSG:32737"

# Sentinel-2 burn mapping: north-east flank, 20 m pixels
S2_BBOX = (37.30, -0.22, 37.62, 0.12)
S2_RES = 20

# Spread model: the fire and the terrain around it, coarser pixels
SIM_BBOX = (37.32, -0.17, 37.58, 0.05)
SIM_RES = 60

# Hotspots: the whole mountain, so other fires that week show up too
FIRMS_BBOX = (36.95, -0.50, 37.85, 0.40)

TZ = "Africa/Nairobi"  # EAT, UTC+3, no daylight saving

# Sentinel-2 L2A scenes (both tiles were acquired ~10:40 EAT each date)
S2_PRE = "2026-08-25"
S2_POSTS = ["2026-09-01", "2026-09-04", "2026-09-09", "2026-09-14", "2026-09-19", "2026-09-24"]

# Replay window shown in the app (EAT)
INCIDENT_START = "2026-09-01T00:00"
INCIDENT_END = "2026-09-09T00:00"

# OpenStreetMap coordinates (lat, lon)
PLACES = {
    "Rutundu cabins": (-0.0395, 37.4611),
    "Lake Rutundu": (-0.0418, 37.4640),
    "Lake Alice": (-0.0754, 37.4653),
    "Lake Ellis": (-0.1238, 37.4010),
    "Lake Michaelson": (-0.1460, 37.3514),
    "Chogoria Gate": (-0.1612, 37.4460),
    "Marania Forest Station": (0.0824, 37.4807),
    "Batian (5,199 m)": (-0.1527, 37.3092),
    "Point Lenana": (-0.1552, 37.3178),
    "Sirimon Gate": (0.0052, 37.2466),
}

# Timeline from news reports (times are approximate where only a day was given)
KEY_EVENTS = [
    {"time": "2026-09-01T12:00", "kind": "ignition",
     "title": "Fire first reported near Rutundu",
     "source": "Mount Kenya Trust via Pulse Kenya, Capital FM"},
    {"time": "2026-09-02T09:00", "kind": "response",
     "title": "Ground and aerial firefighting begins",
     "source": "KWS via Tourism Update"},
    {"time": "2026-09-02T12:00", "kind": "behaviour",
     "title": "Fires on the eastern flank of Kibiaranyeki (Tue–Wed)",
     "source": "Mount Kenya Trust via Pulse Kenya"},
    {"time": "2026-09-04T12:00", "kind": "behaviour",
     "title": "Spread south and west from Rutundu toward Lakes Alice and Ellis; crosses Kathita Gorge",
     "source": "Mount Kenya Trust via Pulse Kenya, Nation"},
    {"time": "2026-09-06T14:00", "kind": "weather",
     "title": "Rain around Lakes Ellis and Alice; northern section contained",
     "source": "Tourism Update, Capital FM"},
    {"time": "2026-09-08T09:00", "kind": "containment",
     "title": "KFS: ~85% suppressed, not yet fully under control",
     "source": "Mwakilishi"},
]

REPORTED_AREAS = [
    {"source": "KFS / Environment CS", "date": "2026-09-08", "ha": 3000},
    {"source": "Mount Kenya Trust / Rhino Ark", "date": "2026-09-06", "ha": 8700},
    {"source": "Daily Nation (30,000 acres)", "date": "2026-09-07", "ha": 12141},
]
