# syntax=docker/dockerfile:1.28

ARG NODE_BUILDER_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs20-debian12:nonroot@sha256:2cd820156cf039c8b54ae2d2a97e424b6729070714de8707a6b79f20d56f6a9a

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
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libssl3 \
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
    && awk '/^Package: libssl3$/{flag=1} flag{print} /^$/{if(flag){exit}}' /var/lib/dpkg/status \
      > /runtime/var/lib/dpkg/status.d/libssl3

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
COPY --from=builder /runtime/var/lib/dpkg/status.d/libssl3 /var/lib/dpkg/status.d/libssl3
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
