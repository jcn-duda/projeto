// Oráculo congelado do lado IMPORT da transferência do banco de magnets.
// Saiu de `src/utils/magnet-bank-transfer.ts` no commit eeb02b94 (branch rust):
// a régua TS do import saiu do src/ porque quem mescla/grava o acervo hoje é o
// gateway (`POST /magnet-bank/import` na admin 8711, `adom-store::
// magnet_bank_import`) — a rota Node só spoola o arquivo descompactado e
// repassa. Fica aqui como régua TS para `test/magnet-bank-transfer.test.ts`
// continuar exigindo a mesma validação e a mesma mescla. O lado EXPORT também
// é do gateway desde o corte da família TS (`GET /magnet-bank/export` na
// admin, `adom-store::magnet_bank_export`); o formato do arquivo
// (`TRANSFER_FORMAT`/`TRANSFER_VERSION`) é importado do módulo vivo — é o
// contrato do arquivo NDJSON, não parte congelada. As linhas tipadas eram de
// `src/utils/magnet-bank-rows.js` e agora moram aqui (a família saiu).
//
// Para que serve: o `magnets.db` é acervo PERMANENTE — o que o site derrubado
// já não devolve só existe ali. O import traz de volta o acervo do export.
//
// O import MESCLA, nunca substitui (decisão do operador, 2026-09-29): a
// regra é a do próprio banco — `first_seen` o mais antigo, `last_seen` o mais
// novo, seeders máximos, `is_br`/`dubbed`/`lied` só sobem, URI só troca por
// outra mais rica. Importar o mesmo arquivo duas vezes não muda nada na
// segunda, e nada que já existe localmente é apagado.
import { isRicherUri } from './magnet-bank-merge.js';

// --- Linhas do acervo (eram de `src/utils/magnet-bank-rows.js`) ------------

export interface MagnetRow {
  hash: string; uri: string; title: string; size: number;
  isBr: number; dubbed: number; quality: string;
  seedersMax: number; seedersLast: number; firstSeen: number; lastSeen: number; lied: number;
}

export interface SourceRow {
  hash: string; indexer: string; tracker: string;
  firstSeen: number; lastSeen: number; seedersLast: number;
}

export interface WorkRow {
  hash: string; imdb: string; season: number; episode: number;
  firstSeen: number; lastSeen: number; passedFilter: number;
}

// --- Validação de registro vindo de arquivo --------------------------------

const HASH_RE = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/;
const IMDB_RE = /^tt\d{1,12}$/;
const MAX_URI = 2048;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown, min = 0): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min ? n : min;
};
const flag = (v: unknown): number => (Number(v) ? 1 : 0);
const hashOf = (v: unknown): string | null => {
  const h = str(v, 64).toLowerCase();
  return HASH_RE.test(h) ? h : null;
};

/** Magnet do arquivo → linha do banco; `null` quando não é registro válido. */
export function readMagnet(o: Record<string, unknown>): MagnetRow | null {
  const hash = hashOf(o.hash);
  if (!hash) return null;
  const uri = str(o.uri, MAX_URI + 1);
  return {
    hash,
    // URI que não é magnet (ou longa demais) vira vazia: o play cai no magnet
    // padrão do hash, que é o comportamento de banco sem URI.
    uri: uri.length <= MAX_URI && /^magnet:\?/i.test(uri) ? uri : '',
    title: str(o.title, 500),
    size: int(o.size),
    isBr: flag(o.isBr),
    dubbed: flag(o.dubbed),
    quality: str(o.quality, 20),
    seedersMax: int(o.seedersMax),
    seedersLast: int(o.seedersLast),
    firstSeen: int(o.firstSeen),
    lastSeen: int(o.lastSeen),
    lied: flag(o.lied),
  };
}

export function readSource(o: Record<string, unknown>): SourceRow | null {
  const hash = hashOf(o.hash);
  const indexer = str(o.indexer, 100);
  if (!hash || !indexer) return null;
  return {
    hash, indexer, tracker: str(o.tracker, 100),
    firstSeen: int(o.firstSeen), lastSeen: int(o.lastSeen), seedersLast: int(o.seedersLast),
  };
}

export function readWork(o: Record<string, unknown>): WorkRow | null {
  const hash = hashOf(o.hash);
  const imdb = str(o.imdb, 20);
  if (!hash || !IMDB_RE.test(imdb)) return null;
  return {
    hash, imdb, season: int(o.season, -1), episode: int(o.episode, -1),
    firstSeen: int(o.firstSeen), lastSeen: int(o.lastSeen), passedFilter: flag(o.passedFilter),
  };
}

// --- Mesclagem linha × linha (as datas vêm do arquivo, não do relógio) ------

const minSeen = (a: number, b: number) => (a && b ? Math.min(a, b) : a || b);

export function mergeMagnetRows(prev: MagnetRow | null, next: MagnetRow): MagnetRow {
  if (!prev) return next;
  const newer = next.lastSeen > prev.lastSeen;
  return {
    hash: prev.hash,
    uri: isRicherUri(next.uri, prev.uri) ? next.uri : prev.uri,
    title: prev.title || next.title,
    size: prev.size || next.size,
    isBr: prev.isBr || next.isBr ? 1 : 0,
    dubbed: prev.dubbed || next.dubbed ? 1 : 0,
    quality: prev.quality || next.quality,
    seedersMax: Math.max(prev.seedersMax, next.seedersMax),
    seedersLast: newer ? next.seedersLast : prev.seedersLast,
    firstSeen: minSeen(prev.firstSeen, next.firstSeen),
    lastSeen: Math.max(prev.lastSeen, next.lastSeen),
    lied: prev.lied || next.lied ? 1 : 0,
  };
}

export function mergeWorkRows(prev: WorkRow | null, next: WorkRow): WorkRow {
  if (!prev) return next;
  // `passed_filter` reflete a ÚLTIMA observação da obra (regra do banco): vence
  // o lado com `last_seen` mais novo, e o empate preserva o local.
  const newer = next.lastSeen > prev.lastSeen;
  return {
    ...prev,
    firstSeen: minSeen(prev.firstSeen, next.firstSeen),
    lastSeen: Math.max(prev.lastSeen, next.lastSeen),
    passedFilter: newer ? next.passedFilter : prev.passedFilter,
  };
}
