// Rotas de EXPORTAR/IMPORTAR o banco de magnets vivo (aba Magnets do painel).
// O EXPORT lê pelo Node (`utils/magnet-bank-transfer.ts`). O IMPORT é do gateway
// Rust: o Node só descompacta o upload para um temporário e pede a mescla à
// admin (`utils/magnet-bank-native.ts`), porque ele não pode gravar no mesmo
// SQLite que o gateway. Aqui fica só o transporte HTTP.
//
// Fora do `/dashboard-action.json` de propósito: aquele é JSON com teto de 4 KB
// e a transferência é um ARQUIVO de dezenas de MB, em fluxo nos dois sentidos.
// Mesmo token (`X-Indexer-Test-Token`, nunca `?token=`), mas SEM o gate de
// diagnóstico: ele admite uma operação por vez, e segurá-lo durante minutos de
// export deixaria o poll do próprio painel em 429. A trava daqui é outra —
// uma transferência por processo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { asyncRoute } from './async.js';
import { unavailable } from './stream-trace.js';
import type { AppServices } from './types.js';
import { flushBarrier, invalidateStatusCache, readEngine } from '../utils/magnet-bank.js';
import { exportLines } from '../utils/magnet-bank-transfer.js';
import { importNativeBank } from '../utils/magnet-bank-native.js';

let busy = false;

function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** Corta o fluxo quando os bytes DESCOMPACTADOS passam do teto do operador. */
function byteCap(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > max) return done(new Error(`arquivo maior que o teto (MAGNET_BANK_IMPORT_MAX_BYTES=${max})`));
      done(null, chunk);
    },
  });
}

export function makeMagnetBankTransferHandlers(services: AppServices) {
  const exportBank = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'diagnóstico desativado pelo operador', { ok: false })) return;
    const engine = readEngine();
    if (!engine) return res.status(409).json({ ok: false, error: 'banco de magnets desligado (MAGNET_BANK=false)' });
    if (busy) return res.status(409).json({ ok: false, error: 'outra exportação/importação em andamento' });
    busy = true;
    try {
      // A fila de captura grava em lote fora da resposta: sem a barreira, o que
      // a última busca achou ainda não estaria no arquivo.
      flushBarrier();
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="adom-magnets-${stamp()}.ndjson.gz"`);
      res.setHeader('Cache-Control', 'no-store');
      await pipeline(Readable.from(exportLines(engine)), zlib.createGzip(), res);
      services.metrics.count('magnetbank.export');
    } catch (err: unknown) {
      services.metrics.count('magnetbank.export.failed');
      services.log.warn('[magnetbank] exportação falhou:', services.log.errorMessage(err));
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'falha na exportação' });
      else res.destroy();
    } finally {
      busy = false;
    }
  });

  const importBank = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'diagnóstico desativado pelo operador', { ok: false })) return;
    // Sem `readEngine()` aqui: quem grava é o gateway. O `MAGNET_BANK=false`
    // continua sendo o kill-switch da GRAVAÇÃO (o mesmo `.env` do gateway), por
    // isso a recusa fica antes de qualquer upload ou chamada à admin.
    if (!services.config.magnetBank.enabled) {
      return res.status(409).json({ ok: false, error: 'banco de magnets desligado (MAGNET_BANK=false)' });
    }
    if (busy) return res.status(409).json({ ok: false, error: 'outra exportação/importação em andamento' });
    busy = true;
    const started = Date.now();
    let spool = '';
    try {
      // A fila do Node grava por cima do mesmo acervo: drená-la antes evita que
      // a mescla do gateway compita com um lote pendente de captura local.
      flushBarrier();
      // `Content-Type: application/gzip` é o export do painel; NDJSON cru
      // (`application/x-ndjson`) também entra, para quem montou o arquivo à mão.
      const gz = /gzip/i.test(String(req.get('Content-Type') || ''));
      // O spool já sai DESCOMPACTADO e com o nome que o gateway exige
      // (`adom-magnets-import-<algo>.ndjson`, absoluto): ele lê o arquivo do
      // disco local, sem o gzip nem o corpo HTTP. O teto vale sobre os bytes
      // descompactados, como antes; um gzip corrompido cai no catch com 400.
      spool = path.join(os.tmpdir(), `adom-magnets-import-${process.pid}-${started}.ndjson`);
      const out = fs.createWriteStream(spool);
      const cap = byteCap(services.config.magnetBank.importMaxBytes);
      if (gz) await pipeline(req, zlib.createGunzip(), cap, out);
      else await pipeline(req, cap, out);

      const result = await importNativeBank(spool);
      invalidateStatusCache();
      const ms = Date.now() - started;
      if (!result) {
        services.metrics.count('magnetbank.import.failed');
        return res.status(503).json({
          ok: false,
          reason: 'native-unavailable',
          error: 'a admin do gateway não respondeu (import do banco é nativo)',
          ms,
        });
      }
      const ok = result.body.ok === true;
      services.metrics.count(ok ? 'magnetbank.import' : result.status >= 500 ? 'magnetbank.import.failed' : 'magnetbank.import.refused');
      const magnets = (result.body.magnets ?? {}) as { inserted?: number; merged?: number };
      services.log.info(`[magnetbank] importação ${ok ? 'concluída' : 'recusada'} pelo gateway: `
        + `${magnets.inserted ?? 0} novo(s), ${magnets.merged ?? 0} mesclado(s), ${result.body.rejected ?? 0} rejeitado(s)`);
      const status = result.status >= 200 && result.status < 600 ? result.status : 502;
      return res.status(status).json({ ...result.body, ms });
    } catch (err: unknown) {
      invalidateStatusCache();
      services.metrics.count('magnetbank.import.failed');
      const message = services.log.errorMessage(err);
      services.log.warn('[magnetbank] importação falhou:', message);
      // O gateway é quem mescla em lotes idempotentes: reimportar o mesmo arquivo
      // termina o serviço se a falha veio do lado do upload.
      return res.status(400).json({ ok: false, error: message, ms: Date.now() - started });
    } finally {
      busy = false;
      if (spool) fs.rm(spool, { force: true }, () => {});
    }
  });

  return { exportBank, importBank };
}
