/**
 * The harness-driver registry: resolve a harness id to its driver. Pi (Phase C)
 * registers here as it lands.
 */

import { claude } from './claude.js';
import { codex } from './codex.js';
import type { HarnessDriver, HarnessId } from './driver.js';

const DRIVERS: Partial<Record<HarnessId, HarnessDriver>> = { claude, codex };

export function getDriver(id: string): HarnessDriver {
  const driver = DRIVERS[id as HarnessId];
  if (!driver) {
    throw new Error(
      `Unknown harness '${id}'. Available: ${Object.keys(DRIVERS).join(', ')}`,
    );
  }
  return driver;
}
