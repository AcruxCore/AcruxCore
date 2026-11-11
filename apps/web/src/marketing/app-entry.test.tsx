// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NEXT } from '@/auth/next-param';

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('@/auth/auth-context-core', () => ({ useOptionalAuth: () => ({ isAuthenticated: true }) }));
vi.mock('./LandingPage', () => ({ LandingPage: () => <p>landing</p> }));

const { RootRoute } = await import('./RootRoute');
const { MarketingHeader } = await import('./marketing-chrome');

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

// A signed-in user entering the app from the marketing site goes where sign-in sends
// them: Get started, which passes a fully set-up team on to its prompts.
describe('entering the app from the marketing site', () => {
  it('"Go to app" links to the post-sign-in destination', () => {
    render(<MemoryRouter><MarketingHeader /></MemoryRouter>);
    expect(screen.getAllByRole('link', { name: 'Go to app' })[0].getAttribute('href')).toBe(DEFAULT_NEXT);
  });

  it('a signed-in visit to / redirects to the post-sign-in destination', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe(DEFAULT_NEXT);
  });
});
