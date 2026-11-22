// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonTree } from './JsonTree';

afterEach(cleanup);

describe('JsonTree with a large output', () => {
  it('scrolls inside a bounded box', () => {
    render(createElement(JsonTree, { value: { a: 1 } }));
    expect(screen.getByTestId('json-tree').className).toMatch(/max-h-\S+/);
    expect(screen.getByTestId('json-tree').className).toContain('overflow-auto');
  });

  it('draws the first 100 items of a 5,000-row list, then more on request', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
    render(createElement(JsonTree, { value: rows }));
    const items = () => screen.getByTestId('json-tree').querySelectorAll('[data-json-depth="1"]').length;
    expect(items()).toBe(100);
    fireEvent.click(screen.getByText('Show 100 more of 4,900'));
    expect(items()).toBe(200);
  });
});
