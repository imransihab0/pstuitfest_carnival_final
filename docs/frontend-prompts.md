# Frontend Prompts

Frontend-specific prompt history. New frontend prompts should be appended to this file only.

## Entry 001

**Timestamp:** 2026-08-29

```
Append to PROMPTS.md, then proceed.

Scaffold /frontend: React + TypeScript + Vite + Tailwind CSS. Configure the
Tailwind theme to a strict grayscale palette (#000000, #111111, #4a4a4a,
#e5e5e5, #ffffff) with exactly one accent color reserved for destructive/
error states only — enforce this via Tailwind config tokens, not ad hoc
classes. Set up React Router, an API client wrapper (fetch/axios) that
attaches the JWT access token and refreshes it transparently on 401. Do not
build feature screens yet — just the shell, layout, and typography system
(monospace/tabular-nums for money values).
```

---

## Entry 002

**Timestamp:** 2026-08-29

```
Build the Login and Register screens against the backend AuthModule from
Prompt 5, including PIN setup during registration and a PIN-entry modal
component that's reusable for any money-moving action. Store the access
token in memory (a React context/store), never in localStorage; rely on the
httpOnly refresh cookie for silent renewal.
```

---

## Entry 003

**Timestamp:** 2026-08-29

```
Build: (1) Dashboard — balance display with tabular-nums, recent activity
feed; (2) Send Money — recipient lookup, amount entry (validate against
integer poisha conversion client-side too), PIN confirmation modal, and
idempotency-key generation (UUID per submit, resent unchanged on retry);
(3) Requests inbox — incoming/outgoing money_requests with Accept/Decline
actions; (4) Transaction History — paginated, filterable, ledger-style
statement view. Wire optimistic UI updates that reconcile against the
server response.
```
