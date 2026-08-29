# Requirements

Scoped requirements for the **Money Movement Application** built for the PSTU IT
Carnival 2026 hackathon (29 August 2026, 9:00 AM – 3:00 PM).

This document is the **build contract**: the subset of the challenge we commit to
delivering, stated precisely enough to test against. It does not replace the source
documents — it narrows them.

**Source documents (unchanged, still authoritative for the full problem space):**

- [`problem_statement.md`](./problem_statement.md) — the challenge brief as issued
  by the organizers: closed money ecosystem with simulated funds, users send and
  request money, BDT 100,000 seeded on registration, ~10M users in 3 years,
  free choice of stack, "think beyond the simplistic CRUD app."
- [`srs_tables.md`](./srs_tables.md) — the full SRS: 33 functional requirements
  (FR-01 … FR-33) and 24 non-functional requirements (NFR-01 … NFR-24), each with a
  Must Have / Nice to Have priority, plus the organizers' shortlist of the ten
  requirements most worth demonstrating in a six-hour build.

Where a requirement below maps onto an existing SRS row, the SRS ID is cited. IDs
cited here are commitments; SRS rows not cited are out of scope for this build
unless explicitly promoted later.

---

## 1. Scope

**In scope.** A closed-loop digital wallet with fake funds: register, log in, find
another user, send money, request money, accept/reject requests, view a full
transaction history, and receive realtime notifications of money movement.

**Out of scope.** Real banks, cards, payment gateways, financial networks, currency
conversion, KYC, and withdrawal/top-up of real funds. All balances are simulated.

**Guiding constraint.** A small, correct, defensible product beats a large collection
of half-built features. Every feature below must survive concurrent, repeated, and
hostile input without producing a wrong balance.

---

## 2. Functional Requirements

### FR-A — Registration with seeded balance

| | |
| --- | --- |
| **Maps to** | SRS FR-01, FR-02, FR-03, FR-04, FR-24 |
| **Priority** | Must Have |

- A user registers with a unique identifier (email and/or phone) plus a password.
  Uniqueness is enforced by a **database constraint**, not an application-level
  pre-check, so two simultaneous registrations of the same identifier cannot both win.
- Passwords are stored only as a salted hash (bcrypt/argon2). Plaintext passwords are
  never logged, persisted, or returned.
- On successful registration the account is credited **exactly ৳100,000.00** — stored
  as the integer `10_000_000` in the minor unit (poisha). See NFR-C.
- **The seeding credit is part of the same database transaction that creates the
  account.** There is no window in which an account exists with a zero or absent
  balance, and no account can be seeded twice.
- The seeding credit is written to the ledger as a regular, auditable entry of type
  `SIGNUP_BONUS`, sourced from a system account — not as a bare `UPDATE` to a balance
  column. The ledger explains every unit of money in the system, including the first.
- Login issues a session token; logout invalidates it.

**Acceptance:** a newly registered user's profile shows a balance of ৳100,000.00, and
their transaction history contains exactly one entry explaining it. Registering the
same identifier twice returns a clean 409-style error and creates exactly one account.

### FR-B — Send money

| | |
| --- | --- |
| **Maps to** | SRS FR-05, FR-06, FR-07, FR-08, FR-09, FR-10, FR-11, FR-12, FR-20, FR-21, FR-22 |
| **Priority** | Must Have |

- An authenticated user selects a recipient (found by username, email, phone, or user
  ID) and an amount, and transfers that amount.
- Server-side validation, all of which must reject the transfer **before** any balance
  moves:
  - amount is a positive integer in the minor unit, greater than zero;
  - amount is within a configured per-transaction maximum;
  - recipient exists and is active;
  - recipient is not the sender (**self-transfer is rejected**);
  - sender's available balance is greater than or equal to the amount.
- The debit and the credit are **one atomic database transaction**. A transfer either
  fully succeeds or fully fails; a partial transfer is not a reachable state
  (see NFR-A).
- Every attempt — successful or failed — is assigned a **unique transaction reference**
  and is recorded with a terminal status (`SUCCESS` / `FAILED` with a machine-readable
  failure reason). Failed transfers leave both balances untouched.
- The caller receives an unambiguous success/failure response carrying the reference,
  the resulting balance, and a human-readable message.
- Client-side validation is a convenience only; the server re-validates everything.

**Acceptance:** the sum of all account balances plus the system account is invariant
across any sequence of transfers. Insufficient-balance, self-transfer, and
non-positive-amount attempts are all rejected with distinct, non-leaky error codes.

### FR-C — Request money

| | |
| --- | --- |
| **Maps to** | SRS FR-15, FR-16, FR-17, FR-28 |
| **Priority** | Must Have (cancel: Nice to Have) |

