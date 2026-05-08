<script lang="ts">
  import { page } from '$app/state';
  import {
    getLatestBankingSession,
    startBankingAuth,
    syncBankingNow,
    type BankingSession,
  } from '$lib/services/banking.service';
  import { Alert, Badge, Button, Heading, HStack, Stack, Text } from '@immich/ui';

  let session = $state<BankingSession | null>(null);
  let loading = $state(false);
  let starting = $state(false);
  let syncing = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  const callbackError = page.url.searchParams.get('error');

  async function load() {
    loading = true;
    error = null;
    try {
      session = await getLatestBankingSession();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  async function connect() {
    starting = true;
    error = null;
    try {
      const result = await startBankingAuth({});
      globalThis.location.href = result.redirectUrl;
    } catch (error_) {
      error = (error_ as Error).message;
      starting = false;
    }
  }

  async function syncNow() {
    syncing = true;
    error = null;
    info = null;
    try {
      await syncBankingNow();
      info = 'Sync queued — refresh in a moment to see new transactions.';
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      syncing = false;
    }
  }

  function daysUntil(iso: string | null): number | null {
    if (!iso) {
      return null;
    }
    const days = (new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    return Math.floor(days);
  }

  function statusColor(status: string): 'success' | 'warning' | 'danger' | 'secondary' {
    if (status === 'active') {
      return 'success';
    }
    if (status === 'pending') {
      return 'warning';
    }
    if (status === 'expired' || status === 'revoked') {
      return 'danger';
    }
    return 'secondary';
  }
</script>

<main class="mx-auto max-w-4xl px-6 py-10">
  <Stack gap={6}>
    <Heading size="large" tag="h1">Banking</Heading>

    {#if callbackError}
      <Alert color="danger">Bank consent failed: <code>{callbackError}</code></Alert>
    {/if}
    {#if error}
      <Alert color="danger">{error}</Alert>
    {/if}
    {#if info}
      <Alert color="success">{info}</Alert>
    {/if}

    {#if loading && !session}
      <Text>Loading…</Text>
    {:else if !session}
      <div class="rounded-lg border border-dashed p-6">
        <Stack gap={3}>
          <Heading size="medium" tag="h2">No bank connected</Heading>
          <Text color="muted">
            Connect a bank via Enable Banking to start ingesting transactions automatically.
          </Text>
          <HStack>
            <Button color="primary" disabled={starting} onclick={connect}>
              {starting ? 'Starting…' : 'Connect bank'}
            </Button>
          </HStack>
        </Stack>
      </div>
    {:else}
      {@const remaining = daysUntil(session.expiresAt)}
      {@const needsReconnect = session.status === 'expired' || session.status === 'revoked'}
      {@const reconnectSoon = session.status === 'active' && remaining !== null && remaining <= 7}

      <div class="rounded-lg border p-6">
        <Stack gap={4}>
          <HStack class="justify-between">
            <Stack gap={1}>
              <Heading size="medium" tag="h2">{session.aspspName}</Heading>
              <Text size="small" color="muted">
                {session.aspspCountry} · {session.psuType}
              </Text>
            </Stack>
            <Badge color={statusColor(session.status)}>{session.status}</Badge>
          </HStack>

          {#if reconnectSoon}
            <Alert color="warning">
              Consent expires in {remaining} day{remaining === 1 ? '' : 's'}. Reconnect to keep
              syncing without interruption.
            </Alert>
          {/if}
          {#if needsReconnect}
            <Alert color="danger">
              This consent is no longer active ({session.status}). Reconnect to resume syncing.
            </Alert>
          {/if}

          <Stack gap={2}>
            <Text size="small" color="muted">Shared accounts</Text>
            {#if session.accounts.length === 0}
              <Text>No accounts shared.</Text>
            {:else}
              <ul class="ml-4 list-disc">
                {#each session.accounts as account (account.uid)}
                  <li>
                    <Text>
                      {account.name ?? account.uid}
                      {#if account.iban}<code>{account.iban}</code>{/if}
                      <span class="text-muted-foreground">· {account.currency}</span>
                    </Text>
                  </li>
                {/each}
              </ul>
            {/if}
          </Stack>

          <HStack gap={2} class="text-sm">
            <Text size="small" color="muted">
              Connected {new Date(session.createdAt).toLocaleDateString()}
            </Text>
            {#if session.expiresAt}
              <Text size="small" color="muted">·</Text>
              <Text size="small" color="muted">
                Expires {new Date(session.expiresAt).toLocaleDateString()}
              </Text>
            {/if}
            {#if session.lastSyncedAt}
              <Text size="small" color="muted">·</Text>
              <Text size="small" color="muted">
                Last synced {new Date(session.lastSyncedAt).toLocaleString()}
              </Text>
            {/if}
          </HStack>

          <HStack gap={3}>
            {#if session.status === 'active'}
              <Button color="primary" disabled={syncing} onclick={syncNow}>
                {syncing ? 'Queuing…' : 'Sync now'}
              </Button>
            {/if}
            <Button variant="ghost" disabled={starting} onclick={connect}>
              {starting ? 'Starting…' : needsReconnect || reconnectSoon ? 'Reconnect' : 'Connect another'}
            </Button>
          </HStack>
        </Stack>
      </div>
    {/if}
  </Stack>
</main>
