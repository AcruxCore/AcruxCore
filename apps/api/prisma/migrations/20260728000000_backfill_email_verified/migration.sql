-- Let accounts that predate the Better Auth cutover back in.
--
-- `20260726090000_better_auth_identity` added `email_verified NOT NULL DEFAULT
-- false`, which is right for new signups and wrong for every account that
-- already existed. Those users authenticated through Supabase, so they have no
-- `auth_accounts` credential row either (the `password_hash` column that
-- migration dropped had been dead since 391485f, so there is nothing to carry
-- over). On an install with a mail transport that combination locks them out
-- completely: no credential means sign-in fails, and `email_verified = false`
-- means the password reset they would use to create one leaves them stuck at
-- EMAIL_NOT_VERIFIED afterwards.
--
-- Reset alone is enough to fix the missing credential — Better Auth's
-- `resetPassword` creates the `credential` account when a user has none — so
-- this only has to clear the verification gate standing in front of it.
--
-- "Predates the cutover" is expressed as "has no account row" rather than a
-- timestamp: every route that creates a user (email signup, Google, the
-- first-run claim) links an `auth_accounts` row in the same call, so a user
-- without one can only have come from Supabase. That also makes this safe to
-- run at any point and safe to re-run — on a fresh install `users` is empty and
-- it does nothing, and it can never touch a legitimately-unverified new signup.
UPDATE "users" u
SET "email_verified" = true
WHERE u."email_verified" = false
  AND NOT EXISTS (
    SELECT 1 FROM "auth_accounts" a WHERE a."user_id" = u."id"
  );
