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

# Core dump DESLIGADO para todos os subprocessos.
#
# O host tem `kernel.core_pattern=core` (arquivo, não pipe), o cwd do supervisor
# é /app e o Chromium do FlareSolverr crasha de tempos em tempos — cada crash
# despejava ~700 MB de `core.<pid>` na camada de escrita do container. Em
# 2026-09-16 isso encheu os 38 GB do disco da VPS com 364 cores: o `git fetch`
# do deploy automático passou a falhar por falta de espaço e a producao ficou
# 24h congelada num commit velho, sem nem conseguir logar o erro (o log também
# não tinha onde ser escrito).
#
# O que mascarava isso era o proprio deploy: `docker compose up -d --build`
# recria o container e joga fora a camada de escrita, entao os cores sumiam a
# cada push. Bastou passar um dia sem deploy para o disco estourar — e a partir
# dai o problema se sustentava sozinho.
#
# `ulimit -c 0` nao esconde crash nenhum: o FlareSolverr continua logando a
# falha e o supervisor continua derrubando o container se um serviço morrer. Só
# impede que a autopsia de 700 MB vire um problema de infraestrutura.
ulimit -c 0 2>/dev/null || true

# Knobs da supervisão do adom-resolvers (laço abaixo).
#
# Ficam AQUI e não em src/config.ts + .env.example porque são do entrypoint, não
# do operador: o binário Rust não lê config.ts (é outro processo, e a policy de
# restart é decisão do supervisor, não do resolvido). O interruptor que o
# operador controla já existe e é um só — BR_RESOLVER_RUST preenchido liga a
# supervisão; vazio desliga tudo (caminho TS intacto).
RESOLVERS_MAX_RESTARTS=5   # mortes seguidas toleradas; a 5ª derruba o container
RESOLVERS_BACKOFF_START=2  # segundos até o 1º reinício (dobra a cada morte)
RESOLVERS_BACKOFF_MAX=60   # teto do backoff: 2→4→8→16→32→60…

