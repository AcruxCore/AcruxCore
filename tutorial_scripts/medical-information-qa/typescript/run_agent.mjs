/**
 * Medical-information QA agent -- Node, over the gateway.
 *
 * One runToolLoop() call with both toolRefs/dispatch and responseFormat set.
 * result.content is the shaped MedicalInformationAnswer JSON; result.iterations counts
 * the tool-gathering rounds. Supports both a plain JSON-schema dict (zero deps) and a
 * zod v4 schema (typed, with field descriptions the model reads) — the SDK accepts either
 * interchangeably.
 */
import AcruxCore from '@acruxcoreai/sdk';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const STOPWORDS = new Set(['a', 'an', 'and', 'any', 'for', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with']);

function tokens(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOPWORDS.has(w) && w.length > 2));
}
function slugify(heading) {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function loadSections(filenames) {
  const sections = [];
  for (const filename of filenames) {
    const text = readFileSync(path.join(DATA_DIR, filename), 'utf8');
    const blocks = text.split(/^## /m).slice(1);
    for (const block of blocks) {
      const nl = block.indexOf('\n');
      const heading = block.slice(0, nl).trim();
      const body = block.slice(nl + 1).trim();
      sections.push({ file: filename, heading, slug: slugify(heading), body });
    }
  }
  return sections;
}

/** Look up one of the committed synthetic drugs by id, brand name, or generic name. */
function getDrugProfile(query) {
  const q = query.trim().toLowerCase();
  const drugs = JSON.parse(readFileSync(path.join(DATA_DIR, 'drugs.json'), 'utf8'));
  const found = drugs.find((d) => [d.id, d.brand_name, d.generic_name].map((s) => s.toLowerCase()).includes(q));
  return found || { error: `No drug found matching '${query}'.` };
}

/** Look up a synthetic prior medical-information inquiry record by its id. */
function getInquiry(inquiryId) {
  const inquiries = JSON.parse(readFileSync(path.join(DATA_DIR, 'inquiries.json'), 'utf8'));
  const found = inquiries.find((i) => i.id.toLowerCase() === inquiryId.trim().toLowerCase());
  return found || { error: `No inquiry found with id '${inquiryId}'.` };
}

/** Token-overlap search over every committed markdown PI/policy fixture. */
function searchPrescribingInfo(query, topK = 3) {
  const sections = loadSections(['neuravex-pi.md', 'cortiblex-pi.md', 'safety-policy.md']);
  const qTokens = tokens(query);
  const scored = sections
    .map((s) => ({ overlap: [...qTokens].filter((t) => tokens(`${s.heading} ${s.body}`).has(t)).length, s }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, topK).map(({ s }) => ({ source: `${s.file}#${s.slug}`, snippet: s.body.slice(0, 400) }));
}

const POLICY_TOPIC_SLUGS = {
  response: 'response-policy',
  refusal: 'refusal-policy',
  adverse_event: 'adverse-event-escalation-policy',
  pii: 'pii-redaction-policy',
};

/** Look up the safety-policy snippet for one of: response, refusal, adverse_event, pii. */
function checkSafetyPolicy(topic) {
  const slug = POLICY_TOPIC_SLUGS[topic];
  if (!slug) return { error: `Unknown policy topic '${topic}'.` };
  const section = loadSections(['safety-policy.md']).find((s) => s.slug === slug);
  return section ? { source: `safety-policy.md#${slug}`, snippet: section.body } : { error: `Policy section '${slug}' not found.` };
}

async function dispatch(name, args) {
  if (name === 'get_drug_profile') return getDrugProfile(args.query);
  if (name === 'get_inquiry') return getInquiry(args.inquiry_id);
  if (name === 'search_prescribing_info') return searchPrescribingInfo(args.query);
  if (name === 'check_safety_policy') return checkSafetyPolicy(args.topic);
  throw new Error(`Unknown tool: ${name}`);
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    disposition: { type: 'string', enum: ['answer', 'answer_with_limitations', 'refuse_off_label', 'refuse_personal_advice', 'escalate_adverse_event'] },
    answer: { type: 'string' },
    safety_flags: { type: 'array', items: { type: 'string', enum: ['off_label', 'personal_medical_advice', 'adverse_event', 'pii_redacted', 'unsupported_claim'] } },
    escalate_adverse_event: { type: 'boolean' },
    pii_redacted: { type: 'boolean' },
    redaction_notes: { type: 'array', items: { type: 'string' } },
    citations: { type: 'array', items: { type: 'string' } },
  },
  required: ['disposition', 'answer', 'safety_flags', 'escalate_adverse_event', 'pii_redacted', 'redaction_notes', 'citations'],
  additionalProperties: false,
};

// --- Alternative: zod schema (typed, with field descriptions) ---
// Requires: npm install zod (>=3.25) — the SDK converts this to the same wire dict.
// Import from 'zod/v4' so the SDK's toJSONSchema converter can process it.
// Uncomment the block below and comment out the dict fallback to use the typed path.
//
// import { z } from 'zod/v4';
// const MedicalInformationAnswer = z.object({
//   disposition: z.enum(['answer', 'answer_with_limitations', 'refuse_off_label', 'refuse_personal_advice', 'escalate_adverse_event']).describe("The agent's decision."),
//   answer: z.string().describe('The text the end user sees.'),
//   safety_flags: z.array(z.enum(['off_label', 'personal_medical_advice', 'adverse_event', 'pii_redacted', 'unsupported_claim'])).describe('Policy flags triggered.'),
//   escalate_adverse_event: z.boolean().describe('True when the question describes a suspected adverse event.'),
//   pii_redacted: z.boolean().describe('True when PII was found and redacted.'),
//   redaction_notes: z.array(z.string()).describe('What was redacted and why.'),
//   citations: z.array(z.string()).describe('Source references.'),
// });

async function main() {
  const question = process.argv[2] || 'What is Cortiblex approved to treat, and is it safe for someone with a fungal infection?';
  const hub = new AcruxCore(); // reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL

  const rendered = await hub.renderPrompt('medical-information-qa', 'production', { question });

  // One call, toolRefs/dispatch and responseFormat set together. result.content is the
  // shaped MedicalInformationAnswer JSON; result.iterations counts the tool-gathering rounds.
  //
  // Two ways to pass responseFormat — pick one:
  //   Dict (zero deps):   responseFormat: { type: 'json_schema', json_schema: { name: '...', schema: ANSWER_SCHEMA, strict: true } }
  //   Zod (typed):        responseFormat: { zod: MedicalInformationAnswer, name: 'medical_information_answer' }
  // Switch to { zod: MedicalInformationAnswer, name: 'medical_information_answer' } after uncommenting the zod block above.
  const responseFormat = { type: 'json_schema', json_schema: { name: 'medical_information_answer', schema: ANSWER_SCHEMA, strict: true } };
  const result = await hub.runToolLoop({
    model: rendered.model,
    messages: [...rendered.messages],
    toolRefs: [{ name: 'get_drug_profile' }, { name: 'get_inquiry' }, { name: 'search_prescribing_info' }, { name: 'check_safety_policy' }],
    dispatch,
    responseFormat,
    sync: false, // already synced by create_tools.py
    promptVersionId: rendered.versionId,
  });

  console.log(`Question: ${question}`);
  console.log(`(gathered over ${result.iterations} tool round(s), trace ${result.traceId})\n`);
  console.log(JSON.stringify(JSON.parse(result.content), null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
