FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node --from=build /app /app
COPY companion/git-askpass.sh /usr/local/bin/conductor-git-askpass
COPY companion/container-entrypoint.sh /usr/local/bin/conductor-entrypoint
RUN chmod 0555 /usr/local/bin/conductor-git-askpass /usr/local/bin/conductor-entrypoint \
    && mkdir -p /workspace /data \
    && chown node:node /workspace /data
USER node
EXPOSE 3000 8765
ENTRYPOINT ["/usr/local/bin/conductor-entrypoint"]
CMD ["npm", "run", "start:container"]
