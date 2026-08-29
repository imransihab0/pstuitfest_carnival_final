### Functional Requirements (FR)

| ID    | Requirement                      | Priority     | Description / Acceptance Criteria                                                                                          |
| ----- | -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| FR-01 | User Registration                | Must Have    | User can create an account using unique identifier such as email/phone/username.                                           |
| FR-02 | User Login                       | Must Have    | Registered users can securely log in and access their account.                                                             |
| FR-03 | User Profile                     | Must Have    | User can view basic account information and current balance.                                                               |
| FR-04 | Initial Balance                  | Must Have    | New users automatically receive **BDT 100,000 fake balance**.                                                              |
| FR-05 | User Search                      | Must Have    | User can find another registered user using username, email, phone, or unique ID.                                          |
| FR-06 | Send Money                       | Must Have    | User can transfer a specified amount to another user.                                                                      |
| FR-07 | Balance Validation               | Must Have    | Transfer is rejected when sender has insufficient balance.                                                                 |
| FR-08 | Self-Transfer Prevention         | Must Have    | User cannot transfer money to their own account.                                                                           |
| FR-09 | Amount Validation                | Must Have    | System rejects zero, negative, invalid, or otherwise unacceptable transaction amounts.                                     |
| FR-10 | Atomic Transaction               | Must Have    | A transfer must either completely succeed or completely fail. Sender debit and receiver credit cannot become inconsistent. |
| FR-11 | Transaction Confirmation         | Must Have    | User receives clear success/failure feedback after a transaction.                                                          |
| FR-12 | Transaction ID                   | Must Have    | Every successful or failed money movement receives a unique transaction/reference ID.                                      |
| FR-13 | Transaction History              | Must Have    | User can view their incoming and outgoing transactions.                                                                    |
| FR-14 | Transaction Details              | Must Have    | Each transaction shows amount, sender, receiver, timestamp, status, and transaction ID.                                    |
| FR-15 | Request Money                    | Must Have    | User can request a specific amount from another user.                                                                      |
| FR-16 | Request Management               | Must Have    | User can view pending requests and accept/reject them.                                                                     |
| FR-17 | Request Payment                  | Must Have    | Accepting a money request performs a validated transfer.                                                                   |
| FR-18 | Duplicate Transaction Protection | Must Have    | Repeated submission of the same request must not transfer money twice.                                                     |
| FR-19 | Concurrent Transaction Handling  | Must Have    | Simultaneous transactions cannot cause incorrect balances or double spending.                                              |
| FR-20 | Transaction Status               | Must Have    | Transactions have clear states such as pending, successful, failed, rejected, or cancelled where applicable.               |
| FR-21 | Transaction Failure Handling     | Must Have    | Failed transactions must not partially modify balances.                                                                    |
| FR-22 | Balance Consistency              | Must Have    | After every successful transfer, sender and receiver balances must remain mathematically consistent.                       |
| FR-23 | Transaction Audit Log            | Must Have    | System records important transaction events for traceability and debugging.                                                |
| FR-24 | Logout                           | Must Have    | User can securely terminate their session.                                                                                 |
| FR-25 | Authentication Protection        | Must Have    | Unauthorized users cannot access another user's account or transaction data.                                               |
| FR-26 | Notification                     | Nice to Have | Users receive notifications when money is received, sent, or requested.                                                    |
| FR-27 | Transaction Search/Filter        | Nice to Have | Users can filter transactions by date, type, amount, or status.                                                            |
| FR-28 | Cancel Money Request             | Nice to Have | Request creator can cancel an outstanding request.                                                                         |
| FR-29 | Transaction Receipt              | Nice to Have | User can view/download/share a transaction receipt.                                                                        |
| FR-30 | Dashboard Statistics             | Nice to Have | Dashboard shows spending, receiving, transaction count, etc.                                                               |
| FR-31 | Admin Dashboard                  | Nice to Have | Admin can monitor users and transactions.                                                                                  |
| FR-32 | Suspicious Transaction Detection | Nice to Have | System can flag unusual transaction patterns or excessive requests.                                                        |
| FR-33 | User Blocking                    | Nice to Have | User can block another user from sending requests/interactions.                                                            |

