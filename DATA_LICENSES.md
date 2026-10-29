# Data licences

The code in this repository is [Apache-2.0](LICENSE). The data products the
pipeline builds, committed in `web/public/data` so the app runs without
re-downloading everything, and the screenshots in `docs/media`, are derived
from the datasets below and keep those datasets' terms. If you redistribute
them, keep the attributions.

| Dataset | Licence / terms | Used for | Files |
|---|---|---|---|
| Copernicus Sentinel-2 L2A (ESA / EU Copernicus), via Microsoft Planetary Computer | [Copernicus data licence](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice): free, full and open; attribute "Contains modified Copernicus Sentinel data [year]" | Burn scar, severity, progression; 3D world imagery | `observed_perimeters.geojson`, `burn_severity.png`, `s2_falsecolour_*.webp`, `world/imagery_*.webp`, `docs/media/s2-*.jpg` |
| Copernicus DEM GLO-30 | [Copernicus DEM licence](https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf): free use with attribution | Elevation, slope | `world/heights_*.u16`, spread-model inputs |
| ESA WorldCover 2021 v200 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium | Fuel types | `fuels.png`, `world/fuel_*.u8` |
| OpenStreetMap | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/), © OpenStreetMap contributors | Roads, tracks, lakes, airstrips, place names | `world/features.json` (a derived database: if you publicly use an adapted version, it must stay under ODbL) |
| NASA FIRMS (VIIRS S-NPP, NOAA-20, NOAA-21; MODIS) | [NASA open data policy](https://www.earthdata.nasa.gov/engage/open-data-services-and-software/data-and-information-policy): free; acknowledge LANCE/FIRMS | Hotspots | `hotspots.geojson`, `incident.json` |
| ERA5 reanalysis (Copernicus Climate Change Service) via Open-Meteo | [CC BY 4.0](https://open-meteo.com/en/license); ERA5 under the [Copernicus licence](https://cds.climate.copernicus.eu/api/v2/terms/static/licence-to-use-copernicus-products.pdf) | Hourly weather | `incident.json` |
| News reports (Mount Kenya Trust via Pulse Kenya, Capital FM / allAfrica; Daily Nation; Mwakilishi; Tourism Update; Africanews) | Cited facts only (dates, places, reported areas) with links | Incident timeline | `incident.json`, `pipeline/mkfire/config.py` |

## Services the app calls at runtime

These are not redistributed here, but their terms apply when you run the app:

- **Esri World Imagery** (satellite basemap in the Incident and Drones maps and
  the drone camera): see [Esri's terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement)
  and keep the on-map attribution. For a production deployment you may need an
  ArcGIS account, or swap the source in `web/lib/basemap.ts` for your own
  imagery.
- **AWS Terrain Tiles** (Mapzen, Terrarium encoding): [attribution requirements](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- **Mapbox GL JS and Mapbox fonts:** need a Mapbox token; [Mapbox terms](https://www.mapbox.com/legal/tos).
- **Open-Meteo forecast and archive APIs:** free for **non-commercial** use;
  commercial use needs an [Open-Meteo API plan](https://open-meteo.com/en/pricing).
- **NASA FIRMS API:** needs a free MAP_KEY; respect its rate limits.
- **OpenStreetMap Overpass API** (pipeline only): follow the [usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)
  (send a User-Agent, keep queries reasonable).
- **Microsoft Planetary Computer** (pipeline only): [terms of use](https://planetarycomputer.microsoft.com/terms).
