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

## 8. Worker nativo do Chupim — flip, verificação e rollback

O autofetch ("Chupim") roda no gateway Rust desde que `AUTOFETCH_WORKER=on`.
O default vive no `docker-compose.yml` como `${AUTOFETCH_WORKER:-on}` — logo, o
`.env` **manda**: `AUTOFETCH_WORKER=off` desliga sem rebuild de imagem.

Com o worker **on**, o gateway consome três kinds de trabalho emitidos pelo
orquestrador: `autofetch_batch`, `br_probe` e `season_key`. Sem worker (ou sem
escopo de chave no cofre) o efeito volta ao Node por
`/internal/search/effects` e o TS do Chupim executa. O resto (marker, hold,
fila v3, painel) continua no Node/painel dos dois jeitos.

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

# equivalente à mão
docker compose exec adom sh -lc \
  'curl -s -H "x-indexer-test-token: $STREAM_STORE_ADMIN_TOKEN" \
   http://127.0.0.1:8711/autofetch' | jq .
```

| campo do `GET /autofetch` | esperado | o que significa se não estiver |
|---|---|---|
| `phase` | `active` | `prepared` = o **laço** não subiu (fábrica/`HttpClient` ausente ou `AUTOFETCH_WORKER` diferente de `on`); `paused` = botão do painel |
| `enabled` | `true` | `false` com `phase=prepared` = flip não aplicado neste container |
| `vaultAccounts` | `> 0` depois de tráfego com `dk` | `0` = nenhuma chave chegou ao cofre; worker vivo, todo lote em `no-credential` |
| `processed` / `inflight` | cresce após uma busca | parado = nada foi emitido (ver `EFFECTS_RUST`) ou nenhum lote passou os portões |
| `skips` | `no-credential`, `paused`, `budget`, `marker` aparecem | é o diagnóstico do que barrou o lote |
| `lastError` | `null` ou erro pontual de debrid | erro repetido = credencial/adaptador, não deploy |
| `lots` / `queueDepth` | acompanham a fila v3 | fila cheia com `processed` zero = dreno travado |
| `suppressed` / `lastSuppressedDrain` | presença do campo | ausência = gateway antigo (imagem anterior à rota) |

Prova de escrita pela admin (o painel usa as mesmas):

```bash
docker compose exec adom sh -lc 'T=$STREAM_STORE_ADMIN_TOKEN; B=http://127.0.0.1:8711
curl -s -X POST -H "x-indexer-test-token: $T" -H "content-type: application/json" \
  -d "{\"paused\":false}" $B/autofetch/pause
curl -s -X POST -H "x-indexer-test-token: $T" -H "content-type: application/json" \
  -d "{\"effect\":\"requested\"}" $B/autofetch/drain'
```

Sinais no log do container: `docker compose logs adom | grep -i autofetch` —
um `[autofetch] passagem com N falha(s)` isolado é aceitável; a cada passagem,
não.

### 8.3 Rollback (na ordem que funciona)

O rollback do Chupim **é env**, e sobrevive a rebuild porque o `.env` não é
versionado (o cron de deploy não o toca):

```bash
# no .env da VPS
AUTOFETCH_WORKER=off

docker compose up -d          # recria o container e RELÊ o .env
```

`docker compose restart` **não** relê o `.env` — use `up -d` (sem `--build`).
Com `off`, `worker_enabled()` fica falso, nenhuma thread `adom-autofetch` sobe
e os três kinds voltam ao Node por `Forward`: o TS do Chupim (que segue na
imagem) reassume em um intervalo. Isso vale inclusive se o laço estiver
panicando — sem `on` o laço nem é criado.

O que **não** é rollback:

- `EFFECTS_RUST=off` — corta a emissão dos kinds; o Chupim para inteiro (nem
  nativo, nem Node). Use só como diagnóstico.
- apagar `docker-data/addon/cache.db` — leva junto fila v3, marker e blacklist
  de mortas; o sintoma piora.
- tirar a chave do `.env` — não desliga nada: o worker fica `active` com
  `vaultAccounts:0` e só pula passos.

Se a env não bastar (gateway não sobe, 8711 em conflito, `/stream` em 503),
rollback é a **imagem/commit anterior** — em `esm`, é `git revert` do commit do
flip e deixar o cron reconstruir, ou `docker compose up -d --build` sobre o
commit anterior. O `/stream` nativo (fatia anterior) **não** tem rollback por
env; o Chupim tem.

Efeito colateral esperado do rollback: o cofre de chaves é RAM, então lotes em
voo perdem a credencial e são re-injetados pela ponte do `/stream` na próxima
busca — nenhuma fila é perdida (ela é no `cache.db`).

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
