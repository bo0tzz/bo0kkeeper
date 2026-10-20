/**
 * bo0kkeeper API
 * 0.1.0
 * DO NOT MODIFY - This file has been generated using oazapfts.
 * See https://www.npmjs.com/package/oazapfts
 */
import * as Oazapfts from "@oazapfts/runtime";
import * as QS from "@oazapfts/runtime/query";
export const defaults: Oazapfts.Defaults<Oazapfts.CustomHeaders> = {
    headers: {},
    baseUrl: "/api"
};
const oazapfts = Oazapfts.runtime(defaults);
export const servers = {
    server1: "/api"
};
export type InvoiceUnmatchedWarningDto = {
    kind: Kind;
    count: number;
    sampleNumbers: string[];
};
export type ExpensePendingReviewWarningDto = {
    kind: Kind2;
    count: number;
    sampleVendors: string[];
};
export type ExpenseLowConfidenceMatchWarningDto = {
    kind: Kind3;
    count: number;
    sampleIds: string[];
};
export type QuarterlyAggregateResponseDto = {
    year: number;
    quarter: number;
    periodStart: string;
    periodEnd: string;
    income: {
        byClass: {
            non_eu: {
                invoiceCount: number;
                grossEurMinor: string;
                btwEurMinor: string;
            };
            eu: {
                invoiceCount: number;
                grossEurMinor: string;
                btwEurMinor: string;
            };
            eu_reverse_charge: {
                invoiceCount: number;
                grossEurMinor: string;
                btwEurMinor: string;
            };
            domestic: {
                invoiceCount: number;
                grossEurMinor: string;
                btwEurMinor: string;
            };
        };
        totalGrossEurMinor: string;
        totalBtwEurMinor: string;
    };
    expenses: {
        grossEurMinor: string;
        deductibleBtwEurMinor: string;
    };
    netBtwEurMinor: string;
    warnings: (InvoiceUnmatchedWarningDto | ExpensePendingReviewWarningDto | ExpenseLowConfidenceMatchWarningDto)[];
    closedAt: string | null;
};
export type ClosePeriodDto = {
    notes?: string;
};
export type ClosePeriodResponseDto = {
    closedAt: string;
};
export type ReopenPeriodResponseDto = {
    reopened: true;
};
export type AuthMeDto = {
    sub: string;
    email?: string;
    name?: string;
};
export type BankingAspspsResponseDto = {
    aspsps: {
        name: string;
        country: string;
        psuTypes: PsuTypes[];
    }[];
};
export type BankingStartAuthDto = {
    aspspName: string;
    aspspCountry: string;
    psuType?: PsuType;
};
export type BankingStartAuthResponseDto = {
    sessionId: string;
    redirectUrl: string;
};
export type BankingSessionResponseDto = {
    id: string;
    status: string;
    aspspName: string;
    aspspCountry: string;
    psuType: string;
    expiresAt: string | null;
    lastSyncedAt: string | null;
    accounts: {
        uid: string;
        iban?: string | null;
        currency: string;
        name?: string | null;
        product?: string | null;
        balance?: {
            amountMinor: string;
            currency: string;
            asOf: string;
        } | null;
        expectedBalanceMinor?: string | null;
        balanceDiscrepancyMinor?: string | null;
    }[];
    createdAt: string;
};
export type BankingSyncResponseDto = {
    enqueued: true;
};
export type BankTransactionResponseDto = {
    id: string;
    source: string;
    externalId: string;
    txDate: string;
    amountMinor: string;
    currency: string;
    counterpartyName: string | null;
    counterpartyIban: string | null;
    description: string;
    matchedTransferId: string | null;
    matchedInvoiceId: string | null;
    matchedExpenseId: string | null;
    matchedTransferLabel: string | null;
    matchedInvoiceLabel: string | null;
    matchedExpenseLabel: string | null;
    matchedAt: string | null;
    matchConfidence: string | null;
    category: (BankTxCategory) | null;
};
export type ListBankTransactionsResponseDto = {
    items: BankTransactionResponseDto[];
    total: number;
};
export type BankTxMatchCandidatesDto = {
    transfers: {
        id: string;
        wiseTransferId: string;
        ourReference: string | null;
        state: string;
        sourceCurrency: string;
        sourceAmountMinor: string;
        targetCurrency: string;
        targetAmountMinor: string;
        createdAt: string;
    }[];
    invoices: {
        id: string;
        "number": string;
        totalMinor: string;
        currency: string;
        issuedAt: string;
        clientName: string | null;
    }[];
    expenses: {
        id: string;
        vendor: string;
        amountMinor: string;
        currency: string;
        expenseDate: string;
        status: string;
    }[];
};
export type BankTxSetMatchDto = {
    "type": Type;
    targetId: string;
};
export type BankTxSetCategoryDto = {
    category: (BankTxCategory) | null;
};
export type ClientResponseDto = {
    id: string;
    name: string;
    "class": Class;
    tradeName: TradeName;
    address: {
        [key: string]: any;
    };
    vatId: string | null;
    wiseSenderPattern: string | null;
    defaultDescription: string;
    createdAt: string;
    updatedAt: string;
};
export type ClientCreateDto = {
    name: string;
    "class": Class;
    tradeName: TradeName;
    address?: {
        line1?: string;
        line2?: string;
        city?: string;
        postalCode?: string;
        countryCode?: string;
        [key: string]: any;
    };
    vatId?: string;
    wiseSenderPattern?: string;
    defaultDescription?: string;
};
export type ClientUpdateDto = {
    name?: string;
    "class"?: Class;
    tradeName?: TradeName;
    address?: {
        line1?: string;
        line2?: string;
        city?: string;
        postalCode?: string;
        countryCode?: string;
        [key: string]: any;
    };
    vatId?: string | null;
    wiseSenderPattern?: string | null;
    defaultDescription?: string;
};
export type ClientDeleteResponseDto = {
    deleted: boolean;
};
export type EventResponseDto = {
    id: string;
    source: Source;
    eventType: string;
    externalId: string;
    occurredAt: string;
    receivedAt: string;
    payload: {
        [key: string]: any;
    };
    status: Status;
    attempts: number;
    lastError: {
        [key: string]: any;
    } | null;
    processedAt: string | null;
    correlationId: string | null;
    relatedEventId: string | null;
};
export type ListEventsResponseDto = {
    items: EventResponseDto[];
    total: number;
    hasMore: boolean;
};
export type ExpenseResponseDto = {
    id: string;
    paperlessDocId: string;
    vendor: string;
    expenseDate: string;
    amountMinor: string;
    currency: string;
    btwRateBps: number | null;
    btwMinor: string | null;
    locationClass: LocationClass;
    category: string;
    status: Status2;
    reviewedAt: string | null;
    notes: string | null;
    sourceEventId: string | null;
    matchedBankTxId: string | null;
    wiseTransferId: string | null;
    eurAmountMinor: string | null;
    fxRate: string | null;
    createdAt: string;
    updatedAt: string;
};
export type ListExpensesResponseDto = {
    items: ExpenseResponseDto[];
    total: number;
    hasMore: boolean;
};
export type ExpenseUpdateDto = {
    vendor?: string;
    expenseDate?: string;
    amountMinor?: string;
    currency?: string;
    btwRateBps?: number | null;
    btwMinor?: string | null;
    locationClass?: LocationClass;
    category?: string;
    notes?: string | null;
    wiseTransferId?: string | null;
};
export type ExpenseApproveDto = {
    vendor?: string;
    expenseDate?: string;
    amountMinor?: string;
    currency?: string;
    btwRateBps?: number | null;
    btwMinor?: string | null;
    locationClass?: LocationClass;
    category?: string;
    notes?: string | null;
    wiseTransferId?: string | null;
};
export type RescanPaperlessResponseDto = {
    scanned: number;
    enqueued: number;
    alreadyIngested: number;
    droppedBeforeCutover: number;
};
export type ExpenseRejectDto = {
    notes?: string;
};
export type InvoiceListItemDto = {
    id: string;
    "number": string;
    issuedAt: string;
    clientId: string;
    clientName: string | null;
    currency: string;
    totalMinor: string;
    eurTotalMinor: string | null;
    btwRateBps: number | null;
    btwMinor: string | null;
    paperlessDocId: string | null;
    paid: boolean;
};
export type ListInvoicesResponseDto = {
    items: InvoiceListItemDto[];
    total: number;
};
export type InvoiceResponseDto = {
    id: string;
    "number": string;
    clientId: string;
    issuedAt: string;
    periodStart: string | null;
    periodEnd: string | null;
    currency: string;
    totalMinor: string;
    eurTotalMinor: string | null;
    fxRate: string | null;
    btwRateBps: number | null;
    btwMinor: string | null;
    paperlessDocId: string | null;
    sourceEventId: string | null;
    createdAt: string;
    updatedAt: string;
    lines: {
        id: string;
        ordinal: number;
        description: string;
        unitLabel: string | null;
        quantity: string | null;
        lineTotalMinor: string;
    }[];
};
export type InvoiceComposeDto = {
    clientId: string;
    issuedAt: string;
    periodStart?: string;
    periodEnd?: string;
    currency: string;
    eurTotalMinor?: string;
    fxRate?: string;
    btwRateBps?: number;
    sourceEventId?: string;
    lines: {
        description: string;
        unitLabel?: string;
        quantity?: string;
        lineTotalMinor: string;
    }[];
};
export type InvoiceComposeResponseDto = {
    invoice: InvoiceResponseDto;
};
export type WiseInvoicePrefillDto = {
    wiseTransferId: string;
    currency: string;
    totalMinor: string;
    eurTotalMinor: string;
    ourReference: string | null;
    suggestedClientId: string | null;
    suggestedPeriodStart: string | null;
    suggestedPeriodEnd: string | null;
    suggestedLineDescription: string;
};
export type InvoiceComposeFromWiseDto = {
    clientId: string;
    issuedAt: string;
    periodStart?: string;
    periodEnd?: string;
    lines: {
        description: string;
        unitLabel?: string;
        quantity?: string;
        lineTotalMinor: string;
    }[];
};
export type SettingsResponseDto = {
    issuer: {
        kvk: string;
        vatId: string;
        addressLine1: string;
        postalCode: string;
        city: string;
        country: string;
        iban: string;
    };
    paperless: {
        expenseTags: string[];
        outgoingInvoiceTags: string[];
    };
    updatedAt: string;
};
export type UpdateSettingsDto = {
    issuer?: {
        kvk?: string;
        vatId?: string;
        addressLine1?: string;
        postalCode?: string;
        city?: string;
        country?: string;
        iban?: string;
    };
    paperless?: {
        expenseTags?: string[];
        outgoingInvoiceTags?: string[];
    };
};
export type PaperlessTagCheckDto = {
    tags: string[];
};
export type PaperlessTagCheckResponseDto = {
    results: {
        name: string;
        exists: boolean;
        id: number | null;
    }[];
};
export type SystemInfoDto = {
    version: string;
    cutoverDate: string | null;
    ingestionEnabled: boolean;
    descriptionPlaceholders: string[];
};
export type IntegrationsResponseDto = {
    checks: {
        id: string;
        name: string;
        status: Status3;
        configured: boolean;
        lastActivityAt: string | null;
        message: string;
    }[];
};
export type RetrySheetWritesResponseDto = {
    enqueued: true;
};
export type SheetWriteStatusDto = {
    staleCount: number;
};
export type WiseWebhookDto = {
    event_type: string;
    schema_version?: string;
    sent_at?: string;
    subscription_id?: string;
    data: {
        occurred_at?: string;
        resource?: {
            id?: number | string;
            "type"?: string;
            profile_id?: number | string;
            account_id?: number | string;
            [key: string]: any;
        };
        [key: string]: any;
    };
};
export type WebhookIngestResponseDto = {
    ingested: boolean;
};
export type PaperlessWebhookDto = {
    document_id?: string | number;
    id?: string | number;
    doc_pk?: string | number;
    document_url?: string;
    correspondent?: string;
    correspondent_name?: string;
    created?: string;
    created_date?: string;
    event_type?: string;
};
export type WiseTransferListItemDto = {
    id: string;
    wiseTransferId: string;
    direction: string;
    state: string;
    sourceAmountMinor: string;
    sourceCurrency: string;
    targetAmountMinor: string;
    targetCurrency: string;
    fxRate: string | null;
    feeMinor: string;
    feeCurrency: string;
    ourReference: string | null;
    correlationId: string | null;
    linkedInvoiceId: string | null;
    linkedInvoiceNumber: string | null;
};
export type ListWiseTransfersResponseDto = {
    items: WiseTransferListItemDto[];
    total: number;
};
export type DraftFromEventDto = {
    ourReference?: string;
    allowUnderCredit?: boolean;
};
export type WiseTransferResponseDto = {
    id: string;
    wiseTransferId: string;
    direction: string;
    state: string;
    sourceAmountMinor: string;
    sourceCurrency: string;
    targetAmountMinor: string;
    targetCurrency: string;
    fxRate: string | null;
    feeMinor: string;
    feeCurrency: string;
    ourReference: string | null;
    correlationId: string | null;
};
export type WiseReconcileResponseDto = {
    enqueued: true;
};
export type WiseAwaitingInvoiceCountDto = {
    count: number;
};
/**
 * Compute the BTW-aangifte aggregate for one quarter. Read-only — the data
 * lives in invoices/expenses/bank_transaction; this endpoint just rolls it
 * up. Warnings field flags filings that need user attention before submit.
 */
