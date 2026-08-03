-- Better Auth takes over identity from Supabase Auth.
--
-- `users` is MODIFIED, never replaced: every foreign key in the schema already
-- points at `users.id`, and letting Better Auth create a table of its own would
-- reproduce the `supabase_user_id` indirection this migration exists to delete.

-- 1. Columns Better Auth requires on its `user` model.
ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "image" TEXT;
ALTER TABLE "users" ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- 2. Drop the Supabase link. Identity is now `users.id` alone.
DROP INDEX IF EXISTS "users_supabase_user_id_unique";
ALTER TABLE "users" DROP COLUMN IF EXISTS "supabase_user_id";

-- 3. Drop the dead password column. Better Auth stores the credential hash on
--    `auth_accounts.password`; this column has been unused since the
--    pre-Supabase session auth was removed in 391485f. Keeping a second,
--    silently-ignored password column is how an auth check later reads the
--    wrong one.
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash";

-- 4. Drop the connect-pg-simple session store, dead since the same commit.
--    Verified empty before writing this migration. A table named `session`
--    sitting next to `auth_sessions` is a trap for the next reader.
DROP TABLE IF EXISTS "session";

-- 5. Better Auth's own tables, prefixed so they read unambiguously next to the
--    domain tables (and so `session` never competes with the tracing vocabulary).
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auth_sessions_token_unique" ON "auth_sessions"("token");
CREATE INDEX "idx_auth_sessions_user_id" ON "auth_sessions"("user_id");
CREATE INDEX "idx_auth_sessions_expires_at" ON "auth_sessions"("expires_at");
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "password" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(6),
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "scope" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auth_accounts_provider_account_unique" ON "auth_accounts"("provider_id", "account_id");
CREATE INDEX "idx_auth_accounts_user_id" ON "auth_accounts"("user_id");
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "auth_verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_auth_verifications_identifier" ON "auth_verifications"("identifier");
