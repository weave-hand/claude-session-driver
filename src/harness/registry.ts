/**
 * The harness-driver registry: resolve a harness id to its driver. Codex
 * (Phase B) and Pi (Phase C) register here as they land.
 */

import { claude } from './claude.js';
import type { HarnessDriver } from './driver.js';

const DRIVERS: Record<string, HarnessDriver> = { claude };

export function getDriver(id: string): HarnessDriver {
  const driver = DRIVERS[id];
  if (!driver) {
    throw new Error(
      `Unknown harness '${id}'. Available: ${Object.keys(DRIVERS).join(', ')}`,
    );
  }
  return driver;
}
