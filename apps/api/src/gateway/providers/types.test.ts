import type {
  ChatMessage,
  NormalizedRequest,
  Usage,
  NormalizedResponse,
  ProviderCredentials,
  StreamChunk,
} from './types';

describe('canonical provider types compile with the expected shapes', () => {
  it('constructs each type', () => {
    const msg: ChatMessage = { role: 'user', content: 'hi' };
    const req: NormalizedRequest = { model: 'gpt-4o-mini', messages: [msg], temperature: 0.7, max_tokens: 50 };
    const usage: Usage = { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 };
    const res: NormalizedResponse = {
      id: 'chatcmpl-1',
      model: 'gpt-4o-mini',
      object: 'chat.completion',
      created: 1751536800,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage,
    };
    const creds: ProviderCredentials = { apiKey: 'sk-x', baseUrl: 'https://api.groq.com/openai/v1' };
    const chunk: StreamChunk = { delta: 'Hi', finish_reason: null };

    expect(req.messages[0]?.content).toBe('hi');
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(usage.total_tokens).toBe(13);
    expect(creds.apiKey).toBe('sk-x');
    expect(chunk.finish_reason).toBeNull();
  });
});
