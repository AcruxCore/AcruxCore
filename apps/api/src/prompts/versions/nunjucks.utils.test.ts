import {
  extractVariables,
  renderMessages,
  loadNunjucksBrowserBundle,
  NunjucksParseError,
  NunjucksRenderError,
} from './nunjucks.utils';

describe('extractVariables', () => {
  it('extracts a simple variable', () => {
    expect(extractVariables([{ content: 'Hello {{ name }}' }])).toEqual(['name']);
  });

  it('extracts variable from a jinja if condition', () => {
    const result = extractVariables([{ content: "{% if role == 'admin' %}hi{% endif %}" }]);
    expect(result).toEqual(['role']);
  });

  it('extracts root of attribute access {{ user.name }} as "user"', () => {
    expect(extractVariables([{ content: '{{ user.name }}' }])).toEqual(['user']);
  });

  it('deduplicates and sorts variables across multiple messages', () => {
    const msgs = [
      { content: '{{ task }} and {{ name }}' },
      { content: '{{ name }} again' },
    ];
    expect(extractVariables(msgs)).toEqual(['name', 'task']);
  });

  it('returns empty array for content with no variables', () => {
    expect(extractVariables([{ content: 'Hello world' }])).toEqual([]);
  });

  it('throws NunjucksParseError for invalid nunjucks syntax', () => {
    expect(() => extractVariables([{ content: '{{ unclosed' }])).toThrow(NunjucksParseError);
  });

  it('excludes a {% for %} loop-bound name, keeping only the iterated source', () => {
    const result = extractVariables([
      { content: '{% for item in items %}{{ item.name }}{% endfor %}' },
    ]);
    expect(result).toEqual(['items']);
  });

  it('excludes both destructured loop-bound names ({% for k, v in items %})', () => {
    const result = extractVariables([
      { content: '{% for key, value in items %}{{ key }}: {{ value }}{% endfor %}' },
    ]);
    expect(result).toEqual(['items']);
  });

  it('excludes a {% set %} target from extracted variables', () => {
    const result = extractVariables([
      { content: '{% set greeting = "hi" %}{{ greeting }} {{ name }}' },
    ]);
    expect(result).toEqual(['name']);
  });

  it('still requires a name that another message happens to bind with {% set %} (issue #503)', () => {
    // Each message is rendered as its OWN template (renderInSandbox calls
    // renderString once per message), so the `{% set %}` below has no scope in
    // the system message. Treating bound names as global made `company` vanish
    // from the required list, and the render then filled it with ''.
    const result = extractVariables([
      { content: 'You are support for {{ company }}. Greet {{ name }}.' },
      { content: '{% set company = "OtherCo" %}Ticket for {{ company }}.' },
    ]);
    expect(result).toEqual(['company', 'name']);
  });

  it('still requires a name that another message happens to bind as a {% for %} target (issue #503)', () => {
    const result = extractVariables([
      { content: 'Reply to {{ ticket }}.' },
      { content: '{% for ticket in tickets %}{{ ticket.id }}{% endfor %}' },
    ]);
    expect(result).toEqual(['ticket', 'tickets']);
  });

  it('extracts the outer variable referenced by a loop source alongside attribute access in its body', () => {
    // Regression case from issue #256: a support-triage prompt looping over
    // tickets and reading each ticket's fields must only require `tickets`.
    const result = extractVariables([
      {
        content:
          '{% for ticket in tickets %}- #{{ ticket.id }}: {{ ticket.title }}\n{% endfor %}',
      },
    ]);
    expect(result).toEqual(['tickets']);
  });

  // Scope is per BLOCK, not per message. `{% for %}` binds its target over its own body
  // and nowhere else, so these three shapes all describe a real input (issue #503).
  it('still requires a name used BEFORE the loop that rebinds it', () => {
    // A greeting that names the customer, above a loop over their orders — the common
    // shape. `item` was dropped from the required list, MISSING_VARIABLES stayed silent,
    // and the greeting rendered as "Hello .".
    const result = extractVariables([
      { content: 'Hello {{ item }}. {% for item in items %}{{ item }}{% endfor %}' },
    ]);
    expect(result).toEqual(['item', 'items']);
  });

  it('still requires a name used AFTER the loop that bound it', () => {
    const result = extractVariables([
      { content: '{% for item in items %}{{ item }}{% endfor %} Bye {{ item }}.' },
    ]);
    expect(result).toEqual(['item', 'items']);
  });

  it('still requires a loop target referenced in the {% else %} branch', () => {
    // `{% else %}` runs precisely when the sequence was empty, so nothing is bound there.
    const result = extractVariables([
      { content: '{% for i in xs %}{{ i }}{% else %}{{ i }}{% endfor %}' },
    ]);
    expect(result).toEqual(['i', 'xs']);
  });

  it('scopes a nested loop to its own body', () => {
    const result = extractVariables([
      { content: '{% for a in xs %}{% for b in a.ys %}{{ b }}{{ c }}{% endfor %}{{ a }}{% endfor %}' },
    ]);
    expect(result).toEqual(['c', 'xs']);
  });

  it('treats a macro parameter as local to the macro body only', () => {
    const result = extractVariables([
      { content: '{% macro m(p) %}{{ p }}{{ outer }}{% endmacro %}{{ p }}' },
    ]);
    expect(result).toEqual(['outer', 'p']);
  });

  it('still requires the value a {% set %} reads, and a name referenced above it', () => {
    const result = extractVariables([{ content: '{{ total }}{% set total = price %}{{ total }}' }]);
    expect(result).toEqual(['price', 'total']);
  });
});