export function getQuarterlyAggregate({ year, quarter }: {
    year: string;
    quarter: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QuarterlyAggregateResponseDto;
    }>(`/api/aggregator/quarterly${QS.query(QS.explode({
        year,
        quarter
    }))}`, {
        ...opts
    }));
}
/**
 * Mark a quarter as filed with the accountant. Doesn't block edits to rows
 * inside the period (corrections happen) — the UI surfaces a "closed" badge
 * + warning so the user notices when they're about to touch settled data.
 */
export function closePeriod({ year, quarter, closePeriodDto }: {
    year: string;
    quarter: string;
    closePeriodDto: ClosePeriodDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClosePeriodResponseDto;
    }>(`/api/aggregator/quarterly/close${QS.query(QS.explode({
        year,
        quarter
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: closePeriodDto
    })));
}
export function reopenPeriod({ year, quarter }: {
    year: string;
    quarter: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ReopenPeriodResponseDto;
    }>(`/api/aggregator/quarterly/close${QS.query(QS.explode({
        year,
        quarter
    }))}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Stream the accountant's "Bookkeeping list" XLSX for the given quarter.
 * Layout matches the existing manually-typed file the user has been
 * shipping to their accountant: outbound + inbound invoice sections,
 * each split by location class (Domestic / EU / Non EU).
 */
export function exportQuarterly({ year, quarter }: {
    year: string;
    quarter: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api/aggregator/quarterly/export.xlsx${QS.query(QS.explode({
        year,
        quarter
    }))}`, {
        ...opts
    }));
}
export function login({ returnTo }: {
    returnTo?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api/auth/login${QS.query(QS.explode({
        return_to: returnTo
    }))}`, {
        ...opts
    }));
}
export function callback({ code, state, error, errorDescription }: {
    code: string;
    state: string;
    error?: string;
    errorDescription?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api/auth/callback${QS.query(QS.explode({
        code,
        state,
        error,
        error_description: errorDescription
    }))}`, {
        ...opts
    }));
}
/**
 * Silent refresh — the API client fires this on a 401 from any other
 * endpoint and retries the original request once on success. No
 * @Authenticated decorator: the id_token is expired by definition;
 * the refresh-token cookie (path-scoped to this endpoint) is the only
 * credential we accept here.
 */
export function refresh(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/api/auth/refresh", {
        ...opts,
        method: "POST"
    }));
}
export function logout(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/api/auth/logout", {
        ...opts,
        method: "POST"
    }));
}
export function getMe(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AuthMeDto;
    }>("/api/auth/me", {
        ...opts
    }));
}
/**
 * Bank catalog for the picker on /banking. Proxies Enable Banking's
 * `/aspsps`; that endpoint needs a JWT we mint server-side, so the SPA
 * goes through us. Filterable by country (default NL).
 */
export function listAspsps({ country }: {
    country?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankingAspspsResponseDto;
    }>(`/api/banking/aspsps${QS.query(QS.explode({
        country
    }))}`, {
        ...opts
    }));
}
export function startAuth({ bankingStartAuthDto }: {
    bankingStartAuthDto: BankingStartAuthDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankingStartAuthResponseDto;
    }>("/api/banking/auth/start", oazapfts.json({
        ...opts,
        method: "POST",
        body: bankingStartAuthDto
    })));
}
export function callback2({ error, state, code }: {
    error?: any;
    state?: any;
    code?: any;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api/banking/auth/callback${QS.query(QS.explode({
        error,
        state,
        code
    }))}`, {
        ...opts
    }));
}
export function getLatestSession(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankingSessionResponseDto;
    }>("/api/banking/session", {
        ...opts
    }));
}
/**
 * Admin "Sync now" — enqueue an immediate banking-sync job. We pass the
 * caller's IP through as PSU-IP-Address so Enable Banking marks the call
 * as user-online (exempt from the 4/day PSD2 background cap).
 */
