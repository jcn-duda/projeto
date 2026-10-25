// POST /internal/debrid/marked — a POSSE do que a checagem NATIVA da AllDebrid
// subiu, de volta ao Node, que é o dono único do `cache.db`.
//
// POR QUE ESTA ROTA EXISTE: no corte nativo quem sobe (`/magnet/upload` da
// checagem) é o Rust; a posse (`adsub:v1`) só pode ser gravada AQUI. Sem ela o
// snapshot seguinte classifica o magnet que a checagem subiu como
// "preexistente" do usuário (imune para sempre à limpeza).
//
// CONTRATO: corpo `{ service, apiKey, submitted: [hash...] }`, respondido com
// **202** `{ ok, service, submitted }` (contagem). `apiKey` é a única
// identidade que o Rust tem no ponto de gatilho (o `encoded` mora no
// `adom-search`); com ela a rota deriva o `accountScope` e grava a MESMA chave
// do caminho TS. A rota é loopback + `X-Indexer-Test-Token` e a chave NUNCA
// entra em log nem em mensagem de erro.
//
// NÃO há canal de remoção (`removed` → `adrm` saiu em 2026-10-24): a limpeza
// nativa é só a HIGIENE da checagem, que no TS nunca marcava `adrm`. Gravar a
// marca ali bloqueava por 3 dias todo candidato fora do cache, e o Chupim
// parava de baixar o dublado. O `adrm` é das varreduras de conteúdo do Node.
//
// Validação estrita: serviço único, chave presente, hash de 40 hex, teto de
// lote e 400 para corpo inválido. Corpo vazio não é "nada a fazer": é 400.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { accountScope } from '../utils/request-key.js';
import { id as alldebridId } from '../debrid/alldebrid-api.js';
import { rememberSubmittedProven } from '../debrid/alldebrid-inventory.js';
import * as metrics from '../utils/metrics.js';
import { rejectedByGuard } from './internal-search-shared.js';

/** Mesmo teto do lote da checagem nativa (500 hashes). */
const MAX_ITEMS = 500;
const HASH = /^[0-9a-f]{40}$/;
/** Teto da chave: `apiKey` de AllDebrid é curta; acima disso é corpo estranho. */
const MAX_KEY = 200;

/** Colaboradores trocáveis em teste (mesmo padrão das outras rotas internas). */
export interface InternalDebridMarkedCollaborators {
  /** Grava a posse (`adsub`) do hash que o checador nativo SUBIU. */
  markSubmitted: (account: string, hash: string) => void;
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

function readApiKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const apiKey = value.trim();
  if (!apiKey || apiKey.length > MAX_KEY) return '';
  return /[\s\u0000-\u001f]/.test(apiKey) ? '' : apiKey;
}

/** Escritores reais: as MESMAS funções e chaves do caminho TS. */
const defaultMarkers: InternalDebridMarkedCollaborators = {
  markSubmitted: rememberSubmittedProven,
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
  if (!submitted.length) {
    return res.status(400).json({ ok: false, error: 'nada para marcar' });
  }

  const account = accountScope(apiKey);
  for (const hash of submitted) deps.markSubmitted(account, hash);
  metrics.count('rust.debrid.marked.batch');
  metrics.count('rust.debrid.marked.submitted', submitted.length);
  // 202: as marcas foram ACEITAS e gravadas; não há trabalho pendente a
  // acompanhar (`cache.set` é síncrono).
  return res.status(202).json({ ok: true, service, submitted: submitted.length });
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
  };
  const json = express.json({ limit: '256kb' });
  router.post('/internal/debrid/marked', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleMarked(deps, req, res);
  }));
}
