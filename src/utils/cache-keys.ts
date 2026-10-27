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
  // v11: o `title` entregue ao cliente deixa de carregar o blob de qualidades
  // do HDRTorrent. Listas v10 mantinham a cauda e clientes que classificam o
  // título por conta própria exibiam 4K em botões 1080p/720p.
  // v12: série/pack fora do intervalo/TS-PreDVD saem da lista de filme.
  // Listas v11 carregavam a série da Netflix no filme Resident Evil (2026),
  // pack 2002-2016 fora do intervalo e gravações de cinema (TELESYNC/PreDVD)
  // que o excludeCam=true do usuário não cortava.
  // v13: DUB genérico sob formato rutracker transliterado
  // (`[AAAA, País, …, Fonte] Dub` / AVO|MVO|DVO|SVO) deixa de provar áudio
  // PT — caso Coyote Ugly (tt0200550, 2026-09-21): 4 vagas BR com russo
  // espelhado pelo kickasstorrents.to. Sem o bump, a lista cacheada
  // continuaria servindo o rótulo DUB BR errado até o TTL.
  // v14: `_dubClaim` (promessa de título) ≠ `_dubbed` (prova de arquivo).
  // Listas v13 pintavam chip/prioridade/Chupim com a promessa e, sob d:1,
  // ou esvaziavam a 1ª abertura ou tratavam mentiroso como DUB confiável.
  // v15: bump do overlay Jev (removido); mantido só na história da versão.
  // v16: a guarda do rutracker passou a aceitar FAIXA de anos
  // (`[1999-2003, País, …] Dub`), que a v13 deixava escapar — medido no corpus
  // do container (2026-09-22): `The Matrix: Trilogy [1999-2003, …] Dub` vinha
  // como `DUB BR · kickass` e ocupava vaga reservada. As listas prontas
  // carregam `_br`/`_dubbed` pintados pelo classificador antigo e não se
  // corrigiriam só com o reboot.
  // v17: `seleZen` (grupo russo, `…DUB.NF.WEB-DLRip…seleZen`) na mesma guarda:
  // o DUB genérico dele é dublagem russa. 11 releases viravam BR (The Whisper
  // Man, 2026-09-24).
  // v18: `LAT.DUB` (dublagem latina) deixa de provar PT, e agregador BR que
  // republica nome de cena EN (`…[YTS.MX]`, `…-NTb[TGx]`) perde a vaga BR.
  // v19: `tgx`/`ethel` na lista de grupos EN — o espelho `…-ETHEL[TGx]` de
  // site BR perde a vaga BR (idx intacto: o corte é na montagem da lista).
  // v20: `yify` na mesma lista — "Coyote Ugly 2000 1080p BluRay x264 YIFY"
  // republicado pelo Rede Torrent saía como BR.
  // v21: `[Azerbaijan|Mongolian|Uzbek… Dubbed]` deixa de provar PT (The Boys
  // S04 da TPB saía como BR, 2026-09-30).
  streams: 'v21',
  autofetch: 'v3',
  raw: 'v1',
  dinv: 'v1',
  davail: 'v1',
  mag: 'v1',
  // Metadados agregados do banco de magnets (contagens por adapter persistidas O(1))
  mag_meta: 'v1',
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
  // `mediaSource` (CAM/WEB-DL/…) é campo OPCIONAL na mesma v10: ausente =
  // desconhecido (rótulo pelo título até a próxima gravação). Bumpar por
  // mediaSource sozinho descartaria ~30d de colheita só por rótulo cosmético
  // — custo medido, não feito.
  // v11: a guarda do rutracker passou a aceitar FAIXA de anos
  // (`[1999-2003, País, …] Dub`) — a mesma classe da v13 (single year) e do
  // Coyote Ugly. O índice PERSISTE `dubbed`/`isBr` por release e o merge é
  // OR-aderente: sem o bump, `The Matrix: Trilogy [1999-2003, …]` (medido no
  // corpus do container, 2026-09-22) permaneceria Dublado/BR até o TTL de
  // semanas. Bump real (não cosmético) — ao contrário do mediaSource da v10.
  // v12: `seleZen` na guarda do rutracker (ver streams v17) — o índice
  // persiste o `isBr`/`dubbed` pintado pelo DUB russo.
  // v13: `LAT.DUB` fora do DUB genérico — mesmo motivo.
  // v14: idiomas da Ásia Central/Mongólia/Soviet na guarda do "Dubbed"
  // (ver streams v21) — mesmo motivo.
  idx: 'v14',
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
  // Arquivos de vídeo por hash (`fsz:v1:<hash>`, lista `{ path, size }`): o
  // tamanho do episódio num pack e do filme numa coleção. Persistido para o
  // restart não zerar a lista (ver `debrid/file-sizes.ts`).
  fsz: 'v1',
  // Tamanho TOTAL do torrent por hash (`tsz:v1:<hash>`, bytes), da checagem
  // de cache do Premiumize. Separado do `fsz` de propósito: não é lista de
  // arquivos, e o `pickFile` leria o pack inteiro como se fosse o episódio.
  tsz: 'v1',
  // Resolução medida no cabeçalho do vídeo, por arquivo
  // (`vres:v1:<hash>:<digest do caminho>`, registro `{ q, w, h }`).
  vres: 'v1',
});

