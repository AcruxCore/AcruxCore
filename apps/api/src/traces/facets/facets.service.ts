import { TraceFacetsRepository } from './facets.repository';
import type { TraceFacets } from './facets.types';

/** Business logic for trace facet discovery (T8). Read-only, team-scoped. */
export class TraceFacetsService {
  constructor(private readonly repo: TraceFacetsRepository) {}

  /**
   * The team's distinct tags + metadata keys + resolved span models, for
   * populating filter pickers.
   *
   * @param teamId - Team scope.
   */
  async getFacets(teamId: string): Promise<TraceFacets> {
    const [tags, metadataKeys, models] = await Promise.all([
      this.repo.listTags(teamId),
      this.repo.listMetadataKeys(teamId),
      this.repo.listModels(teamId),
    ]);
    return { tags, metadataKeys, models };
  }

  /**
   * The team's distinct values for one metadata key.
   *
   * @param teamId - Team scope.
   * @param key - The metadata key to enumerate values for.
   */
  async getMetadataValues(teamId: string, key: string): Promise<string[]> {
    return this.repo.listMetadataValues(teamId, key);
  }
}
