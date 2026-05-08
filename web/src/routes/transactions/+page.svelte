<script lang="ts">
  import {
    listAllTransactions,
    type ListTransactionsResponse,
    type TransactionRow,
  } from '$lib/services/transactions.service';
  import {
    Alert,
    Badge,
    Heading,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';

  let data = $state<ListTransactionsResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      data = await listAllTransactions();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function formatAmount(minor: string, currency: string): string {
    const negative = minor.startsWith('-');
    const abs = (negative ? minor.slice(1) : minor).padStart(3, '0');
    const major = abs.slice(0, -2);
    const cents = abs.slice(-2);
    return `${negative ? '-' : ''}${major}.${cents} ${currency}`;
  }

  function sourceColor(source: TransactionRow['source']): 'primary' | 'secondary' {
    return source === 'wise' ? 'primary' : 'secondary';
  }
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <div class="flex items-center justify-between">
      <Heading size="large" tag="h1">All transactions</Heading>
      <Text size="small" color="muted">{data ? `${data.total} rows` : ''}</Text>
    </div>

    {#if error}
      <Alert color="danger">{error}</Alert>
    {/if}

    {#if loading && !data}
      <Text>Loading…</Text>
    {:else if data}
      {#if data.items.length === 0}
        <Text color="muted">No transactions yet.</Text>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeading>Date</TableHeading>
              <TableHeading>Source</TableHeading>
              <TableHeading>Type</TableHeading>
              <TableHeading>Counterparty</TableHeading>
              <TableHeading class="text-right">Amount</TableHeading>
              <TableHeading>Reference</TableHeading>
              <TableHeading>Description</TableHeading>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.items as row (row.id)}
              <TableRow>
                <TableCell>{row.date}</TableCell>
                <TableCell><Badge color={sourceColor(row.source)}>{row.source}</Badge></TableCell>
                <TableCell>{row.type}</TableCell>
                <TableCell>{row.counterparty ?? '—'}</TableCell>
                <TableCell class="text-right">
                  <span class={row.amountMinor.startsWith('-') ? 'text-red-600' : 'text-green-700'}>
                    {formatAmount(row.amountMinor, row.currency)}
                  </span>
                </TableCell>
                <TableCell>{row.reference || '—'}</TableCell>
                <TableCell class="whitespace-normal break-words">{row.description || '—'}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    {/if}
  </Stack>
</main>
