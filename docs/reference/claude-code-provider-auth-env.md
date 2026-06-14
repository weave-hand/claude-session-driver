# How Claude Code resolves provider & auth from the environment

Reference notes for maintainers. These explain *why* `csd` pins a specific set
of environment variables when it launches or adopts a Claude worker (see
`claudeWorkerEnv` in `src/harness/claude.ts`).

Everything below was read directly out of the Claude Code binary (the
Bun-compiled native build, `@anthropic-ai/claude-code-darwin-arm64`, v2.1.159)
by carving the embedded JS bundle out of the executable. Function names are the
minified identifiers as of that version — they will change between releases, so
treat them as evidence, not API. The *behaviour* is what matters.

## How to re-derive this

```bash
npm pack @anthropic-ai/claude-code-darwin-arm64       # native binary per platform
tar xzf anthropic-ai-claude-code-darwin-*.tgz
# The JS bundle is embedded as a readable text trailer near the end of the
# Mach-O/ELF binary. Find references and carve a window:
grep -a -b -o 'PROVIDER_MANAGED_BY_HOST' package/claude   # byte offsets
tail -c +<offset-minus-context> package/claude | head -c 3000
```

The early offsets land in compiled bytecode (only the string literal is there);
the late offsets (closer to EOF) land in the readable JS trailer — that's where
the logic lives.

## The provider selector

```js
function Zq(){return bH(process.env.CLAUDE_CODE_USE_BEDROCK)?"bedrock":
  bH(process.env.CLAUDE_CODE_USE_FOUNDRY)?"foundry":
  bH(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)?"anthropicAws":
  bH(process.env.CLAUDE_CODE_USE_MANTLE)?"mantle":
  bH(process.env.CLAUDE_CODE_USE_VERTEX)?"vertex":"firstParty"}
function vA(){return Zq()==="firstParty"}
```

`bH(x)` is a truthiness coercion (empty string / unset → false).

**Key fact:** the provider is chosen by reading these env vars **directly**, and
the selector is **not** gated by `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`. The
public docs say `PROVIDER_MANAGED_BY_HOST` causes `USE_BEDROCK` etc. "in
settings files" to be ignored — that qualifier is literal. A `USE_BEDROCK=1`
coming from the **process environment** wins regardless of the host-managed
flag.

## What `PROVIDER_MANAGED_BY_HOST` actually does

Per the official docs (https://code.claude.com/docs/en/env-vars):

> Set by host platforms that embed Claude Code and manage model provider
> routing on its behalf. When set, provider-selection, endpoint, and
> authentication variables such as `CLAUDE_CODE_USE_BEDROCK`,
> `ANTHROPIC_BASE_URL`, and `ANTHROPIC_API_KEY` in settings files are ignored so
> user settings cannot override the host's routing.

It is a *routing-override suppressor*, not a pointer to a process that must be
reachable. In the binary it short-circuits the Bedrock/Vertex model-upgrade and
default-availability probes:

```js
async function bmO(){ if(Zq()!=="bedrock")return[];
  if(bH(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST))return[]; ... }
```

## Host-brokered auth (cmux, IDE extensions)

```js
function ERK(){return process.env.CLAUDE_CODE_HOST_AUTH_ENV_VAR||"ANTHROPIC_AUTH_TOKEN"}
function d7_(){return l_.hostAuthTokenRefreshCallback}
```

- `ERK()` — the host names which env var holds the auth token, via
  `CLAUDE_CODE_HOST_AUTH_ENV_VAR` (default `ANTHROPIC_AUTH_TOKEN`). **The initial
  token is just that environment variable.** A child process that inherits the
  env can authenticate.
- `d7_()` — an in-process `hostAuthTokenRefreshCallback`, invoked only to
  *refresh* the token on a 401 (`api_request_host_managed_auth_fail` path).
  Initial auth does not require the callback, so a detached worker authenticates
  fine for the life of the inherited token.

So a worker inherits host-brokered auth purely through environment variables:
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` + (optionally `CLAUDE_CODE_HOST_AUTH_ENV_VAR`)
+ the token var it names.

## `CLAUDE_CODE_SSE_PORT` is IDE-only

```js
async function RT6(H){ let _=[]; try{
  let q=process.env.CLAUDE_CODE_SSE_PORT,K=q?parseInt(q):null, ...
  // ... matches IDE lock files by port, gated by CLAUDE_CODE_IDE_SKIP_VALID_CHECK
```

`SSE_PORT` is used purely for IDE (VSCode/JetBrains) lock-file discovery and
`autoConnectIde`. It sits in the binary's terminal/IDE-detection env list next
to `VSCODE_*`, `ITERM_SESSION_ID`, `TERM_PROGRAM`. It is **not** the host-auth
channel. A headless worker has no IDE, and a worker auto-connecting to the
*controller's* IDE would be wrong — so `csd` always pins it empty.

## What Claude Code itself does when spawning agents

Claude Code's own teammate/swarm spawner carries an env-forward allowlist
(minified `bL3`) that **propagates** the provider/auth cluster to spawned
agents — including `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`,
`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`/`_ANTHROPIC_AWS`/`_MANTLE`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`,
and the proxy/CA vars. The canonical "spawn a worker that inherits my auth"
pattern is to **propagate** this cluster from the real environment.

## Why this matters for `csd` (issue #18)

`tmux new-session` does **not** inherit the calling process's environment — a new
session inherits the tmux **server's** global environment, captured when the
server first started. A stale `CLAUDE_CODE_USE_BEDROCK=1` left in the server's
global env (visible via `tmux show-environment -g`) therefore leaks into every
worker and, via `Zq()`, forces it onto Bedrock with a likely-expired token → a
403 on the first turn.

`csd` resolves this by **clearing stale values without ever forcing new ones**.
For the provider/auth cluster it pins a variable empty only when that variable
is absent from the controller's (csd's own) environment; when the controller
has it, csd leaves it to inherit through tmux's normal environment:

| Variable(s) | csd behaviour |
|---|---|
| `CLAUDE_CODE_SSE_PORT` | always pinned empty (IDE-only) |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | pinned empty if absent from controller env; otherwise left to inherit |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_ANTHROPIC_AWS` / `_MANTLE` | pinned empty if absent from controller env; otherwise left to inherit |

"Pinned empty" uses `tmux -e VAR=`, which sets the variable to the empty string
(not unset). Claude Code's truthiness checks (`bH`) treat empty as false, so
empty is equivalent to unset for provider selection. csd applies the same
equivalence to the *controller's* value: a var that is empty in the controller's
env (e.g. a user who disabled Bedrock via `export CLAUDE_CODE_USE_BEDROCK=`) is
treated as absent and pinned empty, so a stale non-empty tmux-global value is
still overridden.

**Why clear-only and not force-propagate.** A provider selector or
`PROVIDER_MANAGED_BY_HOST` is useless — worse, actively breaking — without the
credentials it implies (the host auth token, AWS/Vertex creds). Those flow into
the worker through tmux's normal environment inheritance. If csd *forced* a
selector on via `-e` while the matching creds failed to reach the worker (e.g. a
stale tmux server lacking the controller's token), it would merely trade one
auth failure for another; and forwarding the secrets explicitly would put them
on the `tmux` command line (visible via `ps`). So selector and credentials must
travel together through the same inheritance channel — csd only ever removes a
stale selector that the controller is *not* using. This matches the
field-proven workaround in #18 (stop force-clearing `PROVIDER_MANAGED_BY_HOST`;
kill the stale `CLAUDE_CODE_USE_BEDROCK`).

See `tests/test-csd-provider-env.sh` for the behavioural coverage.
