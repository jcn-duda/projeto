#!/bin/bash
# Supervisor do container único: sobe Caddy, Jackett, FlareSolverr e o addon e
# mata o container quando QUALQUER um deles sair — o `restart: unless-stopped`
# do compose recria a stack inteira. Sem isso um crash silencioso (ex.: OOM do
# Chromium) deixaria metade da stack morta com o container "up".
#
# Precisa de bash: o busybox ash (sh padrão do alpine) não tem `wait -n`, trap
# de TERM com array de PIDs nem substituição de processo.
#
# Cada serviço escreve em `> >(awk ...)` e NÃO num pipe `| awk`. A diferença é
# o `$!`: num pipeline ele é o PID do awk, então o `kill` do shutdown mataria o
# formatador de log e deixaria Jackett e addon vivos — o encerramento pareceria
# funcionar sem encerrar nada. Com substituição de processo o `$!` é o serviço,
# e o código que o `wait -n` devolve é o dele, direto (medido: serviço saindo
# com 3 derruba o container com 3).
set -uo pipefail

pids=()
shutdown() {
  echo "[entrypoint] sinal recebido; encerrando subprocessos" >&2
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

mkdir -p /run/jackett-temp /caddy/data /caddy/config

# Prefixa stdout+stderr de cada processo pra manter a convenção de logs por
# subsistema ([jackett], [addon]…) mesmo com tudo misturado no mesmo stdout.
run() {
  local tag="$1"; shift
  "$@" > >(awk -v t="$tag" '{ print t " " $0; fflush() }') 2>&1 &
  pids+=("$!")
}

# Registro idempotente do Cardigann Apache no volume do Jackett.
#
# O volume /config nasce com o `apachetorrent.json` STOCK (indexer C# aposentado)
# e sem o card local `apachetorrent-cardigann.json` — o id plural que a definição
# embutida na imagem usa. Sem o card o catálogo do Jackett não expõe o id e a
# definição fica órfã; rebuild do container NÃO corrige, porque o estado mora no
# volume, não na imagem. O bootstrap roda ANTES de subir os processos: cria o
# card UMA vez (nunca sobrescreve config do operador), estaciona o resíduo stock
# num diretório irmão e é no-op no segundo boot.
#
# JACKETT_INDEXERS_DIR existe só para teste de contrato; o default é o caminho
# real do volume e NÃO é um knob público do addon.
JACKETT_INDEXERS_DIR="${JACKETT_INDEXERS_DIR:-/config/Jackett/Indexers}"

bootstrap_jackett_indexers() {
  local dir="${JACKETT_INDEXERS_DIR%/}"
  local disabled="${dir}-disabled"
  local card="$dir/apachetorrent-cardigann.json"
  local stock="$dir/apachetorrent.json"

  mkdir -p "$dir" "$disabled" 2>/dev/null || true

  # Card ausente: grava no mesmo molde de redetorrent-cardigann.json. O temp
  # nasce no MESMO diretório para o `mv` ser atômico (o Jackett nunca lê um
  # arquivo meio escrito) e é descartado se o move falhar.
  if [ ! -e "$card" ]; then
    local tmp="$card.tmp.$$"
    cat > "$tmp" <<'JSON'
[
  {
    "id": "sitelink",
    "type": "inputstring",
    "name": "Site Link",
    "value": "https://apachetorrents.com/"
  },
  {
    "id": "cookieheader",
    "type": "hiddendata",
    "name": "CookieHeader",
    "value": ""
  },
  {
    "id": "lasterror",
    "type": "hiddendata",
    "name": "LastError",
    "value": null
  },
  {
    "id": "tags",
    "type": "inputtags",
    "name": "Tags",
    "value": ""
  }
]
JSON
    if [ $? -ne 0 ]; then
      rm -f "$tmp" 2>/dev/null || true
      echo "[entrypoint] aviso: falha ao gravar o card apachetorrent-cardigann; stock preservado" >&2
      return
    fi
    if mv "$tmp" "$card" 2>/dev/null; then
      chown node:node "$card" 2>/dev/null || true
      echo "[entrypoint] indexer Cardigann apachetorrent-cardigann registrado"
    else
      rm -f "$tmp" 2>/dev/null || true
      echo "[entrypoint] aviso: falha ao instalar o card apachetorrent-cardigann; stock preservado" >&2
      return
    fi
  fi

  # Resíduo stock: sai do diretório ativo (senão o catálogo carrega um id
  # aposentado) para o irmão `-disabled`, com nome estável e reversível. Nunca
  # apaga em silêncio conteúdo divergente: só remove o ativo quando é idêntico a
  # um backup já existente.
  if [ -e "$stock" ]; then
    if [ ! -e "$disabled/apachetorrent.json" ]; then
      if mv "$stock" "$disabled/apachetorrent.json" 2>/dev/null; then
        echo "[entrypoint] indexer stock apachetorrent estacionado em ${disabled}"
      else
        echo "[entrypoint] aviso: não foi possível estacionar o stock apachetorrent" >&2
      fi
    elif cmp -s "$stock" "$disabled/apachetorrent.json"; then
      rm -f "$stock" 2>/dev/null || true
      echo "[entrypoint] resíduo stock apachetorrent idêntico ao backup removido"
    elif [ ! -e "$disabled/apachetorrent.json.legacy" ]; then
      if mv "$stock" "$disabled/apachetorrent.json.legacy" 2>/dev/null; then
        echo "[entrypoint] variação stock apachetorrent estacionada em .legacy"
      else
        echo "[entrypoint] aviso: não foi possível estacionar a variação stock apachetorrent" >&2
      fi
    elif cmp -s "$stock" "$disabled/apachetorrent.json.legacy"; then
      rm -f "$stock" 2>/dev/null || true
      echo "[entrypoint] resíduo stock apachetorrent idêntico ao .legacy removido"
    else
      echo "[entrypoint] aviso: stock apachetorrent divergente preservado no diretório ativo" >&2
    fi
  fi
}

bootstrap_jackett_indexers

# A ordem é só pra legibilidade de log: o addon já tolera o Jackett demorar
# (busca degrada e o passe tardio recacheia quando tudo chega).
run '[caddy]' env XDG_CONFIG_HOME=/caddy/config XDG_DATA_HOME=/caddy/data \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

run '[jackett]' env XDG_CONFIG_HOME=/config XDG_DATA_HOME=/config TMPDIR=/run/jackett-temp \
  /app/Jackett/jackett --NoUpdates

# PORT fixo: o .env define PORT=7000 pro addon, e o FlareSolverr também lê
# PORT do ambiente — sem isso ele tenta subir na porta do addon e morre em
# "Address in use".
run '[flaresolverr]' env PORT=8191 python3 -u /app/flaresolverr/flaresolverr.py

# Saída do tsc, não o fonte: a imagem de runtime recebe só `dist/` (o COPY
# --from=builder do Dockerfile), então `src/addon.js` não existe lá dentro.
run '[addon]' node dist/src/addon.js

wait -n "${pids[@]}"
code=$?
echo "[entrypoint] um processo saiu com código $code; derrubando o container" >&2
exit "$code"