export function sync(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankingSyncResponseDto;
    }>("/api/banking/sync", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Paginated bank_transaction list with optional filters. Drives /banking.
 */
export function listTransactions({ dateFrom, dateTo, status, page, limit }: {
    dateFrom?: string;
    dateTo?: string;
    status?: string;
    page?: string;
    limit?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ListBankTransactionsResponseDto;
    }>(`/api/banking/transactions${QS.query(QS.explode({
        dateFrom,
        dateTo,
        status,
        page,
        limit
    }))}`, {
        ...opts
    }));
}
/**
 * Candidates for manual link. Defaults to recent rows of each type when no
 * query is given; with a query, filters by the most useful identifier per
 * type (wise reference, invoice number, vendor name).
 */
export function matchCandidates({ q }: {
    q?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankTxMatchCandidatesDto;
    }>(`/api/banking/match-candidates${QS.query(QS.explode({
        q
    }))}`, {
        ...opts
    }));
}
/**
 * Operator-driven manual match. Sets confidence=manual, runs sheet append.
 */
export function setMatch({ id, bankTxSetMatchDto }: {
    id: string;
    bankTxSetMatchDto: BankTxSetMatchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankTransactionResponseDto;
    }>(`/api/banking/transactions/${encodeURIComponent(id)}/match`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: bankTxSetMatchDto
    })));
}
/**
 * Operator unlink — clears all match fields.
 */
