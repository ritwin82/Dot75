# LocalMesh Sensei

LocalMesh Sensei finds PostgreSQL migration conflicts that Git cannot see. It executes related pull requests together in both orders, validates database contracts, verifies rollbacks, and publishes deterministic evidence as a required GitHub Check.

AI is optional. When Ollama is available it explains verified failures and proposes safer SQL, but it never decides whether a check passes.

## Automatic checks and reproducible evidence

LocalMesh now supports a thin GitHub Action as an alternative to the webhook service. It discovers other open migration PRs by immutable SHA, invokes the same validation engine through a portable JSON CLI, and publishes detailed Checks and a sticky PR comment. Default-branch pushes refresh open migration PRs without comment notifications; merge queues validate the full cumulative group. The trusted publisher can also send its verified result to the LocalMesh API so the same run appears in the dashboard without executing it again.

Start with the [architecture, Action setup, reporting guide, and prioritized roadmap](docs/architecture-and-action.md). Copy the [analysis workflow](examples/github-actions/localmesh-analysis.yml) and [publication workflow](examples/github-actions/localmesh-publication.yml) into a consuming repository and configure a reviewed tool SHA. This repository also contains active pinned workflows under `.github/workflows` for its own GitHub checks.

For install-once coverage across all or selected repositories, deploy the [hosted GitHub App control plane](docs/hosted-github-app.md). Users sign in with GitHub, install the App on an account or organization, and see only the installations and repository results they are authorized to access.

GitHub-only operation needs no webhook server, GitHub App key, service database, or inbound port. Dashboard synchronization is optional: configure the API and publication workflow with the same ingestion secret and run the publisher where it can reach the API. The sample keeps isolated analysis and trusted publication separate. A local analysis runner must be isolated for every PR it might analyze, including other open fork PRs.

Replay a saved input without GitHub access:

```bash
pnpm --filter @localmesh/worker... build
pnpm localmesh validate --input input-41.json --output result-41.json
```

Every new result carries the exact tested revisions, coverage decisions, and a SHA-256 input receipt. AI remains optional and cannot change the verdict.

## What the MVP does

- Rebuilds the target branch in the configured PostgreSQL 14–17 image.
- Discovers migration changes in the current and other open pull requests.
- Diffs PostgreSQL catalogs and builds dependency-aware change sets.
- Skips unrelated PRs, executes related pairs in both orders, and tests bounded three-PR permutations.
- Detects SQL failures plus order-dependent schema, fixture-row, and sequence fingerprints.
- Classifies each measured PR relationship as compatible, conflicting, order-sensitive, independent, invalid alone, or untested.
- Validates Git-committed schema and fixture-backed data contracts, including repository-defined schema and read-only SQL assertions.
- Tests paired `.up.sql` and `.down.sql` files and reports unsafe or missing rollbacks.
- Warns about blocking indexes, eager validation, unsafe `NOT NULL`, volatile defaults, unbounded data changes, routine replacement, and likely rewrites.
- Discovers raw SQL, Prisma, Drizzle, Flyway, and Liquibase formatted SQL migrations.
- Publishes a required `LocalMesh Sensei` Check and serves tenant-scoped compatibility maps, recurrence history, progress events, and portable JSON, Markdown, SARIF, and JUnit evidence.

## Architecture

| Component | Responsibility |
|---|---|
| `apps/action` | GitHub Action discovery, CLI invocation, provenance-checked publication |
| `apps/api` | Signed GitHub webhooks, signed Action result ingestion, tenant-scoped evidence API, durable queue, readiness and metrics |
| `apps/worker` | GitHub revision loading, PostgreSQL containers, validation orchestration |
| `apps/web` | Job overview, detailed evidence, compatibility map, and recurrence dashboard |
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

2. Copy `.env.example` to `.env` and configure the GitHub App credentials. Multiline private keys may use literal newlines or escaped `\n` sequences.

3. Create a private GitHub App using `.github/localmesh-app-manifest.example.json`. Grant only:

   - Contents: read
   - Pull requests: read
   - Checks: write
   - Metadata: read

   Subscribe to `pull_request`, `merge_group`, `push`, and `repository`; point the webhook to `https://YOUR_HOST/webhooks/github`.

4. Add `localmesh.yml` to the repository. Start from `localmesh.example.yml`.

5. Start the stack:

   ```bash
   docker compose up --build
   ```

   The dashboard is available at `http://localhost:3000` and API health at `http://localhost:4100/health`.

6. Configure branch protection to require the `LocalMesh Sensei` Check and require branches to be current. Repositories using GitHub merge queue receive a final `merge_group` check against the queue SHA.

## Migration and contract conventions

Raw SQL migration filenames must end with `.up.sql` or `.down.sql`. Configuration version 2 can select `prisma`, `drizzle`, `flyway`, or `liquibase` formatted SQL discovery. Rails, Django, and Alembic are registered but fail closed until an isolated project runner is available. Forward-only migrations are allowed and reported as non-reversible.

Fixture-state comparison is enabled by default. Use `data_state.exclude_columns` for nondeterministic values such as generated timestamps, and keep the exclusion list narrow. Three-PR exploration is bounded by `checks.max_group_permutations`, so the result reports any permutations it did not execute.

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
- GitHub annotations are capped at 50; the full result remains in the dashboard.

## Demo pitch

Open two PRs that pass alone but both modify the same database contract. Show LocalMesh selecting only that related pair, executing both orders, failing the required Check with PostgreSQL evidence, identifying the incomplete rollback, and then adding an Ollama explanation beneath the authoritative result.

> Git can merge two SQL files cleanly even when their migrations cannot coexist. LocalMesh Sensei tests related pull requests together in real PostgreSQL before merge.

## Current boundaries

The SQL adapters execute migration SQL only; they do not run Prisma generators or application framework code. Liquibase support currently covers formatted SQL, not XML, YAML, or JSON changelogs. Rails, Django, and Alembic remain disabled until a project-container runner is available. The hosted control plane does not include billing or production-row ingestion.
