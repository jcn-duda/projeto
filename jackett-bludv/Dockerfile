FROM lscr.io/linuxserver/jackett@sha256:e6a86a28207e6da37fb72e02d6cd157c9f69f70338128b02c5cf99dc36676594

# A definição fica na imagem para que o Jackett a encontre ao iniciar. Não monte
# /app/Jackett/Definitions como volume: isso esconderia as definições nativas.
COPY bludv-cardigann.yml /app/Jackett/Definitions/bludv-cardigann.yml
