# Container único: addon + Jackett + FlareSolverr + Caddy na mesma imagem.
# Cada stage só empresta o binário/app; o runtime é um alpine só.
#
# A base é node:22-alpine (alpine 3.24) de propósito: é o MESMO musl da imagem
# linuxserver/jackett, então o .NET self-contained do Jackett (libcoreclr.so
# embutida) roda sem risco de incompatibilidade de libc.

FROM caddy:2-alpine AS caddy

# Pin deliberado: v0.24.2406-ls2 (build 2026-08-14). O auto-update fica
# desligado em runtime (--NoUpdates no entrypoint), então subir de versão é
# trocar este digest e rebuildar — nunca deixar o `latest` mudar o deploy
# sozinho. Depois do rebuild confira no log que as quatro definitions BR ainda
# carregam: "Loaded N Cardigann indexers" e os quatro ids na lista.
FROM lscr.io/linuxserver/jackett@sha256:6d0c43b533f91f4e88fe4b4082a2b576772072db3d90a39e58d0cccccd585f8d AS jackett

# Atualize o digest deliberadamente; nunca deixe uma mudança em `latest` alterar
# o deploy sem revisão, como já fazemos com o Jackett acima.
FROM ghcr.io/flaresolverr/flaresolverr@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47 AS flaresolverr

# --- Build: compila .ts → .js em dist/ e copia assets estáticos.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY types ./types
COPY scripts ./scripts
COPY resolvers ./resolvers
COPY bludv-resolver ./bludv-resolver
COPY comandotorrents-resolver ./comandotorrents-resolver
COPY nerdfilmes-resolver ./nerdfilmes-resolver
COPY torrentdosfilmes-resolver ./torrentdosfilmes-resolver
COPY vacatorrent-resolver ./vacatorrent-resolver
# `test/` fica de fora de propósito: está no .dockerignore e a imagem de runtime
# não roda a suíte. O `include` do tsconfig cobre test/**, mas glob que não casa
# nada é no-op para o tsc — o build sai com dist/src, dist/scripts e os assets.
RUN npm run build

# --- Runtime.
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
COPY jackett-bludv/vacatorrent.yml /app/Jackett/Definitions/vacatorrent.yml

# --- FlareSolverr: scripts são puro python; o chromedriver glibc da imagem
# oficial NÃO roda em alpine. O código checa exatamente /app/chromedriver,
# então o binário musl do apk assume esse caminho.
COPY --from=flaresolverr /app /app/flaresolverr
RUN cp /usr/bin/chromedriver /app/chromedriver \
 && python3 -m pip install --break-system-packages --no-cache-dir \
      -r /app/flaresolverr/requirements.txt

# --- Addon compilado + resolvedores BR embutidos (8700-8704, chamados pelo Jackett).
# Os resolvedores vão para DENTRO de dist/: o br-resolvers os carrega por caminho
# relativo ao próprio módulo ("../<nome>-resolver/server"), que a partir de
# dist/src/ resolve em dist/. É o mesmo layout que o npm run build produz
# localmente — fora do container isso passa despercebido porque o build já os
# copia para dist/.
COPY package.json ./
# O FlareSolverr procura package.json no diretório PAI (/app/package.json),
# que é o do addon — escrito no Windows com BOM. Python 3.14+ rejeita BOM
# no json.loads.
RUN python3 -c "p='/app/package.json';b=open(p,'rb').read();open(p,'wb').write(b[3:]if b[:3]==b'\xef\xbb\xbf'else b)"
RUN npm install --omit=dev

# Saída do tsc: dist/src/, dist/scripts/ e dist/src/public/ (assets). Sem
# dist/test: a suíte não vai para a imagem (ver o builder).
COPY --from=builder /app/dist ./dist
# Mantém o núcleo também no stage final para inspeção operacional; os shims em
# dist/ o carregam pelo layout copiado pelo build-assets.
COPY --from=builder /app/resolvers ./resolvers

COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 7000 (addon/LAN), 80/443 (Caddy). Jackett e FlareSolverr ficam em loopback,
# expostos só se o compose publicar 127.0.0.1:9117/8191.
EXPOSE 7000 80 443

# Os QUATRO serviços da stack: addon, Jackett, FlareSolverr e Caddy. A API
# administrativa do Caddy fica só no loopback e confirma processo + config sem
# acoplar o healthcheck ao desafio ACME/DNS do site público. 302 do Jackett
# (login) conta como vivo.
#
#  - a sonda do Caddy vai com `Origin` explícito: a API admin faz origin check
#    e o fetch do Node não manda o header, então sem ele a resposta é
#    403 ("client is not allowed to access from origin ''") e o container
#    inteiro cairia em unhealthy com os quatro processos vivos.
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
  CMD node -e "Promise.all([...['http://127.0.0.1:7000/manifest.json','http://127.0.0.1:9117/','http://127.0.0.1:8191/'].map(u=>fetch(u,{redirect:'manual'})),fetch('http://127.0.0.1:2019/config/',{redirect:'manual',headers:{Origin:'http://127.0.0.1:2019'}})]).then(rs=>{for(const r of rs)if(!(r.ok||r.status<400))process.exit(1)}).catch(()=>process.exit(1))"

CMD ["/app/entrypoint.sh"]
