// Réguas puras da captura do banco de magnets vivo, migradas de
// `src/utils/magnet-bank-merge.ts` no corte da família TS (Fase 4 do plano
// docs/superpowers/plans/2026-11-01-banco-vivo-corte.md): quem captura e grava
// o acervo hoje é o gateway (`magnet_bank_capture`/`magnet_bank_write` do
// `adom-store`) e a fachada TS saiu. Fica aqui só o que testes/oráculos
// exercitam: `inputFromItem`/`classifiedDubbed` (régua da captura e do
// backfill), `hashOf`/`parseSeeders` e a régua de URI mais rica (`isRicherUri`)
// que o oráculo do import usa. As deps de vocabulário continuam em `src/` (o
// porte vivo é o `adom-core`); o que aqui está é a fotografia da régua na
// hora do corte.
//
// As regras vêm da especificação da feature:
// - `first_seen` é fixo; `seeders_max` é máximo e `seeders_last` é a última
//   observação (item sem seeders PRESERVA a anterior; 0 explícito é medição);
// - `title`/`size` ficam os primeiros não vazios; `is_br`/`dubbed`/`lied` só
//   sobem (OR), como no índice;
// - `uri` só troca por outra MAIS RICA (`dn=` ou mais trackers) — nunca
//   rebaixa para o `magnetFor`/`defaultMagnet`;
// - `passed_filter` NÃO é OR: reflete a ÚLTIMA observação da obra.
import type { RawItem } from '../../../types/domain.js';
import { extractInfoHash, magnetDisplayName } from '../../../src/utils/title-normalization.js';
import { sanitizeMagnet, defaultMagnet } from '../../../src/utils/magnet-uri.js';
import { sourceFromTitle, qualityFromTitle, audioFromTitle, explicitPtAudio, UNKNOWN_QUALITY } from './audio-quality.js';

export type MagnetInput = {
  hash: string; uri: string; title: string; size: number; isBr: boolean; dubbed: boolean;
  lied: boolean; quality: string;
  /** Máximo de seeders visto na leva (0 quando nenhum item trouxe número). */
  seedersMax: number;
  /** Última observação numérica; null = item não trouxe seeders. */
  seedersLast: number | null;
};
export type SourceInput = { hash: string; indexer: string; tracker: string; seedersLast: number | null };

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

/** "sem resolução" é AUSÊNCIA, não medição: não bloqueia a qualidade real que chega depois. */
function knownQuality(quality: string): string {
  return quality && quality !== UNKNOWN_QUALITY ? quality : '';
}

/**
 * "Dublado" pelo TÍTULO, a mesma régua do `release-index`: em site BR o rótulo
 * de áudio Dublado/Dual/Nacional; fora deles só PT explícito (DUAL de cena
 * gringa não é dublagem). É a PROMESSA do post, não prova de arquivo — quem
 * monta a lista reclassifica pelo título de todo modo.
 */
export function classifiedDubbed(title: string, isBr: boolean): boolean {
  return isBr ? ['Dublado', 'Dual', 'Nacional'].includes(String(audioFromTitle(title))) : explicitPtAudio(title);
}

/**
 * Item bruto → linhas de captura. Devolve null para item sem hash, item de
 * CONTA (`fromAccount`), item de FALLBACK (`fromFallback`) e FOTO do índice
 * (`fromSnapshot`): o inventário é conhecimento da credencial, o fallback é
 * reserva derivada do próprio banco e a foto é o que o índice já sabia —
 * nenhum dos três é observação nova do site e todos se perpetuariam (Etapa 4).
 *
 * A guarda de `fromSnapshot` é a SEGUNDA camada: o Rust já a aplica em
 * `magnet_capture`, mas capturar a foto renovaria `lastSeen`/`seedersLast` no
 * merge e o banco passaria a "provar" frescor que não houve.
 */
export function inputFromItem(item: RawItem, groupIndexer: string): { magnet: MagnetInput; source: SourceInput } | null {
  if (!item || item.fromAccount || item.fromFallback || item.fromSnapshot) return null;
  const hash = hashOf(item);
  if (!hash) return null;
  const rawMagnet = magnetUriOf(item);
  // URI sanitizada (sem credencial); quando o post só resulta no padrão, guarda
  // o `defaultMagnet` mesmo assim para o clone ser total — a remontagem pelo
  // `magnetFor` no play não substitui o dado, aqui o banco é a fonte durável.
  const uri = (rawMagnet ? sanitizeMagnet(rawMagnet, hash) : null) ?? defaultMagnet(hash);
  const seeders = parseSeeders(item.seeders ?? item.Seeders);
  const indexer = (groupIndexer || String(item.indexer || item.Indexer || '')).toLowerCase().slice(0, 64) || 'all';
  return {
    magnet: {
      hash,
      uri,
      // O título do post pode esconder a gravação ("Resident Evil (2026)
      // [1080p 2.60 GB]"), mas o dn= do magnet revela ("…CAMRip…"). Quando
      // o magnet prova CAM e o título não diz, guarda o nome do magnet como
      // título: a evidência do arquivo vence o palpite do WordPress. Sem
      // isso, o item servido do banco instantâneo perde a marca CAM e o
      // excludeCam do usuário não corta.
      title: (() => {
        const postTitle = String(item.title || item.Title || '');
        const dn = magnetDisplayName(item);
        if (dn && sourceFromTitle(dn) === 'CAM' && sourceFromTitle(postTitle) !== 'CAM') {
          return dn;
        }
        return postTitle;
      })(),
      size: Number(item.size ?? item.Size) || 0,
      isBr: Boolean(item.isBr),
      // O item cru do Jackett não traz `dubbed`/`quality` (quem classifica é o
      // `toStremioStream`, depois): as duas colunas ficaram vazias em 182 mil
      // magnets (medido 2026-09-30). Mesma régua do índice (`release-index`).
      dubbed: Boolean(item.dubbed) || classifiedDubbed(String(item.title || item.Title || ''), Boolean(item.isBr)),
      lied: Boolean(item.lied),
      quality: String(item.quality || knownQuality(qualityFromTitle(String(item.title || item.Title || '')))),
      seedersMax: seeders ?? 0,
      seedersLast: seeders,
    },
    source: { hash, indexer, tracker: String(item.tracker || item.Tracker || ''), seedersLast: seeders },
  };
}
