#!/usr/bin/env bash
# Sonda a admin do gateway (loopback + token) e responde se o worker nativo do
# Chupim está CONSUMIDO o canal, não só se o container subiu.
#
#   GET /autofetch → phase / enabled / queueDepth / lots
#
# Por que existe: com `AUTOFETCH_WORKER=on` no compose o worker só chega a
# `phase:"active"` quando o boot injeta a fábrica de debrid — até lá o contrato é
# `enabled:false`/`phase:"prepared"` e TODO efeito de trabalho segue ao Node
# (`rust/crates/adom-server/src/tail_effects.rs:136`). No log de boot os dois
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
  local phase enabled depth lots
  phase="$(field phase)"
  enabled="$(field enabled)"
  depth="$(field queueDepth)"
  lots="$(field lots)"

  echo "[autofetch] GET ${BASE_URL}/autofetch (HTTP ${HTTP_CODE})"
  echo "[autofetch] phase=${phase:-?} enabled=${enabled:-?} queueDepth=${depth:-?} lots=${lots:-?}"
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
        echo "[autofetch] ESPERADO NESTA LEVA: a fábrica de debrid ainda não é injetada no boot" >&2
        echo "[autofetch] (autofetch::spawn() passa None); o trabalho segue no Node. Flip mantido." >&2
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
