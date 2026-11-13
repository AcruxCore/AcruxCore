import { describe, expect, it } from 'vitest';
import { extractVariables } from './template';

describe('extractVariables', () => {
  // The Preview renders each message as its own template (the server's render
  // runs one template per message), so a `{% set %}` or `{% for %}`
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

  // A filter is part of the template language, not an input. `join` and `upper` must not
  // get a Variables field of their own, but a variable passed as a filter argument must.
  it('does not offer a field for a filter name', () => {
    const vars = extractVariables([
      { role: 'system', content: 'Avoid {{ groups | join(", ") }}. {{ tone | upper }}' },
      { role: 'user', content: '{{ name | replace("x", sep) }}{% filter upper %}{{ body }}{% endfilter %}' },
    ]);

    expect(vars).toEqual(['body', 'groups', 'name', 'sep', 'tone']);
  });

  it('leaves the other messages their fields while one is half-typed', () => {
    const vars = extractVariables([
      { role: 'system', content: 'Greet {{ name }}.' },
      { role: 'user', content: '{% for x in ' },
    ]);

    expect(vars).toEqual(['name']);
  });
});
