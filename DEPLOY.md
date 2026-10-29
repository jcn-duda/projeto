# Deploy em VPS — powermovie.net

Stack em container único: addon + Jackett + FlareSolverr + Caddy.
A instalação em casa continua funcionando igual; o que muda na VPS são três
valores no `.env` e o DNS.

## 1. DNS, antes de tudo

O Caddy pede certificado no primeiro boot. Se o DNS ainda não resolver, o
desafio ACME falha e a stack sobe sem HTTPS.

```
A   powermovie.net       ->  <IP da VPS>
A   www.powermovie.net   ->  <IP da VPS>
```

Confirme antes de seguir:

```bash
dig +short powermovie.net
```

## 2. Portas no firewall

Só 80 e 443 precisam entrar. **7000, 9117 e 8191 não** — o Jackett e o
FlareSolverr já estão presos ao loopback pelo compose, e a 7000 fica presa pelo
`BIND_ADDR` do passo 3.

```bash
sudo ufw allow 80,443/tcp && sudo ufw enable
```

## 3. `.env`

O `.env` é gitignored: ele não vem no clone, você cria no servidor.

```bash
cp .env.example .env
```

Os quatro que **têm** que mudar em relação ao exemplo:

| chave | valor na VPS | o que quebra se errar |
|---|---|---|
| `ADDON_DOMAIN` | `powermovie.net, www.powermovie.net` | fica `localhost` e o Caddy serve certificado interno — ninguém de fora entra |
| `PUBLIC_URL` | `https://powermovie.net` | o play. Todo link resolvido no debrid sai daqui; apontando pra IP de LAN, nada toca fora de casa |
| `BIND_ADDR` | `127.0.0.1` | a porta 7000 responde por fora do Caddy, e a URL de instalação leva a chave do debrid em texto puro |
| `RESOLVE_SECRET` | `openssl rand -hex 32` | sem ele a assinatura usa a própria chave do debrid, e a chave viaja em texto puro (base64url) dentro do install URL |

O `Caddyfile` **não** se edita: ele lê `{$ADDON_DOMAIN}`. O default `localhost`
existe justamente para a máquina de casa não sair pedindo certificado de um
domínio cujo DNS aponta para a VPS.

Mais as suas credenciais: `JACKETT_API_KEY`, `DEBRID_API_KEY`, `TMDB_API_KEY`.

```bash
openssl rand -hex 32   # RESOLVE_SECRET
```

Com `RESOLVE_SECRET` preenchido, a chave de debrid vai **cifrada** (AES-256-GCM)
no install URL, e só esta instância abre. O `/configure` faz a troca sozinho ao
montar o link. Dois efeitos que valem saber antes:

- **ligar** é seguro — install URL antigo, com a chave em texto puro, continua
  sendo aceito;
- **trocar o valor depois** invalida os links já cifrados. Quem tinha o addon
  instalado precisa gerar outro em `/configure`.

O selo protege a credencial, não o acesso: quem tem o link continua usando o seu
debrid **através desta instância**. `/configure` e `/defaults.json` são públicos
(passo 6). Instalações sem `dk` não herdam a chave do `.env` se
`DEBRID_ALLOW_ENV_KEY=false`.

## 4. Subir

```bash
docker compose up -d --build
```

Se você trouxe o volume `docker-data/jackett` de uma stack multi-container
antiga, o `ServerConfig.json` ainda aponta o FlareSolverr pelo hostname que
deixou de existir. Corrija uma vez, antes de subir:

```bash
sed -i 's#http://flaresolverr:8191#http://127.0.0.1:8191#' docker-data/jackett/Jackett/ServerConfig.json
```

## 5. Validar

O Jackett leva ~30 s pra carregar os 621 indexadores. Buscar antes disso volta
lista vazia — e o vazio fica 60 s no cache. Espere a stack ficar `healthy`:

```bash
docker compose ps
```

Depois, a suíte de fumaça contra o domínio real:

```bash
npm run smoke https://powermovie.net
```

Ela repete a chamada até a resposta vir cacheável, igual ao cliente Stremio faz,
e cobra fonte BR em cada título. Busca fria estabiliza em 2–4 chamadas.

### Diagnóstico rápido (token = `JACKETT_TEST_TOKEN`)

