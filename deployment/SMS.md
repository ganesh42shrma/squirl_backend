# Bank SMS ingestion (backend)

The backend can capture new SBI UPI debit alerts and the supplied Kotak UPI debit/credit formats.
It does not read a phone's inbox. An Android receiver/automation client must obtain Android's SMS
permission, filter bank messages on the phone, queue events locally, and submit them over the existing
private Tailscale HTTPS address. The frontend provides Profile → Bank SMS pairing/review, and the
[Android SMS companion](../android-sms-helper/README.md) provides the receiver and encrypted queue.
The companion still needs its full SDK build and physical-phone checks on Linux.

## Install/update on the Linux desktop

Back up the encrypted database while Squirl is stopped. Transfer the updated backend source,
including `src/plugins/sms`, then restart the Squirl service. Migration v20 runs through the normal
startup migration mechanism. It preserves transaction IDs, rowids, tags, notes, indexes and references
while adding the `sms` transaction source and SMS evidence/device tables. Keep `DB_MUST_EXIST=true`.
No new secret or environment setting is needed. No account, sender or device is enabled automatically.

## Pair an account and a device

Management endpoints below require the normal signed-in browser session. All writes, including
ingestion, require `X-Requested-With: squirl`; do not put credentials in query parameters.
Responses use Squirl's normal `{ success, data, meta? }` envelope and `Cache-Control: no-store`.

### Configure own accounts: `PUT /api/sms/accounts`

```json
{
  "accounts": [
    { "bank": "sbi", "last4": "1111", "senders": ["REPLACE-SBI-SENDER"] },
    { "bank": "kotak", "last4": "2222", "senders": ["REPLACE-KOTAK-SENDER"] }
  ]
}
```

The examples are fictional. Replace suffixes and sender IDs with the real values shown by the
phone's message details. Sender matching is exact after trim/uppercase, including telecom prefixes
and suffixes; list all variants actually used. Never infer the sender from a bank name in the body.
This operation upserts the supplied banks; omitted banks remain configured. `GET /api/sms/accounts`
returns the current mappings. Sender lists can be changed; an existing bank's account suffix cannot.

Version one supports **one account per bank**, matching the existing statement ledger's bank-level
account labels (`sbi`, `kotak`). Do not use it for two SBI accounts or statements for a different SBI
account: current statement imports cannot distinguish their account suffixes. Both banks must be
explicitly configured as your own before automatic cross-bank transfer pairing is enabled.

### Create a device: `POST /api/sms/devices`

```json
{ "name": "My Android phone" }
```

Returns `{ id, name, token }`. The token is returned **once**, stored only as a SHA-256 hash, and
authorizes only SMS ingestion. Store it in the Android client's secure storage. It cannot read the
ledger, pair devices, change mappings, or review events. `GET /api/sms/devices` never returns tokens
or hashes. `DELETE /api/sms/devices/:id` revokes one. Password changes invalidate existing tokens.
Financial reset archives account mappings/evidence and revokes all SMS devices, so old queued
messages cannot silently repopulate a reset ledger. Device sessions are independent of PWA logout.

## Receive a message: `POST /api/sms/ingest`

Headers:

```http
Authorization: Bearer DEVICE_TOKEN
X-Requested-With: squirl
Content-Type: application/json
```

Example body (fictional data):

```json
{
  "eventId": "stable-device-event-id-001",
  "sender": "REPLACE-SBI-SENDER",
  "body": "Dear UPI user A/C X1111 debited by 1.00 on date 15Nov26 trf to SAMPLE SHOP Refno 900000000001 If not u? call-1800000000 for other services-1800000001-SBI",
  "receivedAt": "2026-11-15T13:31:00+05:30"
}
```

The example date must be replaced with the actual receipt timestamp when testing. `receivedAt`
must be an ISO datetime with an offset or Z, after device pairing, and not more than five minutes
in the future. Preserve it, `eventId`, sender and body unchanged across retries. A bank transaction
date must be within seven calendar days before receipt, using India time; otherwise it requires
review. This is for new messages after pairing, not historical inbox backfill. Bodies are limited
to 1,500 characters; unknown fields (including `userId`, category, bank and amount) are rejected.

The ingestion response contains only `{ id?, status, reason?, transactionId? }`, not ledger data.
States:

