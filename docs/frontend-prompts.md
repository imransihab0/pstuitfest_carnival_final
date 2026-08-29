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

---

## Entry 004

**Timestamp:** 2026-08-29

```
That message is the frontend's generic fallback — it fires because the request never reaches the backend.

Immediate cause: 404. The frontend posts to http://localhost:3000/auth/register, but the API serves /api/v1/auth/register. There's no error body to show, so you get the catch-all text.

And even at the right URL, the payload is rejected (7 problems):

property name should not exist
Phone must be 10-15 digits
Username ... required (3-50 chars)
displayName ... required
Password must be at least 12 characters   ← form only requires 8
PIN must be exactly 6 digits              ← form only allows 4

The form collects name, email, password, pin. The API needs email, phone, username, displayName, password, pin. So: no phone field, no username field, password minimum too low, PIN too short — plus name vs displayName.

This is items 1, 3 and 6 from the wiring audit. Nothing is broken server-side; the two sides were built to different contracts.

Want me to fix it? Smallest useful change:
1. VITE_API_URL=http://localhost:3000/api/v1
2. Add phone + username fields to the register form, rename name → displayName
3. Password min 8 → 12, PIN 4 → 6 digits (form, modal, and validators)
4. Map the login/auth response shape

That gets register + login working end-to-end. The dashboard/transfer screens will still 404 — those five endpoints don't exist yet.
dont change backend just fix the frontend based on backend
```

---

## Entry 005

**Timestamp:** 2026-08-29

```
Integrate the Socket.IO client from Prompt 7: on receiving a transfer
notification, update the balance and activity feed live without a page
refresh, with a subtle balance count-up animation as the only motion
element in the UI per our black-and-white design direction.
```
