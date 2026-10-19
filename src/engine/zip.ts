// Output-file naming helpers and the dependency-free STORE-only ZIP writer. Verbatim from the legacy engine.

// ----------------------------------------------------------------------------------------------
// OUTPUT FILE PLANNING + ZIP ARCHIVE BUILDER
// mediaTypeForExtension, the hand-rolled CRC32/UTF-8/base64/ZIP (STORE only, no compression)
// builder, and the FilePlan machinery (planOutputFiles/buildOutputFiles) that both the download
// button and the editor preview render from, so they can never disagree about the output.
// ----------------------------------------------------------------------------------------------
export function mediaTypeForExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'json') return 'application/json';
  if (e === 'csv') return 'text/csv';
  if (e === 'html' || e === 'htm') return 'text/html';
  if (e === 'xml') return 'application/xml';
  return 'text/plain';
}

// CRC32 for ZIP entries.
export const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// UTF-8 encode a string into bytes without TextEncoder dependency.
export function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const hi = code;
      const lo = str.charCodeAt(i + 1);
      code = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      i++;
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

export function base64FromBytes(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + chars[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    result += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + '=';
  }
  return result;
}

export interface ZipEntry {
  name: string;
  content: string;
}

// Build an uncompressed (STORE) ZIP archive and return base64 string.
export function buildZipBase64(entries: ZipEntry[]): string {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  const pushUint16 = (arr: number[], v: number): void => {
    arr.push(v & 0xff, (v >> 8) & 0xff);
  };
  const pushUint32 = (arr: number[], v: number): void => {
    arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  };

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.name);
    const dataBytes = utf8Bytes(entry.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader: number[] = [];
    pushUint32(localHeader, 0x04034b50);
    pushUint16(localHeader, 20); // version needed
    pushUint16(localHeader, 0x0800); // UTF-8 flag
    pushUint16(localHeader, 0); // no compression
    pushUint16(localHeader, 0); // mod time
    pushUint16(localHeader, 0); // mod date
    pushUint32(localHeader, crc);
    pushUint32(localHeader, size);
    pushUint32(localHeader, size);
    pushUint16(localHeader, nameBytes.length);
    pushUint16(localHeader, 0); // extra length

    const localHeaderBytes = new Uint8Array(localHeader);
    localParts.push(localHeaderBytes, nameBytes, dataBytes);

    const centralHeader: number[] = [];
    pushUint32(centralHeader, 0x02014b50);
    pushUint16(centralHeader, 20); // version made by
    pushUint16(centralHeader, 20); // version needed
    pushUint16(centralHeader, 0x0800);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, crc);
    pushUint32(centralHeader, size);
    pushUint32(centralHeader, size);
    pushUint16(centralHeader, nameBytes.length);
    pushUint16(centralHeader, 0); // extra
    pushUint16(centralHeader, 0); // comment
    pushUint16(centralHeader, 0); // disk number
    pushUint16(centralHeader, 0); // internal attrs
    pushUint32(centralHeader, 0); // external attrs
    pushUint32(centralHeader, offset); // local header offset

    const centralHeaderBytes = new Uint8Array(centralHeader);
    const centralEntry = new Uint8Array(centralHeaderBytes.length + nameBytes.length);
    centralEntry.set(centralHeaderBytes, 0);
    centralEntry.set(nameBytes, centralHeaderBytes.length);
    centralParts.push(centralEntry);

    offset += localHeaderBytes.length + nameBytes.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const centralOffset = offset;

  const end: number[] = [];
  pushUint32(end, 0x06054b50);
  pushUint16(end, 0); // disk number
  pushUint16(end, 0); // disk with central dir
  pushUint16(end, entries.length);
  pushUint16(end, entries.length);
  pushUint32(end, centralSize);
  pushUint32(end, centralOffset);
  pushUint16(end, 0); // comment length
  const endBytes = new Uint8Array(end);

  let totalLength = 0;
  for (const p of localParts) totalLength += p.length;
  totalLength += centralSize + endBytes.length;

  const full = new Uint8Array(totalLength);
  let pos = 0;
  for (const p of localParts) {
    full.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    full.set(p, pos);
    pos += p.length;
  }
  full.set(endBytes, pos);

  return base64FromBytes(full);
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    '-' +
    date.getFullYear() +
    '-' +
    pad(date.getHours()) +
    '-' +
    pad(date.getMinutes()) +
    '-' +
    pad(date.getSeconds())
  );
}
