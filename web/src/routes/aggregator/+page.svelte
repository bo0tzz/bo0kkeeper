<script lang="ts">
  import { formatDate } from '$lib/format';
  import { formatEur as eur } from '$lib/money';
  import {
    closePeriod,
    getQuarterlyAggregate,
    reopenPeriod,
    type AggregatorWarning,
    type ClientClass,
    type QuarterlyAggregateResponse,
  } from '$lib/services/aggregator.service';
  import { Alert, Badge, Button, Heading, HStack, Select, Stack, Text } from '@immich/ui';

  const now = new Date();
  let year = $state<string>(String(now.getUTCFullYear()));
  let quarter = $state<string>(String(Math.floor(now.getUTCMonth() / 3) + 1));
  let data = $state<QuarterlyAggregateResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      data = await getQuarterlyAggregate(Number(year), Number(quarter));
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  let closing = $state(false);
  async function close() {
    closing = true;
    try {
      await closePeriod(Number(year), Number(quarter));
      await load();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      closing = false;
    }
  }
  async function reopen() {
    closing = true;
    try {
      await reopenPeriod(Number(year), Number(quarter));
      await load();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      closing = false;
    }
  }

  const classLabels: Record<ClientClass, string> = {
    non_eu: 'Non-EU (export)',
    eu: 'EU (BTW charged)',
    eu_reverse_charge: 'EU reverse-charge',
    domestic: 'Domestic',
  };

  const yearOptions = Array.from({ length: 6 }, (_, index) => {
    const value = String(now.getUTCFullYear() - 2 + index);
    return { value, label: value };
  });
  const quarterOptions = [1, 2, 3, 4].map((value) => ({ value: String(value), label: `Q${value}` }));

  function warningTitle(w: AggregatorWarning): string {
    switch (w.kind) {
      case 'invoice_unmatched': {
        return `${w.count} invoice${w.count === 1 ? '' : 's'} not yet matched to a bank tx`;
      }
      case 'expense_pending_review': {
        return `${w.count} expense${w.count === 1 ? '' : 's'} still pending review`;
      }
      case 'expense_low_confidence_match': {
        return `${w.count} bank tx match${w.count === 1 ? '' : 'es'} need manual confirmation`;
      }
    }
  }

  function warningSamples(w: AggregatorWarning): string[] {
    switch (w.kind) {
      case 'invoice_unmatched': {
        return w.sampleNumbers;
      }
      case 'expense_pending_review': {
        return w.sampleVendors;
      }
      case 'expense_low_confidence_match': {
        return w.sampleIds;
      }
    }
  }
</script>

<main class="mx-auto max-w-5xl px-6 py-10">
  <Stack gap={6}>
    <Heading size="large" tag="h1">BTW-aangifte rollup</Heading>

    <HStack class="justify-between">
      <HStack gap={3}>
        <Select bind:value={year} options={yearOptions} />
        <Select bind:value={quarter} options={quarterOptions} />
        {#if data?.closedAt}
          <Badge color="success">closed {formatDate(new Date(data.closedAt))}</Badge>
        {/if}
      </HStack>
      <HStack gap={2}>
        {#if data}
          {#if data.closedAt}
            <Button size="small" variant="ghost" disabled={closing} onclick={reopen}>Reopen</Button>
          {:else}
            <Button size="small" variant="ghost" disabled={closing} onclick={close}>
              {closing ? 'Closing…' : 'Mark filed'}
            </Button>
          {/if}
        {/if}
        <Button
          size="small"
          variant="ghost"
          href={`/api/aggregator/quarterly/export.xlsx?year=${year}&quarter=${quarter}`}
        >
          Export for accountant ↓
        </Button>
      </HStack>
    </HStack>

    {#if error}
      <Alert color="danger">Failed to load aggregate: {error}</Alert>
    {/if}

    {#if loading && !data}
      <Text>Loading…</Text>
    {:else if data}
      <Stack gap={4}>
        {#if data.warnings.length > 0}
          <Stack gap={2}>
            <Heading size="small" tag="h2">Warnings</Heading>
            {#each data.warnings as w (w.kind)}
              <Alert color="warning">
                <Stack gap={1}>
                  <Text>{warningTitle(w)}</Text>
                  {#if warningSamples(w).length > 0}
                    <Text size="small" color="muted">
                      Samples: {warningSamples(w).slice(0, 5).join(', ')}
                    </Text>
                  {/if}
                </Stack>
              </Alert>
            {/each}
          </Stack>
        {/if}

        <div class="rounded border p-4">
          <Stack gap={3}>
            <Heading size="small" tag="h2">Income</Heading>
            <table class="w-full">
              <thead>
                <tr class="text-left">
                  <th>Class</th>
                  <th class="text-right"># invoices</th>
                  <th class="text-right">Gross</th>
                  <th class="text-right">BTW</th>
                </tr>
              </thead>
              <tbody>
                {#each Object.entries(data.income.byClass) as [cls, bucket] (cls)}
                  <tr class="border-t">
                    <td>{classLabels[cls as ClientClass]}</td>
                    <td class="text-right">{bucket.invoiceCount}</td>
                    <td class="text-right">{eur(bucket.grossEurMinor)}</td>
                    <td class="text-right">{eur(bucket.btwEurMinor)}</td>
                  </tr>
                {/each}
                <tr class="border-t font-semibold">
                  <td>Total</td>
                  <td></td>
                  <td class="text-right">{eur(data.income.totalGrossEurMinor)}</td>
                  <td class="text-right">{eur(data.income.totalBtwEurMinor)}</td>
                </tr>
              </tbody>
            </table>
          </Stack>
        </div>

        <div class="rounded border p-4">
          <Stack gap={3}>
            <Heading size="small" tag="h2">Expenses</Heading>
            <HStack gap={6}>
              <Stack gap={0}>
                <Text size="small" color="muted">Gross</Text>
                <Text>{eur(data.expenses.grossEurMinor)}</Text>
              </Stack>
              <Stack gap={0}>
                <Text size="small" color="muted">Deductible BTW</Text>
                <Text>{eur(data.expenses.deductibleBtwEurMinor)}</Text>
              </Stack>
            </HStack>
          </Stack>
        </div>

        <div class="rounded border p-4">
          <Stack gap={3}>
            <Heading size="small" tag="h2">Net BTW</Heading>
            <HStack gap={3} class="items-center">
              <Heading size="medium" tag="h3">{eur(data.netBtwEurMinor)}</Heading>
              <Badge color={BigInt(data.netBtwEurMinor) >= 0n ? 'primary' : 'success'}>
                {BigInt(data.netBtwEurMinor) >= 0n ? 'owed' : 'refund'}
              </Badge>
            </HStack>
            <Text size="small" color="muted">
              Period {data.periodStart.slice(0, 10)} – {data.periodEnd.slice(0, 10)}
            </Text>
          </Stack>
        </div>

        <HStack>
          <Button variant="ghost" onclick={() => load()}>Refresh</Button>
        </HStack>
      </Stack>
    {/if}
  </Stack>
</main>
