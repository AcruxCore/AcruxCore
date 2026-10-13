import { parseCandidates, parseCandidatesDetailed } from './optimize.parse';

it('parses valid candidates and drops template-broken ones', () => {
  const raw = JSON.stringify({ candidates: [
    { messages: [{ role: 'system', content: 'Answer about {{ name }} in third person' }], rationale: 'third person' },
    { messages: [{ role: 'system', content: 'broken {{ unclosed' }], rationale: 'x' },
  ]});
  const out = parseCandidates(raw, 3);
  expect(out.length).toBe(1);
  expect(out[0].rationale).toBe('third person');
});
it('caps to draftCount and returns [] on non-JSON', () => {
  expect(parseCandidates('nope', 3)).toEqual([]);
});

describe('Finding #17: variable-preservation enforcement', () => {
  it('drops a candidate whose rewrite omits a variable present in the original template', () => {
    const raw = JSON.stringify({ candidates: [
      { messages: [{ role: 'system', content: 'Answer about {{ name }}, be {{ tone }}' }], rationale: 'keeps both' },
      { messages: [{ role: 'system', content: 'Answer about {{ name }}' }], rationale: 'drops tone' },
    ]});
    const out = parseCandidates(raw, 3, ['name', 'tone']);
    expect(out.length).toBe(1);
    expect(out[0].rationale).toBe('keeps both');
  });

  it('drops a candidate that invents a variable not present in the original template', () => {
    const raw = JSON.stringify({ candidates: [
      { messages: [{ role: 'system', content: 'Answer about {{ name }}' }], rationale: 'matches' },
      { messages: [{ role: 'system', content: 'Answer about {{ name }} in {{ language }}' }], rationale: 'invents language' },
    ]});
    const out = parseCandidates(raw, 3, ['name']);
    expect(out.length).toBe(1);
    expect(out[0].rationale).toBe('matches');
  });

  it('is order-independent: a reordered but identical variable set still survives', () => {
    const raw = JSON.stringify({ candidates: [
      { messages: [{ role: 'system', content: '{{ tone }} note about {{ name }}' }], rationale: 'reordered' },
    ]});
    const out = parseCandidates(raw, 3, ['name', 'tone']);
    expect(out.length).toBe(1);
  });

  it('is skipped entirely when originalVariables is omitted (backward compatible)', () => {
    const raw = JSON.stringify({ candidates: [
      { messages: [{ role: 'system', content: 'Answer about {{ name }} in {{ language }}' }], rationale: 'no check' },
    ]});
    const out = parseCandidates(raw, 3);
    expect(out.length).toBe(1);
  });

  describe('parseCandidatesDetailed', () => {
    it('names the dropped variable when a rewrite returns only the system message', () => {
      // Regression: the optimizer prompt's shape example showed a single system
      // message, so the model copied it and omitted the user message holding
      // `{{ ticket }}`. All three candidates were then dropped and the run
      // failed as "produced no valid candidates" — indistinguishable, from the
      // outside, from the model returning garbage. It had returned good rewrites.
      const raw = JSON.stringify({
        candidates: [
          { messages: [{ role: 'system', content: 'Triage the ticket strictly by policy.' }], rationale: 'a' },
          { messages: [{ role: 'system', content: 'Follow the routing table.' }], rationale: 'b' },
        ],
      });
      const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['ticket']);

      expect(candidates).toHaveLength(0);
      expect(rejections).toHaveLength(2);
      expect(rejections[0]).toContain('candidate 1');
      expect(rejections[0]).toContain('dropped {{ ticket }}');
      expect(rejections[1]).toContain('candidate 2');
    });

    it('reports an invented variable separately from a dropped one', () => {
      const raw = JSON.stringify({
        candidates: [
          { messages: [{ role: 'user', content: '{{ ticket }} in {{ tone }}' }], rationale: 'invented tone' },
        ],
      });
      const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['ticket']);

      expect(candidates).toHaveLength(0);
      expect(rejections[0]).toContain('invented {{ tone }}');
      expect(rejections[0]).not.toContain('dropped');
    });

    it('returns no rejections when every candidate survives', () => {
      const raw = JSON.stringify({
        candidates: [
          {
            messages: [
              { role: 'system', content: 'Triage strictly by policy.' },
              { role: 'user', content: '{{ ticket }}' },
            ],
            rationale: 'complete array',
          },
        ],
      });
      const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['ticket']);

      expect(candidates).toHaveLength(1);
      expect(rejections).toEqual([]);
    });

    it('explains an unparseable optimizer response instead of returning a bare empty list', () => {
      const { candidates, rejections } = parseCandidatesDetailed('I cannot help with that.', 3, ['ticket']);

      expect(candidates).toHaveLength(0);
      expect(rejections[0]).toContain('no JSON object');
    });
  });

  describe('near-valid JSON from the optimizer is repaired rather than lost', () => {
    it("recovers from an illegal \\' escape, which cost a real run three good rewrites", () => {
      // Observed verbatim: the model wrote `customer\'s` inside a rationale.
      // `\'` is not in JSON's escape set, so JSON.parse rejected the whole
      // document and the run failed with valid candidates sitting in it.
      const raw =
        '{"candidates":[{"messages":[{"role":"system","content":"Triage strictly."},' +
        '{"role":"user","content":"{{ ticket }}"}],' +
        '"rationale":"Stops the customer\\\'s tone setting priority."}]}';

      expect(() => JSON.parse(raw)).toThrow();

      const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['ticket']);
      expect(rejections).toEqual([]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.rationale).toBe("Stops the customer's tone setting priority.");
    });

    it('recovers from a raw newline inside a rewritten template string', () => {
      const raw =
        '{"candidates":[{"messages":[{"role":"system","content":"Line one.\nLine two."},' +
        '{"role":"user","content":"{{ ticket }}"}],"rationale":"multiline"}]}';

      expect(() => JSON.parse(raw)).toThrow();

      const { candidates } = parseCandidatesDetailed(raw, 3, ['ticket']);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.messages[0]!.content).toBe('Line one.\nLine two.');
    });

    it('leaves already-valid JSON byte-identical, so the repair cannot change a good response', () => {
      const messages = [
        { role: 'system', content: 'Quote "this" and a path a/b and a tab\there.' },
        { role: 'user', content: '{{ ticket }}' },
      ];
      const raw = JSON.stringify({ candidates: [{ messages, rationale: 'untouched' }] });

      const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['ticket']);
      expect(rejections).toEqual([]);
      expect(candidates[0]!.messages).toEqual(messages);
    });

    it('still reports failure when the response is broken beyond escape repair', () => {
      const raw = '{"candidates":[{"messages":[{"role":"system",,,"content":"x"}]}]}';
      const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['ticket']);

      expect(candidates).toHaveLength(0);
      expect(rejections[0]).toContain('not valid JSON');
    });
  });
});

