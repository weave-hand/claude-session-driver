import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import 'path';

// src/pi-extension/index.ts

// src/events.ts
function serializeEvent(e) {
  return JSON.stringify(e);
}

// src/core/event-log.ts
function appendEvent(file, e) {
  appendFileSync(file, `${serializeEvent(e)}
`);
}
function eventsPath(dir, sid) {
  return `${dir}/${sid}.events.jsonl`;
}
function metaPath(dir, sid) {
  return `${dir}/${sid}.meta`;
}

// src/core/time.ts
function isoSecondsUtc(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// src/core/tool-name.ts
function canonicalToolName(name) {
  if (typeof name !== "string" || name.length === 0) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}
function writeMeta(dir, meta) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(dir, meta.session_id), JSON.stringify(meta));
}

// src/pi-extension/index.ts
function workerDirFromEnv() {
  const dir = process.env.CSD_WORKER_DIR;
  return dir !== void 0 && dir.length > 0 ? dir : null;
}
function record(ctx, e) {
  try {
    const dir = workerDirFromEnv();
    if (dir === null) return;
    const sid = ctx.sessionManager.getSessionId();
    if (sid.length === 0) return;
    if (!existsSync(metaPath(dir, sid))) {
      const transcriptPath = ctx.sessionManager.getSessionFile();
      writeMeta(dir, {
        tmux_name: process.env.CSD_TMUX_NAME ?? "",
        session_id: sid,
        cwd: ctx.cwd,
        harness: "pi",
        ...transcriptPath !== void 0 && transcriptPath.length > 0 ? { transcript_path: transcriptPath } : {}
      });
    }
    appendEvent(eventsPath(dir, sid), e);
  } catch {
  }
}
function csdPiExtension(pi) {
  pi.on("session_start", (_event, ctx) => {
    record(ctx, { event: "session_start", ts: isoSecondsUtc(), cwd: ctx.cwd });
  });
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") return;
    record(ctx, { event: "user_prompt_submit", ts: isoSecondsUtc() });
  });
  pi.on("tool_call", (event, ctx) => {
    record(ctx, {
      event: "pre_tool_use",
      ts: isoSecondsUtc(),
      tool: canonicalToolName(event.toolName),
      tool_input: event.input
    });
  });
  pi.on("tool_result", (event, ctx) => {
    record(ctx, {
      event: "post_tool_use",
      ts: isoSecondsUtc(),
      tool: canonicalToolName(event.toolName)
    });
  });
  pi.on("agent_end", (_event, ctx) => {
    record(ctx, { event: "stop", ts: isoSecondsUtc() });
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "quit") return;
    record(ctx, { event: "session_end", ts: isoSecondsUtc() });
  });
}

export { csdPiExtension as default };
