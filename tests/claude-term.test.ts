import { describe, it, expect } from 'vitest';
// @ts-ignore plain JS server module
import { termEnv } from '../server/claude-term.mjs';

describe('embedded Claude Code environment', () => {
  it('drops studio API keys and inherited Claude Code session variables', () => {
    const env = termEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-bad', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_PATH: '/c' });
    expect(env.PATH).toBe('/bin'); expect(env.HOME).toBe('/h'); expect(env.CLAUDE_PATH).toBe('/c');
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION']) expect(env[k]).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
  });
  it('uses CLAUDE_TERM_API_KEY only when you set it', () => {
    expect(termEnv({ CLAUDE_TERM_API_KEY: 'sk-term', ANTHROPIC_API_KEY: 'sk-studio' }).ANTHROPIC_API_KEY).toBe('sk-term');
  });
});
