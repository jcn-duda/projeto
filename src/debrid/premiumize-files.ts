// Lista de arquivos de pack PRONTO na Premiumize, para a listagem. O
// `/cache/check` só diz sim/não e o tamanho total; os nomes dos arquivos só
// vêm do `/transfer/directdl`, que o play chama. Sem eles o pack sem
// resolução no título ("O.Segredo.de.Widow's Bay.S01.Dub E01-E08", 10 GB)
// seguia "sem resolução" até alguém tocá-lo (2026-10-04), enquanto TorBox e
// AllDebrid já liam os arquivos na checagem.
//
// Fora da resposta de propósito: o directdl é uma chamada por hash e a
// checagem já corre contra o prazo. A lista entra no memo (`fsz`) e no índice
// pelo mesmo `recordFileEvidence` do play; a PRÓXIMA busca lê o tamanho e a
// resolução dela (`probed-quality.ts`, `episode-size.ts`).
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { magnetForPlay } from './common.js';
import { recordFileEvidence } from './audio-audit.js';
import { hasFileSizes } from './file-sizes.js';

// Por checagem: o resto entra nas buscas seguintes (mesma régua das medições
// de cabeçalho da AllDebrid, `MAX_PROBES_PER_BUILD`).
const MAX_PER_CHECK = 2;
const inFlight = new Set<string>();

type Call = (apiKey: string, path: string, init: { method: string; body: URLSearchParams; timeout: number }) => Promise<any>;

/** Agenda a leitura dos arquivos dos `wanted` que estão prontos. */
function scheduleFileLists(call: Call, apiKey: string, cached: readonly string[], wanted: ReadonlySet<string>): number {
  if (!config.debrid.qualityProbe || !apiKey || wanted.size === 0) return 0;
  let started = 0;
  for (const raw of cached) {
    if (started >= MAX_PER_CHECK) break;
    const hash = String(raw || '').toLowerCase();
    if (!wanted.has(hash) || inFlight.has(hash) || hasFileSizes(hash)) continue;
    inFlight.add(hash);
    started += 1;
    void (async () => {
      try {
        const data = await call(apiKey, '/transfer/directdl', {
          method: 'POST',
          body: new URLSearchParams({ src: magnetForPlay(hash) }),
          timeout: config.debrid.cacheCheckTimeout,
        });
        recordFileEvidence(hash, data?.content || []);
        metrics.count('debrid.premiumize.fileList');
      } catch (err) {
        metrics.count('debrid.premiumize.fileListFailed');
        log.debug(`[debrid] premiumize: lista de arquivos de ${hash.slice(0, 8)} falhou: ${(err as Error)?.message || err}`);
      } finally {
        inFlight.delete(hash);
      }
    })();
  }
  return started;
}

/**
 * Link direto e fresco de UM arquivo de pack pronto, para a medição do
 * cabeçalho (`video-quality.ts`). O link guardado no `fsz` expira em horas e
 * o memo dura 30 dias, então a medição pede um novo. Os nomes do pack de
 * Widow's Bay ("…S01.Dub.EP-1.mp4") não dizem a resolução: só o vídeo diz.
 */
async function freshFileLink(call: Call, apiKey: string, hash: string, path: string): Promise<{ url: string; size: number } | null> {
  const data = await call(apiKey, '/transfer/directdl', {
    method: 'POST',
    body: new URLSearchParams({ src: magnetForPlay(hash) }),
    timeout: config.debrid.cacheCheckTimeout,
  });
  const file = (Array.isArray(data?.content) ? data.content : []).find((f: any) => f?.path === path);
  return file?.link ? { url: String(file.link), size: Number(file.size) || 0 } : null;
}

export { scheduleFileLists, freshFileLink };
