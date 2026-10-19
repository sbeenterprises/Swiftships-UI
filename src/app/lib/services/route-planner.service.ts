import { Injectable } from '@angular/core';

export interface PlanResult {
  ok: boolean;
  route?: number[][]; // [lon,lat][]
  /** closest approach to non-navigable water along the route, metres */
  minClearanceM?: number;
  /** true when the requested clearance could not be kept on some leg */
  relaxed?: boolean;
  error?: string;
}

/** [outer, ...holes] rings of [lon,lat] */
export type PlannerPoly = number[][][];

/** One chart's view of the water: where it applies, its safe water, its hazards. */
export interface PlannerLayer {
  chart: string;
  coverage: PlannerPoly[];
  safe: PlannerPoly[];
  blocked: PlannerPoly[]; // land, pontoons, shallow hazard areas
  blockedPts: number[][]; // wrecks, obstructions, piles
  blockedLines: number[][][]; // piers, seawalls, coastline
}

/**
 * Navigable-water model for the planner. `layers` are ordered most detailed
 * chart first: at any spot the first layer whose coverage contains it decides
 * whether the water there is safe, using only that chart's hazards.
 */
export interface PlannerWorld {
  layers: PlannerLayer[];
}

/**
 * Wraps the route-planner web worker. Given the operator's waypoints
 * (via-points) and the ENC navigable-water model, plans a route that stays in
 * safe water and rounds land / shallows / hazards by construction.
 */
@Injectable({ providedIn: 'root' })
export class RoutePlannerService {
  private worker: Worker | null = null;
  /** one plan at a time: the worker answers in order but has no request ids */
  private queue: Promise<unknown> = Promise.resolve();

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(
        new URL('./route-planner.worker', import.meta.url)
      );
    }
    return this.worker;
  }

  /**
   * @param viaPoints operator waypoints [lon,lat][] (>= 2)
   * @param world navigable-water model (see PlannerWorld)
   * @param resM grid resolution in metres (default 25)
   * @param clearanceM keep the route this far off any land/shallow/hazard edge
   * @param algorithm 'theta' (default) = any-angle Theta*, cleaner/straighter
   *   legs; 'astar' = 8-connected grid A* (legacy, staircase legs).
   * @param centreBias keep to the channel centre (default true); false = shortest.
   */
  planRoute(
    viaPoints: number[][],
    world: PlannerWorld,
    resM = 25,
    clearanceM = 20,
    algorithm: 'theta' | 'astar' = 'theta',
    centreBias = true
  ): Promise<PlanResult> {
    const run = () =>
      new Promise<PlanResult>((resolve) => {
        const w = this.ensureWorker();
        const onMsg = ({ data }: MessageEvent) => {
          w.removeEventListener('message', onMsg);
          resolve(data as PlanResult);
        };
        w.addEventListener('message', onMsg);
        w.postMessage({ viaPoints, ...world, resM, clearanceM, algorithm, centreBias });
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
