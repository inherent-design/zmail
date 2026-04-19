FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV RUN_WORKER=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["pnpm", "exec", "tsx", "server/index.tsx"]
