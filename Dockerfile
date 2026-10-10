# syntax=docker/dockerfile:1.28

ARG NODE_BUILDER_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:fbbdda866ea71aef98c4abece17e3d61fbf820cc2ef3961522caa2478716171a

FROM ${NODE_BUILDER_IMAGE} AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_ENV=production

WORKDIR /app

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libc6 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0t64 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libssl3t64 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    openssl \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npx patchright install chrome

COPY stealth-server.js README.md ./
RUN mkdir -p /runtime/home/nonroot/.stealth-browser/browser-contexts /runtime/tmp /runtime/var/lib/dpkg/status.d \
    && awk '/^Package: libssl3t64$/{flag=1} flag{print} /^$/{if(flag){exit}}' /var/lib/dpkg/status \
      > /runtime/var/lib/dpkg/status.d/libssl3t64

FROM ${NODE_RUNTIME_IMAGE} AS runtime

ENV NODE_ENV=production \
    HOME=/home/nonroot \
    TMPDIR=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY --from=builder /usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu
COPY --from=builder /lib/x86_64-linux-gnu /lib/x86_64-linux-gnu
COPY --from=builder /usr/share/fonts /usr/share/fonts
COPY --from=builder /usr/share/fontconfig /usr/share/fontconfig
COPY --from=builder /etc/fonts /etc/fonts
COPY --from=builder /etc/ssl/certs /etc/ssl/certs
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /opt/google/chrome /opt/google/chrome
COPY --from=builder /runtime/var/lib/dpkg/status.d/libssl3t64 /var/lib/dpkg/status.d/libssl3t64
COPY --from=builder --chown=65532:65532 /ms-playwright /ms-playwright
COPY --from=builder --chown=65532:65532 /app/node_modules /app/node_modules
COPY --from=builder --chown=65532:65532 /app/package.json /app/package.json
COPY --from=builder --chown=65532:65532 /app/package-lock.json /app/package-lock.json
COPY --from=builder --chown=65532:65532 /app/README.md /app/README.md
COPY --from=builder --chown=65532:65532 /app/stealth-server.js /app/stealth-server.js
COPY --from=builder --chown=65532:65532 /runtime/home/nonroot /home/nonroot
COPY --from=builder --chown=65532:65532 /runtime/tmp /tmp

USER 65532:65532
EXPOSE 7332
ENTRYPOINT ["/nodejs/bin/node", "/app/stealth-server.js"]
