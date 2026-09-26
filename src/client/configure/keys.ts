/* Adom Power-Movie - /configure: chaves curtas do segmento de URL e o
 * base64url. KEYS precisa bater com SCHEMA em src/runtime.ts: a config inteira
 * vira um segmento, então nome longo custa caro. */

export const KEYS = {
  providers: 'p', qualities: 'q', maxResults: 'm', minSeeders: 's',
  max2160p: 'q4', max1080p: 'q1', max720p: 'q7', max480p: 'q5', maxSd: 'qs', maxUnknown: 'qn',
  maxPerIndexer: 'qi',
  brReservedSlots: 'b', brOnly: 'o', dubbedOnly: 'd',
  preferDubbed: 'a', excludeCam: 'c', maxSizeGb: 'z', brFirst: 'bf',
  jackettIndexers: 'ji', indexerPriority: 'ip', indexerLimits: 'jl',
  debridService: 'ds', debridApiKey: 'dk', debridCachedOnly: 'dc', showUncachedBr: 'bu', autoFetchBr: 'ab',
  streamNameStyle: 'ns', streamNameShowSource: 'st',
} as const;

// Espelha o prefixo de src/utils/secret-box.ts.
export function isSealedKey(value: unknown): boolean {
  return typeof value === 'string' && value.indexOf('enc.v1.') === 0;
}

export function encodeConfig(obj: unknown): string {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConfig(segment: string): any {
  try {
    let b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (e) {
    return null;
  }
}