export function clearMatch({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankTransactionResponseDto;
    }>(`/api/banking/transactions/${encodeURIComponent(id)}/match`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Tag a row with a manual category (tax / self_transfer / fee / ignored)
 * — or pass `null` to clear. Categorized rows are excluded from the
 * unmatched warning surface.
 */
export function setCategory({ id, bankTxSetCategoryDto }: {
    id: string;
    bankTxSetCategoryDto: BankTxSetCategoryDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankTransactionResponseDto;
    }>(`/api/banking/transactions/${encodeURIComponent(id)}/category`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: bankTxSetCategoryDto
    })));
}
/**
 * Re-run the matcher against an existing row using current rules. Used to
 * pull rows in their pre-rule-change state into the new state without
 * out-of-band SQL. Initial scope: categorised-but-not-matched rows.
 * Already-matched rows must be unmatched first.
 */
export function reprocess({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BankTransactionResponseDto;
    }>(`/api/banking/transactions/${encodeURIComponent(id)}/reprocess`, {
        ...opts,
        method: "POST"
    }));
}
export function listClients(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClientResponseDto[];
    }>("/api/clients", {
        ...opts
    }));
}
export function createClient({ clientCreateDto }: {
    clientCreateDto: ClientCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClientResponseDto;
    }>("/api/clients", oazapfts.json({
        ...opts,
        method: "POST",
        body: clientCreateDto
    })));
}
export function getClient({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClientResponseDto;
    }>(`/api/clients/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
export function updateClient({ id, clientUpdateDto }: {
    id: string;
    clientUpdateDto: ClientUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClientResponseDto;
    }>(`/api/clients/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: clientUpdateDto
    })));
}
export function deleteClient({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClientDeleteResponseDto;
    }>(`/api/clients/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
export function listEvents({ source, eventType, status, since, limit, offset }: {
    source?: string;
    eventType?: string;
    status?: string;
    since?: any;
    limit?: string;
    offset?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ListEventsResponseDto;
    }>(`/api/events${QS.query(QS.explode({
        source,
        eventType,
        status,
        since,
        limit,
        offset
    }))}`, {
        ...opts
    }));
}
export function getEvent({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: EventResponseDto;
    }>(`/api/events/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Drop an event out of the pending inbox without acting on it. Records a
 * `system/event.dismissed` audit event so the reason survives in history.
 * Common case: Wise `balances#credit` below the transfer minimum (e.g. a
 * 41-cent cashback) — leave the balance to accumulate; dismiss the event
 * so it stops cluttering the inbox.
 */
export function dismissEvent({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: EventResponseDto;
    }>(`/api/events/${encodeURIComponent(id)}/dismiss`, {
        ...opts,
        method: "POST"
    }));
}
export function listExpenses({ status, locationClass, $from, to, matched, limit, offset }: {
    status?: string;
    locationClass?: string;
    $from?: string;
    to?: string;
    matched?: string;
    limit?: string;
    offset?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ListExpensesResponseDto;
    }>(`/api/expenses${QS.query(QS.explode({
        status,
        locationClass,
        "from": $from,
        to,
        matched,
        limit,
        offset
    }))}`, {
        ...opts
    }));
}
export function getExpense({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ExpenseResponseDto;
    }>(`/api/expenses/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Patch a pending expense without changing its status — used while reviewing
 * (filling in amount, BTW split, category) before the user commits to approve.
 */
export function updateExpense({ id, expenseUpdateDto }: {
    id: string;
    expenseUpdateDto: ExpenseUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ExpenseResponseDto;
    }>(`/api/expenses/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: expenseUpdateDto
    })));
}
/**
 * Approve a pending expense. Body fields are merged in atomically with the
 * status flip, so the UI can submit "save + approve" in a single request.
 *
 * Sheet row writes here IFF the expense already has a bank-tx linked
 * (the other half of the `matched ∧ approved` condition); otherwise this
 * is a pure DB state change and the sheet row fires later when a bank-tx
 * link lands. Approved-but-unmatched expenses surface on the dashboard
 * tile so they don't fall through the cracks.
 */
