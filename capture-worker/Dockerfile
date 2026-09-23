FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ARG CAMOUFOX_VERSION=152.0.4
ARG CAMOUFOX_RELEASE=beta.28
ARG TARGETARCH=amd64
ENV NODE_ENV=production
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-glib-1-2 unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) CAMOUFOX_ARCH=x86_64; CAMOUFOX_SHA256=924f3109ccd6d47cd6a0384d67a345fadf975d48b6319f8dbbd5954c588982bd ;; \
      arm64) CAMOUFOX_ARCH=arm64; CAMOUFOX_SHA256=3a105a2fc929e80a79b4b7fce2c93ed62c4fb2c877f3c1ed2a5d66a1c4fe968f ;; \
      *) exit 1 ;; \
    esac; \
    curl -fSL "https://github.com/daijro/camoufox/releases/download/v${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}/camoufox-${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}-lin.${CAMOUFOX_ARCH}.zip" -o /tmp/camoufox.zip; \
    printf '%s  %s\n' "$CAMOUFOX_SHA256" /tmp/camoufox.zip | sha256sum -c -; \
    mkdir -p "$CAMOUFOX_INSTALL_DIR"; \
    unzip -q /tmp/camoufox.zip -d "$CAMOUFOX_INSTALL_DIR" || [ "$?" -eq 1 ]; \
    rm /tmp/camoufox.zip; \
    printf '{"version":"%s","release":"%s"}\n' "$CAMOUFOX_VERSION" "$CAMOUFOX_RELEASE" > "$CAMOUFOX_INSTALL_DIR/version.json"; \
    chmod -R a+rX "$CAMOUFOX_INSTALL_DIR"; \
    test -x "$CAMOUFOX_INSTALL_DIR/camoufox-bin"; \
    test -f "$CAMOUFOX_INSTALL_DIR/properties.json"
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
USER pwuser
CMD ["sh", "-c", "if [ \"${CAPTURE_BROWSER_HEADLESS:-true}\" = false ]; then exec xvfb-run -a --server-args='-screen 0 1365x768x24 -nolisten tcp' node dist/index.js; else exec node dist/index.js; fi"]
