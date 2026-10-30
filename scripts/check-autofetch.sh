#!/usr/bin/env bash
# Sonda a admin do gateway (loopback + token) e responde se o worker nativo do
# Chupim está CONSUMINDO o canal, não só se o container subiu.
#
# Rotas da admin (`rust/crates/adom-server/src/autofetch/routes.rs:15-22`):
#   GET  /autofetch                    -> phase / enabled / processed / skips /
#                                         queueDepth / lots / suppressed
#   POST /autofetch/config             -> {"paused":bool,"intervalMs":n}
#   POST /autofetch/pause              -> {"paused":bool} (só esse campo)
#   POST /autofetch/drain              -> SEM corpo
#   POST /autofetch/suppressed-drain   -> SEM corpo
# Esta sonda usa SÓ o GET, de propósito: é read-only e `drain` faz trabalho real.
#
# Por que existe: `phase:"active"` só aparece quando o LAÇO subiu. Com
# `AUTOFETCH_WORKER=on` o boot monta a fábrica de produção
# (`autofetch/boot.rs::production_factory`, injetada em `boot.rs:103-106`); sem
# ela — `HttpClient` do debrid que não abriu, `Build::new` falhando, KV do
# `cache.db` inacessível, trava fora do literal `on` — o worker fica
# `phase:"prepared"` e TODO efeito de trabalho segue ao Node
# (`rust/crates/adom-server/src/tail_effects.rs:136-156`). Depois do corte do TS
# do Chupim (leva B4) o Node NÃO executa mais esses kinds: a rota
# `/internal/search/effects` não executa nenhum kind (só valida a forma e conta
# em `nativeOnly`), então o lote morre — `prepared` deixou de significar "segundo dono" e
# virou trabalho perdido. No log de boot os dois
# estados são indistinguíveis (nenhum canal é criado em `prepared`), então
# "subiu" passaria por "ligado". Esta sonda separa os casos.
#
# Uso:
#   scripts/check-autofetch.sh
#   AUTOFETCH_WORKER=on scripts/check-autofetch.sh     # exige enabled=true
#   STREAM_STORE_ADMIN_URL=http://127.0.0.1:8711 scripts/check-autofetch.sh
#
# A admin escuta 127.0.0.1 DENTRO do container e o compose não publica a 8711.
# O script resolve isso sozinho quando existe `docker` no PATH (re-executa a
# sonda dentro do container). Em host sem docker CLI (WSL/Git Bash no Windows),
# copie e rode lá:
#   docker cp scripts/check-autofetch.sh stremio-adom:/tmp/check-autofetch.sh
#   docker exec stremio-adom bash /tmp/check-autofetch.sh
#   docker exec -e AUTOFETCH_WORKER= stremio-adom bash /tmp/check-autofetch.sh
#
# Env:
#   STREAM_STORE_ADMIN_URL    base da admin (default: http://$STREAM_STORE_ADMIN_LISTEN,
#                             e esse default é http://127.0.0.1:8711)
#   STREAM_STORE_ADMIN_TOKEN  token próprio; cai para DEBRID_INTERNAL_TOKEN e
#                             JACKETT_TEST_TOKEN (mesma ordem do `store_admin.rs:88`)
#   AUTOFETCH_WORKER          expectativa: `on` exige enabled=true; vazio = só informa
#   CHECK_AUTOFETCH_EXPECT    mesma expectativa, com precedência sobre
#                             AUTOFETCH_WORKER (é o que o modo container exporta:
#                             o host não vê o `.env` do compose)
#   ADOM_CONTAINER            container usado quando a admin só é alcançável por
#                             dentro dele (default: stremio-adom)
#   CHECK_AUTOFETCH_INNER=1   uso interno do modo container (não recursa)
#
# Saída: 0 = estado esperado (ou nenhuma expectativa declarada); 1 = divergência
# ou sonda falhou. O token vai SEMPRE no header `X-Indexer-Test-Token` — nunca
# na URL, que sobra em log de proxy e em `ps`.
set -uo pipefail

