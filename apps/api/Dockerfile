FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm --filter @localmesh/api... build
CMD ["pnpm","--filter","@localmesh/api","start"]
