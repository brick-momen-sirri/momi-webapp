# `POST /api/jobs` safety map

## Actual production dependency flow

1. `express.json` parses the request. Malformed JSON never reaches the route.
2. `requireAuth` resolves a live session and stores the authenticated `User` on
   the request. `jobSubmissionRoute.ts` never trusts a body-supplied `userId`.
3. The submission handler rejects demo accounts, resolves the project, hides
   projects the caller cannot view, and requires owner/editor access.
4. The workflow is looked up from `workflowService`'s loaded model catalog.
5. `validatedRequest` validates field types, required workflow inputs, resolution,
   duration, image-slot count, provider-specific option shapes, the Seedance 4K
   role rule, and the Kling prompt limit.
6. `jobMediaValidation` validates image/video kinds and sizes. Existing local
   files are realpathed and must belong to either the selected project or the
   caller's upload directory for that project. Public HTTP(S) media remains
   supported; browser-only, malformed, wrong-kind, unsupported local extensions,
   traversal, missing files, and another project/user's local media are rejected.
7. `jobQueue.createJob` looks up the model/project again as a defense against
   stale route state, externalizes inline data URLs into the job input directory,
   validates the target folder, normalizes duration, calculates the credit
   estimate, and constructs the persisted `queued` job.
8. `queuedJobCommit` adds the job to the process cache, persists it, removes the
   cache entry if persistence fails, and only then wakes the dispatcher.
9. An API-role process stops here. A dispatcher/monolith later claims the durable
   queued row and builds provider inputs immediately before provider submission.
10. Provider results, failures, cancellation, and actual-credit reconciliation are
    lifecycle concerns after the HTTP 201 response; they are not part of one HTTP
    transaction.

## Billing and idempotency reality

The repository currently has organization-level credit observation and post-job
usage reconciliation. It does **not** have a per-user/project credit wallet or a
reservation ledger. Therefore the submission path currently provides:

| Capability                               | Current behavior                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Credit estimate                          | Stored on the queued job before persistence                                                                  |
| Insufficient-credit gate                 | Not implemented; observed provider balance is not a transactional wallet                                     |
| Credit reservation                       | Not implemented                                                                                              |
| Reservation rollback/refund              | Not implemented                                                                                              |
| Negative-balance prevention              | Not applicable without a balance ledger                                                                      |
| Idempotency key                          | Not implemented                                                                                              |
| Duplicate HTTP retry suppression         | Not guaranteed                                                                                               |
| Duplicate provider submission prevention | Dispatcher claims and persisted RunPod IDs reduce risk, but there is no submission-key uniqueness constraint |

Tests must not claim those absent guarantees. Adding them safely requires a
durable reservation/idempotency schema with unique constraints and atomic
transactions shared by API workers and dispatchers. A fake in-memory balance in a
route test would prove only the fake.

## Safe test harness

- `jobSubmissionRoute.test.ts` imports only the injected HTTP handler. It uses an
  in-memory repository, controlled queue, deterministic estimator input, and a
  provider adapter whose `submit` method throws immediately. The controlled queue
  never calls it, and every test asserts zero provider calls.
- `jobMediaValidation.test.ts` uses temporary project/upload roots and real files.
  No production path or data is visible to the fixture.
- `queuedJobCommit.test.ts` proves persistence-before-dispatch and removal of an
  in-memory orphan after a database write failure.
- `routesHttp.integration.test.ts` exercises the real router, model catalog,
  project service, SQLite job store, and `jobQueue.createJob`. `ROLE=api` is fixed
  before imports, so the process cannot own dispatcher work. During the POST test,
  any outbound fetch that is not the local test server triggers an immediate
  failure. The returned job is checked in observable queue state.
- The existing unauthenticated-route matrix now includes `POST /api/jobs`.

No test reads provider credentials, calls RunPod/ComfyUI, creates a real generation
job, consumes credits, or accesses production data.

## Covered behavior

- Auth boundary and authenticated ownership override.
- Admin/owner/editor success; viewer, outsider, and demo rejection.
- Unknown project/workflow and malformed JSON/field types.
- Required prompt/image/start/end/video/resolution rules.
- Supported duration, resolution, image count, and provider-option validation.
- Local media ownership, traversal, missing file, type, malformed base64, and size.
- Correct estimate, queued status, durable state visibility, and one controlled
  queue publication.
- Database/persistence failure with no in-memory orphan and no dispatcher wakeup.
- A real route request with a hard outbound-network/provider tripwire.

## Remaining test/design work

- Durable idempotency key with an API-level unique constraint and concurrent retry
  tests across two API processes.
- A reservation ledger with atomic reserve/create/release/refund operations and
  exactly-once settlement identifiers.
- Queue-broker publication failure tests if persistence is ever replaced by a
  separate broker. Today the SQLite/JSON persisted queue is the publication.
- Provider submission/cancellation/settlement races remain covered at the job
  lifecycle layer, not as synchronous POST failures.
