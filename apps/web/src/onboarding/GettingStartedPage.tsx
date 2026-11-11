import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ApiError, useCreatePersonalKey, useTools } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ConnectionDialog } from '@/gateway/ConnectionDialog';
import { ModelDialog } from '@/gateway/ModelDialog';
import { cn } from '@/lib/cn';
import { Button, CopyButton, PageSpinner, Tabs, useToast } from '@/ui';
import { DIRECT_PROVIDERS, STEP_TITLES, buildDirectSnippet, buildSnippet, buildToolSnippet, stepNumber, stepTitle } from './checklist';
import type { DirectProvider, SetupPath, SnippetLang } from './checklist';
import { useChecklist } from './useChecklist';
import { BYO_GUIDE_URL, DOCS_GUIDES } from '@/gateway/StoredKeyRequired';

/**
 * The query flag the post-sign-in default destination carries. With it, a team that
 * had already finished every step when the page opened is sent straight on to its
 * prompts, so returning users do not stop at a checklist they completed long ago.
 */
export const FROM_SIGN_IN_PARAM = 'from';
const FROM_SIGN_IN_VALUE = 'signin';


/**
 * Optional features to try once the first request works. Shown as links, not as
 * checklist steps: many teams never use some of them, so as steps they would keep
 * the checklist unfinished.
 */
const NEXT_GUIDES: { title: string; summary: string; href: string }[] = [
  {
    title: 'Connect a tool to a prompt',
    summary: 'Bind a catalog tool to a prompt, and choose which build of it each prompt alias calls.',
    href: `${DOCS_GUIDES}/connect-a-tool-to-a-prompt`,
  },
  {
    title: 'Collect feedback',
    summary: 'Record user feedback on replies from the SDK.',
    href: `${DOCS_GUIDES}/use-the-sdk-for-chat-and-feedback`,
  },
  {
    title: 'Improve a prompt from feedback',
    summary: 'Turn replies your team disagreed with into prompt rewrites, then score them.',
    href: `${DOCS_GUIDES}/improve-a-prompt-from-feedback`,
  },
  {
    title: 'Score live traffic with a judge',
    summary: 'Have a judge model score matching gateway calls as they arrive.',
    href: `${DOCS_GUIDES}/score-live-traffic-with-an-evaluation-rule`,
  },
  {
    title: 'Evaluate against a dataset',
    summary: 'Run prompt versions and models over a test set and compare the scores.',
    href: `${DOCS_GUIDES}/evaluate-a-prompt`,
  },
];

const LANGS: { value: SnippetLang; label: string }[] = [
  { value: 'curl', label: 'curl' },
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node' },
];

/** The direct path has no curl version: the SDK writes the trace, so the SDK is needed. */
const DIRECT_LANGS: { value: 'python' | 'node'; label: string }[] = [
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node' },
];

const DIRECT_PROVIDER_TABS = (Object.keys(DIRECT_PROVIDERS) as DirectProvider[]).map((value) => ({
  value,
  label: DIRECT_PROVIDERS[value].label,
}));

const PATH_OPTIONS: { value: SetupPath; title: string; summary: string }[] = [
  {
    value: 'gateway',
    title: 'Through the gateway',
    summary: 'Store your provider key in AcruxCore. Calls go through the gateway, which adds budgets, rate limits, caching and fallbacks.',
  },
  {
    value: 'direct',
    title: 'Call your provider directly',
    summary: 'Keep your provider key in your own code. The SDK calls the provider and sends AcruxCore only the trace.',
  },
];

/**
 * First screen for a new team: the steps from an empty account to a traced call.
 * The team picks a path first: through the gateway (four steps) or straight to its
 * provider with its own key (two steps). Each step is ticked from the team's real
 * data, so the page also shows a returning user exactly where they stopped.
 */
