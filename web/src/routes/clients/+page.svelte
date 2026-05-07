<script lang="ts">
  import {
    createClient,
    listClients,
    updateClient,
    type ClientClass,
    type ClientPatch,
    type ClientResponse,
    type TradeName,
  } from '$lib/services/clients.service';
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

  let clients = $state<ClientResponse[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  type Draft = {
    id: string | null;
    name: string;
    class: ClientClass;
    tradeName: TradeName;
    addressLine1: string;
    city: string;
    postalCode: string;
    countryCode: string;
    vatId: string;
    wiseSenderPattern: string;
    defaultDescription: string;
  };

  function emptyDraft(): Draft {
    return {
      id: null,
      name: '',
      class: 'domestic',
      tradeName: 'it_services',
      addressLine1: '',
      city: '',
      postalCode: '',
      countryCode: 'NL',
      vatId: '',
      wiseSenderPattern: '',
      defaultDescription: '',
    };
  }

  let draft = $state<Draft | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      clients = await listClients();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function startCreate() {
    draft = emptyDraft();
  }

  function startEdit(client: ClientResponse) {
    const address = (client.address ?? {}) as Record<string, string>;
    draft = {
      id: client.id,
      name: client.name,
      class: client.class,
      tradeName: client.tradeName,
      addressLine1: address['line1'] ?? '',
      city: address['city'] ?? '',
      postalCode: address['postalCode'] ?? '',
      countryCode: address['countryCode'] ?? '',
      vatId: client.vatId ?? '',
      wiseSenderPattern: client.wiseSenderPattern ?? '',
      defaultDescription: client.defaultDescription,
    };
  }

  function cancel() {
    draft = null;
  }

  function buildPatch(d: Draft): ClientPatch {
    return {
      name: d.name,
      class: d.class,
      tradeName: d.tradeName,
      address: {
        line1: d.addressLine1,
        city: d.city,
        postalCode: d.postalCode,
        countryCode: d.countryCode,
      },
      vatId: d.vatId || undefined,
      wiseSenderPattern: d.wiseSenderPattern || undefined,
      defaultDescription: d.defaultDescription,
    };
  }

  async function save() {
    if (!draft) {
      return;
    }
    error = null;
    try {
      const patch = buildPatch(draft);
      await (draft.id
        ? updateClient(draft.id, patch)
        : createClient({ ...patch, name: draft.name, class: draft.class, tradeName: draft.tradeName }));
      draft = null;
      await load();
    } catch (error_) {
      error = (error_ as Error).message;
    }
  }

  function classColor(c: ClientClass) {
    switch (c) {
      case 'domestic': {
        return 'primary';
      }
      case 'eu_reverse_charge': {
        return 'success';
      }
      case 'non_eu': {
        return 'warning';
      }
      default: {
        return 'secondary';
      }
    }
  }

  const classOptions = [
    { value: 'domestic', label: 'Domestic' },
    { value: 'eu', label: 'EU (BTW charged)' },
    { value: 'eu_reverse_charge', label: 'EU reverse-charge' },
    { value: 'non_eu', label: 'Non-EU' },
  ];

  const tradeOptions = [
    { value: 'it_services', label: 'IT Services' },
    { value: '3d', label: '3D' },
  ];
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <div class="flex items-center justify-between">
      <Heading size="large" tag="h1">Clients</Heading>
      <Button color="primary" onclick={startCreate}>New client</Button>
    </div>

    {#if error}
      <Alert color="danger">{error}</Alert>
    {/if}

    {#if loading && clients.length === 0}
      <Text>Loading…</Text>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeading>Name</TableHeading>
            <TableHeading>Class</TableHeading>
            <TableHeading>Trade name</TableHeading>
            <TableHeading>VAT</TableHeading>
            <TableHeading>City</TableHeading>
            <TableHeading></TableHeading>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each clients as client (client.id)}
            <TableRow>
              <TableCell>{client.name}</TableCell>
              <TableCell><Badge color={classColor(client.class)}>{client.class}</Badge></TableCell>
              <TableCell>{client.tradeName}</TableCell>
              <TableCell>{client.vatId ?? '—'}</TableCell>
              <TableCell>{(client.address as Record<string, string>)?.['city'] ?? ''}</TableCell>
              <TableCell>
                <Button variant="ghost" onclick={() => startEdit(client)}>Edit</Button>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>

      {#if clients.length === 0}
        <Text color="muted">No clients yet — create one to get started.</Text>
      {/if}
    {/if}

    {#if draft}
      <div class="rounded border bg-subtle p-4">
        <Stack gap={4}>
          <Heading size="small" tag="h2">{draft.id ? 'Edit client' : 'New client'}</Heading>
          <HStack gap={3}>
            <Field label="Name">
              <Input bind:value={draft.name} />
            </Field>
            <Field label="Class">
              <Select bind:value={draft.class} options={classOptions} />
            </Field>
            <Field label="Trade name">
              <Select bind:value={draft.tradeName} options={tradeOptions} />
            </Field>
          </HStack>
          <HStack gap={3}>
            <Field label="VAT id">
              <Input bind:value={draft.vatId} />
            </Field>
            <Field label="Wise sender pattern">
              <Input bind:value={draft.wiseSenderPattern} />
            </Field>
          </HStack>
          <HStack gap={3}>
            <Field label="Address line 1">
              <Input bind:value={draft.addressLine1} />
            </Field>
            <Field label="City">
              <Input bind:value={draft.city} />
            </Field>
            <Field label="Postal code">
              <Input bind:value={draft.postalCode} />
            </Field>
            <Field label="Country">
              <Input bind:value={draft.countryCode} placeholder="NL" />
            </Field>
          </HStack>
          <Field label="Default description">
            <Input bind:value={draft.defaultDescription} />
          </Field>
          <HStack gap={3}>
            <Button variant="ghost" onclick={cancel}>Cancel</Button>
            <Button color="primary" onclick={save}>{draft.id ? 'Save changes' : 'Create client'}</Button>
          </HStack>
        </Stack>
      </div>
    {/if}
  </Stack>
</main>
