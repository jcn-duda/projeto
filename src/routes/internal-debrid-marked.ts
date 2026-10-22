// POST /internal/debrid/marked — as marcas da limpeza NATIVA da AllDebrid de
// volta ao Node, que é o dono único do `cache.db`.
//
// POR QUE ESTA ROTA EXISTE: no corte nativo quem sobe (`/magnet/upload` da
// checagem) e quem apaga (fila de `dropReady`/`dropUncached`) é o Rust; a posse
// (`adsub:v1`) e o anti-reenchimento (`adrm:v1`) só podem ser gravados AQUI.
// Sem esta ponte a limpeza nativa apaga e a busca seguinte re-sobe o mesmo hash:
// o magnet vira "preexistente" (imune para sempre) e a limpeza vira esteira.
//
// CONTRATO: corpo `{ service, apiKey, submitted: [hash...],
// removed: [{ hash, name? }...] }`, respondido com **202** `{ ok, service,
// submitted, removed }` (contagens). `apiKey` é a única identidade que o Rust
// tem nos dois pontos de gatilho (o `encoded` mora no `adom-search`); com ela a
// rota deriva o `accountScope` e grava as MESMAS chaves do caminho TS. A rota é
// loopback + `X-Indexer-Test-Token` e a chave NUNCA entra em log nem em
// mensagem de erro.
//
// O QUE É GRAVADO:
//   - `submitted` → `adsub` (posse com prova de criação: o hash não estava no
//     `knownBefore` do lote — o Rust só manda o que provou);
//   - `removed` → `forgetSubmitted` + `adrm` (só o que o `DeleteReport`
//     confirmou removido; o `name` alimenta a blindagem BR do 8.4).
//
// Validação estrita: serviço único, chave presente, hash de 40 hex, teto de
// lote e 400 para corpo inválido. Corpo vazio não é "nada a fazer": é 400.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { accountScope } from '../utils/request-key.js';
import { id as alldebridId } from '../debrid/alldebrid-api.js';
import { rememberSubmittedProven, forgetSubmitted } from '../debrid/alldebrid-inventory.js';
import { markReuploadBlocked } from '../debrid/alldebrid-reupload.js';
import * as metrics from '../utils/metrics.js';
import { rejectedByGuard } from './internal-search-shared.js';

/** Mesmo teto do lote da checagem nativa (500 hashes). */
const MAX_ITEMS = 500;
const HASH = /^[0-9a-f]{40}$/;
/** Teto da chave: `apiKey` de AllDebrid é curta; acima disso é corpo estranho. */
const MAX_KEY = 200;

interface RemovedMark {
  hash: string;
  name?: string;
}

/** Colaboradores trocáveis em teste (mesmo padrão das outras rotas internas). */
export interface InternalDebridMarkedCollaborators {
  /** Grava a posse (`adsub`) do hash que o checador nativo SUBIU. */
  markSubmitted: (account: string, hash: string) => void;
  /** Grava o `adrm` do hash que a limpeza nativa REMOVEU de verdade. */
  markRemoved: (account: string, hash: string, name: string | undefined, apiKey: string) => void;
}

/** Hash canônico (minúsculo) ou `null` quando não é 40 hex. */
function readHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hash = value.trim().toLowerCase();
  return HASH.test(hash) ? hash : null;
}

/** Lista de hashes sem duplicata, na ordem do corpo; `null` = inválida. */
function readSubmitted(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const out: string[] = [];
  for (const item of value) {
    const hash = readHash(item);
    if (!hash) return null;
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

/** Lista de `{ hash, name? }` sem duplicata; `null` = inválida. */
function readRemoved(value: unknown): RemovedMark[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const out: RemovedMark[] = [];
  for (const item of value) {
    const hash = readHash((item as { hash?: unknown } | null)?.hash);
    if (!hash) return null;
    if (out.some((mark) => mark.hash === hash)) continue;
    const raw = (item as { name?: unknown }).name;
    if (raw !== undefined && typeof raw !== 'string') return null;
    // Mesmo truncamento do `markReuploadBlocked`: o nome é diagnóstico e
    // alimenta a blindagem BR, não um payload livre.
    const name = String(raw ?? '').trim().slice(0, 160);
    out.push(name ? { hash, name } : { hash });
  }
  return out;
}

function readApiKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const apiKey = value.trim();
  if (!apiKey || apiKey.length > MAX_KEY) return '';
  return /[\s\u0000-\u001f]/.test(apiKey) ? '' : apiKey;
}

/** Escritores reais: as MESMAS funções e chaves do caminho TS. */
const defaultMarkers: InternalDebridMarkedCollaborators = {
  markSubmitted: rememberSubmittedProven,
  markRemoved: (account, hash, name, apiKey) => {
    // Mesma ordem do caminho TS (`alldebrid-check.ts:189-192`): o magnet saiu
    // da conta por limpeza NOSSA, então purga a posse e só então grava o
    // `adrm`. Falha de delete não chega aqui — o Rust manda só o confirmado.
    forgetSubmitted(account, hash);
    markReuploadBlocked(account, hash, name, apiKey);
  },
};

function handleMarked(
  deps: InternalDebridMarkedCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'corpo ausente' });
  }
  const service = typeof body.service === 'string' ? body.service.trim() : '';
  if (service !== alldebridId) {
    return res.status(400).json({ ok: false, error: `marked só existe para ${alldebridId}` });
  }
  const apiKey = readApiKey(body.apiKey);
  if (!apiKey) return res.status(400).json({ ok: false, error: 'apiKey ausente ou inválida' });
  const submitted = readSubmitted(body.submitted);
  if (!submitted) {
    return res.status(400).json({ ok: false, error: `submitted deve ser array de até ${MAX_ITEMS} hashes de 40 hex` });
  }
  const removed = readRemoved(body.removed);
  if (!removed) {
    return res.status(400).json({ ok: false, error: `removed deve ser array de até ${MAX_ITEMS} itens { hash, name? }` });
  }
  if (!submitted.length && !removed.length) {
    return res.status(400).json({ ok: false, error: 'nada para marcar' });
  }

  const account = accountScope(apiKey);
  for (const hash of submitted) deps.markSubmitted(account, hash);
  for (const mark of removed) deps.markRemoved(account, mark.hash, mark.name, apiKey);
  metrics.count('rust.debrid.marked.batch');
  metrics.count('rust.debrid.marked.submitted', submitted.length);
  metrics.count('rust.debrid.marked.removed', removed.length);
  // 202: as marcas foram ACEITAS e gravadas; não há trabalho pendente a
  // acompanhar (`cache.set` é síncrono).
  return res.status(202).json({ ok: true, service, submitted: submitted.length, removed: removed.length });
}

/**
 * Registra POST /internal/debrid/marked com a mesma guarda das demais
 * `/internal/*` (loopback + token) e antes do overlay `/:userConfig`.
 */
export function registerInternalDebridMarked(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalDebridMarkedCollaborators> = {},
): void {
  const deps: InternalDebridMarkedCollaborators = {
    markSubmitted: overrides.markSubmitted ?? defaultMarkers.markSubmitted,
    markRemoved: overrides.markRemoved ?? defaultMarkers.markRemoved,
  };
  const json = express.json({ limit: '256kb' });
  router.post('/internal/debrid/marked', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleMarked(deps, req, res);
  }));
}
