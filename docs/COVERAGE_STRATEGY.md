# Coverage Strategy

Coverage is a regression signal, not the definition of correctness. The project
uses global CI floors to prevent broad backsliding and reviews sensitive modules
by behavior and absolute covered counts. New tests must be able to fail against
the defect or invariant they claim to protect.

## Baseline and final measurement

Percentages are statements / branches / functions / lines.

| Suite    |            9.3 phase baseline |       Final local measurement |          CI floor |
| -------- | ----------------------------: | ----------------------------: | ----------------: |
| Frontend | 54.22 / 51.42 / 53.92 / 56.14 | 57.12 / 52.84 / 57.44 / 59.17 | 53 / 49 / 53 / 55 |
| Backend  | 75.08 / 74.45 / 83.31 / 75.08 | 78.82 / 74.44 / 87.59 / 78.82 | 74 / 71 / 82 / 74 |

The floors deliberately retain several points of headroom. They are high enough
to reject a meaningful regression but low enough that a newly loaded difficult
file does not force low-value assertions merely to recover a percentage.

## Newly extracted frontend modules

| Module                          |  Lines | Branches | Functions | Interpretation                                                                               |
| ------------------------------- | -----: | -------: | --------: | -------------------------------------------------------------------------------------------- |
| CreditUsageDashboard.tsx        | 100.00 |   100.00 |    100.00 | Public composition/trigger is fully exercised.                                               |
| CreditUsageDashboardDialog.tsx  |  72.72 |    88.88 |     53.84 | Fetch, range, error, loading, close, and body cleanup are covered.                           |
| CreditUsageDashboardContent.tsx |  75.00 |    43.75 |     55.55 | Core composition is covered; visual permutations remain lower value.                         |
| CreditUsageSummary.tsx          |  83.33 |    50.00 |     66.66 | Summary/anomaly/user panels have representative states.                                      |
| CreditUsageTables.tsx           |  28.57 |    23.91 |     29.62 | Presentation-only table branches are not a calculation boundary.                             |
| creditUsageDashboardUtils.ts    |  85.96 |    62.50 |     97.43 | Pure grouping, de-duplication, stable sort, ranges, rounding, and CSV are directly asserted. |
| useCreditDashboard.ts           | 100.00 |   100.00 |    100.00 | Stale response and close/unmount request identity are fully covered.                         |

The low CreditUsageTables percentage is accepted because arithmetic, filtering,
sorting, and export serialization live outside it and are strongly tested. A
future table interaction change must add a user-visible component test rather
than snapshots that execute every JSX branch without proving behavior.

## Job lifecycle architecture

| Module                                   |  Lines | Branches | Functions |
| ---------------------------------------- | -----: | -------: | --------: |
| jobQueue.ts compatibility/runtime facade |  61.20 |    79.91 |     75.00 |
| lifecycleState.ts                        | 100.00 |    94.87 |    100.00 |
| executionRegistry.ts                     | 100.00 |   100.00 |    100.00 |
| archiveMembership.ts                     | 100.00 |   100.00 |    100.00 |
| jobFactory.ts                            | 100.00 |   100.00 |    100.00 |
| queuedJobCommit.ts                       | 100.00 |   100.00 |    100.00 |
| dispatcherLease.ts                       |  89.83 |    81.81 |     91.66 |
| jobPersistence.ts                        |  95.00 |    85.71 |    100.00 |
| mediaExternalization.ts                  |  89.55 |    56.25 |    100.00 |
| providerInputs.ts                        |  85.09 |    68.08 |     90.47 |
| runpodExecution.ts                       |  83.60 |    20.00 |     37.50 |
| localComfyExecution.ts                   |  29.18 |    80.95 |     50.00 |
| remoteResultRecovery.ts                  |  25.66 |   100.00 |     42.85 |

Pure state, claim identity, construction, persistence, and archive boundaries
are high. Provider executor percentages are interpreted with their fake-provider
integration and race tests: increasing them next should target abort, retry, and
recovery failures, not paid or real provider dispatch.

