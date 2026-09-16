import { describe, expect, it } from 'vitest';
import { extractVariables, renderMessages } from './template';

describe('extractVariables', () => {
  // The Preview renders each message as its own template (`renderMessages`
  // calls `renderString` once per message), so a `{% set %}` or `{% for %}`
  // target in one message has no scope in any other. Treating the messages as
  // one joined blob dropped the name from the Variables form, leaving the
  // message that genuinely needed it with no field and a blank render
  // (issue #503, the same bug the API had in `nunjucks.utils.ts`).
  it('does not let a `set` in one message hide the same name in another', () => {
    const vars = extractVariables([
      { role: 'system', content: 'You are support for {{ company }}. Greet {{ name }}.' },
      { role: 'user', content: '{% set company = "OtherCo" %}Ticket for {{ company }}.' },
    ]);

    expect(vars).toEqual(['company', 'name']);
  });

  it('does not let a `for` target in one message hide the same name in another', () => {
    const vars = extractVariables([
      { role: 'system', content: 'The topic is {{ item }}.' },
      { role: 'user', content: '{% for item in items %}{{ item }}{% endfor %}' },
    ]);

    expect(vars).toEqual(['item', 'items']);
  });

  it('still treats a binding as local within the message that binds it', () => {
    const vars = extractVariables([
      { role: 'user', content: '{% set greeting = "hi" %}{{ greeting }} {{ name }}' },
    ]);

    expect(vars).toEqual(['name']);
  });

  // Scope is per BLOCK as well as per message. `{% for %}` binds its target over its
  // own body and nowhere else, so a name used before the loop, after `{% endfor %}`, or
  // in the `{% else %}` branch is a real input that needs its own field.
  it('keeps a name used before the loop that later rebinds it', () => {
    const vars = extractVariables([
      { role: 'user', content: 'Hello {{ item }}. {% for item in items %}{{ item }}{% endfor %}' },
    ]);

    expect(vars).toEqual(['item', 'items']);
  });

  it('keeps a name used after the loop that bound it', () => {
    const vars = extractVariables([
      { role: 'user', content: '{% for item in items %}{{ item }}{% endfor %} Bye {{ item }}.' },
    ]);

    expect(vars).toEqual(['item', 'items']);
  });

  it('keeps a loop target referenced in the else branch, where nothing is bound', () => {
    const vars = extractVariables([
      { role: 'user', content: '{% for i in xs %}{{ i }}{% else %}{{ i }}{% endfor %}' },
    ]);

    expect(vars).toEqual(['i', 'xs']);
  });

  it('still treats a loop target as local inside the loop body', () => {
    const vars = extractVariables([
      { role: 'user', content: '{% for item in items %}{{ item }}{{ prefix }}{% endfor %}' },
    ]);

    expect(vars).toEqual(['items', 'prefix']);
  });

  it('leaves the other messages their fields while one is half-typed', () => {
    const vars = extractVariables([
      { role: 'system', content: 'Greet {{ name }}.' },
      { role: 'user', content: '{% for x in ' },
    ]);

    expect(vars).toEqual(['name']);
  });

  it('renders blank for a variable the old flat scope dropped', () => {
    // The symptom the fix removes: with `item` missing from the form there is no field
    // to fill, and nunjucks renders the reference as an empty string.
    const rendered = renderMessages(
      [{ role: 'user', content: 'Hello {{ item }}. {% for item in items %}{{ item }}{% endfor %}' }],
      { item: 'Ada', items: ['i1'] },
    );

    expect(rendered[0].content).toBe('Hello Ada. i1');
  });

  it('renders each message independently, which is why the scope is per message', () => {
    const rendered = renderMessages(
      [
        { role: 'system', content: 'Support for {{ company }}.' },
        { role: 'user', content: '{% set company = "OtherCo" %}Ticket for {{ company }}.' },
      ],
      { company: 'Acme' },
    );

    expect(rendered[0].content).toBe('Support for Acme.');
    expect(rendered[1].content).toBe('Ticket for OtherCo.');
  });
});
