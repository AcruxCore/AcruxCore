-- AlterEnum
-- Five evaluation events, so the audit trail covers the one domain that could
-- destroy data and commit the team to spend without leaving a record (#508).
-- Postgres 12+ allows several ADD VALUEs in one migration.

ALTER TYPE "AuditEvent" ADD VALUE 'dataset_created';
ALTER TYPE "AuditEvent" ADD VALUE 'dataset_deleted';
ALTER TYPE "AuditEvent" ADD VALUE 'eval_rule_created';
ALTER TYPE "AuditEvent" ADD VALUE 'eval_rule_updated';
ALTER TYPE "AuditEvent" ADD VALUE 'eval_rule_deleted';
