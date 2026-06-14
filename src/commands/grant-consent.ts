import { consentPath, grantConsent, hasConsent } from '../core/consent.js';
import type { CommandContext, CommandResult } from './context.js';

const PREAMBLE = `claude-session-driver runs workers with --dangerously-skip-permissions.
Workers execute tool calls without prompting. By granting consent, you
acknowledge this risk and accept responsibility for any actions the
worker takes.`;

export interface GrantConsentOpts {
  /**
   * Emit the risk warning to the user. Called BEFORE `confirm` so the user sees
   * the full warning before being asked to type 'yes' (bash prints the heredoc,
   * THEN reads). Defaults to a no-op for callers that do not surface it.
   */
  warn?: (text: string) => void;
  /** Called after the warning is displayed. Return true if the user typed 'yes'. */
  confirm: () => Promise<boolean>;
}

export async function cmdGrantConsent(
  ctx: CommandContext,
  opts: GrantConsentOpts,
): Promise<CommandResult> {
  const path = consentPath(ctx.home);

  if (hasConsent(ctx.home)) {
    return { stdout: `Consent already granted at ${path}`, code: 0 };
  }

  // Show the risk warning BEFORE prompting, matching bash (heredoc, then read).
  opts.warn?.(PREAMBLE);

  const confirmed = await opts.confirm();
  if (!confirmed) {
    return {
      stderr: 'Consent not granted.',
      code: 1,
    };
  }

  grantConsent(ctx.home);
  return {
    stdout: `Consent granted. Written: ${path}`,
    code: 0,
  };
}
