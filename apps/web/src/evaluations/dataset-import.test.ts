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
