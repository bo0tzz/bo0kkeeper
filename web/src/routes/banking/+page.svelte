<script lang="ts">
  import { page } from '$app/state';
  import { formatDate, formatDateTime } from '$lib/format';
  import {
    clearBankTxMatch,
    getLatestBankingSession,
    listBankingAspsps,
    listBankTransactions,
    listMatchCandidates,
    setBankTxCategory,
    setBankTxMatch,
    startBankingAuth,
    syncBankingNow,
    type BankingAspsp,
    type BankingSession,
    type BankTransaction,
    type BankTxCategory,
    type BankTxStatusFilter,
    type ListBankTransactionsResponse,
    type MatchCandidates,
  } from '$lib/services/banking.service';
  import {
    Alert,
    Badge,
    Button,
    Field,
    Heading,
    HStack,
    Input,
    Modal,
    ModalBody,
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

  let session = $state<BankingSession | null>(null);
  let txData = $state<ListBankTransactionsResponse | null>(null);
  let loading = $state(false);
  let starting = $state(false);
  let syncing = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  // ASPSP picker: loaded once from the catalog. Persists across reconnects.
  let aspsps = $state<BankingAspsp[]>([]);
  let selectedAspspName = $state<string>('');
  let selectedPsuType = $state<'personal' | 'business'>('personal');

  let dateFrom = $state('');
  let dateTo = $state('');
  let status = $state<'' | BankTxStatusFilter>('');
  let txPage = $state(1);

  const statusOptions = [
    { value: '', label: 'Any status' },
    { value: 'unmatched', label: 'Unmatched' },
    { value: 'matched', label: 'Matched' },
    { value: 'categorized', label: 'Categorized' },
  ];

  let linkingTx = $state<BankTransaction | null>(null);
  let candidates = $state<MatchCandidates>({ transfers: [], invoices: [], expenses: [] });
  let candidateQuery = $state('');
  let candidatesLoading = $state(false);
  let linking = $state(false);

  const callbackError = page.url.searchParams.get('error');

  async function loadSession() {
    try {
      session = await getLatestBankingSession();
    } catch (error_) {
      error = (error_ as Error).message;
    }
  }

  async function loadTx() {
    try {
      txData = await listBankTransactions({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        status: status || undefined,
        page: txPage,
        limit: PAGE_SIZE,
      });
    } catch (error_) {
      error = (error_ as Error).message;
    }
  }

  async function load() {
    loading = true;
    error = null;
    try {
      await Promise.all([loadSession(), loadTx(), loadAspsps()]);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function applyTxFilters() {
    txPage = 1;
    void loadTx();
  }

  function clearTxFilters() {
    dateFrom = '';
    dateTo = '';
    status = '';
    txPage = 1;
    void loadTx();
  }

  let totalPages = $derived(txData ? Math.max(1, Math.ceil(txData.total / PAGE_SIZE)) : 1);
  let transactions = $derived<BankTransaction[]>(txData?.items ?? []);

  function replaceTx(updated: BankTransaction) {
    if (!txData) {
      return;
    }
    txData = {
      ...txData,
      items: txData.items.map((row) => (row.id === updated.id ? updated : row)),
    };
  }

  async function connectWith(name: string, country: string, psuType: 'personal' | 'business') {
    starting = true;
    error = null;
    try {
      const result = await startBankingAuth({ aspspName: name, aspspCountry: country, psuType });
      globalThis.location.href = result.redirectUrl;
    } catch (error_) {
      error = (error_ as Error).message;
      starting = false;
    }
  }

  async function connect() {
    const aspsp = aspsps.find((a) => a.name === selectedAspspName);
    if (!aspsp) {
      error = 'Pick a bank first.';
      return;
    }
    await connectWith(aspsp.name, aspsp.country, selectedPsuType);
  }

  async function reconnect() {
    if (!session) {
      return;
    }
    const psuType = session.psuType === 'business' ? 'business' : 'personal';
    await connectWith(session.aspspName, session.aspspCountry, psuType);
  }

  async function loadAspsps() {
    try {
      const result = await listBankingAspsps('NL');
      aspsps = result.aspsps;
      // Default to whatever the existing session uses, otherwise leave empty
      // so the operator has to make an explicit choice.
      const current = session;
      if (current && aspsps.some((a) => a.name === current.aspspName)) {
        selectedAspspName = current.aspspName;
      }
    } catch (error_) {
      // Non-fatal: show the catalog as empty + an error message.
      error = `Couldn't load bank list: ${(error_ as Error).message}`;
    }
  }

  async function syncNow() {
    syncing = true;
    error = null;
    info = null;
    try {
      await syncBankingNow();
      info = 'Sync queued. Refreshing in a moment…';
      // Give the worker a beat to pull, then re-pull the list.
      setTimeout(() => void load(), 2500);
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      syncing = false;
    }
  }

  function formatAmount(minor: string, currency: string): string {
    const sign = minor.startsWith('-') ? '-' : '';
    const abs = minor.replace(/^-/, '').padStart(3, '0');
    const major = abs.slice(0, -2);
    const cents = abs.slice(-2);
    return `${sign}${major}.${cents} ${currency}`;
  }

  function statusLabel(tx: BankTransaction): { color: 'success' | 'warning' | 'secondary'; text: string } {
    if (tx.matchedTransferId || tx.matchedInvoiceId || tx.matchedExpenseId) {
      // auto_low matches are heuristic guesses — warning-coloured so they read
      // as "needs your eye" rather than "done".
      const color = tx.matchConfidence === 'auto_low' ? 'warning' : 'success';
      const suffix = tx.matchConfidence ? ` · ${tx.matchConfidence}` : '';
      if (tx.matchedTransferId) {
        return { color, text: `Wise${suffix}` };
      }
      if (tx.matchedInvoiceId) {
        return { color, text: `Invoice${suffix}` };
      }
      return { color, text: `Expense${suffix}` };
    }
    if (tx.category) {
      return { color: 'secondary', text: tx.category.replace('_', ' ') };
    }
    return { color: 'warning', text: 'unmatched' };
  }

  function isMatched(tx: BankTransaction): boolean {
    return tx.matchedTransferId !== null || tx.matchedInvoiceId !== null || tx.matchedExpenseId !== null;
  }

  /** Map raw Wise state names to the friendly labels used in /wise/transfers. */
  function wiseStateLabel(state: string): string {
    const labels: Record<string, string> = {
      incoming_payment_waiting: 'Incoming payment waiting',
      processing: 'Processing',
      funds_converted: 'Funds converted',
      outgoing_payment_sent: 'Outgoing payment sent',
      cancelled: 'Cancelled',
      failed: 'Failed',
    };
    return labels[state] ?? state;
  }

  const categoryOptions = [
    { value: '', label: 'Categorize…' },
    { value: 'tax', label: 'Tax' },
    { value: 'drawings', label: 'Drawings' },
    { value: 'self_transfer', label: 'Self-transfer' },
    { value: 'fee', label: 'Fee' },
    { value: 'ignored', label: 'Ignored' },
  ];

  async function changeCategory(tx: BankTransaction, value: string) {
    const next = (value || null) as BankTxCategory | null;
    try {
      const updated = await setBankTxCategory(tx.id, next);
      replaceTx(updated);
    } catch (error_) {
      error = (error_ as Error).message;
    }
  }

  async function openLinkModal(tx: BankTransaction) {
    linkingTx = tx;
    candidateQuery = '';
    await loadCandidates();
  }

  function closeLinkModal() {
    linkingTx = null;
    candidates = { transfers: [], invoices: [], expenses: [] };
    candidateQuery = '';
  }

  async function loadCandidates() {
    candidatesLoading = true;
    try {
      candidates = await listMatchCandidates(candidateQuery);
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      candidatesLoading = false;
    }
  }

  async function link(type: 'wise_transfer' | 'invoice' | 'expense', targetId: string) {
    if (!linkingTx) {
      return;
    }
    linking = true;
    try {
      const updated = await setBankTxMatch(linkingTx.id, { type, targetId });
      replaceTx(updated);
      closeLinkModal();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      linking = false;
    }
  }

  async function unlink(tx: BankTransaction) {
    try {
      const updated = await clearBankTxMatch(tx.id);
      replaceTx(updated);
    } catch (error_) {
      error = (error_ as Error).message;
    }
  }

  /**
   * Promote an auto_low match to manual. Re-uses the same target (whichever
   * matched* FK is set) and PUTs the existing endpoint, which writes the
   * sheet row this time (auto_low skips it; manual + auto_high don't).
   */
  async function confirmMatch(tx: BankTransaction) {
    let target: { type: 'wise_transfer' | 'invoice' | 'expense'; targetId: string } | null = null;
    if (tx.matchedTransferId) {
      target = { type: 'wise_transfer', targetId: tx.matchedTransferId };
    } else if (tx.matchedInvoiceId) {
      target = { type: 'invoice', targetId: tx.matchedInvoiceId };
    } else if (tx.matchedExpenseId) {
      target = { type: 'expense', targetId: tx.matchedExpenseId };
    }
    if (!target) {
      return;
    }
    try {
      const updated = await setBankTxMatch(tx.id, target);
      replaceTx(updated);
    } catch (error_) {
      error = (error_ as Error).message;
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

<main class="mx-auto max-w-6xl px-6 py-10">
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
          <Text color="muted">Connect a bank via Enable Banking to start ingesting transactions automatically.</Text>
          <HStack gap={3} class="items-end">
            <Field label="Bank">
              <Select
                bind:value={selectedAspspName}
                options={[
                  { value: '', label: aspsps.length === 0 ? 'Loading…' : 'Pick a bank' },
                  ...aspsps.map((a) => ({ value: a.name, label: `${a.name} (${a.country})` })),
                ]}
              />
            </Field>
            <Field label="Account type">
              <Select
                bind:value={selectedPsuType}
                options={[
                  { value: 'personal', label: 'Personal' },
                  { value: 'business', label: 'Business' },
                ]}
              />
            </Field>
            <Button color="primary" disabled={starting || !selectedAspspName} onclick={connect}>
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
              Consent expires in {remaining} day{remaining === 1 ? '' : 's'}. Reconnect to keep syncing without
              interruption.
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
                      {#if account.balance}
                        <span class="text-muted-foreground">
                          · balance {formatAmount(account.balance.amountMinor, account.balance.currency)}
                        </span>
                      {/if}
                    </Text>
                    {#if account.balanceDiscrepancyMinor && account.balanceDiscrepancyMinor !== '0'}
                      <Text size="small" color="warning">
                        Drift: bank says {formatAmount(account.balance!.amountMinor, account.balance!.currency)},
                        expected {formatAmount(account.expectedBalanceMinor!, account.currency)}
                        (diff {formatAmount(account.balanceDiscrepancyMinor, account.currency)}). A sync may catch up;
                        if persistent, an ingest is missing.
                      </Text>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </Stack>

          <HStack gap={2} class="text-sm">
            <Text size="small" color="muted">
              Connected {formatDate(new Date(session.createdAt))}
            </Text>
            {#if session.expiresAt}
              <Text size="small" color="muted">·</Text>
              <Text size="small" color="muted">
                Expires {formatDate(new Date(session.expiresAt))}
              </Text>
            {/if}
            {#if session.lastSyncedAt}
              <Text size="small" color="muted">·</Text>
              <Text size="small" color="muted">
                Last synced {formatDateTime(new Date(session.lastSyncedAt))}
              </Text>
            {/if}
          </HStack>

          <HStack gap={3}>
            {#if session.status === 'active'}
              <Button color="primary" disabled={syncing} onclick={syncNow}>
                {syncing ? 'Queuing…' : 'Sync now'}
              </Button>
            {/if}
            <Button variant="ghost" disabled={starting} onclick={reconnect}>
              {starting ? 'Starting…' : `Reconnect to ${session.aspspName}`}
            </Button>
          </HStack>

          {#if needsReconnect || reconnectSoon}
            <div class="rounded-md border border-dashed p-4">
              <Stack gap={2}>
                <Text size="small" color="muted">…or connect a different bank:</Text>
                <HStack gap={3} class="items-end">
                  <Field label="Bank">
                    <Select
                      bind:value={selectedAspspName}
                      options={[
                        { value: '', label: aspsps.length === 0 ? 'Loading…' : 'Pick a bank' },
                        ...aspsps.map((a) => ({ value: a.name, label: `${a.name} (${a.country})` })),
                      ]}
                    />
                  </Field>
                  <Field label="Account type">
                    <Select
                      bind:value={selectedPsuType}
                      options={[
                        { value: 'personal', label: 'Personal' },
                        { value: 'business', label: 'Business' },
                      ]}
                    />
                  </Field>
                  <Button disabled={starting || !selectedAspspName} onclick={connect}>
                    {starting ? 'Starting…' : 'Connect'}
                  </Button>
                </HStack>
              </Stack>
            </div>
          {/if}
        </Stack>
      </div>
    {/if}

    <Stack gap={3}>
      <HStack class="justify-between">
        <Heading size="medium" tag="h2">Recent transactions</Heading>
        <Text size="small" color="muted">{txData ? `${txData.total} total` : ''}</Text>
      </HStack>

      <HStack gap={3} class="items-end">
        <Field label="From">
          <Input type="date" bind:value={dateFrom} />
        </Field>
        <Field label="To">
          <Input type="date" bind:value={dateTo} />
        </Field>
        <Field label="Status">
          <Select bind:value={status} options={statusOptions} />
        </Field>
        <Button size="small" onclick={applyTxFilters}>Apply</Button>
        <Button size="small" variant="ghost" onclick={clearTxFilters}>Clear</Button>
      </HStack>

      {#if transactions.length === 0}
        <Text color="muted">
          {txData && (dateFrom || dateTo || status)
            ? 'No transactions match these filters.'
            : "No bank transactions yet. They'll appear here after the next sync."}
        </Text>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeading>Date</TableHeading>
              <TableHeading>Amount</TableHeading>
              <TableHeading>Counterparty</TableHeading>
              <TableHeading>Description</TableHeading>
              <TableHeading>Status</TableHeading>
              <TableHeading></TableHeading>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each transactions as tx (tx.id)}
              {@const label = statusLabel(tx)}
              {@const matched = isMatched(tx)}
              <TableRow>
                <TableCell>{tx.txDate}</TableCell>
                <TableCell>
                  <span class={tx.amountMinor.startsWith('-') ? 'text-red-600' : 'text-green-700'}>
                    {formatAmount(tx.amountMinor, tx.currency)}
                  </span>
                </TableCell>
                <TableCell>
                  {tx.counterpartyName ?? '—'}
                  {#if tx.counterpartyIban}
                    <div class="text-xs text-muted-foreground"><code>{tx.counterpartyIban}</code></div>
                  {/if}
                </TableCell>
                <TableCell class="whitespace-normal break-words">{tx.description || '—'}</TableCell>
                <TableCell><Badge color={label.color}>{label.text}</Badge></TableCell>
                <TableCell>
                  {#if matched && tx.matchConfidence === 'auto_low'}
                    <div class="flex flex-wrap items-center gap-2">
                      <Button size="small" color="primary" onclick={() => confirmMatch(tx)}>Confirm</Button>
                      <Button size="small" variant="ghost" onclick={() => unlink(tx)}>Unlink</Button>
                    </div>
                  {:else if matched}
                    <Button size="small" variant="ghost" onclick={() => unlink(tx)}>Unlink</Button>
                  {:else if tx.category}
                    <div class="flex flex-wrap items-center gap-2">
                      <Select
                        size="small"
                        class="min-w-28"
                        value={tx.category}
                        options={categoryOptions}
                        onChange={(value) => changeCategory(tx, value)}
                      />
                      <Button size="small" variant="ghost" onclick={() => changeCategory(tx, '')}>Clear</Button>
                    </div>
                  {:else}
                    <div class="flex flex-wrap items-center gap-2">
                      <Button size="small" onclick={() => openLinkModal(tx)}>Link</Button>
                      <Select
                        size="small"
                        class="min-w-28"
                        value=""
                        options={categoryOptions}
                        onChange={(value) => changeCategory(tx, value)}
                      />
                    </div>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>

        <HStack class="justify-between">
          <Text size="small" color="muted">
            Page {txPage} of {totalPages}
          </Text>
          <HStack gap={2}>
            <Button
              size="small"
              variant="ghost"
              disabled={txPage <= 1 || loading}
              onclick={() => {
                txPage -= 1;
                void loadTx();
              }}
            >
              ← Prev
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={txPage >= totalPages || loading}
              onclick={() => {
                txPage += 1;
                void loadTx();
              }}
            >
              Next →
            </Button>
          </HStack>
        </HStack>
      {/if}
    </Stack>
  </Stack>

  {#if linkingTx}
    <Modal title="Link bank transaction" onClose={closeLinkModal} size="medium" closeOnBackdropClick>
      <ModalBody>
        <Stack gap={4}>
          <div class="rounded border p-3 text-sm">
            <div><strong>{linkingTx.txDate}</strong> · {formatAmount(linkingTx.amountMinor, linkingTx.currency)}</div>
            <div class="text-muted-foreground">{linkingTx.description || '—'}</div>
            {#if linkingTx.counterpartyName}<div class="text-muted-foreground">{linkingTx.counterpartyName}</div>{/if}
          </div>

          <Field label="Search">
            <Input
              bind:value={candidateQuery}
              placeholder="TXN ref / invoice number / vendor"
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  void loadCandidates();
                }
              }}
            />
          </Field>
          <HStack>
            <Button size="small" variant="ghost" disabled={candidatesLoading} onclick={loadCandidates}>
              {candidatesLoading ? 'Searching…' : 'Search'}
            </Button>
          </HStack>

          {#if candidates.transfers.length > 0}
            <Stack gap={2}>
              <Text size="small" color="muted">Wise transfers</Text>
              {#each candidates.transfers as t (t.id)}
                <HStack class="justify-between rounded border px-3 py-2">
                  <div class="text-sm">
                    <div>
                      <strong>{t.ourReference ?? t.wiseTransferId}</strong>
                      <span class="text-muted-foreground">· {wiseStateLabel(t.state)}</span>
                    </div>
                    <div class="text-muted-foreground">
                      {formatAmount(t.sourceAmountMinor, t.sourceCurrency)} → {formatAmount(
                        t.targetAmountMinor,
                        t.targetCurrency,
                      )}
                    </div>
                  </div>
                  <Button size="small" disabled={linking} onclick={() => link('wise_transfer', t.id)}>Link</Button>
                </HStack>
              {/each}
            </Stack>
          {/if}

          {#if candidates.invoices.length > 0}
            <Stack gap={2}>
              <Text size="small" color="muted">Invoices</Text>
              {#each candidates.invoices as i (i.id)}
                <HStack class="justify-between rounded border px-3 py-2">
                  <div class="text-sm">
                    <div>
                      <strong>{i.number}</strong>
                      {#if i.clientName}<span class="text-muted-foreground">· {i.clientName}</span>{/if}
                    </div>
                    <div class="text-muted-foreground">
                      {i.issuedAt} · {formatAmount(i.totalMinor, i.currency)}
                    </div>
                  </div>
                  <Button size="small" disabled={linking} onclick={() => link('invoice', i.id)}>Link</Button>
                </HStack>
              {/each}
            </Stack>
          {/if}

          {#if candidates.expenses.length > 0}
            <Stack gap={2}>
              <Text size="small" color="muted">Expenses</Text>
              {#each candidates.expenses as e (e.id)}
                <HStack class="justify-between rounded border px-3 py-2">
                  <div class="text-sm">
                    <div><strong>{e.vendor}</strong> <span class="text-muted-foreground">· {e.status}</span></div>
                    <div class="text-muted-foreground">
                      {e.expenseDate} · {formatAmount(e.amountMinor, e.currency)}
                    </div>
                  </div>
                  <Button size="small" disabled={linking} onclick={() => link('expense', e.id)}>Link</Button>
                </HStack>
              {/each}
            </Stack>
          {/if}

          {#if !candidatesLoading && candidates.transfers.length === 0 && candidates.invoices.length === 0 && candidates.expenses.length === 0}
            <Text color="muted">No candidates. Try a different search.</Text>
          {/if}
        </Stack>
      </ModalBody>
    </Modal>
  {/if}
</main>