export function approveExpense({ id, expenseApproveDto }: {
    id: string;
    expenseApproveDto: ExpenseApproveDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ExpenseResponseDto;
    }>(`/api/expenses/${encodeURIComponent(id)}/approve`, oazapfts.json({
        ...opts,
        method: "POST",
        body: expenseApproveDto
    })));
}
/**
 * Redirect to the paperless document UI for this expense's source receipt.
 * Every expense has a paperlessDocId by construction (created from a
 * paperless workflow webhook), so this should never 404 in normal use.
 */
export function paperlessRedirect({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api/expenses/${encodeURIComponent(id)}/paperless`, {
        ...opts
    }));
}
/**
 * Operator-driven backfill — walk paperless's REST API for documents that
 * carry every configured gate tag and were created on or after CUTOVER_DATE,
 * then synthesize a webhook event per doc through the existing pipeline.
 *
 * Use cases:
 *  - paperless's webhook delivery dropped (no retry on transport-level
 *    failures past 3 HTTP-error retries).
 *  - operator tagged a doc AFTER the workflow trigger window — Document
 *    Updated re-fires for live updates only.
 *  - first time wiring up the workflow against an inbox of pre-tagged docs.
 *
 * Idempotent: events are keyed on `paperless:<doc_id>`, expenses on
 * `paperlessDocId`. Re-running is safe.
 */
export function rescanPaperless(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RescanPaperlessResponseDto;
    }>("/api/expenses/rescan-paperless", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Reject the expense (paperless doc was misclassified, isn't a business expense, etc).
 */
export function rejectExpense({ id, expenseRejectDto }: {
    id: string;
    expenseRejectDto: ExpenseRejectDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ExpenseResponseDto;
    }>(`/api/expenses/${encodeURIComponent(id)}/reject`, oazapfts.json({
        ...opts,
        method: "POST",
        body: expenseRejectDto
    })));
}
export function getHealth(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/api/health", {
        ...opts
    }));
}
export function getReady(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/api/health/ready", {
        ...opts
    }));
}
/**
 * Paginated invoice list. Drives the /invoices list view.
 */
export function listInvoices({ year, status, page, limit }: {
    year?: string;
    status?: string;
    page?: string;
    limit?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ListInvoicesResponseDto;
    }>(`/api/invoices${QS.query(QS.explode({
        year,
        status,
        page,
        limit
    }))}`, {
        ...opts
    }));
}
export function getInvoice({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: InvoiceResponseDto;
    }>(`/api/invoices/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Compose, issue, render, and archive an invoice in one shot. Returns the
 * persisted row + paperless metadata when the upload succeeded; the PDF
 * itself is on disk inside paperless and addressable via paperlessDocId.
 */
export function composeInvoice({ invoiceComposeDto }: {
    invoiceComposeDto: InvoiceComposeDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: InvoiceComposeResponseDto;
    }>("/api/invoices/compose", oazapfts.json({
        ...opts,
        method: "POST",
        body: invoiceComposeDto
    })));
}
/**
 * Prefill data for the "compose invoice from completed Wise transfer" form.
 * UI calls this before opening the composer to hydrate currency, amounts,
 * and a suggested client. Validates the transfer is invoiceable (outgoing,
 * outgoing_payment_sent, not already invoiced) so the UI doesn't surface
 * the action for transfers that wouldn't accept a compose.
 */
export function getWisePrefill({ wiseTransferId }: {
    wiseTransferId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WiseInvoicePrefillDto;
    }>(`/api/invoices/wise-prefill/${encodeURIComponent(wiseTransferId)}`, {
        ...opts
    }));
}
/**
 * Compose an invoice from a completed outbound Wise transfer. Currency +
 * amounts come from the transfer (user doesn't enter FX); the body
 * supplies client + period + line splits.
 */
