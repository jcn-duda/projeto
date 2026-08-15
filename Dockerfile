# Container único: addon + Jackett + FlareSolverr + Caddy na mesma imagem.
# Cada stage só empresta o binário/app; o runtime é um alpine só.
#
# A base é node:22-alpine (alpine 3.24) de propósito: é o MESMO musl da imagem
# linuxserver/jackett, então o .NET self-contained do Jackett (libcoreclr.so
# embutida) roda sem risco de incompatibilidade de libc.

FROM caddy:2-alpine AS caddy

# Mesmo pin de sha256 do antigo jackett-bludv/Dockerfile.
FROM lscr.io/linuxserver/jackett@sha256:bdde094b662158f3fd93d640dcf30f20e901cfc0b9a47ff3c338b9400cd6b5d7 AS jackett

# Atualize o digest deliberadamente; nunca deixe uma mudança em `latest` alterar
# o deploy sem revisão, como já fazemos com o Jackett acima.
FROM ghcr.io/flaresolverr/flaresolverr@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47 AS flaresolverr

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
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
COPY jackett-bludv/bludv-cardigann.yml /app/Jackett/Definitions/bludv-cardigann.yml
COPY jackett-bludv/comandotorrents.yml /app/Jackett/Definitions/comandotorrents.yml
COPY jackett-bludv/nerdfilmes.yml /app/Jackett/Definitions/nerdfilmes.yml
COPY jackett-bludv/torrentdosfilmesv2.yml /app/Jackett/Definitions/torrentdosfilmesv2.yml

# --- FlareSolverr: scripts são puro python; o chromedriver glibc da imagem
# oficial NÃO roda em alpine. O código checa exatamente /app/chromedriver,
# então o binário musl do apk assume esse caminho.
COPY --from=flaresolverr /app /app/flaresolverr
RUN cp /usr/bin/chromedriver /app/chromedriver \
 && python3 -m pip install --break-system-packages --no-cache-dir \
      -r /app/flaresolverr/requirements.txt

# --- Addon + resolvedores BR embutidos (8700-8703, chamados pelo Jackett).
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY bludv-resolver/server.js ./bludv-resolver/server.js
COPY comandotorrents-resolver/server.js ./comandotorrents-resolver/server.js
COPY nerdfilmes-resolver/server.js ./nerdfilmes-resolver/server.js
COPY torrentdosfilmes-resolver/server.js ./torrentdosfilmes-resolver/server.js

COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 7000 (addon/LAN), 80/443 (Caddy). Jackett e FlareSolverr ficam em loopback,
# expostos só se o compose publicar 127.0.0.1:9117/8191.
EXPOSE 7000 80 443

# Os TRÊS serviços que a busca precisa: addon, Jackett e FlareSolverr — senão
# container "healthy" com um deles morto passa despercebido e a busca degrada em
# silêncio. 302 do Jackett (login) conta como vivo.
#
# Escopo, pra não confiar demais nisto:
#  - o HEALTHCHECK sozinho NÃO reinicia nada aqui. `restart: unless-stopped`
#    reage à saída do container, não ao status unhealthy (só o Swarm reage a
#    ele). Quem age é o `wait -n` do entrypoint, que derruba tudo quando um
#    processo morre. Isto é sinal para `docker ps`/log, não recuperação.
#  - o GET / do FlareSolverr responde do próprio processo, sem abrir o
#    Chromium: pega processo morto ou porta fechada, NÃO pega Chromium travado
#    no meio de um desafio. Cobrir isso exigiria um request.get real a cada
#    30s — caro e falso-positivo fácil.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "Promise.all(['http://127.0.0.1:7000/manifest.json','http://127.0.0.1:9117/','http://127.0.0.1:8191/'].map(u=>fetch(u,{redirect:'manual'}))).then(rs=>{for(const r of rs)if(!(r.ok||r.status<400))process.exit(1)}).catch(()=>process.exit(1))"

CMD ["/app/entrypoint.sh"]
