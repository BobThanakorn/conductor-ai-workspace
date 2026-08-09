# Node.js 22.17.1 bookworm-slim, pinned to the manifest digest resolved for P6-T1.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN node scripts/source-digest.mjs /app > /app/.conductor-source-digest \
    && npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260701T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260701T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260701T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
      ca-certificates=20230311+deb12u1 \
      git=1:2.39.5-0+deb12u3 \
      python3=3.11.2-1+b1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node --from=build /app /app
COPY companion/git-askpass.sh /usr/local/bin/conductor-git-askpass
COPY companion/container-entrypoint.sh /usr/local/bin/conductor-entrypoint
RUN chmod 0555 /usr/local/bin/conductor-git-askpass /usr/local/bin/conductor-entrypoint \
    && mkdir -p /workspace /data \
    && chown node:node /workspace /data
USER node
LABEL org.opencontainers.image.title="conductor-ai-workspace" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.base.name="node:22-bookworm-slim"
EXPOSE 3000 8765
ENTRYPOINT ["/usr/local/bin/conductor-entrypoint"]
CMD ["npm", "run", "start:container"]