## Security- and credit-sensitive coverage

| Area                          | Module                     |  Lines | Branches | Functions |
| ----------------------------- | -------------------------- | -----: | -------: | --------: |
| Canonical path containment    | pathContainment.ts         |  98.30 |    80.00 |    100.00 |
| Media root/realpath policy    | mediaPathPolicy.ts         | 100.00 |    88.88 |    100.00 |
| Media authorization/streaming | routes/mediaRoutes.ts      |  76.54 |    50.72 |    100.00 |
| Provider input mapping        | jobQueue/providerInputs.ts |  85.09 |    68.08 |     90.47 |
| Workflow validation/mapping   | workflowService.ts         |  77.14 |    72.15 |     81.98 |
| Comfy worker coordination     | comfyPool.ts               |  69.83 |    93.47 |     68.42 |
| Authentication                | authService.ts             |  85.31 |    84.71 |     90.19 |
| Credit balance service        | creditService.ts           |  93.10 |    76.66 |    100.00 |
| Credit accounting             | creditUsageAccounting.ts   |  97.84 |    74.50 |    100.00 |
| Credit usage service          | creditUsageService.ts      | 100.00 |    95.65 |    100.00 |
| Credit dashboard calculations | creditDashboardService.ts  |  98.40 |    87.15 |    100.00 |
| Credit estimator              | creditEstimator.ts         |  69.57 |    78.99 |     77.77 |
| Job submission route          | routes/jobRoutes.ts        |  63.63 |    35.00 |    100.00 |
| Public frontend gateway       | frontendGateway.ts         |  94.81 |    85.18 |    100.00 |
| Gateway shutdown/config       | frontendServerLifecycle.ts |  93.33 |    66.66 |    100.00 |

The job submission route percentage does not express its full safety coverage:
route integration tests assert authentication, project/media ownership,
validation, durable creation, rollback, deterministic credits, and a
provider/network tripwire. Missing reservation-ledger, refund, and idempotency
capabilities remain product gaps and are not represented by fake tests.

## Route wiring

backend/src/index.ts remains at 0% because importing it starts the production
listener and process-level services. The suite instead exercises the router over
isolated HTTP sockets, maintains the protected-route authorization table, tests
ops configuration guards, and covers the separate public gateway at 94.81%
lines. Do not import the entrypoint merely to turn lines green. Add an
application factory only when a real wiring invariant cannot be tested through
the existing route harness.

backend/src/frontendServer.ts is similarly an entrypoint. Its meaningful
configuration and shutdown behavior is extracted into a 93.33%-covered lifecycle
module, while the compiled child-process smoke proves the actual entrypoint can
start, serve the built artifact, proxy a fake API, and exit cleanly.

## Policy for future changes

1. Newly added or significantly modified business logic must include tests for
   its success path, invalid input, authorization boundary where applicable, and
   at least one meaningful failure or race path.
2. New pure business modules should normally reach at least 85% line/function
   coverage and 70% branch coverage. A lower number requires a written review
   note explaining why additional execution would not improve behavioral
   confidence.
3. Payment, credits, media authorization, lifecycle ownership, cancellation,
   settlement, provider mapping, and authentication changes require
   behavior-specific integration or characterization tests; global coverage
   alone is insufficient.
4. Provider tests must use fail-closed fakes and network tripwires. Coverage runs
   must never submit paid jobs or use production credentials/data.
5. Do not exclude files because they are awkward. Current backend exclusions are
   limited to emitted-nothing type declarations, a static HTML template whose
   import would create fake coverage, tests, and the standalone topology harness.
6. Raise global floors only after repeat measurements. Keep enough margin for
   tool drift and denominator changes, and record both covered counts and
   percentages.
7. Review low-coverage execution/recovery modules before adding features there.
   Prefer one failure-injection test over many happy-path line hits.