BASE_URL="${STREAM_STORE_ADMIN_URL:-}"
if [ -z "$BASE_URL" ]; then
  BASE_URL="http://${STREAM_STORE_ADMIN_LISTEN:-127.0.0.1:8711}"
fi
BASE_URL="${BASE_URL%/}"

TOKEN="${STREAM_STORE_ADMIN_TOKEN:-}"
[ -z "$TOKEN" ] && TOKEN="${DEBRID_INTERNAL_TOKEN:-}"
[ -z "$TOKEN" ] && TOKEN="${JACKETT_TEST_TOKEN:-}"

# Token vazio aqui não significa token vazio no container: `fetch_local` manda o
# header vazio e a admin responde 401/503. O aviso existe para esse 401/503 não
# ser lido como "worker morto".
if [ -z "$TOKEN" ]; then
  echo "[autofetch] AVISO: sem token no host (STREAM_STORE_ADMIN_TOKEN/DEBRID_INTERNAL_TOKEN/JACKETT_TEST_TOKEN)." >&2
  echo "[autofetch] AVISO: 401/503 abaixo pode ser só isto — o container pode ter o token." >&2
fi

# Expectativa declarada pelo CHAMADOR, não pelo container: quem roda a sonda no
# host não tem o `AUTOFETCH_WORKER` do compose no ambiente, e adivinhar pelo
# 8711 seria mentira. Vazio = informativo.
EXPECT="${CHECK_AUTOFETCH_EXPECT:-${AUTOFETCH_WORKER:-}}"
CONTAINER="${ADOM_CONTAINER:-stremio-adom}"

BODY=""
HTTP_CODE=""

# GET com curl (preferido). O container de runtime NÃO tem curl, então há o
# fallback em node (a base da imagem) — sem dependência nova em nenhum dos dois.
fetch_local() {
  if command -v curl >/dev/null 2>&1; then
    local out
    out="$(curl -sS --max-time 10 \
      -H "X-Indexer-Test-Token: ${TOKEN}" \
      -w '\n%{http_code}' \
      "${BASE_URL}/autofetch" 2>/dev/null)" || return 1
    HTTP_CODE="${out##*$'\n'}"
    BODY="${out%$'\n'*}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    local out
    # Token por env (não por argv): `ps` mostra argumentos, ambiente não.
    out="$(CHECK_AUTOFETCH_TOKEN="$TOKEN" node -e '
      const http = require("http");
      const target = new URL(process.argv[1]);
      const req = http.request({
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname,
        method: "GET",
        headers: { "X-Indexer-Test-Token": process.env.CHECK_AUTOFETCH_TOKEN || "" }
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => { process.stdout.write(body + "\n" + res.statusCode); });
      });
      req.setTimeout(10000, () => req.destroy(new Error("timeout")));
      req.on("error", (err) => { process.stderr.write(String(err.message)); process.exit(1); });
      req.end();
    ' "${BASE_URL}/autofetch" 2>/dev/null)" || return 1
    HTTP_CODE="${out##*$'\n'}"
    BODY="${out%$'\n'*}"
    return 0
  fi
  return 1
}