describe('renderMessages', () => {
  it('renders variables into message content', async () => {
    const result = await renderMessages(
      [{ role: 'system', content: 'Hello {{ name }}' }],
      { name: 'Alice' },
    );
    expect(result).toEqual([{ role: 'system', content: 'Hello Alice' }]);
  });

  it('renders conditional blocks correctly', async () => {
    const result = await renderMessages(
      [{ role: 'user', content: "{% if is_admin %}Admin{% else %}User{% endif %}" }],
      { is_admin: true },
    );
    expect(result[0].content).toBe('Admin');
  });

  it('leaves a cross-message {% set %} out of another message\'s scope (issue #503)', async () => {
    const result = await renderMessages(
      [
        { role: 'system', content: 'You are support for {{ company }}.' },
        { role: 'user', content: '{% set company = "OtherCo" %}Ticket for {{ company }}.' },
      ],
      { company: 'Acme' },
    );
    expect(result[0]!.content).toBe('You are support for Acme.');
    expect(result[1]!.content).toBe('Ticket for OtherCo.');
  });

  it('fills a pre-loop reference the extractor used to drop (issue #503)', async () => {
    // The user-visible symptom: with `item` absent from the required list there is no
    // value to supply, so nunjucks rendered the greeting as "Hello .".
    const content = 'Hello {{ item }}. {% for item in items %}{{ item }}{% endfor %}';
    const rendered = await renderMessages([{ role: 'user', content }], { item: 'Ada', items: ['i1'] });
    expect(rendered[0]!.content).toBe('Hello Ada. i1');
  });

  it('throws NunjucksRenderError on runtime render failure', async () => {
    // Calling an undefined filter is a runtime error
    await expect(
      renderMessages([{ role: 'user', content: '{{ name | unknownFilter }}' }], { name: 'x' }),
    ).rejects.toThrow(NunjucksRenderError);
  });

  it('does not execute arbitrary JavaScript via a constructor-chain SSTI payload', async () => {
    // Proof-of-concept RCE payload: walks String -> Function via the prototype
    // chain and calls Function("return process.version"). Against an
    // unsandboxed nunjucks Environment this returns the real Node version
    // string; sandboxed, `process` does not exist in the isolate's global
    // scope, so this must reject instead of leaking anything.
    const payload = '{{ "".constructor.constructor("return process.version")() }}';
    await expect(renderMessages([{ role: 'system', content: payload }], {})).rejects.toThrow(
      NunjucksRenderError,
    );
  });

  it('rejects a constructor-chain infinite loop within the render timeout instead of hanging', async () => {
    // Same escape as above, but the generated function body is an infinite
    // loop instead of a data leak — proves the sandbox enforces a wall-clock
    // timeout, not just a missing-global failure.
    const payload = '{{ "".constructor.constructor("while(true){}")() }}';
    await expect(renderMessages([{ role: 'system', content: payload }], {})).rejects.toThrow(
      NunjucksRenderError,
    );
  }, 10_000);

  it('renders a large batch of legitimate messages without hitting the render timeout', async () => {
    // Regression test: the render timeout used to be applied once to the
    // WHOLE batch (a single compiled script rendering every template via
    // .map()), so a big-but-legitimate batch of messages could cumulatively
    // exceed the 250ms budget and fail even though nothing was malicious or
    // slow. Each message here is a small, fast, ordinary template — 120 of
    // them, well past what a single 250ms budget could cover if it were
    // still shared across the batch.
    const messages = Array.from({ length: 120 }, (_, i) => ({
      role: 'user' as const,
      content: `Message #${i}: hello {{ name }}, your task is {{ task }}.`,
    }));

    const result = await renderMessages(messages, { name: 'Alice', task: 'reviewing PRs' });

    expect(result).toHaveLength(120);
    expect(result[0]!.content).toBe('Message #0: hello Alice, your task is reviewing PRs.');
    expect(result[119]!.content).toBe('Message #119: hello Alice, your task is reviewing PRs.');
  });

  it('renders a legitimate loop over a reasonably large array without hitting the render timeout', async () => {
    const items = Array.from({ length: 500 }, (_, i) => `item-${i}`);
    const payload = '{% for item in items %}{{ item }},{% endfor %}';

    const result = await renderMessages([{ role: 'user', content: payload }], { items });

    expect(result[0]!.content).toBe(items.map((item) => `${item},`).join(''));
  });

  it('still bounds a single runaway template to its own timeout when packed into a large batch of legitimate ones', async () => {
    // Proves timeouts are per-template, not shared: a malicious template
    // can't "hide" inside a big batch and inherit extra time from its
    // neighbors — nor does its slowness eat into their budget.
    const legitimateBefore = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Hello {{ name }} #${i}`,
    }));
    const runaway = {
      role: 'system' as const,
      content: '{{ "".constructor.constructor("while(true){}")() }}',
    };
    const legitimateAfter = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Goodbye {{ name }} #${i}`,
    }));

    await expect(
      renderMessages([...legitimateBefore, runaway, ...legitimateAfter], { name: 'Alice' }),
    ).rejects.toThrow(NunjucksRenderError);
  }, 10_000);
});

describe('loadNunjucksBrowserBundle', () => {
  it('loads the real nunjucks browser bundle from its resolved path', () => {
    const bundle = loadNunjucksBrowserBundle();
    expect(bundle.length).toBeGreaterThan(0);
    expect(bundle).toContain('nunjucks');
  });

  it('throws a clear, descriptive error when the bundle path does not exist', () => {
    // Simulates the real failure mode this refactor guards against: a
    // missing/relocated bundle file (e.g. a nunjucks version bump changing
    // the browser-bundle path, or a production install step pruning
    // non-`main`-field files) must fail with an actionable message instead
    // of an opaque, uncaught ENOENT crashing server startup.
    expect(() => loadNunjucksBrowserBundle('/nonexistent/path/nunjucks.js')).toThrow(
      /Failed to load bundled nunjucks browser runtime for sandboxed template rendering/,
    );
  });
});
