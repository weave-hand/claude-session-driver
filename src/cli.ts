import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { cmdAdopt } from './commands/adopt.js';
import type { CommandContext, CommandResult } from './commands/context.js';
import { cmdConverse } from './commands/converse.js';
import { cmdEventsFile } from './commands/events-file.js';
import { cmdGrantConsent } from './commands/grant-consent.js';
import { cmdHandoff } from './commands/handoff.js';
import type { BootstrapOpts } from './commands/launch.js';
import { cmdLaunch } from './commands/launch.js';
import { cmdList } from './commands/list.js';
import { cmdReadEvents, followEvents } from './commands/read-events.js';
import { cmdReadTurn } from './commands/read-turn.js';
import { cmdSend } from './commands/send.js';
import { cmdSessionId } from './commands/session-id.js';
import { cmdStatus } from './commands/status.js';
import { cmdStop } from './commands/stop.js';
import { cmdWaitForTurn } from './commands/wait-for-turn.js';
import { workerDir } from './core/paths.js';
import { tmux } from './core/tmux.js';
import type { HarnessId } from './harness/driver.js';
import { getDriver } from './harness/registry.js';

/** Writers the dispatcher prints through; tests inject capturing functions. */
export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const realIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

const TOP_LEVEL_SUBS = ['launch', 'adopt', 'list', 'grant-consent', 'help'];
const PER_WORKER_SUBS = [
  'converse',
  'send',
  'wait-for-turn',
  'status',
  'read-events',
  'read-turn',
  'stop',
  'handoff',
  'session-id',
  'events-file',
];

/**
 * The user contract. A verbatim port of the bash `usage()` heredoc, with the
 * two `/tmp/claude-workers` references updated to the new `/tmp/csd-workers`
 * default (the back-compat symlink keeps the old path working).
 */
const USAGE = `Usage: csd <subcommand> [args...]
       csd --worker <name> <subcommand> [args...]

A worker is a Claude Code session in a tmux pane with the session-driver plugin
loaded. \`csd launch\` prints a *shim path* on stdout (deterministic at
/tmp/csd-workers/bin/<tmux-name>) — run that shim for all per-worker
subcommands. \`csd stop\` removes the shim along with the worker's state.

Top-level subcommands:
  launch <tmux-name> <cwd> [-- claude-args...]
                       Bootstrap a worker; shim path on stdout, panel on stderr
  adopt <tmux-name> <cwd> <session-id> [-- claude-args...]
                       Re-adopt an existing Claude session as a driveable
                       worker via \`claude --resume <session-id>\`. Restores a
                       worker after a reboot/crash wiped /tmp/csd-workers
                       while the conversation transcript survived. If a tmux
                       session named <tmux-name> already exists (e.g. restored
                       by tmux-resurrect), respawns its pane in place; else
                       opens a new one. Shim path on stdout, panel on stderr
  list [--all] [<pattern>]
                       Enumerate workers (default: skip workers whose tmux is
                       gone). Optional pattern filters by tmux-name substring
  grant-consent        One-time consent for --dangerously-skip-permissions
  help                 Show this message

Per-worker subcommands (require --worker, supplied by the shim):
  converse [--with-turn] <prompt> [timeout=120]
                       Send prompt, wait for turn, return assistant text.
                       --with-turn returns the full markdown turn instead
  send <prompt>        Send a prompt without waiting for the turn
  wait-for-turn [timeout=60]
                       Block until the next stop OR session_end
  status               idle | working | terminated | gone | unknown
  read-events [--last N] [--type T] [--follow]
                       Read the event JSONL stream
  read-turn [--full]   Last turn as markdown. Without --full, tool results
                       are truncated to 5 lines; --full shows them complete
  stop                 /exit, clean up meta + events + shim
  handoff              Print tmux-attach instructions for a human
  session-id           Print the worker's session UUID
  events-file          Print the absolute path to the events JSONL

Environment variables:
  CSD_CLAUDE_BIN       Path to the claude binary (default: claude — resolved via PATH).
                       Set when claude is not on PATH or you want a specific version.
  CSD_CONVERSE_DIAG_FILE
                       When set, \`converse\` writes a post-mortem diagnostic (ps tree +
                       tmux capture-pane + claude session JSONL tail + csd events tail)
                       to this path on timeout, then emits "csd-diagnostic: <path>" to
                       stderr. Overwritten on each timeout. Unset = no diagnostic file.
  HOME                 Used to locate ~/.claude/projects/<encoded-cwd>/<sid>.jsonl and
                       the one-time consent file (~/.claude/.claude-session-driver-consent).
`;

