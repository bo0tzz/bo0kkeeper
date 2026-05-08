<script lang="ts">
  import { formatIssuePath, type ApiFieldIssue } from '$lib/services/api';
  import { Alert, Stack, Text } from '@immich/ui';

  type Props = {
    /** Top-level message ("Validation failed", "Internal server error", etc). */
    message: string;
    /** Field-level issues from the backend's Zod validation, when present. */
    issues?: ApiFieldIssue[];
  };

  let { message, issues = [] }: Props = $props();
</script>

<Alert color="danger">
  <Stack gap={1}>
    <Text>{message}</Text>
    {#if issues.length > 0}
      <ul class="list-disc pl-6 text-sm">
        {#each issues as issue, i (i)}
          {@const path = formatIssuePath(issue.path)}
          <li>
            {#if path}<code class="font-medium">{path}</code>:
            {/if}
            {issue.message}
          </li>
        {/each}
      </ul>
    {/if}
  </Stack>
</Alert>
