# Windows hooks: issue #15 is resolved

**Issue #15** ("hooks don't fire on Windows") is fixed by the TypeScript rewrite.

## The problem

The old `csd` lifecycle hooks were bash scripts that shelled out to `jq`. On
Windows, the PATH Claude Code exposes to its hook subprocess did not include
`bash` or `jq`, so the hook command silently failed — workers never emitted
events, and the controller could not observe them. The repo carried a
`run-hook.cmd` polyglot wrapper (a file that is simultaneously a valid `.cmd`
batch script and a shell script) to try to bridge the two worlds.

## The fix

The hooks are now **node programs** (`dist/emit-event.cjs`), invoked directly as
`node "${CLAUDE_PLUGIN_ROOT}/dist/emit-event.cjs"` from `hooks/hooks.json`. Node
is inherently cross-platform and is already present wherever Claude Code runs, so
there is no `bash`/`jq`-on-PATH requirement to satisfy. Consequently:

- The `run-hook.cmd` polyglot wrapper is **no longer needed** and has been
  removed.
- The bash `emit-event` hook and its `_lib.sh` helper are gone.
- `jq` is no longer a dependency of the plugin.

The same node hook bundle serves both the Claude and Codex harnesses (Pi uses a
native TypeScript extension instead of hooks). No Windows-specific code path is
required for hooks to fire — being a node program is the whole fix.