| Sintoma | Onde olhar |
|---|---|
| ⚡ sumiu de todos os streams | `curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" https://powermovie.net/debrid-status.json` — conta cheia ou chave recusada |
| BR dublado não aparece | card do indexer em `/configure` (breaker) e `cache.hit.raw` / `search.pt-sweep.hit` em `/metrics.json` |
| Lista vazia na primeira abertura | normal na busca fria; reabra. Sem `PUBLIC_URL` o aviso usa `127.0.0.1` |
| Lento / timeout | `search.response` p95 vs `search.late` e `search.deadline` em `/metrics.json` |
| Cache “não pega” | `cache.hit.streams` e `cache.hit.raw` no mesmo JSON |

```bash
curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" https://powermovie.net/metrics.json
```

## 6. `/configure` é público

`/configure` e `/defaults.json` são públicos. Eles **não** vazam a chave do
debrid — o `/defaults.json` a zera, e há teste no smoke cobrindo isso — mas
expõem a lista de indexadores e deixam qualquer um gerar install URL nesta
instância. A chave do `.env` **não** é herdada por instalação anônima se
`DEBRID_ALLOW_ENV_KEY=false`.

O diálogo HTTP (`basic_auth` do Caddy) foi retirado de propósito: uma env
`CONFIGURE_PAGE_PASSWORD` no `.env` da VPS, se ainda existir, **não é lida**.
Métricas, status e ações do painel continuam atrás de `X-Indexer-Test-Token`.

O `npm run smoke` cobra 200 em `/configure` e `/defaults.json`.

## 7. Instalar no cliente

```
https://powermovie.net/configure
```

Monte a config, copie o install URL. Ele carrega a chave do debrid no segmento
base64 — por isso ele só deve trafegar por HTTPS, e por isso o passo 3 prende a
7000 no loopback.

---

## 8. Worker nativo do Chupim — verificação e rollback (pós-corte do TS)

O autofetch ("Chupim") roda **só** no gateway Rust: o corpo TS que executava o
mesmo trabalho saiu da imagem na leva B4 (2026-10-28). `AUTOFETCH_WORKER` deixou
de ser "quem é o dono" e virou a **trava do worker nativo**: `on` (default do
`docker-compose.yml`, `${AUTOFETCH_WORKER:-on}`; o `.env` da VPS vence a
interpolação) liga o laço, e `off`/vazio desliga o Chupim inteiro — **não há
segundo dono para assumir**.

Com o worker **on**, o gateway consome três kinds de trabalho emitidos pelo
orquestrador — `autofetch_batch`, `br_probe` e `season_key` — mais a represa
`sup:` e a evicção F6 na passagem do laço. O que segue no Node: `adsub`/`adprot`
(marcas de posse e retenção que o nativo só LÊ) e o `harvester_enqueue`. As
quatro varreduras destrutivas da AllDebrid **não** estão mais aqui: o agendador é
o do gateway (`al_sweeps`), atrás do freio `DEBRID_AL_SWEEP_APPLY`. O marker com
`obra` e o registro F2 da obra são gravados pelo próprio aceite nativo
(`enqueue.rs:299-316`, `enqueue_obra.rs:294-295`). O painel lê os dois lados
(§8.4).

### 8.1 Pré-requisitos

| item | por quê |
|---|---|
| `GATEWAY=on` + `ROUTES_RUST=stream` (fixos no compose) | o emissor dos kinds é o `/stream` nativo; sem ele não há lote |
| `EFFECTS_RUST` **não** desligado (default ON no código) | `off` corta a emissão: nem worker nem Node recebem lote |
| `STREAM_STORE_ADMIN_TOKEN` — ou `DEBRID_INTERNAL_TOKEN`/`JACKETT_TEST_TOKEN` | sem token a admin 8711 responde **503** e não há como verificar o worker |
| nenhuma chave de debrid | não é pré-requisito: sem chave o worker sobe `active` e cada passo é pulado com `no-credential` |

### 8.2 Verificação pós-deploy (prova de que o worker subiu)

A 8711 é **loopback e nunca publicada**. Sonda de dentro do container (não abra
porta nova no firewall):

