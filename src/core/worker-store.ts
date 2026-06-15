import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  eventsPath,
  harnessMarkerPath,
  metaPath,
  shimPath,
  workerHomePath,
} from './paths.js';

export interface WorkerMeta {
  tmux_name: string;
  session_id: string;
  cwd: string;
  harness: string;
  [k: string]: unknown;
}

export function writeMeta(dir: string, meta: WorkerMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(dir, meta.session_id), JSON.stringify(meta));
}

export function readMeta(dir: string, sid: string): WorkerMeta | null {
  const p = metaPath(dir, sid);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WorkerMeta;
  } catch {
    return null;
  }
}

export function listWorkers(dir: string): WorkerMeta[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.meta'))
    .flatMap((f) => {
      const sid = f.slice(0, -'.meta'.length);
      const meta = readMeta(dir, sid);
      return meta !== null ? [meta] : [];
    });
}

export function resolveSession(dir: string, arg: string): string | null {
  if (existsSync(metaPath(dir, arg)) || existsSync(eventsPath(dir, arg))) {
    return arg;
  }
  const match = listWorkers(dir).find((m) => m.tmux_name === arg);
  return match?.session_id ?? null;
}

export function writeShim(dir: string, name: string, csdEntry: string): string {
  const p = shimPath(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  const content = `#!/usr/bin/env bash\nexec node "${csdEntry}" --worker "${name}" "$@"\n`;
  writeFileSync(p, content);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Write the sidecar harness marker for a derive worker (codex), so per-worker
 * commands can resolve the right driver before the meta self-registers.
 */
export function writeHarnessMarker(
  dir: string,
  name: string,
  harness: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(harnessMarkerPath(dir, name), harness);
}

/** Read the sidecar harness marker for `name`, or null if it does not exist. */
export function readHarnessMarker(dir: string, name: string): string | null {
  const p = harnessMarkerPath(dir, name);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function removeWorker(dir: string, sid: string, name: string): void {
  rmSync(metaPath(dir, sid), { force: true });
  rmSync(eventsPath(dir, sid), { force: true });
  rmSync(shimPath(dir, name), { force: true });
  rmSync(harnessMarkerPath(dir, name), { force: true });
  // The per-worker home (codex/pi staged the operator's auth.json here during
  // prepare); remove it recursively so stop leaves no staged credentials behind.
  rmSync(workerHomePath(dir, name), { recursive: true, force: true });
}

/**
 * tmux-names that have a leftover `.harness` sidecar or shim but NO registered
 * `<sid>.meta` — orphans from workers that bypassed `stop` (crash, killed tmux,
 * old fixtures). `list` can't see them (it keys off meta) and the gone-worker
 * scan misses them (no meta). A live derive worker in its pre-registration
 * window also has no meta yet, so callers must gate removal on the tmux session
 * being gone.
 */
export function listOrphanNames(dir: string): string[] {
  const registered = new Set(listWorkers(dir).map((m) => m.tmux_name));
  const names = new Set<string>();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.harness')) names.add(f.slice(0, -'.harness'.length));
    }
  }
  const bin = join(dir, 'bin');
  if (existsSync(bin)) {
    for (const f of readdirSync(bin)) names.add(f);
  }
  return [...names].filter((n) => !registered.has(n));
}

/** Remove a meta-less worker's leftover sidecar/shim/home (orphan cleanup). */
export function removeOrphan(dir: string, name: string): void {
  rmSync(shimPath(dir, name), { force: true });
  rmSync(harnessMarkerPath(dir, name), { force: true });
  rmSync(workerHomePath(dir, name), { recursive: true, force: true });
}
