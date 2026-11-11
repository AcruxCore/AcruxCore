import { ModelsRepository, type GatewayModelWithProvider } from '../../gateway/models/models.repository';
import { cacheRatesForModel, computeCost, computeCostFromPrices, stripDateSuffix } from '../../gateway/providers/models';
import type { IngestSpan, IngestTrace } from './ingest.types';

/**
 * Fills in `costUsd` on traced spans that arrive without one — SDK and OTLP spans that
 * never went through the gateway, so no gateway ledger row priced them.
 *
 * The order is: a cost the client sent, then the team's own model of that name
 * (`gateway_models.input_price_per_m` / `output_price_per_m`, matched on public name or
 * upstream id), then the built-in `MODELS` registry. A matched team model always wins, even
 * with blank prices: blank means "no cost", as it does on the gateway, so the span stays
 * unpriced rather than taking the registry's price (issue #825).
 *
 * A span's `usage.cachedTokens` is billed at the model's cached input price, the same split
 * the gateway bills. Without the team step, any model the registry does not list stayed at
 * `cost = null` on every traced call, and the cost charts undercounted with no warning
 * (issue #588).
 */
export class SpanPricer {
  /** @param models - Read access to the team's registered gateway models. */
  constructor(private readonly models: ModelsRepository = new ModelsRepository()) {}

  /**
   * Returns the batch with a cost on every span that has a model and both token counts
   * but no cost yet. One query for the whole batch, however many spans it holds.
   *
   * @param teamId - Team scope; only this team's prices are read.
   * @param traces - The validated batch. Not mutated.
   * @returns A copy of `traces` with costs filled where a price was found. A span keeps
   *          `costUsd` undefined (stored as null) when its matched team model lacks either
   *          price, or when no team model matches and the registry does not list it.
   */
  async price(teamId: string, traces: IngestTrace[]): Promise<IngestTrace[]> {
    const names = new Set<string>();
    for (const trace of traces) {
      for (const span of trace.spans) {
        if (needsPrice(span)) {
          names.add(span.model!);
          names.add(stripDateSuffix(span.model!));
        }
      }
    }
    if (names.size === 0) return traces;

    const teamModels = await this.models.listByNames(teamId, [...names]);
    return traces.map((trace) => ({
      ...trace,
      spans: trace.spans.map((span) => (needsPrice(span) ? withCost(span, teamModels) : span)),
    }));
  }
}

/** A span the pricer should touch: no client cost, a model, and both token counts. */
function needsPrice(span: IngestSpan): boolean {
  return (
    span.costUsd === undefined &&
    span.model !== undefined &&
    span.usage?.promptTokens !== undefined &&
    span.usage?.completionTokens !== undefined
  );
}

/**
 * Picks the team model that decides the price of `model`: an exact public-name match wins
 * over an upstream-id match, and either wins over a match on the date-stripped id. The
 * result may have blank prices; the caller then leaves the span unpriced.
 *
 * Within one tier, a model with both prices wins over one without. Several public names can
 * point at the same upstream id, and a span reporting that id cannot say which one it used,
 * so an unpriced alias must not hide a priced one. Otherwise ties go to the most recently
 * edited model, because `teamModels` is newest-edit first.
 */
function findTeamModel(model: string, teamModels: GatewayModelWithProvider[]): GatewayModelWithProvider | undefined {
  const bare = stripDateSuffix(model);
  return (
    pickPricedFirst(teamModels.filter((m) => m.publicName === model)) ??
    pickPricedFirst(teamModels.filter((m) => m.upstreamModel === model)) ??
    pickPricedFirst(teamModels.filter((m) => m.publicName === bare || m.upstreamModel === bare))
  );
}

/** The first model with both prices set, else the first model; undefined for an empty list. */
function pickPricedFirst(matches: GatewayModelWithProvider[]): GatewayModelWithProvider | undefined {
  return matches.find((m) => m.inputPricePerM !== null && m.outputPricePerM !== null) ?? matches[0];
}

/**
 * Returns `span` with `costUsd` set from the matched team model, else the registry, else
 * unchanged. A matched team model with a blank price leaves the span unchanged: the
 * registry is only for models the team never registered.
 */
function withCost(span: IngestSpan, teamModels: GatewayModelWithProvider[]): IngestSpan {
  const promptTokens = span.usage!.promptTokens!;
  const completionTokens = span.usage!.completionTokens!;
  const cachedTokens = span.usage!.cachedTokens;
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: span.usage!.totalTokens ?? promptTokens + completionTokens,
    ...(cachedTokens ? { cached_tokens: cachedTokens } : {}),
  };
  const team = findTeamModel(span.model!, teamModels);
  // The same blended pricing as the gateway: cached tokens at the team's cached input
  // price, or at the provider's default cache rate when the model has none (issue #594).
  const costUsd = team
    ? computeCostFromPrices(
        team.inputPricePerM,
        team.outputPricePerM,
        usage,
        // The connection that serves the model sets the default cache rate, as on the gateway.
        // The span's own `provider` is free text from the client and may say anything.
        cacheRatesForModel(team.credential.provider, team.upstreamModel, team.cachedInputPricePerM),
      )
    : computeCost(span.model!, usage);
  return costUsd == null ? span : { ...span, costUsd };
}
