# Imagem da aplicação (Bun 1.x como runtime, package manager e test runner).
FROM oven/bun:1

WORKDIR /app

# Dependências primeiro (cache de layer).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Código + migrations.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

# Compila o TypeScript (strict) para dist/.
RUN bun run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# O health check do compose usa /health/ready.
CMD ["bun", "dist/main.js"]
