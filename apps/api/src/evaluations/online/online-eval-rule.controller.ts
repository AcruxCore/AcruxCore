import { Request, Response, NextFunction } from 'express';
import { OnlineEvalRuleService } from './online-eval-rule.service';
import {
  CreateEvalRuleSchema,
  UpdateEvalRuleSchema,
  RuleScoreListQuerySchema,
  ToDatasetSchema,
} from './online-eval-rule.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP boundary for the online-eval-rule domain: validates the request with
 * the Task 2 Zod schemas, calls {@link OnlineEvalRuleService}, and shapes the
 * response. Holds no business logic — that all lives in the service.
 */
export class OnlineEvalRuleController {
  constructor(private readonly service: OnlineEvalRuleService) {}

  /**
   * Creates a new online-eval rule for the caller's team.
   *
   * @throws {ValidationError} If the body fails {@link CreateEvalRuleSchema}.
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateEvalRuleSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.createRule(req.teamId!, req.user!.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** Lists every online-eval rule for the caller's team. */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await this.service.listRules(req.teamId!));
    } catch (err) {
      next(err);
    }
  };

  /**
   * Fetches one rule by id, scoped to the caller's team.
   *
   * @throws {NotFoundError} If the rule does not exist in this team.
   */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await this.service.getRule(req.params.id, req.teamId!));
    } catch (err) {
      next(err);
    }
  };

  /**
   * Patches a rule's mutable fields.
   *
   * @throws {ValidationError} If the body fails {@link UpdateEvalRuleSchema}.
   * @throws {NotFoundError} If the rule does not exist in this team.
   */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateEvalRuleSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      res.status(200).json(await this.service.updateRule(req.params.id, req.teamId!, parsed.data));
    } catch (err) {
      next(err);
    }
  };

  /**
   * Deletes a rule. Its scores cascade-delete at the DB level.
   *
   * @throws {NotFoundError} If the rule does not exist in this team.
   */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.deleteRule(req.params.id, req.teamId!);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Lists a rule's judged scores, paginated and optionally score-filtered.
   *
   * @throws {ValidationError} If the query fails {@link RuleScoreListQuerySchema}.
   * @throws {NotFoundError} If the rule does not exist in this team.
   */
  listScores = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = RuleScoreListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const { total, data } = await this.service.listScores(req.params.id, req.teamId!, parsed.data);
      res.status(200).json({ total, data, page: parsed.data.page, limit: parsed.data.limit });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Dry-runs a rule's judge against recent matching spans without persisting
   * any score rows.
   *
   * @throws {NotFoundError} If the rule does not exist in this team.
   */
  preview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Math.min(Number(req.body?.limit ?? 10), 10);
      res.status(200).json(await this.service.previewRule(req.params.id, req.teamId!, limit));
    } catch (err) {
      next(err);
    }
  };

  /**
   * Builds a dataset from a rule's judged scores at or below a threshold.
   *
   * @throws {ValidationError} If the body fails {@link ToDatasetSchema}.
   * @throws {NotFoundError} If the rule does not exist in this team.
   */
  toDataset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ToDatasetSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      res.status(201).json(await this.service.buildDataset(req.params.id, req.teamId!, parsed.data));
    } catch (err) {
      next(err);
    }
  };
}
