# Prompt Log

This file is an **append-only log of every prompt given to Claude Code during this
build**, recorded in chronological order.

It exists for **hackathon-judging transparency**: the judges asked teams to be able
to understand, explain, and defend the solution they build, and AI-assisted
development is explicitly permitted. This log makes the AI-assisted portion of the
work fully auditable — every instruction that shaped the codebase is reproduced here
verbatim.

**Rules for this file**

- Entries are **append-only**. Existing entries are never edited, reworded, or deleted.
- Each prompt is recorded **verbatim**, before the work it requests is carried out.
- Entries are numbered sequentially (`Entry 001`, `Entry 002`, …) in the order given.
- Assistant replies, tool output, and intermediate reasoning are **not** recorded here —
  only the human prompts.

---

## Entry 001

**Timestamp:** 2026-08-29

```
This repo already contains some preliminary docs. Before writing any code:

1. Scan the repo root and any /docs folder for existing files and summarize
   what's already there in your response.
2. Create a file at /docs/PROMPTS.md with a header explaining that this file
   is an append-only log of every prompt given to you (Claude Code) during
   this build, in chronological order, for hackathon-judging transparency.
   Add this current prompt as Entry 001.
3. Create a file at /docs/REQUIREMENTS.md capturing functional requirements
   (registration w/ seeded ৳100,000 balance, send money, request money,
   transaction history, realtime notifications) and non-functional
   requirements (ACID correctness under concurrency, idempotent retries,
   integer-only money arithmetic, horizontal scalability path, sub-second
   p95 transfer latency). Pull anything relevant from the existing docs you
   found in step 1 instead of overwriting them.
4. Do not scaffold any application code yet. Just confirm the repo structure,
   PROMPTS.md, and REQUIREMENTS.md are in place, then stop.

From this point forward, append every subsequent prompt I give you to
PROMPTS.md as a new numbered entry before acting on it.
```

---

## Entry 002

**Timestamp:** 2026-08-29

```
Append this prompt to /docs/PROMPTS.md as the next entry, then proceed.

Scaffold a /backend service: NestJS + TypeScript, Prisma as the ORM,
targeting PostgreSQL. Enforce a layered architecture — Controllers, Services
(domain logic, no direct DB access), Repositories (only place Prisma is
invoked). Add ESLint + Prettier with strict TypeScript config
(noImplicitAny, strictNullChecks). Add a /backend/requirements.txt-style
manifest — since this is Node, generate it as /backend/REQUIREMENTS.txt
listing runtime prerequisites (Node version, PostgreSQL version, Redis
version, required env vars with placeholder values) rather than a Python
package list. Add a docker-compose.yml at repo root wiring up api + postgres
+ redis. Implement only a GET /health endpoint for now. Do not implement
business logic yet.
```

---

## Entry 003

**Timestamp:** 2026-08-29

```
Append to PROMPTS.md, then proceed.

In /backend, define the Prisma schema for: users, accounts, transactions,
ledger_entries, money_requests, idempotency_keys, notifications. All monetary
fields are BigInt representing poisha (1 taka = 100 poisha) — add a schema
comment explaining why floats are banned in this domain. Add CHECK
constraints (amount_poisha > 0), enums for transaction/request status, and
foreign keys with appropriate onDelete behavior. Ledger_entries must be
insert-only at the application layer — document this constraint in a comment
even though Postgres won't enforce immutability natively. Generate the
initial migration and seed script.
```

---

## Entry 004

**Timestamp:** 2026-08-29

```
Append to PROMPTS.md, then proceed.

Implement TransferService.executeTransfer(senderUserId, receiverIdentifier,
amountPoisha, idempotencyKey) as a single Prisma $transaction. Requirements:

Resolve both accounts, then acquire row locks via SELECT ... FOR UPDATE
  in a deterministic order (sort by account UUID) to prevent deadlocks
  under concurrent cross-transfers.
Validate: sender !== receiver, amount > 0, sender balance >= amount.
On the idempotency_keys table: if the key already exists with a matching
  request hash, short-circuit and return the cached result — do not
  re-execute the transfer.
4.Write exactly one DEBIT and one CREDIT row to ledger_entries, update both
  cached accounts.balance_poisha fields, and insert the transactions row
  with status COMPLETED, all inside the same transaction.
5.On any validation failure, roll back and persist a FAILED transaction
  record for audit purposes.
6.Use Postgres SERIALIZABLE isolation or explicit row locking — pick one,
  document the trade-off in a code comment.

Write Jest unit tests that spin up 50 concurrent calls to executeTransfer
from a single account with insufficient combined balance, and assert:
(a) the account balance never goes negative, (b) exactly the affordable
number of transfers succeed, (c) SUM(ledger_entries) reconciles with
accounts.balance_poisha afterward.


, along side, firstly create a knowledge graph with a md file maybe, so that by reading it, any agent can understand whats going on in the project
```
