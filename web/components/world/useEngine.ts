"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FireData } from "@/lib/data";
import type { EngineResult, EngineWorld, Scenario } from "@/lib/engine";
import type { WorldData } from "@/lib/world";

/** Owns the fire-engine worker: hands it the world once, then runs scenarios. */
export function useEngine(world: WorldData | null, data: FireData) {
  const worker = useRef<Worker | null>(null);
  const latest = useRef(0);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!world) return;
    const w = new Worker(new URL("../../workers/fire.worker.ts", import.meta.url), { type: "module" });
    const engineWorld: EngineWorld = {
      world: world.meta.world,
      inner: world.meta.inner,
      heightsOuter: world.heightsOuter,
      heightsInner: world.heightsInner,
      fuelOuter: world.fuelOuter,
      fuelInner: world.fuelInner,
      baseRos: data.incident.fuels.map((f) => f.base_ros),
      roads: world.features.roads,
      lakes: world.features.lakes.map((l) => l.ring),
    };
    w.postMessage({ type: "init", world: engineWorld });
    w.onmessage = (e) => {
      const msg = e.data;
      if (msg.id !== latest.current) return; // a newer run superseded this one
      if (msg.type === "progress") setProgress({ done: msg.done, total: msg.total });
      else if (msg.type === "result") {
        setResult(msg.result as EngineResult);
        setProgress(null);
      }
    };
    worker.current = w;
    return () => w.terminate();
  }, [world, data]);

  const run = useCallback((scenario: Scenario) => {
    if (!worker.current) return;
    const id = ++latest.current;
    setProgress({ done: 0, total: scenario.ensemble ? 11 : 1 });
    worker.current.postMessage({ type: "run", id, scenario });
  }, []);

  const clear = useCallback(() => {
    latest.current++;
    setResult(null);
    setProgress(null);
  }, []);

  return { result, progress, run, clear };
}
