// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SpanTools } from './SpanTools';

afterEach(cleanup);

describe('SpanTools', () => {
  it('shows tool_choice for a call that sent an empty tools list', () => {
    render(createElement(SpanTools, { tools: [], toolChoice: 'none' }));
    expect(screen.getByTestId('span-tool-choice').textContent).toBe('tool_choice: none');
    expect(screen.getByText('Tools sent to the model (0)')).toBeTruthy();
  });

  it('renders nothing when neither tools nor tool_choice were sent', () => {
    const { container } = render(createElement(SpanTools, { tools: undefined, toolChoice: null }));
    expect(container.innerHTML).toBe('');
  });
});
