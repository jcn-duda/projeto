// POST /internal/crawl-result — recebe o CrawlWorkResult do sidecar Rust e
// encaminha ao crawl-recorder. Rota SEM config (montada antes de /:userConfig
// no register.ts). Autenticação: X-Indexer-Test-Token no header (mesmo token
// do painel). Fail-open: erro no recorder responde 500 mas não derruba o
// sidecar — o Rust trata o 5xx como temporário e retenta (motor/types.rs:
// delivered=false → backoff até esgotar tries; 2xx é terminal).
// Página sem IMDb com releases segue a MESMA semântica do motor Node
// (crawl-page.ts): identifyWork no TMDB; 'unavailable' → 500 (retentável),
// 'unidentified'/'ambiguous' → 200 terminal (obra errada é pior que nenhuma).
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { recordCrawlReleases } from '../providers/crawl-recorder.js';
import type { CrawlObra, CrawlObraLocation, CrawlRecorder } from '../providers/crawl-recorder.js';
import { identifyWork } from '../providers/crawl-identify.js';
import type { IdentifyInput, IdentifyResult } from '../providers/crawl-identify.js';
import type { RawItem } from '../../types/domain.js';
import * as log from '../utils/logger.js';

/** Corpo que o sidecar Rust envia ao terminar UMA página (CrawlWorkResult). */
interface RustRelease {
  title: string;
  magnet: string | null;
  link: string | null;
  size: string | null;
  seeders: number | null;
  tracker: string | null;
  is_br: boolean;
}

interface RustGroup {
  season: number | null;
  episode: number | null;
  releases: RustRelease[];
}

interface CrawlWorkResultRust {
  url: string;
  url_key: string;
  site: string;
  status: 'done' | 'no-torrent' | 'no-work' | 'error' | 'simulated' | 'partial';
  imdb: string | null;
  title: string | null;
  year: number | null;
  kind: 'movie' | 'series';
  releases: RustRelease[];
  groups: RustGroup[];
  unlocated: RustRelease[];
  progress: string | null;
  request_cost: number;
  error: string;
}

