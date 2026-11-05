<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import ApiErrorAlert from '$lib/components/ApiErrorAlert.svelte';
  import { majorToMinor } from '$lib/money';
  import { formatIssuePath, type ApiFieldIssue } from '$lib/services/api';
  import { extractApiError } from '$lib/sdk';
  import {
    Class,
    composeInvoiceFromWise,
    getWisePrefill as getWiseInvoicePrefill,
    listClients,
    type ClientResponseDto as ClientResponse,
    type InvoiceComposeResponseDto as InvoiceComposeResponse,
    type WiseInvoicePrefillDto as WiseInvoicePrefill,
  } from '@bo0kkeeper/sdk';
  import { Alert, Button, Field, Heading, HStack, Input, Select, Stack, Text } from '@immich/ui';

  /**
   * Compose a Non-EU invoice from a completed outbound Wise transfer.
   *
   * Currency + amounts come from the wise_transfer (operator doesn't enter
   * FX): `totalMinor` = the source USD billed, `eurTotalMinor` = the EUR
   * that actually landed at SNS (net of Wise's fee + spread). This is what
   * makes the Typst bilingual `$ X (€ Y)` summary line render correctly.
   */
  type LineDraft = {
    description: string;
    /** Major-unit string in the SOURCE currency (USD), e.g. "4791.00". */
    amount: string;
  };

  /** Regular period line, period line + bonus on top, or a standalone bonus (no period). */
  type Shape = 'regular' | 'split' | 'bonus';

  const BONUS_DESCRIPTION = 'Bonus';

  const wiseTransferId = page.params.wiseTransferId as string;

  let prefill = $state<WiseInvoicePrefill | null>(null);
  let prefillError = $state<string | null>(null);
  let clients = $state<ClientResponse[]>([]);

  let clientId = $state('');
  let issuedAt = $state(new Date().toISOString().slice(0, 10));
  let periodStart = $state('');
  let periodEnd = $state('');
  let lines = $state<LineDraft[]>([{ description: '', amount: '' }]);
  let shape = $state<Shape>('regular');

  let submitting = $state(false);
  let error = $state<string | null>(null);
  let issues = $state<ApiFieldIssue[]>([]);
  let result = $state<InvoiceComposeResponse | null>(null);

  function hasIssue(prefix: string): boolean {
    return issues.some((issue) => formatIssuePath(issue.path).startsWith(prefix));
  }

  /** Minor → major decimal string (e.g. "479100" + 2 → "4791.00"). */
  function minorToMajor(minor: string): string {
    const negative = minor.startsWith('-');
    const abs = (negative ? minor.slice(1) : minor).padStart(3, '0');
    const whole = abs.slice(0, -2);
    const cents = abs.slice(-2);
    return `${negative ? '-' : ''}${whole}.${cents}`;
  }

  async function load() {
    try {
      const [pf, cs] = await Promise.all([getWiseInvoicePrefill({ wiseTransferId }), listClients()]);
      prefill = pf;
      clients = cs;
      if (pf.suggestedClientId) {
        clientId = pf.suggestedClientId;
      }
      applyShape(pf.bonusMinor ? 'split' : 'regular');
    } catch (error_) {
      prefillError = extractApiError(error_).message;
    }
  }

  $effect(() => {
    void load();
  });

  /**
   * Period prefilled from the suggested client's last invoice (next half-month);
   * operator can override. Server already substituted any `{period.*}` placeholders
   * in client.defaultDescription, so `suggestedLineDescription` is the final string.
   * A standalone bonus gets no period so it doesn't shift the half-month cadence.
   */
  function applyShape(next: Shape) {
    if (!prefill) {
      return;
    }
    shape = next;
    if (next === 'bonus') {
      periodStart = '';
      periodEnd = '';
      lines = [{ description: BONUS_DESCRIPTION, amount: minorToMajor(prefill.totalMinor) }];
      return;
    }
    periodStart = prefill.suggestedPeriodStart ?? '';
    periodEnd = prefill.suggestedPeriodEnd ?? '';
    lines =
      next === 'split' && prefill.usualTotalMinor && prefill.bonusMinor
        ? [
            { description: prefill.suggestedLineDescription, amount: minorToMajor(prefill.usualTotalMinor) },
            { description: BONUS_DESCRIPTION, amount: minorToMajor(prefill.bonusMinor) },
          ]
        : [{ description: prefill.suggestedLineDescription, amount: minorToMajor(prefill.totalMinor) }];
  }

  const shapeOptions = $derived([
    { value: 'regular', label: 'Regular payment' },
    ...(prefill?.bonusMinor ? [{ value: 'split', label: 'Regular payment + bonus' }] : []),
    { value: 'bonus', label: 'Bonus only' },
  ]);

  /** Lines that get submitted: the ones with both a description and an amount. */
  const filledLines = $derived(lines.filter((l) => l.description.trim() && l.amount.trim()));

  /** Payment minus the submitted lines, in minor units; null while an amount doesn't parse. */
  const unallocatedMinor = $derived.by(() => {
    if (!prefill) {
      return null;
    }
    try {
      const linesMinor = filledLines.reduce((sum, line) => sum + BigInt(majorToMinor(line.amount)), 0n);
      return BigInt(prefill.totalMinor) - linesMinor;
    } catch {
      return null;
    }
  });

  function addLine() {
    lines = [...lines, { description: '', amount: '' }];
  }

  function removeLine(index: number) {
    lines = lines.filter((_, i) => i !== index);
  }

  const clientOptions = $derived([
    { value: '', label: 'Select a client…' },
    ...clients.filter((c) => c.class === Class.NonEu).map((c) => ({ value: c.id, label: c.name })),
  ]);

  function downloadPdf(invoiceId: string) {
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
      result = await composeInvoiceFromWise({
        wiseTransferId,
        invoiceComposeFromWiseDto: {
          clientId,
          issuedAt,
          periodStart: periodStart || undefined,
          periodEnd: periodEnd || undefined,
          lines: filledLines.map((l) => ({
            description: l.description,
            lineTotalMinor: majorToMinor(l.amount),
          })),
        },
      });
    } catch (error_) {
      const extracted = extractApiError(error_);
      error = extracted.message;
      issues = extracted.issues;
    } finally {
      submitting = false;
    }
  }
