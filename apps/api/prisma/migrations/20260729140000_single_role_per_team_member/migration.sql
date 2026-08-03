-- A team member holds exactly one role, not a set: owner/admin/editor/viewer
-- form a strict hierarchy (every permission check that allows a lower role
-- also allows every role above it), so a second, lower role granted on top of
-- a member's highest role added nothing. Collapses `team_member_roles` (one
-- row per held role) down to a single `role` column, picking the
-- highest-priority role a member already held so no one loses access.

-- team_members: add nullable column, backfill from team_member_roles, then require it
ALTER TABLE "team_members" ADD COLUMN "role" "team_role";

UPDATE "team_members" tm
SET "role" = CASE
  WHEN EXISTS (SELECT 1 FROM "team_member_roles" r WHERE r.team_member_id = tm.id AND r.role = 'owner')  THEN 'owner'::"team_role"
  WHEN EXISTS (SELECT 1 FROM "team_member_roles" r WHERE r.team_member_id = tm.id AND r.role = 'admin')  THEN 'admin'::"team_role"
  WHEN EXISTS (SELECT 1 FROM "team_member_roles" r WHERE r.team_member_id = tm.id AND r.role = 'editor') THEN 'editor'::"team_role"
  ELSE 'viewer'::"team_role"
END;

ALTER TABLE "team_members" ALTER COLUMN "role" SET NOT NULL;

-- team_invites: same collapse, from the text[] `roles` column
ALTER TABLE "team_invites" ADD COLUMN "role" "team_role";

UPDATE "team_invites"
SET "role" = CASE
  WHEN 'owner'  = ANY("roles") THEN 'owner'::"team_role"
  WHEN 'admin'  = ANY("roles") THEN 'admin'::"team_role"
  WHEN 'editor' = ANY("roles") THEN 'editor'::"team_role"
  ELSE 'viewer'::"team_role"
END;

ALTER TABLE "team_invites" ALTER COLUMN "role" SET NOT NULL;
ALTER TABLE "team_invites" DROP COLUMN "roles";

-- Drop the now-unused junction table entirely.
DROP TABLE "team_member_roles";
