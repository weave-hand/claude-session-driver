import { consentPath, grantConsent, hasConsent } from '../core/consent.js';
import type { CommandContext, CommandResult } from './context.js';

const PREAMBLE = `claude-session-driver runs workers with --dangerously-skip-permissions.
Workers execute tool calls without prompting. By granting consent, you
acknowledge this risk and accept responsibility for any actions the
worker takes.

Type 'yes' to grant consent:`;

export interface GrantConsentOpts {
  /** Called after the preamble is displayed. Return true if the user typed 'yes'. */
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

  const confirmed = await opts.confirm();
  if (!confirmed) {
    return {
      stdout: PREAMBLE,
      stderr: 'Consent not granted.',
      code: 1,
    };
  }

  grantConsent(ctx.home);
  return {
    stdout: `${PREAMBLE}\nConsent granted. Written: ${path}`,
    code: 0,
  };
}
