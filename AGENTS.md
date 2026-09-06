# Repository Guidelines

## Project Structure & Module Organization

LocalMesh Sensei is a pnpm TypeScript monorepo. Runtime applications live under `apps/`: `api` receives GitHub webhooks, `worker` runs PostgreSQL validation jobs, and `web` provides the Next.js dashboard. Reusable logic belongs under `packages/`: `engine`, `inspector`, `contracts`, `github`, `db`, and `shared`. Keep cross-package types in `packages/shared` and avoid importing directly between application folders.

Benchmarks are defined in `benchmarks/`. Docker-backed examples and sample migrations live in `examples/demo/`. Tests are colocated with source as `*.test.ts`; Docker tests use `*.integration.test.ts`.

## Build, Test, and Development Commands

- `pnpm install` installs all workspace dependencies. Use Node.js 22 or newer.
- `pnpm dev` starts the API, worker, and dashboard concurrently.
- `pnpm typecheck` checks every workspace with strict TypeScript settings.
- `pnpm test:unit` runs the focused Vitest suite.
- `RUN_DOCKER_TESTS=1 pnpm test:integration` runs PostgreSQL container tests.
- `pnpm build` creates production builds for all applications and packages.
- `pnpm benchmark` executes the 20-conflict/20-safe benchmark corpus; Docker is required.
- `docker compose up --build` launches the complete local stack.

## Coding Style & Naming Conventions

Use TypeScript ESM, two-space indentation, semicolons, and double quotes. Prefer small typed functions and validate external input with Zod. Use `camelCase` for values/functions, `PascalCase` for types/classes/components, and kebab-case for package or configuration names. Migration files follow `NNN_description.up.sql` and `NNN_description.down.sql`.

No formatter or standalone linter is configured; preserve nearby style and run `pnpm typecheck` before submitting changes.

## Testing Guidelines

Use Vitest and keep tests deterministic. Add unit coverage for parsing, filtering, contract, and formatting logic. Changes to PostgreSQL execution or rollback behavior require an integration test guarded by `RUN_DOCKER_TESTS=1`. Extend `benchmarks/cases.ts` when introducing a new collision class. AI output must never determine test pass/fail.

## Commit & Pull Request Guidelines

Use Conventional Commits in the form `<type>(<scope>): <imperative summary>`, for example `feat(engine): detect enum collisions` or `fix(worker): cancel stale checks`. Approved types are `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, and `perf`. Use a workspace or subsystem as the scope (`api`, `worker`, `web`, `engine`, `contracts`, or `repo`). Keep the subject under 72 characters, make each commit one coherent change, and add a body when the motivation is not obvious. Breaking changes require a `!` and a `BREAKING CHANGE:` footer.

Pull requests should explain behavior changes, link relevant issues, list verification commands, and include dashboard screenshots for UI changes. Document configuration or permission changes and never commit `.env`, GitHub keys, tokens, production records, generated `dist/`, or `.next/` output.
