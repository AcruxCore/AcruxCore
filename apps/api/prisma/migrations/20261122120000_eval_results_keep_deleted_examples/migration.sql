-- A run freezes its examples into experiment_runs.example_snapshot, and each result's
-- dataset_example_id names an example in that snapshot. The foreign key to the live
-- dataset_examples row cascaded a result away whenever the example was deleted, so
-- finished runs silently lost results (issue #867, F01). The id is kept, unconstrained.
ALTER TABLE "eval_results" DROP CONSTRAINT "eval_results_dataset_example_id_fkey";
