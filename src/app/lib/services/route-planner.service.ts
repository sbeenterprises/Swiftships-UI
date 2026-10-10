import { Injectable } from '@angular/core';

export interface PlanResult {
  ok: boolean;
  route?: number[][]; // [lon,lat][]
  error?: string;
}

/**
 * Wraps the A* route-planner web worker. Given the operator's drawn waypoints
 * (via-points) and the ENC navigable polygons, plans a safe route that stays in
 * navigable water and rounds land/shallow/hazards by construction.
 */
@Injectable({ providedIn: 'root' })
export class RoutePlannerService {
  private worker: Worker | null = null;

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
   * @param rings navigable-water outer rings [lon,lat][][]
   * @param resM grid resolution in metres (default 25)
   * @param clearanceM keep the route this far off any land/shallow/hazard edge
   * @param algorithm 'theta' (default) = any-angle Theta*, cleaner/straighter
   *   legs; 'astar' = 8-connected grid A* (legacy, staircase legs).
   * @param centreBias keep to the channel centre (default true); false = shortest.
   */
  planRoute(
    viaPoints: number[][],
    rings: number[][][],
    resM = 25,
    clearanceM = 20,
    algorithm: 'theta' | 'astar' = 'theta',
    centreBias = true
  ): Promise<PlanResult> {
    return new Promise((resolve) => {
      const w = this.ensureWorker();
      const onMsg = ({ data }: MessageEvent) => {
        w.removeEventListener('message', onMsg);
        resolve(data as PlanResult);
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ viaPoints, rings, resM, clearanceM, algorithm, centreBias });
    });
  }
}
