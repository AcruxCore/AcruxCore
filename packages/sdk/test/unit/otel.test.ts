import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The real OTLPTraceExporter never makes a network call at construction time — only
 * when a span actually flushes — but its `url`/`headers` end up buried behind an
 * internal transport delegate (see `@opentelemetry/otlp-exporter-base`'s node-http
 * helpers), which is too version-fragile to introspect in a test. Mocking the
 * constructor instead lets these tests assert exactly what config `register()`'s own
 * logic computed, independent of the exporter's internals.
 */
const otlpExporterCalls: Array<{ url?: string; headers?: Record<string, string> }> = [];

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor(config: { url?: string; headers?: Record<string, string> } = {}) {
      otlpExporterCalls.push(config);
    }
    export(): void {}
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
    forceFlush(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { trace } from '@opentelemetry/api';
import { acruxcoreError } from '../../src/error';
import { register, SUPPORTED_FRAMEWORKS } from '../../src/otel';

/**
 * `@opentelemetry/api`'s `trace.setGlobalTracerProvider()` only takes effect once per
 * process — a second call to `registerGlobal` returns `false` and the delegate is left
 * untouched (see `@opentelemetry/api`'s `internal/global-utils.js`). `trace.disable()`
 * clears the registration flag but not the proxy's stored delegate, so both must be
 * reset directly between tests or a later test silently sees an earlier one's provider.
 */
function resetGlobalTracerProvider(): void {
  trace.disable();
  (trace as unknown as { _proxyTracerProvider: { _delegate?: unknown } })._proxyTracerProvider._delegate =
    undefined;
}

beforeEach(() => {
  otlpExporterCalls.length = 0;
  resetGlobalTracerProvider();
});

afterEach(async () => {
  resetGlobalTracerProvider();
  // register() installs a context manager and the step bridge process-wide; leave
  // neither behind for the next test.
  (await import('@opentelemetry/api')).context.disable();
  (await import('../../src/steps')).setStepContextBridge(undefined);
  delete process.env.ACRUXCORE_API_KEY;
  delete process.env.ACRUXCORE_BASE_URL;
});

describe('register()', () => {
  describe('config resolution', () => {
    it('throws MISSING_API_KEY when no key is given or set', async () => {
      delete process.env.ACRUXCORE_API_KEY;
      await expect(register({ baseUrl: 'https://x/api/v1' })).rejects.toMatchObject({
        code: 'MISSING_API_KEY',
      });
    });

    it('throws MISSING_BASE_URL when no base URL is given or set', async () => {
      delete process.env.ACRUXCORE_BASE_URL;
      await expect(register({ apiKey: 'k' })).rejects.toBeInstanceOf(acruxcoreError);
      await expect(register({ apiKey: 'k' })).rejects.toMatchObject({ code: 'MISSING_BASE_URL' });
    });

    it('throws instances of acruxcoreError, not a bare Error', async () => {
      delete process.env.ACRUXCORE_API_KEY;
      await expect(register({ baseUrl: 'https://x/api/v1' })).rejects.toBeInstanceOf(acruxcoreError);
    });

    it('falls back to env vars', async () => {
      process.env.ACRUXCORE_API_KEY = 'env-key';
      process.env.ACRUXCORE_BASE_URL = 'https://api.acruxcore.com/api/v1';
      await register({ setGlobal: false });
      expect(otlpExporterCalls).toHaveLength(1);
      expect(otlpExporterCalls[0].url).toBe('https://api.acruxcore.com/api/v1/traces/otlp');
      expect(otlpExporterCalls[0].headers).toEqual({ Authorization: 'Bearer env-key' });
    });

    it('prefers explicit args over env vars', async () => {
      process.env.ACRUXCORE_API_KEY = 'env-key';
      process.env.ACRUXCORE_BASE_URL = 'https://env-host/api/v1';
      await register({ apiKey: 'explicit-key', baseUrl: 'https://explicit-host/api/v1', setGlobal: false });
      expect(otlpExporterCalls[0].url).toBe('https://explicit-host/api/v1/traces/otlp');
      expect(otlpExporterCalls[0].headers).toEqual({ Authorization: 'Bearer explicit-key' });
    });

    it('strips trailing slashes from baseUrl', async () => {
      await register({ apiKey: 'k', baseUrl: 'https://x/api/v1///', setGlobal: false });
      expect(otlpExporterCalls[0].url).toBe('https://x/api/v1/traces/otlp');
    });

    it('reports serviceName as the service.name resource attribute', async () => {
      const provider = await register({
        apiKey: 'k',
        baseUrl: 'https://x/api/v1',
        serviceName: 'my-crew',
        setGlobal: false,
      });
      // `TracerProvider` (sdk-trace 2.x) dropped the public `.resource` getter earlier
      // versions had — `_resource` is the only way to inspect it, same as the SDK's
      // own `inspect()` implementation does internally.
      expect((provider as unknown as { _resource: { attributes: Record<string, unknown> } })._resource.attributes[
        'service.name'
      ]).toBe('my-crew');
    });

    it('defaults serviceName to acruxcore-instrumented-app', async () => {
      const provider = await register({ apiKey: 'k', baseUrl: 'https://x/api/v1', setGlobal: false });
      expect((provider as unknown as { _resource: { attributes: Record<string, unknown> } })._resource.attributes[
        'service.name'
      ]).toBe('acruxcore-instrumented-app');
    });
  });

  describe('setGlobal', () => {
    it('installs the provider as the process-wide default by default', async () => {
      const provider = await register({ apiKey: 'k', baseUrl: 'https://x/api/v1' });
      const delegate = (trace.getTracerProvider() as unknown as { getDelegate(): unknown }).getDelegate();
      expect(delegate).toBe(provider);
    });

    it('leaves the process-wide provider untouched when setGlobal is false', async () => {
      const provider = await register({ apiKey: 'k', baseUrl: 'https://x/api/v1', setGlobal: false });
      const delegate = (trace.getTracerProvider() as unknown as { getDelegate(): unknown }).getDelegate();
      expect(delegate).not.toBe(provider);
    });
  });

  describe('instrument: [...]', () => {
    it('throws UNKNOWN_INSTRUMENTOR for a name outside SUPPORTED_FRAMEWORKS', async () => {
      await expect(
        register({
          apiKey: 'k',
          baseUrl: 'https://x/api/v1',
          // @ts-expect-error — deliberately outside SupportedFramework for this test
          instrument: ['not-a-real-framework'],
          setGlobal: false,
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_INSTRUMENTOR' });
    });

    it.each(['openai', 'openai_agents', 'langchain'] as const)(
      'throws INSTRUMENTOR_NOT_INSTALLED with an install hint for %s when its packages are missing',
      async (name) => {
        // Neither framework's own package nor its OpenInference instrumentation
        // package is installed in this SDK's own devDependencies (unlike the Python
        // SDK's test suite, an npm workspace can't guarantee these two independently
        // published packages resolve to the same physical location the instrumentor
        // needs — see the package.json history for the hoisting issue this avoided).
        // This still exercises the real dynamic-import-failure path, not a mock.
        let caught: unknown;
        try {
          await register({ apiKey: 'k', baseUrl: 'https://x/api/v1', instrument: [name], setGlobal: false });
        } catch (err) {
          caught = err;
        }
        expect(caught).toMatchObject({ code: 'INSTRUMENTOR_NOT_INSTALLED' });
        // The instrumentation package is imported before the framework package, so
        // its name is what actually appears in the message when neither is installed.
        const expectedPackage = {
          openai: '@arizeai/openinference-instrumentation-openai',
          openai_agents: '@arizeai/openinference-instrumentation-openai-agents',
          langchain: '@arizeai/openinference-instrumentation-langchain',
        }[name];
        expect((caught as Error).message).toContain(expectedPackage);
      },
    );
  });

  it('SUPPORTED_FRAMEWORKS lists openai, openai_agents and langchain', () => {
    expect(SUPPORTED_FRAMEWORKS).toContain('openai');
    expect(SUPPORTED_FRAMEWORKS).toContain('openai_agents');
    expect(SUPPORTED_FRAMEWORKS).toContain('langchain');
  });
});

describe('steps and register() share one trace (issue #789)', () => {
  /** What a step reports and what an OTel span inside it records. */
  interface Seen {
    step?: { traceId: string; spanId: string };
    inner?: { traceId: string; spanId: string };
    otel?: { traceId: string; parentSpanId?: string };
  }

  // `parentSpanContext` on sdk-trace-base 2.x, `parentSpanId` on 1.x.
  function parentOf(span: unknown): string | undefined {
    const s = span as { parentSpanContext?: { spanId: string }; parentSpanId?: string };
    return s.parentSpanContext?.spanId ?? s.parentSpanId;
  }

  afterEach(async () => {
    const { context } = await import('@opentelemetry/api');
    context.disable();
    (await import('../../src/steps')).setStepContextBridge(undefined);
  });

  it('an OTel span started inside traces.step is a child of that step, in its trace', async () => {
    const provider = await register({ apiKey: 'k', baseUrl: 'https://x/api/v1' });
    const { runAsStep } = await import('../../src/steps');
    const sent: Array<{ spans?: Array<{ spanId: string }> }> = [];
    const seen: Seen = {};

    await runAsStep('agent', { kind: 'agent' }, (p) => sent.push(p), {}, undefined, async (step) => {
      seen.step = { traceId: step.traceId, spanId: step.spanId };
      await new Promise((r) => setTimeout(r, 1)); // the context must survive an await
      provider.getTracer('test').startActiveSpan('OpenAI Chat Completions', (span) => {
        seen.otel = { traceId: span.spanContext().traceId, parentSpanId: parentOf(span) };
        span.end();
      });
    });

    expect(seen.otel!.traceId).toBe(seen.step!.traceId.replace(/-/g, ''));
    expect(seen.otel!.parentSpanId).toBe(seen.step!.spanId);
    // The id OTel points at is the id the step reports, so the server links the two.
    expect(sent[0].spans!.map((s) => s.spanId)).toContain(seen.step!.spanId);
  });

  it('an OTel span inside a nested step points at the nested step', async () => {
    const provider = await register({ apiKey: 'k', baseUrl: 'https://x/api/v1' });
    const { runAsStep } = await import('../../src/steps');
    const seen: Seen = {};
    const owner = {}; // one client: only its own steps nest

    await runAsStep('agent', {}, () => {}, owner, undefined, async (outer) => {
      seen.step = { traceId: outer.traceId, spanId: outer.spanId };
      await runAsStep('tool', { kind: 'tool' }, () => {}, owner, undefined, async (inner) => {
        seen.inner = { traceId: inner.traceId, spanId: inner.spanId };
        provider.getTracer('test').startActiveSpan('http', (span) => {
          seen.otel = { traceId: span.spanContext().traceId, parentSpanId: parentOf(span) };
          span.end();
        });
      });
    });

    expect(seen.inner!.traceId).toBe(seen.step!.traceId);
    expect(seen.otel!.parentSpanId).toBe(seen.inner!.spanId);
  });

  it("a step inside a framework's own OTel span leaves that span's trace alone", async () => {
    const provider = await register({ apiKey: 'k', baseUrl: 'https://x/api/v1' });
    const { runAsStep } = await import('../../src/steps');
    const tracer = provider.getTracer('test');
    let framework: { traceId: string; spanId: string } | undefined;
    let llm: { traceId: string; parentSpanId?: string } | undefined;

    // LangChain's tool span is active, and the tool function is wrapped in a step.
    await tracer.startActiveSpan('langchain.tool', async (toolSpan) => {
      framework = { traceId: toolSpan.spanContext().traceId, spanId: toolSpan.spanContext().spanId };
      await runAsStep('search', { kind: 'tool' }, () => {}, {}, undefined, async () => {
        tracer.startActiveSpan('OpenAI Chat Completions', (span) => {
          llm = { traceId: span.spanContext().traceId, parentSpanId: parentOf(span) };
          span.end();
        });
      });
      toolSpan.end();
    });

    expect(llm!.traceId).toBe(framework!.traceId);
    expect(llm!.parentSpanId).toBe(framework!.spanId);
  });

  it('does not reparent OTel spans when another tracer provider owns the process', async () => {
    const { BasicTracerProvider } = await import('@opentelemetry/sdk-trace-base');
    const other = new BasicTracerProvider();
    trace.setGlobalTracerProvider(other); // Sentry, say, registered first
    const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
    const { context } = await import('@opentelemetry/api');
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

    await register({ apiKey: 'k', baseUrl: 'https://x/api/v1' }); // cannot become global
    const { runAsStep } = await import('../../src/steps');
    let parent: string | undefined = 'unset';
    let stepTrace = '';
    let spanTrace = '';

    await runAsStep('job', {}, () => {}, {}, undefined, async (step) => {
      stepTrace = step.traceId.replace(/-/g, '');
      trace.getTracer('sentry').startActiveSpan('db.query', (span) => {
        parent = parentOf(span);
        spanTrace = span.spanContext().traceId;
        span.end();
      });
    });

    // The other tracer's span starts its own trace, as it did before the bridge existed.
    expect(parent).toBeUndefined();
    expect(spanTrace).not.toBe(stepTrace);
  });
});
