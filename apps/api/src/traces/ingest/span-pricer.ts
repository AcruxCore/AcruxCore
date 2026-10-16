import { ModelsRepository, type PricedGatewayModel } from '../../gateway/models/models.repository';
import { cacheRatesForModel, computeCost, computeCostFromPrices, stripDateSuffix } from '../../gateway/providers/models';
import type { IngestSpan, IngestTrace } from './ingest.types';

/**
 * Fills in `costUsd` on traced spans that arrive without one — SDK and OTLP spans that
 * never went through the gateway, so no gateway ledger row priced them.
 *
 * The order is: a cost the client sent, then the team's own price for that model
 * (`gateway_models.input_price_per_m` / `output_price_per_m`, matched on public name or
 * upstream id), then the built-in `MODELS` registry. A span's `usage.cachedTokens` is billed at
 * the model's cached input price, the same split the gateway bills. Without the team step, any model the
 * registry does not list stayed at `cost = null` on every traced call, and the cost charts
 * undercounted with no warning (issue #588).
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
   * @returns A copy of `traces` with costs filled where a price was found. A span with no
   *          team price and no registry entry keeps `costUsd` undefined (stored as null).
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

    const priced = await this.models.listPricedByNames(teamId, [...names]);
    return traces.map((trace) => ({
      ...trace,
      spans: trace.spans.map((span) => (needsPrice(span) ? withCost(span, priced) : span)),
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
 * Picks the team model that prices `model`: an exact public-name match wins over an
 * upstream-id match, and either wins over a match on the date-stripped id. `priced` is
 * newest-edit first, so ties go to the most recently updated model.
 */
function findTeamPrice(model: string, priced: PricedGatewayModel[]): PricedGatewayModel | undefined {
  const bare = stripDateSuffix(model);
  return (
    priced.find((m) => m.publicName === model) ??
    priced.find((m) => m.upstreamModel === model) ??
    priced.find((m) => m.publicName === bare || m.upstreamModel === bare)
  );
}

/** Returns `span` with `costUsd` set from the team price, else the registry, else unchanged. */
function withCost(span: IngestSpan, priced: PricedGatewayModel[]): IngestSpan {
  const promptTokens = span.usage!.promptTokens!;
  const completionTokens = span.usage!.completionTokens!;
  const cachedTokens = span.usage!.cachedTokens;
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: span.usage!.totalTokens ?? promptTokens + completionTokens,
    ...(cachedTokens ? { cached_tokens: cachedTokens } : {}),
  };
  const team = findTeamPrice(span.model!, priced);
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
