import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import { hydrateToolResultsFromTrace, normalizeSessionHistory } from './session-history.js';

describe('session-history', () => {
  it('hydrates missing toolResults from trace entries', () => {
    const session: SessionSnapshot = {
      id: 's1',
      createdAt: 0,
      updatedAt: 0,
      deviceState: createEmptyDeviceState(),
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          createdAt: 1,
          toolCalls: [{ id: 'call-1', name: 'stop', args: { channel: 'A' } }],
        },
      ],
    };

    const changed = hydrateToolResultsFromTrace(session, [
      {
        id: 'trace-1',
        createdAt: 1,
        kind: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'stop',
        output: '{"ok":true}',
      },
    ]);

    expect(changed).toBe(true);
    expect(session.messages[0]?.toolResults?.[0]?.output).toBe('{"ok":true}');
  });

  it('keeps assistant messages with complete tool rounds during normalize', () => {
    const session: SessionSnapshot = {
      id: 's1',
      createdAt: 0,
      updatedAt: 0,
      deviceState: createEmptyDeviceState(),
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          createdAt: 1,
          toolCalls: [{ id: 'call-1', name: 'stop', args: { channel: 'A' } }],
        },
        {
          id: 'a2',
          role: 'assistant',
          content: '',
          createdAt: 2,
          toolCalls: [{ id: 'call-1', name: 'stop', args: { channel: 'A' } }],
          toolResults: [{ callId: 'call-1', output: '{"ok":true}' }],
        },
      ],
    };

    expect(normalizeSessionHistory(session)).toBe(true);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.toolResults?.[0]?.output).toBe('{"ok":true}');
  });
});