/** A code-2 dispatch error: print `message` to stderr, return 2. */
interface DispatchError {
  message: string;
  code: number;
}

function err(message: string, code = 2): DispatchError {
  return { message, code };
}

/**
 * Parse a leading `--worker <val>` / `--worker=val` (bash csd:950-963). Returns
 * the worker (or undefined) plus the remaining argv after the worker flag, or a
 * DispatchError when `--worker` is given with no value.
 */
function parseWorker(
  argv: string[],
): { worker?: string; rest: string[] } | DispatchError {
  let worker: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? '';
    if (a === '--worker') {
      if (i + 1 >= argv.length) {
        return err('Error: --worker requires a value');
      }
      worker = argv[i + 1];
      i += 2;
    } else if (a.startsWith('--worker=')) {
      worker = a.slice('--worker='.length);
      i += 1;
    } else {
      break;
    }
  }
  return { worker, rest: argv.slice(i) };
}

/** Build the CommandContext: real tmux, claude as the default driver. */
function buildContext(): CommandContext {
  return {
    workerDir: workerDir(),
    home: process.env.HOME ?? homedir(),
    tmux,
    driver: getDriver('claude'),
  };
}

/**
 * The bootstrap opts launch/adopt need. In the tsup CJS bundle `__dirname` is
 * the `dist/` directory, so the plugin root is its parent and `csd.cjs` sits
 * beside this file.
 */
function bootstrapOpts(): BootstrapOpts {
  const csdEntry = join(__dirname, 'csd.cjs');
  return {
    pluginDir: process.env.CLAUDE_PLUGIN_ROOT ?? resolve(__dirname, '..'),
    csdEntry,
    csdPath: process.env.CSD_PATH ?? csdEntry,
  };
}

/** Read one line from stdin, resolving the trimmed string. */
function readLine(): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin });
    rl.once('line', (line) => {
      rl.close();
      res(line.trim());
    });
  });
}

/** Parse `launch <tmux-name> <cwd> [--harness <id>] [-- claude-args...]`. */
function parseLaunchArgs(
  argv: string[],
):
  | { tmuxName: string; cwd: string; extraArgs: string[]; harness: HarnessId }
  | DispatchError {
  const usage = 'Usage: launch <tmux-name> <cwd> [-- claude-args...]';
  const positionals: string[] = [];
  let harness: HarnessId = 'claude';
  let extraArgs: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? '';
    if (a === '--') {
      extraArgs = argv.slice(i + 1);
      break;
    }
    if (a === '--harness') {
      if (i + 1 >= argv.length) return err(usage);
      harness = argv[i + 1] as HarnessId;
      i += 2;
      continue;
    }
    positionals.push(a);
    i += 1;
  }
  const [tmuxName, cwd] = positionals;
  if (tmuxName === undefined || cwd === undefined) return err(usage);
  return { tmuxName, cwd, extraArgs, harness };
}

/** Parse `adopt <tmux-name> <cwd> <session-id> [-- claude-args...]`. */
function parseAdoptArgs(
  argv: string[],
):
  | { tmuxName: string; cwd: string; sessionId: string; extraArgs: string[] }
  | DispatchError {
  const usage =
    'Usage: adopt <tmux-name> <cwd> <session-id> [-- claude-args...]';
  let rest = argv;
  let extraArgs: string[] = [];
  const sep = rest.indexOf('--');
  if (sep !== -1) {
    extraArgs = rest.slice(sep + 1);
    rest = rest.slice(0, sep);
  }
  const [tmuxName, cwd, sessionId] = rest;
  if (tmuxName === undefined || cwd === undefined || sessionId === undefined) {
    return err(usage);
  }
  return { tmuxName, cwd, sessionId, extraArgs };
}

