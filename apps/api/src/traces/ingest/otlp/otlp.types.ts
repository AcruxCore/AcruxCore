/** One key/value attribute pair as OTel encodes it (protobuf and JSON alike). */
export interface RawKeyValue {
  key: string;
  value: RawAnyValue;
}

/** OTel's `AnyValue` oneof, decoded to a plain discriminated shape. */
export interface RawAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  // `values` is optional on purpose: protobufjs omits an empty repeated field,
  // so a genuinely empty list decodes as `{ arrayValue: {} }` / `{ kvlistValue: {} }`.
  arrayValue?: { values?: RawAnyValue[] };
  kvlistValue?: { values?: RawKeyValue[] };
}

/** One decoded OTel span, before any AcruxCore-specific translation. */
export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: RawKeyValue[];
  // `code` is optional for the same reason as `values` above: proto3 omits a
  // field at its zero value, so a real `STATUS_CODE_UNSET` decodes as `{}`.
  status?: { code?: number; message?: string };
}

/** One decoded `ResourceSpans` entry — a resource plus the spans it produced. */
export interface RawResourceSpans {
  resourceAttributes: RawKeyValue[];
  spans: RawSpan[];
}
