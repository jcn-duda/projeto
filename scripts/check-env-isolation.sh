#!/bin/sh
# Sonda do ambiente herdado pelos FILHOS do entrypoint do container único.
#
# O container sobe Caddy -> Jackett -> FlareSolverr (Chromium) -> resolvers ->
# gateway -> Node a partir do MESMO `scripts/entrypoint.sh`, que herda o
# ambiente do container inteiro (`.env` via `env_file` do compose). Quem não
# precisa de segredo não pode carregar segredo: um browser headless navegando
# site de terceiro é o pior lugar para ter o token que autoriza as rotas
# administrativas e o disparo das varreduras destrutivas.
#
# Esta sonda lê `/proc/<pid>/environ` de cada família de processo e compara os
# NOMES das variáveis com a allowlist de `flaresolverr_env()`/`caddy_env()`/
# `jackett_env()` do entrypoint. NUNCA imprime valor: só nome, contagem e
# booleano.
#
# Uso (roda DENTRO do container; nada muda na imagem):
#   docker cp scripts/check-env-isolation.sh stremio-adom:/tmp/check-env-isolation.sh
#   docker exec stremio-adom sh /tmp/check-env-isolation.sh
#
#   Linux/macOS também aceita pipe, sem copiar arquivo:
#   docker exec -i stremio-adom sh -s < scripts/check-env-isolation.sh
#
#   (Evite `Get-Content | docker exec` no PowerShell 5.1: a pipeline converte
#   para a code page do console e os acentos chegam quebrados. `docker cp`
#   preserva os bytes.)
#
# Para provar TAMBÉM o Chromium (e não só o python), force uma sessão antes:
#   docker exec stremio-adom sh -c 'curl -s -m 90 -XPOST http://127.0.0.1:8191/v1 \
#     -H "Content-Type: application/json" \
#     -d "{\"cmd\":\"request.get\",\"url\":\"https://example.com\",\"maxTimeout\":60000}"'
#   docker exec stremio-adom sh /tmp/check-env-isolation.sh
#
# `--report` só relata (sempre exit 0) — é o modo para medir ANTES do rebuild.
# Sem argumento é ASSERTIVO: falha (exit 1) se um processo isolado carregar
# nome fora da allowlist ou nome com cara de segredo (TOKEN/KEY/SECRET/...).
#
# POSIX/busybox: sem arrays, sem `--`, sem `bash`ismo. `tr`/`cut` são applets.

REPORT=0
BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --report) REPORT=1 ;;
    --browser) BROWSER=1 ;;
  esac
done

# Abre uma SESSÃO do FlareSolverr para o Chromium ficar de pé durante a medição.
# Sem isso o probe mede só o python (o browser sobe e morre a cada request) — e
# o browser é o ALVO do achado. `node` está na imagem (é o runtime do addon).
FLARE_SESSION=""
if [ "$BROWSER" = "1" ]; then
  FLARE_SESSION=$(node -e 'fetch("http://127.0.0.1:8191/v1",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cmd:"sessions.create"})}).then(r=>r.json()).then(b=>console.log(b.session||"")).catch(()=>console.log(""))' 2>/dev/null)
  if [ -n "$FLARE_SESSION" ]; then
    echo "sessão FlareSolverr aberta: o Chromium está de pé para a medição"
  else
    echo "aviso: não consegui abrir sessão no FlareSolverr; medindo só o python"
  fi
fi

# Nomes que identificam segredo pelo formato. Usado como segunda camada: mesmo
# que alguém acrescente uma variável à allowlist por engano, o nome grita.
# Exceção única: PROXY_PASSWORD é a credencial DO BROWSER (o solver a usa para
# autenticar no proxy); ela não nasce no `.env` do addon e não autoriza rota
# administrativa nenhuma.
is_secret_name() {
  case "$1" in
    PROXY_PASSWORD) return 1 ;;
    *TOKEN*|*KEY*|*SECRET*|*PASSWORD*|*CREDENTIAL*) return 0 ;;
    *) return 1 ;;
  esac
}

