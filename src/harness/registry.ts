/**
 * The harness-driver registry: resolve a harness id to its driver. Codex
 * (Phase B) and Pi (Phase C) register here as they land.
 */

import { claude } from './claude.js';
import type { HarnessDriver, HarnessId } from './driver.js';

const DRIVERS: Partial<Record<HarnessId, HarnessDriver>> = { claude };

export function getDriver(id: string): HarnessDriver {
  const driver = DRIVERS[id as HarnessId];
  if (!driver) {
    throw new Error(
      `Unknown harness '${id}'. Available: ${Object.keys(DRIVERS).join(', ')}`,
    );
  }
  return driver;
}
