import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Helpers de conversão compartilhados pelas seções: todo process.env vira
// número/lista com fallback explícito AQUI. Nada fora de src/config/ lê
// process.env (invariante A5).
export function num(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function list(value: unknown) {
  if (!value || !String(value).trim()) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Ids de indexer APOSENTADOS → substituto. O id de um indexer vive no .env de
// cada ambiente (local e VPS), e o volume do Jackett não expõe mais o antigo:
// sem normalizar aqui, cada deploy exigiria editar o .env na mão e o id morto
// reapareceria no catálogo como OFFLINE permanente. Mapa só de RENAME — um id
// que o operador escreve por decisão própria (ex.: religar o hdrtorrent) nunca
// entra aqui, porque sumir com a escolha dele em silêncio seria pior.
export const RETIRED_INDEXERS: Readonly<Record<string, string>> = Object.freeze({
  // O indexer C# stock foi aposentado; o card local é o `-cardigann` que o
  // entrypoint registra no volume (scripts/entrypoint.sh).
  apachetorrent: 'apachetorrent-cardigann',
});

/**
 * `list()` para listas de INDEXER: aplica os renames aposentados e deduplica.
 * O dedup é o ponto fino — um .env que já cita o id novo E o velho produziria
 * a mesma entrada duas vezes, e o addon consultaria o indexer em dobro.
 */
export function indexerList(value: unknown) {
  const out: string[] = [];
  for (const id of list(value)) {
    const mapped = Object.prototype.hasOwnProperty.call(RETIRED_INDEXERS, id)
      ? RETIRED_INDEXERS[id]
      : id;
    if (!mapped || out.includes(mapped)) continue;
    out.push(mapped);
  }
  return out;
}

// Default único do bludv. O resolvedor embutido e o scraper direto leem a
// MESMA BLUDV_URL; com dois defaults diferentes, quem não define a env fazia
// os dois buscarem em sites distintos. Trocar de domínio se faz aqui.
export const BLUDV_DEFAULT_URL = 'https://bludvfilmes.xyz';

// Este arquivo roda em dist/src/config (um nível ABAIXO do antigo config.ts
// único, que ficava em dist/src): subir TRÊS níveis preserva data/cache.db no
// build, que é o único runtime (npm start roda dist/). Sem o nível extra, o
// default apontaria para dist/data/ e o aquecimento L2 morreria a cada restart.
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(CONFIG_DIR, '..', '..', '..');
export const DEFAULT_CACHE_DB_PATH = path.join(REPO_ROOT, 'data', 'cache.db');
export const DEFAULT_CATALOG_DB_PATH = path.join(REPO_ROOT, 'data', 'catalog.db');
// Banco de magnets VIVO: clone permanente de tudo que o Jackett devolveu.
// SQLite PRÓPRIO pelo mesmo motivo do catálogo — o cache do addon tem cota,
// TTL e bump de namespace, e qualquer um dos três apagaria o acervo.
export const DEFAULT_MAGNET_BANK_DB_PATH = path.join(REPO_ROOT, 'data', 'magnets.db');
