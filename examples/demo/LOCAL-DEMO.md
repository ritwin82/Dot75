# Local PostgreSQL and Ollama demo

The local demo uses simulated PR numbers with real PostgreSQL 16 execution.
It calls the same validation plan as the GitHub worker, stores the measured results,
then calls local Ollama. GitHub authentication, webhook delivery, queue delivery
and Check publication still require a configured GitHub App and are not verified
by this demo.

## Start on Windows

From the repository root, with Docker Desktop and Ollama running:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
pnpm install
pnpm --filter './packages/**' build
& "$env:LOCALAPPDATA/Programs/DockerDesktop/resources/bin/docker.exe" compose up -d metadata
pnpm dev
```

The root .env is loaded automatically by the API, worker and demo scripts.
For a stable presentation without development file watchers, run `pnpm build`
once, then use `pnpm start` instead of `pnpm dev`. Do not run both at once.
The local installation uses:

```env
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:3b
OLLAMA_TIMEOUT_MS=120000
```

Install the model if necessary:

```powershell
& "$env:LOCALAPPDATA/Programs/Ollama/ollama.exe" pull qwen2.5-coder:3b
```

Model downloads are about 1.9 GB. This machine already has the model installed.
The first inference can be slower while the model loads. The web page displays
the verified result immediately and refreshes while its explanation is pending.
OLLAMA_MODEL overrides the per-repository model setting; without either, AI is
disabled. Docker Compose routes the worker to the host Ollama service through
host.docker.internal; change that setting if Ollama runs elsewhere.

In another terminal:

```powershell
pnpm demo:conflicts
# Fast database-only checks:
pnpm --filter @localmesh/worker demo --no-ai
# One specific scenario:
pnpm --filter @localmesh/worker demo --scenario=inventory-contract-collision
```

Open http://localhost:3000/dashboard. Each run adds new records and preserves
history. The latest entries use PR numbers 201–213. Old demo entries retain their
original explanations; inspect the newest run for the updated model output.

## Cases

| Scenario | Expected outcome |
| --- | --- |
| Duplicate column | Each PR passes alone; both merge orders fail with 42701 |
| Drop versus index | Each PR passes alone; dropping before indexing fails with 42703 |
| Conflicting defaults | Both SQL orders succeed but final schemas differ |
| Required status column | Removing a bound column fails the orders schema contract |
| Inventory contract | From quantity 10, each PR subtracts 6: alone passes, together fails with -2 |
| Three-PR safe control | Related column additions pass; unrelated users change is skipped |

Comparisons are pairwise against the current PR, not every permutation of all
PRs. When contract mappings are enabled, candidate selection is conservative:
data-only migrations may interact without changing the catalog, so every
candidate is compared. Baseline fixtures are loaded BEFORE each migration
sequence, and contracts are checked against the resulting schema and data.
Fixtures must be compatible with the baseline schema.

The six demos do not run rollback checks; the integration suite covers rollback,
including replay of earlier data migrations before checking a later rollback.
The UI explicitly labels absent contract and rollback coverage.

## Explanation behavior and efficiency

Ollama summarizes verified findings and proposes repairs. Suggestions are
unexecuted and require review; database checks alone set pass/fail.
The interface identifies model, elapsed time, assumptions, pending work and
fallback reasons. Missing models, invalid responses and timeouts preserve the
database evidence and use deterministic guidance.

Repeated findings are grouped in the UI with affected execution orders.
The engine uses a single-PR run for both dependency inspection and validation,
runs at most two merge orders concurrently per comparison, and avoids persisting
full per-order catalog snapshots. AI context is bounded; identical successful
requests have a bounded ten-minute in-process cache and share in-flight calls.
Containers are stopped after the test run. The worker releases its PostgreSQL
container before inference.

The integration uses Ollama's documented [generate endpoint](https://docs.ollama.com/api/generate)
and [structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
Decoding uses a compact JSON schema; strict response limits are validated after
generation for compatibility with the local inference engine.
When there are no findings, the model is not called. The page shows the verified
passing result and test coverage directly, avoiding unnecessary inference and
unsupported model claims about nonexistent errors.

## Regression checks

```powershell
pnpm typecheck
pnpm test:unit
$env:RUN_DOCKER_TESTS = '1'
pnpm test:integration
pnpm benchmark
pnpm build
```

To stop development services, press Ctrl+C in their terminal.
Stop the database with Docker Compose stop metadata; its volume preserves history.
