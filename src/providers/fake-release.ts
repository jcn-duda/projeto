// Release FALSA publicada com o nome do filme. Uma rede espalha, para filme
// ainda no cinema, "Resident Evil (2026) 1080p AMZN WEB-DL DDP5 1 H 264-FLUX.exe"
// (magnetdownload) e republica o MESMO nome sem a extensão no LimeTorrents, com
// seeders inflados. A AllDebrid guarda em cache o que qualquer um sobe, então o
// falso ganha ⚡ e só o play descobre que não há vídeo (`bad` por hash — o
// gêmeo seguinte escapa). Medido no magnets.db (2026-09-24): 23 releases com
// extensão executável, todas do magnetdownload, nenhuma com cara de BR; 3
// irmãos sem extensão, todos do LimeTorrents, um deles já provado sem vídeo.
//
// Corte 1 — extensão executável no título ou no `dn=`: nenhum filme legítimo se
// chama assim.
// Corte 2 — o irmão: mesmo nome normalizado de um executável da MESMA obra (no
// lote ou no acervo). Quem falsifica COPIA nome de release real, então o irmão
// só cai quando o hash aparece em UM indexer no acervo: a release real circula
// por vários trackers; os três irmãos medidos estavam só no LimeTorrents.
//
// Item da conta (`fromAccount`) fica fora: o que está na conta é escolha do
// usuário, e o play já tem o `NoVideoError` para ele.
import type { RawItem } from '../../types/domain.js';
import { hashOf } from '../utils/magnet-bank.js';
import { executableTitlesForObra, sourcesForMany } from '../utils/magnet-bank-query.js';
import { magnetDisplayName } from '../utils/title-normalization.js';
import { dropTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';

// A extensão fecha o nome (ou vem antes de espaço/colchete): `DVDSCR`,
// `www.site.com` e `NoRaR` não casam.
const EXECUTABLE_RE = /\.(exe|scr|lnk|bat|cmd|msi|pif|vbs)(?=$|[\s\])(|,;])/i;

const titleOf = (item: RawItem) => String(item?.title || item?.Title || '');

/** O título ou o `dn=` declara um executável? */
export function isExecutableRelease(title: string, dn = ''): boolean {
  return EXECUTABLE_RE.test(String(title || '')) || EXECUTABLE_RE.test(String(dn || ''));
}

/** Nome comparável: sem a extensão, sem pontuação, em minúsculas. */
export function fakeReleaseBase(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(new RegExp(EXECUTABLE_RE.source, 'gi'), ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Tira do lote os executáveis e os irmãos deles. `imdbId` alimenta a leitura
 * do acervo (o executável pode não ter vindo nesta busca); sem ele, só o lote.
 */
export function dropFakeReleases(
  raw: RawItem[],
  { imdbId, trace }: { imdbId?: string | null; trace?: StreamTraceState | null } = {},
): RawItem[] {
  const executables = new Set<RawItem>();
  const bases = new Set<string>();
  for (const item of raw) {
    if (!item || item.fromAccount) continue;
    if (isExecutableRelease(titleOf(item), magnetDisplayName(item))) {
      executables.add(item);
      bases.add(fakeReleaseBase(titleOf(item)));
    }
  }
  for (const title of imdbId ? executableTitlesForObra(imdbId) : []) {
    if (isExecutableRelease(title)) bases.add(fakeReleaseBase(title));
  }
  if (executables.size === 0 && bases.size === 0) return raw;

  const twinCandidates = raw.filter((item) =>
    item && !item.fromAccount && !executables.has(item) && bases.has(fakeReleaseBase(titleOf(item))));
  const hashes = twinCandidates.map((item) => hashOf(item)).filter(Boolean) as string[];
  const sources = hashes.length ? sourcesForMany(hashes) : new Map();
  const twins = new Set(twinCandidates.filter((item) => {
    const hash = hashOf(item);
    // Sem hash ou fora do acervo não há como provar que circula em um só lugar.
    if (!hash || !sources.has(hash)) return false;
    return (sources.get(hash) || []).length <= 1;
  }));
  if (executables.size === 0 && twins.size === 0) return raw;

  for (const item of executables) dropTrace(trace, item, 'fake-release');
  for (const item of twins) dropTrace(trace, item, 'fake-release');
  if (executables.size) metrics.count('search.fake.executable', executables.size);
  if (twins.size) metrics.count('search.fake.twin', twins.size);
  log.info(`[search] ${executables.size + twins.size} release(s) falsa(s) descartada(s) (${executables.size} executável, ${twins.size} irmão)`);
  return raw.filter((item) => !executables.has(item) && !twins.has(item));
}
