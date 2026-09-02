// Fonte única de verdade para a versão de cada namespace versionado do cache.
// Módulo puro, sem require: quem monta chave pode importá-lo sem arrastar o
// `cache.js` (que abre SQLite e agenda timer no require).
//
// Namespaces cuja chave é `<ns>:<versão>:<resto>`. Bumpar AQUI é o que invalida
// o formato antigo: o loadFromDisk apaga do disco tudo que não bate, em vez de
// deixar a versão morta ocupando cota até expirar. Antes a versão vivia em dois
// lugares e a do descarte ficou parada na v3 enquanto a chave já ia na v5.
// streams v6: a guarda de ano pelo dn= do magnet (remake ≠ clássico) muda o
// resultado do filtro — listas antigas com obra errada não podem sobreviver
// ao TTL. streams v7: o classificador de sinal BR foi corrigido (remoção do
// alternador genérico `www.…org -` que absolvia `www.UIndex.org -`) e a marca
// DUB/DUBBED genérica passou a depender da ausência de HINDI — as listas
// prontas carregam bolts/ranking gerados pelo matching antigo e não se
// corrigiriam só com o reboot. streams v8: fronteira no token `bthd`
// (`www.HDBTHD.com` deixou de ser sinal PT/marca BR) — listas prontas carregam
// `_br`/bolts pintados com o falso positivo e as vagas reservadas não se
// corrigem só com o reboot. streams v9: DUB/DUBBED GENÉRICO deixa de provar
// áudio PT quando o título tem script cirílico (`[DUB]` russo/ucraniano) —
// medido pelo /stream-trace.json ao vivo: 11 dos 50 títulos cirílicos do
// índice (826 únicos) estavam classificados Dublado/BR via [DUB] e disputavam
// vaga reservada anunciando pt-BR. As listas prontas carregam `_br`/`_dubbed`
// pintados pelo classificador antigo e não se corrigem só com o reboot.
// idx v2: as releases gravadas sem essa prova morrem no boot e são regravadas
// já filtradas.
const NAMESPACE_VERSIONS = Object.freeze({
  // v9: DUB/DUBBED genérico deixa de provar áudio PT com script cirílico no
  // título (guarda CYRILLIC_RE, mesma classe do conserto DUB/HINDI da v7).
  // O índice PERSISTE `dubbed`/`isBr` por release e o merge é OR-aderente —
  // sem o bump, release cirílica já indexada como Dublado (medido: 11 de 50
  // títulos cirílicos no índice ao vivo, achado do /stream-trace.json)
  // permaneceria errada até o TTL de semanas.
  // v10: ENGLISH|ENG entra na guarda do DUB/DUBBED genérico (Spirited Away
  // "English Dubbed" media rotulado DUB BR); o índice PERSISTE `dubbed` por
  // release e o merge é OR-aderente — sem o bump, o rótulo errado sobrevive
  // até o TTL de 30 dias do índice.
  streams: 'v10',
  autofetch: 'v3',
  raw: 'v1',
  dinv: 'v1',
  davail: 'v1',
  mag: 'v1',
  // Ledger durável do CDN do Real-Debrid (veredictos por hash). Não leva escopo
  // de conta: cache do RD é propriedade do serviço, não da credencial que o
  // mediu. v1 nasceu MISTURADO — a mesma chave `rdc:v1:<hash>` convivia com o
  // cache por título do Torrentio (`rdc:v1:trt:...`) e com a fila do warmer
  // (`rdc:v1:wq`) sob o MESMO prefixo. Em v2 o ledger fica só com hashes; o
  // cache por título migra para `rdt` e a fila para `rdq`. O bump descarrega,
  // numa ÚNICA passada idempotente do boot, os misses suspeitos históricos
  // (inflados pelo eco do oráculo) e os legados trt/wq embutidos — todos
  // reconstruíveis (Torrentio reconsultado, fila re-enfileirada sob demanda),
  // então não há perda funcional e não se apaga hit corrente em toda subida.
  rdc: 'v2',
  // Cache por título da resposta do Torrentio do oráculo (*rd-oracle*), chave
  // `rdt:v1:trt:<type>:<id>` com TTL ~6h por obra. Separado do ledger para o
  // veredicto por hash não competir com o histórico por título na mesma cota.
  rdt: 'v1',
  // Fila persistente do rdWarmer, chave `rdq:v1:wq` (uma única entrada que
  // carrega o array). Separado do ledger para o bump do rdc não arrastar um
  // estado vivo: a fila não é histórico reconstructivo — é trabalho pendente.
  rdq: 'v1',
  // v3: a gravação passou a ROTEAR a release pela temporada/episódio que o
  // título dela declara, em vez de assumir a chave da busca. O formato do
  // registro é o mesmo, mas metade do conteúdo da v2 estava sob chave errada
  // (medido: 328 de 659) — e re-rotear o legado custaria mais código que
  // deixar o índice se refazer, que é o que ele faz sozinho.
  // v4: qualityFromTitle/audioFromTitle aprenderam a cortar o blob de tags
  // que o hdrtorrent anexa ao fim do título ("… 720P 1080p, 2160p, 720p, HD,
  // WEB-DL") — releases gravadas como 2160p/Dual quando eram 720p/Legendado.
  // O rótulo errado vive semanas no TTL do índice; sem o bump, o conserto do
  // classificador não aparece para obra já indexada.
  // v5: marcas d'água de trackers BR ("derew", "www ThePiratefilmes")
  // deixavam releases legítimas abaixo da precisão mínima. O índice antigo
  // nunca reconsulta obra já coberta; descartar o legado permite colhê-las.
  // v6: o classificador de áudio aprendeu que MULTI sozinho é Dual (não
  // "sem marca") — releases já indexadas carregam `dubbed`/qualidade gravados
  // pelo classificador antigo e vivem semanas; sem o bump o conserto não
  // aparece em obra já indexada.
  // v7: `audioFromTitle`/`dubbed` persistido em fileEvidence/índice mudou com
  // a correção DUB/HINDI (generic DUB só valida áudio PT sem HINDI ao lado).
  // Sem o bump, obra já indexada continuaria gravada como dublada quando o
  // release é dublagem indiana.
  // v8: `brOriginMark`/`BR_MARK` ganharam fronteira no token `bthd`
  // (`www.HDBTHD.com` deixou de ser marca BR). O índice PERSISTE `isBr` por
  // release e o merge é OR-aderente (uma vez BR, sempre BR) — sem o bump, o
  // HDBTHD já indexado permaneceria BR até o TTL de semanas.
  // v9: guarda cirílica no DUB/DUBBED genérico (mesma classe do HINDI da
  // v7): release `[DUB]` em cirílico gravada como Dublado/BR — 11 dos 50
  // títulos cirílicos medidos no índice ao vivo — não se corrige em obra já
  // indexada sem o bump.
  // v10: ENGLISH|ENG na mesma guarda — release "English Dubbed" não pode
  // ficar gravada como `dubbed` no índice por até 30 dias.
  idx: 'v10',
  harvest: 'v1',
  notify: 'v1',
  seed: 'v1',
  cfg: 'v1',
  // Proteção durável dos BR no AllDebrid (`adprot:v1:<adapter>:<account>:<hash>`),
  // registro `{ acceptedAt, readyAt }`. Não leva apiKey — escopo é conta + adapter.
  adprot: 'v1',
  // Posse durável dos uploads do próprio addon no AllDebrid
  // (`adsub:v1:<account>:<hash>`, registro `{ at }`). Sobrevive ao restart:
  // é o que impede o snapshot seguinte de reclassificar o upload do addon como
  // acervo do usuário (a catraca que encheu a conta sem o autofetch).
  adsub: 'v1',
  // Anti-reenchimento do AllDebrid (`adrm:v1:<account>:<hash>`, registro
  // `{ at, name? }`, Fase 8 item 8.14): hash que a limpeza INTENCIONAL
  // (sweepUndubbed, catálogo/painel) apagou não volta a ser enviado ao
  // /magnet/upload — que é a própria checagem de cache. Sem escopo de adapter
  // de propósito: só o AllDebrid marca, e a leitura por outras contas/keys
  // simplesmente não encontra registro.
  adrm: 'v1',
});

// Prefixos de formatos aposentados, apagados uma vez no boot. `raw1:` e
// `dinv1:` eram a versão colada no nome (sem `<ns>:<versão>:`); ao migrar para
// `raw:v1:` / `dinv:v1:` os antigos virariam namespaces órfãos ocupando a cota
// padrão para sempre.
const LEGACY_PREFIXES = Object.freeze(['raw1:', 'dinv1:']);

const prefix = (ns: keyof typeof NAMESPACE_VERSIONS) => `${ns}:${NAMESPACE_VERSIONS[ns]}:`;

export { NAMESPACE_VERSIONS, LEGACY_PREFIXES, prefix };
