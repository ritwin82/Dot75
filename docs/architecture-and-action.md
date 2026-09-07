# LocalMesh: architecture, automatic checks, and product direction

LocalMesh's strongest product is an executable compatibility check for concurrent PostgreSQL migrations. It should answer a concrete question: **If these independently valid pull requests meet on this exact base revision, what actually breaks, where, and how can a reviewer reproduce it?**

The GitHub Action is a useful addition because it makes that question part of the merge process. It uses the same validator as the local CLI and GitHub App service.

## What exists and how it connects

| Layer | Responsibility | Current implementation |
| --- | --- | --- |
| Discovery | Read immutable base/head SQL and other open PRs targeting the same branch | `packages/github/src/discovery.ts`; paginated open PR list, Git tree comparison, SHA cache |
| Input boundary | Validate a portable versioned replay bundle | `packages/engine/src/input.ts`; Zod, trusted configuration, exact input digest |
| Execution | Construct isolated PostgreSQL databases and execute migrations | `packages/engine/src/runtime.ts`; PostgreSQL 14–17 containers |
| Schema inspection | Record catalog objects, dependencies, and fingerprints | `packages/inspector`; tables, columns, constraints, indexes, views, functions, triggers, policies, extensions, enums |
| Validation plan | Run current and candidate PRs, screen dependencies, test both related orders, check contracts and rollback | `packages/engine/src/validation-plan.ts` |
| Contracts | Check committed application invariants using schema and fixture data | `packages/contracts`; users, orders, payments, inventory, soft deletion, multi-tenancy |
| Reporting | Explain evidence, ownership, coverage, and next steps | `packages/github/src/reporting.ts`; Checks, annotations, sticky PR comment |
| Optional explanation | Explain an already determined verdict | Ollama in the service worker; deterministic explanations remain available without a model |
| Action transport | Discover, invoke the CLI, retain results, verify publication provenance | `apps/action`, root `action.yml`, workflow examples |
| Service transport | Receive signed webhooks, ingest verified Action results, and process durable jobs | `apps/api`, `apps/worker`, PostgreSQL metadata, `pg-boss` |
| Account dashboard | View authorized GitHub App, GitHub Action, and local validation evidence | `apps/web`; Next.js dashboard |

The Action publisher can import the same verified result into the service job database. The API authenticates the exact JSON bytes with HMAC-SHA-256, validates the versioned result shape, requires the repository, run, attempt, PR, and external check identity to agree, and accepts only fresh deliveries. Storage is idempotent by repository, PR, head SHA, and base SHA, so a workflow retry updates the existing dashboard entry. No SQL is rerun during synchronization.

## Automatic behavior

