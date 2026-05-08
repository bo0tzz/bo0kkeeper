<script lang="ts">
  import { resolve } from '$app/paths';
  import ApiErrorAlert from '$lib/components/ApiErrorAlert.svelte';
  import { ApiError, formatIssuePath, type ApiFieldIssue } from '$lib/services/api';
  import {
    approveExpense,
    listExpenses,
    rejectExpense,
    updateExpense,
    type ExpenseLocationClass,
    type ExpensePatch,
    type ExpenseResponse,
    type ExpenseStatus,
    type ListExpensesResponse,
  } from '$lib/services/expenses.service';
  import {
    Badge,
    Button,
    Field,
    Heading,
    HStack,
    Input,
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

  let status = $state<ExpenseStatus | ''>('');
  let offset = $state(0);
  let data = $state<ListExpensesResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let issues = $state<ApiFieldIssue[]>([]);
  let expandedId = $state<string | null>(null);

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

  function toDraft(expense: ExpenseResponse): DraftFields {
    return {
      vendor: expense.vendor,
      expenseDate: expense.expenseDate,
      amountMajor: minorToMajor(expense.amountMinor),
      btwRatePercent: expense.btwRateBps == null ? '' : (expense.btwRateBps / 100).toFixed(2).replace(/\.?0+$/, ''),
      btwMajor: expense.btwMinor == null ? '' : minorToMajor(expense.btwMinor),
      locationClass: expense.locationClass,
      category: expense.category,
      notes: expense.notes ?? '',
    };
  }

  function minorToMajor(minor: string): string {
    const cents = BigInt(minor);
    const negative = cents < 0n;
    const abs = negative ? -cents : cents;
    const major = abs / 100n;
    const tail = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${major}.${tail}`;
  }

  function majorToMinor(major: string): string {
    const trimmed = major.trim();
    if (!trimmed) {
      return '0';
    }
    const negative = trimmed.startsWith('-');
    const body = negative ? trimmed.slice(1) : trimmed;
    const [whole, frac = ''] = body.split('.');
    const cents = (frac + '00').slice(0, 2);
    const total = BigInt(whole || '0') * 100n + BigInt(cents || '0');
    return (negative ? -total : total).toString();
  }

  /**
   * Derive BTW from gross + rate using Dutch convention (gross is VAT-inclusive):
   *   btw = gross * rate / (100 + rate)
   * Returns '' when either input is empty/invalid so the field can be cleared
   * by clearing the rate.
   */
  function deriveBtwMajor(amountMajor: string, btwRatePercent: string): string {
    const gross = Number.parseFloat(amountMajor);
    const rate = Number.parseFloat(btwRatePercent);
    if (!Number.isFinite(gross) || !Number.isFinite(rate) || rate < 0) {
      return '';
    }
    const btw = (gross * rate) / (100 + rate);
    return btw.toFixed(2);
  }

  function recalcBtw(id: string) {
    const draft = drafts[id];
    if (!draft) {
      return;
    }
    draft.btwMajor = deriveBtwMajor(draft.amountMajor, draft.btwRatePercent);
  }

  function expand(expense: ExpenseResponse) {
    expandedId = expense.id;
    if (!drafts[expense.id]) {
      drafts[expense.id] = toDraft(expense);
    }
  }

  function collapse() {
    expandedId = null;
  }

  function buildPatch(draft: DraftFields): ExpensePatch {
    const btwRateBps = draft.btwRatePercent.trim() === '' ? null : Math.round(Number(draft.btwRatePercent) * 100);
    const btwMinor = draft.btwMajor.trim() === '' ? null : majorToMinor(draft.btwMajor);
    return {
      vendor: draft.vendor,
      expenseDate: draft.expenseDate,
      amountMinor: majorToMinor(draft.amountMajor),
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
      <Text size="small" color="muted">
        {data ? `${data.total} total` : ''}
      </Text>
    </div>

    <HStack gap={3}>
      <Select
        bind:value={status}
        options={statusOptions}
        onChange={() => {
          offset = 0;
        }}
      />
    </HStack>

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
                <a
                  class="text-xs underline"
                  href={resolve(`/api/expenses/${expense.id}/paperless`)}
                  target="_blank"
                  rel="noopener"
                >
                  {expense.paperlessDocId} ↗
                </a>
              </TableCell>
              <TableCell>
                <Button
                  variant={expense.status === 'pending_review' ? 'outline' : 'ghost'}
                  size="small"
                  onclick={() => expand(expense)}
                >
                  {expense.status === 'pending_review' ? 'Review' : 'Edit'}
                </Button>
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
              <HStack gap={3}>
                <Field label="Vendor" invalid={hasIssue('vendor')}>
                  <Input bind:value={drafts[expense.id].vendor} />
                </Field>
                <Field label="Date" invalid={hasIssue('expenseDate')}>
                  <Input bind:value={drafts[expense.id].expenseDate} placeholder="YYYY-MM-DD" />
                </Field>
              </HStack>
              <HStack gap={3}>
                <Field label="Amount (gross, EUR)" invalid={hasIssue('amountMinor')}>
                  <Input
                    bind:value={drafts[expense.id].amountMajor}
                    placeholder="0.00"
                    oninput={() => recalcBtw(expense.id)}
                  />
                </Field>
                <Field label="BTW rate (%)" invalid={hasIssue('btwRateBps')}>
                  <Input
                    bind:value={drafts[expense.id].btwRatePercent}
                    placeholder="21"
                    oninput={() => recalcBtw(expense.id)}
                  />
                </Field>
                <Field label="BTW amount (EUR)" invalid={hasIssue('btwMinor')}>
                  <Input bind:value={drafts[expense.id].btwMajor} placeholder="0.00" />
                </Field>
              </HStack>
              <HStack gap={3}>
                <Field label="Location class" invalid={hasIssue('locationClass')}>
                  <Select bind:value={drafts[expense.id].locationClass} options={locationOptions} />
                </Field>
                <Field label="Category" invalid={hasIssue('category')}>
                  <Input bind:value={drafts[expense.id].category} />
                </Field>
              </HStack>
              <Field label="Notes" invalid={hasIssue('notes')}>
                <Textarea bind:value={drafts[expense.id].notes} />
              </Field>
              <HStack gap={3}>
                <Button variant="ghost" onclick={collapse}>Cancel</Button>
                <Button variant="outline" onclick={() => save(expense)}>Save</Button>
                <Button color="danger" variant="outline" onclick={() => reject(expense)}>Reject</Button>
                <Button color="primary" onclick={() => approve(expense)}>Save & Approve</Button>
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
              offset = offset + PAGE_SIZE;
            }}
          >
            Next
          </Button>
        </HStack>
      </div>
    {/if}
  </Stack>
</main>