export function GettingStartedPage() {
  const { canManageTeam } = useAuth();
  const [searchParams] = useSearchParams();
  const fromSignIn = searchParams.get(FROM_SIGN_IN_PARAM) === FROM_SIGN_IN_VALUE;

  const { loaded, failed, retry, path, setPath, steps, active, doneCount, isDone, connections, models } = useChecklist({ poll: true });
  const createKey = useCreatePersonalKey();
  const toast = useToast();

  // The plaintext key exists only in this response; the API keeps a hash. Holding it
  // here is what lets the snippet below carry a key that works on the first paste.
  const [newKey, setNewKey] = useState<string | null>(null);
  const [lang, setLang] = useState<SnippetLang>('curl');
  const [directLang, setDirectLang] = useState<'python' | 'node'>('python');
  const [directProvider, setDirectProvider] = useState<DirectProvider>('openai');
  const [toolLang, setToolLang] = useState<'python' | 'node'>('python');
  // Poll only once the optional tool step can open: before the first request it is not
  // shown, so a tab left on step 1 should not read /tools every 5 s.
  const tools = useTools({ pollWhileEmptyMs: isDone('firstRequest') ? 5_000 : undefined });
  // The credential and model forms open here, over the checklist, rather than on their
  // own pages: leaving for /gateway/connections stranded people there with no way back
  // to the next step except the sidebar.
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  const preRequestDone = steps.filter((s) => s.id !== 'firstRequest').every((s) => s.done);
  const allDone = active === null;

  // Decided once, from the first status that loads. Checking on every render sent a
  // user who finished the last step here (say, by creating a key) on to /prompts at
  // once, and the key, which is shown only once, went with the page.
  const skipChecklist = useRef<boolean | null>(null);
  if (loaded && skipChecklist.current === null) skipChecklist.current = fromSignIn && allDone;

  if (failed) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 rounded-xl border border-line bg-surface px-4 py-4" data-testid="onboarding-error">
        <p className="text-[13.5px] font-medium text-ink">Could not load your setup progress.</p>
        <p className="text-[13px] text-muted">The page tries again every few seconds. You can also retry now, or carry on without it.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={retry}>Try again</Button>
          <Link to="/prompts" className="text-[13px] text-accent hover:underline">Go to prompts</Link>
        </div>
      </div>
    );
  }

  if (!loaded) return <PageSpinner />;

  if (skipChecklist.current) return <Navigate to="/prompts" replace />;

  const baseUrl = `${window.location.origin}/api/v1`;
  const model = models.data?.[0]?.publicName ?? null;
  const snippet = buildSnippet(lang, { baseUrl, apiKey: newKey, model });
  const directSnippet = buildDirectSnippet(directLang, directProvider, { baseUrl, apiKey: newKey, model: null });
  const toolSnippet = buildToolSnippet(toolLang, path, directProvider, { baseUrl, apiKey: newKey, model });
  const toolCount = tools.data?.length ?? 0;

  const onCreateKey = async () => {
    try {
      const created = await createKey.mutateAsync({ name: 'Getting started' });
      setNewKey(created.key);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create the key');
    }
  };

  const adminOnly = !canManageTeam && (
    <p className="text-[12.5px] text-faint">Only a team owner or admin can do this step. Ask one of them.</p>
  );

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Get started</h1>
        <p className="mt-1 text-[13px] text-muted">
          {path === 'gateway' ? 'Four' : 'Two'} steps from an empty account to your first traced LLM
          call. Each step is marked done when you finish it.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${(doneCount / steps.length) * 100}%` }}
            />
          </div>
          <span className="text-[12px] tabular-nums text-muted" data-testid="onboarding-progress">
            {doneCount} of {steps.length} done
          </span>
        </div>
      </header>

      <PathChoice path={path} onChange={setPath} />

      {allDone && (
        <div className="rounded-xl border border-accent/40 bg-accent/10 px-4 py-3.5 text-[13px] text-ink">
          You are set up. Your calls now show in{' '}
          <Link to="/traces" className="text-accent hover:underline">Traces</Link>. Next, try{' '}
          <Link to="/prompts" className="text-accent hover:underline">versioning a prompt</Link> or{' '}
          {path === 'gateway' ? (
            <Link to="/gateway/budgets" className="text-accent hover:underline">setting a budget</Link>
          ) : (
            <a href={`${DOCS_GUIDES}/use-the-sdk-for-chat-and-feedback`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              collecting feedback
            </a>
          )}.
        </div>
      )}

      <ol className="flex flex-col gap-3">
        {path === 'gateway' && (<>
        <Step
          n={1}
          title={STEP_TITLES.credential}
          done={isDone('credential')}
          active={active === 'credential'}
          summary={
            isDone('credential')
              ? connections.data
                ? `${connections.data.length} credential${connections.data.length === 1 ? '' : 's'} saved.`
                : 'Credential saved.'
              : 'Save the API key of the provider you already use: OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint such as OpenRouter.'
          }
        >
          <p className="text-[13px] text-muted">
            The key is encrypted at rest and never shown again. Your app never sees the provider
            key. It sends your AcruxCore key instead.
          </p>
          {canManageTeam ? (
            <Button variant={isDone('credential') ? 'default' : 'primary'} onClick={() => setCredentialOpen(true)}>
              {isDone('credential') ? 'Add another credential' : 'Add a credential'}
            </Button>
          ) : adminOnly}
        </Step>

        <Step
          n={2}
          title={STEP_TITLES.model}
          done={isDone('model')}
          active={active === 'model'}
          summary={
            isDone('model')
              ? models.data?.length
                ? `Your app can call ${models.data.map((m) => `"${m.publicName}"`).slice(0, 3).join(', ')}.`
                : 'Model added.'
              : 'Give a provider model a public name. Your code sends this name, so you can change the real model later without a deploy.'
          }
        >
          <p className="text-[13px] text-muted">
            For example, set the public name to <code className="font-mono text-ink">support-model</code> and
            the upstream model to <code className="font-mono text-ink">gpt-4o-mini</code>.
          </p>
          {canManageTeam && !isDone('credential') && (
            <p className="text-[12.5px] text-faint">A model points at a credential, so add the credential in step 1 first.</p>
          )}
          {canManageTeam ? (
            <Button
              variant={isDone('model') ? 'default' : 'primary'}
              onClick={() => setModelOpen(true)}
              disabled={!isDone('credential')}
            >
              {isDone('model') ? 'Add another model' : 'Add a model'}
            </Button>
          ) : adminOnly}
        </Step>
        </>)}

        <Step
          n={stepNumber('apiKey', path)}
          title={STEP_TITLES.apiKey}
          done={isDone('apiKey')}
          active={active === 'apiKey' || newKey !== null}
          summary={
            newKey
              ? 'Key created. Save it now: it will not be shown again.'
              : isDone('apiKey')
                ? canManageTeam
                  ? 'Your team has a key. If you need a new one, create it here.'
                  : 'Your team has a key. Ask an owner or admin if you need one.'
                : path === 'direct'
                  ? 'The SDK sends your traces to AcruxCore with this key. It is not your provider key.'
                  : 'Your code and the SDKs sign each request with this key.'
          }
        >
          {newKey ? (
            <div className="flex w-full min-w-0 flex-col gap-2">
              <div
                role="alert"
                className="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2.5 text-[13px] text-ink"
                data-testid="onboarding-save-key"
              >
                <span className="font-medium">Save this key now.</span> It will not be shown
                again. AcruxCore stores only a hash of it, so a lost key cannot be recovered.
                Copy it into a password manager or your app's secret store before you leave
                this page.
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-line-soft bg-bg px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" data-testid="onboarding-new-key">
                  {newKey}
                </code>
                <CopyButton value={newKey} />
              </div>
            </div>
          ) : !canManageTeam ? (
            adminOnly
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant={isDone('apiKey') ? 'default' : 'primary'} onClick={onCreateKey} disabled={createKey.isPending}>
                {createKey.isPending ? 'Creating…' : isDone('apiKey') ? 'Create another key' : 'Create a key'}
              </Button>
              <Link to="/account" className="text-[13px] text-accent hover:underline">Manage keys</Link>
            </div>
          )}
        </Step>

        {path === 'direct' ? (
          <Step
            n={stepNumber('firstRequest', path)}
            title={stepTitle('firstRequest', path)}
            done={isDone('firstRequest')}
            active={active === 'firstRequest' || preRequestDone}
            summary={
              isDone('firstRequest')
                ? 'A trace reached AcruxCore. It is in your traces.'
                : 'Run this with your own provider key in an environment variable. The SDK calls the provider and records the trace.'
            }
          >
            <div className="w-full min-w-0 self-stretch overflow-hidden rounded-lg border border-line-soft" data-testid="onboarding-direct">
              <Tabs
                items={DIRECT_PROVIDER_TABS}
                value={directProvider}
                onChange={(v) => setDirectProvider(v as DirectProvider)}
                className="overflow-x-auto overflow-y-hidden bg-surface"
              />
              <div className="flex items-center justify-between border-t border-line-soft bg-surface pr-2">
                <Tabs items={DIRECT_LANGS} value={directLang} onChange={(v) => setDirectLang(v as 'python' | 'node')} className="border-b-0" />
                <CopyButton value={directSnippet} />
              </div>
              <pre
                className="overflow-x-auto border-t border-line-soft bg-bg px-3 py-3 font-mono text-[12px] leading-relaxed text-ink"
                data-testid="onboarding-direct-snippet"
              >
                {directSnippet}
              </pre>
            </div>
            <p className="text-[12.5px] text-faint">
              {newKey ? '' : 'Replace the key placeholder with your AcruxCore key. '}
              Any model name your provider accepts works here. Prompts, tools, traces and feedback
              all work on this path.{' '}
              <a href={BYO_GUIDE_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                What needs a stored key
              </a>
            </p>
            {isDone('firstRequest') ? (
              <Link to="/traces"><Button variant="primary">Open traces</Button></Link>
            ) : (
              <p className="text-[12.5px] text-muted">
                <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent align-middle" />
                Waiting for your first trace. This step is marked done when it arrives.
              </p>
            )}
          </Step>
        ) : (
        <Step
          n={stepNumber('firstRequest', path)}
          title={STEP_TITLES.firstRequest}
          done={isDone('firstRequest')}
          // Stays open once the setup steps are done, so the "Open traces" button that
          // appears when the request lands is not hidden by the step collapsing.
          active={active === 'firstRequest' || preRequestDone}
          summary={
            isDone('firstRequest')
              ? 'A request reached AcruxCore. It is in your traces.'
              : 'Run this from your terminal. The gateway routes it, prices it and records a trace.'
          }
        >
          <div className="w-full min-w-0 self-stretch overflow-hidden rounded-lg border border-line-soft">
            <div className="flex items-center justify-between bg-surface pr-2">
              <Tabs items={LANGS} value={lang} onChange={(v) => setLang(v as SnippetLang)} className="border-b-0" />
              <CopyButton value={snippet} />
            </div>
            <pre
              className="overflow-x-auto border-t border-line-soft bg-bg px-3 py-3 font-mono text-[12px] leading-relaxed text-ink"
              data-testid="onboarding-snippet"
            >
              {snippet}
            </pre>
          </div>
          {!newKey && (
            <p className="text-[12.5px] text-faint">
              Replace the key placeholder with your key. To have it filled in for you, create a new
              key in step 3.
            </p>
          )}
          {isDone('firstRequest') ? (
            <Link to="/traces"><Button variant="primary">Open traces</Button></Link>
          ) : (
            <p className="text-[12.5px] text-muted">
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent align-middle" />
              Waiting for your first request. This step is marked done when the request arrives.
              {isDone('model') && (
                <>
                  {' '}If you have no terminal, try the{' '}
                  <Link to="/gateway/playground" className="text-accent hover:underline">Playground</Link>.
                </>
              )}
            </p>
          )}
        </Step>
        )}

        {/* Optional, so it is not in the progress count: a team that never uses tools
            still finishes setup. It opens once the first call works. */}
        <Step
          n={steps.length + 1}
          title="Give the model a tool"
          optional
          done={toolCount > 0}
          active={isDone('firstRequest') && tools.isSuccess && toolCount === 0}
          summary={
            toolCount > 0
              ? `Your team has ${toolCount} tool${toolCount === 1 ? '' : 's'} in its catalog.`
              : 'Define a function in your code and let the model call it. The SDK runs it and saves it to your tool catalog.'
          }
        >
          <div className="w-full min-w-0 self-stretch overflow-hidden rounded-lg border border-line-soft" data-testid="onboarding-tool">
            {path === 'direct' && (
              <Tabs
                items={DIRECT_PROVIDER_TABS}
                value={directProvider}
                onChange={(v) => setDirectProvider(v as DirectProvider)}
                className="overflow-x-auto overflow-y-hidden bg-surface"
              />
            )}
            <div className={cn('flex items-center justify-between bg-surface pr-2', path === 'direct' && 'border-t border-line-soft')}>
              <Tabs items={DIRECT_LANGS} value={toolLang} onChange={(v) => setToolLang(v as 'python' | 'node')} className="border-b-0" />
              <CopyButton value={toolSnippet} />
            </div>
            <pre
              className="overflow-x-auto border-t border-line-soft bg-bg px-3 py-3 font-mono text-[12px] leading-relaxed text-ink"
              data-testid="onboarding-tool-snippet"
            >
              {toolSnippet}
            </pre>
          </div>
          <p className="text-[12.5px] text-faint">
            The model asks for the weather in two cities, and the loop runs{' '}
            <code className="font-mono text-ink">get_weather</code> in your process for each call.
            The tool is also saved to your team&apos;s catalog, so it shows under Tools.{' '}
            <a href={`${DOCS_GUIDES}/create-a-tool`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Other ways to create a tool
            </a>
          </p>
          {toolCount > 0 ? (
            <Link to="/tools"><Button variant="primary">Open tools</Button></Link>
          ) : (
            <p className="text-[12.5px] text-muted">
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent align-middle" />
              Waiting for a tool. This step is marked done when one is in your catalog.
            </p>
          )}
        </Step>
      </ol>

      <p className="text-[12.5px] text-faint">
        The longer version, with a stored prompt, is in the{' '}
        <a
          href="https://docs.acruxcore.com/docs/getting-started/quickstart"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          Quickstart
        </a>
        .
      </p>

      <section aria-labelledby="next-guides-heading" className="flex flex-col gap-3" data-testid="onboarding-next">
        <h2 id="next-guides-heading" className="text-[14px] font-medium text-ink">What to do next</h2>
        <ul className="grid gap-2 lg:grid-cols-2">
          {NEXT_GUIDES.map((g) => (
            <li key={g.href} className="min-w-0">
              <a
                href={g.href}
                target="_blank"
                rel="noreferrer"
                className="group flex h-full flex-col gap-0.5 rounded-lg border border-line bg-surface px-3.5 py-3 transition-colors hover:border-accent/50"
              >
                <span className="text-[13.5px] font-medium text-ink group-hover:text-accent">
                  {g.title}
                  {'\u00a0'}
                  <span aria-hidden="true">↗</span>
                </span>
                <span className="text-[12.5px] text-muted">{g.summary}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <ConnectionDialog open={credentialOpen} onOpenChange={setCredentialOpen} />
      <ModelDialog open={modelOpen} onOpenChange={setModelOpen} />
    </div>
  );
}

interface StepProps {
  n: number;
  title: string;
  /** Shows an "Optional" tag; the step is left out of the progress count by the caller. */
  optional?: boolean;
  summary: string;
  done: boolean;
  /** Open steps show their body; a done step that is not active collapses to its summary. */
  active: boolean;
  children: ReactNode;
}

/** One numbered checklist row: a status circle, the title, a summary and, when open, the step's body. */
function Step({ n, title, optional, summary, done, active, children }: StepProps) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? active;
  return (
    <li
      className={cn(
        'min-w-0 rounded-xl border bg-surface transition-colors',
        active && !done ? 'border-accent/50' : 'border-line',
      )}
      data-testid={`onboarding-step-${n}`}
      data-done={done}
    >
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
      >
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full border text-[12px] font-semibold',
            done ? 'border-accent bg-accent text-accent-ink' : 'border-line text-muted',
          )}
          aria-label={done ? 'Done' : `Step ${n}`}
        >
          {done ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5L20 7" />
            </svg>
          ) : (
            n
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('flex items-center gap-2 text-[14px] font-medium', done ? 'text-muted' : 'text-ink')}>
            {title}
            {optional && (
              <span className="rounded-full border border-line px-1.5 py-px text-[11px] font-normal text-muted">Optional</span>
            )}
          </span>
          <span className="mt-0.5 block text-[12.5px] text-muted">{summary}</span>
        </span>
        <svg
          className={cn('mt-1 flex-none text-faint transition-transform', open && 'rotate-180')}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && <div className="flex min-w-0 flex-col items-start gap-3 px-4 pb-4 pl-[52px]">{children}</div>}
    </li>
  );
}

/**
 * The two setup paths as a radio group. The choice changes only which steps the page
 * shows; the steps are always ticked from the team's real data.
 */
function PathChoice({ path, onChange }: { path: SetupPath; onChange: (path: SetupPath) => void }) {
  return (
    <section aria-labelledby="setup-path-heading" className="flex flex-col gap-2">
      <h2 id="setup-path-heading" className="text-[13px] font-medium text-ink">How will your app call its model?</h2>
      <div role="radiogroup" aria-labelledby="setup-path-heading" className="grid gap-2 sm:grid-cols-2">
        {PATH_OPTIONS.map((o) => {
          const selected = o.value === path;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.value)}
              data-testid={`setup-path-${o.value}`}
              className={cn(
                'flex min-w-0 items-start gap-3 rounded-xl border bg-surface px-3.5 py-3 text-left transition-colors',
                selected ? 'border-accent bg-accent/5' : 'border-line hover:border-accent/50',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border',
                  selected ? 'border-accent' : 'border-line',
                )}
              >
                {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-ink">{o.title}</span>
                <span className="mt-0.5 block text-[12.5px] text-muted">{o.summary}</span>
              </span>
            </button>
          );
        })}
      </div>
      {path === 'direct' && (
        <p className="text-[12.5px] text-faint">
          The Playground, server-side evaluation runs, the optimizer and judge rules run on
          AcruxCore's servers, so they still need a stored key.{' '}
          <a href={BYO_GUIDE_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Read the guide
          </a>
          .
        </p>
      )}
    </section>
  );
}
