/**
 * Convenience wiring for AcruxCore's OTLP trace ingestion endpoint.
 *
 * AcruxCore accepts traces from any OpenTelemetry (OTel) source at
 * `POST /api/v1/traces/otlp` — the OpenAI Agents SDK, LangChain, or a hand-rolled OTel
 * pipeline all work with nothing but a `TracerProvider`, a `BatchSpanProcessor`, and an
 * OTLP exporter pointed at that endpoint. This module is optional sugar over that same
 * wiring: it does not change what the endpoint accepts, and a hand-written pipeline
 * works identically.
 *
 * The OTel packages this module imports are optional peer dependencies of
 * `@acruxcoreai/sdk` — install them alongside the SDK to use `register()`:
 * `npm install @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base
 * @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions`.
 * Framework auto-instrumentation via `instrument: [...]` additionally requires that
 * framework's own package and its `@arizeai/openinference-instrumentation-*` package;
 * {@link register} raises a clear error naming the missing package rather than
 * installing it for you.
 */

import { acruxcoreError } from './error';

/** One entry in {@link SUPPORTED_FRAMEWORKS}'s backing registry. */
interface InstrumentorEntry {
  /** The framework's own npm package — dynamically imported and handed to `manuallyInstrument()`. */
  frameworkPackage: string;
  /** The `@arizeai/openinference-instrumentation-*` package providing the instrumentation class. */
  instrumentationPackage: string;
  /** Name of the exported `InstrumentationBase` subclass within `instrumentationPackage`. */
  className: string;
}

const INSTRUMENTOR_REGISTRY = {
  openai: {
    frameworkPackage: 'openai',
    instrumentationPackage: '@arizeai/openinference-instrumentation-openai',
    className: 'OpenAIInstrumentation',
  },
  openai_agents: {
    frameworkPackage: '@openai/agents',
    instrumentationPackage: '@arizeai/openinference-instrumentation-openai-agents',
    className: 'OpenAIAgentsInstrumentation',
  },
} as const satisfies Record<string, InstrumentorEntry>;

/**
 * Framework names accepted by `register({ instrument: [...] })`, sorted for display.
 *
 * Shorter than the Python SDK's list by design: LangChain.js's OpenInference
 * instrumentor patches `@langchain/core/callbacks/manager` rather than the top-level
 * package, and LlamaIndex.TS's `@arizeai/openinference-instrumentation-llama-index` is
 * an empty placeholder as of `0.0.12` — neither has a stable wiring to hardcode yet.
 * Both frameworks still work with {@link register}'s bare pipeline plus their own
 * hand-wired instrumentor, the same as any framework outside this list.
 */
export const SUPPORTED_FRAMEWORKS = Object.keys(INSTRUMENTOR_REGISTRY).sort() as SupportedFramework[];

/** A framework name accepted by `register({ instrument: [...] })`. */
export type SupportedFramework = keyof typeof INSTRUMENTOR_REGISTRY;

/** Options for {@link register}. */
export interface RegisterOptions {
  /** AcruxCore API key. Falls back to `ACRUXCORE_API_KEY`. */
  apiKey?: string;
  /** AcruxCore API base URL, e.g. `https://api.acruxcore.com/api/v1`. Falls back to `ACRUXCORE_BASE_URL`. */
  baseUrl?: string;
  /** Reported as the OTel `service.name` resource attribute. Defaults to `acruxcore-instrumented-app`. */
  serviceName?: string;
  /**
   * Framework names to auto-instrument against the returned provider, e.g.
   * `['openai_agents']`. See {@link SUPPORTED_FRAMEWORKS} for the full list. Each
   * name's framework package and OpenInference instrumentation package must already
   * be installed; this only instruments them, it never installs anything.
   */
  instrument?: SupportedFramework[];
  /**
   * Also install the provider process-wide via `NodeTracerProvider#register()`
   * (default `true`) — not just `trace.setGlobalTracerProvider`, but also an
   * `AsyncLocalStorageContextManager` and a W3C propagator. Without that context
   * manager, OTel context (parent spans, `context.with()` session grouping) does
   * not survive an `await`, so turning this off requires wiring an equivalent
   * context manager yourself before any instrumented async code runs.
   */
  setGlobal?: boolean;
}

/**
 * Builds an OTel `NodeTracerProvider` that exports straight to AcruxCore.
 *
 * Collapses the `NodeTracerProvider` + `BatchSpanProcessor` + `OTLPTraceExporter`
 * wiring every OTLP tracing tutorial hand-writes into one call, and optionally
 * instruments a named framework's own package against the resulting provider.
 *
 * OTel's own instrumentation classes patch a framework via `require()` hooks, which
 * never fire for an ESM `import` — so this dynamically imports each requested
 * framework's package itself and passes it to the instrumentor's
 * `manuallyInstrument()`, which works in both module systems. Because Node resolves a
 * given package to one cached module instance per process, the object patched here is
 * the same one any later `import` in the caller's own code sees.
 *
 * @param options - See {@link RegisterOptions}.
 * @returns The configured `NodeTracerProvider` — pass it to instrumentors you wire
 *   yourself, or to `@arizeai/openinference-core`'s `context.with(setSession(...))`.
 * @throws {acruxcoreError} `OTEL_NOT_AVAILABLE` if the OTel peer dependencies aren't
 *   installed; `MISSING_API_KEY` / `MISSING_BASE_URL` if required config is absent;
 *   `UNKNOWN_INSTRUMENTOR` for a name outside {@link SUPPORTED_FRAMEWORKS};
 *   `INSTRUMENTOR_NOT_INSTALLED` if that framework's package or OpenInference package
 *   isn't installed.
 */
