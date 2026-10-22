import { execSync } from 'node:child_process';

/**
 * The wallet's password for a command an MCP client starts: the output of
 * --password-command (a keychain entry that asks you, ideally), or
 * OPAQUE_PASSWORD, which is then taken out of this process's environment so
 * nothing it starts inherits it. Undefined: ask at the terminal.
 */
export function takePassword(env: Record<string, string | undefined>, command: string | undefined, run = (c: string) => execSync(c, { encoding: 'utf8' })): string | undefined {
  const fromEnv = env['OPAQUE_PASSWORD'];
  delete env['OPAQUE_PASSWORD'];
  return command !== undefined ? run(command).trim() : fromEnv;
}
