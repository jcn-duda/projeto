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
   (ver `pickFile`/`pickWorkFile` em [`common.js`](src/debrid/common.js)).
3. **Enfileirar download sem esperar.** É o que sustenta o autofetch da fonte
   BR dublada: fonte rara nunca está pré-cacheada, então a primeira busca manda
   baixar e a segunda mostra com ⚡.

## Comparativo

| | Premiumize | TorBox | AllDebrid | Real-Debrid | Debrid-Link |
|---|---|---|---|---|---|
| `cacheCheck` em lote | ✅ real | ✅ real | ⚠️ via upload | ❌ | ❌ |
| Custo da checagem | 1 POST, sem escrever na conta | 1 GET, sem escrever | **cria transferência** | — | — |
| Abortável no deadline | ✅ | ✅ | ❌ (`abortSafeCacheCheck: false`) | — | — |
| `enqueue` (autofetch BR) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auth | `apikey` na query | `Bearer` | `Bearer` + `agent` | `Bearer` | `Bearer` |
| Erro fora do HTTP | `status != success` | corpo `data` | **200 com `status:"error"`** | HTTP | HTTP + `success:false` |
| Limite documentado | fair-use por tráfego (`limit_used`) | **300/min; `createtorrent` 60/HORA se não-cacheado** | **12 req/s, 600 req/min, 30 magnets ativos** | **250 req/min**, teto de torrents ativos | não publicado (mas há `/seedbox/limits`) |
| Endpoint de uso/limite que **não** usamos | `/account/info` | — | — | `/torrents/activeCount` | `/seedbox/limits` |
| Escolhe o arquivo **antes** de baixar | ❌ | ❌ **por projeto** ("baixa todos, não vai mudar") | ❌ | ✅ `selectFiles` | ❌ |
| Veredito para este addon | **melhor encaixe** | alternativa boa | funciona, cobra caro | lista sem ⚡ | lista sem ⚡ |

---

## Premiumize

Adaptador: [`src/debrid/premiumize.js`](src/debrid/premiumize.js) — 68 linhas, o
mais simples dos cinco, e não é coincidência.

**Endpoints usados**

| chamada | uso aqui |
|---|---|
| `POST /api/cache/check` com `items[]` | checagem em lote; devolve `response[]` paralelo ao lote enviado |
| `POST /api/transfer/directdl` com `src` | no play: devolve `content[]` com `path`, `size`, `link` |
| `POST /api/transfer/create` com `src` | autofetch: dispara o download e sai |

**O que a documentação oficial acrescenta e o addon ainda não usa:** `Bearer`
no header (hoje mandamos `?apikey=`, que segue aceito como legacy),
`/api/account/info` com `limit_used` em `[0,1]` (daria um aviso de fair-use
antes de o usuário bater no teto), `/api/transfer/list` com `status`/`progress`
(daria para mostrar "baixando 42%" em vez do silêncio atual do autofetch), e o
código `rate_limit_reached` — que chega com **HTTP 200**, então tratar só o
status HTTP não vê rate limit. A doc marca `stream_link` como legacy; o
`resolveLink` daqui usa `file.stream_link || file.link`, nessa ordem — vale
inverter quando sobrar tempo.

**O que eu acho:** é o encaixe certo para este addon. A checagem em lote é
barata, não escreve nada na conta e pode ser abortada no deadline; as outras
duas chamadas são POSTs diretos sem polling. O adaptador ser o menor de todos é
o sintoma: não há armadilha a contornar. O ponto fraco é fair-use por tráfego
(`limit_used`), que hoje passa despercebido até a conta travar.

## TorBox

Adaptador: [`src/debrid/torbox.js`](src/debrid/torbox.js). Base
`https://api.torbox.app`, versão `v1`, `Bearer` no header.

**Endpoints**: `GET /v1/api/torrents/checkcached` (aceita `hash` repetido,
`format=list`), `POST /torrents/createtorrent` (com `seed=3` para **não**
semear), `GET /torrents/requestdl` para o link.

A checagem em lote existe e é honesta, como a do Premiumize. A esquisitice é o
formato de resposta: `data` volta ora como **lista** de objetos com `hash`, ora
como **mapa** `hash → info` — o adaptador aceita os dois e normaliza para
minúsculas, porque hash em caixa alta já causou "0 em cache" com a conta cheia.

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
  mensagem pronta para mostrar ao usuário. O adaptador lê só `data` e descarta
  o `detail` — é a explicação de graça que hoje jogamos fora quando o play
  falha.
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

Adaptador: [`src/debrid/alldebrid.js`](src/debrid/alldebrid.js) — 396 linhas,
quase seis vezes o Premiumize. O tamanho é a crítica.