```bash
# caminho curto: o próprio script do repo (curl → node → docker exec)
./scripts/check-autofetch.sh

# equivalente à mão: a imagem NÃO tem curl (`node:22-alpine` + apk sem curl),
# então a sonda usa o wget do busybox. Token só no header.
docker compose exec adom sh -lc \
  'wget -q -O - --header "x-indexer-test-token: $STREAM_STORE_ADMIN_TOKEN" \
     http://127.0.0.1:8711/autofetch'
```

| campo de `status` no `GET /autofetch` | esperado | o que significa se não estiver |
|---|---|---|
| `phase` | `active` | `prepared` = o **laço** não subiu (fábrica/`HttpClient` ausente ou `AUTOFETCH_WORKER` diferente de `on`); `paused` = botão do painel |
| `enabled` | `true` | `false` com `phase=prepared` = o laço não subiu neste container (trava fora do literal `on` ou fábrica ausente) — com o TS fora da imagem não há segundo dono que assuma |
| `vaultAccounts` | `> 0` depois de tráfego com `dk` | `0` = nenhuma chave chegou ao cofre; worker vivo, todo lote em `no-credential` |
| `processed` / `inflight` | cresce após uma busca | `processed` são os **jobs despachados pelo canal** desde o boot (`control.rs:88-89`); parado = nada foi emitido (ver `EFFECTS_RUST`), nenhum lote passou os portões, ou o worker não é o dono — depois do corte do TS **não há Node** que execute o lote (§8.4) |
| `skips` | `no-credential`, `paused`, `budget`, `marker` aparecem | é o diagnóstico do que barrou o lote |
| `lastError` | `null` ou erro pontual de debrid | erro repetido = credencial/adaptador, não deploy |
| `lots` / `queueDepth` | **foto do boot**, não da fila viva (`worker.rs:74-79`) | valor congelado desde que o container subiu: não prova dreno nem crescimento. Prova de consumo é `processed` |
| `suppressed` / `lastSuppressedDrain` | presença do campo | ausência = gateway antigo (imagem anterior à rota) |

Prova de escrita pela admin (o painel usa as mesmas). As rotas são de
`rust/crates/adom-server/src/autofetch/routes.rs:15-22`: `pause` exige **só**
`{"paused":bool}`; `drain` e `suppressed-drain` **não levam corpo** — `effect`
é campo da RESPOSTA, não do pedido.

```bash
# `pause` leva corpo; `drain`/`suppressed-drain` NÃO levam corpo — o `fetch`
# do Node distingue os dois; o token viaja só no header.
docker compose exec adom node -e '
const t = process.env.STREAM_STORE_ADMIN_TOKEN || process.env.DEBRID_INTERNAL_TOKEN || "";
const post = (p, body) => fetch(`http://127.0.0.1:8711${p}`, {
  method: "POST",
  headers: { "x-indexer-test-token": t, ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => console.log(p, r.status, await r.text()));
Promise.all([
  post("/autofetch/pause", { paused: false }),
  post("/autofetch/drain"),
  post("/autofetch/suppressed-drain"),
]);'
```

Varreduras da AllDebrid (mesma admin, contrato em
[`docs/debrid-al-check-rust.md`](docs/debrid-al-check-rust.md) §9). `GET` não
toca a conta e responde `200` mesmo desligado; o `POST` roda **um** tipo por
chamada (`sweepDead`/`sweepUndubbed`/`reconcile`/`revalidate`, sem `all`), exige
a **credencial destrutiva** (`STREAM_STORE_ADMIN_TOKEN`/`DEBRID_INTERNAL_TOKEN` —
`sweeps_requires_admin_token` sem ela, `sweeps_token_insufficient` com o token de
diagnóstico) e só cobra `confirm` no modo `apply`:

```bash
# GET /sweeps — enabled/scheduled/mode/intervalMs/disabledReason + contadores
docker compose exec adom sh -lc \
  'wget -q -O - --header "x-indexer-test-token: $STREAM_STORE_ADMIN_TOKEN" \
     http://127.0.0.1:8711/sweeps'

# POST /sweeps/run — UM tipo; 409 confirmation_required sem o confirm
docker compose exec adom sh -lc \
  'wget -q -O - \
     --header "x-indexer-test-token: $STREAM_STORE_ADMIN_TOKEN" \
     --header "content-type: application/json" \
     --post-data "{\"kind\":\"sweepDead\",\"confirm\":true}" \
     http://127.0.0.1:8711/sweeps/run'
