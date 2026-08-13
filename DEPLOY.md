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
| `RESOLVE_SECRET` | `openssl rand -hex 32` | sem ele a assinatura usa a própria chave do debrid; trocar a chave invalida os links |
| `POSTGRES_PASSWORD` | senha longa e aleatória | vazio impede o Compose de iniciar |

O `Caddyfile` **não** se edita: ele lê `{$ADDON_DOMAIN}`. O default `localhost`
existe justamente para a máquina de casa não sair pedindo certificado de um
domínio cujo DNS aponta para a VPS.

Mais as suas credenciais: `JACKETT_API_KEY`, `DEBRID_API_KEY`, `TMDB_API_KEY`.

```bash
openssl rand -hex 32   # RESOLVE_SECRET
```

`ADMIN_DASHBOARD_PASSWORD` e `CONFIGURE_PAGE_PASSWORD` **não protegem nada** —
nenhum código as lê. Ver passo 6.

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

## 6. Fechar `/configure` (opcional)

`/configure` e `/defaults.json` são públicos. Eles **não** vazam a chave do
debrid — o `/defaults.json` a zera, e há teste no smoke cobrindo isso — mas
expõem sua lista de indexadores e deixam qualquer um gerar install URL na sua
instância.

```bash
docker exec stremio-adom caddy hash-password --plaintext 'suasenha'
```

Cole o hash no bloco `basic_auth` que já está comentado no `Caddyfile` e
recarregue.

## 7. Instalar no cliente

```
https://powermovie.net/configure
```

Monte a config, copie o install URL. Ele carrega a chave do debrid no segmento
base64 — por isso ele só deve trafegar por HTTPS, e por isso o passo 3 prende a
7000 no loopback.

---

## Operação

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