export function composeInvoiceFromWise({ wiseTransferId, invoiceComposeFromWiseDto }: {
    wiseTransferId: string;
    invoiceComposeFromWiseDto: InvoiceComposeFromWiseDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: InvoiceComposeResponseDto;
    }>(`/api/invoices/compose-from-wise/${encodeURIComponent(wiseTransferId)}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: invoiceComposeFromWiseDto
    })));
}
/**
 * Re-render an issued invoice's PDF on demand. Same template + data the
 * compose flow would have used; useful for downloading the file before
 * sending it manually, or when paperless wasn't reachable at compose time.
 */
export function getInvoicePdf({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api/invoices/${encodeURIComponent(id)}/pdf`, {
        ...opts
    }));
}
/**
 * Redirect to the paperless document UI for this invoice. 404 when the
 * invoice was never archived (paperless was unreachable at compose time
 * and the retry job hasn't completed yet).
 */
export function paperlessRedirect2({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api/invoices/${encodeURIComponent(id)}/paperless`, {
        ...opts
    }));
}
export function getApiSettings(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SettingsResponseDto;
    }>("/api/settings", {
        ...opts
    }));
}
/**
 * Partial update — any subset of issuer fields and/or paperless tag
 * arrays. Empty arrays disable the corresponding tag-gate / tagging path.
 */
export function update({ updateSettingsDto }: {
    updateSettingsDto: UpdateSettingsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SettingsResponseDto;
    }>("/api/settings", oazapfts.json({
        ...opts,
        method: "PATCH",
        body: updateSettingsDto
    })));
}
/**
 * Read-only existence check against the live paperless tag set. Lets the
 * operator verify they typed the gate names correctly before saving — a
 * typo in `paperlessExpenseTags` silently breaks the expense pipeline
 * (tag-gate falls open and ingests every doc, or fails-and-warns on
 * every webhook depending on env). Does not create tags.
 */
export function checkPaperlessTags({ paperlessTagCheckDto }: {
    paperlessTagCheckDto: PaperlessTagCheckDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PaperlessTagCheckResponseDto;
    }>("/api/settings/paperless/tag-check", oazapfts.json({
        ...opts,
        method: "POST",
        body: paperlessTagCheckDto
    })));
}
export function getInfo(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SystemInfoDto;
    }>("/api/system/info", {
        ...opts
    }));
}
export function getIntegrations(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: IntegrationsResponseDto;
    }>("/api/system/integrations", {
        ...opts
    }));
}
/**
 * Trigger an immediate sheet-write retry — re-attempts any matched
 * bank_tx / approved expense whose sheet row failed to land. Same job
 * pg-boss runs hourly; this is the "do it now" button from the
 * dashboard's Sheet-write-failures tile.
 */
export function retrySheetWrites(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RetrySheetWritesResponseDto;
    }>("/api/system/retry-sheet-writes", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Current sheet-write health — counts entities that should have a sheet
 * row but don't and have been waiting longer than the retry-job healing
 * window. Distinct from the `sheet.write_failed` event count, which is
 * historical noise that doesn't tell you whether the system has actually
 * recovered.
 */
export function getSheetWriteStatus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SheetWriteStatusDto;
    }>("/api/system/sheet-write-status", {
        ...opts
    }));
}
/**
 * Wise webhook endpoint. RSA-SHA256-signed bodies are verified before ingestion.
 * The handler is intentionally minimal — verify, idempotent INSERT, return 200.
 * Side effects (drafting transfers, generating invoices, writing the sheet) live
 * in pg-boss job handlers that run downstream of the events row.
 */
export function ingestWiseWebhook({ wiseWebhookDto }: {
    wiseWebhookDto: WiseWebhookDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WebhookIngestResponseDto;
    }>("/api/webhooks/wise", oazapfts.json({
        ...opts,
        method: "POST",
        body: wiseWebhookDto
    })));
}
/**
 * Paperless-ngx workflow webhook endpoint. paperless-ngx fires a "Webhook"
 * action on document consumption with a JSON body containing the document
 * id (and whatever extra fields the workflow template includes). Auth is a
 * shared bearer token; the workflow is configured to send it.
 */
export function ingestPaperlessWebhook({ paperlessWebhookDto }: {
    paperlessWebhookDto: PaperlessWebhookDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WebhookIngestResponseDto;
    }>("/api/webhooks/paperless", oazapfts.json({
        ...opts,
        method: "POST",
        body: paperlessWebhookDto
    })));
}
/**
 * Paginated wise_transfer list with optional state filter, newest first.
 */
export function listTransfers({ state, page, limit }: {
    state?: string;
    page?: string;
    limit?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ListWiseTransfersResponseDto;
    }>(`/api/wise/transfers${QS.query(QS.explode({
        state,
        page,
        limit
    }))}`, {
        ...opts
    }));
}
/**
 * Draft a USD→EUR transfer in Wise from the given inbound credit event.
 * Returns the persisted wise_transfer row. The user still needs to SCA-confirm
 * the draft in the Wise app for money to actually move.
 */
export function draftFromEvent({ eventId, draftFromEventDto }: {
    eventId: string;
    draftFromEventDto: DraftFromEventDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WiseTransferResponseDto;
    }>(`/api/wise/draft-from-event/${encodeURIComponent(eventId)}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: draftFromEventDto
    })));
}
/**
 * Trigger an immediate Wise reconcile — pulls non-terminal wise_transfer
 * rows from the Wise API and reapplies their state. Same job pg-boss runs
 * on the 4h cron; this just enqueues an out-of-band tick.
 */
