/**
 * Canonicalize a harness tool name to the capitalized convention claude and
 * codex use (`Bash`, `Read`), so a cross-harness `read-events`/`read-turn`
 * tool-name filter agrees across the fleet. Pi reports its built-ins lowercase
 * (`bash`, `read`); title-casing the first letter aligns them. Empty stays
 * empty; everything past the first letter is left untouched (custom tool names
 * pass through).
 */
export function canonicalToolName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) return '';
  return name.charAt(0).toUpperCase() + name.slice(1);
}
