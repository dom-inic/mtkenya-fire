"use client";

import type { FireData } from "@/lib/data";

export default function About({ data, onClose }: { data: FireData; onClose: () => void }) {
  const { incident } = data;
  const p = incident.sim.params;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-panel p-6 text-[13px] leading-relaxed shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">Method, data and limits</h2>
          <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>

        <h3 className="mt-4 font-semibold">What happened (news reports)</h3>
        <p>
          The fire was first reported on 1 Sep 2026 near Rutundu on the north-east moorlands. It burned on the eastern flank of Kibiaranyeki on Tue–Wed, then on Thursday 4 Sep spread south and west toward
          Lakes Alice and Ellis and crossed Kathita Gorge. KWS, KFS, KDF, Mount Kenya Trust, Lewa, Rhino Ark, Borana, Kisima and community scouts fought it, with aircraft from Tropic Air. Rain fell around the
          lakes on the afternoon of 6 Sep; KFS reported it ~85% suppressed on 8 Sep. Reported areas range from 3,000 to ~12,000 ha. The cause is under investigation; wild honey harvesting is suspected but not
          confirmed.
        </p>

        <h3 className="mt-4 font-semibold">Burned area: Sentinel-2</h3>
        <p>
          Six Sentinel-2 L2A passes (1–24 Sep) compared with a clear pass on 25 Aug using the differenced Normalised Burn Ratio (dNBR, NIR vs SWIR-2), cloud-masked with the scene classification. The scar
          measures <b>{incident.sentinel.final_area_ha.toLocaleString()} ha</b>, close to the Mount Kenya Trust&apos;s 8,700 ha. Each pass shows what had burned by 10:40 that day, so timing is to the day, not
          the hour; clouds hid parts of some passes.
        </p>

        <h3 className="mt-4 font-semibold">Hotspots: NASA FIRMS</h3>
        <p>
          {incident.hotspots.available
            ? `${incident.hotspots.count} VIIRS / MODIS detections on this fire; the first at ${incident.hotspots.first}. Each satellite passes about twice a day.`
            : "Not loaded yet: add FIRMS_MAP_KEY to .env and rebuild the data."}
        </p>

        <h3 className="mt-4 font-semibold">Spread model</h3>
        <p>
          A grid model (60 m cells, 16 directions) computes when fire reaches each cell. Rate of spread depends on fuel (ESA WorldCover + elevation: alpine grass, ericaceous heath, heath forest, montane
          forest), slope (doubling per 10° uphill), hourly wind (ERA5, elliptical fire shape), humidity and elevation. Rain and containment reported on 6 and 8 Sep are applied as slow-downs because the
          25 km weather model misses them. The ignition point and time were found by searching for the start that best reproduces the Sentinel-2 burn ({incident.sim.ignition_basis}). Calibrated: k={p.k},
          wind coefficient {p.wind_a}, elevation scale {p.elev_scale} m. Overall agreement {incident.sim.score.toFixed(2)} (Sørensen).
          {incident.sim.assimilated && (
            <>
              {" "}
              Feeding the {incident.sim.assimilated.detections} FIRMS detections back in as new ignitions (hotspot assimilation) scores {incident.sim.assimilated.score.toFixed(2)} against{" "}
              {incident.sim.model_only?.score.toFixed(2)} for the model alone; the replay uses {incident.sim.uses_assimilation ? "the assimilated run" : "the model alone"}.
            </>
          )}
        </p>
        <p className="mt-2 text-stone-600">
          Limits: no spotting (embers jumping ahead, e.g. across Kathita Gorge), no firefighting lines, one weather point for the whole fire, and fuel types from land cover rather than field surveys.
          The model misses the south-western lobes toward Lake Ellis and runs a little too far north-west.
        </p>

        <h3 className="mt-4 font-semibold">Drones</h3>
        <p>Simulated. The fleet flies missions against the modelled fire to show what drone support would look like; positions, camera feeds and detections are generated, not recorded.</p>

        <h3 className="mt-4 font-semibold">Sources</h3>
        <ul className="list-disc pl-5 text-stone-700">
          <li>Copernicus Sentinel-2 L2A, Copernicus GLO-30 DEM, ESA WorldCover 2021 (via Microsoft Planetary Computer)</li>
          <li>NASA FIRMS VIIRS / MODIS active fires</li>
          <li>ERA5 reanalysis via Open-Meteo; OpenStreetMap place names</li>
          <li>Reports: Mount Kenya Trust (via Pulse Kenya, Capital FM / allAfrica), Daily Nation, Mwakilishi, Tourism Update, Africanews</li>
        </ul>
      </div>
    </div>
  );
}
