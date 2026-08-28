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
// ao TTL. idx v2: as releases gravadas sem essa prova morrem no boot e são
// regravadas já filtradas.
const NAMESPACE_VERSIONS = Object.freeze({
  streams: 'v6',
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
  idx: 'v6',
  harvest: 'v1',
  notify: 'v1',
  seed: 'v1',
  cfg: 'v1',
  // Proteção durável dos BR no AllDebrid (`adprot:v1:<adapter>:<account>:<hash>`),
  // registro `{ acceptedAt, readyAt }`. Não leva apiKey — escopo é conta + adapter.
  adprot: 'v1',
});

// Prefixos de formatos aposentados, apagados uma vez no boot. `raw1:` e
// `dinv1:` eram a versão colada no nome (sem `<ns>:<versão>:`); ao migrar para
// `raw:v1:` / `dinv:v1:` os antigos virariam namespaces órfãos ocupando a cota
// padrão para sempre.
const LEGACY_PREFIXES = Object.freeze(['raw1:', 'dinv1:']);

const prefix = (ns: keyof typeof NAMESPACE_VERSIONS) => `${ns}:${NAMESPACE_VERSIONS[ns]}:`;

export { NAMESPACE_VERSIONS, LEGACY_PREFIXES, prefix };