pids=()
SIDECAR_PID=""
RESOLVERS_SUPERVISOR_PID=""
shutdown() {
  echo "[entrypoint] sinal recebido; encerrando subprocessos" >&2
  # Sidecar do raspador (se ativo): mata sem esperar, ele não está no wait -n
  [ -n "$SIDECAR_PID" ] && kill -TERM "$SIDECAR_PID" 2>/dev/null || true
  # Supervisor dos resolvers: o trap do laço repassa o TERM ao filho em
  # andamento (variável do laço só é visível lá dentro — daqui não dá para
  # matar o binário direto). A saída deste shell derruba o container, e o
  # Docker ceifa o que sobrou.
  [ -n "$RESOLVERS_SUPERVISOR_PID" ] && kill -TERM "$RESOLVERS_SUPERVISOR_PID" 2>/dev/null || true
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

# Molde de card do Jackett (mesmo shape de redetorrent-cardigann.json), escrito
# no caminho recebido. Único lugar com o JSON: o sitelink é o que varia entre
# os cards, e duplicar o molde faria as cópias divergirem na próxima mudança.
write_indexer_card() {
  local path="$1" sitelink="$2"
  cat > "$path" <<JSON
[
  {
    "id": "sitelink",
    "type": "inputstring",
    "name": "Site Link",
    "value": "${sitelink}"
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
}

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
    if write_indexer_card "$tmp" 'https://apachetorrents.com/' && mv "$tmp" "$card" 2>/dev/null; then
      chown node:node "$card" 2>/dev/null || true
      echo "[entrypoint] indexer Cardigann apachetorrent-cardigann registrado"
    else
      rm -f "$tmp" 2>/dev/null || true
      echo "[entrypoint] aviso: falha ao instalar o card apachetorrent-cardigann; stock preservado" >&2
      return
    fi
  fi

  park_stock_indexer apachetorrent

  # HDR reativado: o resolver local (porta 8707) contorna a busca quebrada do
  # site raspando as páginas de listagem. O card ATIVO precisa do nome da
  # DEFINIÇÃO (`hdrtorrent-cardigann.json` — é o filename que vira o id no
  # Jackett), e o fluxo é o mesmo molde do Apache: reativa card estacionado do
  # id certo e cria se ausente, sem sobrescrever config do operador.
  #
  # Medido no Docker local (2026-09-19): o par `reactivate_parked_card hdrtorrent`
  # + `park_stock_indexer hdrtorrent` era ping-pong do MESMO arquivo (stock C#
  # `hdrtorrent.json`): reativava e reestacionava em seguida, e o catálogo do
  # Jackett ficava SEM o `hdrtorrent-cardigann` enquanto o addon o listava. O
  # stock C# segue estacionado; quem expõe o id novo é a definição da imagem.
  reactivate_parked_card hdrtorrent-cardigann
  local hdr_card="$dir/hdrtorrent-cardigann.json"
  if [ ! -e "$hdr_card" ]; then
    local hdr_tmp="$hdr_card.tmp.$$"
    if write_indexer_card "$hdr_tmp" 'https://hdrtorrents.net/' && mv "$hdr_tmp" "$hdr_card" 2>/dev/null; then
      chown node:node "$hdr_card" 2>/dev/null || true
      echo "[entrypoint] indexer Cardigann hdrtorrent-cardigann registrado"
    else
      rm -f "$hdr_tmp" 2>/dev/null || true
      echo "[entrypoint] aviso: falha ao instalar o card hdrtorrent-cardigann" >&2
    fi
  fi
  park_stock_indexer hdrtorrent

  # Chromium derrubando a aba: `rutor` e `kickasstorrents-ws` respondiam com
  # `tab crashed` no FlareSolverr e ZERO release — 28 crashes/hora medidos em
  # 2026-09-17, com o RuTor pendurando 100 SEGUNDOS por busca. O FlareSolverr
  # atende em fila serial, entao cada um desses atrasa todas as outras fontes.
  #
  # Tirar do JACKETT_INDEXERS do .env NAO basta: a lista efetiva de uma busca
  # vem do `ji` da config SELADA na URL de instalacao (collect-orchestrator lê
  # `opts().jackettIndexers`), entao quem ja instalou continua pedindo os dois.
  # Estacionar no Jackett corta na fonte, para qualquer instalacao.
  #
  # `kickasstorrents-to` fica FORA desta lista de proposito: foi revalidado e
  # esta entregando (commit d218548).
  park_stock_indexer rutor
  park_stock_indexer kickasstorrents-ws
}

# Estaciona `<id>.json` do diretório ativo no irmão `-disabled` (senão o
# catálogo carrega um id aposentado), com nome estável e reversível. Nunca
# apaga em silêncio conteúdo divergente: só remove o ativo quando é idêntico a
# um backup já existente.
park_stock_indexer() {
  local id="$1"
  local dir="${JACKETT_INDEXERS_DIR%/}"
  local disabled="${dir}-disabled"
  local stock="$dir/$id.json"
  local backup="$disabled/$id.json"

  [ -e "$stock" ] || return 0

  if [ ! -e "$backup" ]; then
    if mv "$stock" "$backup" 2>/dev/null; then
      echo "[entrypoint] indexer stock $id estacionado em ${disabled}"
    else
      echo "[entrypoint] aviso: não foi possível estacionar o stock $id" >&2
    fi
  elif cmp -s "$stock" "$backup"; then
    rm -f "$stock" 2>/dev/null || true
    echo "[entrypoint] resíduo stock $id idêntico ao backup removido"
  elif [ ! -e "$backup.legacy" ]; then
    if mv "$stock" "$backup.legacy" 2>/dev/null; then
      echo "[entrypoint] variação stock $id estacionada em .legacy"
    else
      echo "[entrypoint] aviso: não foi possível estacionar a variação stock $id" >&2
    fi
  elif cmp -s "$stock" "$backup.legacy"; then
    rm -f "$stock" 2>/dev/null || true
    echo "[entrypoint] resíduo stock $id idêntico ao .legacy removido"
  else
    echo "[entrypoint] aviso: stock $id divergente preservado no diretório ativo" >&2
  fi
}

# Reativa um card estacionado: move `<id>.json` do diretório `-disabled` de
# volta para o ativo. Se o card já está no diretório ativo, é no-op. Se o
# operador editou o card estacionado, a edição é preservada (o mv não
# sobrescreve).
reactivate_parked_card() {
  local id="$1"
  local dir="${JACKETT_INDEXERS_DIR%/}"
  local disabled="${dir}-disabled"
  local card="$dir/$id.json"
  local parked="$disabled/$id.json"

  [ -e "$parked" ] || return 0
  [ -e "$card" ] && return 0
  if mv "$parked" "$card" 2>/dev/null; then
    echo "[entrypoint] card $id reativado de ${disabled}"
  else
    echo "[entrypoint] aviso: falha ao reativar o card $id" >&2
  fi
}

# Semeia um card JÁ estacionado (diretório `-disabled`), pronto para religar.
# Só grava se ausente: um card estacionado que o operador editou é config dele.
# Não toca no diretório ativo — semear NUNCA liga o indexer.
seed_parked_card() {
  local id="$1" sitelink="$2"
  local disabled="${JACKETT_INDEXERS_DIR%/}-disabled"
  local card="$disabled/$id.json"

  [ -e "$card" ] && return 0
  local tmp="$card.tmp.$$"
  if write_indexer_card "$tmp" "$sitelink" && mv "$tmp" "$card" 2>/dev/null; then
    chown node:node "$card" 2>/dev/null || true
    echo "[entrypoint] card $id semeado estacionado em ${disabled} (nao ligado)"
  else
    rm -f "$tmp" 2>/dev/null || true
    echo "[entrypoint] aviso: falha ao semear o card estacionado $id" >&2
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

# Sidecar do raspador Rust (só quando CRAWL_ENGINE=rust).
# O sidecar NÃO entra no `wait -n` abaixo: ele tem reinício próprio ou fica
# fora do supervisionamento. O `wait -n` continua supervisionando só
# caddy+jackett+flaresolverr+addon.
if [ "${CRAWL_ENGINE:-ts}" = "rust" ]; then
    echo "[entrypoint] iniciando sidecar adom-crawl (CRAWL_ENGINE=rust)"
    /app/dist/rust/adom-sidecar &
    SIDECAR_PID=$!
    # Aguarda sidecar ficar pronto (healthcheck)
    for i in $(seq 1 10); do
        if curl -sf http://127.0.0.1:${CRAWL_SIDECAR_PORT:-7077}/health > /dev/null 2>&1; then
            echo "[entrypoint] sidecar pronto"
            break
        fi
        sleep 1
    done
fi

# Laço de supervisão do adom-resolvers — só rodado com BR_RESOLVER_RUST não vazio.
#
# O binário serve TODOS os sites delegados num processo único
# (rust/crates/adom-resolvers/src/main.rs: um tokio::spawn por entrada do CSV).
# Morto ele, as portas 8700-8707 somem, o healthcheck do Dockerfile NÃO cobre
# essas portas, e o `wait -n` não o enxerga: o container ficaria "saudável" com
# todos os indexers BR ausentes da busca — a falha silenciosa que o contrato dos
# outros quatro processos existe para evitar.
#
# Por que laço de restart e NÃO `wait -n` direto: a delegação é parcial por
# design (BR_RESOLVER_RUST aceita subconjunto dos 8 sites — um site experimental
# derrubaria a stack inteira, Chromium e ACME inclusos, a cada crash dele), e o
# binário sai com código 0 quando o CSV é inválido (main.rs: "nenhuma entrada
# válida") — no wait -n um typo no .env viraria crash-loop instantâneo do
# container, sem nenhuma chance de recuperação local. O laço cobre o crash
# transitório (OOM, panic de um site) sem reiniciar nada; o crash PERMANENTE
# degenera para o mesmo contrato dos outros quatro: esgotadas
# RESOLVERS_MAX_RESTARTS mortes seguidas, derruba o container e o
# `restart: unless-stopped` recria a stack (o contador zera no recriar — sem
# reset por uptime de propósito: 5 quedas ao longo de semanas já justificam um
# reinício limpo, e complicar a contabilidade para evitar isso escondia o
# problema em vez de mostrá-lo).
supervise_resolvers() {
  local tentativa=0 delay="$RESOLVERS_BACKOFF_START" code RESOLVERS_CHILD_PID=""
  # Mesmo motivo do run(): substituição de processo, não pipeline — o `$!` tem
  # que ser o PID do binário (o kill do shutdown e o wait deste laço dependem
  # dele; num pipeline seria o PID do awk).
  trap 'kill "$RESOLVERS_CHILD_PID" 2>/dev/null || true; exit 143' TERM INT
  while :; do
    /app/dist/rust/adom-resolvers > >(awk -v t='[resolvers]' '{ print t " " $0; fflush() }') 2>&1 &
    RESOLVERS_CHILD_PID=$!
    wait "$RESOLVERS_CHILD_PID"
    code=$?
    tentativa=$((tentativa + 1))
    if [ "$tentativa" -ge "$RESOLVERS_MAX_RESTARTS" ]; then
      echo "[resolvers] adom-resolvers caiu $tentativa vezes seguidas (código $code); sem mais reinícios — derrubando o container para o orquestrador recriar a stack" >&2
      # $$ no laço em segundo plano é o PID do shell PAI (não BASHPID): TERM no
      # entrypoint dispara o shutdown() — o mesmo caminho de um sinal do Docker,
      # com os quatro supervisionados encerrados em ordem.
      kill -TERM "$$" 2>/dev/null || true
      exit "$code"
    fi
    echo "[resolvers] adom-resolvers saiu com código $code; recriando em ${delay}s (morte $tentativa de $((RESOLVERS_MAX_RESTARTS - 1)))" >&2
    sleep "$delay"
    delay=$((delay * 2))
    [ "$delay" -gt "$RESOLVERS_BACKOFF_MAX" ] && delay="$RESOLVERS_BACKOFF_MAX"
  done
}

# Resolvers BR em Rust (só quando BR_RESOLVER_RUST está preenchido).
# O binário lê a env e sobe um servidor HTTP por site delegado. Com a env vazia
# (produção TS de hoje) este bloco inteiro é pulado: nenhum processo novo,
# nenhum log novo — o caminho do addon em `wait -n` fica exatamente o que era.
if [ -n "${BR_RESOLVER_RUST:-}" ]; then
    echo "[entrypoint] iniciando adom-resolvers supervisionado (BR_RESOLVER_RUST=${BR_RESOLVER_RUST})"
    supervise_resolvers &
    RESOLVERS_SUPERVISOR_PID=$!
fi

# Saída do tsc, não o fonte: a imagem de runtime recebe só `dist/` (o COPY
# --from=builder do Dockerfile), então `src/addon.js` não existe lá dentro.
run '[addon]' node dist/src/addon.js

wait -n "${pids[@]}"
code=$?
echo "[entrypoint] um processo saiu com código $code; derrubando o container" >&2
exit "$code"
