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
