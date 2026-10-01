/**
 * Regression test for mock.module() worker pollution (#1299)
 *
 * context-reinjection-guard.test.ts used to call mock.module('../../src/utils/project-name.js', ...)
 * at the top level, which permanently stubbed getProjectName to return 'test-project'
 * for every subsequent import in the same Bun worker process.
 *
 * bunfig.toml's smol=true was believed to contain this by giving each file its
 * own worker, but that is not what smol does — the leak persisted until the
 * mocking files started restoring the real exports in afterAll.
 *
 * These tests fail if any earlier-loaded test file mocks project-name.js or
 * project-filter.js without restoring it.
 */
import { describe, it, expect } from 'bun:test';
import { getProjectName } from '../../src/utils/project-name.js';
import { isProjectExcluded } from '../../src/utils/project-filter.js';

describe('getProjectName mock isolation (#1299)', () => {
  it('returns real basename, not the leaked test-project mock', () => {
    expect(getProjectName('/real/path/to/my-project')).toBe('my-project');
  });

  it('returns unknown-project for empty string (real implementation)', () => {
    expect(getProjectName('')).toBe('unknown-project');
  });

  it('returns real basename from nested path', () => {
    expect(getProjectName('/home/user/code/awesome-app')).toBe('awesome-app');
  });
});

describe('isProjectExcluded mock isolation (#1299)', () => {
  it('applies real pattern matching, not the leaked always-false mock', () => {
    // The leaked mock is `() => false`, so a genuine match proves the real
    // implementation is in place.
    expect(isProjectExcluded('/home/user/scratch', '/home/user/scratch')).toBe(true);
  });

  it('still returns false for a genuinely non-matching project', () => {
    expect(isProjectExcluded('/home/user/keep-me', '/home/user/scratch')).toBe(false);
  });
});