/** Print a CommandResult and return its code; each stream gets a trailing newline. */
function emit(io: Io, result: CommandResult): number {
  if (result.stdout !== undefined && result.stdout.length > 0) {
    io.out(`${result.stdout}\n`);
  }
  if (result.stderr !== undefined && result.stderr.length > 0) {
    io.err(`${result.stderr}\n`);
  }
  return result.code;
}

/**
 * The CLI dispatcher. Parses `--worker`, validates the subcommand against the
 * top-level/per-worker sets, builds the CommandContext, parses the per-command
 * args, runs the matching command, and prints its result. Returns the exit code
 * (never calls process.exit — the entry point does that).
 */
export async function run(argv: string[], io: Io = realIo): Promise<number> {
  const parsed = parseWorker(argv);
  if ('code' in parsed) {
    io.err(`${parsed.message}\n`);
    return parsed.code;
  }
  const { worker, rest } = parsed;
  const sub = rest[0];
  const args = rest.slice(1);

  if (sub === undefined) {
    io.err(USAGE);
    return 2;
  }

  if (TOP_LEVEL_SUBS.includes(sub)) {
    if (worker !== undefined) {
      io.err(
        `Error: --worker is not valid for '${sub}' (top-level subcommand)\n`,
      );
      return 2;
    }
  } else if (PER_WORKER_SUBS.includes(sub)) {
    if (worker === undefined) {
      io.err(`Error: --worker <name> is required for '${sub}'\n`);
      return 2;
    }
  } else {
    io.err(`Error: unknown subcommand '${sub}'\n`);
    io.err(USAGE);
    return 2;
  }

  if (sub === 'help') {
    io.out(USAGE);
    return 0;
  }

  const ctx = buildContext();
  // PER_WORKER_SUBS validation above guarantees `worker` is set for those subs.
  const w = worker as string;

  switch (sub) {
    case 'grant-consent':
      return emit(
        io,
        await cmdGrantConsent(ctx, { confirm: () => grantConsentConfirm(io) }),
      );

    case 'launch': {
      const parsedArgs = parseLaunchArgs(args);
      if ('code' in parsedArgs) {
        io.err(`${parsedArgs.message}\n`);
        return parsedArgs.code;
      }
      return emit(io, await cmdLaunch(ctx, parsedArgs, bootstrapOpts()));
    }

    case 'adopt': {
      const parsedArgs = parseAdoptArgs(args);
      if ('code' in parsedArgs) {
        io.err(`${parsedArgs.message}\n`);
        return parsedArgs.code;
      }
      return emit(io, await cmdAdopt(ctx, parsedArgs, bootstrapOpts()));
    }

    case 'list': {
      const opts = parseListArgs(args);
      if ('code' in opts) {
        io.err(`${opts.message}\n`);
        return opts.code;
      }
      return emit(io, await cmdList(ctx, opts));
    }

    case 'converse': {
      let withTurn = false;
      let i = 0;
      if (args[i] === '--with-turn') {
        withTurn = true;
        i += 1;
      }
      const prompt = args[i];
      if (prompt === undefined) {
        io.err('Usage: converse [--with-turn] <prompt> [timeout=120]\n');
        return 1;
      }
      const timeout = args[i + 1] !== undefined ? Number(args[i + 1]) : 120;
      return emit(io, await cmdConverse(ctx, w, prompt, { withTurn, timeout }));
    }

    case 'send': {
      const prompt = args[0];
      if (prompt === undefined) {
        io.err('Usage: send <prompt>\n');
        return 1;
      }
      return emit(io, await cmdSend(ctx, w, prompt));
    }

    case 'wait-for-turn': {
      const opts = parseWaitForTurnArgs(args);
      if ('code' in opts) {
        io.err(`${opts.message}\n`);
        return opts.code;
      }
      return emit(io, await cmdWaitForTurn(ctx, w, opts));
    }

    case 'read-events': {
      const opts = parseReadEventsArgs(args);
      if ('code' in opts) {
        io.err(`${opts.message}\n`);
        return opts.code;
      }
      if (opts.follow) {
        return followStream(ctx, w, opts, io);
      }
      return emit(
        io,
        await cmdReadEvents(ctx, w, { last: opts.last, type: opts.type }),
      );
    }

    case 'read-turn': {
      const full = args[0] === '--full';
      return emit(io, await cmdReadTurn(ctx, w, { full }));
    }

    case 'status':
      return emit(io, await cmdStatus(ctx, w));

    case 'handoff':
      return emit(io, await cmdHandoff(ctx, w));

    case 'session-id':
      return emit(io, await cmdSessionId(ctx, w));

    case 'events-file':
      return emit(io, await cmdEventsFile(ctx, w));

    case 'stop':
      return emit(io, await cmdStop(ctx, w));

    default:
      // Unreachable: validated against PER_WORKER_SUBS/TOP_LEVEL_SUBS above.
      io.err(`Error: unknown subcommand '${sub}'\n`);
      return 2;
  }
}

