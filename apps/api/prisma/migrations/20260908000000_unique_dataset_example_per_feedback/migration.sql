-- One dataset row per feedback row.
--
-- `POST /datasets/:id/examples/from-feedback` checked for an existing row and
-- then inserted, so two appends of the same feedback row could both pass the
-- check and both insert. Only the database can close that window.
--
-- Postgres treats NULLs as distinct in a unique index, so examples added by
-- hand (source_feedback_id IS NULL) are unaffected — any number of them may
-- sit in the same dataset.

-- Existing duplicates would block the index below. Drop the lineage pointer on
-- every copy but the oldest rather than deleting the row: eval_results
-- references dataset_examples with ON DELETE CASCADE, so deleting a redundant
-- example would take a past run's graded results with it. Nulling the pointer
-- keeps the example and its results, and only loses the "came from this
-- feedback" link that the older copy already carries.
UPDATE "dataset_examples" AS e
SET "source_feedback_id" = NULL
WHERE "source_feedback_id" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "dataset_examples" AS older
    WHERE older."dataset_id" = e."dataset_id"
      AND older."source_feedback_id" = e."source_feedback_id"
      AND (older."created_at", older."id") < (e."created_at", e."id")
  );

CREATE UNIQUE INDEX "uq_dataset_examples_dataset_feedback"
  ON "dataset_examples" ("dataset_id", "source_feedback_id");
