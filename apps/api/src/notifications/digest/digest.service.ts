import { appLink } from '../../email';
import type { DigestStat, WeeklyDigestEmailProps } from '../../email/email.types';
import { notify } from '../notify';
import {
  DIGEST_WINDOW_DAYS,
  TOP_MODELS_LIMIT,
} from './digest.config';
import { formatCount, formatDay, formatDelta, formatUsd, isoWeekKey } from './digest.format';
import { DigestRepository, type DigestWindow } from './digest.repository';
import {
  digestJobId,
  DIGEST_TEAM_JOB,
  digestTeamJobOpts,
  getDigestQueue,
  type DigestTeamJobData,
} from './digest.queue';

/** Milliseconds in the digest window. */
const WINDOW_MS = DIGEST_WINDOW_DAYS * 86_400_000;

/**
 * Builds and dispatches weekly usage digests.
 */
export class DigestService {
  constructor(private readonly repo: DigestRepository) {}

  /**
   * The window a dispatch at `now` covers, plus the preceding window it is
   * compared against.
   *
   * @param now - Dispatch time.
   * @returns Current and prior `[from, to)` windows.
   */
  static windows(now: Date): { current: DigestWindow; prior: DigestWindow } {
    const to = now;
    const from = new Date(to.getTime() - WINDOW_MS);
    return {
      current: { from, to },
      prior: { from: new Date(from.getTime() - WINDOW_MS), to: from },
    };
  }

  /**
   * Finds every eligible team and enqueues one digest job each.
   *
   * Does no email work itself. Fan-out per team is the point: a slow aggregate or
   * a bad row for one team must not stall or fail the digest for every other team,
   * and each team's job gets BullMQ's retry semantics individually.
   *
   * @param now - Dispatch time, which defines the window.
   * @returns The number of per-team jobs enqueued. Teams already dispatched this
   *   ISO week are counted but produce no second job — the job id dedupes them.
   */
  async dispatch(now: Date): Promise<number> {
    const { current } = DigestService.windows(now);
    const isoWeek = isoWeekKey(now);
    const teamIds = await this.repo.findActiveTeamIds(current);

    const queue = getDigestQueue();
    for (const teamId of teamIds) {
      const data: DigestTeamJobData = {
        teamId,
        from: current.from.toISOString(),
        to: current.to.toISOString(),
        isoWeek,
      };
      await queue.add(DIGEST_TEAM_JOB, data, {
        ...digestTeamJobOpts,
        jobId: digestJobId(teamId, isoWeek),
      });
    }

    return teamIds.length;
  }

  /**
   * Assembles one team's digest content.
   *
   * Every number is formatted here, before it reaches the template, so the
   * template stays a pure layout concern and the arithmetic edge cases —
   * a percentage change from a zero baseline, a zero delta — are unit-testable
   * without a database.
   *
   * Counts and money only. No prompt text, trace input/output, or eval result is
   * read at all, let alone rendered: payload capture defaults to on, so a digest
   * that quoted content would route customer data into mailboxes, and `email_log`
   * stores no bodies, so it would be untraceable afterwards.
   *
   * @param teamId - Team to summarise.
   * @param window - The `[from, to)` window.
   * @returns Template props, minus the per-recipient `unsubscribeUrl`, or null
   *   when the team no longer exists.
   */
  async build(
    teamId: string,
    window: DigestWindow,
  ): Promise<Omit<WeeklyDigestEmailProps, 'unsubscribeUrl'> | null> {
    const teamName = await this.repo.teamName(teamId);
    if (teamName === null) return null;

    const prior: DigestWindow = {
      from: new Date(window.from.getTime() - WINDOW_MS),
      to: window.from,
    };

    const [usage, priorUsage, counts, topModels, budgets] = await Promise.all([
      this.repo.usage(teamId, window),
      this.repo.usage(teamId, prior),
      this.repo.counts(teamId, window),
      this.repo.topModels(teamId, window, TOP_MODELS_LIMIT),
      this.repo.budgets(teamId),
    ]);

    // Deltas for spend and request count only — the two numbers where a trend is
    // genuinely useful. Deltas on every row would double the query cost for
    // decoration.
    const stats: DigestStat[] = [
      {
        label: 'Gateway spend',
        value: formatUsd(usage.costUsd),
        delta: formatDelta(usage.costUsd, priorUsage.costUsd),
      },
      {
        label: 'Gateway requests',
        value: formatCount(usage.requests),
        delta: formatDelta(usage.requests, priorUsage.requests),
      },
      { label: 'Traces recorded', value: formatCount(counts.traces) },
      { label: 'New prompts', value: formatCount(counts.newPrompts) },
      { label: 'Versions committed', value: formatCount(counts.promptVersions) },
      {
        label: 'Runs finished',
        value: `${formatCount(counts.runsSucceeded)} succeeded · ${formatCount(counts.runsFailed)} failed`,
      },
    ];

    return {
      teamName,
      fromDate: formatDay(window.from),
      // The window's upper bound is exclusive, so the last day it actually covers
      // is the day before it. Showing `to` itself would claim a day of data the
      // digest does not include.
      toDate: formatDay(new Date(window.to.getTime() - 86_400_000)),
      stats,
      topModels: topModels.map((m) => ({
        model: m.model,
        value: `${formatUsd(m.costUsd)} · ${formatCount(m.requests)} req`,
      })),
      budgets: budgets.map((b) => ({
        scope: `${b.scope} (${b.period})`,
        value: `${formatUsd(b.spendUsd)} of ${formatUsd(b.limitUsd)}`,
      })),
      usageUrl: appLink('/gateway/usage'),
    };
  }

  /**
   * Builds and sends one team's digest to its owners and admins.
   *
   * Editors and viewers are excluded by design: a usage-and-spend summary is an
   * operational report, and the people who can act on it are the ones who can
   * change budgets and keys.
   *
   * @param teamId - Team to send for.
   * @param window - The `[from, to)` window.
   * @param isoWeek - Week identifier, used in the per-recipient dedupe key.
   * @returns The number of emails enqueued.
   */
  async send(teamId: string, window: DigestWindow, isoWeek: string): Promise<number> {
    const props = await this.build(teamId, window);
    if (!props) return 0;

    return notify({
      teamId,
      category: 'weekly_digest',
      audience: { roles: ['owner', 'admin'] },
      // `notify()` appends the recipient's user id, so this is one email per
      // owner/admin per week — and a re-dispatch of the same week collapses.
      dedupeKey: `digest:${teamId}:${isoWeek}`,
      payload: { type: 'weekly_digest', props },
    });
  }
}
