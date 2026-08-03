-- Platform API keys were stored in plain text. A key that has ever been stored
-- in plain text is compromised (readable in the live DB, in every backup, and
-- for some keys in git history), so existing keys are deleted rather than
-- hashed forward. Pre-launch there are no external users to break; the owner
-- recreates keys from the UI. Nothing holds a foreign key to api_keys, so this
-- delete cannot cascade or orphan anything.
DELETE FROM "api_keys";

-- Hash-on-store: only the sha256 of the token is persisted, plus the last four
-- characters so the UI can render a recognisable masked value.
ALTER TABLE "api_keys" ADD COLUMN "key_hash" TEXT NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN "key_last_four" TEXT NOT NULL;

-- The plaintext column and its index are gone for good.
DROP INDEX IF EXISTS "idx_api_keys_key_active";
ALTER TABLE "api_keys" DROP COLUMN "key";

-- Serves both uniqueness and the per-request auth lookup (equality on a
-- fixed-length hex string).
CREATE UNIQUE INDEX "api_keys_key_hash_unique" ON "api_keys"("key_hash");
