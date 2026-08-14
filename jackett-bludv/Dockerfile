FROM lscr.io/linuxserver/jackett@sha256:bdde094b662158f3fd93d640dcf30f20e901cfc0b9a47ff3c338b9400cd6b5d7

# A definição fica na imagem para que o Jackett a encontre ao iniciar. Não monte
# /app/Jackett/Definitions como volume: isso esconderia as definições nativas.
COPY bludv-cardigann.yml /app/Jackett/Definitions/bludv-cardigann.yml
COPY comandotorrents.yml /app/Jackett/Definitions/comandotorrents.yml
COPY nerdfilmes.yml /app/Jackett/Definitions/nerdfilmes.yml
COPY torrentdosfilmesv2.yml /app/Jackett/Definitions/torrentdosfilmesv2.yml
