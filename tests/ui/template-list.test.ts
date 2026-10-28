import { describe, it, expect } from 'vitest';
import { orderTemplateList, isInFolder, isInMainList, withFolder, withoutFolder, withMain } from '../../src/ui/template-list';
import type { TemplateData, TemplateFolder } from '../../src/domain/types';

const t = (id: string, o: Partial<TemplateData> = {}): TemplateData => ({
  id, title: id, body: '', extension: 'txt', pinned: false, pinnedAt: null, fileBreak: 'product', mergeCondition: '', ...o,
});
const label = (items: ReturnType<typeof orderTemplateList>): string[] =>
  items.map((i) => (i.kind === 'template' ? i.tpl.id : `[${i.folder.id}:${i.list.map((x) => x.id).join(',')}]`));

describe('orderTemplateList', () => {
  const folders: TemplateFolder[] = [{ id: 'F1', name: 'F1' }, { id: 'F2', name: 'F2' }];
  it('puts pinned templates first, then unpinned folders, then the other templates', () => {
    const list = [t('a'), t('b', { pinned: true, pinnedAt: 5 }), t('c', { folderIds: ['F1'] }), t('d')];
    expect(label(orderTemplateList(list, folders, '', 'old-new'))).toEqual(['b', '[F1:c]', '[F2:]', 'a', 'd']);
  });
  it('a pinned folder sorts among the pinned templates by pin time (newest first)', () => {
    const list = [t('a', { pinned: true, pinnedAt: 10 }), t('b', { pinned: true, pinnedAt: 1 }), t('c')];
    const pinnedFolders: TemplateFolder[] = [{ id: 'F1', name: 'F1', pinned: true, pinnedAt: 5 }, { id: 'F2', name: 'F2' }];
    expect(label(orderTemplateList(list, pinnedFolders, '', 'old-new'))).toEqual(['a', '[F1:]', 'b', '[F2:]', 'c']);
  });
  it('a pinned template inside a folder stays inside that folder, pinned first', () => {
    const list = [t('a', { folderIds: ['F1'] }), t('b', { folderIds: ['F1'], pinned: true, pinnedAt: 1 }), t('c')];
    expect(label(orderTemplateList(list, folders, '', 'old-new'))).toEqual(['[F1:b,a]', '[F2:]', 'c']);
  });
  it('a template whose folder is gone appears in the main list', () => {
    expect(label(orderTemplateList([t('a', { folderIds: ['GONE'] })], [], '', 'old-new'))).toEqual(['a']);
  });
  it('a search shows folders holding a match (just the matches) before the matching main-list templates', () => {
    const list = [t('apple', { folderIds: ['F1'] }), t('pear', { folderIds: ['F1'] }), t('banana'), t('apricot', { pinned: true, pinnedAt: 1 })];
    expect(label(orderTemplateList(list, folders, 'ap', 'a-z'))).toEqual(['[F1:apple]', 'apricot']);
  });
  it('a search matching a folder name shows the folder with all its templates', () => {
    const list = [t('apple', { folderIds: ['F2'] }), t('pear', { folderIds: ['F2'] }), t('plum')];
    const named: TemplateFolder[] = [{ id: 'F1', name: 'Fruit' }, { id: 'F2', name: 'Orchard' }];
    expect(label(orderTemplateList(list, named, 'orch', 'a-z'))).toEqual(['[F2:apple,pear]']);
    expect(label(orderTemplateList(list, named, 'fruit', 'a-z'))).toEqual(['[F1:]']);
  });
  it('applies the chosen sort to unpinned templates', () => {
    const list = [t('b'), t('a'), t('c')];
    expect(label(orderTemplateList(list, [], '', 'a-z'))).toEqual(['a', 'b', 'c']);
    expect(label(orderTemplateList(list, [], '', 'new-old'))).toEqual(['c', 'a', 'b']);
  });
  it('lists a template under every folder it is in, and not in the main list', () => {
    const list = [t('a', { folderIds: ['F1', 'F2'] }), t('b')];
    expect(label(orderTemplateList(list, folders, '', 'old-new'))).toEqual(['[F1:a]', '[F2:a]', 'b']);
  });
  it('a template whose folders are all gone, or only partly gone, is placed accordingly', () => {
    expect(label(orderTemplateList([t('a', { folderIds: ['GONE', 'F1'] })], folders, '', 'old-new'))).toEqual(['[F1:a]', '[F2:]']);
  });
});

describe('folder membership helpers', () => {
  it('a template can be on the main page and in folders at once', () => {
    const fs: TemplateFolder[] = [{ id: 'F1', name: 'F1' }];
    const both = withMain(withFolder(t('a'), 'F1'), true);
    expect(isInMainList(both, fs)).toBe(true);
    expect(isInFolder(both, 'F1')).toBe(true);
    expect(label(orderTemplateList([both], fs, '', 'old-new'))).toEqual(['[F1:a]', 'a']);
  });
  it('adding to a folder keeps a main-page template on the main page; removing it from the main page is explicit', () => {
    const fs: TemplateFolder[] = [{ id: 'F1', name: 'F1' }, { id: 'F2', name: 'F2' }];
    const inF = withFolder(t('a'), 'F1');
    expect(isInMainList(inF, fs)).toBe(true);
    expect(isInFolder(inF, 'F1')).toBe(true);
    expect(isInMainList(withMain(inF, false), fs)).toBe(false);
    // a template that was only in folders stays only in folders when it joins another
    const folderOnly = withFolder(withMain(inF, false), 'F2');
    expect(isInMainList(folderOnly, fs)).toBe(false);
  });
  it('taking a template out of its last folder leaves it on the main page', () => {
    const fs: TemplateFolder[] = [{ id: 'F1', name: 'F1' }];
    const back = withoutFolder(withMain(withFolder(t('a'), 'F1'), false), 'F1');
    expect(isInMainList(back, fs)).toBe(true);
    expect('onMain' in back).toBe(false);
  });
  it('a template taken off the main page while in a folder is listed only in that folder', () => {
    const fs: TemplateFolder[] = [{ id: 'F1', name: 'F1' }];
    const x = withMain(t('a', { folderIds: ['F1'], onMain: true }), false);
    expect(label(orderTemplateList([x], fs, '', 'old-new'))).toEqual(['[F1:a]']);
  });
  it('a template is on the main page when it is in none of the existing folders', () => {
    const fs: TemplateFolder[] = [{ id: 'F1', name: 'F1' }];
    expect(isInMainList(t('a'), fs)).toBe(true);
    expect(isInMainList(t('a', { folderIds: ['GONE'] }), fs)).toBe(true);
    expect(isInMainList(t('a', { folderIds: ['F1'] }), fs)).toBe(false);
  });
  it('adds without duplicating and removes only that folder', () => {
    const a = t('a');
    const one = withFolder(a, 'F1');
    expect(withFolder(one, 'F1')).toBe(one);
    const two = withFolder(one, 'F2');
    expect(two.folderIds).toEqual(['F1', 'F2']);
    expect(isInFolder(two, 'F2')).toBe(true);
    expect(withoutFolder(two, 'F1').folderIds).toEqual(['F2']);
    expect('folderIds' in withoutFolder(one, 'F1')).toBe(false);
    expect(withoutFolder(a, 'F1')).toBe(a);
  });
});