```

O token sai do env do container. Para o `POST` ele tem de ser a credencial
destrutiva (`STREAM_STORE_ADMIN_TOKEN`/`DEBRID_INTERNAL_TOKEN`): com só
`JACKETT_TEST_TOKEN` o `GET` funciona e o `run` responde `409`/`403`. A ordem do
`auth` é `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` →
`JACKETT_TEST_TOKEN` (`store_admin::token_from_env`), e a da credencial
destrutiva pára nas duas primeiras (`destructive_token_from_env`). Nenhum dos
comandos imprime segredo: o header aparece na requisição, não na saída.

Sinais no log do container: `docker compose logs adom | grep -i autofetch` —
um `[autofetch] passagem com N falha(s)` isolado é aceitável; a cada passagem,
não.

### 8.3 Rollback (dois degraus, e nenhum deles é env)

O degrau de env **não existe mais**. Depois do corte do TS,
`AUTOFETCH_WORKER=off` desliga o laço e **não devolve o trabalho a ninguém**: o
efeito de trabalho segue ao Node por `/internal/search/effects`, onde a forma é
aceita, o `kind` entra em `nativeOnly` e nada é executado — o lote morre, e o
único sintoma no 202 é `nativeOnly` subindo sem `rejected`. `off` serve para
PARAR o Chupim, nunca para voltar ao estado anterior.

**Degrau 1 — imagem/commit anterior.** Se o worker não sobe (gateway não sobe,
8711 em conflito, `/stream` em 503, `phase=prepared` com `enabled=false`), o
rollback é a **imagem/commit anterior** — em `esm`, é `git revert` do commit do
flip e deixar o cron reconstruir, ou `docker compose up -d --build` sobre o
commit anterior. O `/stream` nativo (fatia anterior) e o Chupim (pós-corte)
**não** têm rollback por env.

**Degrau 2 — volume.** Último recurso, e só com o KV ilegível: restaurar o
backup inteiro de `docker-data/`. O `cache.db` é um só e carrega fila v3,
marker, blacklist de mortas, represa e os demais namespaces — restaurar o
volume devolve o estado anterior ao corte, e a fila se reconcilia na busca
seguinte.

O que **não** é rollback:

- `AUTOFETCH_WORKER=off` — desliga o laço do gateway e deixa o efeito de
  trabalho sem executor (o Node aceita a forma e só conta em `nativeOnly`). Para
  o Chupim; não restaura o dono anterior.
- `EFFECTS_RUST=off` — corta a emissão dos kinds; o Chupim para inteiro. Use só
  como diagnóstico.
- `DEBRID_AL_SWEEP_APPLY=off` — deixa as quatro varreduras da AllDebrid em
  **READ-ONLY** (monta o plano e loga; nada sai da conta). Não devolve o
  agendador ao Node: ele não existe mais lá. Rollback das varreduras é
  imagem/commit anterior.
- apagar `docker-data/addon/cache.db` — leva junto fila v3, marker e blacklist
  de mortas; o sintoma piora.
- tirar a chave do `.env` — não desliga nada: o worker fica `active` com
  `vaultAccounts:0` e só pula passos.

Efeito colateral esperado do rollback: o cofre de chaves é RAM, então lotes em
voo perdem a credencial e são re-injetados pela ponte do `/stream` na próxima
busca — nenhuma fila é perdida (ela é no `cache.db`).

### 8.4 Checklist do corte do TS — código cortado, falta MEDIR em produção

O código **já está cortado** nesta leva (2026-10-28): os **19** arquivos da classe
(a) saíram de `src/`, `services.autofetchRunner` saiu do registro de serviços e
`evictFallbacks` saiu de `alldebrid.ts` (o método opcional do `DebridAdapter`
fica sem implementação de propósito — nada é apagado por omissão). **Nenhum
número deste checklist foi medido em produção nesta leva**: o que vem nos passos
1 e 2 é o que o operador ainda precisa medir e provar; o resto descreve o que já
está no código.

1. **Prova do worker** — `./scripts/check-autofetch.sh` com `AUTOFETCH_WORKER=on`
   tem que sair 0: `enabled=true` e `phase=active`. Exit 1 aqui não é "medir
   depois", é incidente: com o TS fora da imagem, `prepared` significa lote
   emitido para ninguém. Se a produção ainda estiver na imagem ANTERIOR, rode a
   sonda nela antes de subir — é o baseline; depois do deploy, repita e compare.
2. **Uma busca real** — uma obra que precise de dublado BR. Em `GET /autofetch`:
   `processed` sobe (jobs despachados pelo canal) e `skips` ganha o motivo;
   `lastError` fica `null`. **Não existe `enqueued` no status** e
   `queueDepth`/`lots` são foto do boot (§8.2): a prova de enfileiramento é
   `processed` subindo + a fila `autofetch:v3:q:` no KV, não o `queueDepth`.
3. **Critério de aceite do deploy** — o que se pode afirmar com esses dois
   números, sem inventar medição:
   - `phase=active` com `enabled=true` ⇒ o laço nativo subiu e é ele quem consome
     `autofetch_batch`/`br_probe`/`season_key`;
   - `processed` crescente depois de uma busca ⇒ o efeito saiu do orquestrador e
     foi despachado pelo canal — não existe mais fallback no Node que possa
     explicar o número;
   - `AUTOFETCH_WORKER=off` **não** é mais rollback: desliga o Chupim e o lote
     morre na rota do Node (§8.3). Voltar é imagem/commit anterior.
4. **O que sobe nativo x o que continua no Node** (estado do código, sem
   medição):

   | fluxo | onde roda depois do corte |
   |---|---|
   | lote pós-debrid (`autofetch_batch`): hold, cascata, pools, portões, escritor único da fila v3 | nativo (`rust/crates/adom-server/src/autofetch/`) |
   | recheck, settle, expiração, terminal, blacklist `dead:` e fila `autofetch:v3:q:` | nativo |
   | sonda dirigida (`br_probe`) e chave de temporada (`season_key`) | nativo (mesmo canal, despacho por `Job.kind`) |
   | represa `sup:` e evicção F6 (com o `adrm` que ela grava) | nativo (passagem do laço) |
   | interrogatório de áudio (`dub_audit`), warmer do RD (`rd_warmer`), colhedor | nativo — `rd_warmer` só volta ao Node se o sink recusar por falta de escopo |
   | ponte `/internal/search/effects` no Node | **só executa** `rd_warmer` e `harvester_enqueue`; os três kinds de trabalho são aceitos na forma e somados em `nativeOnly` |
   | marker com `obra` e registro F2 (`autofetch:v3:o:`) no aceite | nativo (`enqueue.rs:299-316`, `enqueue_obra.rs:294-295`); a ponte napi grava o mesmo marker |
   | `adsub`/`adprot` (posse e retenção que o nativo só LÊ) | Node (`alldebrid-inventory.ts`, `protected.ts`) |
   | painel do Chupim | do Node: config ao vivo (`cfg:v1:autofetch`) e pausa, obras do registro F2 e `lastSkips`/`trace.chupim` do anel do trace (**vazios desde o corte**: não há mais escritor no Node); do worker: os números da admin 8711. Sem a admin, o bloco sai `partial:true` e o card mostra "—", nunca zero |
   | varreduras destrutivas da AllDebrid (mortos, não-dublados, reconcile e represados) | nativo (`al_sweeps`), gate `DEBRID_AL_SWEEP_APPLY`; o Node não agenda nem executa nenhuma |

   **Ficam** (o nativo não cobre): `autofetch.ts` (encolhido — `reindexQueues`/
   `reindexDead` no boot, `markerActive` no `rd-warmer`, `isDeadQuiet` no
   `trace-recompute`), `autofetch-obra.ts` e família (registro F2: o aceite
   nativo grava, o Node lê no resumo), `autofetch-marker.ts` (chave, valor e
   `forget` do marker — a gravação de produção é do aceite nativo),
   `autofetch-gate.ts`,
   `autofetch-keys.ts`, `autofetch-suppressed.ts` (painel), `autofetch-evict.ts`
   (leitor da prova `er:` que o painel usa — só `hasBrReady`; política e executor
   são o passo nativo `evict_job.rs`),
   `utils/autofetch-trace.ts` (`trace.chupim` e o
   anel de motivos — **sem escritor desde o corte**: saem vazios e os números do
   laço vêm da admin 8711), as pontes (`utils/autofetch-native.ts`,
   `autofetch-state-native.ts`, `rust-autofetch.ts`) e o vocabulário/painel
   (`utils/autofetch-live*`, `autofetch-pools`, `autofetch-picks`,
   `autofetch-obra-summary`, `config/debrid*`, `routes/dashboard-*`,
   `client/painel/view-chupim.ts`).

   **Saíram** (a classe (a), **19 arquivos** — a lista é a mesma de
   `CUT_SOURCES` na catraca, `test/autofetch-cut-edges.test.ts:36-56`):
   `autofetch-{runner,candidates,batch,drain,recheck,settle,expired,terminal,
   index,lot-state,progress,season-index,seeds-pool,policy,gates,fallback}.ts`,
   `br-probe.ts`, `autofetch-chupim-trace.ts` e
   `src/debrid/alldebrid-fallback-evict.ts`. `autofetch-evict.ts`
   **não** está nessa lista: ele lê a ausência do evict do adaptador e não tenta
   outra via.
5. **A catraca muda de lado** (é o Juiz quem troca). A troca **já entrou**:
   `test/autofetch-cut-edges.test.ts` tem duas metades. `CUT_SOURCES` (19
   caminhos) é asserção de **não-existência** — cada caminho tem que **não
   existir** em `src/` (`:199-212`) — e de **não-importação** por `src/` e por
   `test/` (`:214-229`, `:284-299`); `LIVE_BOUNDARY` é a fronteira VIVA que
   precisa continuar existindo e exportando (`:231-247`). Reintroduzir um dos
   arquivos reprova o teste em vez de passar batido. A lista é a definição do
   corte: quem mexer no contrato da rota (`rd_warmer`/`harvester_enqueue`, testado
   em `:249-282`) mexe nela junto.
6. **Rollback = imagem anterior** — com o TS fora da imagem,
   `AUTOFETCH_WORKER=off` não devolve o trabalho a ninguém: o efeito vai ao Node,
   a forma é aceita e o `kind` só soma em `nativeOnly` (sem executor), e o lote
   morre. Voltar é `docker compose up -d --build` sobre o commit/imagem anterior
   (§8.3, degrau 1).

---

## 9. Deploy automático (pull da VPS)

Todo push em `esm` entra no ar em até 5 minutos: um cron do
usuário da VPS roda `~/adom-deploy.sh`, que faz `git fetch` e, havendo commit
novo, `checkout` + `docker compose up -d --build`. É pull, não push: o
provedor só aceita a porta 22 vindo do IP do operador, então CI batendo de
fora (GitHub Actions) nunca chega — testado de 10 locais do mundo, todos
bloqueados.

> Verificado em 2026-09-06: o `~/adom-deploy.sh` da VPS já faz `git fetch origin
> esm` + `checkout -f -B esm` — o deploy automático observa a branch certa
> (HEAD da VPS == `origin/esm`).

O script tem trava (`~/.adom-deploy.lock`) para o cron não sobrepor um build
em andamento e registra tudo em `~/adom-deploy.log`. Para deploy na hora,
sem esperar o cron:

```bash
~/adom-deploy.sh
```

Se o build falhar, o container antigo continua no ar — o compose só troca
quando o novo sobe.

---

## Operação

**Deploy na hora:** `~/adom-deploy.sh` (o cron de 5 min faz sozinho; o log
fica em `~/adom-deploy.log`).

**Logs:**

```bash
docker compose logs -f adom
```

Linhas que importam: `X/Y em cache no <debrid> (NNNms)`, `N fonte(s) BR fora do
cache mantida(s) como P2P`, `N stream(s) (parcial) para tt…`.

**Limpar cache** — `docker compose restart` zera a memória, mas o SQLite em
`docker-data/addon/cache.db` sobrevive. Para zerar de vez, pare a stack e apague
o arquivo.

**Teto de memória:** o compose limita a stack em 3 GB (o Chromium do
FlareSolverr sozinho come ~1 GB). Estourando, tudo reinicia via `restart` em vez
do OOM killer escolher a vítima no host. VPS com menos de 4 GB vai sofrer.