| Status | Meaning |
|---|---|
| `captured` | A new provisional ledger transaction with `source: "sms"`. |
| `reconciled` | Evidence attached to an existing matching statement payment. |
| `duplicate` | Message/payment already received; no second ledger entry. |
| `review` | Unknown template, account mismatch, suspect date, or ambiguous/conflicting payment. No new ledger entry. |
| `ignored` | Unapproved sender, OTP/secret, recognized failed/pending request, or a previously deleted SMS payment. |

Unapproved senders are discarded without retaining content. OTP bodies are never retained.
Recognized warning footers such as "If not u?" do not mean a payment failed, and their links are
never opened. Unknown messages from approved bank senders are retained in the encrypted database
for review. Sender/body capture is evidence supplied by a paired device, not cryptographic proof
that a bank executed a payment.

Use a stable device event ID for delivery retries. Reusing an ID with a different payload returns
409 `SMS_EVENT_REUSED`. Separate broadcasts/devices are also deduplicated by message content or
financial identity. A 200 response is an acknowledgement even for `review`/`ignored`: don't resend it
endlessly. Retry network failures/5xx with backoff, honor 429, and require re-pairing on
401 `SMS_AUTH_REQUIRED`. The server limits ingestion to 120 requests/device/minute and pairing to
10 attempts/user/hour (at most five non-revoked devices). The companion retains an encrypted offline queue.

## Ledger and statement behavior

- Successful parsed messages are normalized to a UPI narration with bank account, direction,
  amount in paise, transaction date and 12-digit UPI reference. No LLM runs during parsing/ingestion.
- Existing local merchant/contact rules can categorize the entry. Automatic AI category jobs
  exclude `source='sms'`. After a statement upgrades the entry to `import`, normal statement
  categorization applies. Explicitly requested AI reports still follow the person's AI settings.
- Exact user/bank/date/amount/direction/reference matches reconcile in either arrival order.
  An SMS entry is upgraded in place when its statement arrives, preserving its ID, rowid, notes,
  tags and category choices. `stats.reconciled` counts upgrades; `stats.inserted` counts new rows.
- Never match on just amount/date or the recipient's name. The same amount with two different
  references remains two transactions. A usable reference is required for automatic reconciliation;
  statement rows missing a reference in both the reference field and UPI narration require manual
  duplicate resolution. SMS capture cannot guarantee every UPI payment has an alert.
- Ambiguous/conflicting statement evidence is authoritative in ledger totals. Its conflicting
  provisional SMS transaction is soft-archived, retaining evidence and annotations for review.
  Review events expose `previousTransaction` when applicable. No uncertain match is silently merged.
- A uniquely paired debit/credit on two configured own bank accounts, with identical reference,
  date and amount, receives one `transferId` and a transfer category. Both bank ledger legs remain;
  existing "Moved" totals still sum both legs (a ₹1 transfer can display ₹2 moved). Explicit category
  choices are preserved. No inference is made from the counterparty's name alone.
- Payment facts on SMS/statement rows are read-only; notes, tags and categories remain editable.
  The ledger API exposes `source`, `transferId` and `smsEvidenceCount` (but no raw SMS body).
- Undoing an import restores independently evidenced payments to SMS rows rather than removing
  them. Re-delivery never resurrects an SMS payment the user deleted. Evidence stays archived on
  financial reset; account deletion removes it through normal owner-scoped cascades.

## Review endpoints (signed-in session)

- `GET /api/sms/events?status=review&page=1&limit=50`: bounded, owner-only event history, including
  original bank text and parsed facts where available. `data.items` plus normal pagination `meta`.
- `POST /api/sms/events/:id/dismiss`: dismiss an unresolved event.
- `POST /api/sms/events/:id/confirm`: explicitly confirm the facts below against the event's mapped
  bank. The same exact-match and account/date guards apply. An ambiguous match remains in review;
  it is never guessed. Confirming a quarantined event against one unique statement preserves its
  tags and non-conflicting annotations. Review `previousTransaction` before confirming if both
  entries have different notes: the existing statement notes are preserved.

```json
{
  "date": "2026-11-15",
  "amount": 1,
  "type": "debit",
  "refNo": "900000000001",
  "last4": "1111",
  "description": "UPI payment to SAMPLE SHOP"
}
```

SBI credits/refunds and other unrecognized formats remain review-only until there are representative
examples and tests. No sender/account is enabled automatically. Android source and build instructions
are included, rather than a prebuilt APK. An already-open frontend does not
poll SMS ingestion; reload/refetch the ledger to see a newly submitted event.

## Validation

Run `npm run test:sms`. It uses fictional messages, an in-memory database and a temporary loopback
HTTP server, with no external requests, real SMS, production keys, or real database access.
