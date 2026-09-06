FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm --filter @localmesh/worker... build
CMD ["pnpm","--filter","@localmesh/worker","start"]
