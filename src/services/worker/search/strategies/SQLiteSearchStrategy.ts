/**
 * SQLiteSearchStrategy - Direct SQLite queries for filter-only searches
 *
 * This strategy handles searches without query text (filter-only):
 * - Date range filtering
 * - Project filtering
 * - Type filtering
 * - Concept/file filtering
 *
 * Used when: No query text is provided, or as a fallback when Chroma fails
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { AppError } from '../../../server/ErrorHandler.js';
import { logger } from '../../../../utils/logger.js';

export class SQLiteSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'sqlite';

  constructor(private sessionSearch: SessionSearch) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle filter-only queries (no query text)
    // Also used as fallback when Chroma is unavailable
    return !options.query || options.strategyHint === 'sqlite';
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      offset = 0,
      project,
      dateRange,
      orderBy = 'date_desc'
    } = options;

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    const baseOptions = { limit, offset, orderBy, project, dateRange };

    logger.debug('SEARCH', 'SQLiteSearchStrategy: Filter-only query', {
      searchType,
      hasDateRange: !!dateRange,
      hasProject: !!project
    });

    try {
      if (searchObservations) {
        const obsOptions = {
          ...baseOptions,
          type: obsType,
          concepts,
          files
        };
        observations = this.sessionSearch.searchObservations(undefined, obsOptions);
      }

      if (searchSessions) {
        sessions = this.sessionSearch.searchSessions(undefined, baseOptions);
      }

      if (searchPrompts) {
        prompts = this.sessionSearch.searchUserPrompts(undefined, baseOptions);
      }

      logger.debug('SEARCH', 'SQLiteSearchStrategy: Results', {
        observations: observations.length,
        sessions: sessions.length,
        prompts: prompts.length
      });

      return {
        results: { observations, sessions, prompts },
        usedChroma: false,
        fellBack: false,
        strategy: 'sqlite'
      };

    } catch (error) {
      if (error instanceof AppError) {
        // Validation error (e.g. neither query nor filters provided) — the API
        // contract returns 400, so let it propagate instead of masking it as
        // an empty result.
        throw error;
      }
      logger.error('SEARCH', 'SQLiteSearchStrategy: Search failed', {}, error as Error);
      return this.emptyResult('sqlite');
    }
  }

  /**
   * Find observations by concept (used by findByConcept tool)
   */
  findByConcept(concept: string, options: StrategySearchOptions): ObservationSearchResult[] {
    // SessionSearch overrides the concepts key and ignores unknown keys,
    // so passing options through applies every supported filter.
    return this.sessionSearch.findByConcept(concept, options);
  }

  /**
   * Find observations by type (used by findByType tool)
   */
  findByType(type: string | string[], options: StrategySearchOptions): ObservationSearchResult[] {
    return this.sessionSearch.findByType(type as any, options);
  }

  /**
   * Find observations and sessions by file path (used by findByFile tool)
   */
  findByFile(filePath: string, options: StrategySearchOptions): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    return this.sessionSearch.findByFile(filePath, options);
  }
}
