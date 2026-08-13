#!/usr/bin/env bash
# Prepara e sobe a stack numa VPS. Rode DENTRO do diretório do projeto, no
# servidor. É idempotente: preserva credenciais e segredos de um .env existente,
# mas reaplica os endereços seguros exigidos pela VPS.
#
#   bash scripts/deploy-setup.sh powermovie.net
#
# O que ele NÃO faz: preencher suas credenciais. JACKETT_API_KEY,
# DEBRID_API_KEY e TMDB_API_KEY você cola no .env — o script para e avisa.
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "uso: bash scripts/deploy-setup.sh <dominio>     (ex: powermovie.net)" >&2
  exit 1
fi

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m   %s\033[0m\n' "$*"; }
ok() { printf '\033[32m   ok  %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- pré-checagem
say "DNS"
# O Caddy pede certificado no primeiro boot. Sem o A resolvendo, o desafio ACME
# falha e a stack sobe sem HTTPS — e ainda gasta a cota de erro do Let's Encrypt.
resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [ -z "$resolved" ]; then
  warn "$DOMAIN não resolve ainda."
  warn "Aponte o A de $DOMAIN (e www) para o IP desta VPS e espere propagar."
  warn "Subir agora deixa a stack sem certificado."
  read -r -p "   seguir mesmo assim? [s/N] " go
  [ "${go:-n}" = "s" ] || exit 1
else
  ok "$DOMAIN -> $resolved"
  myip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "$myip" ] && [ "$myip" != "$resolved" ]; then
    warn "o IP público desta máquina é $myip, e o DNS aponta para $resolved."
    warn "se não forem a mesma VPS, o ACME vai falhar."
  fi
fi

say "Docker"
command -v docker >/dev/null || { echo "docker não encontrado" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 não encontrado" >&2; exit 1; }
ok "$(docker --version)"

# --------------------------------------------------------------------- .env
say ".env"
set_kv() {
  if grep -q "^$1=" .env; then
    # `|` como delimitador porque os valores têm barra (https://)
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

ensure_secret() {
  current="$(grep -E "^$1=" .env | cut -d= -f2- || true)"
  [ -n "$current" ] || set_kv "$1" "$(openssl rand -hex "$2")"
}

if [ -f .env ]; then
  ok ".env já existe — credenciais e segredos preservados"
else
  cp .env.example .env
  ok ".env criado a partir do exemplo"
fi

# Estes endereços não podem herdar os defaults domésticos: expor a porta 7000
# na VPS deixa a configuração (e a chave do debrid) trafegar sem TLS.
set_kv ADDON_DOMAIN "$DOMAIN, www.$DOMAIN"
set_kv PUBLIC_URL "https://$DOMAIN"
set_kv BIND_ADDR 127.0.0.1
ensure_secret RESOLVE_SECRET 32
ensure_secret POSTGRES_PASSWORD 24

# ------------------------------------------------------- credenciais que faltam
say "Credenciais"
faltando=()
for k in JACKETT_API_KEY DEBRID_API_KEY TMDB_API_KEY; do
  v="$(grep -E "^$k=" .env | cut -d= -f2- || true)"
  [ -n "$v" ] && ok "$k preenchida" || faltando+=("$k")
done
if [ ${#faltando[@]} -gt 0 ]; then
  warn "faltam no .env: ${faltando[*]}"
  warn "edite e rode este script de novo:   nano .env"
  exit 1
fi

# -------------------------------------------------- migração do volume Jackett
JCFG=docker-data/jackett/Jackett/ServerConfig.json
if [ -f "$JCFG" ] && grep -q 'flaresolverr:8191' "$JCFG"; then
  say "Migração"
  # Volume vindo do compose multi-container: o hostname não existe mais.
  sed -i 's#http://flaresolverr:8191#http://127.0.0.1:8191#' "$JCFG"
  ok "FlareSolverr reapontado para 127.0.0.1 no ServerConfig.json"
fi

# --------------------------------------------------------------------- subir
say "Subindo"
docker compose up -d --build

say "Aguardando"
# O Jackett carrega ~621 indexadores; buscar antes disso volta vazio, e o vazio
# fica 60s no cache. Melhor esperar o healthcheck do que testar cedo demais.
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' stremio-adom 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 5
done
[ "$status" = "healthy" ] && ok "stack healthy" || warn "ainda $status — veja: docker compose logs -f adom"

say "Pronto"
cat <<EOF
   Configure e instale:   https://$DOMAIN/configure
   Validar:               npm run smoke https://$DOMAIN
   Logs:                  docker compose logs -f adom

   Antes de divulgar o link: /configure e /defaults.json são PÚBLICOS.
   Para fechar, descomente o basic_auth no Caddyfile:
     docker exec stremio-adom caddy hash-password --plaintext 'suasenha'
EOF
