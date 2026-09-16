import { normalizeOutput } from '../datasets/history.builder';

/** One entry of an OpenAI-style multi-part `content` array. */
interface ContentPart {
  type?: unknown;
  text?: unknown;
}

/**
 * Narrows a span's stored output to the part a judge should actually grade.
 *
 * `span_payloads.output` holds the provider's whole response for a gateway
 * call — `{id, object, created, model, usage, choices:[…]}`. Handing that to
 * an LLM judge means a criterion written about the answer ("must name a
 * city", "must not mention a competitor") is graded against JSON bookkeeping,
 * which is what produced verdicts like *"it is a JSON object instead"* on
 * perfectly good answers, and billed a judge call for the privilege
 * (issue #505). The offline eval path never had this problem because
 * `cell.processor.ts` stores `choices[0].message.content` and nothing else;
 * this brings the online path to the same notion of "output".
 *
 * **Both producers are handled**, via the same {@link normalizeOutput} the
 * dataset builder uses: the gateway hook writes the full `{choices:[…]}`
 * envelope, and both published SDKs write the bare assistant message
 * (`output: result.message`). Reading `choices` alone left every
 * SDK-reported span — the documented way to report a span — still handing the
 * judge a JSON object, which is the #505 failure itself.
 *
 * **Tool calls are read before text, not after.** Anthropic and Gemini build
 * a pure tool-calling turn as `content: ''` rather than `content: null`
 * (`anthropic.adapter.ts` joins the text parts of a response that has none),
 * and the streaming path accumulates from an `''` seed. Testing the string
 * first therefore narrowed those turns to an empty string, and narrowed an
 * OpenAI turn that carried both a preamble and tool calls to the preamble
 * alone — so a rule whose criteria are about tool use ("must call
 * get_weather before answering") graded text that no longer mentioned any
 * tool, and still billed a judge completion per sampled span.
 *
 * Everything that is not a recognisable assistant message is returned
 * untouched — a hand-ingested span may store a plain string, or a shape this
 * platform does not define — so this only changes the cases that were wrong.
 *
 * @param output - `span_payloads.output`, of unknown shape. May be null.
 * @returns The assistant's text when the turn produced text and nothing else;
 *   the assistant message itself when it called tools (the calls *are* the
 *   answer, and any preamble rides along inside it); otherwise `output`
 *   unchanged.
 */
export function judgeableOutput(output: unknown): unknown {
  const message = normalizeOutput(output);
  if (!message) return output;

  // Tool calls first — see the note above on `content: ''` and on preambles.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return message;

  const content: unknown = message.content;
  if (typeof content === 'string') return content;

  // A multi-part `content` array: grade the text the user would have seen. An array
  // holding no text part at all (an image-only reply) falls through to the message,
  // because an empty string would tell the judge the model said nothing.
  if (Array.isArray(content)) {
    const text = (content as ContentPart[])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    return text === '' ? message : text;
  }

  return message;
}
