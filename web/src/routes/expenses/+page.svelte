<script lang="ts">
  import { page } from '$app/state';
  import ApiErrorAlert from '$lib/components/ApiErrorAlert.svelte';
  import { ApiError, formatIssuePath, type ApiFieldIssue } from '$lib/services/api';
  import { listBankTransactions, setBankTxMatch, type BankTransaction } from '$lib/services/banking.service';
  import { listWiseTransfers, type WiseTransferListItem } from '$lib/services/wise.service';
  import {
    approveExpense,
    listExpenses,
    rejectExpense,
    rescanPaperless,
    updateExpense,
    type ExpenseLocationClass,
    type ExpensePatch,
    type ExpenseResponse,
    type ExpenseStatus,
    type ListExpensesResponse,
    type RescanPaperlessResponse,
  } from '$lib/services/expenses.service';
  import { deriveBtwMinor, majorToMinor, minorToMajor } from '$lib/money';
  import {
    Alert,
    Badge,
    Button,
    Field,
    Heading,
    HStack,
    Input,
    Modal,
    ModalBody,
    Select,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
    Textarea,
  } from '@immich/ui';

  const PAGE_SIZE = 50;

  // URL-driven initial filters — lets the dashboard's "Approved, no bank
  // match" tile link directly to /expenses?status=approved&matched=false.
  const initialStatus = (page.url.searchParams.get('status') ?? '') as ExpenseStatus | '';
  const initialMatched = page.url.searchParams.get('matched');

  let status = $state<ExpenseStatus | ''>(initialStatus);
  let matched = $state<'' | 'true' | 'false'>(
    initialMatched === 'true' || initialMatched === 'false' ? initialMatched : '',
  );
  let offset = $state(0);
  let data = $state<ListExpensesResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let issues = $state<ApiFieldIssue[]>([]);
  let expandedId = $state<string | null>(null);

  let rescanRunning = $state(false);
  let rescanResult = $state<RescanPaperlessResponse | null>(null);
  let rescanError = $state<string | null>(null);

  async function runRescan() {
    rescanRunning = true;
    rescanError = null;
    rescanResult = null;
    try {
      rescanResult = await rescanPaperless();
      // Refresh the list so newly-ingested rows show up.
      await load();
    } catch (error_) {
      rescanError = (error_ as Error).message;
    } finally {
      rescanRunning = false;
    }
  }

  function hasIssue(prefix: string): boolean {
    return issues.some((issue) => formatIssuePath(issue.path).startsWith(prefix));
  }
  function clearError() {
    error = null;
    issues = [];
  }
  function captureError(error_: unknown) {
    if (error_ instanceof ApiError) {
      error = error_.message;
      issues = error_.issues;
    } else {
      error = (error_ as Error).message;
    }
  }

  type DraftFields = {
    vendor: string;
    expenseDate: string;
    amountMajor: string;
    currency: string;
    /** wise_transfer.id when currency !== EUR. Empty string = unset. */
    wiseTransferId: string;
    btwRatePercent: string;
    btwMajor: string;
    locationClass: ExpenseLocationClass;
    category: string;
    notes: string;
  };
  let drafts = $state<Record<string, DraftFields>>({});

  async function load() {
    loading = true;
    error = null;
    try {
      data = await listExpenses({
        status: status || undefined,
        matched: matched === '' ? undefined : matched === 'true',
        limit: PAGE_SIZE,
        offset,
      });
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  // Populated on first foreign-currency edit; cached across drawer opens.
  // The dropdown shows sweeps newest-first — the pool the operator drew
  // from is almost always the most recent one for their currency.
  let wiseTransfers = $state<WiseTransferListItem[]>([]);
  let wiseTransfersLoaded = $state(false);
  async function ensureWiseTransfersLoaded() {
    if (wiseTransfersLoaded) {
      return;
    }
    try {
      const result = await listWiseTransfers({ limit: 50 });
      wiseTransfers = result.items;
      wiseTransfersLoaded = true;
    } catch (error_) {
      error = `Couldn't load Wise sweeps: ${(error_ as Error).message}`;
    }
  }

  function toDraft(expense: ExpenseResponse): DraftFields {
    return {
      vendor: expense.vendor,
      expenseDate: expense.expenseDate,
      amountMajor: minorToMajor(expense.amountMinor),
      currency: expense.currency,
      wiseTransferId: expense.wiseTransferId ?? '',
      btwRatePercent: expense.btwRateBps == null ? '' : (expense.btwRateBps / 100).toFixed(2).replace(/\.?0+$/, ''),
      btwMajor: expense.btwMinor == null ? '' : minorToMajor(expense.btwMinor),
      locationClass: expense.locationClass,
      category: expense.category,
      notes: expense.notes ?? '',
    };
  }

  /**
   * Derive BTW from gross + rate as major-unit strings. Pure integer math
   * via BigInt so both `126.97` and `126,97` produce the exact same 22.04
   * (the earlier `parseFloat` path silently dropped everything past a
   * comma and gave 21.87 — a 17-cent understatement on €126.97). Empty /
   * unparseable inputs return `''` so clearing the rate blanks the field.
   */
  function deriveBtwMajor(amountMajor: string, btwRatePercent: string): string {
    if (!amountMajor.trim() || !btwRatePercent.trim()) {
      return '';
    }
    const rate = Number.parseInt(btwRatePercent, 10);
    if (!Number.isFinite(rate) || rate <= 0) {
      return '';
    }
    const rateBps = rate * 100;
    const grossMinor = BigInt(majorToMinor(amountMajor));
    return minorToMajor(deriveBtwMinor(grossMinor, rateBps).toString());
  }

  function recalcBtw(id: string) {
    const draft = drafts[id];
    if (!draft) {
      return;
    }
    draft.btwMajor = deriveBtwMajor(draft.amountMajor, draft.btwRatePercent);
  }

  /**
   * NL VAT brackets per location. Reverse-charge (B2B intra-EU) and non-EU
   * imports leave the supplier with no Dutch VAT to charge — rate is N/A,
   * BTW amount snaps to 0.
   */
  function ratesForLocation(loc: ExpenseLocationClass): { value: string; label: string }[] {
    if (loc === 'eu_reverse_charge' || loc === 'non_eu') {
      return [{ value: '', label: 'N/A' }];
    }
    return [
      { value: '21', label: '21%' },
      { value: '9', label: '9%' },
      { value: '0', label: '0%' },
    ];
  }

  function onLocationChange(id: string, next: ExpenseLocationClass) {
    const draft = drafts[id];
    if (!draft) {
      return;
    }
    draft.locationClass = next;
    if (next === 'eu_reverse_charge' || next === 'non_eu') {
      draft.btwRatePercent = '';
      draft.btwMajor = '0.00';
    } else {
      // Re-derive BTW under the new location's bracket.
      recalcBtw(id);
    }
  }

  function expand(expense: ExpenseResponse) {
    expandedId = expense.id;
    if (!Object.hasOwn(drafts, expense.id)) {
      drafts[expense.id] = toDraft(expense);
    }
    if (expense.currency !== 'EUR' || expense.wiseTransferId) {
      void ensureWiseTransfersLoaded();
    }
  }

  const currencyOptions = [
    { value: 'EUR', label: 'EUR' },
    { value: 'USD', label: 'USD' },
  ];

  function wiseTransferOptions(currentId: string): Array<{ value: string; label: string }> {
    const base: Array<{ value: string; label: string }> = [{ value: '', label: 'Pick a Wise sweep…' }];
    for (const t of wiseTransfers) {
      const src = `${(Number(t.sourceAmountMinor) / 100).toFixed(2)} ${t.sourceCurrency}`;
      const tgt = `${(Number(t.targetAmountMinor) / 100).toFixed(2)} ${t.targetCurrency}`;
      base.push({ value: t.id, label: `${t.ourReference ?? t.wiseTransferId} · ${src} → ${tgt} · ${t.state}` });
    }
    // If the expense's current transfer isn't in the recent list (e.g. old
    // one), still show it so the operator can see what's currently linked.
    if (currentId && wiseTransfers.every((t) => t.id !== currentId)) {
      base.push({ value: currentId, label: `(currently linked, older) ${currentId}` });
    }
    return base;
  }

  function onCurrencyChange(id: string, next: string) {
    const draft = drafts[id];
    if (!draft) {
      return;
    }
    draft.currency = next;
    if (next === 'EUR') {
      draft.wiseTransferId = '';
    } else {
      void ensureWiseTransfersLoaded();
    }
  }

  // ── Bank-tx link picker ───────────────────────────────────────────────
  // The bank-tx → expense link is the same DB write either way, but the
  // operator's mental model after approving an expense is "now point this
  // at the bank tx that paid for it" — not "switch to /banking and find
  // the matching row." Mirror the link affordance on this side too.
  let linkingExpense = $state<ExpenseResponse | null>(null);
  let candidates = $state<BankTransaction[]>([]);
  let candidatesLoading = $state(false);
  let linking = $state(false);

  async function openLinkModal(expense: ExpenseResponse) {
    linkingExpense = expense;
    candidates = [];
    candidatesLoading = true;
    try {
      const result = await listBankTransactions({ status: 'unmatched', limit: 100 });
      candidates = result.items;
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      candidatesLoading = false;
    }
  }

  function closeLinkModal() {
    linkingExpense = null;
    candidates = [];
  }

  async function linkBankTx(bankTxId: string) {
    if (!linkingExpense) {
      return;
    }
    linking = true;
    try {
      await setBankTxMatch(bankTxId, { type: 'expense', targetId: linkingExpense.id });
      closeLinkModal();
      await load();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      linking = false;
    }
  }

  function formatBankAmount(minor: string, currency: string): string {
    const sign = minor.startsWith('-') ? '-' : '';
    const abs = minor.replace(/^-/, '').padStart(3, '0');
    const major = abs.slice(0, -2);
    const cents = abs.slice(-2);
    return `${sign}${major}.${cents} ${currency}`;
  }

  function collapse() {
    expandedId = null;
  }

  function buildPatch(draft: DraftFields): ExpensePatch {
    const btwRateBps = draft.btwRatePercent.trim() === '' ? null : Number.parseInt(draft.btwRatePercent, 10) * 100;
    const btwMinor = draft.btwMajor.trim() === '' ? null : majorToMinor(draft.btwMajor);
    return {
      vendor: draft.vendor,
      expenseDate: draft.expenseDate,
      amountMinor: majorToMinor(draft.amountMajor),
      currency: draft.currency,
      // EUR-native rows should never carry a wise-transfer link; foreign
      // currency rows must (DB CHECK constraint enforces this too).
      wiseTransferId: draft.currency === 'EUR' ? null : draft.wiseTransferId || null,
      btwRateBps,
      btwMinor,
      locationClass: draft.locationClass,
      category: draft.category,
      notes: draft.notes.trim() === '' ? null : draft.notes,
    };
  }

  async function save(expense: ExpenseResponse) {
    const draft = drafts[expense.id];
    if (!draft) {
      return;
    }
    clearError();
    try {
      await updateExpense(expense.id, buildPatch(draft));
      await load();
    } catch (error_) {
      captureError(error_);
    }
  }

  async function approve(expense: ExpenseResponse) {
    const draft = drafts[expense.id];
    clearError();
    try {
      await approveExpense(expense.id, draft ? buildPatch(draft) : {});
      collapse();
      await load();
    } catch (error_) {
      captureError(error_);
    }
  }

  async function reject(expense: ExpenseResponse) {
    const draft = drafts[expense.id];
    clearError();
    try {
      await rejectExpense(expense.id, draft?.notes || undefined);
      collapse();
      await load();
    } catch (error_) {
      captureError(error_);
    }
  }

  function statusColor(s: ExpenseStatus) {
    switch (s) {
      case 'approved': {
        return 'success';
      }
      case 'rejected': {
        return 'danger';
      }
      default: {
        return 'warning';
      }
    }
  }

  const statusOptions = [
    { value: 'pending_review', label: 'Pending review' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: '', label: 'All' },
  ];

  const locationOptions = [
    { value: 'domestic', label: 'Domestic' },
    { value: 'eu', label: 'EU (BTW charged)' },
    { value: 'eu_reverse_charge', label: 'EU (reverse-charge)' },
    { value: 'non_eu', label: 'Non-EU' },
  ];
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <div class="flex items-center justify-between">
      <Heading size="large" tag="h1">Expenses</Heading>
      <HStack gap={3} class="items-center">
        <Text size="small" color="muted">
          {data ? `${data.total} total` : ''}
        </Text>
        <Button size="small" variant="ghost" disabled={rescanRunning} onclick={runRescan}>
          {rescanRunning ? 'Scanning…' : 'Backfill from paperless'}
        </Button>
      </HStack>
    </div>

    <HStack gap={3}>
      <Select
        bind:value={status}
        options={statusOptions}
        onChange={() => {
          offset = 0;
        }}
      />
      {#if matched !== ''}
        <Badge color="warning">
          {matched === 'false' ? 'Unmatched only' : 'Matched only'}
          <button
            type="button"
            class="ml-2 underline"
            onclick={() => {
              matched = '';
              offset = 0;
            }}
          >
            clear
          </button>
        </Badge>
      {/if}
    </HStack>

    {#if rescanError}
      <Alert color="danger">{rescanError}</Alert>
    {/if}
    {#if rescanResult}
      <Alert color={rescanResult.enqueued > 0 ? 'success' : 'secondary'}>
        Scanned {rescanResult.scanned}; {rescanResult.enqueued} enqueued, {rescanResult.alreadyIngested} already ingested.
      </Alert>
    {/if}

    {#if error}
      <ApiErrorAlert message={error} {issues} />
    {/if}

    {#if loading && !data}
      <Text>Loading…</Text>
    {:else if data}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeading>Date</TableHeading>
            <TableHeading>Vendor</TableHeading>
            <TableHeading>Amount</TableHeading>
            <TableHeading>BTW</TableHeading>
            <TableHeading>Class</TableHeading>
            <TableHeading>Status</TableHeading>
            <TableHeading>Paperless</TableHeading>
            <TableHeading></TableHeading>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each data.items as expense (expense.id)}
            <TableRow>
              <TableCell>{expense.expenseDate}</TableCell>
              <TableCell>
                {#if expense.vendor}
                  {expense.vendor}
                {:else}
                  <em>(unknown)</em>
                {/if}
              </TableCell>
              <TableCell>{minorToMajor(expense.amountMinor)} {expense.currency}</TableCell>
              <TableCell>
                {#if expense.btwMinor}{minorToMajor(expense.btwMinor)}{:else}—{/if}
              </TableCell>
              <TableCell><code class="text-xs">{expense.locationClass}</code></TableCell>
              <TableCell><Badge color={statusColor(expense.status)}>{expense.status}</Badge></TableCell>
              <TableCell>
                <Button size="tiny" variant="ghost" href={`/api/expenses/${expense.id}/paperless`} target="_blank">
                  {expense.paperlessDocId} ↗
                </Button>
              </TableCell>
              <TableCell>
                <HStack gap={1}>
                  <Button
                    variant={expense.status === 'pending_review' ? 'outline' : 'ghost'}
                    size="small"
                    onclick={() => expand(expense)}
                  >
                    {expense.status === 'pending_review' ? 'Review' : 'Edit'}
                  </Button>
                  {#if expense.status === 'approved' && !expense.matchedBankTxId}
                    <Button size="small" variant="ghost" onclick={() => openLinkModal(expense)}>Link</Button>
                  {/if}
                </HStack>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>

      {#if expandedId}
        {@const expense = data.items.find((row) => row.id === expandedId)}
        {#if expense && drafts[expense.id]}
          <div class="rounded border bg-subtle p-4">
            <Stack gap={4}>
              <Heading size="small" tag="h2">Editing {expense.vendor || expense.paperlessDocId}</Heading>
              {#if expense.status === 'approved'}
                <Alert color="warning">
                  This expense is already approved. Edits update the database only — the accountant sheet row was
                  written at approve time and isn't rewritten.
                </Alert>
              {:else if expense.status === 'rejected'}
                <Alert color="warning">This expense is rejected. Re-saving doesn't restore it to pending review.</Alert>
              {/if}
              <HStack gap={3}>
                <Field label="Vendor" invalid={hasIssue('vendor')}>
                  <Input bind:value={drafts[expense.id].vendor} />
                </Field>
                <Field label="Date" invalid={hasIssue('expenseDate')}>
                  <Input bind:value={drafts[expense.id].expenseDate} placeholder="YYYY-MM-DD" />
                </Field>
              </HStack>
              <HStack gap={3}>
                <Field label="Currency" invalid={hasIssue('currency')}>
                  <Select
                    value={drafts[expense.id].currency}
                    options={currencyOptions}
                    onChange={(value) => onCurrencyChange(expense.id, value)}
                  />
                </Field>
                <Field
                  label={drafts[expense.id].currency === 'EUR'
                    ? 'Amount (gross, EUR)'
                    : `Amount (gross, ${drafts[expense.id].currency})`}
                  invalid={hasIssue('amountMinor')}
                >
                  <Input
                    bind:value={drafts[expense.id].amountMajor}
                    placeholder="0.00"
                    inputmode="decimal"
                    oninput={() => recalcBtw(expense.id)}
                  />
                </Field>
                <Field label="BTW rate (%)" invalid={hasIssue('btwRateBps')}>
                  <Select
                    value={drafts[expense.id].btwRatePercent}
                    options={ratesForLocation(drafts[expense.id].locationClass)}
                    onChange={(value) => {
                      drafts[expense.id].btwRatePercent = value;
                      recalcBtw(expense.id);
                    }}
                  />
                </Field>
                <Field label="BTW amount (EUR)" invalid={hasIssue('btwMinor')}>
                  <Input bind:value={drafts[expense.id].btwMajor} placeholder="0.00" inputmode="decimal" />
                </Field>
              </HStack>
              {#if drafts[expense.id].currency !== 'EUR'}
                <Field label="Paid from Wise sweep" invalid={hasIssue('wiseTransferId')}>
                  <Select
                    value={drafts[expense.id].wiseTransferId}
                    options={wiseTransferOptions(drafts[expense.id].wiseTransferId)}
                    onChange={(value) => (drafts[expense.id].wiseTransferId = value)}
                  />
                </Field>
                {#if expense.eurAmountMinor}
                  <Text size="small" color="muted">
                    EUR booked: {minorToMajor(expense.eurAmountMinor)} at rate {expense.fxRate}
                  </Text>
                {:else if drafts[expense.id].wiseTransferId}
                  <Text size="small" color="muted">
                    EUR will be booked at sweep-clear time (from the picked transfer's realized rate).
                  </Text>
                {/if}
              {/if}
              <HStack gap={3}>
                <Field label="Location class" invalid={hasIssue('locationClass')}>
                  <Select
                    value={drafts[expense.id].locationClass}
                    options={locationOptions}
                    onChange={(value) => onLocationChange(expense.id, value as ExpenseLocationClass)}
                  />
                </Field>
              </HStack>
              <Field label="Notes" invalid={hasIssue('notes')}>
                <Textarea bind:value={drafts[expense.id].notes} />
              </Field>
              <HStack gap={3}>
                <Button variant="ghost" onclick={collapse}>Cancel</Button>
                <Button variant="outline" onclick={() => save(expense)}>Save</Button>
                {#if expense.status === 'pending_review'}
                  <Button color="danger" variant="outline" onclick={() => reject(expense)}>Reject</Button>
                  <Button color="primary" onclick={() => approve(expense)}>Save & Approve</Button>
                {/if}
              </HStack>
            </Stack>
          </div>
        {/if}
      {/if}

      {#if data.items.length === 0}
        <Text color="muted">No expenses match these filters.</Text>
      {/if}

      <div class="flex items-center justify-between">
        <Text size="small" color="muted">
          Showing {offset + 1}–{Math.min(offset + data.items.length, data.total)} of {data.total}
        </Text>
        <HStack gap={2}>
          <Button
            variant="outline"
            disabled={offset === 0}
            onclick={() => {
              offset = Math.max(0, offset - PAGE_SIZE);
            }}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={!data.hasMore}
            onclick={() => {
              offset += PAGE_SIZE;
            }}
          >
            Next
          </Button>
        </HStack>
      </div>
    {/if}
  </Stack>

  {#if linkingExpense}
    <Modal title="Link bank transaction to expense" onClose={closeLinkModal} size="medium" closeOnBackdropClick>
      <ModalBody>
        <Stack gap={4}>
          <div class="rounded border p-3 text-sm">
            <div>
              <strong>{linkingExpense.vendor || linkingExpense.paperlessDocId}</strong> ·
              {linkingExpense.expenseDate}
            </div>
            <div class="text-muted-foreground">
              {minorToMajor(linkingExpense.amountMinor)}
              {linkingExpense.currency}
            </div>
          </div>

          <Text size="small" color="muted">
            Pick the bank tx that paid this. Only unmatched transactions are shown.
          </Text>

          {#if candidatesLoading}
            <Text color="muted">Loading…</Text>
          {:else if candidates.length === 0}
            <Text color="muted">No unmatched bank transactions.</Text>
          {:else}
            <Stack gap={2}>
              {#each candidates as tx (tx.id)}
                <HStack class="justify-between rounded border px-3 py-2">
                  <div class="text-sm">
                    <div>
                      <strong>{tx.txDate}</strong> · {formatBankAmount(tx.amountMinor, tx.currency)}
                    </div>
                    {#if tx.counterpartyName || tx.description}
                      <div class="text-muted-foreground">
                        {tx.counterpartyName ?? ''}{tx.counterpartyName && tx.description
                          ? ' · '
                          : ''}{tx.description ?? ''}
                      </div>
                    {/if}
                  </div>
                  <Button size="small" disabled={linking} onclick={() => linkBankTx(tx.id)}>Link</Button>
                </HStack>
              {/each}
            </Stack>
          {/if}
        </Stack>
      </ModalBody>
    </Modal>
  {/if}
</main>
