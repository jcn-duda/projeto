# Debrid: como cada serviço se comporta neste addon

Mapa dos cinco serviços suportados, do ponto de vista do que o addon realmente
precisa deles. Não é cópia da documentação oficial: é o que os adaptadores em
[`src/debrid/`](src/debrid/) fazem, mais as armadilhas que já custaram bug aqui.

Documentação oficial consultada: [Premiumize](https://www.premiumize.me/api),
[AllDebrid](https://docs.alldebrid.com/#general-informations),
[Real-Debrid](https://api.real-debrid.com/) e
[Debrid-Link](https://debrid-link.com/api_doc/v2/introduction) (esta última é
SPA: precisou de navegador para renderizar) e
[TorBox](https://api-docs.torbox.app/) — cujo conteúdo não sai por fetch nem
por `openapi.json`, e entrou aqui a partir do texto da documentação.

## O que o addon pede de um debrid

Três capacidades, em ordem de importância:

1. **Checagem de cache em lote.** A lista de streams sai com ⚡ (toca na hora)
   ou "download" (o serviço ainda vai baixar). Sem uma consulta em lote barata,
   o addon não sabe o que está pronto — e com `DEBRID_CACHED_ONLY=true` a lista
   inteira desaparece. É o divisor de águas entre os serviços.
2. **Resolução por arquivo no play.** O `/resolve` precisa da lista de arquivos
   do torrent para escolher a obra certa dentro de um pack multi-filme
   (ver `pickFile`/`pickWorkFile` em [`common.ts`](src/debrid/common.ts)).
3. **Enfileirar download sem esperar.** É o que sustenta o autofetch da fonte
   BR dublada: fonte rara nunca está pré-cacheada, então a primeira busca manda
   baixar e a segunda mostra com ⚡.

## Comparativo

| | Premiumize | TorBox | AllDebrid | Real-Debrid | Debrid-Link |
|---|---|---|---|---|---|
| `cacheCheck` em lote | ✅ real | ✅ real | ⚠️ via upload | ⚠️ dinâmico (ledger+oráculo) | ❌ |
| Custo da checagem | 1 POST, sem escrever na conta | 1 GET, sem escrever | **cria transferência** | ledger local + oráculo (rede) | — |
| Abortável no deadline | ✅ | ✅ | ❌ (`abortSafeCacheCheck: false`) | — | — |
| `enqueue` (autofetch BR) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auth | `apikey` na query | `Bearer` | `Bearer` + `agent` | `Bearer` | `Bearer` |
| Erro fora do HTTP | `status != success` | corpo `data` | **200 com `status:"error"`** | HTTP | HTTP + `success:false` |
| Detecta **parado** (`stalled`) | ⚠️ heurística | ✅ nativo | ❌ | ❌ | ❌ |
| Limite documentado | fair-use por tráfego (`limit_used`) | **300/min; `createtorrent` 60/HORA se não-cacheado** | **12 req/s, 600 req/min, 30 magnets ativos** | **250 req/min**, teto de torrents ativos | não publicado (mas há `/seedbox/limits`) |
| Endpoint de uso/limite | `/account/info` (`limit_used`) | mylist (contagem) | `/magnet/status` | `/torrents/activeCount` | `/seedbox/limits` (ainda não) |
| Escolhe o arquivo **antes** de baixar | ❌ | ❌ **por projeto** ("baixa todos, não vai mudar") | ❌ | ✅ `selectFiles` | ❌ |
| Veredito para este addon | **melhor encaixe** | alternativa boa | funciona, cobra caro | ⚡ via conta/histórico/sonda/ledger/oráculo | lista sem ⚡ |

---

## Premiumize

Adaptador: [`src/debrid/premiumize.ts`](src/debrid/premiumize.ts) — 68 linhas, o
mais simples dos cinco, e não é coincidência.

**Endpoints usados**

| chamada | uso aqui |
|---|---|
| `POST /api/cache/check` com `items[]` | checagem em lote; devolve `response[]` paralelo ao lote enviado |
| `POST /api/transfer/directdl` com `src` | no play: devolve `content[]` com `path`, `size`, `link` |
| `POST /api/transfer/create` com `src` | autofetch: dispara o download e sai |

**O que a documentação oficial acrescenta e o addon ainda não usa:** `Bearer`
no header (hoje mandamos `?apikey=`, que segue aceito como legacy).
`/api/transfer/list` — que a doc descreve com `status`/`progress` — **já é
usado** pelo `torrentStatus` do ciclo de recheck (`ready`/`downloading`/`dead`
+ `stalled` heurístico); só não serve ainda para mostrar "baixando 42%" ao
usuário. A doc marca `stream_link` como legacy; o `resolveLink` daqui usa
`file.stream_link || file.link`, nessa ordem — vale inverter quando sobrar
tempo (TV).

`/api/account/info` (`limit_used`) e os códigos HTTP 200 `rate_limit_reached`
(transitório, `known:false`) / `account_limit_reached` (quota, lista P2P) /
`authentication_failed` (auth) **já entram** no adaptador e no `/debrid-status.json`.

**O que eu acho:** é o encaixe certo para este addon. A checagem em lote é
barata, não escreve nada na conta e pode ser abortada no deadline; as outras
duas chamadas são POSTs diretos sem polling. O adaptador ser o menor de todos é
sintoma da simplicidade do contrato, **não da ausência de armadilha** — e há
duas coladas ao `torrentStatus`:

- **Casar a transferência a um hash exige cascata (`transferHash`).** O magnet
  chega como `src` e, quando vem completo, traz o `btih:40hex`; sem `btih`
  (magnet só com nome), o `name` cru de 40 hex entra, e por fim o campo direto
  `hash`/`info_hash`. Quem não casa com nenhum dos três volta `null` e é contado
  como órfã (`debrid.pm.status.unmatched`) — nunca inventa hash para limpar a
  conta por engano.
- **Não existe estado nativo de parada.** O `stalled` é **heurístico** (`running`
  + progresso 0/ausente + mensagem atascada "0 Bytes of 0 Bytes"/"from 0 peer"),
  e o recheck o conta com o limiar próprio `DEBRID_AUTO_FETCH_STALL_STREAK` em
  vez de o colapsar como um dead de 2 rechecks.

O ponto fraco real continua sendo fair-use por tráfego; o `/debrid-status.json`
agora avisa em `limit_used` ≥ 0.8.

## TorBox

Adaptador: [`src/debrid/torbox.ts`](src/debrid/torbox.ts). Base
`https://api.torbox.app`, versão `v1`, `Bearer` no header.

**Endpoints**: `GET /v1/api/torrents/checkcached` (aceita `hash` repetido,
`format=list`), `POST /torrents/createtorrent` (com `seed=3` para **não**
semear), `GET /torrents/requestdl` para o link.

A checagem em lote existe e é honesta, como a do Premiumize. A esquisitice é o
formato de resposta: `data` volta ora como **lista** de objetos com `hash`, ora
como **mapa** `hash → info` — o adaptador aceita os dois e normaliza para
minúsculas, porque hash em caixa alta já causou "0 em cache" com a conta cheia.

É também a única detecção de **parado nativa** dos cinco: a API marca
`download_state === "stalled"` para o torrent que não avança mas ainda não
errou. O `torrentStatus` traduz isso em `stalled:true` sem heurística, e o
recheck o conta com `DEBRID_AUTO_FETCH_STALL_STREAK` — não o colapsa como um
dead.

**O que a documentação fixa, e pesa aqui:**

- **Rate limit assimétrico**: 300/min por token no geral, mas
  `POST /torrents/createtorrent` cai para **60 por HORA quando o item não está
  em cache** (300/min se já estiver). Como o autofetch BR existe justamente
  para mandar baixar o que **não** está em cache, esse é o teto real do
  recurso aqui: 60 fontes dubladas novas por hora, por token.
- **Não existe seleção de arquivo**: a tabela de equivalência com o
  Real-Debrid diz, sobre o `selectFiles`, "não é necessário — torrents baixam
  todos os arquivos", e que isso não vai mudar. Ou seja, um pack de 22 GB é
  baixado inteiro para entregar um filme. É o oposto exato da vantagem do RD.
- **Teto por plano**: `DOWNLOAD_TOO_LARGE` dispara acima de 10 GB no Free e
  200 GB no Essential/Standard (500 GB no Pro) — o pack de coleção passa fácil
  do limite do plano gratuito. Há ainda `ACTIVE_LIMIT`, `MONTHLY_LIMIT` e
  `COOLDOWN_LIMIT` como códigos próprios.
- **Envelope**: `{success, error, detail, data}`, com `detail` sendo uma
  mensagem pronta para mostrar ao usuário. O adaptador inclui o `detail` no
  erro de play e classifica `ACTIVE_LIMIT`/`MONTHLY_LIMIT` como quota.
- Confirmado que `/torrents/checkcached` é o substituto oficial do
  `instantAvailability` do RD, e que a remoção é via
  `POST /torrents/controltorrent`.

**O que eu acho:** continua sendo a alternativa real ao Premiumize pela
checagem em lote, mas as duas descobertas acima mudam o tom: com pack
multi-obra ele é o pior dos cinco (baixa tudo, sempre) e o autofetch BR tem um
teto de 60/hora que nenhum outro serviço impõe. Para uso normal — filme
avulso, dublado ou não — segue ótimo.

### Stream API (v8.1, plano Pro) — a única coisa aqui que ataca um problema nosso

`GET /v1/api/stream/createstream` devolve um `hls_url` para o arquivo, com
transcodificação opcional e, principalmente, **seleção de faixa por índice**:
`chosen_audio_index`, `chosen_subtitle_index`, `chosen_resolution_index`. A
primeira chamada com índices nulos devolve o `metadata` com a lista de áudios
(`language`, `language_full`, `title`) e legendas disponíveis.

Por que isso importa exatamente neste addon: hoje a nossa escolha para por
**arquivo** (`pickFile`). Numa release **DUAL** — que é metade do catálogo BR —
o arquivo certo é escolhido, mas o play começa no áudio em inglês e o usuário
tem que trocar a faixa no controle da TV. Com `chosen_audio_index` dava para
entregar o stream **já na faixa PT**, que é a promessa do addon inteiro.
`chosen_resolution_index` resolveria o outro caso conhecido, o Fire TV Stick
antigo engasgando em HEVC 4K.

O preço: é específico da TorBox e restrito ao plano Pro, então viraria um
caminho de play paralelo só para um dos cinco serviços — e um `[TB]` que se
comporta diferente dos outros quatro. Vale como experimento, não como base.

## AllDebrid

Adaptador: [`src/debrid/alldebrid.ts`](src/debrid/alldebrid.ts) — 396 linhas,
quase seis vezes o Premiumize. O tamanho é a crítica.

**A questão central:** o `/magnet/instant` foi removido. A única forma de saber
se um torrent está em cache é **dar upload dele** e ler o campo `ready` da
resposta. Ou seja: *consultar* o cache **escreve na conta**. Daí toda a
maquinaria que não existe em nenhum outro adaptador:

- `dropUncached` remove da conta o que voltou não-cacheado, senão cada busca
  deixa um download fantasma rodando lá;
- [`protected.ts`](src/debrid/protected.ts) protege da limpeza justamente o
  hash que o autofetch acabou de mandar baixar — sem isso a busca seguinte
  apagaria o próprio download no meio;
- `warmInventory` fotografa os magnets que já existiam na conta antes do addon,
  porque o upload é idempotente e não diz se criou ou reaproveitou — sem essa
  referência a limpeza apagaria o filme que o usuário guardou de propósito;
- `sweepDead` remove os que nunca vão baixar; magnets PRONTOS sem áudio PT
  têm limpeza própria: a varredura automática `DEBRID_SWEEP_UNDUBBED*`
  (respeita o acervo via `knownBefore`, idade mínima e `held`) ou
  `scripts/clean-undubbed.ts` para limpeza manual com preview (`--apply`
  executa);
- `abortSafeCacheCheck: false`: como a chamada cria estado remoto, ela não pode
  ser simplesmente abortada no deadline — segue em background para limpar.

Mais duas armadilhas medidas: a API responde **HTTP 200 com
`{status:"error"}`** (o adaptador classifica `AUTH_*` e
`MAGNET_TOO_MANY_ACTIVE` como erros não-transitórios, para o addon degradar
para P2P em vez de prometer um play que não vem), e em rajada de deleção ela
devolve **503 com HTML** em parte dos ids — 13 de 45 numa medição.

**O que a documentação oficial explica desse comportamento:** o limite é de
**12 requisições por segundo e 600 por minuto**, e o excedente volta como
**429 ou 503**. Ou seja, aquele 503-com-HTML da rajada de deleção não é
instabilidade do serviço: é a nossa limpeza passando do teto. Uma pausa entre
deleções resolve melhor que retry.

Outros números que a doc fixa e valem estar aqui: **máximo de 30 magnets
ativos** por conta (é o gatilho exato do `MAGNET_TOO_MANY_ACTIVE`, o que torna
o `dropUncached` não uma otimização e sim requisito de funcionamento);
autenticação hoje é `Authorization: Bearer` **em header** — a forma antiga por
parâmetro GET foi removida, e o `agent` continua indo na query; `/v4.1` é a
versão corrente com a `/v4` depreciada; e `/magnet/instant` **não aparece mais
na documentação**, o que confirma que a leitura de cache via `ready` do upload
é o caminho oficial, não um contorno nosso.

**O que eu acho:** funciona bem hoje e é o serviço com mais código dedicado
aqui, mas o preço é estrutural: cada busca mexe na conta do usuário, dentro de
um teto de 30 magnets ativos e 12 req/s. Se o `/magnet/instant` voltasse,
metade desse arquivo desapareceria.

## Real-Debrid

Adaptador: [`src/debrid/realdebrid.ts`](src/debrid/realdebrid.ts), com uma
camada própria de paridade no `cacheCheck`: [`rd-ledger.ts`](src/debrid/rd-ledger.ts),
[`rd-oracle.ts`](src/debrid/rd-oracle.ts) e [`rd-gate.ts`](src/debrid/rd-gate.ts).

`/torrents/instantAvailability` foi aposentado (doc oficial atual: o método
**não existe**; quem chama leva erro `37 Disabled endpoint`). O `checkCached`
em si segue devolvendo `Set` vazio e `complete` apenas quando todo hash tem
evidência no ledger, mas o **`cacheCheck` agora é DINÂMICO**: o registry o
promete como `true` quando `config.debrid.rdLedger.enabled` **e**
`rdOracle.available()` (ao menos uma fonte externa ligada) — só então o addon
tem como conversar a confirmação do CDN. Sem as duas, continua honesto em
`false` (e `cachedOnly` não pode esconder a lista). Não volte para o `false`
fixo: o `current()` em `debrid/index.ts` traduz o flag por requisição num clone.

**Como o ⚡ existe** (camadas, da mais barata à mais cara):

| Fonte | Quando |
|---|---|
| Ledger global (`rdc:v2:<hash>`, **sem conta**) | Hit/miss/blocked confirmados por qualquer caminho (ver abaixo) |
| Inventário pronto da conta (`dinv` / `inventoryPeek`) | Hash já baixado em `/torrents` |
| Histórico de play (`magnetdb.isAlive`) | `/resolve` devolveu link de verdade |
| Oráculo Torrentio (`[RD+]` no `name`) | Busca: item listado com marcador = cacheado; listado sem = miss autoritativo; **não-listado ≠ miss** |
| Oráculo StremThru (`GET /v0/store/torz/check`) | Busca: item presente (`status: 'cached'`) = hit; presente sem cached = miss |
| Sonda em fundo (`DEBRID_RD_PROBE`, [`rd-probe.ts`](src/providers/rd-probe.ts)) | Após a lista: `addMagnet` → se vira `downloaded` na hora, marca hit no ledger e **apaga** o torrent da sonda |

**Ledger (`rd-ledger.ts`).** O CDN/cache do RD pertence ao SERVIÇO, não à conta
que observou o resultado — a chave `rdc:v2:<hash>` não leva `apiKey` nem
`accountScope`, então uma confirmação de uma instalação vale para todas. Estados
`hit`/`miss`/`blocked`; `blocked` vence hit (451 legal não pode ser apagado por
caminho atrasado). Miss usa **backoff exponencial** (`DEBRID_RD_LEDGER_MISS_BACKOFF_MS`,
30min→3d nos passos padrão) e, como falso negativo aqui é pior que falso
positivo, **nunca condena uma release**: serve só para a sonda não martelar e
para o filtro do `cachedOnly`. Sinais gratuitos que alimentam o ledger:
inventário, play/downloaded (`/resolve`), 451 (`noteBlocked`), `enqueue` pronto,
recheck pronto, `torrentStatus` e sonda RD. Convive com o `mag:alive` (que
continua por conta e registra um play que funcionou naquela credencial). O
oráculo consulta o ledger ANTES de ir à rede (dedupe); hash já resolvido não
paga chamada.

**Oráculo (`rd-oracle.ts`).** Despachante com `Promise.allSettled` + fail-open
(erro devolve `Map` vazio, nunca lança) sobre as fontes habilitadas em paralelo,
com **um deadline único** para a chamada toda (não soma por lote/fonte): cada
lote StremThru usa só o restante e não inicia lote depois do prazo; o Torrentio
usa o mesmo restante. Fusão **true-wins**: `true` de qualquer fonte vence;
`false` só conta de fonte que enumera com autoridade — StremThru (item presente
sem `cached`) e Torrentio (listado com hash do conjunto pedido, sem o marcador
`[RD+]` exato). Hash **não listado** pelo Torrentio — ou cuja URL pertence a um
hash que não pedimos — é **desconhecido**, nunca miss: o acervo BR dublado que
interessa é justamente o que o Torrentio não indexa, e tratar como miss
envenenaria o ledger. O segmento de config do Torrentio é **texto puro**
`realdebrid=<key>` (não base64url), e a extração de hash **só aceita hash do
conjunto pedido**: o token apiKey no path também é 40-hex, e o antigo "primeiro
40-hex" confundia a chave com o hash real. A chamada do Torrentio é cacheada por
título (`rdt:v1:trt:<type>:<id>`, TTL ~6h) para não virar uma chamada por busca
repetida contra infra de terceiro. **Ativado por padrão**: token/key explícitos
das fontes têm precedência; vazios, usam a apiKey efetiva da instalação (que vai
às fontes — terceiros a veem). `available()` exige fonte realmente utilizável
com credencial efetiva; sem uma, o RD honesto não promete `cacheCheck`.

**Governador de escrita (`rd-gate.ts`).** O RD tem teto de 250 req/min e
bruteforce = bloqueio por tempo indefinido; o gate serializa as escritas **por
conta** (concorrência 1) com filas por prioridade
`play > cleanup > autofetch > probe`. AIMD no intervalo entre admissões: 429
dobra o gap (limitado por `DEBRID_RD_GATE_MAX_GAP_MS`) e, com `Retry-After`,
entra em cooldown honorido; cinco sucessos consecutivos reduzem o gap em 10%.
Play fura gap/cooldown só depois de `playMaxWaitMs`, e nunca preempta job já em
voo; **`cleanup` (DELETE) fura o cooldown imediatamente** — liberar vaga na
conta não consome o recurso que o cooldown protege. `autofetch` e `probe`
respeitam o cooldown. A sonda delega cooldown ao gate; `settleProbeLot` espera o
término real com o gate ligado.

**Filtro ternário do `cachedOnly`.** Com `DEBRID_CACHED_ONLY` (`dc`) e ledger ativo,
o corte remove **só o miss confirmado** (`rdLedger.peek` = `miss`/`blocked`);
hash **desconhecido sobrevive** (ranqueado abaixo) em vez de a lista inteira
sumir. Sem ledger + oráculo, cai na regra antiga do inventário quente. No
`sortAndLimit`, `knownInstant()` (via ledger) entra ao lado de `magnetdb.isAlive`
e `inventoryReady` — o ⚡ real sobrevive às cotas de qualidade.

**cacheMaxAge real.** Quando o ledger cobriu o top-N da busca (`debridKnown:
true` na entrada do cache), `streamsNeedRevalidation` devolve `false` e a
resposta sai com `cacheMaxAge` completo (TTL de 900s) em vez dos 60s de "precisa
revalidar". O custo: a garantia passa a depender do oráculo ter marcado aquele
lote no momento da gravação — é a troca consciente de "re-perguntar a cada
reabertura" por "confiar no ledger até expirar".

O play funciona bem: `addMagnet` → `waiting_files_selection` → `selectFiles`
com o arquivo escolhido pelo `pickFile` → `unrestrict` — tudo dentro de um job
só admissado como `play` no gate. É o único que deixa o addon **escolher o
arquivo antes de baixar**, o que em pack multi-filme é a opção mais econômica
de todas — em vez de puxar os 22 GB da coleção para entregar um filme, ele
baixa só o arquivo pedido. O Ready-id memoizado (`readyTorrentId`) evita
re-addMagnet do que já está pronto, e o `451` de infringimento grava `blocked`
no ledger.

**Contratos oficiais usados:** base `https://api.real-debrid.com/rest/1.0/`,
`Bearer`, **250 req/min** (429 / erro `34`; bruteforce = bloqueio por tempo
indeterminado), `activeCount`, erros `21` (ativos), `33` (already active),
`35` (infringing), `37` (disabled endpoint).

## Debrid-Link

Adaptador: [`src/debrid/debridlink.ts`](src/debrid/debridlink.ts) — 77 linhas.
Documentação: <https://debrid-link.com/api_doc/v2/introduction> (SPA; foi
preciso renderizar no navegador para ler).

Base `https://debrid-link.com/api/v2`, envelope `{"success": true, "value": …}`
e, no erro, `{"success": false, "error": "badToken"}` — **com HTTP 400/500 de
verdade**, diferente da AllDebrid que devolve 200 em cima de erro. O adaptador
já lê o `value` e trata `success:false`.

O inventário de endpoints confirma o diagnóstico do código: existem
`/seedbox/list`, `/seedbox/activity`, `/seedbox/add`,
`DELETE /seedbox/:ids/remove`, `/seedbox/:id/config`, `/seedbox/:id/zip`,
`/files/:idParent/list` — e **nenhum endpoint de disponibilidade em cache**,
nem individual nem em lote. O `cacheCheck: false` não é omissão nossa, é o que
a API oferece. O play usa `/seedbox/add` com `async=true` e faz até 4 rodadas
de polling do `downloadPercent`.

Dois pontos que só a doc revela:

- **`GET /seedbox/limits`** devolve limites e uso da conta — o adaptador não
  usa. É a mesma família do `limit_used` do Premiumize e do
  `/torrents/activeCount` do Real-Debrid.
- Autenticação aceita chave privada **ou** OAuth2, e é o único dos cinco com
  **device code flow** documentado (`urn:ietf:params:oauth:grant-type:device_code`,
  com `user_code` de 8 caracteres e QR Code). Para um addon que roda em TV,
  isso é exatamente o fluxo certo — o usuário autoriza no celular em vez de
  digitar uma API key no controle remoto.

⚠️ A introdução diz textualmente que a API não serve para revender o serviço e
que a conta é de uso pessoal. Instância pública compartilhando uma chave de
operador (`DEBRID_ALLOW_ENV_KEY=true`) mora numa zona cinzenta aqui — vale ler
os termos antes de expor o addon com uma conta Debrid-Link.

**O que eu acho:** o menos exercitado dos cinco por aqui, e herda o mesmo
problema do Real-Debrid (lista sem ⚡). Mas tem a melhor história de
autenticação para TV, que é justamente o dispositivo onde este addon roda —
se um dia a checagem de cache aparecer, ele sobe várias posições.

---

## Ciclo de recheck: `torrentStatus` e `stalled`

O autofetch consulta o estado real de cada torrent via `adapter.torrentStatus()`,
que devolve `{ state: ready|downloading|dead|unknown, stalled?, id }`. A
diferença entre **morto** e **parado** decide o desfecho: dead colapsa em 2
rechecks consecutivos (blacklist + remoção + dreno da fila); um parado merece
o limiar próprio `DEBRID_AUTO_FETCH_STALL_STREAK` (default 3) porque a falta de
pares pode ser transitória. Movimento zera a contagem — só observações
consecutivas derrubam. O campo `stalled` só é afirmado onde há sinal objetivo:

| serviço | fonte do `stalled` | limite |
|---|---|---|
| Premiumize | heurística (`running` + progresso 0/ausente + mensagem "0 Bytes of 0 Bytes"/"from 0 peer") | `DEBRID_AUTO_FETCH_STALL_STREAK` |
| TorBox | **nativo** (`download_state === "stalled"`) | idem |
| AllDebrid / Real-Debrid / Debrid-Link | **nunca** — a API não expõe o sinal | sem `stalled`, só ready/downloading/dead |

`0` no `DEBRID_AUTO_FETCH_STALL_STREAK` desliga o stall: parado nunca derruba o
download.

## Season Pack Fill e `cacheCheck`

Quando um pack de temporada enfileirado por autofetch fica pronto, o addon
invalida as buscas da mesma temporada/conta e semeia disponibilidade
(`noteAvailable`) para o ⚡ voltar sem esperar o `CACHE_TTL`. **Isso só roda em
adaptador com `cacheCheck: true`** (Premiumize, TorBox, AllDebrid e o
Real-Debrid quando o ledger+oráculo o elevam para `true`): é o recheck do cache
que prova ready. Em Debrid-Link (`cacheCheck: false`) não existe essa prova,
então pack pronto **não** marca nem semeia nada e não gera promessa de ⚡ — a
constatação fica para o `resolveLink` do play. Se o kill-switch do ledger
(`DEBRID_RD_LEDGER=false`) ou do oráculo removerem a prova RD, o fill volta a
não valer lá — a promessa só existe onde a confirmação existe.

## Configuração ao vivo do autofetch (`/dashboard#autofetch`)

Os limites operacionais do autofetch (cota imediata, profundidade da fila, teto
horário de downloads, limiar de seeders, detecção de stall e pausa por ocupação)
podem ser ajustados ao vivo pelo operador na aba `[Chupim / Autofetch]` do
dashboard (`/dashboard#autofetch`), protegidos por `JACKETT_TEST_TOKEN`.

As alterações persistem no cache (`cfg:v1:autofetch`) sem restart. O botão de
pausa emergencial suspende o envio de novos downloads para a conta do debrid
mantendo os rechecks e a resolução de links ativos.

---

## Recomendação prática

Para o caso de uso deste addon — **BR dublado, que é raro e quase nunca está
pré-cacheado** — o que decide não é a velocidade do serviço, é o par
_checagem em lote + autofetch_:

1. **Premiumize** — melhor equilíbrio. Checagem barata, autofetch simples.
2. **TorBox** — equivalente em capacidade, um pouco mais de cerimônia no play.
3. **Real-Debrid** — subiu de posição com a paridade F1–F5: com o ledger global
   + oráculo ligados (`DEBRID_RD_ORACLE*`), o ⚡ aparece **na primeira abertura**,
   não mais só na reabertura via sonda. Mantém as duas vantagens estruturais —
   a única seleção de arquivo *antes* de baixar entre os cinco e o custo de
   checagem que não escreve na conta por mero diagnóstico (o oráculo consulta
   fontes externas; o ledger é local). Preço: depende do oráculo/ledger ativos e
   do governador `rd-gate` domar o teto apertado de 250 req/min.
4. **AllDebrid** — funciona, mas cada busca escreve na conta e depende da
   limpeza automática se comportar; ficou abaixo do RD justamente onde ele
   melhora sem custo estrutural.
5. **Debrid-Link** — o menos exercitado dos cinco; herda a lista sem ⚡ e fica
   de fora da paridade RD por não expor checagem nem oráculo.

## Configuração relevante

No `.env` (operador): `DEBRID_SERVICE`, `DEBRID_API_KEY`, `DEBRID_CACHED_ONLY`,
`DEBRID_SHOW_UNCACHED_BR`, `DEBRID_RESOLVE_UNCACHED`, `DEBRID_DROP_UNCACHED`,
`DEBRID_DROP_READY`, `DEBRID_BATCH_SIZE`, `DEBRID_CACHE_CHECK_TIMEOUT_MS`,
`DEBRID_AUTO_FETCH_QUEUE`, `DEBRID_AUTO_FETCH_QUEUE_DEPTH`,
`DEBRID_AUTO_FETCH_DEAD_TTL`, `DEBRID_AUTO_FETCH_STALL_STREAK`,
`DEBRID_AUTO_FETCH_SETTLE_MS`, `DEBRID_AUTO_FETCH_SETTLE_MAX_LOTS`,
`DEBRID_AUTO_FETCH_ENQUEUE_MAX_HOUR`, `DEBRID_AUTO_FETCH_SEASON_FILL`,
`DEBRID_AUTO_FETCH_SEASON_INDEX_MAX`, `DEBRID_PREFETCH_NEXT_EP`,
`DEBRID_PREFETCH_TTL`, `DEBRID_SWEEP_DEAD`, `DEBRID_ACCOUNT_WARN_TOTAL`,
`DEBRID_ACCOUNT_WARN_LIMIT_USED`.

**Paridade Real-Debrid (F1/F2/F5; F3 vem depois):**

- Governador de escrita (`DEBRID_RD_GATE*`): `DEBRID_RD_GATE` (default `true`;
  `false` restaura o fluxo pré-governador, inclusive gap/cooldown locais da
  sonda), `DEBRID_RD_GATE_MIN_GAP_MS` (1000), `DEBRID_RD_GATE_MAX_GAP_MS`
  (30000), `DEBRID_RD_GATE_COOLDOWN_MS` (90000),
  `DEBRID_RD_GATE_PLAY_MAX_WAIT_MS` (1500 — play fura gap/cooldown só depois
  deste teto).
- Ledger global (`DEBRID_RD_LEDGER*`): `DEBRID_RD_LEDGER` (default `true`),
  `DEBRID_RD_LEDGER_HIT_TTL` (2592000), `DEBRID_RD_LEDGER_BLOCKED_TTL`
  (2592000), `DEBRID_RD_LEDGER_MISS_BACKOFF_MS`
  (`1800000,7200000,43200000,259200000` — backoff exponencial do miss).
- Oráculo (`DEBRID_RD_ORACLE*`): `DEBRID_RD_ORACLE` (default **`true`** — o oráculo
  liga, e junto com o ledger eleva o `cacheCheck` do RD a **`true`**; mas isso
  **só** quando há fonte de fato: as fontes são **opt-in por padrão**).
  `DEBRID_RD_ORACLE_TIMEOUT_MS` (800 — prazo ÚNICO, compartilhado pelas fontes),
  `DEBRID_RD_ORACLE_MAX_HASHES` (100, teto 500), `DEBRID_RD_ORACLE_STREMTHRU_URL`
  (default do runtime **vazio** — sem endpoint, nada sai; o compose injeta
  `http://stremthru:8080`, a instância self-hosted da própria stack),
  `DEBRID_RD_ORACLE_STREMTHRU_TOKEN`,
  `DEBRID_RD_ORACLE_STREMTHRU_STORE` (`realdebrid`),
  `DEBRID_RD_ORACLE_TORRENTIO` (default **`false`** — o flag é o opt-in; com
  `true` e credencial efetiva a fonte é consultada e pode enviar a chave),
  `DEBRID_RD_ORACLE_TORRENTIO_URL`
  (`https://torrentio.strem.fun`, doc do alvo; sem o flag `true` ele não é
  usado), `DEBRID_RD_ORACLE_TORRENTIO_KEY` (vazio usa a
  chave efetiva da instalação), `DEBRID_RD_ORACLE_TORRENTIO_TTL` (21600 — cache
  da resposta por título).
- Sonda (`DEBRID_RD_PROBE*`): já vistos acima, agora com o cooldown delegado ao
  gate quando ele está ligado.
- **`DEBRID_RD_WARM*` (F3)** ainda **não existe** no código — reservado para a
  futura fase de aquecimento do oráculo/ledger. Não configure até chegar.

O `DEBRID_AUTO_FETCH_SEASON_FILL` (default `true`) só tem efeito em serviço com
`cacheCheck: true` — o ⚡ do Season Pack Fill é garantido pelo recheck do cache,
que DL não tem e o RD passa a ter quando o ledger+oráculo o elevam a `true`.

Na URL de instalação (por usuário, ver [`src/runtime.ts`](src/runtime.ts)):
`ds` serviço, `dk` chave, `dc` somente-cacheado, `bu` mostrar BR fora do cache,
`ab` autofetch BR.

Combinação que explica a maior parte das dúvidas de "sumiu o dublado":
`dc=1` + `bu=0` esconde toda fonte BR fora do cache. Com `ab=1` ela é enviada
para download assim que aparece — e só fica visível na busca seguinte, já com
⚡. Candidatos excedentes entram na fila persistente e downloads mortos são
substituídos automaticamente pelo próximo da fila. Com `prefetchNextEp=true`,
pesquisar um episódio já dispara o prefetch em background do próximo (`E+1`).
Ligar `bu=1` troca o silêncio inicial por uma entrada P2P visível enquanto o
download acontece.

## Nota de segurança

A chave do debrid viaja no segmento de config da URL de instalação. Sem
`RESOLVE_SECRET` definido ela vai em **texto puro** — o addon avisa isso no
boot. Com o segredo definido, o `/configure` sela a chave e o link deixa de
expor a credencial. Fora de HTTPS, a URL ainda aparece em log de proxy.