/** Parse `list [--all] [<pattern>]`. */
function parseListArgs(
  argv: string[],
): { all?: boolean; pattern?: string } | DispatchError {
  let all = false;
  let pattern: string | undefined;
  for (const a of argv) {
    if (a === '--all') {
      all = true;
    } else if (a.startsWith('--')) {
      return err(`Error: unknown option '${a}' for list`);
    } else if (pattern !== undefined) {
      return err('Error: list takes at most one pattern argument');
    } else {
      pattern = a;
    }
  }
  return { all, pattern };
}

/** Parse `wait-for-turn [timeout=60] [--after-line N]`. */
function parseWaitForTurnArgs(
  argv: string[],
): { timeout?: number; afterLine?: number } | DispatchError {
  let timeout: number | undefined;
  let afterLine: number | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? '';
    if (a === '--after-line') {
      afterLine = Number(argv[i + 1]);
      i += 2;
    } else if (/^[0-9]/.test(a)) {
      timeout = Number(a);
      i += 1;
    } else {
      return err(`Error: unknown option '${a}' for wait-for-turn`);
    }
  }
  return { timeout, afterLine };
}

interface ReadEventsArgs {
  last?: number;
  type?: string;
  follow: boolean;
}

/** Parse `read-events [--last N] [--type T] [--follow]`. */
function parseReadEventsArgs(argv: string[]): ReadEventsArgs | DispatchError {
  let last: number | undefined;
  let type: string | undefined;
  let follow = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? '';
    if (a === '--last') {
      last = Number(argv[i + 1]);
      i += 2;
    } else if (a === '--type') {
      type = argv[i + 1];
      i += 2;
    } else if (a === '--follow') {
      follow = true;
      i += 1;
    } else {
      return err(`Error: unknown option '${a}' for read-events`);
    }
  }
  return { last, type, follow };
}

/**
 * Stream events to stdout until SIGINT. followEvents emits lines WITHOUT a
 * trailing newline, so the sink appends one. Resolves 0 once aborted.
 */
function followStream(
  ctx: CommandContext,
  worker: string,
  opts: { type?: string },
  io: Io,
): Promise<number> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  return followEvents(
    ctx,
    worker,
    { type: opts.type },
    (line) => io.out(`${line}\n`),
    controller.signal,
  )
    .then(() => 0)
    .finally(() => process.off('SIGINT', onSigint));
}

/**
 * The interactive consent confirm: print the prompt (the command's preamble no
 * longer includes it), read a line from stdin, resolve true iff it is 'yes'.
 */
async function grantConsentConfirm(io: Io): Promise<boolean> {
  io.out("Type 'yes' to grant consent:\n");
  const reply = await readLine();
  return reply === 'yes';
}

// Run the CLI only when executed as the bundled `node dist/csd.cjs`. In the
// tsup CJS bundle `require.main === module` is true only then; under vitest's
// ESM import of this source it is not, so run() does not fire during tests.
if (
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module
) {
  run(process.argv.slice(2)).then((c) => process.exit(c));
}
