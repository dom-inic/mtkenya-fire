/// <reference lib="webworker" />
import { runScenario, type EngineWorld, type Scenario } from "@/lib/engine";

let world: EngineWorld | null = null;

self.onmessage = (e: MessageEvent<{ type: "init"; world: EngineWorld } | { type: "run"; id: number; scenario: Scenario }>) => {
  const msg = e.data;
  if (msg.type === "init") {
    world = msg.world;
    return;
  }
  if (!world) return;
  const result = runScenario(world, msg.scenario, (done, total) => self.postMessage({ type: "progress", id: msg.id, done, total }));
  const transfer = [result.arrival.buffer, result.eta.buffer, ...(result.prob ? [result.prob.buffer] : [])];
  self.postMessage({ type: "result", id: msg.id, result }, { transfer });
};
