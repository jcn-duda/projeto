FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7000

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
# Resolvedores BR: rodam no processo do addon (src/br-resolvers.js), não em
# containers próprios. Continuam ouvindo em 8700-8703 para o Jackett.
COPY bludv-resolver/server.js ./bludv-resolver/server.js
COPY comandotorrents-resolver/server.js ./comandotorrents-resolver/server.js
COPY nerdfilmes-resolver/server.js ./nerdfilmes-resolver/server.js
COPY torrentdosfilmes-resolver/server.js ./torrentdosfilmes-resolver/server.js

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7000/manifest.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/addon.js"]
