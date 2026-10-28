import { buildTerrain, controlLines, forecastRuns, summarise, type EngineResult, type EngineWorld, type Scenario } from "./engine";
import { respond } from "./suppression";

/** Forecast, then (if any units were sent) the same fire with the response working on it. */
export function run(w: EngineWorld, s: Scenario, progress?: (done: number, total: number) => void): EngineResult {
  const t0 = performance.now();
  const terrain = buildTerrain(w, s);
  const r = s.resources;
  const responding = !!r && r.helis.length + r.tankers.length + r.crews.length > 0;
  const extra = responding ? s.hours : 0;
  const f = forecastRuns(terrain, s, (d, t) => progress?.(d, t + extra));
  const base = summarise(terrain, f.arrival, s.hours);
  const control = controlLines(terrain, f.arrival, f.eta, s.hours, base.series);
  if (!responding) {
    return { grid: terrain.g, arrival: f.arrival, prob: f.prob, eta: f.eta, series: base.series, firsts: base.firsts, control, baseline: null, response: null, runs: f.runs, ms: Math.round(performance.now() - t0) };
  }
  const resp = respond(terrain, s, r!, w.lakes, (d) => progress?.(f.runs + d, f.runs + extra));
  const after = summarise(terrain, resp.arrival, s.hours);
  const { arrival, ...rest } = resp;
  const response = { block: rest.block, legs: rest.legs, drops: rest.drops, crewTracks: rest.crewTracks, lineCells: rest.lineCells, units: rest.units };
  return {
    grid: terrain.g,
    arrival,
    prob: f.prob,
    eta: f.eta,
    series: after.series,
    firsts: after.firsts,
    control,
    baseline: { series: base.series },
    response,
    runs: f.runs,
    ms: Math.round(performance.now() - t0),
  };
}