container_up() {
  command -v docker >/dev/null 2>&1 || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

# A admin escuta 127.0.0.1 DENTRO do container e o compose não publica a 8711.
# Sem alcançar daqui, a mesma sonda roda lá dentro (env do container já tem o
# token; o script chega por stdin, sem COPY na imagem).
run_in_container() {
  echo "[autofetch] admin não alcançável em ${BASE_URL}; sondando dentro de ${CONTAINER}" >&2
  docker exec -e "CHECK_AUTOFETCH_EXPECT=${EXPECT}" -i "$CONTAINER" bash -s < "$0"
  return $?
}

# Campos do `status` num JSON de UMA linha (`{"ok":true,"status":{...}}`). Sem
# jq no runtime: sed basta para escalares de topo. `skips` é objeto e fica de fora.
field() {
  printf '%s' "$BODY" | tr -d '\n' | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | tr -d '"'
}

report() {
  local phase enabled depth lots processed suppressed
  phase="$(field phase)"
  enabled="$(field enabled)"
  depth="$(field queueDepth)"
  lots="$(field lots)"
  processed="$(field processed)"
  suppressed="$(field suppressed)"

  echo "[autofetch] GET ${BASE_URL}/autofetch (HTTP ${HTTP_CODE})"
  echo "[autofetch] phase=${phase:-?} enabled=${enabled:-?} processed=${processed:-?} queueDepth=${depth:-?} lots=${lots:-?} suppressed=${suppressed:-?}"
  # `queueDepth`/`lots` são FOTO DO BOOT (`worker.rs:69-70`): dizem o que o KV
  # tinha ao subir, não a fila viva. Quem prova consumo é `processed` — jobs
  # despachados pelo canal desde o boot (`control.rs:88-89`).
  # Corpo cru é seguro: o status nunca carrega credencial (vault só publica
  # contagem). Ajuda quando o painel e a sonda discordarem.
  echo "[autofetch] status=${BODY}"

  if [ -z "$EXPECT" ]; then
    echo "[autofetch] AVISO: AUTOFETCH_WORKER vazio no host — nenhuma expectativa declarada."
    echo "[autofetch] AVISO: resultado informativo (exit 0). Rode com AUTOFETCH_WORKER=on para cobrar enabled=true."
    return 0
  fi

  case "$EXPECT" in
    on)
      if [ "$enabled" = "true" ]; then
        echo "[autofetch] OK: worker nativo consumindo o canal (phase=${phase})."
        return 0
      fi
      echo "[autofetch] FALHA: AUTOFETCH_WORKER=on mas enabled=${enabled:-?} phase=${phase:-?}." >&2
      if [ "$phase" = "prepared" ]; then
        echo "[autofetch] 'prepared' = o LAÇO não subiu: fábrica ausente (HttpClient do debrid" >&2
        echo "[autofetch] não abriu, Build::new falhou, KV inacessível) ou trava fora do literal 'on'." >&2
        echo "[autofetch] Sem a fábrica o lote é REJEITADO no Node (corte do TS) — rollback é imagem anterior." >&2
      elif [ "$phase" = "unavailable" ]; then
        echo "[autofetch] store/KV indisponível no gateway: o handle do worker nem existe." >&2
      fi
      return 1
      ;;
    off|"")
      if [ "$enabled" = "true" ]; then
        echo "[autofetch] FALHA: AUTOFETCH_WORKER=off mas o worker está ativo (phase=${phase})." >&2
        return 1
      fi
      echo "[autofetch] OK: worker desligado como esperado (phase=${phase:-?})."
      echo "[autofetch] Com o TS fora da imagem, 'off' significa Chupim PARADO — não é rollback." >&2
      return 0
      ;;
    *)
      echo "[autofetch] AVISO: AUTOFETCH_WORKER=${EXPECT} não é on/off; tratando como informativo." >&2
      return 0
      ;;
  esac
}

if fetch_local; then
  :
elif [ "${CHECK_AUTOFETCH_INNER:-}" != "1" ] && container_up; then
  run_in_container
  exit $?
else
  echo "[autofetch] FALHA: não consegui falar com ${BASE_URL}/autofetch." >&2
  echo "[autofetch] Confira STREAM_STORE_ADMIN_URL/STREAM_STORE_ADMIN_LISTEN e se o gateway subiu." >&2
  exit 1
fi

if [ "$HTTP_CODE" != "200" ]; then
  echo "[autofetch] FALHA: HTTP ${HTTP_CODE} em ${BASE_URL}/autofetch." >&2
  case "$HTTP_CODE" in
    401) echo "[autofetch] Token recusado: STREAM_STORE_ADMIN_TOKEN/DEBRID_INTERNAL_TOKEN/JACKETT_TEST_TOKEN não casa com o do gateway." >&2 ;;
    503) echo "[autofetch] Admin sem token configurado (o gateway responde 503 até alguém definir o token)." >&2 ;;
  esac
  exit 1
fi

report
exit $?
