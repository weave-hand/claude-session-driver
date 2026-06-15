import { existsSync, symlinkSync } from 'node:fs';

const DEFAULT_WORKER_DIR = '/tmp/csd-workers';
const BACK_COMPAT_LINK = '/tmp/claude-workers';

export function workerDir(): string {
  return process.env.CSD_WORKER_DIR ?? DEFAULT_WORKER_DIR;
}

export function eventsPath(dir: string, sid: string): string {
  return `${dir}/${sid}.events.jsonl`;
}

export function metaPath(dir: string, sid: string): string {
  return `${dir}/${sid}.meta`;
}

export function shimPath(dir: string, name: string): string {
  return `${dir}/bin/${name}`;
}

/**
 * The per-worker home dir, keyed by tmux_name. Derive harnesses (codex's
 * CODEX_HOME, pi's PI_CODING_AGENT_DIR) stage the operator's auth and config
 * here during `prepare`. Deterministic from tmux_name so it can be re-derived
 * without persisted state; `stop`/`removeWorker` deletes it to clean up the
 * staged credentials.
 */
export function workerHomePath(dir: string, name: string): string {
  return `${dir}/homes/${name}`;
}

/**
 * The sidecar harness marker keyed by tmux_name. Written at launch for derive
 * harnesses (codex), whose `<sid>.meta` does not exist until the producer
 * self-registers it on the first prompt — so per-worker commands can load the
 * right driver during that pre-registration window. Assign harnesses (claude)
 * carry the harness in the meta from launch and do not need this.
 */
export function harnessMarkerPath(dir: string, name: string): string {
  return `${dir}/${name}.harness`;
}

export function claudeTranscriptPath(
  home: string,
  cwd: string,
  sid: string,
): string {
  return `${home}/.claude/projects/${cwd.replace(/[/._:]/g, '-')}/${sid}.jsonl`;
}

/**
 * Creates a back-compat symlink /tmp/claude-workers → /tmp/csd-workers when
 * using the default worker dir. Best-effort: errors are silently swallowed so
 * a failure here never crashes the caller.
 */
export function ensureBackCompatSymlink(dir: string): void {
  if (dir !== DEFAULT_WORKER_DIR) return;
  if (existsSync(BACK_COMPAT_LINK)) return;
  try {
    symlinkSync(DEFAULT_WORKER_DIR, BACK_COMPAT_LINK);
  } catch {
    // best-effort; a failure must not crash
  }
}
