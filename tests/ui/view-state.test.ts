import { describe, it, expect } from 'vitest';
import { buildViewState, parseViewState, parseDownloadMode } from '../../src/ui/view-state';
import { formatSelectedSummary } from '../../src/format/helpers';

describe('view state', () => {
  const state = buildViewState({
    search: 'help OR sku:ABC',
    productIds: ['p1', 'p2'],
    variantIds: { p1: ['v1'], gone: ['x'] },
    notes: { p2: 'note', gone: 'stale' },
    noteObjects: [{ id: 'n1', note: 'free' }],
    order: { p1: 1, p2: 2 },
    templateIds: ['t1', 't2'],
    expandedFolderIds: ['f1'],
  });
  it('round-trips through JSON', () => {
    expect(parseViewState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
  it('drops variant picks and notes of products no longer selected', () => {
    expect(state.variantIds).toEqual({ p1: ['v1'] });
    expect(state.notes).toEqual({ p2: 'note' });
  });
  it('treats anything unreadable as no saved state, and keeps the valid parts of damaged data', () => {
    expect(parseViewState(undefined)).toBeNull();
    expect(parseViewState('nope')).toBeNull();
    expect(parseViewState({ v: 2 })).toBeNull();
    const partly = parseViewState({ v: 1, search: 5, productIds: ['a', 7], templateIds: 'x', order: { a: 'z', b: 2 } });
    expect(partly).toMatchObject({ search: '', productIds: ['a'], templateIds: [], order: { b: 2 } });
  });
});

describe('formatSelectedSummary', () => {
  it('shows variants|templates, with notes after the variants when there are any', () => {
    expect(formatSelectedSummary(3, 0, 2)).toBe('(3|2)');
    expect(formatSelectedSummary(0, 0, 0)).toBe('(0|0)');
    expect(formatSelectedSummary(3, 2, 1)).toBe('(3/2|1)');
  });
});

describe('download mode setting', () => {
  it('reads a saved choice and falls back to grouping by template', () => {
    expect(parseDownloadMode('alternate')).toBe('alternate');
    expect(parseDownloadMode('grouped')).toBe('grouped');
    expect(parseDownloadMode(undefined)).toBe('grouped');
    expect(parseDownloadMode(42)).toBe('grouped');
  });
});
