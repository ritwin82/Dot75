# Dot75

Dot75 is a self-hosted PostgreSQL migration-safety platform. GitHub is the decision surface: one required **`Dot75 / Migration Compatibility`** Check and one bot-owned sticky PR comment carry the deterministic verdict. The local web app is the authenticated investigation and contract-configuration workbench. `localmesh` is the portable engine CLI used by every delivery path.

AI is optional. When Ollama is available it explains verified failures and proposes safer SQL, but it never decides whether a check passes.

## Automatic checks and reproducible evidence

LocalMesh now supports a thin GitHub Action as an alternative to the webhook service. It discovers other open migration PRs by immutable SHA, invokes the same validation engine through a portable JSON CLI, and publishes detailed Checks and a sticky PR comment. Default-branch pushes refresh open migration PRs without comment notifications; merge queues validate the full cumulative group.

Start with the [architecture, Action setup, reporting guide, and prioritized roadmap](docs/architecture-and-action.md). Copy the [analysis workflow](examples/github-actions/localmesh-analysis.yml) and [publication workflow](examples/github-actions/localmesh-publication.yml) into a consuming repository and configure a reviewed tool SHA. They are templates and are not enabled automatically in this checkout.

The Action route needs no webhook server, GitHub App key, service database, or inbound port. Its sample uses isolated analysis and a separate publisher. A local runner can use the same route, provided its isolation is appropriate for every PR it might analyze, including other open fork PRs.

Replay a saved input without GitHub access:

```bash
pnpm --filter @localmesh/worker... build
pnpm localmesh validate --input input-41.json --output result-41.json
```

Every new result carries the exact tested revisions, coverage decisions, and a SHA-256 input receipt. AI remains optional and cannot change the verdict.

## What ships

- Rebuilds the target branch in the configured PostgreSQL 14–17 image.
- Discovers migration changes in the current and other open pull requests.
- Diffs PostgreSQL catalogs and builds dependency-aware change sets.
- Skips unrelated PRs, executes related pairs in both orders, and runs bounded three-PR permutations with explicit untested coverage.
- Detects SQL failures and order-dependent final schema or fixture-data state.
- Validates templates and custom schema/SQL contracts from the trusted base revision.
- Tests paired `.up.sql` and `.down.sql` files and reports unsafe or missing rollbacks.
- Warns about blocking indexes, eager constraint validation, and likely rewrites.
- Publishes the required `Dot75 / Migration Compatibility` Check and exactly one bot-owned sticky comment.
- Provides authenticated compatibility maps, recurrence fingerprints, rollback evidence, portable exports, SSE progress, a reviewed config-PR editor, and a verified local remediation lab.
- Supports raw SQL, Prisma, Drizzle, Flyway, and Liquibase formatted SQL discovery. Rails, Django, and Alembic are registered as code-driven adapters and fail closed until isolated project-container execution is enabled.

## Architecture

| Component | Responsibility |
|---|---|
| `apps/action` | GitHub Action discovery, CLI invocation, provenance-checked publication |
| `apps/api` | Signed GitHub webhooks, OAuth, authorized investigation API, migrations, durable queues |
| `apps/worker` | GitHub revision loading, PostgreSQL containers, validation orchestration |
| `apps/web` | Investigation, recurrence, rollback, contracts, exports, remediation |
| `packages/inspector` | Normalized PostgreSQL catalog snapshots and dependency edges |
| `packages/engine` | Candidate filtering, execution orders, rollback and performance analysis |
| `packages/contracts` | Six contract templates, mappings, fixtures, suggestions |
| `packages/github` | GitHub App authentication, repository reads, Checks formatting |

The service metadata is stored in PostgreSQL and jobs are delivered through `pg-boss`. Each validation job receives an ephemeral PostgreSQL container. Repository contents are read using short-lived GitHub App installation credentials; no production records are copied.

## Webhook service prerequisites

- Node.js 22 or newer and pnpm 10 or newer.
- Docker Engine with permission to start sibling PostgreSQL containers.
- A private GitHub App.
- Optional: Ollama and `qwen2.5-coder:7b`.
- For a service running on a developer machine, an HTTPS webhook endpoint such as Cloudflare Tunnel.

## Webhook service setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Copy `.env.example` to `.env`. Configure the GitHub App, GitHub OAuth app, a random `SESSION_SECRET`, and `DOT75_DELIVERY_MODE=app`. Multiline private keys may use literal newlines or escaped `\n` sequences.

3. Create a private GitHub App using `.github/localmesh-app-manifest.example.json`. Grant only:

   - Contents: read
   - Pull requests: write (read PR metadata and maintain the single sticky comment)
   - Checks: write
   - Metadata: read

   Subscribe to `pull_request` and `merge_group`; point the webhook to `https://YOUR_HOST/webhooks/github`.

4. Add `localmesh.yml` to the repository. Start from `localmesh.example.yml`.

5. Start the stack:

   ```bash
   docker compose up --build
   ```

   The dashboard is available at `http://localhost:3000` and API health at `http://localhost:4100/health`.

6. Configure branch protection to require `Dot75 / Migration Compatibility` and require branches to be current. Repositories using GitHub merge queue receive a final `merge_group` check against the queue SHA.

## Migration and contract conventions

Raw migrations end with `.up.sql` or `.down.sql`; a leading integer controls order. Configuration version 2 can select Prisma, Drizzle, Flyway, or Liquibase formatted SQL adapters. Forward-only SQL is reported as non-reversible.

Mappings live in `.localmesh/contracts.yml` and must be committed before enforcement. Six templates are included: users, orders, payments, inventory, soft deletion, and multi-tenancy. SQL fixtures under `.localmesh/fixtures` are loaded only into disposable databases.

See [`examples/demo`](examples/demo) for a complete configuration, baseline, fixtures, and two simulated PR changes.

## Development and verification

```bash
pnpm typecheck
pnpm test
RUN_DOCKER_TESTS=1 pnpm test:integration
pnpm benchmark
```

The benchmark contains 20 known-conflicting and 20 known-safe pairs and reports accuracy, precision, recall, false-positive rate, median runtime, and P95 runtime. Docker-backed commands require a running Docker Engine.

## Failure model

- Invalid configuration fails the Check with an actionable error.
- Unsupported extensions fail during isolated baseline construction.
- A missing Ollama server never prevents deterministic validation.
- Ambiguous dependency inspection is conservative: the pair is tested.
- New PR commits cancel older queued or running records; job keys prevent duplicate delivery.
- The worker stops its test container in `finally`, including error paths.
- GitHub annotations are capped at 50; the full result remains in the local dashboard.

## Current boundaries

Dot75 does not ingest production rows or claim measured production latency. Operational findings are static checks plus isolated lock simulation. Code-driven Rails, Django, and Alembic execution remains disabled until an operator provides the planned isolated project-container runner. The web app does not replace GitHub review or act as a merge queue, and verified AI patches are never committed automatically.
