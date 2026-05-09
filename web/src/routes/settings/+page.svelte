<script lang="ts">
  import ApiErrorAlert from '$lib/components/ApiErrorAlert.svelte';
  import { ApiError, type ApiFieldIssue } from '$lib/services/api';
  import { rescanPaperless, type RescanPaperlessResponse } from '$lib/services/expenses.service';
  import {
    checkPaperlessTags,
    getSettings,
    updateSettings,
    type PaperlessTagCheckResult,
    type SettingsResponse,
  } from '$lib/services/settings.service';
  import {
    Alert,
    Button,
    Field,
    Heading,
    HStack,
    Input,
    Stack,
    Text,
    Textarea,
  } from '@immich/ui';

  let loaded = $state<SettingsResponse | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let issues = $state<ApiFieldIssue[]>([]);
  let info = $state<string | null>(null);

  let tagCheckResults = $state<PaperlessTagCheckResult[] | null>(null);
  let tagCheckRunning = $state(false);
  let tagCheckError = $state<string | null>(null);

  let rescanRunning = $state(false);
  let rescanResult = $state<RescanPaperlessResponse | null>(null);
  let rescanError = $state<string | null>(null);

  // Local draft state (so the user can edit without touching the server until Save).
  let kvk = $state('');
  let vatId = $state('');
  let addressLine1 = $state('');
  let postalCode = $state('');
  let city = $state('');
  let country = $state('');
  let iban = $state('');
  let expenseTagsRaw = $state('');
  let outgoingInvoiceTagsRaw = $state('');

  function applyToDraft(s: SettingsResponse) {
    kvk = s.issuer.kvk;
    vatId = s.issuer.vatId;
    addressLine1 = s.issuer.addressLine1;
    postalCode = s.issuer.postalCode;
    city = s.issuer.city;
    country = s.issuer.country;
    iban = s.issuer.iban;
    expenseTagsRaw = s.paperless.expenseTags.join(', ');
    outgoingInvoiceTagsRaw = s.paperless.outgoingInvoiceTags.join(', ');
  }

  async function load() {
    loading = true;
    error = null;
    issues = [];
    try {
      loaded = await getSettings();
      applyToDraft(loaded);
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function splitTags(raw: string): string[] {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async function save() {
    saving = true;
    error = null;
    issues = [];
    info = null;
    try {
      const updated = await updateSettings({
        issuer: { kvk, vatId, addressLine1, postalCode, city, country, iban },
        paperless: {
          expenseTags: splitTags(expenseTagsRaw),
          outgoingInvoiceTags: splitTags(outgoingInvoiceTagsRaw),
        },
      });
      loaded = updated;
      applyToDraft(updated);
      info = `Saved ${new Date(updated.updatedAt).toLocaleTimeString()}`;
    } catch (error_) {
      if (error_ instanceof ApiError) {
        error = error_.message;
        issues = error_.issues;
      } else {
        error = (error_ as Error).message;
      }
    } finally {
      saving = false;
    }
  }

  function reset() {
    if (loaded) {
      applyToDraft(loaded);
      info = null;
    }
  }

  async function runRescan() {
    rescanRunning = true;
    rescanError = null;
    rescanResult = null;
    try {
      rescanResult = await rescanPaperless();
    } catch (error_) {
      rescanError = (error_ as Error).message;
    } finally {
      rescanRunning = false;
    }
  }

  async function runTagCheck() {
    tagCheckRunning = true;
    tagCheckError = null;
    tagCheckResults = null;
    try {
      const tags = [...new Set([...splitTags(expenseTagsRaw), ...splitTags(outgoingInvoiceTagsRaw)])];
      if (tags.length === 0) {
        tagCheckResults = [];
        return;
      }
      const response = await checkPaperlessTags(tags);
      tagCheckResults = response.results;
    } catch (error_) {
      tagCheckError = (error_ as Error).message;
    } finally {
      tagCheckRunning = false;
    }
  }
</script>

<main class="mx-auto max-w-3xl px-6 py-10">
  <Stack gap={6}>
    <Heading size="large" tag="h1">Settings</Heading>

    {#if error}
      <ApiErrorAlert message={error} {issues} />
    {/if}
    {#if info}
      <Alert color="success">{info}</Alert>
    {/if}

    {#if loading && !loaded}
      <Text>Loading…</Text>
    {:else if loaded}
      <div class="rounded border p-4">
        <Stack gap={4}>
          <Heading size="medium" tag="h2">Issuer</Heading>
          <Text size="small" color="muted">
            Printed on every invoice. KvK + VAT id are required by Dutch tax law.
          </Text>
          <HStack gap={3}>
            <Field label="KvK"><Input bind:value={kvk} /></Field>
            <Field label="VAT id"><Input bind:value={vatId} /></Field>
          </HStack>
          <Field label="Address line 1"><Input bind:value={addressLine1} /></Field>
          <HStack gap={3}>
            <Field label="Postal code"><Input bind:value={postalCode} /></Field>
            <Field label="City"><Input bind:value={city} /></Field>
            <Field label="Country"><Input bind:value={country} /></Field>
          </HStack>
          <Field label="IBAN (printed on domestic invoice payment block)">
            <Input bind:value={iban} />
          </Field>
        </Stack>
      </div>

      <div class="rounded border p-4">
        <Stack gap={4}>
          <Heading size="medium" tag="h2">Paperless tags</Heading>
          <Text size="small" color="muted">
            Comma-separated names. Tags get auto-created in paperless on first use.
          </Text>
          <Field label="Expense ingestion tag-gate (doc must carry ALL of these)">
            <Textarea bind:value={expenseTagsRaw} placeholder="Business, Bills" />
          </Field>
          <Field label="Outgoing invoice tags (applied when an invoice is uploaded)">
            <Textarea bind:value={outgoingInvoiceTagsRaw} placeholder="Business, Invoice, bo0kkeeper" />
          </Field>
          <HStack gap={3} class="items-center">
            <Button size="small" variant="ghost" disabled={tagCheckRunning} onclick={runTagCheck}>
              {tagCheckRunning ? 'Checking…' : 'Check tags exist in paperless'}
            </Button>
            <Text size="small" color="muted">
              Catches typos before save (e.g. <code>Buisness</code> vs <code>Business</code>).
            </Text>
          </HStack>
          {#if tagCheckError}
            <Alert color="danger">Tag check failed: {tagCheckError}</Alert>
          {/if}
          {#if tagCheckResults}
            {#if tagCheckResults.length === 0}
              <Text size="small" color="muted">No tags configured.</Text>
            {:else}
              {@const missing = tagCheckResults.filter((r) => !r.exists)}
              {#if missing.length === 0}
                <Alert color="success">
                  All {tagCheckResults.length} tag{tagCheckResults.length === 1 ? '' : 's'} exist in paperless.
                </Alert>
              {:else}
                <Alert color="warning">
                  {missing.length} of {tagCheckResults.length} tag{tagCheckResults.length === 1 ? '' : 's'} not found in paperless: {missing.map((r) => r.name).join(', ')}.
                </Alert>
              {/if}
            {/if}
          {/if}
        </Stack>
      </div>

      <div class="rounded border p-4">
        <Stack gap={4}>
          <Heading size="medium" tag="h2">Paperless backfill</Heading>
          <Text size="small" color="muted">
            Walks paperless for documents that carry the expense tag-gate and were created on or after
            <code>CUTOVER_DATE</code>, then runs each through the regular ingestion pipeline. Use this
            after wiring up the workflow against an inbox of pre-tagged docs, or to recover from a
            dropped webhook delivery. Idempotent — re-runs are safe.
          </Text>
          <HStack gap={3} class="items-center">
            <Button size="small" disabled={rescanRunning} onclick={runRescan}>
              {rescanRunning ? 'Scanning…' : 'Backfill from paperless'}
            </Button>
            <Text size="small" color="muted">May take a moment for large inboxes.</Text>
          </HStack>
          {#if rescanError}
            <Alert color="danger">{rescanError}</Alert>
          {/if}
          {#if rescanResult}
            <Alert color={rescanResult.enqueued > 0 ? 'success' : 'secondary'}>
              Scanned {rescanResult.scanned} doc{rescanResult.scanned === 1 ? '' : 's'};
              {rescanResult.enqueued} new event{rescanResult.enqueued === 1 ? '' : 's'} enqueued,
              {rescanResult.alreadyIngested} already ingested.
              {#if rescanResult.droppedBeforeCutover > 0}
                {rescanResult.droppedBeforeCutover} dropped (date before cutover — should be 0).
              {/if}
            </Alert>
          {/if}
        </Stack>
      </div>

      <HStack gap={3}>
        <Button variant="ghost" onclick={reset} disabled={saving}>Reset</Button>
        <Button color="primary" onclick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </HStack>

      <Text size="small" color="muted">
        Last saved {new Date(loaded.updatedAt).toLocaleString()}.
      </Text>
    {/if}
  </Stack>
</main>
