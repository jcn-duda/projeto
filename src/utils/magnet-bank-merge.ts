// Banco de magnets vivo — REGRAS PURAS: merge das linhas e extração do item.
//
// Separado de `magnet-bank.ts` pela catraca de 400 linhas: aqui não há engine,
// fila nem I/O — só as decisões que os testes conseguem exercitar sem banco.
// As regras vêm da especificação da feature:
// - `first_seen` é fixo; `seeders_max` é máximo e `seeders_last` é a última
//   observação (item sem seeders PRESERVA a anterior; 0 explícito é medição);
// - `title`/`size` ficam os primeiros não vazios; `is_br`/`dubbed`/`lied` só
//   sobem (OR), como no índice;
// - `uri` só troca por outra MAIS RICA (`dn=` ou mais trackers) — nunca
//   rebaixa para o `magnetFor`/`defaultMagnet`;
// - `passed_filter` NÃO é OR: reflete a ÚLTIMA observação da obra (a captura
//   nasce 0 e o resultado do filtro da mesma busca escreve 0/1).
import type { RawItem } from '../../types/domain.js';
import { extractInfoHash, magnetDisplayName } from './title-normalization.js';
import { sanitizeMagnet, defaultMagnet } from './magnet-uri.js';
import { sourceFromTitle, looksPtBr } from './audio-quality.js';
import type { MagnetRow, SourceRow, WorkRow } from './magnet-bank-rows.js';

export type WorkCtx = {
  imdbId?: string | null; season?: number | null; episode?: number | null;
  /**
   * Só a coleta VIVA (a que será seguida por `markFilterResult`) reseta a obra
   * para 0 nesta captura. Captura de FUNDO (colhedor/varredura de cauda) não
   * executa o filtro do stream-builder: preserva o `passed_filter` existente e
   * só cria 0 quando a obra ainda não existe. Sem reset explícito, preserva.
   */
  resetPassedFilter?: boolean;
};

export type MagnetInput = {
  hash: string; uri: string; title: string; size: number; isBr: boolean; dubbed: boolean;
  lied: boolean; quality: string;
  /** Máximo de seeders visto na leva (0 quando nenhum item trouxe número). */
  seedersMax: number;
  /** Última observação numérica; null = item não trouxe seeders. */
  seedersLast: number | null;
};
export type SourceInput = { hash: string; indexer: string; tracker: string; seedersLast: number | null };
export type WorkMark = { hash: string; imdb: string; season: number; episode: number; passedFilter: number };

const normEp = (v: number | null | undefined): number => (v == null ? -1 : Math.trunc(Number(v)));

/** `season`/`episode` viram -1 quando nulos: parte da PK de `magnet_work`. */
export function workTuple(ctx: WorkCtx): { imdb: string; season: number; episode: number } {
  return { imdb: String(ctx?.imdbId || ''), season: normEp(ctx?.season), episode: normEp(ctx?.episode) };
}

/**
 * Seeders do item: devolve null quando AUSENTE (string vazia/null/undefined ou
 * não numérico), para o merge PRESERVAR a última observação. `0` é número
 * válido e continua sendo observação — distinto de "não veio".
 */