1. **PR opened or updated:** resolve its exact head and the live target-branch commit; read configuration, contracts, fixtures, and operational metadata from that trusted base; discover other migration PRs for the same target branch; run the CLI.
2. **Push to the default branch:** resolve open migration PRs against that push SHA and validate each in sequence. Each gets its own head-SHA check. No PR comments are written by this fan-out.
3. **Merge queue:** validate the cumulative migrations from the live trusted target branch to the queue's actual `head_sha`. Record the queue `base_sha` separately as its parent, which may include earlier queued PRs. This tests the cumulative group without reading unmerged policy changes as trusted configuration.
4. **No migrations changed:** produce an explicit success with zero PostgreSQL executions. Do not use workflow-level `paths` filters on a required check; a skipped workflow can otherwise leave the check pending. [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

Only discovery uses the cache. Open PR lists and branch heads are always refreshed. Immutable trees, merge-base lookups, and SQL blobs are cached; corrupt SQL entries are checked against their Git blob hash. Within a run, an unchanged PR's SQL is reused. Reuse across pushes requires persistent, operator-controlled trusted cache storage; default hosted runners and disposable VMs do not preserve this directory between jobs. Do not share writable discovery caches between untrusted fork jobs and trusted analysis. A baseline change may require new comparisons, while unchanged blobs remain reusable.

Migration history is append-only. Removed, renamed, or modified applied migrations and unsupported SQL filenames produce explicit discovery failures. A truncated API tree or missing expected blob cannot silently become a passing check.

PR runs use a per-PR concurrency group. Push refreshes are bounded and sequential. The two orders of a related pair use at most two independent databases concurrently. Queue runs do not cancel another live queue validation. Cancellation of a running Action terminates its process through Actions; the current engine does not yet implement cooperative cancellation of each database statement.

## What a reviewer sees

A failure report explains:

- **Verdict and scope:** base SHA, current head, every candidate head, tested and skipped PRs, why screening chose each pair, fixture and contract coverage.
- **Ownership and location:** the other PR number and author, failing migration owner, SQL path and exact line when PostgreSQL supplies a character position.
- **Database evidence:** SQLSTATE, server message/detail, failing application order, changed objects and fingerprints where available.
- **Impact and next step:** deterministic guidance matched to the failure class, with optional service-side AI explanation kept separate from the verdict.
- **Reproduction:** saved input JSON and a CLI command that does not require GitHub credentials or a queued service job.

For example, two PRs can both add `orders.discount` and each pass alone. LocalMesh then shows `#41 → #52` failing in PR #52 and `#52 → #41` failing in PR #41, the duplicate-column PostgreSQL error, both authors, and the recommendation to agree on one column definition and remove or rename the duplicate operation. This example describes expected behavior; it is not a measured benchmark result.

Annotations are attached only to files belonging to the checked head. A failure in another PR remains in the explanation rather than being attached to an unrelated file in the current PR. When PostgreSQL supplies no statement position, an annotation explicitly says it is anchored at the start of the file.

The sticky comment uses a hidden marker and only updates the configured bot's own comment. Passing results collapse to one line. Detailed evidence remains in the Check. Comment content escapes untrusted text to avoid accidental mentions and markup injection.

## Compatibility receipt and offline reproduction

The new input format is version 1 and contains:

```text
version, job, config, baseline, current, candidates,
fixtures, mappingsText?, metadataText?, provenance?, discoveryFindings?
```

`current` and every candidate contain `{ pr, files }`; migration files carry path, SQL, up/down direction, and execution order. `job` identifies the repository and exact base/head SHAs. `provenance` identifies each PR author/head. Policy files are read from the base, so a PR cannot silently disable its own checks; policy changes take effect after review and merge.

```bash
pnpm localmesh validate --input input-41.json --output result-41.json
```

Exit codes are `0` for passed, `1` for a validation failure, and `2` for malformed input or infrastructure failure. Node 22+, installed/built workspace dependencies, and Docker are required for SQL execution. A no-migration run or discovery error does not start PostgreSQL.

A runnable synthetic duplicate-column bundle is provided at `examples/github-actions/localmesh-input.example.json`. Its SHAs and PR identities are example values; it exercises real PostgreSQL when replayed with Docker and should exit 1.

The result includes a SHA-256 digest of the canonical replay input and the engine version. This binds the recorded evidence to its base, candidate set, SQL, fixtures, configuration, and metadata. The digest is a reproducibility identifier, **not a digital signature or proof that an untrusted artifact is authentic**. The privileged publisher separately verifies origin and freshness.

## Deployment and trust boundaries

Copy `examples/github-actions/localmesh-analysis.yml` and `localmesh-publication.yml` into the target repository's `.github/workflows/`, preserving their filenames and workflow names. Set these repository variables:

| Variable | Value |
| --- | --- |
| `LOCALMESH_TOOL_REF` | Full 40-character SHA of a reviewed LocalMesh commit containing this implementation |
| `LOCALMESH_TOOL_REPOSITORY` | Repository containing that tool commit; defaults to the consuming repository |
| `LOCALMESH_RUNNER_JSON` | Optional JSON runner label array; defaults to `["ubuntu-latest"]` |
| `LOCALMESH_PUBLISHER_RUNNER_JSON` | Optional JSON runner label array for the trusted publisher; use a local runner when the API is private |
| `LOCALMESH_PLATFORM_URL` | Optional API origin reachable from the publisher, such as `http://localmesh.internal:4100` |
| `LOCALMESH_UPLOAD_REPLAY` | Optional `true` to upload SQL/fixture replay inputs for seven days |

To synchronize Action results into the dashboard, generate a high-entropy secret and set the same value as `LOCALMESH_INGESTION_SECRET` in the platform `.env` and as a GitHub Actions repository secret. Set `LOCALMESH_PLATFORM_URL` as a repository variable. Both values are required together; omitting both keeps the GitHub-only mode. The API endpoint is `POST /api/action-results`, and the publisher signs the exact request body in `x-localmesh-signature-256`.

Change the example `push.branches: [main]` if the default branch has another name. The analyzer checks out only the pinned tool source. It fetches target PR SQL as data through GitHub APIs; it never checks out or installs the PR project. The tool repository must be readable with the analysis job's read-only token (or public); private cross-repository tool distribution needs a separately designed credential-free distribution mechanism for forks.

The analysis job has contents/PR read permissions. The `workflow_run` publisher has contents/actions read and checks/PR write permissions and runs separately. It never executes SQL or artifact-provided code. It validates the repository, originating run and attempt, workflow path, source event, expected workflow contents, target heads, peer heads, live base, and merge-group branch before publishing to GitHub and the optional dashboard. A PR-modified analysis workflow cannot produce an accepted passing artifact. Changes to that workflow need to reach the trusted default branch before the new workflow is accepted.

When the platform runs only on a workstation or private network, set `LOCALMESH_PUBLISHER_RUNNER_JSON` to labels for a trusted self-hosted runner with network access to the API. That runner long-polls GitHub over an outbound connection, and then calls the private API locally; the API does not need an inbound public route. Keep this publisher runner separate from untrusted SQL analysis runners because it receives the ingestion secret and a write-capable GitHub token.

Require the **LocalMesh Sensei** check from the GitHub Actions integration, require branches to be current, and enable its `merge_group` event if using merge queue. Do not enable the Action and GitHub App publisher under the same required-check name for the same repository; choose one delivery path. The reusable examples remain under `examples/github-actions`; this repository also has pinned active workflows for its own checks.

A self-hosted Actions runner initiates outbound connections to GitHub, so this deployment needs no inbound webhook or public local endpoint. [GitHub self-hosted runner communication](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)

**A read-only token does not make arbitrary SQL safe for a persistent runner.** The current runtime executes SQL as a PostgreSQL superuser inside disposable containers; that can execute programs inside the container. Do not connect public/fork-capable analysis to a trusted persistent runner, production network, host-mounted secrets, shared admin PostgreSQL server, or privileged publication runner. For local-first untrusted analysis, provision disposable self-hosted runner VMs with isolated networking, resource/time limits, and no sensitive metadata. Select their labels with `LOCALMESH_RUNNER_JSON` only after that isolation exists. The default hosted runner is an alternative when locality is not required. [GitHub runner security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)

The supplied workflow does not use `pull_request_target`. Read-only analysis and privileged publication are separated, and fork artifacts are treated as untrusted data. [GitHub secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use)

## Why this is useful alongside an AI coding assistant

An AI assistant can propose a migration fix. LocalMesh supplies an automatically refreshed, reproducible experiment against real PostgreSQL and the team's committed invariants. The practical value comes from access to all open migration PRs, execution of both orders, catalog evidence, rollback checks, and a merge gate with exact provenance. AI does not decide pass/fail, and an explanation changing cannot turn a failed database experiment into a pass.

The defensible product claim is **continuous evidence of migration compatibility**. It is not a claim that no AI agent could run these commands or that the approach is scientifically unique.

## Implemented improvements and next additions

Implemented in this change:

- Portable replay input and shared validation engine for the CLI, service worker, and Action.
- SHA-aware cross-PR discovery cache and conservative treatment of unsupported migration history.
- Automatic PR, main-refresh, and whole-group queue paths with separate publication.
- Signed, idempotent Action-result ingestion into the existing dashboard.
- Compatibility receipts, ownership-aware reports, explicit coverage/skip reasons, and sticky comments.
- Data-only changes with an empty catalog diff are conservatively compared.
- Fingerprints preserve whitespace inside SQL literals; semantically different defaults no longer become equal through blanket whitespace normalization.

The most valuable next work is measurable, rather than adding more AI text:

| Priority | Addition | Benefit | Correctness condition |
| --- | --- | --- | --- |
| 1 | Fixture-state comparison after both orders | Detect successful SQL that leaves different data without needing a predefined contract | Compare deterministic row sets with documented handling for clocks, random IDs, sequences, and nondeterminism |
| 2 | Reusable isolated baseline templates and bounded single-PR execution cache | Reduce repeated baseline builds and repeated candidate analysis during fan-out | Key by base SHA, all SQL/config/fixtures/metadata, PostgreSQL image identity, and engine version; invalidate when any input changes |
| 3 | Compatibility graph and verified merge-order suggestions | Show which pending PRs can coexist and which ordering was actually tested | Never infer a safe order from AI text or untested edges |
| 4 | Budgeted three-PR checks for connected groups | Find interactions that pairwise validation misses | Clearly report tested subsets and remaining coverage gaps |
| 5 | Broader benchmark corpus and mutation testing | Demonstrate capability beyond variations of duplicate-column collisions | Separate known conflict families, include negatives, and measure false positives and runtime on real Docker runs |

The current code still rebuilds baselines across execution orders and does not maintain a warm PostgreSQL pool. It does not prove arbitrary application correctness, all three-or-more-PR combinations, production-data safety, or order-independent fixture state. Dependency inspection is incomplete for some functions/triggers/dynamic SQL. Performance findings use SQL heuristics and optional operational metadata, not production load measurements. These boundaries should remain visible in the product's claims and evaluation.
