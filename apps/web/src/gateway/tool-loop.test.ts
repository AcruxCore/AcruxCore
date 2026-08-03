import { describe, it, expect } from 'vitest';
import { nextLoopStep, appendToolResults, MAX_TOOL_ITERATIONS } from './tool-loop';
import type { ChatMessage, ChatCompletionChoice } from '@/api/types';

const choiceWithCalls = (calls: { id: string; name: string; args: string }[]): ChatCompletionChoice => ({
  index: 0,
  message: { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) },
  finish_reason: 'tool_calls',
});

describe('tool-loop', () => {
  it('detects tool calls and returns them as pending', () => {
    const step = nextLoopStep([{ role: 'user', content: 'hi' }], choiceWithCalls([{ id: 'c1', name: 'get_weather', args: '{"city":"Paris"}' }]));
    expect(step.done).toBe(false);
    expect(step.pendingCalls).toEqual([{ id: 'c1', name: 'get_weather', arguments: { city: 'Paris' } }]);
  });
  it('marks the step done when finish_reason is not tool_calls', () => {
    const step = nextLoopStep([{ role: 'user', content: 'hi' }], { index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' });
    expect(step.done).toBe(true);
    expect(step.pendingCalls).toHaveLength(0);
  });
  it('appends the assistant tool_calls message + one tool message per result', () => {
    const base: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const assistant: ChatMessage = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] };
    const out = appendToolResults(base, assistant, [{ toolCallId: 'c1', content: '{"tempC":18}' }]);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual(assistant);
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"tempC":18}' });
  });
  it('caps iterations at 10', () => { expect(MAX_TOOL_ITERATIONS).toBe(10); });
});
