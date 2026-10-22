import { describe, expect, it } from 'vitest';
import { formatMessages } from './format-messages';

describe('formatMessages', () => {
  it('marks a message that carries a prompt-cache marker, so two versions differing only there do not read as identical', () => {
    const plain = formatMessages([{ role: 'system', content: 'Be brief.' }]);
    const cached = formatMessages([{ role: 'system', content: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
    expect(cached).toBe('[system · cached]\nBe brief.');
    expect(plain).not.toBe(cached);
  });
});
