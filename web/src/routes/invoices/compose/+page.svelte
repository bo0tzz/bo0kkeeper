<script lang="ts">
  import ApiErrorAlert from '$lib/components/ApiErrorAlert.svelte';
  import { ApiError, formatIssuePath, type ApiFieldIssue } from '$lib/services/api';
  import { listClients, type ClientResponse } from '$lib/services/clients.service';
  import { composeInvoice, type InvoiceComposeResponse } from '$lib/services/invoices.service';
  import { Alert, Button, Field, Heading, HStack, Input, Select, Stack, Text } from '@immich/ui';

  type LineDraft = {
    description: string;
    unitLabel: string;
    quantity: string;
    /** Major-unit string (e.g. "165.00"). */
    amount: string;
  };

  let clients = $state<ClientResponse[]>([]);
  let clientsError = $state<string | null>(null);

  let clientId = $state('');
  let issuedAt = $state(new Date().toISOString().slice(0, 10));
  let periodStart = $state('');
  let periodEnd = $state('');
  let currency = $state('EUR');
  let btwRatePercent = $state('21');
  let lines = $state<LineDraft[]>([{ description: '', unitLabel: '', quantity: '', amount: '' }]);

  let submitting = $state(false);
  let error = $state<string | null>(null);
  let issues = $state<ApiFieldIssue[]>([]);
  let result = $state<InvoiceComposeResponse | null>(null);

  /** Lookup helper: any issue paths starting with `<prefix>` (so `lines.0.amount` matches `lines.0`). */
  function hasIssue(prefix: string): boolean {
    return issues.some((issue) => formatIssuePath(issue.path).startsWith(prefix));
  }

  async function loadClients() {
    try {
      clients = await listClients();
    } catch (error_) {
      clientsError = (error_ as Error).message;
    }
  }

  $effect(() => {
    void loadClients();
  });

  function addLine() {
    lines = [...lines, { description: '', unitLabel: '', quantity: '', amount: '' }];
  }

  function removeLine(index: number) {
    lines = lines.filter((_, i) => i !== index);
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

  const clientOptions = $derived([
    { value: '', label: 'Select a client…' },
    ...clients.map((c) => ({ value: c.id, label: `${c.name} (${c.class})` })),
  ]);

  function downloadPdf(invoiceId: string) {
    // Programmatic anchor click bypasses SvelteKit's typed-routing — these
    // are server endpoints, not SvelteKit pages, so the typed router doesn't
    // know about them.
    const a = document.createElement('a');
    a.href = `/api/invoices/${invoiceId}/pdf`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function submit() {
    if (!clientId) {
      error = 'Pick a client first.';
      return;
    }
    submitting = true;
    error = null;
    issues = [];
    try {
      result = await composeInvoice({
        clientId,
        issuedAt,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        currency,
        btwRateBps: btwRatePercent.trim() === '' ? undefined : Math.round(Number(btwRatePercent) * 100),
        lines: lines
          .filter((l) => l.description.trim() && l.amount.trim())
          .map((l) => ({
            description: l.description,
            unitLabel: l.unitLabel || undefined,
            quantity: l.quantity || undefined,
            lineTotalMinor: majorToMinor(l.amount),
          })),
      });
    } catch (error_) {
      if (error_ instanceof ApiError) {
        error = error_.message;
        issues = error_.issues;
      } else {
        error = (error_ as Error).message;
      }
    } finally {
      submitting = false;
    }
  }
</script>

<main class="mx-auto max-w-4xl px-6 py-10">
  <Stack gap={6}>
    <Heading size="large" tag="h1">Compose invoice</Heading>

    {#if clientsError}
      <Alert color="danger">Failed to load clients: {clientsError}</Alert>
    {/if}

    {#if error}
      <ApiErrorAlert message={error} {issues} />
    {/if}

    {#if result}
      <Alert color="success">
        <Stack gap={2}>
          <Text>
            Issued invoice <strong>{result.invoice.number}</strong>
            {#if result.paperlessDocId}
              — archived as paperless doc <code>{result.paperlessDocId}</code>.
            {:else}
              — paperless archive failed or unconfigured (the invoice is still persisted; you can download the PDF below
              and upload manually).
            {/if}
          </Text>
          <HStack>
            <Button variant="outline" onclick={() => downloadPdf(result!.invoice.id)}>Download PDF</Button>
          </HStack>
        </Stack>
      </Alert>
    {/if}

    <Stack gap={4}>
      <HStack gap={3}>
        <Field label="Client" invalid={hasIssue('clientId')}>
          <Select bind:value={clientId} options={clientOptions} />
        </Field>
        <Field label="Currency" invalid={hasIssue('currency')}>
          <Input bind:value={currency} placeholder="EUR" />
        </Field>
        <Field label="BTW rate (%)" invalid={hasIssue('btwRateBps')}>
          <Input bind:value={btwRatePercent} placeholder="21" />
        </Field>
      </HStack>

      <HStack gap={3}>
        <Field label="Issued (YYYY-MM-DD)" invalid={hasIssue('issuedAt')}>
          <Input bind:value={issuedAt} />
        </Field>
        <Field label="Period start (optional)" invalid={hasIssue('periodStart')}>
          <Input bind:value={periodStart} placeholder="YYYY-MM-DD" />
        </Field>
        <Field label="Period end (optional)" invalid={hasIssue('periodEnd')}>
          <Input bind:value={periodEnd} placeholder="YYYY-MM-DD" />
        </Field>
      </HStack>

      <Heading size="small" tag="h2">Lines</Heading>
      {#each lines as _, index (index)}
        <HStack gap={3}>
          <Field label="Description" invalid={hasIssue(`lines[${index}].description`)}>
            <Input bind:value={lines[index].description} />
          </Field>
          <Field label="Unit (€/hr)" invalid={hasIssue(`lines[${index}].unitLabel`)}>
            <Input bind:value={lines[index].unitLabel} placeholder="" />
          </Field>
          <Field label="Quantity" invalid={hasIssue(`lines[${index}].quantity`)}>
            <Input bind:value={lines[index].quantity} placeholder="" />
          </Field>
          <Field label="Amount" invalid={hasIssue(`lines[${index}].lineTotalMinor`)}>
            <Input bind:value={lines[index].amount} placeholder="0.00" />
          </Field>
          <Button variant="ghost" color="danger" onclick={() => removeLine(index)} disabled={lines.length === 1}>
            Remove
          </Button>
        </HStack>
      {/each}

      <HStack>
        <Button variant="outline" onclick={addLine}>Add line</Button>
      </HStack>

      <HStack>
        <Button color="primary" disabled={submitting} onclick={submit}>
          {submitting ? 'Issuing…' : 'Issue invoice'}
        </Button>
      </HStack>
    </Stack>

    {#if result}
      <Stack gap={2}>
        <Heading size="small" tag="h2">Issued invoice</Heading>
        <Text size="small" color="muted">
          Number: <code>{result.invoice.number}</code> · Total minor: <code>{result.invoice.totalMinor}</code>
        </Text>
      </Stack>
    {/if}
  </Stack>
</main>
