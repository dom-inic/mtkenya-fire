/// <reference lib="webworker" />
import type { EngineWorld, Scenario } from "@/lib/engine";
import { run } from "@/lib/run";

let world: EngineWorld | null = null;

self.onmessage = (e: MessageEvent<{ type: "init"; world: EngineWorld } | { type: "run"; id: number; scenario: Scenario }>) => {
  const msg = e.data;
  if (msg.type === "init") {
    world = msg.world;
    return;
  }
  if (!world) return;
  const result = run(world, msg.scenario, (done, total) => self.postMessage({ type: "progress", id: msg.id, done, total }));
  const transfer: ArrayBuffer[] = [result.arrival.buffer, result.eta.buffer] as ArrayBuffer[];
  if (result.prob) transfer.push(result.prob.buffer as ArrayBuffer);
  if (result.response) {
    const b = result.response.block;
    transfer.push(b.from.buffer as ArrayBuffer, b.until.buffer as ArrayBuffer, b.kind.buffer as ArrayBuffer);
  }
  self.postMessage({ type: "result", id: msg.id, result }, { transfer });
};
