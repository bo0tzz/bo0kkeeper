<script lang="ts">
  import { resolve } from '$app/paths';
  import { listInvoices, type InvoiceListItem } from '$lib/services/invoices.service';
  import {
    Alert,
    Badge,
    Button,
    Heading,
    HStack,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';

  let invoices = $state<InvoiceListItem[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      invoices = await listInvoices();
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
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <HStack class="justify-between">
      <Heading size="large" tag="h1">Invoices</Heading>
      <Button color="primary" href={resolve('/invoices/compose')}>New invoice</Button>
    </HStack>

    {#if error}
      <Alert color="danger">{error}</Alert>
    {/if}

    {#if loading && invoices.length === 0}
      <Text>Loading…</Text>
    {:else if invoices.length === 0}
      <Text color="muted">No invoices yet.</Text>
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
              <TableCell>
                <HStack gap={2}>
                  <Button size="small" variant="ghost" href={`/api/invoices/${inv.id}/pdf`}>PDF ↓</Button>
                  {#if inv.paperlessDocId}
                    <Button
                      size="small"
                      variant="ghost"
                      href={`/api/invoices/${inv.id}/paperless`}
                      target="_blank"
                    >
                      Paperless ↗
                    </Button>
                  {/if}
                </HStack>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  </Stack>
</main>
