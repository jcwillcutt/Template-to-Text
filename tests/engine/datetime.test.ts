import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../../src/engine/datetime';
import { loadLegacyEngine } from '../helpers/legacy-oracle';

const d = new Date(2026, 2, 3, 6, 5, 7, 89); // Tue 3 Mar 2026 06:05:07.089 local
const f = (s: string) => formatDateTime(d, s);

describe('formatDateTime', () => {
  it('day / month / year', () => {
    expect(f('d dd')).toBe('3 03');
    expect(f('ddd dddd')).toBe('Tues Tuesday');
    expect(f('M MM')).toBe('3 03');
    expect(f('MMM MMMM')).toBe('Mar March');
    expect(f('y yy yyy yyyy')).toBe('26 26 2026 2026');
  });
  it('hours, minutes, seconds, meridiem', () => {
    expect(f('h hh H HH')).toBe('6 06 6 06');
    expect(f('m mm s ss')).toBe('5 05 7 07');
    expect(f('t tt')).toBe('A AM');
    expect(formatDateTime(new Date(2026, 0, 1, 15, 0, 0), 'h:mm tt')).toBe('3:00 PM');
    expect(formatDateTime(new Date(2026, 0, 1, 0, 0, 0), 'h tt')).toBe('12 AM');
    expect(formatDateTime(new Date(2026, 0, 1, 12, 0, 0), 'h tt')).toBe('12 PM');
  });
  it('fractional seconds', () => {
    expect(f('fff')).toBe('089');
    expect(f('ffffff')).toBe('089000');
    expect(f('FFF')).toBe('089');
    expect(formatDateTime(new Date(2026, 0, 1, 0, 0, 0, 500), 'FFF')).toBe('5');
  });
  it('time-zone offsets look like +HH:mm', () => {
    expect(f('K')).toMatch(/^[+-]\d\d:\d\d$/);
    expect(f('zzz')).toMatch(/^[+-]\d\d:\d\d$/);
    expect(f('zz')).toMatch(/^[+-]\d\d$/);
  });
  it('anything else passes through; quotes escape letters', () => {
    expect(f('yyyy-MM-dd, HH:mm')).toBe('2026-03-03, 06:05');
    expect(f("'at' H")).toBe('at 6');
    expect(f('"MM" MM')).toBe('MM 03');
    expect(f("'unterminated")).toBe('unterminated');
    expect(f('')).toBe('');
  });
  it('matches the legacy formatter', () => {
    const legacy = loadLegacyEngine().formatDateTime;
    for (const fmt of ['dddd, MMMM d, yyyy', 'MM/dd/yyyy h:mm tt', 'HH:mm:ss.fff', 'yy-M-d', "yyyy 'of' MMM"]) {
      expect(f(fmt)).toBe(legacy(d, fmt));
    }
  });
});
