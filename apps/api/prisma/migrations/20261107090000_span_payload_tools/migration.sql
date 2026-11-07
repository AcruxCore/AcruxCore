-- AlterTable: the tool definitions and tool_choice a gateway llm call was sent (issues #792, #793)
ALTER TABLE "span_payloads" ADD COLUMN "tools" JSONB,
ADD COLUMN "tool_choice" JSONB;
