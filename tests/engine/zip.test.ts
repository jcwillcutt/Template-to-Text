import { describe, expect, it } from 'vitest';
import { buildZipBase64, mediaTypeForExtension, crc32, utf8Bytes, base64FromBytes } from '../../src/engine/zip';
import { loadLegacyEngine } from '../helpers/legacy-oracle';

// A tiny independent ZIP reader (STORE entries only) so the test doesn't just compare against our own writer.
function readZip(b64: string): { name: string; content: string; crcOk: boolean }[] {
  const buf = Buffer.from(b64, 'base64');
  const out: { name: string; content: string; crcOk: boolean }[] = [];
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const lnLen = buf.readUInt16LE(local + 26);
    const exLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnLen + exLen, local + 30 + lnLen + exLen + size);
    out.push({ name, content: data.toString('utf8'), crcOk: crc === crc32(new Uint8Array(data)) });
    p += 46 + nameLen;
  }
  return out;
}

describe('buildZipBase64', () => {
  it('round-trips names and contents (including non-ASCII and astral characters)', () => {
    const entries = [
      { name: 'a.txt', content: 'hello' },
      { name: 'ünï.csv', content: 'naïve café ☕ 😀 \n line2' },
      { name: 'empty.txt', content: '' },
    ];
    const read = readZip(buildZipBase64(entries));
    expect(read.map((r) => r.name)).toEqual(entries.map((e) => e.name));
    expect(read.map((r) => r.content)).toEqual(entries.map((e) => e.content));
    expect(read.every((r) => r.crcOk)).toBe(true);
  });
  it('an empty archive is just the end-of-central-directory record', () => {
    expect(Buffer.from(buildZipBase64([]), 'base64').length).toBe(22);
  });
  it('is byte-identical to the legacy writer', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, content: `line ${i}\n`.repeat(i * 3) + '€😀' }));
    expect(buildZipBase64(entries)).toBe(loadLegacyEngine().buildZipBase64(entries));
  });
  it('handles a large entry', () => {
    const big = 'x'.repeat(2_000_000);
    expect(readZip(buildZipBase64([{ name: 'big.txt', content: big }]))[0].content.length).toBe(big.length);
  });
});

describe('helpers', () => {
  it('crc32 known values', () => {
    expect(crc32(utf8Bytes(''))).toBe(0);
    expect(crc32(utf8Bytes('123456789'))).toBe(0xcbf43926);
  });
  it('utf8Bytes agrees with TextEncoder', () => {
    const s = 'aé€😀\u0000z';
    expect(Array.from(utf8Bytes(s))).toEqual(Array.from(new TextEncoder().encode(s)));
  });
  it('base64FromBytes agrees with Buffer for every remainder length', () => {
    for (let n = 0; n < 8; n++) {
      const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255));
      expect(base64FromBytes(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
  it('media types', () => {
    expect(mediaTypeForExtension('CSV')).toBe('text/csv');
    expect(mediaTypeForExtension('json')).toBe('application/json');
    expect(mediaTypeForExtension('htm')).toBe('text/html');
    expect(mediaTypeForExtension('xml')).toBe('application/xml');
    expect(mediaTypeForExtension('weird')).toBe('text/plain');
  });
});