describe('a prompt that reads an image (issue #573)', () => {
  const rewrite = [
    { role: 'system', content: 'Read the receipt and answer in one line.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read this {{ kind }}.' },
        { type: 'image_url', image_url: { url: '{{ receipt_url }}' } },
      ],
    },
  ];

  it('keeps a candidate that rewrites the text and leaves the image part in place', () => {
    const raw = JSON.stringify({ candidates: [{ messages: rewrite, rationale: 'shorter' }] });

    const out = parseCandidates(raw, 3, ['kind', 'receipt_url']);

    expect(out).toHaveLength(1);
    expect(out[0]!.messages[1]!.content).toEqual(rewrite[1]!.content);
  });

  it('drops a candidate that loses the image variable', () => {
    const raw = JSON.stringify({
      candidates: [
        { messages: [rewrite[0], { role: 'user', content: 'Read this {{ kind }}.' }], rationale: 'drops the image' },
      ],
    });

    const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['kind', 'receipt_url']);

    expect(candidates).toHaveLength(0);
    expect(rejections[0]).toContain('dropped {{ receipt_url }}');
  });
});

describe('a rewrite must keep the image part where the model can see it', () => {
  const system = { role: 'system', content: 'Read the receipt and answer in one line.' };
  const imageUser = {
    role: 'user',
    content: [
      { type: 'text', text: 'Read this {{ kind }}.' },
      { type: 'image_url', image_url: { url: '{{ receipt_url }}' } },
    ],
  };

  it('drops a candidate that moves the image URL into a text part', () => {
    const raw = JSON.stringify({
      candidates: [
        { messages: [system, { role: 'user', content: 'Read this {{ kind }}: {{ receipt_url }}' }], rationale: 'inlined' },
      ],
    });

    const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['kind', 'receipt_url'], ['{{ receipt_url }}']);

    expect(candidates).toHaveLength(0);
    expect(rejections[0]).toContain('image');
  });

  it('drops a candidate that moves the image part into a system message', () => {
    const raw = JSON.stringify({
      candidates: [
        {
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'Read it.' }, { type: 'image_url', image_url: { url: '{{ receipt_url }}' } }] },
            { role: 'user', content: 'This is a {{ kind }}.' },
          ],
          rationale: 'moved',
        },
      ],
    });

    const { candidates, rejections } = parseCandidatesDetailed(raw, 3, ['kind', 'receipt_url'], ['{{ receipt_url }}']);

    expect(candidates).toHaveLength(0);
    expect(rejections[0]).toContain('user message');
  });

  it('keeps a candidate whose user message still holds the same image part', () => {
    const raw = JSON.stringify({ candidates: [{ messages: [system, imageUser], rationale: 'same image' }] });

    const { candidates } = parseCandidatesDetailed(raw, 3, ['kind', 'receipt_url'], ['{{ receipt_url }}']);

    expect(candidates).toHaveLength(1);
  });
});