# Allowlists — têm que espelhar os `set --` das funções do entrypoint.
# caddy: o Caddyfile interpola {$ADDON_DOMAIN}; os XDG são o volume do ACME.
caddy_allowed=" PATH HOME TZ ADDON_DOMAIN XDG_CONFIG_HOME XDG_DATA_HOME "
# jackett: estado no volume (/config), temp fora do /config, sem auto-update.
jackett_allowed=" PATH HOME TZ XDG_CONFIG_HOME XDG_DATA_HOME TMPDIR AUTO_UPDATE "
# flaresolverr: PORT fixo (o .env define 7000 pro addon), resto é knob do
# solver. LANG entra no --accept-lang do Chromium (utils.py do FlareSolverr).
#
# Os últimos NÃO vêm do container: o próprio FlareSolverr os põe em
# `os.environ` depois de nascer — REQUESTS_CA_BUNDLE/SSL_CERT_FILE apontam para
# o certifi (`flaresolverr.py`, para o SSL das bins compiladas) e DISPLAY é o
# display do Xvfb aberto no modo headless (`utils.py` -> start_xvfb_display).
#
# CHROME_*/DBUS_SESSION_BUS_ADDRESS/PWD/SHLVL/log-level vêm do launcher do
# Chromium (/usr/bin/chromium é script) e do próprio browser para os filhos —
# medido: 11 processos chromium/chromedriver, 60 nomes, ZERO com cara de
# segredo. Valor nenhum deles é segredo; a lista existe para o probe não gritar
# com o que o processo criou sozinho.
flare_allowed=" PATH HOME TZ PORT HOST LOG_LEVEL LANG LOG_HTML HEADLESS DISABLE_MEDIA BROWSER_WAIT_TIMEOUT LOG_FILE PROXY_URL PROXY_USERNAME PROXY_PASSWORD REQUESTS_CA_BUNDLE SSL_CERT_FILE DISPLAY CHROME_DESKTOP CHROME_WRAPPER CHROME_VERSION_EXTRA DBUS_SESSION_BUS_ADDRESS PWD SHLVL log-level "
# resolvers: só knobs de resolver (nenhum segredo é usado pelo binário).
resolvers_allowed=" PATH HOME TZ BR_RESOLVER_RUST BR_RESOLVERS_HOST RESOLVER_EXTRA_PROTECTORS FLARE_WARM_INTERVAL_MS FLARE_WARM_IDLE_MS BLUDV_GATE_MIN_WAIT_MS BLUDV_URL BLUDV_URLS COMANDOTORRENTS_URL COMANDOTORRENTS_URLS NERDFILMES_URL NERDFILMES_URLS TORRENTDOSFILMES_URL TORRENTDOSFILMES_URLS VACATORRENT_URL VACATORRENT_URLS REDETORRENT_URL REDETORRENT_URLS APACHETORRENT_URL APACHETORRENT_URLS HDRTORRENTS_URL HDRTORRENTS_URLS TORRENTGALAXY_URL TORRENTGALAXY_URLS "