/** Extrai o infoHash de um magnet ou hash cru (mesma lógica do rust-shadow). */
function extractHash(magnetOrHash: string | null): string | null {
  if (!magnetOrHash) return null;
  const raw = magnetOrHash.trim();
  if (/^[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  const m = raw.match(/btih:([a-fA-F0-9]{32,40})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Converte rótulo de tamanho ("1.5 GB", "700 MB") para bytes. */
function parseSizeBytes(text: string | null): number | undefined {
  if (!text) return undefined;
  const match = text.match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return undefined;
  const value = Number(match[1].replace(',', '.'));
  const mult: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  const unit = match[2].toUpperCase();
  return Number.isFinite(value) && mult[unit] ? Math.round(value * mult[unit]) : undefined;
}

/** Converte um release do Rust para o RawItem que o recorder espera. */
function toRawItem(site: string, r: RustRelease): RawItem {
  const infoHash = extractHash(r.magnet);
  const item: RawItem = {
    title: r.title,
    indexer: site,
    tracker: r.tracker ?? undefined,
    isBr: r.is_br,
    seeders: r.seeders ?? undefined,
    size: parseSizeBytes(r.size),
  };
  if (r.magnet) item.magnet = r.magnet;
  if (infoHash) item.infoHash = infoHash;
  return item;
}

/**
 * Colaboradores da rota — trocáveis em teste pela MESMA via do motor Node
 * (createPageProcessor): módulos ESM são namespaces congelados, então o teste
 * prova o fio pelos parâmetros de registro e a produção usa os reais.
 */
export interface InternalCrawlCollaborators {
  identify(input: IdentifyInput): Promise<IdentifyResult>;
  record: CrawlRecorder['record'];
}

/**
 * Registra a rota POST /internal/crawl-result no router fornecido.
 * O maestro (register.ts) monta esta rota ANTES do overlay /:userConfig.
 */
export function registerInternalCrawlResult(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalCrawlCollaborators> = {},
): void {
  const identify = overrides.identify ?? identifyWork;
  const record = overrides.record
    ?? ((...args: Parameters<CrawlRecorder['record']>) => recordCrawlReleases.record(...args));

  router.post('/internal/crawl-result',
    express.json({ limit: '512kb' }),
    asyncRoute(async (req, res) => {
      // 1. Valida token (mesmo gate do painel)
      if (!services.config.jackett.testToken) {
        return res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
      }
      if (!services.authorized(services.config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
        return res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
      }

      // 2. Parse do body como CrawlWorkResult
      const body = req.body as CrawlWorkResultRust;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ ok: false, error: 'body vazio ou inválido' });
      }
      if (!body.site || !body.url) {
        return res.status(400).json({ ok: false, error: 'site e url obrigatórios' });
      }

      // 3. Status error sem obra identificada: o sidecar reporta mas não há
      //    o que gravar — responde 200 (o Rust não retenta error).
      if (body.status === 'error' || body.status === 'no-work') {
        log.info(`[internal-crawl] ${body.site} ${body.url_key}: status=${body.status} (sem gravação)`);
        return res.json({ ok: true, kept: 0, added: 0, note: body.status });
      }

      // 4. Sem IMDb: espelha o motor Node (crawl-page.ts "done" sem IMDb
      //    ancorado → identifyWork). Página sem NENHUMA release a gravar não
      //    consulta o TMDB (no motor, no-torrent não gasta identificação) e
      //    mantém a nota de sempre.
      const hasReleasesToRecord =
        (body.groups || []).some((g) => (g.releases || []).length > 0) ||
        (body.releases || []).length > 0;
      let imdb = body.imdb;
      if (!imdb) {
        if (!hasReleasesToRecord) {
          log.info(`[internal-crawl] ${body.site} ${body.url_key}: sem IMDb e sem release (status=${body.status})`);
          return res.json({ ok: true, kept: 0, added: 0, note: 'no-imdb' });
        }
        // identifyWork é fail-open (nunca lança; rede → 'unavailable'), mas o
        // try/catch garante que um bug não derrube a rota: cai no 500, que o
        // sidecar reentrega com backoff.
        let identification: IdentifyResult;
        try {
          identification = await identify({
            type: body.kind === 'series' ? 'series' : 'movie',
            title: String(body.title || ''),
            year: body.year ?? null,
          });
        } catch (err) {
          log.error(`[internal-crawl] ${body.site} ${body.url_key}: identify lançou:`, err);
          return res.status(500).json({ ok: false, error: 'identify-indisponivel' });
        }
        if (identification.outcome === 'identified' && identification.imdb) {
          imdb = identification.imdb;
        } else if (identification.outcome === 'unavailable') {
          // TMDB fora/timeout é retentável, NÃO é veredicto (crawl-page.ts
          // "tmdb-indisponivel"): 500 → sidecar reentrega (from_work:
          // delivered=false → backoff; esgota tries, sem laço infinito).
          log.warn(`[internal-crawl] ${body.site} ${body.url_key}: identify indisponível (${identification.reason}); reentrega`);
          return res.status(500).json({ ok: false, error: `identify-indisponivel:${identification.reason}` });
        } else {
          // 'unidentified'/'ambiguous': veredicto terminal do TMDB — obra errada
          // é pior que nenhuma (crawl-page.ts marca no-work). 200 aqui: 500
          // viraria retentativa infinita de uma resposta definitiva.
          log.info(`[internal-crawl] ${body.site} ${body.url_key}: identify sem obra (${identification.reason})`);
          return res.json({ ok: true, kept: 0, added: 0, note: `no-work:${identification.reason}` });
        }
      }

      // 5. Converte para o formato do recorder.
      const obra: CrawlObra = {
        imdb,
        title: body.title ?? body.url_key,
        year: body.year,
        kind: body.kind === 'series' ? 'tv_show' : 'movie',
      };

      let totalKept = 0;
      let totalAdded = 0;

      try {
        // 6a. Grupos (séries): UMA chamada por grupo, com a locação declarada.
        if (body.groups && body.groups.length > 0) {
          for (const group of body.groups) {
            const releases = (group.releases || []).map((r) => toRawItem(body.site, r));
            if (!releases.length) continue;
            const location: CrawlObraLocation = {
              season: group.season ?? null,
              episode: group.episode ?? null,
            };
            const report = await record(body.site, obra, releases, location);
            totalKept += report.kept;
            totalAdded += report.added;
          }
        }

        // 6b. Releases avulsos (filme ou série sem grupos).
        const topLevel = (body.releases || []).map((r) => toRawItem(body.site, r));
        if (topLevel.length) {
          const report = await record(body.site, obra, topLevel, {});
          totalKept += report.kept;
          totalAdded += report.added;
        }

        log.info(`[internal-crawl] ${body.site} ${body.url_key}: kept=${totalKept} added=${totalAdded}`);
        return res.json({ ok: true, kept: totalKept, added: totalAdded });
      } catch (err) {
        // Fail-open: o sidecar recebe 500 e retenta; o log registra o erro.
        log.error(`[internal-crawl] falha ao gravar ${body.site} ${body.url_key}:`, err);
        return res.status(500).json({ ok: false, error: 'falha ao gravar releases' });
      }
    })
  );
}
