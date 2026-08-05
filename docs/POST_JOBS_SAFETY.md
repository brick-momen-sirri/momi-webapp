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
7. `jobQueue.createJobIdempotent` looks up the model/project again as a defense against
   stale route state, externalizes inline data URLs into the job input directory,
   validates the target folder, normalizes duration, calculates the credit
   estimate, and constructs the persisted `queued` job.
8. For SQLite, job creation and the `(user_id, request_id)` idempotency record are
   inserted in one immediate transaction. A matching retry returns the original
   row; a reused key with different request content returns 409. JSON mode retains
   process-local suppression but is not the production multi-worker guarantee.
9. The new row is added to the process cache only after the transaction commits,
   and only then is the dispatcher awakened.
10. An API-role process stops here. A dispatcher/monolith later claims the durable
    queued row and builds provider inputs immediately before provider submission.
11. Provider results, failures, cancellation, and actual-credit reconciliation are
    lifecycle concerns after the HTTP 201 response; they are not part of one HTTP
    transaction.

## Billing and idempotency reality

The repository currently has organization-level credit observation and post-job
usage reconciliation. It does **not** have a per-user/project credit wallet or a
reservation ledger. Therefore the submission path currently provides:

| Capability                               | Current behavior                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Credit estimate                          | Stored on the queued job before persistence                                                                |
| Insufficient-credit gate                 | Not implemented; observed provider balance is not a transactional wallet                                   |
| Credit reservation                       | Not implemented                                                                                            |
| Reservation rollback/refund              | Not implemented                                                                                            |
| Negative-balance prevention              | Not applicable without a balance ledger                                                                    |
| Idempotency key                          | Durable per-user `clientRequestId`, backed by a SQLite unique constraint and request hash                  |
| Duplicate HTTP retry suppression         | Guaranteed in SQLite mode across API workers; a replay returns HTTP 200 and the original job               |
| Duplicate provider submission prevention | Retried HTTP creation resolves to one durable queued job; dispatcher claims still fence provider execution |

The credit-wallet capabilities remain absent and tests do not simulate them with
an in-memory balance. Idempotency is a real store guarantee: tests race two SQLite
connections, verify content-mismatch conflicts, exercise cross-worker replay in
the topology gate, and verify the browser reuses its key after an uncertain response.

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
- Durable same-key replay, different-payload conflict, JSON-to-SQLite backfill,
  two-connection uniqueness, and cross-API-worker retry recovery.

## Remaining test/design work

- A reservation ledger with atomic reserve/create/release/refund operations and
  exactly-once settlement identifiers.
- Queue-broker publication failure tests if persistence is ever replaced by a
  separate broker. Today the SQLite/JSON persisted queue is the publication.
- Provider submission/cancellation/settlement races remain covered at the job
  lifecycle layer, not as synchronous POST failures.
