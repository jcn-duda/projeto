# Container único: servidor Rust + Jackett + FlareSolverr + Caddy na mesma
# imagem. Branch `rust`: sem Node — a versão TypeScript vive no branch `esm`.
# Cada stage só empresta o binário/app; o runtime é um alpine só.
#
# A base é alpine:3.24 de propósito: é o MESMO musl da imagem
# linuxserver/jackett, então o .NET self-contained do Jackett (libcoreclr.so
# embutida) roda sem risco de incompatibilidade de libc.

FROM caddy:2-alpine AS caddy

# Pin deliberado: v0.24.2748-ls45 (build 2026-10-01; antes v0.24.2531-ls19). O auto-update fica
# desligado em runtime (--NoUpdates no entrypoint), então subir de versão é
# trocar este digest e rebuildar — nunca deixar o `latest` mudar o deploy
# sozinho. Depois do rebuild confira no log que as definitions BR ainda
# carregam: "Loaded N Cardigann indexers" e os ids na lista
# (bludv-cardigann, comandotorrents, nerdfilmes, torrentdosfilmesv2, vacatorrent,
# redetorrent-cardigann, apachetorrent-cardigann).
FROM lscr.io/linuxserver/jackett@sha256:099e895abbeb4564f8c5cb5f2def66462d73dffa39728a1a106af79ff1b04e65 AS jackett

# Atualize o digest deliberadamente; nunca deixe uma mudança em `latest` alterar
# o deploy sem revisão, como já fazemos com o Jackett acima. Pin: v3.5.2
# (2026-09-12; antes v3.5.0).
FROM ghcr.io/flaresolverr/flaresolverr@sha256:c80ae007ce2ccdcd217a12426e4f039ef763ff90738c808d38810c3e59323767 AS flaresolverr

# --- Binários Rust (estáticos, musl). Mesma toolchain do rust/rust-toolchain.toml
# (1.92.0); o arquivo não é copiado porque os componentes clippy/rustfmt dele
# fariam o rustup baixar o que o build não usa.
FROM rust:1.92.0-alpine AS rust
RUN apk add --no-cache musl-dev
WORKDIR /rust
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/crates ./crates
RUN cargo build --locked --release --bin adom-sidecar --bin adom-resolvers --bin adom-server \
 && mkdir /out \
 && cp target/release/adom-sidecar target/release/adom-resolvers target/release/adom-server /out/

# --- Runtime.
FROM alpine:3.24

WORKDIR /app
ENV HOST=0.0.0.0
ENV PORT=7000

# bash: o supervisor usa `wait -n`, que o busybox ash não tem (o awk dos
# prefixos de log é o do próprio busybox, já na base).
# icu-libs/icu-data-full/libstdc++/zlib: runtime .NET self-contained do Jackett.
# python3/py3-pip: FlareSolverr (deps puras-python instaladas abaixo).
# chromium/chromium-chromedriver: desafios Cloudflare (musl, não o binário glibc da imagem oficial).
# xvfb: o FlareSolverr roda o Chrome head-FULL num display virtual, igual à imagem oficial.
# tzdata: honra o TZ do compose.
RUN apk add --no-cache bash tzdata icu-libs icu-data-full libstdc++ zlib \
      python3 py3-pip chromium chromium-chromedriver xvfb

# --- Caddy: binário estático, nada mais a copiar.
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy

# --- Jackett: deploy self-contained + definitions Cardigann BR.
# As definitions vêm da imagem (não monte /config em cima delas): o volume
# /config carrega só o estado (ServerConfig.json, Indexers/).
COPY --from=jackett /app/Jackett /app/Jackett
# Sobrescreve só a definição: os headers evitam o 403 sem migrar o card no volume.
COPY jackett-bludv/therarbg.yml /app/Jackett/Definitions/therarbg.yml
COPY jackett-bludv/bludv-cardigann.yml /app/Jackett/Definitions/bludv-cardigann.yml
COPY jackett-bludv/comandotorrents.yml /app/Jackett/Definitions/comandotorrents.yml
COPY jackett-bludv/nerdfilmes.yml /app/Jackett/Definitions/nerdfilmes.yml
COPY jackett-bludv/torrentdosfilmesv2.yml /app/Jackett/Definitions/torrentdosfilmesv2.yml
COPY jackett-bludv/vacatorrent.yml /app/Jackett/Definitions/vacatorrent.yml
COPY jackett-bludv/redetorrent-cardigann.yml /app/Jackett/Definitions/redetorrent-cardigann.yml
COPY jackett-bludv/apachetorrent-cardigann.yml /app/Jackett/Definitions/apachetorrent-cardigann.yml
COPY jackett-bludv/hdrtorrent-cardigann.yml /app/Jackett/Definitions/hdrtorrent-cardigann.yml

# --- FlareSolverr: scripts são puro python; o chromedriver glibc da imagem
# oficial NÃO roda em alpine. O código checa exatamente /app/chromedriver,
# então o binário musl do apk assume esse caminho.
COPY --from=flaresolverr /app /app/flaresolverr
RUN cp /usr/bin/chromedriver /app/chromedriver \
 && python3 -m pip install --break-system-packages --no-cache-dir \
      -r /app/flaresolverr/requirements.txt
# O FlareSolverr lê a própria versão de /app/package.json (diretório pai).
RUN echo '{"name":"flaresolverr","version":"3.5.2"}' > /app/package.json

# --- Servidor, resolvers BR (8700-8707, chamados pelo Jackett) e raspador.
COPY --from=rust /out/ /app/bin/
# Páginas estáticas (configuração e painel) para as rotas que o servidor portar.
COPY web/public /app/web/public

COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 7000 (servidor/LAN), 80/443 (Caddy). Jackett e FlareSolverr ficam em loopback,
# expostos só se o compose publicar 127.0.0.1:9117/8191.
EXPOSE 7000 80 443

# Os QUATRO serviços: servidor, Jackett, FlareSolverr e Caddy. A API admin do
# Caddy exige `Origin` explícito (sem ele responde 403 e o container cairia em
# unhealthy com tudo vivo). 301/302 do Jackett (login) conta como vivo: o
# busybox wget se perde no redirect dele, então vale o primeiro status. O
# HEALTHCHECK não reinicia nada — quem age é o `wait -n` do entrypoint; isto é
# sinal para `docker ps`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:7000/health \
   && wget -S -O /dev/null http://127.0.0.1:9117/ 2>&1 | grep -q "HTTP/1.1 [23]" \
   && wget -q -O /dev/null http://127.0.0.1:8191/ \
   && wget -q -O /dev/null --header "Origin: http://127.0.0.1:2019" http://127.0.0.1:2019/config/

CMD ["/app/entrypoint.sh"]
