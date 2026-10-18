<script lang="ts">
  import { extractApiError } from '$lib/sdk';
  import { getIntegrations, Status3 as IntegrationStatusEnum, type IntegrationsResponseDto } from '@bo0kkeeper/sdk';

  type IntegrationCheck = IntegrationsResponseDto['checks'][number];
  type IntegrationStatus = IntegrationCheck['status'];
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

  let checks = $state<IntegrationCheck[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      const response = await getIntegrations();
      checks = response.checks;
    } catch (error_) {
      error = extractApiError(error_).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function statusBadge(status: IntegrationStatus): {
    color: 'success' | 'warning' | 'danger' | 'secondary';
    label: string;
  } {
    switch (status) {
      case IntegrationStatusEnum.Healthy: {
        return { color: 'success', label: 'healthy' };
      }
      case IntegrationStatusEnum.Degraded: {
        return { color: 'warning', label: 'degraded' };
      }
      case IntegrationStatusEnum.Broken: {
        return { color: 'danger', label: 'broken' };
      }
      case IntegrationStatusEnum.NotConfigured: {
        return { color: 'secondary', label: 'not configured' };
      }
    }
  }

  function formatLastActivity(iso: string | null): string {
    if (!iso) {
      return '—';
    }
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
    if (days === 0) {
      return 'today';
    }
    if (days === 1) {
      return '1d ago';
    }
    return `${days}d ago`;
  }
</script>

<main class="mx-auto max-w-5xl px-6 py-10">
  <Stack gap={6}>
    <HStack class="justify-between">
      <Heading size="large" tag="h1">System</Heading>
      <Button size="small" variant="ghost" disabled={loading} onclick={load}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </Button>
    </HStack>

    {#if error}
      <Alert color="danger">{error}</Alert>
    {/if}

    {#if loading && checks.length === 0}
      <Text>Loading…</Text>
    {:else if checks.length > 0}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeading>Integration</TableHeading>
            <TableHeading>Status</TableHeading>
            <TableHeading>Last activity</TableHeading>
            <TableHeading>Detail</TableHeading>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each checks as check (check.id)}
            {@const badge = statusBadge(check.status)}
            <TableRow>
              <TableCell>{check.name}</TableCell>
              <TableCell><Badge color={badge.color}>{badge.label}</Badge></TableCell>
              <TableCell>{formatLastActivity(check.lastActivityAt)}</TableCell>
              <TableCell class="whitespace-normal break-anywhere">{check.message}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  </Stack>
</main>