// Prefixos de formatos aposentados, apagados uma vez no boot. `raw1:` e
// `dinv1:` eram a versão colada no nome (sem `<ns>:<versão>:`); ao migrar para
// `raw:v1:` / `dinv:v1:` os antigos virariam namespaces órfãos ocupando a cota
// padrão para sempre. `muri:` é a aposentadoria da URI por hash no cache: o
// dono do dado passou a ser o banco permanente (`utils/magnet-bank.ts`), e o
// prefixo legado é descartado no boot por aqui — sair de `NAMESPACE_VERSIONS`
// sozinho NÃO limpa o que já está no disco. `tsj:` é o julgamento do Jev
// (runtime TypeSafe removido): sem o descarte, as entradas órfãs ocupariam o
// balde `__default` até o TTL.
const LEGACY_PREFIXES = Object.freeze(['raw1:', 'dinv1:', 'muri:', 'tsj:']);

const prefix = (ns: keyof typeof NAMESPACE_VERSIONS) => `${ns}:${NAMESPACE_VERSIONS[ns]}:`;

// Dono ÚNICO por namespace, declarado pelo DONO DE EXECUÇÃO (quem tem o timer
// ou a rota que grava):
//   `idx`     — IdxStore do gateway, no MESMO cache.db;
//   `streams` — `data/streams.db` do gateway (F4.4a), o SWR do corte;
//   `raw`     — RawCacheStore do gateway (F3, dono único): o escritor TS do
//               Jackett saiu e o leitor do diagnóstico lê pela ponte napi
//               (`raw-store-native.ts`), como o idx;
//   `davail`  — DavailStore do `adom-index` (T2-L5b), no mesmo cache.db; o ⚡ do
//               debrid sai de `debrid-state-native.ts`, não do L1;
//   `mag`     — MagnetStateStore do `adom-index` (T2-L5b): banco de magnets,
//               histórico e a enumeração do painel são da ponte;
//   `adrm`    — KV durável do anti-reenchimento (T2-L7): o gateway lê a marca
//               no mesmo `cache.db` para tirar o hash do `/magnet/upload`.
// O Node não lê nem grava esses namespaces no L1/L2 — segundo escritor deixa o
// disco incoerente com o handle nativo (rollback é commit/imagem anterior). A
// superfície do Node é só a ponte (`streams-store-native.ts` /
// `raw-store-native.ts` / `debrid-state-native.ts` / `native-kv.ts`): a leitura
// do L1 nasce vazia e cai nela; escrita, invalidação e poda de vencidos vão por
// ela. `davail`, `mag`, `adsub`, `adprot` e `adrm` entram TAMBÉM em
// `RUST_OWNED_PREFIXES` (logo abaixo) porque é o prefixo, e não o nome do
// namespace, que bloqueia `get`/`peek` no L1.
const RUST_OWNED = Object.freeze(['idx', 'streams', 'raw', 'davail', 'mag', 'adsub', 'adprot', 'adrm']);