in_list() {
  # $1 = nome, $2 = lista cercada por espaço
  case "$2" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

fails=0
checked=0

# check_family <rótulo> <padrão do cmdline> <allowlist> <isolado:0|1>
# - casa o cmdline contra o padrão (`case`, sem regex)
# - conta nomes fora da allowlist e nomes com cara de segredo
check_family() {
  label="$1"; pattern="$2"; allowed="$3"; isolated="$4"
  pids=0; env_total=0; outside=""; secrets=""
  for d in /proc/[0-9]*; do
    [ -r "$d/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
    [ -n "$cmd" ] || continue
    case "$cmd" in
      $pattern) ;;
      *) continue ;;
    esac
    pid=${d#/proc/}
    names=$(tr '\0' '\n' < "$d/environ" 2>/dev/null | cut -d= -f1)
    [ -n "$names" ] || continue
    pids=$((pids + 1))
    for name in $names; do
      env_total=$((env_total + 1))
      in_list "$name" "$allowed" || outside="$outside $name"
      if is_secret_name "$name"; then secrets="$secrets $name"; fi
    done
  done

  n_outside=$(printf '%s\n' $outside | grep -c . 2>/dev/null || true)
  [ -n "$outside" ] || n_outside=0
  n_secrets=$(printf '%s\n' $secrets | grep -c . 2>/dev/null || true)
  [ -n "$secrets" ] || n_secrets=0

  if [ "$pids" -eq 0 ]; then
    echo "pula $label: nenhum processo ativo com cmdline '$pattern'"
    return 0
  fi

  checked=$((checked + 1))
  if [ "$n_outside" -eq 0 ] && [ "$n_secrets" -eq 0 ]; then
    echo "ok   $label: $pids proc(s), $env_total variáveis, todas na allowlist"
    return 0
  fi

  if [ "$isolated" = "1" ] && [ "$REPORT" = "0" ]; then
    fails=$((fails + 1))
    echo "FALHA $label: $pids proc(s), $env_total variáveis, $n_outside fora da allowlist, $n_secrets com cara de segredo"
  else
    echo "nota  $label: $pids proc(s), $env_total variáveis, $n_outside fora da allowlist, $n_secrets com cara de segredo"
  fi
  # Só NOMES. Valor de segredo não sai daqui em nenhum modo. A lista nominal
  # só sai para família que REPROVA (isolated=1): no controle positivo (gateway/
  # node/sidecar) ela é ruído — esses carregam o `.env` inteiro de propósito.
  if [ "$isolated" = "1" ] && [ -n "$outside" ]; then
    echo "      fora da allowlist:$outside"
  fi
  return 0
}

# Famílias isoladas (allowlist fechada, sem segredo por construção).
check_family "flaresolverr" '*flaresolverr.py*' "$flare_allowed" 1
# chromedriver + Chromium no mesmo padrão de propósito: o Chromium é filho do
# chromedriver, que é filho do python — se um vaza, os três vazam. Famílias
# separadas aqui só contariam o mesmo vazamento duas vezes.
check_family "chromedriver+chromium" '*chrom*' "$flare_allowed" 1
check_family "caddy" '*caddy run*' "$caddy_allowed" 1
check_family "jackett" '*/app/Jackett/jackett*' "$jackett_allowed" 1
# resolvers: NÃO isolado de propósito (ver `resolvers_env` no entrypoint — não
# existe: eles leem `<SITE>_URL`/`<SITE>_URLS` por site e uma allowlist perderia
# espelho do operador em silêncio). A lista acima mede o que faltaria isolá-los;
# por isso `isolated=0`: mede e relata, não reprova.
check_family "resolvers(herdado-de-proposito)" '*adom-resolvers*' "$resolvers_allowed" 0

# Controle POSITIVO: quem PRECISA do token tem que continuar com ele. Sem isso
# a sonda passaria com o container quebrado (token sumido de todo mundo).
check_family "gateway(esperado-com-token)" '*adom-server*' "" 0
check_family "node(esperado-com-token)" '*dist/src/addon.js*' "" 0
check_family "sidecar(esperado-com-token)" '*adom-sidecar*' "" 0

# Presença (booleano) dos segredos que a auditoria apontou, nas famílias que
# devem continuar sem eles. Nome + contagem, nunca valor.
for d in /proc/[0-9]*; do
  [ -r "$d/cmdline" ] || continue
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  case "$cmd" in
    *flaresolverr.py*|*chromedriver*|*chrom*|*caddy\ run*|*/app/Jackett/jackett*)
      pid=${d#/proc/}
      names=$(tr '\0' '\n' < "$d/environ" 2>/dev/null | cut -d= -f1)
      hits=$(printf '%s\n' $names | grep -cE '^(JACKETT_TEST_TOKEN|STREAM_STORE_ADMIN_TOKEN|DEBRID_INTERNAL_TOKEN|DEBRID_API_KEY|RD_LIVE_KEY|RESOLVE_SECRET|TMDB_API_KEY|RAPIDAPI_KEY)$' 2>/dev/null || true)
      [ -n "$hits" ] || hits=0
      if [ "$hits" -gt 0 ]; then
        # Mesmo vocabulário de `check_family`: --report só mede (nota), o modo
        # assertivo reprova. Senão o modo --report diria "nada reprovado" e
        # imprimiria FALHA na linha de cima.
        if [ "$REPORT" = "1" ]; then
          echo "nota  segredo visível em pid $pid ($(echo "$cmd" | cut -c1-40)): $hits de 8 nomes-sonda"
        else
          fails=$((fails + 1))
          echo "FALHA segredo visível em pid $pid ($(echo "$cmd" | cut -c1-40)): $hits de 8 nomes-sonda"
        fi
      fi
      ;;
  esac
done

# Fecha a sessão aberta por --browser (o Chromium morre junto). Tem que rodar em
# TODO caminho de saída: se o probe reprovar ou for --report, deixar a sessão
# aberta manteria um Chromium de pé no container até o próximo restart.
close_session() {
  [ -n "$FLARE_SESSION" ] || return 0
  node -e "fetch('http://127.0.0.1:8191/v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cmd:'sessions.destroy',session:'$FLARE_SESSION'})}).catch(()=>{})" >/dev/null 2>&1 || true
  echo "sessão FlareSolverr encerrada"
  FLARE_SESSION=""
}

if [ "$REPORT" = "1" ]; then
  close_session
  echo "relatório: $checked família(s) medida(s); nada foi reprovado (modo --report)"
  exit 0
fi
if [ "$fails" -gt 0 ]; then
  close_session
  echo "$fails problema(s) de isolamento de ambiente"
  exit 1
fi
close_session
echo "isolamento de ambiente ok ($checked família(s) na allowlist)"
exit 0
