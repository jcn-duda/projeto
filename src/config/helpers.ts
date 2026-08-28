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
