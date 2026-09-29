// Rotas de EXPORTAR/IMPORTAR o banco de magnets vivo (aba Magnets do painel).
// O formato e a mesclagem moram em `utils/magnet-bank-transfer.ts`; aqui fica
// só o transporte HTTP.
//
// Fora do `/dashboard-action.json` de propósito: aquele é JSON com teto de 4 KB
// e a transferência é um ARQUIVO de dezenas de MB, em fluxo nos dois sentidos.
// Mesmo token (`X-Indexer-Test-Token`, nunca `?token=`), mas SEM o gate de
// diagnóstico: ele admite uma operação por vez, e segurá-lo durante minutos de
// export deixaria o poll do próprio painel em 429. A trava daqui é outra —
// uma transferência por processo.
import zlib from 'node:zlib';
import readline from 'node:readline';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { asyncRoute } from './async.js';
import { unavailable } from './stream-trace.js';
import type { AppServices } from './types.js';
import { flushBarrier, invalidateStatusCache, readEngine } from '../utils/magnet-bank.js';
import { exportLines, importLines } from '../utils/magnet-bank-transfer.js';

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
    const engine = readEngine();
    if (!engine) return res.status(409).json({ ok: false, error: 'banco de magnets desligado (MAGNET_BANK=false)' });
    if (busy) return res.status(409).json({ ok: false, error: 'outra exportação/importação em andamento' });
    busy = true;
    const started = Date.now();
    try {
      // A fila grava por cima do mesmo acervo: drenar ANTES deixa o merge do
      // import ler o estado mais novo em vez de competir com um lote pendente.
      flushBarrier();
      // `Content-Type: application/gzip` é o export do painel; NDJSON cru
      // (`application/x-ndjson`) também entra, para quem montou o arquivo à mão.
      const gz = /gzip/i.test(String(req.get('Content-Type') || ''));
      const body = new PassThrough();
      let streamErr: unknown = null;
      const cap = byteCap(services.config.magnetBank.importMaxBytes);
      const piping = (gz ? pipeline(req, zlib.createGunzip(), cap, body) : pipeline(req, cap, body))
        .catch((err: unknown) => { streamErr = err; body.end(); });
      const lines = readline.createInterface({ input: body, crlfDelay: Infinity });
      const report = await importLines(engine, lines);
      await piping;
      if (streamErr) throw streamErr;
      invalidateStatusCache();
      services.metrics.count(report.ok ? 'magnetbank.import' : 'magnetbank.import.refused');
      services.log.info(`[magnetbank] importação ${report.ok ? 'concluída' : 'recusada'}: `
        + `${report.magnets.inserted} novo(s), ${report.magnets.merged} mesclado(s), ${report.rejected} rejeitado(s)`);
      return res.status(report.ok ? 200 : 400).json({ ...report, ms: Date.now() - started });
    } catch (err: unknown) {
      invalidateStatusCache();
      services.metrics.count('magnetbank.import.failed');
      const message = services.log.errorMessage(err);
      services.log.warn('[magnetbank] importação falhou:', message);
      // Lotes já gravados ficam: cada lote é uma transação completa e a mescla é
      // idempotente, então reimportar o mesmo arquivo termina o serviço.
      return res.status(400).json({ ok: false, error: message, ms: Date.now() - started });
    } finally {
      busy = false;
    }
  });

  return { exportBank, importBank };
}

