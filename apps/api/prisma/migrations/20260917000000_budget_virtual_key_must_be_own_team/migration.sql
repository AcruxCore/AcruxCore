-- A budget may only point at a virtual key its own team owns.
--
-- `POST /api/v1/gateway/budgets` took `virtual_key_id` from the request body
-- and never checked who owned it. A row written that way can never match any
-- of its own team's calling keys, because `applicable_budgets` looks for
-- `virtual_key_id IS NULL OR virtual_key_id = <the calling key>` — so the cap
-- enforces nothing, while the Budgets page still lists it as active. A team
-- believes it has a spend cap and does not.
--
-- Part 1 removes the rows that door could already have written. Deleting is
-- the only remedy that changes no enforcement: the row capped nothing before
-- and caps nothing after, so no traffic that used to be allowed is refused and
-- none that used to be refused is allowed. Setting `virtual_key_id` to NULL
-- instead would silently turn a cap someone wrote for one key into a team-wide
-- one and could start refusing a team's traffic on the next deploy — a change
-- nobody asked for.

DELETE FROM budgets b
USING virtual_keys k
WHERE k.id = b.virtual_key_id
  AND k.team_id <> b.team_id;

-- Part 2 makes the state unreachable rather than merely cleaned up once. The
-- composite foreign key needs a unique index on exactly its referenced
-- columns; `virtual_keys.id` is already the primary key, so this index is
-- redundant for lookups and exists only to be referenced.

CREATE UNIQUE INDEX IF NOT EXISTS virtual_keys_id_team_id_key
  ON virtual_keys (id, team_id);

-- MATCH SIMPLE (the default) skips the check entirely when any referencing
-- column is NULL, so a team-wide budget — `virtual_key_id IS NULL` — is not
-- constrained, which is exactly what it should be. CASCADE mirrors the
-- existing single-column foreign key, so deleting a virtual key still takes
-- its budget with it.
--
-- DROP first so this file can be re-applied to a database that already has it,
-- which the test beside the budgets domain relies on.

ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_virtual_key_team_fk;

ALTER TABLE budgets
  ADD CONSTRAINT budgets_virtual_key_team_fk
  FOREIGN KEY (virtual_key_id, team_id)
  REFERENCES virtual_keys (id, team_id)
  ON DELETE CASCADE
  ON UPDATE NO ACTION;
