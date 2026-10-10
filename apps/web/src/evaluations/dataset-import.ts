/**
 * Parsing for the dataset "Import file" tab: turns a CSV, JSON or JSONL file
 * into the rows `POST /datasets/:id/examples/bulk` accepts, and reports every
 * problem by row number before anything is sent.
 *
 * Kept free of React so the format rules can be unit-tested on their own.
 */

/** One example as the bulk endpoint takes it. */
export interface ImportRow {
  input: Record<string, unknown>;
  criteria?: string;
  history?: unknown[];
}

/** One problem found in the file, tied to the row a person would look for. */
export interface ImportIssue {
  /** 1-based row number as the person sees it: a CSV data row, or a JSON array item. */
  row: number;
  message: string;
}

/** What parsing a file produced: the rows that are ready, and what is wrong with the rest. */
export interface ImportParseResult {
  rows: ImportRow[];
  /**
   * The file row number of each entry in `rows`, same order. Rows with problems
   * are left out of `rows`, so the preview needs this to show the number a
   * person can find in their file — the same numbering `issues` uses.
   */
  rowNumbers: number[];
  issues: ImportIssue[];
  /** Variable names seen across all rows, in first-seen order. Drives the preview columns. */
  variables: string[];
}

/** Mirrors the API's cap (`MAX_EXAMPLES_PER_BULK`), so the dialog can refuse before sending. */
export const MAX_IMPORT_ROWS = 500;

/** Mirrors the API's `MAX_EXAMPLE_INPUT_BYTES`. */
export const MAX_INPUT_BYTES = 8192;

/**
 * The API's request body limit is 1 MB. The dialog checks the serialized body
 * against a slightly lower number so a near-limit file gets a clear message
 * here, instead of a bare "request entity too large" from the server.
 */
export const MAX_BODY_BYTES = 1_000_000;

/** Column / key names that are not input variables. Matched case-insensitively. */
const CRITERIA_KEY = 'criteria';
const HISTORY_KEY = 'history';

/** A sample CSV for the format hint and the download link. */
export const SAMPLE_CSV = `question,customer_tier,criteria
How long do I have to return an item?,free,"Says 30 days from delivery, and that items must be unused."
Can I get a refund on an annual plan?,pro,Quotes the 14-day refund window for annual plans.
`;

/** A sample JSON file for the format hint and the download link. */
export const SAMPLE_JSON = `[
  {
    "input": { "question": "How long do I have to return an item?", "customer_tier": "free" },
    "criteria": "Says 30 days from delivery, and that items must be unused."
  },
  {
    "input": { "question": "And for annual plans?" },
    "criteria": "Quotes the 14-day refund window for annual plans.",
    "history": [
      { "role": "user", "content": "Can I get a refund?" },
      { "role": "assistant", "content": "Yes, within 30 days." }
    ]
  }
]
`;

/**
 * Splits CSV text into records of fields (RFC 4180): quoted fields may hold
 * commas, newlines and doubled quotes (`""`). Handles CRLF and a UTF-8 BOM,
 * which Excel writes. Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endRecord = () => {
    record.push(field);
    // A blank line parses as one empty field; it is not a row.
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
    field = '';
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      endRecord();
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

/** Byte length of a value once serialized, the same measure the API applies. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Checks one built row against the same rules the API applies, so the preview is honest. */
function checkRow(row: ImportRow, rowNumber: number, issues: ImportIssue[]): boolean {
  if (Object.keys(row.input).length === 0) {
    issues.push({ row: rowNumber, message: 'has no input variables.' });
    return false;
  }
  if (jsonBytes(row.input) > MAX_INPUT_BYTES) {
    issues.push({ row: rowNumber, message: `input is larger than ${MAX_INPUT_BYTES} bytes.` });
    return false;
  }
  return true;
}

function collectVariables(rows: ImportRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.input)) seen.add(key);
  return [...seen];
}

/**
 * Builds rows from CSV text. The first line is the header. Every column becomes
 * an input variable, except a column named `criteria`, which becomes the
 * judge criteria. Values stay strings — the same thing a prompt template
 * renders.
 */
export function rowsFromCsv(text: string): ImportParseResult {
  const records = parseCsv(text);
  const issues: ImportIssue[] = [];
  if (records.length === 0) return { rows: [], rowNumbers: [], issues: [{ row: 0, message: 'The file is empty.' }], variables: [] };

  const header = records[0].map((h) => h.trim());
  if (header.some((h) => h === '')) {
    issues.push({ row: 0, message: 'The header row has an empty column name.' });
  }
  const dupes = header.filter((h, i) => h !== '' && header.indexOf(h) !== i);
  if (dupes.length > 0) {
    issues.push({ row: 0, message: `The header row repeats a column name: ${dupes[0]}.` });
  }
  if (issues.length > 0) return { rows: [], rowNumbers: [], issues, variables: [] };

  const criteriaCol = header.findIndex((h) => h.toLowerCase() === CRITERIA_KEY);
  const rows: ImportRow[] = [];
  const rowNumbers: number[] = [];
  records.slice(1).forEach((record, index) => {
    const rowNumber = index + 1;
    if (record.length !== header.length) {
      issues.push({
        row: rowNumber,
        message: `has ${record.length} column${record.length === 1 ? '' : 's'}, the header has ${header.length}.`,
      });
      return;
    }
    const input: Record<string, unknown> = {};
    header.forEach((name, col) => {
      if (col !== criteriaCol) input[name] = record[col];
    });
    const criteria = criteriaCol >= 0 ? record[criteriaCol].trim() : '';
    const row: ImportRow = { input, ...(criteria ? { criteria } : {}) };
    if (checkRow(row, rowNumber, issues)) {
      rows.push(row);
      rowNumbers.push(rowNumber);
    }
  });
  return { rows, rowNumbers, issues, variables: collectVariables(rows) };
}

