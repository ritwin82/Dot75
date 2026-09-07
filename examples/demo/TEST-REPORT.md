# Local validation report — 2026-09-07

## Completed

- Production monorepo build and strict workspace type-check.
- 21 unit tests, including valid/invalid Ollama responses, model-not-installed
  handling, timeouts, cache reuse and finding classification.
- 10 Docker integration tests, including schema conflicts, schema contracts,
  fixture data contracts, safe PR selection, failed baseline recovery and rollback.
- 40 benchmark cases: 20 conflicts and 20 safe; all matched expected outcomes.
  No false positives in this corpus. Median case: 590 ms; P95: 805 ms;
  total including startup: 27.4 seconds. These are local corpus measurements,
  not a production accuracy or latency guarantee.
- Five failing local multi-PR demos generated real Ollama explanations using
  qwen2.5-coder:3b. Warm model calls took 5.7–8.1 seconds.
  The first cold call in an earlier run took 75.6 seconds.
  The safe control now skips inference and shows its deterministic passing
  result; browser inspection caught and eliminated a model-invented conflict
  for an empty finding list. A regression test confirms Ollama is not called.

## Demo results

| Scenario | Current PR | Other PRs | Expected result |
| --- | --- | --- | --- |
| Duplicate column | 201 | 202 | Failed, SQLSTATE 42701 |
| Drop versus index | 203 | 204 | Failed, SQLSTATE 42703 in one order |
| Conflicting defaults | 205 | 206 | Failed, different final schemas |
| Required status column | 207 | 208 | Failed, required schema column missing |
| Inventory quantity | 209 | 210 | Singles pass; combined data contract fails |
| Compatible control | 211 | 212, 213 | Passed; unrelated PR 213 skipped |

The suite uses 13 distinct simulated PR numbers. Comparisons are pairwise with
the current PR. The demo records show 24 orders; an additional unrelated candidate
inspection is performed for the safe control. No GitHub PRs were created.

## Issues found and fixed

- Internal PostgreSQL TOAST index names caused false schema divergence. Internal
  schemas are now excluded from inspection.
- Data-only migrations could evade dependency selection despite interacting
  through a contract. With enabled mappings, candidate selection is conservative.
- Contracts now run on each successful merge-order database, after baseline
  fixtures and migrations. A SQL-success row can still fail a contract.
- The model's bounded JSON grammar failed on the local inference backend.
  Generation now uses a compact schema with strict validation afterward.
- AI fallback reasons and pending work are visible. Database results are saved
  before inference; the UI refreshes while an explanation is pending.

The UI provides measured PR outcomes, distinct findings with occurrence context,
impact, next step, error code, migration path, expandable evidence, model/source,
uncertainties and explicit coverage. Desktop and 390px-wide layouts were inspected.

## Limits

Real GitHub authentication, webhook/queue delivery and Check publication still
need GitHub App credentials and are not verified by these local runs. Existing
demo history is preserved; use the newest records. AI suggestions remain advisory
and were not automatically executed. No production data was used.
