// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT_COUNT, DraftCountField } from './DraftCountField';

afterEach(cleanup);

describe('DraftCountField', () => {
  it('offers 1 to 6, marks the server default, and reports the pick as a number', () => {
    const onChange = vi.fn();
    render(createElement(DraftCountField, { id: 'drafts', value: DEFAULT_DRAFT_COUNT, onChange }));

    const select = screen.getByLabelText('Number of rewrites') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(select.value).toBe('3');
    expect(screen.getByRole('option', { name: '3 (default)' })).toBeTruthy();

    fireEvent.change(select, { target: { value: '1' } });
    expect(onChange).toHaveBeenCalledWith(1);
  });
});
