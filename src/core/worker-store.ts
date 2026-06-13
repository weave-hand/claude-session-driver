import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { eventsPath, metaPath, shimPath } from './paths.js';

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

export function removeWorker(dir: string, sid: string, name: string): void {
  rmSync(metaPath(dir, sid), { force: true });
  rmSync(eventsPath(dir, sid), { force: true });
  rmSync(shimPath(dir, name), { force: true });
}
