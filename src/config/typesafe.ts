// TypeSafe / System One (Jev) — runtime SHADOW-ONLY. O que esta seção define
// são knobs de OPERADOR (nunca do schema da URL de instalação): o julgamento
// de título é shadow — classifica em fila assíncrona, compara com o veredito
// determinístico e só produz MÉTRICA. Nenhuma decisão de busca, ranking, BR,
// lie, índice, banco, limpeza ou autofetch lê nada daqui (docs/
// TYPESAFE_SYSTEM_ONE.md). Default OFF: sem `TYPESAFE_RUNTIME_ENABLED=true`
// (ou sem chave) o runtime é inerte por construção — zero fetch, zero leitura
// e zero escrita no cache `tsj`.
//
// `TYPESAFE_API_KEY` é a MESMA env dos probes (scripts/jev-*.mjs): uma chave,
// dois usos. Ela viaja SÓ no header `Authorization: Bearer` e nunca é
// cacheada, logada ou exportada por status/métrica.
//
// MODELO VERSIONADO: o default é `jev-1.13.0`, ID fixo registrado em
// docs/JEV_REFERENCIA.md. Alias móvel (`jev-latest`, `jev-preview`) ainda é
// ACEITO pela fila shadow (o eco do serviço viaja no cache para auditoria),
// mas NUNCA decide: o overlay só lê julgamento cujo fingerprint foi montado
// com ID versionado (`jev-x.y.z` — `isVersionedModel` abaixo). O default
// anterior `jev-latest` foi aposentado: troca silenciosa de alias não pode
// derrubar dublado por julgamento de modelo não identificado.

// Clamp local: as seções usam os helpers de `helpers.js`, mas aqui quase todo
// knob tem faixa própria (teto de timeout é CONTRATO: <= 3000 ms), então o
// clamp com min/max explícito evita espalhar Math.min/Math.max por linha.
function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const int = (n: number) => Math.trunc(n);

// ID versionado do Jev (`jev-x.y.z`, regex estrito). Alias móvel
// (`jev-latest`/`jev-preview`) NUNCA autoriza decisão do overlay: só modelo
// com versão conhecida e registrada tem julgamento cacheado lido como
// influência sobre a listagem (fail closed — src/ai/index.ts consulta aqui).
const VERSIONED_MODEL_RE = /^jev-\d+\.\d+\.\d+$/;
function isVersionedModel(model: string): boolean {
  return VERSIONED_MODEL_RE.test(String(model || '').trim());
}

export const typesafe = () => ({
  enabled: String(process.env.TYPESAFE_RUNTIME_ENABLED || 'false') === 'true',
  // ETAPA C — overlay GATEADO do Jev no termo fraco `genericDubProvesPt` de
  // `explicitPtAudio`. DEFAULT DESLIGADO (2026-09-23): o portão formal de
  // confiança (>= 200 julgamentos + revisão humana, docs/
  // TYPESAFE_SYSTEM_ONE.md §16) NÃO foi cumprido, então a fábrica nasce no
  // estado determinístico e LIGAR é opt-in explícito do operador. Com ligado,
  // a decisão ainda exige runtime shadow ON, chave presente, Jev não pausado e
  // modelo versionado — os portões fecham ANTES de qualquer leitura, e o
  // julgamento em cache só decide com o eco do modelo igual ao ID da config
  // (fail closed). `TYPESAFE_OVERLAY_ENABLED=true` liga; `false` (default) é
  // rollback imediato e baseline determinística (o idx, o catálogo e a
  // evidência de arquivo já gravam com {overlay:false}). O uso é cache-only,
  // monotônico e portado pelas travas de docs/TYPESAFE_SYSTEM_ONE.md §16: PT
  // explícito imune, só o generic DUB isolado pode derrubar true->false com
  // negativa CONFIANTE (noul <= 0.15); NUNCA fetch, enqueue, escrita ou espera.
  overlayEnabled: String(process.env.TYPESAFE_OVERLAY_ENABLED || 'false') === 'true',
  apiKey: String(process.env.TYPESAFE_API_KEY || '').trim(),
  endpoint:
    String(process.env.TYPESAFE_ENDPOINT || '').trim() ||
    'https://api.typesafe.ai/v1/systemone',
  // ID versionado (docs/JEV_REFERENCIA.md). Alias móvel serve à fila shadow,
  // mas o overlay se recusa a decidir com ele (isVersionedModel).
  model: String(process.env.TYPESAFE_MODEL || '').trim() || 'jev-1.13.0',
  // Threshold aplicado SÓ na comparação shadow (nunca decide nada). 0.55 é o
  // valor validado online (26/30; margem estreita — não baixar sem revisão
  // humana do corpus contraditório, ver docs/TYPESAFE_SYSTEM_ONE.md).
  threshold: clamp(process.env.TYPESAFE_THRESHOLD, 0, 1, 0.55),
  // Teto de 3000 ms é contrato do slice: a chamada roda fora do prazo de
  // resposta, mas teto é teto — nada de timeout de probe (30s) em runtime.
  timeoutMs: int(clamp(process.env.TYPESAFE_TIMEOUT_MS, 500, 3000, 3000)),
  // Fila com teto DURO: excedente descarta (o título re-enfileira na próxima
  // busca, o cache `tsj` evita re-chamada) — não existe fila infinita.
  queueMax: int(clamp(process.env.TYPESAFE_QUEUE_MAX, 1, 1024, 64)),
  concurrency: int(clamp(process.env.TYPESAFE_CONCURRENCY, 1, 4, 2)),
  // Orçamento de custo ÚNICO das DUAS perguntas, por processo (zera no
  // restart): mesma chave e mesmo limite do provedor, então o teto protege o
  // VOLUME enviado ao terceiro, não dinheiro. Janelas independentes entre si
  // (hora e dia).
  hourlyCap: int(clamp(process.env.TYPESAFE_HOURLY_CAP, 1, 1000, 1000)),
  dailyCap: int(clamp(process.env.TYPESAFE_DAILY_CAP, 1, 10000, 10000)),
  // Base do backoff após falhas (auth para 30 min independente desta base).
  cooldownMs: int(clamp(process.env.TYPESAFE_COOLDOWN_MS, 1000, 60 * 60 * 1000, 60000)),
  // TTL do julgamento CRU no cache `tsj` (namespace versionado, cota própria).
  judgmentTtlS: int(clamp(process.env.TYPESAFE_JUDGMENT_TTL_S, 60, 30 * 86400, 14 * 86400)),
});

export { isVersionedModel };
