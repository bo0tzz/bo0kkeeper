<script lang="ts">
  import { resolve } from '$app/paths';
  import { getQuarterlyAggregate, type QuarterlyAggregateResponse } from '$lib/services/aggregator.service';
  import {
    getLatestBankingSession,
    listBankTransactions,
    type BankingSession,
    type BankTransaction,
  } from '$lib/services/banking.service';
  import { listEvents, type ListEventsResponse } from '$lib/services/events.service';
  import { listExpenses, type ListExpensesResponse } from '$lib/services/expenses.service';
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Heading,
    HStack,
    Stack,
    Text,
  } from '@immich/ui';

  type Counts = {
    pendingWiseCredits: number;
    pendingExpenseReviews: number;
    unmatchedBankTx: number;
    bankingSession: BankingSession | null;
    aggregate: QuarterlyAggregateResponse | null;
    aggregateYear: number;
    aggregateQuarter: number;
  };

  let counts = $state<Counts | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      const now = new Date();
      const year = now.getUTCFullYear();
      const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
      const [wise, expenses, bankTx, bankingSession, agg] = await Promise.all([
        listEvents({
          source: 'wise',
          eventType: 'balances#credit',
          status: 'pending',
          limit: 1,
        }) as Promise<ListEventsResponse>,
        listExpenses({ status: 'pending_review', limit: 1 }) as Promise<ListExpensesResponse>,
        listBankTransactions().catch(() => [] as BankTransaction[]),
        getLatestBankingSession().catch(() => null),
        getQuarterlyAggregate(year, quarter).catch(() => null),
      ]);
      counts = {
        pendingWiseCredits: wise.total,
        pendingExpenseReviews: expenses.total,
        unmatchedBankTx: bankTx.filter(
          (tx) => !tx.matchedTransferId && !tx.matchedInvoiceId && !tx.matchedExpenseId && !tx.category,
        ).length,
        bankingSession,
        aggregate: agg,
        aggregateYear: year,
        aggregateQuarter: quarter,
      };
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function eur(minor: string): string {
    const cents = BigInt(minor);
    const negative = cents < 0n;
    const abs = negative ? -cents : cents;
    const major = abs / 100n;
    const tail = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}€${major}.${tail}`;
  }

  function bankingExpiryDays(session: BankingSession | null): number | null {
    if (!session?.expiresAt || session.status !== 'active') {
      return null;
    }
    return Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  }
</script>

<main class="mx-auto max-w-5xl px-6 py-10">
  <Stack gap={6}>
    <Heading size="large" tag="h1">bo0kkeeper</Heading>

    {#if error}
      <Alert color="danger">Failed to load dashboard: {error}</Alert>
    {/if}

    {#if loading && !counts}
      <Text>Loading…</Text>
    {:else if counts}
      {@const totalThingsToDo =
        counts.pendingWiseCredits + counts.pendingExpenseReviews + counts.unmatchedBankTx}
      {@const reconnectDays = bankingExpiryDays(counts.bankingSession)}
      {#if totalThingsToDo === 0}
        <Alert color="success">Inbox zero — nothing pending review.</Alert>
      {/if}
      {#if counts.bankingSession && (counts.bankingSession.status === 'expired' || counts.bankingSession.status === 'revoked')}
        <Alert color="danger">
          Bank consent is {counts.bankingSession.status} — bank tx sync is paused.
          <a class="ml-1 underline" href={resolve('/banking')}>Reconnect →</a>
        </Alert>
      {:else if reconnectDays !== null && reconnectDays <= 7}
        <Alert color="warning">
          Bank consent expires in {reconnectDays} day{reconnectDays === 1 ? '' : 's'}.
          <a class="ml-1 underline" href={resolve('/banking')}>Reconnect →</a>
        </Alert>
      {/if}

      <Stack gap={4}>
        <Heading size="small" tag="h2">Inbox</Heading>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Wise inbound credits</CardTitle>
            </CardHeader>
            <CardBody>
              <Stack gap={3}>
                <HStack class="items-center justify-between">
                  <Heading size="medium" tag="h3">{counts.pendingWiseCredits}</Heading>
                  <Badge color={counts.pendingWiseCredits === 0 ? 'secondary' : 'warning'}>
                    {counts.pendingWiseCredits === 0 ? 'none' : 'pending'}
                  </Badge>
                </HStack>
                <Text size="small" color="muted">USD credits waiting to be drafted as transfers.</Text>
                {#if counts.pendingWiseCredits > 0}
                  <Button href={resolve('/wise')} variant="outline">Review →</Button>
                {/if}
              </Stack>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Expenses to review</CardTitle>
            </CardHeader>
            <CardBody>
              <Stack gap={3}>
                <HStack class="items-center justify-between">
                  <Heading size="medium" tag="h3">{counts.pendingExpenseReviews}</Heading>
                  <Badge color={counts.pendingExpenseReviews === 0 ? 'secondary' : 'warning'}>
                    {counts.pendingExpenseReviews === 0 ? 'none' : 'pending'}
                  </Badge>
                </HStack>
                <Text size="small" color="muted">Receipts ingested by paperless awaiting amount + BTW + approval.</Text>
                {#if counts.pendingExpenseReviews > 0}
                  <Button href={resolve('/expenses')} variant="outline">Review →</Button>
                {/if}
              </Stack>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Bank reconciliation</CardTitle>
            </CardHeader>
            <CardBody>
              <Stack gap={3}>
                <HStack class="items-center justify-between">
                  <Heading size="medium" tag="h3">{counts.unmatchedBankTx}</Heading>
                  <Badge color={counts.unmatchedBankTx === 0 ? 'secondary' : 'warning'}>
                    {counts.unmatchedBankTx === 0 ? 'all matched' : 'unmatched'}
                  </Badge>
                </HStack>
                <Text size="small" color="muted">
                  Recent bank rows without an automatic match — link them to a transfer or invoice.
                </Text>
                {#if counts.unmatchedBankTx > 0}
                  <Button href={resolve('/banking')} variant="outline">Review →</Button>
                {/if}
              </Stack>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Compose invoice</CardTitle>
            </CardHeader>
            <CardBody>
              <Stack gap={3}>
                <Text size="small" color="muted">
                  Issue a new invoice (domestic / EU / non-EU). Renders the PDF and pushes to paperless.
                </Text>
                <Button href={resolve('/invoices/compose')} color="primary">New invoice →</Button>
              </Stack>
            </CardBody>
          </Card>
        </div>
      </Stack>

      {#if counts.aggregate}
        {@const agg = counts.aggregate}
        <Stack gap={4}>
          <HStack class="items-center justify-between">
            <Heading size="small" tag="h2">This quarter ({agg.year} Q{agg.quarter})</Heading>
            <Button href={resolve('/aggregator')} variant="ghost" size="small">Open rollup →</Button>
          </HStack>
          <div class="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardBody>
                <Stack gap={1}>
                  <Text size="small" color="muted">Income (gross)</Text>
                  <Heading size="medium" tag="h3">{eur(agg.income.totalGrossEurMinor)}</Heading>
                  <Text size="small" color="muted">BTW collected: {eur(agg.income.totalBtwEurMinor)}</Text>
                </Stack>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <Stack gap={1}>
                  <Text size="small" color="muted">Expenses (gross)</Text>
                  <Heading size="medium" tag="h3">{eur(agg.expenses.grossEurMinor)}</Heading>
                  <Text size="small" color="muted">Deductible BTW: {eur(agg.expenses.deductibleBtwEurMinor)}</Text>
                </Stack>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <Stack gap={1}>
                  <Text size="small" color="muted">Net BTW</Text>
                  <Heading size="medium" tag="h3">{eur(agg.netBtwEurMinor)}</Heading>
                  <Text size="small" color="muted">
                    {BigInt(agg.netBtwEurMinor) >= 0n ? 'owed to Belastingdienst' : 'refund expected'}
                  </Text>
                </Stack>
              </CardBody>
            </Card>
          </div>
          {#if agg.warnings.length > 0}
            <Stack gap={2}>
              {#each agg.warnings as warning (warning.kind)}
                {@const target =
                  warning.kind === 'invoice_unmatched'
                    ? resolve('/banking')
                    : warning.kind === 'expense_pending_review'
                      ? resolve('/expenses')
                      : resolve('/banking')}
                <Alert color="warning">
                  {#if warning.kind === 'invoice_unmatched'}
                    {warning.count} invoice{warning.count === 1 ? '' : 's'} not yet matched to a bank tx
                  {:else if warning.kind === 'expense_pending_review'}
                    {warning.count} expense{warning.count === 1 ? '' : 's'} still pending review
                  {:else}
                    {warning.count} bank tx match{warning.count === 1 ? '' : 'es'} need manual confirmation
                  {/if}
                  <a class="ml-1 underline" href={target}>Open →</a>
                </Alert>
              {/each}
            </Stack>
          {/if}
        </Stack>
      {/if}
    {/if}
  </Stack>
</main>