**A questão central:** o `/magnet/instant` foi removido. A única forma de saber
se um torrent está em cache é **dar upload dele** e ler o campo `ready` da
resposta. Ou seja: *consultar* o cache **escreve na conta**. Daí toda a
maquinaria que não existe em nenhum outro adaptador:

- `dropUncached` remove da conta o que voltou não-cacheado, senão cada busca
  deixa um download fantasma rodando lá;
- [`protected.js`](src/debrid/protected.js) protege da limpeza justamente o
  hash que o autofetch acabou de mandar baixar — sem isso a busca seguinte
  apagaria o próprio download no meio;
- `warmInventory` fotografa os magnets que já existiam na conta antes do addon,
  porque o upload é idempotente e não diz se criou ou reaproveitou — sem essa
  referência a limpeza apagaria o filme que o usuário guardou de propósito;
- `sweepDead` remove os que nunca vão baixar;
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

Adaptador: [`src/debrid/realdebrid.js`](src/debrid/realdebrid.js).

`/torrents/instantAvailability` foi aposentado e **não há substituto**:
`checkCached` devolve `Set` vazio e `cacheCheck: false`. Consequência direta na
tela: nada aparece com ⚡, tudo vira "download", e com `DEBRID_CACHED_ONLY=true`
o resultado seria uma lista vazia — por isso o orquestrador ignora o filtro
"somente em cache" quando o adaptador declara `cacheCheck: false`.

O play funciona bem: `addMagnet` → `waiting_files_selection` → `selectFiles`
com o arquivo escolhido pelo `pickFile` → `unrestrict`. É o único que deixa o
addon **escolher o arquivo antes de baixar**, o que em pack multi-filme é a
opção mais econômica de todas — em vez de puxar os 22 GB da coleção para
entregar um filme, ele baixa só o arquivo pedido.

**O que a documentação oficial acrescenta:** base `https://api.real-debrid.com/rest/1.0/`,
`Bearer` no header (o adaptador já usa), **250 requisições por minuto** com 429
no excedente — e o aviso de que força bruta bloqueia a conta por tempo
indeterminado. Existe teto de torrents ativos, consultável em
`/torrents/activeCount`, que o adaptador ainda não lê. E o
`/torrents/instantAvailability` **não aparece mais** na documentação, o que
confirma a aposentadoria que o código já assume.

**O que eu acho:** ótimo serviço, encaixe ruim aqui. Sem checagem em lote o
addon perde a informação que organiza a lista inteira. Use se você já paga por
ele e aceita que tudo apareça como "download" — e note a ironia: é justamente
o RD que tem o melhor play para pack multi-filme, por escolher o arquivo antes
de baixar.

## Debrid-Link

Adaptador: [`src/debrid/debridlink.js`](src/debrid/debridlink.js) — 77 linhas.
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

## Recomendação prática

Para o caso de uso deste addon — **BR dublado, que é raro e quase nunca está
pré-cacheado** — o que decide não é a velocidade do serviço, é o par
_checagem em lote + autofetch_:

1. **Premiumize** — melhor equilíbrio. Checagem barata, autofetch simples.
2. **TorBox** — equivalente em capacidade, um pouco mais de cerimônia no play.
3. **AllDebrid** — funciona, mas cada busca escreve na conta e depende da
   limpeza automática se comportar.
4. **Real-Debrid / Debrid-Link** — só se você já paga; conviva com a lista sem ⚡.

## Configuração relevante

No `.env` (operador): `DEBRID_SERVICE`, `DEBRID_API_KEY`, `DEBRID_CACHED_ONLY`,
`DEBRID_SHOW_UNCACHED_BR`, `DEBRID_RESOLVE_UNCACHED`, `DEBRID_DROP_UNCACHED`,
`DEBRID_BATCH_SIZE`, `DEBRID_CACHE_CHECK_TIMEOUT_MS`.

Na URL de instalação (por usuário, ver [`src/runtime.js`](src/runtime.js)):
`ds` serviço, `dk` chave, `dc` somente-cacheado, `bu` mostrar BR fora do cache,
`ab` autofetch BR.

Combinação que explica a maior parte das dúvidas de "sumiu o dublado":
`dc=1` + `bu=0` esconde toda fonte BR fora do cache. Com `ab=1` ela é enviada
para download assim que aparece — e só fica visível na busca seguinte, já com
⚡. Ligar `bu=1` troca esse silêncio por uma entrada P2P visível enquanto o
download acontece.

## Nota de segurança

A chave do debrid viaja no segmento de config da URL de instalação. Sem
`RESOLVE_SECRET` definido ela vai em **texto puro** — o addon avisa isso no
boot. Com o segredo definido, o `/configure` sela a chave e o link deixa de
expor a credencial. Fora de HTTPS, a URL ainda aparece em log de proxy.