- A user creates a money request against another user for a specified amount, with an
  optional note. A request is a **claim, not a transfer** — no money moves at creation.
- A request has an explicit lifecycle: `PENDING → ACCEPTED | REJECTED | CANCELLED`
  (`EXPIRED` reserved). Transitions out of a terminal state are rejected.
- The requestee sees incoming pending requests and may **accept** or **reject** them.
  The requester may **cancel** their own outstanding request.
- **Accepting a request executes a fully validated transfer under FR-B** — the same
  code path, the same balance check, the same atomicity, the same ledger entries. A
  request is not a shortcut around any transfer rule; accepting a request for more
  than the requestee's balance fails exactly as a direct transfer would, and the
  request stays `PENDING`.
- The state transition of the request and the transfer it triggers commit **together
  or not at all**. A request can never be marked `ACCEPTED` without its transfer
  having committed, and vice versa.
- Only the requestee may accept/reject; only the requester may cancel (see FR-E).

**Acceptance:** double-clicking "Accept" on one request moves money exactly once and
leaves the request `ACCEPTED`. Accepting an already-accepted request is a no-op that
returns the original transfer's reference.

### FR-D — Transaction history

| | |
| --- | --- |
| **Maps to** | SRS FR-13, FR-14, FR-23, FR-27, FR-30 |
| **Priority** | Must Have (filtering, statistics: Nice to Have) |

- A user views their own incoming and outgoing transactions in reverse-chronological
  order, paginated (keyset/cursor pagination, so paging stays O(1) as history grows).
- Each entry shows: amount, direction, counterparty, timestamp (UTC, rendered local),
  status, transaction reference, and note.
- History is derived from the **immutable ledger**. Ledger rows are append-only: a
  correction is a new compensating entry, never an update or delete of an existing
  row. This is what makes the history an audit trail rather than a report.
- Nice-to-have, if time permits: filter by date range, direction, status, and amount;
  dashboard totals for sent/received/count.

**Acceptance:** replaying a user's ledger entries from account creation reproduces
their current balance exactly.

### FR-E — Authentication, authorization, and API protection

| | |
| --- | --- |
| **Maps to** | SRS FR-25, NFR-06, NFR-07, NFR-08, NFR-16 |
| **Priority** | Must Have |

- Every money-related endpoint requires a valid session token.
- **Authorization is enforced per-object on the server, at the point of use.** A user
  may read only their own profile, balance, history, and requests, and may act only on
  requests where they hold the correct role. Object IDs in a request body are never
  trusted as proof of ownership; hiding an action in the UI is not authorization.
- The acting user's identity is taken **from the session token only** — never from a
  client-supplied `userId`/`fromAccount` field. A sender field in a request body is
  ignored if present.
- Malformed, oversized, or manipulated payloads are rejected with a schema error
  before reaching business logic.

### FR-F — Realtime notifications

| | |
| --- | --- |
| **Maps to** | SRS FR-26 (promoted from Nice to Have) |
| **Priority** | Should Have |

- A connected user receives a realtime push (WebSocket / Socket.IO) when they
  receive money, when a money request is created against them, and when a request they
  created is accepted, rejected, or cancelled.
- Notifications carry the transaction/request reference and the recipient's updated
  balance, so the UI updates without a refetch.
- **Notifications are emitted only after the database transaction commits.** A user is
  never told about money that a rollback subsequently erased.
- Notifications are an **enhancement, not the source of truth**: a missed or dropped
  socket message must never leave the UI permanently wrong. Reconnect triggers a
  refetch of balance and history, and the REST endpoints remain fully authoritative.

**Acceptance:** with the socket connection deliberately severed, every feature still
works correctly via REST; on reconnect the UI converges to the correct state.

### FR-G — Split payments (added beyond the original brief)

| | |
| --- | --- |
| **Maps to** | Not in `srs_tables.md` — a novel addition, logged here per the doc hierarchy in `docs/KNOWLEDGE_GRAPH.md` §1 rather than silently added to the code |
| **Priority** | Nice to Have |

- A user creates a **bill split**: a total amount, an optional description, and
  a list of participants each owing a fixed share. Creating a split moves no
  money — a claim, not a transfer, exactly like FR-C. The shares must sum to
  the declared total exactly; a mismatch is rejected before any row is
  written.
- Each participant pays their own share independently, whenever they choose.
  Paying a share **executes a fully validated transfer under FR-B** — the same
  balance check, the same atomicity, the same ledger entries as a direct send.
  A split share is never a shortcut around any transfer rule.
- Once every share of a split has been paid, the split is automatically marked
  **settled**. This is a cross-row invariant (no CHECK constraint can express
  "every sibling row is PAID"), so it is enforced by locking the parent split
  row for the duration of each share payment — see `docs/KNOWLEDGE_GRAPH.md`
  §5 (I8, I9) and §6 for why.

