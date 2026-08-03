-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';

-- One budget per (team, key-or-team-wide, period). virtual_key_id NULL = team-wide.
-- COALESCE collapses NULL to a sentinel UUID so two team-wide budgets for the same
-- period collide (Postgres otherwise treats NULLs as distinct).
CREATE UNIQUE INDEX "uq_budgets_scope"
  ON "budgets" ("team_id", COALESCE("virtual_key_id", '00000000-0000-0000-0000-000000000000'), "period");
