FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile=false && pnpm --filter @localmesh/web... build
CMD ["pnpm","--filter","@localmesh/web","start"]