export async function register(options: RegisterOptions = {}) {
  let sdkTraceNode: typeof import('@opentelemetry/sdk-trace-node');
  let sdkTraceBase: typeof import('@opentelemetry/sdk-trace-base');
  let exporterOtlpHttp: typeof import('@opentelemetry/exporter-trace-otlp-http');
  let resources: typeof import('@opentelemetry/resources');
  let semconv: typeof import('@opentelemetry/semantic-conventions');
  try {
    // @opentelemetry/api itself is not imported directly here — sdk-trace-node
    // requires it internally, so a missing install already fails this Promise.all.
    [sdkTraceNode, sdkTraceBase, exporterOtlpHttp, resources, semconv] = await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);
  } catch (exc) {
    throw new acruxcoreError(
      'acruxcore/otel register() needs the OTel peer dependencies: npm install ' +
        '@opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base ' +
        '@opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions',
      'OTEL_NOT_AVAILABLE',
    );
  }

  const resolvedKey = options.apiKey ?? process.env.ACRUXCORE_API_KEY;
  if (!resolvedKey) {
    throw new acruxcoreError(
      'acruxcore/otel register(): apiKey is required. Pass it or set ACRUXCORE_API_KEY.',
      'MISSING_API_KEY',
    );
  }

  const resolvedBase = options.baseUrl ?? process.env.ACRUXCORE_BASE_URL;
  if (!resolvedBase) {
    throw new acruxcoreError(
      'acruxcore/otel register(): baseUrl is required. Pass it or set ACRUXCORE_BASE_URL.',
      'MISSING_BASE_URL',
    );
  }

  const endpoint = `${resolvedBase.replace(/\/+$/, '')}/traces/otlp`;
  const exporter = new exporterOtlpHttp.OTLPTraceExporter({
    url: endpoint,
    headers: { Authorization: `Bearer ${resolvedKey}` },
  });
  const provider = new sdkTraceNode.NodeTracerProvider({
    resource: resources.resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: options.serviceName ?? 'acruxcore-instrumented-app',
    }),
    spanProcessors: [new sdkTraceBase.BatchSpanProcessor(exporter)],
  });

  if (options.setGlobal ?? true) {
    // NodeTracerProvider#register() does more than trace.setGlobalTracerProvider():
    // it also installs an AsyncLocalStorageContextManager and a W3C propagator.
    // Without that context manager, OTel context (parent spans, `context.with()`
    // session grouping) does not survive an `await` — it would silently stop
    // propagating past the first async boundary in any real agent framework.
    provider.register();
  }

  for (const name of options.instrument ?? []) {
    await instrumentFramework(name, provider);
  }

  return provider;
}

/** Looks up and instruments one framework by name against the given provider. */
async function instrumentFramework(name: SupportedFramework, provider: unknown): Promise<void> {
  const entry = (INSTRUMENTOR_REGISTRY as Record<string, InstrumentorEntry>)[name];
  if (!entry) {
    throw new acruxcoreError(
      `acruxcore/otel: unknown framework ${JSON.stringify(name)}. Supported: ${SUPPORTED_FRAMEWORKS.join(', ')}.`,
      'UNKNOWN_INSTRUMENTOR',
    );
  }

  let instrumentationModule: Record<string, unknown>;
  try {
    instrumentationModule = (await import(entry.instrumentationPackage)) as Record<string, unknown>;
  } catch (exc) {
    throw new acruxcoreError(
      `acruxcore/otel: instrument=${JSON.stringify(name)} needs "${entry.instrumentationPackage}". ` +
        `Install it with: npm install ${entry.instrumentationPackage}`,
      'INSTRUMENTOR_NOT_INSTALLED',
    );
  }

  let frameworkModule: unknown;
  try {
    frameworkModule = await import(entry.frameworkPackage);
  } catch (exc) {
    throw new acruxcoreError(
      `acruxcore/otel: instrument=${JSON.stringify(name)} needs "${entry.frameworkPackage}". ` +
        `Install it with: npm install ${entry.frameworkPackage}`,
      'INSTRUMENTOR_NOT_INSTALLED',
    );
  }

  const InstrumentationClass = instrumentationModule[entry.className] as new (opts: {
    tracerProvider: unknown;
  }) => { manuallyInstrument(mod: unknown): void };
  const instrumentation = new InstrumentationClass({ tracerProvider: provider });
  instrumentation.manuallyInstrument(frameworkModule);
}
