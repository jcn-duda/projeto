#!/bin/bash
# Supervisor do container único: sobe Caddy, Jackett, FlareSolverr e o addon e
# mata o container quando QUALQUER um deles sair — o `restart: unless-stopped`
# do compose recria a stack inteira. Sem isso um crash silencioso (ex.: OOM do
# Chromium) deixaria metade da stack morta com o container "up".
#
# Precisa de bash: o busybox ash (sh padrão do alpine) não tem `wait -n`.
# pipefail: sem isso o exit code do pipeline é o do awk (sempre 0) e o
# supervisor jamais veria o crash do processo vigiado.
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

run '[addon]' node src/addon.js

wait -n "${pids[@]}"
code=$?
echo "[entrypoint] um processo saiu com código $code; derrubando o container" >&2
exit "$code"
