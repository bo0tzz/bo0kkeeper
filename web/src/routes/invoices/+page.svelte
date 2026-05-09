<script lang="ts">
  import { resolve } from '$app/paths';
  import {
    listInvoices,
    type InvoiceListItem,
    type ListInvoicesResponse,
  } from '$lib/services/invoices.service';
  import {
    Alert,
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
  } from '@immich/ui';

  const PAGE_SIZE = 50;

  let data = $state<ListInvoicesResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let yearInput = $state('');
  let status = $state<'' | 'open' | 'paid'>('');
  let page = $state(1);

  const statusOptions = [
    { value: '', label: 'Any status' },
    { value: 'open', label: 'Open' },
    { value: 'paid', label: 'Paid' },
  ];

  async function load() {
    loading = true;
    error = null;
    try {
      const yearNum = yearInput ? Number(yearInput) : undefined;
      data = await listInvoices({
        year: Number.isFinite(yearNum) ? yearNum : undefined,
        status: status || undefined,
        page,
        limit: PAGE_SIZE,
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

  function applyFilters() {
    page = 1;
    void load();
  }

  function clearFilters() {
    yearInput = '';
    status = '';
    page = 1;
    void load();
  }

  function formatAmount(minor: string, currency: string): string {
    const negative = minor.startsWith('-');
    const abs = (negative ? minor.slice(1) : minor).padStart(3, '0');
    const major = abs.slice(0, -2);
    const cents = abs.slice(-2);
    return `${negative ? '-' : ''}${major}.${cents} ${currency}`;
  }

  let totalPages = $derived(data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1);
  let invoices = $derived<InvoiceListItem[]>(data?.items ?? []);
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <HStack class="justify-between">
      <Heading size="large" tag="h1">Invoices</Heading>
      <Button color="primary" href={resolve('/invoices/compose')}>New invoice</Button>
    </HStack>

    <HStack gap={3} class="items-end">
      <Field label="Year">
        <Input type="number" placeholder="2026" bind:value={yearInput} />
      </Field>
      <Field label="Status">
        <Select bind:value={status} options={statusOptions} />
      </Field>
      <Button size="small" onclick={applyFilters}>Apply</Button>
      <Button size="small" variant="ghost" onclick={clearFilters}>Clear</Button>
      {#if data}
        <Text size="small" color="muted">{data.total} total</Text>
      {/if}
    </HStack>

    {#if error}
      <Alert color="danger">{error}</Alert>
    {/if}

    {#if loading && !data}
      <Text>Loading…</Text>
    {:else if invoices.length === 0}
      <Text color="muted">No invoices match these filters.</Text>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeading>Number</TableHeading>
            <TableHeading>Issued</TableHeading>
            <TableHeading>Client</TableHeading>
            <TableHeading class="text-right">Total</TableHeading>
            <TableHeading class="text-right">BTW</TableHeading>
            <TableHeading>Status</TableHeading>
            <TableHeading></TableHeading>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each invoices as inv (inv.id)}
            <TableRow>
              <TableCell><code>{inv.number}</code></TableCell>
              <TableCell>{inv.issuedAt}</TableCell>
              <TableCell>{inv.clientName ?? '—'}</TableCell>
              <TableCell class="text-right">
                {formatAmount(inv.totalMinor, inv.currency)}
                {#if inv.eurTotalMinor && inv.currency !== 'EUR'}
                  <div class="text-xs text-muted-foreground">
                    ≈ {formatAmount(inv.eurTotalMinor, 'EUR')}
                  </div>
                {/if}
              </TableCell>
              <TableCell class="text-right">
                {inv.btwMinor ? formatAmount(inv.btwMinor, inv.currency) : '—'}
              </TableCell>
              <TableCell>
                <Badge color={inv.paid ? 'success' : 'warning'}>
                  {inv.paid ? 'paid' : 'open'}
                </Badge>
              </TableCell>
              <TableCell class="whitespace-nowrap">
                <HStack gap={2}>
                  <Button size="small" variant="ghost" href={`/api/invoices/${inv.id}/pdf`}>PDF</Button>
                  {#if inv.paperlessDocId}
                    <Button
                      size="small"
                      variant="ghost"
                      href={`/api/invoices/${inv.id}/paperless`}
                      target="_blank"
                    >
                      Paperless
                    </Button>
                  {/if}
                </HStack>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>

      <HStack class="justify-between">
        <Text size="small" color="muted">
          Page {page} of {totalPages}
        </Text>
        <HStack gap={2}>
          <Button
            size="small"
            variant="ghost"
            disabled={page <= 1 || loading}
            onclick={() => {
              page -= 1;
              void load();
            }}
          >
            ← Prev
          </Button>
          <Button
            size="small"
            variant="ghost"
            disabled={page >= totalPages || loading}
            onclick={() => {
              page += 1;
              void load();
            }}
          >
            Next →
          </Button>
        </HStack>
      </HStack>
    {/if}
  </Stack>
</main>
