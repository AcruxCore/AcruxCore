// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewTab } from './PreviewTab';

afterEach(cleanup);

// Issue #534: every Preview input reached the template as a string, so a list variable
// showed `arr.join is not a function` and a `{% for %}` loop walked its characters.
describe('PreviewTab list and object variables', () => {
  it('passes a JSON list typed into a field to the template as a list', () => {
    render(createElement(PreviewTab, { draft: [{ role: 'user', content: 'Avoid: {{ xs | join(", ") }}.' }] }));

    fireEvent.change(screen.getByLabelText('xs'), { target: { value: '["age", "religion"]' } });

    expect(screen.getByText('Avoid: age, religion.')).toBeTruthy();
  });

  it('passes a JSON object, and loops over a list item by item', () => {
    const draft = [{ role: 'user' as const, content: '{{ user.name }}:{% for x in xs %} [{{ x }}]{% endfor %}' }];
    render(createElement(PreviewTab, { draft }));

    fireEvent.change(screen.getByLabelText('user'), { target: { value: '{"name": "Ada"}' } });
    fireEvent.change(screen.getByLabelText('xs'), { target: { value: '["a", "b"]' } });

    expect(screen.getByText('Ada: [a] [b]')).toBeTruthy();
  });

  it('keeps text that only looks like JSON as plain text', () => {
    render(createElement(PreviewTab, { draft: [{ role: 'user', content: 'Status: {{ s }}' }] }));

    fireEvent.change(screen.getByLabelText('s'), { target: { value: '[draft]' } });

    expect(screen.getByText('Status: [draft]')).toBeTruthy();
  });
});