/**
 * Turns one JSON item into a row. Two shapes are accepted:
 *
 * - The API shape: `{ "input": {...}, "criteria": "...", "history": [...] }`.
 * - A flat object: `{ "question": "...", "criteria": "..." }`, where every key
 *   other than `criteria` and `history` is a variable. This is how most hand-
 *   written test sets look.
 *
 * An item counts as the API shape only when its `input` is an object, so a flat
 * row with a string variable named `input` still works.
 */
function rowFromItem(item: unknown, rowNumber: number, issues: ImportIssue[]): ImportRow | null {
  if (!isPlainObject(item)) {
    issues.push({ row: rowNumber, message: 'is not a JSON object.' });
    return null;
  }
  const apiShape = isPlainObject(item.input);
  let input: Record<string, unknown>;
  let criteriaValue: unknown;
  let historyValue: unknown;
  if (apiShape) {
    input = item.input as Record<string, unknown>;
    criteriaValue = item.criteria;
    historyValue = item.history;
  } else {
    input = {};
    for (const [key, value] of Object.entries(item)) {
      const lower = key.toLowerCase();
      if (lower === CRITERIA_KEY) criteriaValue = value;
      else if (lower === HISTORY_KEY) historyValue = value;
      else input[key] = value;
    }
  }

  if (criteriaValue !== undefined && criteriaValue !== null && typeof criteriaValue !== 'string') {
    issues.push({ row: rowNumber, message: 'criteria must be a string.' });
    return null;
  }
  if (historyValue !== undefined && historyValue !== null && !Array.isArray(historyValue)) {
    issues.push({ row: rowNumber, message: 'history must be an array of chat messages.' });
    return null;
  }
  const criteria = typeof criteriaValue === 'string' ? criteriaValue.trim() : '';
  const row: ImportRow = {
    input,
    ...(criteria ? { criteria } : {}),
    ...(Array.isArray(historyValue) && historyValue.length > 0 ? { history: historyValue } : {}),
  };
  return checkRow(row, rowNumber, issues) ? row : null;
}

/**
 * Builds rows from JSON text: an array of items, or `{ "examples": [...] }` —
 * the request body itself, so a file saved from an API script imports as is.
 */
export function rowsFromJson(text: string): ImportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { rows: [], rowNumbers: [], issues: [{ row: 0, message: `The file is not valid JSON (${(e as Error).message}).` }], variables: [] };
  }
  const items = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.examples)
      ? parsed.examples
      : null;
  if (!items) {
    return {
      rows: [],
      rowNumbers: [],
      issues: [{ row: 0, message: 'Expected a JSON array of examples, or an object with an "examples" array.' }],
      variables: [],
    };
  }
  return fromItems(items.map((item, i) => ({ item, rowNumber: i + 1 })));
}

/** Builds rows from JSON Lines text: one JSON object per line. */
export function rowsFromJsonl(text: string): ImportParseResult {
  const issues: ImportIssue[] = [];
  const items: Array<{ item: unknown; rowNumber: number }> = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      items.push({ item: JSON.parse(line), rowNumber: i + 1 });
    } catch {
      issues.push({ row: i + 1, message: 'is not valid JSON.' });
    }
  });
  const result = fromItems(items);
  return { ...result, issues: [...issues, ...result.issues].sort((a, b) => a.row - b.row) };
}

function fromItems(items: Array<{ item: unknown; rowNumber: number }>): ImportParseResult {
  const issues: ImportIssue[] = [];
  const rows: ImportRow[] = [];
  const rowNumbers: number[] = [];
  for (const { item, rowNumber } of items) {
    const row = rowFromItem(item, rowNumber, issues);
    if (row) {
      rows.push(row);
      rowNumbers.push(rowNumber);
    }
  }
  return { rows, rowNumbers, issues, variables: collectVariables(rows) };
}

/**
 * Picks the parser from the file name, falling back to the content: text that
 * starts with `[` or `{` is JSON, anything else is CSV.
 */
export function parseImportFile(fileName: string, text: string): ImportParseResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return rowsFromJsonl(text);
  if (lower.endsWith('.json')) return rowsFromJson(text);
  if (lower.endsWith('.csv')) return rowsFromCsv(text);
  const head = text.replace(/^﻿/, '').trimStart();
  return head.startsWith('[') || head.startsWith('{') ? rowsFromJson(text) : rowsFromCsv(text);
}

/** Size of the request body these rows would make, for the pre-send limit check. */
export function bodyBytes(rows: ImportRow[]): number {
  return jsonBytes({ examples: rows });
}
