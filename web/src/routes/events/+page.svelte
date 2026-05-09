<script lang="ts">
  import { page } from '$app/state';
  import { formatDateTime } from '$lib/format';
  import {
    listEvents,
    type EventResponse,
    type EventSource,
    type EventStatus,
    type ListEventsResponse,
  } from '$lib/services/events.service';
  import {
    Badge,
    Button,
    Heading,
    HStack,
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

  // Initial filter values from URL query — lets the dashboard's "Failed events
  // → Investigate" link land directly on /events?status=failed instead of the
  // operator having to re-pick the filter.
  const initialSource = (page.url.searchParams.get('source') ?? '') as EventSource | '';
  const initialStatus = (page.url.searchParams.get('status') ?? '') as EventStatus | '';

  let source = $state<EventSource | ''>(initialSource);
  let status = $state<EventStatus | ''>(initialStatus);
  let offset = $state(0);
  let data = $state<ListEventsResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      data = await listEvents({
        source: source || undefined,
        status: status || undefined,
        limit: PAGE_SIZE,
        offset,
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

  function statusColor(s: EventStatus) {
    switch (s) {
      case 'processed': {
        return 'success';
      }
      case 'failed': {
        return 'danger';
      }
      case 'processing': {
        return 'warning';
      }
      case 'skipped': {
        return 'secondary';
      }
      default: {
        return 'primary';
      }
    }
  }

  const sourceOptions = [
    { value: '', label: 'All sources' },
    { value: 'wise', label: 'Wise' },
    { value: 'paperless', label: 'Paperless' },
    { value: 'bank', label: 'Bank' },
    { value: 'manual', label: 'Manual' },
    { value: 'system', label: 'System' },
  ];

  const statusOptions = [
    { value: '', label: 'All statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'processing', label: 'Processing' },
    { value: 'processed', label: 'Processed' },
    { value: 'failed', label: 'Failed' },
    { value: 'skipped', label: 'Skipped' },
  ];

  function shorten(id: string) {
    return id.slice(0, 8);
  }

  function sourceLabel(s: EventSource): string {
    return sourceOptions.find((o) => o.value === s)?.label ?? s;
  }

  function preview(event: EventResponse): string {
    const keys = Object.keys(event.payload).slice(0, 3);
    return keys.length > 0 ? keys.join(', ') : '—';
  }
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
  <Stack gap={6}>
    <div class="flex items-center justify-between">
      <Heading size="large" tag="h1">Events</Heading>
      <Text size="small" color="muted">
        {data ? `${data.total} total` : ''}
      </Text>
    </div>

    <HStack gap={3}>
      <Select
        bind:value={source}
        options={sourceOptions}
        onChange={() => {
          offset = 0;
        }}
      />
      <Select
        bind:value={status}
        options={statusOptions}
        onChange={() => {
          offset = 0;
        }}
      />
    </HStack>

    {#if error}
      <Text color="danger">Failed to load events: {error}</Text>
    {/if}

    {#if loading && !data}
      <Text>Loading…</Text>
    {:else if data}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeading>ID</TableHeading>
            <TableHeading>Source</TableHeading>
            <TableHeading>Event type</TableHeading>
            <TableHeading>Occurred</TableHeading>
            <TableHeading>Status</TableHeading>
            <TableHeading>Attempts</TableHeading>
            <TableHeading>Payload keys</TableHeading>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each data.items as event (event.id)}
            <TableRow>
              <TableCell>
                <code class="text-xs">{shorten(event.id)}</code>
              </TableCell>
              <TableCell>{sourceLabel(event.source)}</TableCell>
              <TableCell><code class="text-xs">{event.eventType}</code></TableCell>
              <TableCell class="whitespace-nowrap">{formatDateTime(new Date(event.occurredAt))}</TableCell>
              <TableCell>
                <Badge color={statusColor(event.status)}>{event.status}</Badge>
              </TableCell>
              <TableCell>{event.attempts}</TableCell>
              <TableCell><Text size="small" color="muted">{preview(event)}</Text></TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>

      {#if data.items.length === 0}
        <Text color="muted">No events match these filters.</Text>
      {/if}

      <div class="flex items-center justify-between">
        <Text size="small" color="muted">
          Showing {offset + 1}–{Math.min(offset + data.items.length, data.total)} of {data.total}
        </Text>
        <HStack gap={2}>
          <Button
            variant="outline"
            disabled={offset === 0}
            onclick={() => {
              offset = Math.max(0, offset - PAGE_SIZE);
            }}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={!data.hasMore}
            onclick={() => {
              offset = offset + PAGE_SIZE;
            }}
          >
            Next
          </Button>
        </HStack>
      </div>
    {/if}
  </Stack>
</main>
