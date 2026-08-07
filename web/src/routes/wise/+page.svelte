<script lang="ts">
  import { formatDateTime } from '$lib/format';
  import { dismissEvent, listEvents, type EventResponse, type ListEventsResponse } from '$lib/services/events.service';
  import { draftFromEvent, reconcileWise, type WiseTransferResponse } from '$lib/services/wise.service';
  import {
    Alert,
    Badge,
    Button,
    Checkbox,
    Field,
    Heading,
    Input,
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

  let data = $state<ListEventsResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let drafting = $state<string | null>(null);
  let dismissing = $state<string | null>(null);
  let drafts = $state<Record<string, string>>({});
  // Per-event "I spent from this Wise balance already; sweep the remainder"
  // toggle. Bypasses the balance-≥-credit guard in wise-draft.service.ts.
  let underCredit = $state<Record<string, boolean>>({});
  let lastDrafted = $state<WiseTransferResponse | null>(null);
  let reconciling = $state(false);
  let reconcileInfo = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      data = await listEvents({
        source: 'wise',
        eventType: 'balances#credit',
        status: 'pending',
        limit: PAGE_SIZE,
        offset: 0,
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

  function creditAmount(event: EventResponse): string {
    const data = event.payload['data'] as { amount?: number; currency?: string } | undefined;
    if (data?.amount === undefined) {
      return '—';
    }
    const currency = data.currency ?? '';
    return `${data.amount.toFixed(2)} ${currency}`;
  }

  async function draft(event: EventResponse) {
    drafting = event.id;
    error = null;
    try {
      const reference = drafts[event.id]?.trim() || undefined;
      lastDrafted = await draftFromEvent(event.id, {
        ourReference: reference,
        allowUnderCredit: underCredit[event.id] || undefined,
      });
      delete drafts[event.id];
      delete underCredit[event.id];
      await load();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      drafting = null;
    }
  }

  async function dismiss(event: EventResponse) {
    // Confirm dismiss so accidental clicks don't drop signal from the inbox.
    // The event isn't deleted (status=skipped, audit-trailed), but the UI
    // won't surface it again — the balance sitting behind it will get
    // swept when the next larger transfer drafts.
    if (!confirm(`Dismiss ${creditAmount(event)}? It'll wait in the Wise balance to be swept next time.`)) {
      return;
    }
    dismissing = event.id;
    error = null;
    try {
      await dismissEvent(event.id);
      await load();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      dismissing = null;
    }
  }

  async function reconcile() {
    reconciling = true;
    error = null;
    reconcileInfo = null;
    try {
      await reconcileWise();
      reconcileInfo = 'Reconcile queued. Transfer states will refresh in a moment.';
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      reconciling = false;
    }
  }
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <div class="flex items-center justify-between">
      <Heading size="large" tag="h1">Wise drafts</Heading>
      <div class="flex items-center gap-3">
        <Text size="small" color="muted">
          {data ? `${data.total} pending` : ''}
        </Text>
        <Button size="small" variant="ghost" href="/wise/transfers">Transfers →</Button>
        <Button size="small" variant="ghost" disabled={reconciling} onclick={reconcile}>
          {reconciling ? 'Reconciling…' : 'Reconcile transfers'}
        </Button>
      </div>
    </div>

    {#if error}
      <Alert color="danger">Failed: {error}</Alert>
    {/if}

    {#if reconcileInfo}
      <Alert color="success">{reconcileInfo}</Alert>
    {/if}

    {#if lastDrafted}
      <Alert color="success">
        Drafted Wise transfer {lastDrafted.wiseTransferId}
        {#if lastDrafted.ourReference}as <code>{lastDrafted.ourReference}</code>{/if}
        — confirm in the Wise app to send.
      </Alert>
    {/if}

    {#if loading && !data}
      <Text>Loading…</Text>
    {:else if data}
      {#if data.items.length === 0}
        <Text color="muted">No pending Wise balance credits to draft from.</Text>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeading>Occurred</TableHeading>
              <TableHeading>Credit amount</TableHeading>
              <TableHeading>Status</TableHeading>
              <TableHeading>TXN reference (optional)</TableHeading>
              <TableHeading>Action</TableHeading>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.items as event (event.id)}
              <TableRow>
                <TableCell class="whitespace-nowrap">{formatDateTime(new Date(event.occurredAt))}</TableCell>
                <TableCell>{creditAmount(event)}</TableCell>
                <TableCell><Badge color="warning">{event.status}</Badge></TableCell>
                <TableCell>
                  <Field label="">
                    <Input bind:value={drafts[event.id]} placeholder="auto-allocated" />
                  </Field>
                  <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={underCredit[event.id] ?? false}
                      onCheckedChange={(v) => (underCredit[event.id] = Boolean(v))}
                      size="small"
                    />
                    <span>Spent from this balance already (sweep remainder)</span>
                  </label>
                </TableCell>
                <TableCell>
                  <div class="flex gap-2">
                    <Button
                      color="primary"
                      disabled={drafting !== null || dismissing !== null}
                      onclick={() => draft(event)}
                    >
                      {drafting === event.id ? 'Drafting…' : 'Draft transfer'}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={drafting !== null || dismissing !== null}
                      onclick={() => dismiss(event)}
                    >
                      {dismissing === event.id ? 'Dismissing…' : 'Dismiss'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    {/if}
  </Stack>
</main>