---

### Non-Functional Requirements (NFR)

| ID     | Requirement          | Priority     | Description / Acceptance Criteria                                                                                                 |
| ------ | -------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| NFR-01 | Reliability          | Must Have    | Money movement must produce correct results even when requests fail or are repeated.                                              |
| NFR-02 | Data Integrity       | Must Have    | Balance and transaction records must never become inconsistent.                                                                   |
| NFR-03 | Atomicity            | Must Have    | Debit and credit operations must execute as one atomic database transaction.                                                      |
| NFR-04 | Concurrency Safety   | Must Have    | System must correctly handle multiple simultaneous transactions involving the same account.                                       |
| NFR-05 | Idempotency          | Must Have    | Retrying the same transaction request must not create duplicate transfers.                                                        |
| NFR-06 | Security             | Must Have    | Authentication, authorization, secure sessions/tokens, and protected APIs must be implemented.                                    |
| NFR-07 | Input Validation     | Must Have    | Server must validate all user-provided input; client-side validation alone is insufficient.                                       |
| NFR-08 | Authorization        | Must Have    | Users can only access their own balance, transactions, and authorized operations.                                                 |
| NFR-09 | Auditability         | Must Have    | Important money-related operations must be traceable through immutable or controlled logs.                                        |
| NFR-10 | Availability         | Must Have    | Application should remain operational during normal concurrent usage and recover gracefully from failures.                        |
| NFR-11 | Performance          | Must Have    | Normal transaction requests should receive a response within a reasonable time, preferably under 1–2 seconds under expected load. |
| NFR-12 | Scalability          | Must Have    | Architecture should support significant growth in users and transactions without requiring a complete redesign.                   |
| NFR-13 | Consistency          | Must Have    | All users must see balances and transaction states consistent with committed database transactions.                               |
| NFR-14 | Error Handling       | Must Have    | System should return meaningful errors without exposing sensitive implementation details.                                         |
| NFR-15 | Database Reliability | Must Have    | Financial records should use appropriate constraints, transactions, indexes, and backup/recovery considerations.                  |
| NFR-16 | API Security         | Must Have    | APIs must reject unauthorized, malformed, and manipulated requests.                                                               |
| NFR-17 | Maintainability      | Nice to Have | Backend should use modular architecture so transaction, authentication, user, and notification logic are separated.               |
| NFR-18 | Observability        | Nice to Have | Application should provide structured logs and basic monitoring/error tracking.                                                   |
| NFR-19 | Rate Limiting        | Nice to Have | Repeated requests from a user/IP should be limited to reduce abuse and accidental request floods.                                 |
| NFR-20 | High Availability    | Nice to Have | System should support redundancy and minimize downtime when deployed at larger scale.                                             |
| NFR-21 | Disaster Recovery    | Nice to Have | System should have a strategy for recovering important transaction data after infrastructure failure.                             |
| NFR-22 | Usability            | Must Have    | Core operations such as sending and requesting money should be simple and understandable.                                         |
| NFR-23 | Responsive Design    | Must Have    | Web application should work properly on desktop and mobile screens.                                                               |
| NFR-24 | Accessibility        | Nice to Have | Interface should follow basic accessibility practices such as readable contrast, labels, and keyboard navigation.                 |

### Most important requirements to demonstrate at the hackathon

If you have only **6 hours**, do **not** try to implement all 33 FRs. The strongest demo would revolve around these:

1. **Send Money**
2. **Request Money**
3. **Transaction History**
4. **Atomic transactions**
5. **Concurrency protection**
6. **Idempotency / duplicate prevention**
7. **Insufficient-balance protection**
8. **Authentication + authorization**
9. **Audit trail**
10. **Clear transaction status/error handling**

The key demonstration should be something like:

> Two requests attempt to spend the same balance simultaneously → **only valid transactions succeed, and the final balance remains correct.**

That demonstrates that you understood the actual challenge rather than building another CRUD application.