**Acceptance:** creating a split with shares that do not sum to the total is
rejected. Two participants paying the last two outstanding shares of the same
split at the same instant results in the split settling exactly once, not
zero times and not twice — proven in
`backend/test/bill-split.concurrency.integration-spec.ts` against a real
PostgreSQL, not asserted against a mock.

---

## 3. Non-Functional Requirements

### NFR-A — ACID correctness under concurrency

| | |
| --- | --- |
| **Maps to** | SRS NFR-02, NFR-03, NFR-04, NFR-13, NFR-15 |
| **Priority** | Must Have — this is the requirement the build is judged on |

- Debit, credit, ledger insert, and any request state change for a single transfer
  execute inside **one ACID database transaction**. There is no cross-service
  two-phase state where money exists in neither account.
- Concurrent transfers touching the same account must serialize correctly. Concretely:
  - balances are mutated only via a conditional, atomic statement
    (`UPDATE … SET balance = balance - :amt WHERE id = :id AND balance >= :amt`), so
    the balance check and the deduction cannot be split by another transaction —
    a read-then-write in application code is not acceptable;
  - where multiple accounts are locked in one transaction, locks are acquired in a
    **deterministic global order** (e.g. ascending account ID) so that
    `A→B` and `B→A` running simultaneously cannot deadlock;
  - a `CHECK (balance >= 0)` constraint is the last line of defense: even a logic bug
    cannot persist a negative balance.
- Isolation level and locking strategy are chosen explicitly, documented, and defended
  — not left at whatever the ORM defaults to.
- **Invariant, continuously assertable:** the sum of all account balances plus the
  system account is constant, and equals the sum of all ledger entries. Any violation
  is a build-stopping bug.

**Demonstration (the headline demo).** N concurrent transfers race for the same
balance — e.g. an account holding ৳100,000 is hit by 20 simultaneous ৳10,000
transfers. Exactly 10 succeed, 10 fail with insufficient funds, the final balance is
exactly ৳0, no balance ever goes negative, and no money is created or destroyed. This
is delivered as a **repeatable automated test**, not a manual click-through.

### NFR-B — Idempotent retries

| | |
| --- | --- |
| **Maps to** | SRS FR-18, NFR-01, NFR-05 |
| **Priority** | Must Have |

- Every mutating money endpoint accepts a client-generated **idempotency key**
  (UUID, `Idempotency-Key` header). Clients generate it once per user intent and reuse
  it across retries.
- The key is stored with a **unique database constraint** scoped to the acting user.
  The uniqueness violation is the mechanism — a "check if it exists first" lookup is
  itself a race and is not sufficient.
- Replaying a key returns the **original stored response** (same transaction
  reference, same status code) without performing the transfer again.
- This holds under the realistic failure modes, not just the easy one: double-click,
  client timeout with the server still committing, mobile-network retry, and
  at-least-once delivery from any queue.
- A key replayed with a **different payload** is a client bug and is rejected with a
  conflict error rather than silently serving the old response.

**Acceptance:** firing the same transfer request 50 times concurrently with one
idempotency key moves money exactly once and returns 50 identical responses.

### NFR-C — Integer-only money arithmetic

| | |
| --- | --- |
| **Maps to** | SRS NFR-02, NFR-07, NFR-15 |
| **Priority** | Must Have |

- Money is stored, transported, and computed **exclusively as 64-bit integers in the
  minor unit (poisha, 1/100 BDT)**. `৳100,000.00` is the integer `10000000`.
- **Floating-point types are banned anywhere in the money path** — no `float`/`double`
  columns, no JS `Number` arithmetic on amounts, no `parseFloat`. Amounts cross the
  API as integers or as strings parsed to integers, never as JSON floats.
- Column type is a fixed-width integer (`BIGINT`), not `NUMERIC`-by-convention or
  `VARCHAR`.
- Formatting to `৳1,234.56` happens **only at the presentation edge**, on a value that
  was an integer up to that point. Parsing user input to the minor unit happens
  immediately at the input edge, with explicit rejection of more than two decimal
  places rather than silent rounding.
- No rounding, truncation, or division occurs in the transfer path at all. There is no
  code path in which ৳0.01 can be created or lost.

**Acceptance:** a static check (grep/lint) over the money modules finds no
floating-point arithmetic; unit tests cover parse/format round-tripping at boundary
values.

### NFR-D — Horizontal scalability path

| | |
| --- | --- |
| **Maps to** | SRS NFR-10, NFR-12, NFR-20, NFR-21 |
| **Priority** | Must Have (as a defensible design, not a deployed cluster) |

The brief projects **>10 million users within three years**. We do not deploy at that
scale in six hours; we build so that reaching it does not require a redesign, and we
can defend the path.

