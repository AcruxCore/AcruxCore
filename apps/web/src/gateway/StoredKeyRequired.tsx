import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useConnections } from '@/api';
import { cn } from '@/lib/cn';
import { Button } from '@/ui';

/** The docs site's guides section, the base for every guide link in the dashboard. */
export const DOCS_GUIDES = 'https://docs.acruxcore.com/docs/guides';
/** The guide for calling a provider directly with the team's own key (BYO). */
export const BYO_GUIDE_URL = `${DOCS_GUIDES}/call-your-provider-directly`;
/** The guide for local experiments, the BYO way to evaluate a dataset. */
export const LOCAL_EXPERIMENT_GUIDE_URL = `${DOCS_GUIDES}/run-your-app-as-an-experiment`;

export interface StoredKeyRequiredProps {
  /** The feature, as the start of a sentence: "The Playground", "An evaluation run". */
  feature: string;
  /** Extra line for a feature that has a BYO alternative, such as local experiments. */
  alternative?: ReactNode;
  /** Tighter layout for a dialog or a form field. */
  compact?: boolean;
  className?: string;
}

/**
 * Shown in place of an empty model picker on a feature that calls a model from
 * AcruxCore's servers: the Playground, evaluation runs, the optimizer and judge rules.
 *
 * Those calls happen with no request from the team's app in progress, so they cannot
 * use a key the app holds (BYO). They need a model on a stored credential. The panel
 * says that, links to the missing setup step (a credential, or a model once a
 * credential exists), and says what still works without one.
 *
 * @param props.feature - Names the feature in the panel's first sentence.
 * @param props.alternative - Optional BYO alternative, shown under the main text.
 * @param props.compact - Use the smaller layout inside dialogs and fields.
 */
export function StoredKeyRequired({ feature, alternative, compact, className }: StoredKeyRequiredProps) {
  const connections = useConnections();
  // Until the list has loaded (or if loading failed), point at Models, as JudgeModelField
  // does: telling a team that has a credential to add one sends it the wrong way.
  const hasCredential = (connections.data?.length ?? 0) > 0 || !connections.isSuccess;

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-line bg-surface text-[13px]',
        compact ? 'px-3 py-2.5' : 'px-4 py-4',
        className,
      )}
      data-testid="stored-key-required"
    >
      <p className={cn('font-medium text-ink', compact ? 'text-[13px]' : 'text-[14px]')}>
        {feature} needs a model on a stored provider key
      </p>
      <p className="text-muted">
        It calls the model from AcruxCore&apos;s servers, with no request from your app in
        progress, so it cannot use a key your app holds.{' '}
        {hasCredential
          ? 'Your team has a credential but no model yet: add one under Gateway → Models.'
          : 'Store a key under Gateway → Credentials, then add a model on it.'}
      </p>
      <p className="text-muted">
        Calling your provider directly with your own key still works for prompts, tools,
        traces and feedback.{' '}
        <a href={BYO_GUIDE_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          How direct calls work
        </a>
      </p>
      {alternative && <p className="text-muted">{alternative}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <Link to={hasCredential ? '/gateway/models' : '/gateway/connections'}>
          <Button variant="primary" size="sm">{hasCredential ? 'Add a model' : 'Add a credential'}</Button>
        </Link>
      </div>
    </div>
  );
}
