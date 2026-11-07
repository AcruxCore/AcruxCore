-- AlterTable: whether a trace name is a server fallback the root step may replace (issue #791)
ALTER TABLE "traces" ADD COLUMN "name_is_derived" BOOLEAN NOT NULL DEFAULT false;
