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
// ALIAS MÓVEL do modelo: `jev-latest` é alias do provedor e pode apontar para
// um modelo diferente ao longo do tempo sem ação daqui. Só é aceitável como
// default porque o runtime é shadow — para auditoria, o model usado viaja no
// valor do cache (`m`) e na chave (o fingerprint inclui o model), então uma
// troca silenciosa do alias não mistura julgamentos de modelos diferentes.

// Clamp local: as seções usam os helpers de `helpers.js`, mas aqui quase todo
// knob tem faixa própria (teto de timeout é CONTRATO: <= 3000 ms), então o
// clamp com min/max explícito evita espalhar Math.min/Math.max por linha.
function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const int = (n: number) => Math.trunc(n);

export const typesafe = () => ({
  enabled: String(process.env.TYPESAFE_RUNTIME_ENABLED || 'false') === 'true',
  // ETAPA C — overlay GATEADO do Jev no termo fraco `genericDubProvesPt` de
  // `explicitPtAudio`. DEFAULT LIGADO (decisão do operador, 2026-09-22): com
  // cache vazio o overlay é no-op honesto — todo lookup é miss e miss preserva
  // `true`, então ligar por padrão não muda nada até o runtime shadow (§15)
  // povoar o `tsj`. `TYPESAFE_OVERLAY_ENABLED=false` é o KILL-SWITCH (rollback
  // imediato e baseline determinística; o idx já grava com {overlay:false}).
  // O uso é cache-only, monotônico e portado pelos travas de docs/
  // TYPESAFE_SYSTEM_ONE.md §16: PT explícito imune, só o generic DUB isolado
  // pode derrubar true->false com negativa CONFIANTE (noul <= 0.15); NUNCA
  // fetch, enqueue, escrita ou espera.
  overlayEnabled: String(process.env.TYPESAFE_OVERLAY_ENABLED || 'true') === 'true',
  apiKey: String(process.env.TYPESAFE_API_KEY || '').trim(),
  endpoint:
    String(process.env.TYPESAFE_ENDPOINT || '').trim() ||
    'https://api.typesafe.ai/v1/systemone',
  model: String(process.env.TYPESAFE_MODEL || '').trim() || 'jev-latest',
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
  // Orçamento de custo: chamadas por hora e por DIA (janelas independentes).
  hourlyCap: int(clamp(process.env.TYPESAFE_HOURLY_CAP, 1, 1000, 120)),
  dailyCap: int(clamp(process.env.TYPESAFE_DAILY_CAP, 1, 10000, 600)),
  // Base do backoff após falhas (auth para 30 min independente desta base).
  cooldownMs: int(clamp(process.env.TYPESAFE_COOLDOWN_MS, 1000, 60 * 60 * 1000, 60000)),
  // TTL do julgamento CRU no cache `tsj` (namespace versionado, cota própria).
  judgmentTtlS: int(clamp(process.env.TYPESAFE_JUDGMENT_TTL_S, 60, 30 * 86400, 14 * 86400)),
});