- **Stateless application tier.** No in-process session state, no in-memory balances,
  no sticky routing required. Any instance can serve any request, so scaling out is
  adding processes behind a load balancer. Session state lives in the token or a
  shared store.
- **The database is the consistency boundary**, and correctness never depends on there
  being exactly one app instance. Every invariant in NFR-A is enforced by the database
  itself (constraints, conditional updates, unique keys), so it holds identically at
  one instance or fifty.
- **Indexes designed for the access patterns that grow**: ledger by
  `(account_id, created_at DESC)` for history, unique index on the idempotency key,
  unique indexes on user identifiers, index on request recipient + status. Keyset
  pagination throughout — no `OFFSET` scans over a growing table.
- **Documented next steps**, deliberately not built today: read replicas for history
  and dashboard reads (accepting bounded staleness on reads while all writes stay on
  the primary); horizontal sharding by account ID with a two-phase or outbox-based
  path for cross-shard transfers; a transactional outbox to decouple notification
  delivery from the write path; connection pooling (PgBouncer) ahead of raising
  instance counts.
- Realtime fan-out is pluggable: the local socket broadcast is swappable for a
  Redis pub/sub adapter so multiple app instances can serve sockets.

**Acceptance:** we can run two app instances against one database and every
correctness test in NFR-A and NFR-B still passes unchanged.

### NFR-E — Sub-second p95 transfer latency

| | |
| --- | --- |
| **Maps to** | SRS NFR-11 (tightened from "1–2 seconds") |
| **Priority** | Must Have |

- **Target: p95 end-to-end latency of a `POST /transfer` under 1000 ms**, measured
  server-side from request receipt to response flush, under the demo's expected
  concurrent load. p99 under 2000 ms.
- Achieved by keeping the write path short: one database round trip for the
  transaction, indexed lookups only, no N+1 queries, no synchronous third-party calls,
  and **no blocking work inside the transaction** — notification fan-out happens after
  commit, off the critical path.
- Lock hold time is minimized: validation that does not require a lock happens before
  the transaction opens, so contention on hot accounts stays low.
- **Measured, not asserted:** a load-test script reports p50/p95/p99 and the numbers
  go in the README. A target without a measurement is a wish.

### NFR-F — Supporting qualities

| | |
| --- | --- |
| **Maps to** | SRS NFR-09, NFR-14, NFR-17, NFR-18, NFR-19, NFR-22, NFR-23, NFR-24 |
| **Priority** | Mixed — see below |

- **Auditability (Must).** Every money-affecting operation is traceable through the
  append-only ledger plus structured logs carrying the transaction reference. Ledger
  rows are never mutated.
- **Error handling (Must).** Stable machine-readable error codes
  (`INSUFFICIENT_FUNDS`, `SELF_TRANSFER`, `IDEMPOTENCY_CONFLICT`, …) with safe human
  messages. Stack traces, SQL text, and internal identifiers are never returned to
  clients.
- **Usability (Must).** Sending and requesting money each take an obvious, short path
  with a clear confirmation. Amounts are always displayed with the ৳ symbol and two
  decimals.
- **Responsive design (Must).** Works on desktop and mobile viewports.
- **Maintainability (Should).** Modular separation of auth, users, transfers,
  requests, and notifications; the transfer service is the single place money moves.
- **Observability (Should).** Structured JSON logs with a correlation ID per request;
  a health endpoint.
- **Rate limiting (Nice).** Per-user and per-IP limits on transfer, request-creation,
  and auth endpoints to blunt floods and brute force.
- **Accessibility (Nice).** Readable contrast, labelled form controls, keyboard-
  navigable core flows.

---

## 4. Explicitly deferred

Not built in this six-hour window, and named here so the omissions are choices rather
than gaps: admin dashboard (SRS FR-31), suspicious-transaction detection (FR-32), user
blocking (FR-33), downloadable receipts (FR-29), and disaster-recovery tooling
(NFR-21). The scalability path in NFR-D is documented and designed for, not deployed.

---

## 5. Definition of done

The build is demo-ready when all of the following hold:

1. Register two users; both show exactly ৳100,000.00, each explained by one ledger entry.
2. A → B transfer succeeds; both balances and both histories are correct and consistent.
3. B requests money from A; A accepts; the transfer executes; the request reads `ACCEPTED`.
4. Insufficient balance, self-transfer, and zero/negative amounts are each cleanly rejected.
5. The concurrency test in NFR-A passes: no negative balance, no money created or destroyed.
6. The idempotency test in NFR-B passes: 50 concurrent identical requests move money once.
7. Realtime notification arrives on receipt; with the socket cut, the app still works via REST.
8. Measured p95 transfer latency is recorded in the README and is under 1000 ms.
9. Every prompt used in the build is logged in [`PROMPTS.md`](./PROMPTS.md).
