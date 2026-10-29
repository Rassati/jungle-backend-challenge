FROM oven/bun:1.3.1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
ENV HOST=0.0.0.0
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
