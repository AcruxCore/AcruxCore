import {
  User,
  Team,
  TeamMember,
  ApiKey,
  ProviderConnection,
  team_role as TeamRole,
  GatewayRequest,
  VirtualKey,
  Budget,
  budget_period as BudgetPeriod,
  GatewayCache,
  GatewayModel,
  GatewayModelFallback,
  Trace,
  Span,
  SpanPayload,
  TeamTraceSettings,
  span_kind as SpanKind,
  span_status as SpanStatus,
  TraceFeedback,
} from '@prisma/client';

export type {
  User, Team, TeamMember, ApiKey, ProviderConnection, TeamRole,
  GatewayRequest, VirtualKey, Budget, BudgetPeriod, GatewayCache, GatewayModel, GatewayModelFallback,
  Trace, Span, SpanPayload, TeamTraceSettings, SpanKind, SpanStatus, TraceFeedback,
};

/** Alias used across the gateway completion domain for a gateway_requests row. */
export type GatewayRequestRow = GatewayRequest;

/** Alias used across the traces domain for a `traces` row. */
export type TraceRow = Trace;
/** Alias used across the traces domain for a `spans` row. */
export type SpanRow = Span;
/** Alias used across the traces domain for a `span_payloads` row. */
export type SpanPayloadRow = SpanPayload;
/** Alias used across the traces feedback domain for a trace_feedback row. */
export type FeedbackRow = TraceFeedback;
