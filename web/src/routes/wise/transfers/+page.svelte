<script lang="ts">
  import { resolve } from '$app/paths';
  import { listWiseTransfers, reconcileWise, type WiseTransferResponse } from '$lib/services/wise.service';
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

  let transfers = $state<WiseTransferResponse[]>([]);
  let loading = $state(false);
  let reconciling = $state(false);
  let info = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      transfers = await listWiseTransfers();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  async function reconcile() {
    reconciling = true;
    info = null;
    error = null;
    try {
      await reconcileWise();
      info = 'Reconcile queued. Refreshing in a moment…';
      setTimeout(() => void load(), 2500);
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      reconciling = false;
    }
  }

  function formatAmount(minor: string, currency: string): string {
    const negative = minor.startsWith('-');
    const abs = (negative ? minor.slice(1) : minor).padStart(3, '0');
    const major = abs.slice(0, -2);
    const cents = abs.slice(-2);
    return `${negative ? '-' : ''}${major}.${cents} ${currency}`;
  }

  function stateColor(state: string): 'success' | 'warning' | 'danger' | 'secondary' {
    if (state === 'outgoing_payment_sent') {
      return 'success';
    }
    if (state === 'cancelled' || state === 'failed') {
      return 'danger';
    }
    if (state === 'incoming_payment_waiting' || state === 'processing' || state === 'funds_converted') {
      return 'warning';
    }
    return 'secondary';
  }
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <HStack class="justify-between">
      <Heading size="large" tag="h1">Wise transfers</Heading>
      <HStack gap={2}>
        <Button size="small" variant="ghost" href={resolve('/wise')}>← Inbox</Button>
        <Button size="small" variant="ghost" disabled={reconciling} onclick={reconcile}>
          {reconciling ? 'Reconciling…' : 'Reconcile'}
        </Button>
      </HStack>
    </HStack>

    {#if error}
      <Alert color="danger">{error}</Alert>
    {/if}
    {#if info}
      <Alert color="success">{info}</Alert>
    {/if}

    {#if loading && transfers.length === 0}
      <Text>Loading…</Text>
    {:else if transfers.length === 0}
      <Text color="muted">No transfers yet.</Text>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeading>Reference</TableHeading>
            <TableHeading>Wise ID</TableHeading>
            <TableHeading>Direction</TableHeading>
            <TableHeading>State</TableHeading>
            <TableHeading class="text-right">Source</TableHeading>
            <TableHeading class="text-right">Target</TableHeading>
            <TableHeading class="text-right">Rate</TableHeading>
            <TableHeading class="text-right">Fee</TableHeading>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each transfers as t (t.id)}
            <TableRow>
              <TableCell>
                {#if t.ourReference}<code>{t.ourReference}</code>{:else}—{/if}
              </TableCell>
              <TableCell><code>{t.wiseTransferId}</code></TableCell>
              <TableCell>{t.direction}</TableCell>
              <TableCell><Badge color={stateColor(t.state)}>{t.state}</Badge></TableCell>
              <TableCell class="text-right">{formatAmount(t.sourceAmountMinor, t.sourceCurrency)}</TableCell>
              <TableCell class="text-right">{formatAmount(t.targetAmountMinor, t.targetCurrency)}</TableCell>
              <TableCell class="text-right">{t.fxRate ?? '—'}</TableCell>
              <TableCell class="text-right">
                {Number(t.feeMinor) === 0 ? '—' : formatAmount(t.feeMinor, t.feeCurrency)}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  </Stack>
</main>
