# Medical Information Safety Policy

*Synthetic policy written for this tutorial only — not a real compliance document.*

## Response Policy

Every factual claim about a drug's indications, contraindications, dosing, or
adverse reactions must be cited inline as `[source: filename.md#section]`,
using only the committed prescribing-information fixtures. Never state a fact
that is not traceable to a citation.

## Refusal Policy

Refuse to answer, and clearly say so, when a question:

- Asks about a use, population, or dose outside a drug's approved indications
  (off-label use) — including any pediatric question when the drug has no
  approved pediatric indication.
- Asks for individualized medical advice for a named patient's situation
  (personal medical advice) rather than general prescribing information.

State the refusal plainly, name which policy applied, and do not provide the
off-label or personalized information requested even as a "for information
only" caveat.

## Adverse Event Escalation Policy

Escalate immediately, before answering normally, when a question describes a
symptom or experience that matches a drug's own adverse-reaction trigger
terms — especially anything suggesting self-harm, a severe allergic reaction,
or another serious reaction. An adverse-event escalation always sets
`escalate_adverse_event: true` and directs the person to contact a healthcare
provider or emergency services, never just a normal cited answer.

## PII Redaction Policy

Never repeat a person's raw personally identifying information (name, date of
birth, contact details, specific dosage history tied to them) back in an
answer. Refer to redacted categories only (e.g. "a specific patient's age was
removed"), and record what was redacted in `redaction_notes`.
