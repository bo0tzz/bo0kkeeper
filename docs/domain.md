# Domain notes

Bookkeeping concepts that shape the system. Public-safe — no real names or numbers.

## Single legal entity, two trade names

One zzp / KvK registration holds two trade names (one for IT services, one for 3D printing/design work). Same VAT ID, same IBAN. Trade name affects:

- Invoice header (legal-entity name displayed)
- Possibly the Typst template used (different visual identity)

Trade name is a per-client default in the `clients` table, overridable at compose time.

## kasstelsel (cash-basis BTW)

The user accounts on **cash basis**, not accrual:

- Sheet row date = **payment received date**, not invoice issue date.
- BTW is reported in the quarter when payment was **received**, regardless of when the invoice was issued.
- An invoice issued in December but paid in January goes in Q1 of the following year on the BTW return.

The `events` payload preserves all timestamps; the system always uses payment-received date when writing sheet rows.

## Invoice numbering

`YYYY/NNN`, year-restarted, three-digit zero-padded:

- `2026/001`, `2026/002`, …, `2026/099`, `2026/100`.
- **Single sequence shared across all clients**: the same counter advances regardless of client (the regular US client and occasional domestic clients interleave).
- **Gap-free** per Belastingdienst rules. Allocation must succeed-or-not-at-all; never reserve an invoice number that might be discarded.
- Allocation: `UPDATE invoice_number_sequence SET last_number = last_number + 1 WHERE year = ? RETURNING ...`. Wrapped in the same transaction that writes the invoice + paperless doc reference. Paperless write happens **before** committing — guarantees the canonical record exists externally even if Postgres is lost mid-flow.

## Client classification

| Class | BTW treatment | Examples |
|---|---|---|
| `non_eu` | Outside scope of EU VAT | The regular US client |
| `eu_reverse_charge` | BTW reverse-charge (B2B, valid VAT ID exchanged) | Some EU vendors when buying |
| `eu` | Standard Dutch BTW applies | EU vendors selling B2C-style |
| `domestic` | Standard Dutch BTW (21% / 9% / 0%) | Occasional Dutch clients |

For *income*: only `non_eu` and `domestic` are encountered in practice. For *expenses* (purchases): all four.

## Two income flows

### Wise income (payment-triggered)

The payment provider pushes USD on its own cadence (typically twice a month). The user reacts:

1. Wise webhook fires (`balances.credit`).
2. System idempotent-inserts event, enqueues job, returns 200.
3. Worker creates an "inbound credit" review item; admin UI surfaces it.
4. User reviews → system drafts a single USD→EUR transfer in Wise (one operation; Wise handles the conversion implicitly).
5. User SCA-taps in the Wise app.
6. Wise webhook fires (`transfers.state_change` → `outgoing_payment_sent`) with FX rate locked.
7. Admin UI surfaces invoice composition. User confirms (single line / multi-line for paycheck + bonus + reimbursement).
8. System allocates next invoice number, renders PDF (Typst), pushes to paperless, writes sheet row.

Invoice EUR amount = post-FX amount that landed; invoice date = end of work period (e.g. 15th or end-of-month).

### Domestic income (invoice-triggered)

User composes the invoice **first**, sends it manually, payment arrives later:

1. User opens admin UI invoice composer, picks client, adds line items, sets BTW rate, optionally pastes a payment-link URL.
2. User clicks Issue → system allocates next invoice number, renders PDF (Typst), pushes to paperless. **No sheet row yet.**
3. User emails the PDF manually (auto-email is future scope).
4. Days later, the bank tx arrives.
5. System matches bank tx → invoice (by amount + counterparty + invoice number in description).
6. Sheet row is written on match, dated to bank tx (kasstelsel).

## Expense pipeline

1. Receipt arrives in paperless-ngx (email forward, scan, etc.).
2. paperless OCR + post-consume webhook.
3. System creates a `pending_expense` event. OCR-extracted fields (vendor, date, amount, BTW) are *suggestions only*; never auto-write to the sheet.
4. Admin UI weekly review queue: user edits fields inline, approves.
5. Approval → sheet row.