</script>

<main class="mx-auto max-w-4xl px-6 py-10">
  <Stack gap={6}>
    <Heading size="large" tag="h1">Compose invoice from Wise transfer</Heading>

    {#if prefillError}
      <Alert color="danger">
        <Stack gap={2}>
          <Text>{prefillError}</Text>
          <Text size="small" color="muted">
            This usually means the transfer isn't in <code>outgoing_payment_sent</code>, isn't outbound, or already has
            an invoice composed. Check
            <a href={resolve('/wise/transfers')} class="text-primary underline">/wise/transfers</a>.
          </Text>
        </Stack>
      </Alert>
    {/if}

    {#if error}
      <ApiErrorAlert message={error} {issues} />
    {/if}

    {#if result}
      <Alert color="success">
        <Stack gap={2}>
          <Text>
            Issued invoice <strong>{result.invoice.number}</strong> — paperless archive queued in the background.
          </Text>
          <HStack>
            <Button variant="outline" onclick={() => downloadPdf(result!.invoice.id)}>Download PDF</Button>
            <a href={resolve('/wise/transfers')} class="text-primary underline">Back to transfers</a>
          </HStack>
        </Stack>
      </Alert>
    {/if}

    {#if prefill && !result}
      <Stack gap={2}>
        <Text size="small" color="muted">
          Currency + amounts are derived from the Wise transfer — the EUR figure is what actually landed at SNS (net of
          Wise's fee + spread).
        </Text>
        <HStack gap={6}>
          <Text>
            <strong>{prefill.currency}</strong>
            {minorToMajor(prefill.totalMinor)} → € {minorToMajor(prefill.eurTotalMinor)}
          </Text>
          {#if prefill.ourReference}
            <Text size="small" color="muted">ref <code>{prefill.ourReference}</code></Text>
          {/if}
        </HStack>
      </Stack>

      <Stack gap={4}>
        <HStack gap={3}>
          <Field label="Client" invalid={hasIssue('clientId')}>
            <Select bind:value={clientId} options={clientOptions} />
          </Field>
          <Field label="Issued (YYYY-MM-DD)" invalid={hasIssue('issuedAt')}>
            <Input bind:value={issuedAt} />
          </Field>
        </HStack>

        <Field label="Invoice as">
          <Select value={shape} options={shapeOptions} onChange={(value) => applyShape(value as Shape)} />
        </Field>
        {#if shape === 'split' && prefill.usualTotalMinor && prefill.bonusMinor}
          <Text size="small" color="muted">
            This payment is {prefill.currency}
            {minorToMajor(prefill.bonusMinor)} more than the usual {minorToMajor(prefill.usualTotalMinor)}, so the
            excess is on a bonus line.
          </Text>
        {/if}

        <HStack gap={3}>
          <Field label="Period start (optional)" invalid={hasIssue('periodStart')}>
            <Input bind:value={periodStart} placeholder="YYYY-MM-DD" />
          </Field>
          <Field label="Period end (optional)" invalid={hasIssue('periodEnd')}>
            <Input bind:value={periodEnd} placeholder="YYYY-MM-DD" />
          </Field>
        </HStack>

        <Heading size="small" tag="h2">Lines</Heading>
        <Text size="small" color="muted">
          Line amounts are in <strong>{prefill.currency}</strong>; they have to add up to the source total above. For
          paycheck + bonus + reimbursement on one transfer, split into multiple lines.
        </Text>
        {#each lines as _, index (index)}
          <HStack gap={3}>
            <Field label="Description" invalid={hasIssue(`lines[${index}].description`)}>
              <Input bind:value={lines[index].description} placeholder="e.g. Services Jan 1 – 15" />
            </Field>
            <Field label="Amount ({prefill.currency})" invalid={hasIssue(`lines[${index}].lineTotalMinor`)}>
              <Input bind:value={lines[index].amount} placeholder="0.00" />
            </Field>
            {#if lines.length > 1}
              <Button variant="ghost" onclick={() => removeLine(index)}>Remove</Button>
            {/if}
          </HStack>
        {/each}
        <HStack>
          <Button variant="outline" onclick={addLine}>+ Add line</Button>
        </HStack>
        {#if unallocatedMinor === null}
          <Text size="small" color="danger">Check the line amounts.</Text>
        {:else if unallocatedMinor === 0n}
          <Text size="small" color="success">Lines add up to the payment.</Text>
        {:else}
          <Text size="small" color="danger">
            Lines add up to {prefill.currency}
            {minorToMajor(String(BigInt(prefill.totalMinor) - unallocatedMinor))} of {minorToMajor(prefill.totalMinor)}:
            {#if unallocatedMinor > 0n}
              {minorToMajor(String(unallocatedMinor))} left to allocate.
            {:else}
              {minorToMajor(String(-unallocatedMinor))} over the payment.
            {/if}
          </Text>
        {/if}

        <HStack gap={3}>
          <Button color="primary" disabled={submitting || unallocatedMinor !== 0n} onclick={submit}>
            {submitting ? 'Issuing…' : 'Issue invoice'}
          </Button>
          <a href={resolve('/wise/transfers')} class="text-primary underline">Cancel</a>
        </HStack>
      </Stack>
    {/if}
  </Stack>
</main>
