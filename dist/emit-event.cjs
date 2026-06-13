"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/hooks/emit-event.ts
var emit_event_exports = {};
__export(emit_event_exports, {
  isoSecondsUtc: () => isoSecondsUtc,
  runHook: () => runHook
});
module.exports = __toCommonJS(emit_event_exports);
var import_node_fs3 = require("fs");

// src/core/event-log.ts
var import_node_fs = require("fs");

// src/events.ts
function serializeEvent(e) {
  return JSON.stringify(e);
}

// src/core/event-log.ts
function appendEvent(file, e) {
  (0, import_node_fs.appendFileSync)(file, `${serializeEvent(e)}
`);
}

// src/core/paths.ts
var import_node_fs2 = require("fs");
var DEFAULT_WORKER_DIR = "/tmp/csd-workers";
function workerDir() {
  return process.env.CSD_WORKER_DIR ?? DEFAULT_WORKER_DIR;
}
function eventsPath(dir, sid) {
  return `${dir}/${sid}.events.jsonl`;
}
function metaPath(dir, sid) {
  return `${dir}/${sid}.meta`;
}

// src/hooks/emit-event.ts
var EVENT_MAP = {
  SessionStart: "session_start",
  Stop: "stop",
  UserPromptSubmit: "user_prompt_submit",
  SessionEnd: "session_end",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use"
};
function isoSecondsUtc(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function asRecord(v) {
  return typeof v === "object" && v !== null ? v : null;
}
function asString(v) {
  return typeof v === "string" ? v : "";
}
function runHook(opts) {
  const empty = { stdout: "" };
  let parsed;
  try {
    parsed = JSON.parse(opts.stdin);
  } catch {
    return empty;
  }
  const payload = asRecord(parsed);
  if (payload === null) return empty;
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return empty;
  if (!(0, import_node_fs3.existsSync)(metaPath(opts.workerDir, sessionId))) return empty;
  const hookEventName = asString(payload.hook_event_name);
  const event = EVENT_MAP[hookEventName];
  if (event === void 0) return empty;
  const ts = opts.now();
  const worker = buildEvent(event, ts, payload);
  appendEvent(eventsPath(opts.workerDir, sessionId), worker);
  const stdout = hookEventName === "Stop" ? '{"decision":"approve"}' : "";
  return { stdout, appended: worker };
}
function buildEvent(event, ts, payload) {
  switch (event) {
    case "session_start": {
      const cwd = asString(payload.cwd);
      return cwd.length > 0 ? { event, ts, cwd } : { event, ts };
    }
    case "pre_tool_use": {
      const toolInput = payload.tool_input;
      return {
        event,
        ts,
        tool: asString(payload.tool_name),
        tool_input: toolInput === void 0 ? {} : toolInput
      };
    }
    case "post_tool_use":
      return { event, ts, tool: asString(payload.tool_name) };
    default:
      return { event, ts };
  }
}
function readStdin(timeoutMs = 5e3) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => finish(data));
    process.stdin.on("error", () => finish(data));
  });
}
async function main() {
  const stdin = await readStdin();
  const result = runHook({
    stdin,
    workerDir: workerDir(),
    now: () => isoSecondsUtc()
  });
  if (result.stdout.length > 0) {
    process.stdout.write(`${result.stdout}
`);
  }
  process.exit(0);
}
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  void main();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isoSecondsUtc,
  runHook
});