export function reconcileNow(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WiseReconcileResponseDto;
    }>("/api/wise/reconcile", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Count outbound transfers in `outgoing_payment_sent` that still have no
 * linked invoice. Drives the dashboard's "Wise transfer awaiting invoice"
 * tile — populated when auto-compose declined (or hasn't fired yet) and
 * the operator needs to run the manual compose flow.
 */
export function awaitingInvoiceCount(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WiseAwaitingInvoiceCountDto;
    }>("/api/wise/awaiting-invoice-count", {
        ...opts
    }));
}
export enum Kind {
    InvoiceUnmatched = "invoice_unmatched"
}
export enum Kind2 {
    ExpensePendingReview = "expense_pending_review"
}
export enum Kind3 {
    ExpenseLowConfidenceMatch = "expense_low_confidence_match"
}
export enum PsuTypes {
    Personal = "personal",
    Business = "business"
}
export enum PsuType {
    Personal = "personal",
    Business = "business"
}
export enum BankTxCategory {
    Tax = "tax",
    Drawings = "drawings",
    SelfTransfer = "self_transfer",
    Fee = "fee",
    Ignored = "ignored"
}
export enum Type {
    WiseTransfer = "wise_transfer",
    Invoice = "invoice",
    Expense = "expense"
}
export enum Class {
    NonEu = "non_eu",
    EuReverseCharge = "eu_reverse_charge",
    Eu = "eu",
    Domestic = "domestic"
}
export enum TradeName {
    ItServices = "it_services",
    $3D = "3d"
}
export enum Source {
    Wise = "wise",
    Paperless = "paperless",
    Bank = "bank",
    Manual = "manual",
    System = "system"
}
export enum Status {
    Pending = "pending",
    Processing = "processing",
    Processed = "processed",
    Failed = "failed",
    Skipped = "skipped"
}
export enum LocationClass {
    Domestic = "domestic",
    Eu = "eu",
    EuReverseCharge = "eu_reverse_charge",
    NonEu = "non_eu"
}
export enum Status2 {
    PendingReview = "pending_review",
    Approved = "approved",
    Rejected = "rejected"
}
export enum Status3 {
    Healthy = "healthy",
    Degraded = "degraded",
    Broken = "broken",
    NotConfigured = "not_configured"
}
