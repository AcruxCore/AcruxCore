import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  parseImportFile,
  rowsFromCsv,
  rowsFromJson,
  rowsFromJsonl,
  SAMPLE_CSV,
  SAMPLE_JSON,
} from './dataset-import';

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, newlines inside quotes, CRLF and a BOM', () => {
    const text = '﻿a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['line1\nline2', 'z'],
    ]);
  });

  it('keeps a trailing empty field', () => {
    expect(parseCsv('a,b\n1,')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });
});

describe('rowsFromCsv', () => {
  it('turns every column into a variable except criteria', () => {
    const result = rowsFromCsv('question,tier,Criteria\nHow long?,free,Says 30 days\nHi,pro,\n');
    expect(result.issues).toEqual([]);
    expect(result.variables).toEqual(['question', 'tier']);
    expect(result.rows).toEqual([
      { input: { question: 'How long?', tier: 'free' }, criteria: 'Says 30 days' },
      // Blank criteria means "none", not an empty rubric.
      { input: { question: 'Hi', tier: 'pro' } },
    ]);
  });

  it('reports a row with the wrong column count by its row number, and keeps the rest', () => {
    const result = rowsFromCsv('question,criteria\nok,c\nbroken\nok2,c2\n');
    expect(result.rows).toHaveLength(2);
    expect(result.rowNumbers).toEqual([1, 3]);
    expect(result.issues).toEqual([{ row: 2, message: 'has 1 column, the header has 2.' }]);
  });

  it('rejects a header with a repeated column', () => {
    const result = rowsFromCsv('q,q\n1,2\n');
    expect(result.rows).toEqual([]);
    expect(result.issues[0].message).toMatch(/repeats a column name: q/);
  });

  it('flags a file whose only column is criteria', () => {
    const result = rowsFromCsv('criteria\nsomething\n');
    expect(result.issues).toEqual([{ row: 1, message: 'has no input variables.' }]);
  });

  it('flags an oversized input', () => {
    const result = rowsFromCsv(`q\n${'x'.repeat(9000)}\n`);
    expect(result.rows).toEqual([]);
    expect(result.issues[0].message).toMatch(/larger than 8192 bytes/);
  });
});

describe('rowsFromJson', () => {
  it('reads the API shape, history included', () => {
    const result = rowsFromJson(SAMPLE_JSON);
    expect(result.issues).toEqual([]);
    expect(result.rows[1]).toEqual({
      input: { question: 'And for annual plans?' },
      criteria: 'Quotes the 14-day refund window for annual plans.',
      history: [
        { role: 'user', content: 'Can I get a refund?' },
        { role: 'assistant', content: 'Yes, within 30 days.' },
      ],
    });
  });

  it('reads flat objects, where every key but criteria and history is a variable', () => {
    const result = rowsFromJson('[{"category":"policy","question":"How long?","criteria":"30 days"}]');
    expect(result.rows).toEqual([{ input: { category: 'policy', question: 'How long?' }, criteria: '30 days' }]);
  });

  it('treats a string "input" key as a plain variable, not the API shape', () => {
    const result = rowsFromJson('[{"input":"raw text"}]');
    expect(result.rows).toEqual([{ input: { input: 'raw text' } }]);
  });

  it('accepts the bulk request body { examples: [...] }', () => {
    const result = rowsFromJson('{"examples":[{"input":{"q":"a"}}]}');
    expect(result.rows).toEqual([{ input: { q: 'a' } }]);
  });

  it('reports bad items by their 1-based position', () => {
    const result = rowsFromJson('[{"q":"a"}, 5, {"q":"b","criteria":3}]');
    expect(result.rows).toHaveLength(1);
    expect(result.issues).toEqual([
      { row: 2, message: 'is not a JSON object.' },
      { row: 3, message: 'criteria must be a string.' },
    ]);
  });

  it('says so when the file is not JSON or not a list', () => {
    expect(rowsFromJson('{oops').issues[0].message).toMatch(/not valid JSON/);
    expect(rowsFromJson('{"q":"a"}').issues[0].message).toMatch(/Expected a JSON array/);
  });
});

describe('rowsFromJsonl', () => {
  it('reads one object per line and names the bad line', () => {
    const result = rowsFromJsonl('{"q":"a"}\n\nnot json\n{"q":"b"}\n');
    expect(result.rows).toEqual([{ input: { q: 'a' } }, { input: { q: 'b' } }]);
    expect(result.issues).toEqual([{ row: 3, message: 'is not valid JSON.' }]);
  });
});

describe('parseImportFile', () => {
  it('picks the parser from the extension, then from the content', () => {
    expect(parseImportFile('set.csv', SAMPLE_CSV).rows).toHaveLength(2);
    expect(parseImportFile('set.json', SAMPLE_JSON).rows).toHaveLength(2);
    expect(parseImportFile('set.txt', SAMPLE_JSON).rows).toHaveLength(2);
    expect(parseImportFile('set.txt', SAMPLE_CSV).rows).toHaveLength(2);
  });
});

describe('expected (reference answer for code scorers)', () => {
  it('reads an expected column as JSON when it parses, else as text, and never as a variable', () => {
    const result = rowsFromCsv('message,expected\ntwo coffees,"{""total"": 8}"\none tea,8\nnothing,no order\n');
    expect(result.issues).toEqual([]);
    expect(result.rows).toEqual([
      { input: { message: 'two coffees' }, expected: { total: 8 } },
      { input: { message: 'one tea' }, expected: 8 },
      { input: { message: 'nothing' }, expected: 'no order' },
    ]);
    expect(result.variables).toEqual(['message']);
  });

  it('takes expected from both JSON shapes', () => {
    const result = rowsFromJson(
      JSON.stringify([
        { input: { message: 'a' }, expected: { total: 1 } },
        { message: 'b', expected: [1, 2] },
        { message: 'c' },
      ]),
    );
    expect(result.rows).toEqual([
      { input: { message: 'a' }, expected: { total: 1 } },
      { input: { message: 'b' }, expected: [1, 2] },
      { input: { message: 'c' } },
    ]);
  });
});

describe('expected — PR #602 review fixes', () => {
  it('keeps a long numeric id as text instead of rounding it through JSON.parse', () => {
    const result = rowsFromCsv('message,expected\norder,12345678901234567890\nleading zero,007\n');
    expect(result.rows.map((r) => r.expected)).toEqual(['12345678901234567890', '007']);
  });

  it('still reads JSON objects, arrays, booleans and exact numbers from a CSV expected cell', () => {
    const result = rowsFromCsv('message,expected\na,"{""total"": 8}"\nb,"[1,2]"\nc,true\nd,8\ne,2.5\n');
    expect(result.rows.map((r) => r.expected)).toEqual([{ total: 8 }, [1, 2], true, 8, 2.5]);
  });

  it('refuses an expected value over the API cap before sending, naming the row', () => {
    const big = JSON.stringify({ text: 'x'.repeat(9000) });
    const result = rowsFromJson(JSON.stringify([{ message: 'a', expected: JSON.parse(big) }]));
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([{ row: 1, message: 'expected is larger than 8192 bytes.' }]);
  });
});
