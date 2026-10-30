/**
 * Corpo TS do `resolveLink` do Premiumize, tirado de `src/debrid/premiumize.ts`.
 * Produção não roda isto: `current()` embrulha o adaptador na ponte nativa, que
 * sobrepõe o método. Só o oráculo de paridade chama, via `rawAdapter()`.
 *
 * O `checkCached` NÃO saiu de `src/`: o diagnóstico `liveCheck`
 * (`live-check.ts`, /stream-trace.json) lê o GET cru de lote pelo adaptador de
 * `BY_ID`, e essa leitura crua é justamente o contrato dele.
 */
import { magnetForPlay, pickFile } from '../../../../src/debrid/common.js';
import { assertDubbedFiles, recordFileEvidence } from '../../../../src/debrid/audio-audit.js';
import { call } from '../../../../src/debrid/premiumize.js';
import type { PlayHint } from '../../../../types/domain.js';

/**
 * Resolve o link direto de reprodução — só na hora do play, porque o directdl
 * é caro demais pra rodar em cima da lista inteira de torrents.
 *
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: PlayHint = {}) {
  const body = new URLSearchParams({ src: magnetForPlay(infoHash) });
  const data = await call(apiKey, '/transfer/directdl', { method: 'POST', body });
  const file = pickFile(data.content || [], { season, episode, work });
  recordFileEvidence(infoHash, data.content || []);
  assertDubbedFiles(data.content || [], Boolean(dubbed));
  return file ? file.stream_link || file.link : null;
}
export const bodies = { resolveLink };
