// Comparação determinística do replay Node com a referência gravada.
//
// Regra do gate: só duas liberdades — `sig=...` vira `sig={{sig}}` e as listas
// `streams`/`sources` são ordenadas. Nada além disso é normalizado; qualquer
// outro campo que divirja reprova. Ordem de chaves de objeto é irrelevante
// (comparação por conjunto de chaves), como manda o §9.3 do contrato.
import { isDeepStrictEqual } from 'node:util';

const SIG_RE = /sig=[A-Za-z0-9_-]+/g;

function maskSig(value) {
  if (Array.isArray(value)) return value.map(maskSig);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.replace(SIG_RE, 'sig={{sig}}') : value;
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) out[key] = maskSig(raw);
  return out;
}

export function streamKey(stream) {
  if (!stream || typeof stream !== 'object') return '';
  return String(stream.infoHash || stream.url || stream.name || '');
}

export function normalizeResponse(value) {
  const clone = maskSig(structuredClone(value));
  for (const stream of clone.streams || []) {
    if (Array.isArray(stream.sources)) {
      stream.sources = [...stream.sources].sort((a, b) => String(a).localeCompare(String(b)));
    }
  }
  clone.streams = [...(clone.streams || [])].sort((a, b) => streamKey(a).localeCompare(streamKey(b)));
  return clone;
}

function short(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

/**
 * Primeira diferença de valor, em profundidade, ignorando a ordem das chaves.
 * Devolve `{ path, want, got }` ou `null`.
 */
export function firstDiff(want, got, at = '$') {
  if (Object.is(want, got)) return null;
  if (want === null || got === null || typeof want !== 'object' || typeof got !== 'object') {
    return { path: at, want, got };
  }
  const wantArray = Array.isArray(want);
  const gotArray = Array.isArray(got);
  if (wantArray !== gotArray) return { path: at, want, got };
  if (wantArray) {
    if (want.length !== got.length) return { path: `${at}.length`, want: want.length, got: got.length };
    for (let i = 0; i < want.length; i += 1) {
      const diff = firstDiff(want[i], got[i], `${at}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
  for (const key of keys) {
    if (!(key in want)) return { path: `${at}.${key}`, want: '<ausente>', got: got[key] };
    if (!(key in got)) return { path: `${at}.${key}`, want: want[key], got: '<ausente>' };
    const diff = firstDiff(want[key], got[key], `${at}.${key}`);
    if (diff) return diff;
  }
  return null;
}

function streamLine(label, index, stream) {
  return `${label} #${index} ${stream ? streamKey(stream) : '<ausente>'}`;
}

/** Diff legível: total, primeiro stream divergente e o primeiro campo. */
export function describeDiff(want, got) {
  const lines = [];
  const wantStreams = want.streams || [];
  const gotStreams = got.streams || [];
  lines.push(`streams esperado=${wantStreams.length} replay=${gotStreams.length}`);
  if (want.cacheMaxAge !== got.cacheMaxAge) {
    lines.push(`cacheMaxAge esperado=${want.cacheMaxAge} replay=${got.cacheMaxAge}`);
  }
  let shown = 0;
  const max = Math.max(wantStreams.length, gotStreams.length);
  for (let i = 0; i < max; i += 1) {
    const left = wantStreams[i];
    const right = gotStreams[i];
    if (isDeepStrictEqual(left, right)) continue;
    lines.push(streamLine('esperado', i, left));
    lines.push(streamLine('replay  ', i, right));
    const diff = firstDiff(left, right, `streams[${i}]`);
    if (diff) {
      lines.push(`  campo ${diff.path}`);
      lines.push(`    esperado=${short(diff.want)}`);
      lines.push(`    replay  =${short(diff.got)}`);
    }
    shown += 1;
    if (shown >= 5) break;
  }
  if (shown === 0) {
    const diff = firstDiff(want, got, '$');
    if (diff) {
      lines.push(`campo ${diff.path}`);
      lines.push(`  esperado=${short(diff.want)}`);
      lines.push(`  replay  =${short(diff.got)}`);
    }
  }
  return lines;
}

export function compareResponses(wantRaw, gotRaw) {
  const want = normalizeResponse(wantRaw);
  const got = normalizeResponse(gotRaw);
  if (isDeepStrictEqual(want, got)) {
    return { ok: true, want, got, lines: [] };
  }
  return { ok: false, want, got, lines: describeDiff(want, got) };
}
