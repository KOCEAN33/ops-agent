FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-distroless
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
# The chart runs every container as git-sync's user, with a read-only root
# filesystem and a writable /tmp.
USER 65533:65533
ENV HOME=/tmp
EXPOSE 8080
CMD ["src/server.ts"]