export function parseSeeders(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Hash canônico (40-hex minúsculo) do item bruto. Tenta `infoHash`, `magnet`,
 * `MagnetUri` e `Guid` EM ORDEM até achar válido — `infoHash` presente mas
 * inválido (string suja) não pode cegar as outras fontes. Mesmo extrator do
 * pipeline (`extractInfoHash`), que já aceita hash puro ou URI de magnet.
 */
export function hashOf(item: RawItem): string {
  const guid = typeof item?.Guid === 'string' ? item.Guid : '';
  for (const candidate of [item?.infoHash, item?.magnet, item?.MagnetUri, guid]) {
    const hash = String(extractInfoHash(candidate || '') || '').toLowerCase();
    if (hash) return hash;
  }
  return '';
}

/** URI de magnet do item: primeiro candidato que É magnet (`magnet:`). */
function magnetUriOf(item: RawItem): string {
  const guid = typeof item.Guid === 'string' ? item.Guid : '';
  for (const candidate of [item.magnet, item.MagnetUri, guid]) {
    const uri = String(candidate || '');
    if (uri.startsWith('magnet:')) return uri;
  }
  return '';
}

/** Presença de `dn=` e contagem de trackers — a régua de "URI mais rica". */
function uriShape(uri: string) {
  return { hasDn: /[?&]dn=[^&]/.test(uri), trackers: (uri.match(/[?&]tr=/g) || []).length };
}

/**
 * A nova URI só substitui a guardada quando é MAIS rica: tem `dn=` (a antiga
 * não) ou mais trackers. `defaultMagnet` (só o piso) nunca rebaixa uma URI com
 * `dn=`/trackers do post; no sentido oposto, um post mais rico promove a
 * padrão. Empate mantém a guardada — a primeira evidência vence.
 */
export function isRicherUri(next: string, prev: string): boolean {
  if (!prev) return Boolean(next);
  if (!next || next === prev) return false;
  const a = uriShape(next);
  const b = uriShape(prev);
  if (a.hasDn !== b.hasDn) return a.hasDn;
  return a.trackers > b.trackers;
}

/** Merge de duas capturas da MESMA leva (hashes repetidos entre indexers). */
export function mergeInputs(prev: MagnetInput, next: MagnetInput): MagnetInput {
  return {
    ...prev,
    uri: isRicherUri(next.uri, prev.uri) ? next.uri : prev.uri,
    title: prev.title || next.title,
    size: prev.size || next.size,
    isBr: prev.isBr || next.isBr,
    dubbed: prev.dubbed || next.dubbed,
    lied: prev.lied || next.lied,
    quality: prev.quality || next.quality,
    seedersMax: Math.max(prev.seedersMax, next.seedersMax),
    seedersLast: next.seedersLast != null ? next.seedersLast : prev.seedersLast,
  };
}

/** Merge de duas fontes da MESMA leva (mesmo hash+indexer). */
export function mergeSourceInput(prev: SourceInput, next: SourceInput): SourceInput {
  return {
    ...prev,
    tracker: prev.tracker || next.tracker,
    seedersLast: next.seedersLast != null ? next.seedersLast : prev.seedersLast,
  };
}

/** Upsert do registro de conteúdo: first_seen fixo, seeders_max máximo, flags OR. */
export function mergeMagnet(prev: MagnetRow | null, input: MagnetInput, now: number, liedAny = false): MagnetRow {
  if (!prev) {
    return {
      hash: input.hash,
      uri: input.uri,
      title: input.title,
      size: input.size,
      isBr: input.isBr ? 1 : 0,
      dubbed: input.dubbed ? 1 : 0,
      quality: input.quality,
      seedersMax: input.seedersMax,
      seedersLast: input.seedersLast ?? 0,
      firstSeen: now,
      lastSeen: now,
      lied: input.lied || liedAny ? 1 : 0,
    };
  }
  return {
    ...prev,
    uri: isRicherUri(input.uri, prev.uri) ? input.uri : prev.uri,
    title: prev.title || input.title,
    size: prev.size || input.size,
    // `is_br`, `dubbed` e `lied` nunca voltam a falso (mesma regra do idx).
    isBr: prev.isBr || (input.isBr ? 1 : 0),
    dubbed: prev.dubbed || (input.dubbed ? 1 : 0),
    lied: prev.lied || (input.lied ? 1 : 0) || (liedAny ? 1 : 0),
    quality: prev.quality || input.quality,
    seedersMax: Math.max(prev.seedersMax, input.seedersMax),
    // Seeders ausente PRESERVA o último valor; 0 é observação e sobrescreve.
    seedersLast: input.seedersLast != null ? input.seedersLast : prev.seedersLast,
    lastSeen: now,
  };
}

export function mergeSource(prev: SourceRow | null, input: SourceInput, now: number): SourceRow {
  if (!prev) {
    return {
      hash: input.hash,
      indexer: input.indexer,
      tracker: input.tracker,
      firstSeen: now,
      lastSeen: now,
      seedersLast: input.seedersLast ?? 0,
    };
  }
  return {
    ...prev,
    tracker: prev.tracker || input.tracker,
    lastSeen: now,
    seedersLast: input.seedersLast != null ? input.seedersLast : prev.seedersLast,
  };
}

/**
 * Upsert da obra. `passed_filter` é SOBRESCRITO: o valor já chega resolvido
 * pelo coalescing da leva (captura = 0; resultado do filtro = 0/1). OR aqui
 * tornaria a marca permanente e a queda 1→0 impossível.
 */
export function mergeWork(prev: WorkRow | null, mark: WorkMark, now: number): WorkRow {
  if (!prev) {
    return {
      hash: mark.hash,
      imdb: mark.imdb,
      season: mark.season,
      episode: mark.episode,
      firstSeen: now,
      lastSeen: now,
      passedFilter: mark.passedFilter,
    };
  }
  return { ...prev, lastSeen: now, passedFilter: mark.passedFilter };
}

/**
 * Item bruto → linhas de captura. Devolve null para item sem hash, item de
 * CONTA (`fromAccount`) e item de FALLBACK (`fromFallback`): o inventário é
 * conhecimento da credencial e o fallback é reserva derivada do próprio banco —
 * nenhum dos dois é observação nova do site e ambos se perpetuariam (Etapa 4).
 */
export function inputFromItem(item: RawItem, groupIndexer: string): { magnet: MagnetInput; source: SourceInput } | null {
  if (!item || item.fromAccount || item.fromFallback) return null;
  const hash = hashOf(item);
  if (!hash) return null;
  const rawMagnet = magnetUriOf(item);
  // URI sanitizada (sem credencial); quando o post só resulta no padrão, guarda
  // o `defaultMagnet` mesmo assim para o clone ser total — a remontagem pelo
  // `magnetFor` no play não substitui o dado, aqui o banco é a fonte durável.
  const uri = (rawMagnet ? sanitizeMagnet(rawMagnet, hash) : null) ?? defaultMagnet(hash);
  const seeders = parseSeeders(item.seeders ?? item.Seeders);
  const indexer = (groupIndexer || String(item.indexer || item.Indexer || '')).toLowerCase().slice(0, 64) || 'all';
  // O título do post pode esconder a gravação ("Resident Evil (2026)
  // [1080p 2.60 GB]"), mas o dn= do magnet revela ("…CAMRip…"). Quando
  // o magnet prova CAM e o título não diz, guarda o nome do magnet como
  // título: a evidência do arquivo vence o palpite do WordPress. Sem
  // isso, o item servido do banco instantâneo perde a marca CAM e o
  // excludeCam do usuário não corta.
  const postTitle = String(item.title || item.Title || '');
  const dn = magnetDisplayName(item);
  const title = dn && sourceFromTitle(dn) === 'CAM' && sourceFromTitle(postTitle) !== 'CAM' ? dn : postTitle;
  return {
    magnet: {
      hash,
      uri,
      title,
      size: Number(item.size ?? item.Size) || 0,
      // O isBr do item vem da LISTAGEM, onde o overlay Jev (gateado) pode ter
      // derrubado um generic DUB ao vivo. `is_br` aqui é PERMANENTE e só sobe
      // por OR: gravar 0 influenciado congelava a origem do magnet no banco.
      // Reclassifica com {overlay:false} sobre o TÍTULO DO POST (o mesmo texto
      // que o produtor classificou) — acervo determinístico, igual ao idx.
      isBr: Boolean(item.isBr) || looksPtBr(postTitle, { overlay: false }),
      dubbed: Boolean(item.dubbed),
      lied: Boolean(item.lied),
      quality: String(item.quality || ''),
      seedersMax: seeders ?? 0,
      seedersLast: seeders,
    },
    source: { hash, indexer, tracker: String(item.tracker || item.Tracker || ''), seedersLast: seeders },
  };
}
