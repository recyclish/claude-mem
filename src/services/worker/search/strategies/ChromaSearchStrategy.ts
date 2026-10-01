/**
 * ChromaSearchStrategy - Vector-based semantic search via Chroma
 *
 * This strategy handles semantic search queries using ChromaDB:
 * 1. Query Chroma for semantically similar documents
 * 2. Filter by recency (90-day window)
 * 3. Categorize by document type
 * 4. Hydrate from SQLite
 *
 * Used when: Query text is provided and Chroma is available
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ChromaMetadata,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';

export class ChromaSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'chroma';

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle when query text is provided and Chroma is available
    return !!options.query && !!this.chromaSync;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project,
      dateRange,
      orderBy = 'date_desc'
    } = options;

    if (!query) {
      return this.emptyResult('chroma');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    try {
      // Build Chroma where filter for doc_type and project
      const whereFilter = this.buildWhereFilter(searchType, project);

      // Step 1: Chroma semantic search
      logger.debug('SEARCH', 'ChromaSearchStrategy: Querying Chroma', { query, searchType });
      const chromaResults = await this.chromaSync.queryChroma(
        query,
        SEARCH_CONSTANTS.CHROMA_BATCH_SIZE,
        whereFilter
      );

      logger.debug('SEARCH', 'ChromaSearchStrategy: Chroma returned matches', {
        matchCount: chromaResults.ids.length
      });

      if (chromaResults.ids.length === 0) {
        // No matches - this is the correct answer
        return {
          results: { observations: [], sessions: [], prompts: [] },
          usedChroma: true,
          fellBack: false,
          strategy: 'chroma'
        };
      }

      // Step 2: Filter by the user-provided date range, or the 90-day recency window
      const recentItems = this.filterByRecency(chromaResults, dateRange);
      logger.debug('SEARCH', 'ChromaSearchStrategy: Filtered by recency', {
        count: recentItems.length
      });

      // Step 3: Categorize by document type
      const categorized = this.categorizeByDocType(recentItems, {
        searchObservations,
        searchSessions,
        searchPrompts
      });

      // Step 4: Hydrate from SQLite with additional filters
      if (categorized.obsIds.length > 0) {
        const obsOptions = { type: obsType, concepts, files, orderBy, limit, project };
        observations = this.sessionStore.getObservationsByIds(categorized.obsIds, obsOptions);
      }

      if (categorized.sessionIds.length > 0) {
        sessions = this.sessionStore.getSessionSummariesByIds(categorized.sessionIds, {
          orderBy,
          limit,
          project
        });
      }

      if (categorized.promptIds.length > 0) {
        prompts = this.sessionStore.getUserPromptsByIds(categorized.promptIds, {
          orderBy,
          limit,
          project
        });
      }

      logger.debug('SEARCH', 'ChromaSearchStrategy: Hydrated results', {
        observations: observations.length,
        sessions: sessions.length,
        prompts: prompts.length
      });

      return {
        results: { observations, sessions, prompts },
        usedChroma: true,
        fellBack: false,
        strategy: 'chroma'
      };

    } catch (error) {
      logger.error('SEARCH', 'ChromaSearchStrategy: Search failed', {}, error as Error);
      // Return empty result - caller may try fallback strategy
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        fellBack: false,
        strategy: 'chroma'
      };
    }
  }

  /**
   * Build Chroma where filter for document type and project
   *
   * When a project is specified, includes it in the ChromaDB where clause
   * so that vector search is scoped to the target project. Without this,
   * larger projects dominate the top-N results and smaller projects get
   * crowded out before the post-hoc SQLite project filter can take effect.
   */
  private buildWhereFilter(searchType: string, project?: string): Record<string, any> | undefined {
    let docTypeFilter: Record<string, any> | undefined;
    switch (searchType) {
      case 'observations':
        docTypeFilter = { doc_type: 'observation' };
        break;
      case 'sessions':
        docTypeFilter = { doc_type: 'session_summary' };
        break;
      case 'prompts':
        docTypeFilter = { doc_type: 'user_prompt' };
        break;
      default:
        docTypeFilter = undefined;
    }

    if (project) {
      // Match both native-provenance rows (project) and adopted merged-worktree
      // rows (merged_into_project) so a parent-project query surfaces its
      // merged children's observations too.
      const projectFilter = {
        $or: [
          { project },
          { merged_into_project: project }
        ]
      };
      if (docTypeFilter) {
        return { $and: [docTypeFilter, projectFilter] };
      }
      return projectFilter;
    }

    return docTypeFilter;
  }

  /**
   * Filter results by date range, defaulting to the 90-day recency window
   * when the caller did not provide one.
   *
   * IMPORTANT: ChromaSync.queryChroma() returns deduplicated `ids` (unique sqlite_ids)
   * but the `metadatas` array may contain multiple entries per sqlite_id (e.g., one
   * observation can have narrative + multiple facts as separate Chroma documents).
   *
   * This method iterates over the deduplicated `ids` and finds the first matching
   * metadata for each ID to avoid array misalignment issues.
   */
  private filterByRecency(
    chromaResults: {
      ids: number[];
      metadatas: ChromaMetadata[];
    },
    dateRange?: { start?: string | number; end?: string | number }
  ): Array<{ id: number; meta: ChromaMetadata }> {
    let startEpoch: number | undefined;
    let endEpoch: number | undefined;

    if (dateRange) {
      if (dateRange.start) {
        startEpoch = typeof dateRange.start === 'number'
          ? dateRange.start
          : new Date(dateRange.start).getTime();
      }
      if (dateRange.end) {
        endEpoch = typeof dateRange.end === 'number'
          ? dateRange.end
          : new Date(dateRange.end).getTime();
      }
    } else {
      startEpoch = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
    }

    // Build a map from sqlite_id to first metadata for efficient lookup
    const metadataByIdMap = new Map<number, ChromaMetadata>();
    for (const meta of chromaResults.metadatas) {
      if (meta?.sqlite_id !== undefined && !metadataByIdMap.has(meta.sqlite_id)) {
        metadataByIdMap.set(meta.sqlite_id, meta);
      }
    }

    // Iterate over deduplicated ids and get corresponding metadata
    return chromaResults.ids
      .map(id => ({
        id,
        meta: metadataByIdMap.get(id) as ChromaMetadata
      }))
      .filter(item => item.meta && item.meta.created_at_epoch != null
        && (!startEpoch || item.meta.created_at_epoch >= startEpoch)
        && (!endEpoch || item.meta.created_at_epoch <= endEpoch));
  }

  /**
   * Categorize IDs by document type
   */
  private categorizeByDocType(
    items: Array<{ id: number; meta: ChromaMetadata }>,
    options: {
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
    }
  ): { obsIds: number[]; sessionIds: number[]; promptIds: number[] } {
    const obsIds: number[] = [];
    const sessionIds: number[] = [];
    const promptIds: number[] = [];

    for (const item of items) {
      const docType = item.meta?.doc_type;
      if (docType === 'observation' && options.searchObservations) {
        obsIds.push(item.id);
      } else if (docType === 'session_summary' && options.searchSessions) {
        sessionIds.push(item.id);
      } else if (docType === 'user_prompt' && options.searchPrompts) {
        promptIds.push(item.id);
      }
    }

    return { obsIds, sessionIds, promptIds };
  }
}