// Dono por PREFIXO dentro de namespace compartilhado:
//
// `harvest:v1` entra aqui pelo namespace INTEIRO (Fase 5): a fila
// (`harvest:v1:q`), o balde horário e o dedupe de 12h são escritos pelo colhedor
// do gateway. O Node não pode carregar essas linhas no L1 (`loadFromDisk`) nem
// regravá-las no SQLite: o L1 nasceria com uma fila velha e o flush sobrescreveria
// o trabalho do Rust. O namespace continua em `NAMESPACE_VERSIONS` porque quem
// monta a chave precisa da versão — o dono é que mudou.
//
// `davail:v1` e `mag:v1` (T2-L5b) entram pelo prefixo pelo mesmo motivo do
// `harvest`, mais um: `cache.get`/`peek` só consultam ESTA lista (`isRustOwned`
// vale para escrita/forget/persist), então sem o prefixo a leitura do L1
// devolveria sempre vazio em vez de cair na ponte.
//
// `adsub:v1` e `adprot:v1` (T2-L6) têm o mesmo desenho: a posse e a retenção BR
// sobrevivem ao restart no MESMO `cache.db`, e o `adom-debrid` já as lê por
// lá; deixar o Node escrever no L1 criava segundo escritor para um estado que
// decide o que a limpeza da conta pode apagar.
//
// `adrm:v1` (T2-L7) é o mesmo caso com um agravante: o gateway lê a marca por
// `DurablePeek` no `cache.db` no INSTANTE da checagem, e o `cache.set` do Node
// só despeja no SQLite no próximo `setImmediate`. Escrever pela ponte (`kvSet`,
// síncrono) fecha a janela em que a marca recém-gravada ainda não barrava o
// `/magnet/upload`.
//
// A fila (`q:`), o marker (`m:`) e a blacklist (`dead:`) do Chupim são do
// `NativeKv` (mesma tabela `cache` do `cache.db`): o Node não os lê nem grava
// no L1, e o prefixo é o que impede o L1 velho de responder no `get`/`peek`.
// `pf:` (prefetch) e `sup:` seguem do Node e NÃO entram aqui: marcar o
// namespace inteiro faria `cache.set`/`get` deles virarem no-op silencioso.
const AUTOFETCH_NATIVE_PREFIXES = Object.freeze([
  `${prefix('autofetch')}q:`, `${prefix('autofetch')}m:`, `${prefix('autofetch')}dead:`,
]);

const RUST_OWNED_PREFIXES = Object.freeze([
  prefix('harvest'), prefix('davail'), prefix('mag'), prefix('adsub'), prefix('adprot'), prefix('adrm'),
  ...AUTOFETCH_NATIVE_PREFIXES,
]);

const isRustOwned = (namespace: string) => RUST_OWNED.includes(String(namespace || ''));

const isForeignKey = (key: string) => {
  const wanted = String(key || '');
  return RUST_OWNED_PREFIXES.some((owned) => wanted.startsWith(owned));
};

const magMetaCountsKey = () => `${prefix('mag_meta')}counts`;

export {
  NAMESPACE_VERSIONS, LEGACY_PREFIXES, RUST_OWNED, RUST_OWNED_PREFIXES, AUTOFETCH_NATIVE_PREFIXES,
  isRustOwned, isForeignKey, prefix, magMetaCountsKey,
};
