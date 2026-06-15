/**
 * Shell-quoting utilities. Two functions with INTENTIONALLY DIFFERENT semantics:
 *
 *   shellQuote        – safe tokens pass through unquoted (for human-readable
 *                       reproduce lines where readability matters).
 *   shellQuoteAlways  – always wraps in single quotes (for args baked into a
 *                       string another shell will re-evaluate, e.g. a hook command
 *                       stored in a config file — a fast path would be unsafe there
 *                       because the outer string is later re-parsed by a shell).
 *
 * Keep both exported here so a future consolidation attempt is blocked by the
 * tests in tests/shell.test.ts, which pin the behavioral difference.
 */

/**
 * Shell-quote a single token for a human-readable reproduce line. A simplified
 * port of bash `printf %q`: tokens of only safe characters pass through
 * unquoted; anything else is wrapped in single quotes (with embedded single
 * quotes escaped the `'\''` way). The goal is a copy-pasteable command, not
 * byte parity with %q.
 *
 * Safe for: terminal output, log messages, reproduce lines.
 * NOT safe for: baking into a string another shell will re-evaluate (use
 * `shellQuoteAlways` there — `=` and other chars can survive unquoted in the
 * current shell but break when re-parsed in a sub-shell context).
 */
export function shellQuote(token: string): string {
  if (token === '') return "''";
  if (/^[A-Za-z0-9_./:=@-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/**
 * Always single-quote-wrap a token (POSIX `'\''` escaping for embedded single
 * quotes). No fast path — every token, including "safe" alphanumeric ones, is
 * wrapped in single quotes.
 *
 * Use when the result is embedded in a string another shell will re-evaluate
 * (e.g. a hook `command` baked into a TOML config file that codex later
 * shell-executes). A fast path would be unsafe there: a token like `--env=VAL`
 * passes through unquoted but may be misinterpreted when the surrounding
 * quoted string is re-parsed.
 */
export function shellQuoteAlways(token: string): string {
  return `'${token.replaceAll("'", "'\\''")}'`;
}
