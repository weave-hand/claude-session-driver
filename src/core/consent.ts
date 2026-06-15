import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function consentPath(home: string): string {
  return `${home}/.claude/.claude-session-driver-consent`;
}

export function hasConsent(home: string): boolean {
  return existsSync(consentPath(home));
}

export function grantConsent(home: string): void {
  const p = consentPath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
}
