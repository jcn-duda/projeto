import { list, num } from './helpers.js';

// Fábricas (não objetos prontos): módulo ESM é cacheado, e cada re-avaliação
// do compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Evidência de magnets e auditoria de áudio; webhooks operacionais.
export const magnetDb = () => ({
  enabled: String(process.env.MAGNET_DB || 'true') === 'true',
  aliveTtl: num(process.env.MAGNET_ALIVE_TTL, 7 * 24 * 3600),
  badTtl: num(process.env.MAGNET_BAD_TTL, 24 * 3600),
  // "Lie" não é bad: há vídeo, mas os paths provaram release EN apesar da
  // promessa de áudio PT no post. É evidência própria, por conta.
  lieEnabled: String(process.env.MAGNET_LIE || 'true') === 'true',
  lieTtl: num(process.env.MAGNET_LIE_TTL, 7 * 24 * 3600),
});

// Listas calibráveis sem deploy. Ausência de PT nunca condena sozinha: o
// veredito ainda exige um marcador forte de release EN.
export const audioAudit = () => ({
  enabled: String(process.env.AUDIO_AUDIT || 'true') === 'true',
  ptMarkers: list(
    process.env.AUDIO_AUDIT_PT_MARKERS ||
      // `dual` sozinho entrou depois de `dual audio`: o padrão dominante do
      // WEB-DL dublado BR é "…AMZN.WEB-DL.DUAL.5.1…" (DUAL sem "audio"), e
      // sem o marcador o audit de mentira olhava o AMZN — que é PLATAFORMA,
      // não prova de idioma — e condenava o dublado como release EN, chamando
      // unprotect no acervo retido. Medido: Coringa.2019.1080p.AMZN.WEB-DL.
      // DUAL.5.1.x264.mkv virava lie.
      'dublado,dublada,dublagem,dubbed,dual audio,dual,pt br,ptbr,portugues,portuguese,nacional,fleg',
  ),
  enGroups: list(
    process.env.AUDIO_AUDIT_EN_GROUPS ||
      // amzn/dsnp/smi saíram: são plataformas de streaming (Amazon, Disney+,
      // Showtime), presentes em release dublada e legenda igualmente — só
      // grupo de CENA prova idioma do conteúdo.
      'rarbg,killers,ettv,afm72,tovar,evo,megusta,galaxyrg,glxrc,yts,fgt,ntb,roarb,oxy,bae,drs,huzzah',
  ),
});

// Webhooks operacionais: alerta de credenciais recusadas, indexers BR offline
// e aviso proativo de quota de magnets.
export const notify = () => ({
  enabled: String(process.env.NOTIFY_ENABLED || 'true') !== 'false',
  webhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
  cooldownS: num(process.env.NOTIFY_COOLDOWN_S, 3600),
  magnetsWarn: num(process.env.NOTIFY_MAGNETS_WARN, 900),
});
