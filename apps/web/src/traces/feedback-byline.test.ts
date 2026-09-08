import { describe, expect, it } from 'vitest';
import { feedbackByline } from './format';

describe('feedbackByline', () => {
  it('names the member behind a developer row, so two reviewers are told apart', () => {
    expect(feedbackByline('developer', { name: 'Ada', email: 'ada@example.com' })).toBe('Developer · Ada');
  });

  it('falls back to the email when the member never set a display name', () => {
    expect(feedbackByline('developer', { name: null, email: 'ada@example.com' })).toBe(
      'Developer · ada@example.com',
    );
  });

  it('shows the bare source when no user sits behind the row (team key or end user)', () => {
    expect(feedbackByline('end_user', null)).toBe('End user');
    expect(feedbackByline('api', null)).toBe('API');
  });

  it('passes an unrecognised source through rather than blanking the byline', () => {
    expect(feedbackByline('webhook', null)).toBe('webhook');
    expect(feedbackByline('webhook', { name: 'Ada', email: 'ada@example.com' })).toBe('webhook · Ada');
  });
});