OCR is fallible (especially BTW splits: 9% / 21% / 0%). Two-stage review is non-negotiable.

## Bank as anchor

Every meaningful transaction has a bank row. The bank-tx review queue is the canonical entry point for cases without an associated document (bank fees, salary to personal account, occasional cash-equivalent stuff). Such cases get categorized inline as "no document" rather than via a separate manual-entry path.

### Matching heuristics

- **Wise outbound (TXN-NNNN ref) → bank inbound**: exact-string match on `TXN-NNNN` reference embedded in bank description. Auto-link, high confidence.
- **Domestic invoice → bank inbound**: amount match + invoice number in description (when present) → auto-link high confidence; amount + counterparty + date proximity → auto-link low confidence; otherwise → manual review.
- **Bank debit → paperless document**: amount + ±5 days date + vendor fuzzy match on paperless correspondent.
- **Everything else**: manual review queue.

Match decisions are themselves events, queryable for spot-checks.

## Quarterly aggregator

Reads sheet rows, filters to quarter, maps each row's category to a BTW rubriek, populates the accountant's Excel template. Validation gates (refuses to produce output until clean):

- All rows have unambiguous BTW status.
- All categories known.
- Totals across categories equal totals across rubrieken.
- No orphan transactions in the period.
- Every transaction has either a paperless link or an explicit "no document" justification.

Yearly is out-of-scope for the system: the accountant combines quarterlies.

## Sheet shape (existing convention to preserve)

| Date | Id | Type | Location | From | To | Amount | VAT % | VAT | Notes |
|---|---|---|---|---|---|---|---|---|---|

- Tabs per quarter, named `YYYY QN` (e.g. `2026 Q2`).
- Date format `DD/MM/YYYY`.
- Amount in EUR (USD only on the invoice for Non-EU clients).
- Type ∈ {Income, Transfer, Purchase, Expense, Payout, blank}; some Belastingdienst-related entries have blank type.
- Location ∈ {Domestic, EU, Non-EU}.
- VAT % can be `21%` or `21.00%` in existing data; system writes one canonical format, tolerates both on read.
- Existing rows have no `source` audit tag. **A new `source` column is added** (e.g. `wise:transfer/12345`, `paperless:doc/678`, `bank:tx/abc`) for system-written rows; legacy rows have it empty.
- System writes only append-to-bottom of current quarter tab. New quarter tab created automatically when needed.

## Special cases worth not forgetting

- **Recurring bank fees**: SNS `Klantonderzoek` (~€1.82/mo with 21% BTW), `Kosten rekening` (~€7.95/mo no BTW), occasional `Kosten betaalverzoek` (€0.15). Recurring; categorize once, recognize automatically.
- **Personal-account leg**: salary and expense reimbursements flow business → personal. Type=Payout. Reimbursements (Wise→Personal or SNS→Personal) pair with the original expense paid out of personal.
- **Belastingdienst flows**: BTW teruggaaf (incoming refund), Bijdrage ZVW (outgoing tax payment). Type may be blank; categorize explicitly.
- **Activation-style transfers**: net-zero in/out (e.g. €20 to activate Wise, refunded). Type=Transfer with note.
- **Reimbursements as separate one-off invoices**: occasionally the regular client reimburses an expense (e.g. event travel) as a distinct payment with its own invoice.
- **Multi-line invoices**: paycheck + bonus + reimbursement may share one Wise inbound; each becomes a line on the same invoice (one paycheck = one invoice; bonus and reimbursements as additional lines). One sheet row per invoice.
- **Multi-paycheck inbound**: when payments accumulate (procrastination), one Wise transfer can cover multiple paychecks → multiple invoices, multiple sheet rows, all backed by the same Wise transfer.
- **Mixed-component domestic expenses**: e.g. rental + refundable deposit (`borg`). BTW math is non-trivial; user manually decides splits. System tolerates BTW that doesn't back-solve from `amount × rate / (1+rate)`.
