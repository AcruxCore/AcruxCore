-- Data-only migration: the online-eval-rule redesign removes the hardcoded
-- EVAL_JUDGE_MODEL fallback (see phase-5-faq). Every rule must carry a real,
-- team-registered judge model going forward. Backfill any existing rule left
-- with a null judge_model to that team's earliest-created GatewayModel, so it
-- keeps working under the new required-judgeModel contract. A team with zero
-- registered models is left null — such a rule was already unable to judge
-- anything (the old fallback string 'gpt-4o-mini' only worked if the team
-- happened to have registered a model with that exact public name), and
-- judge() now surfaces that state as a graceful failed-run reason instead of
-- silently guessing a model name.
UPDATE eval_rules er
SET judge_model = gm.public_name
FROM (
  SELECT DISTINCT ON (team_id) team_id, public_name
  FROM gateway_models
  ORDER BY team_id, created_at ASC
) gm
WHERE er.judge_model IS NULL
  AND er.team_id = gm.team_id;
