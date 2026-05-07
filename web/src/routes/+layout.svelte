<script lang="ts">
  import { page } from '$app/state';
  import { TooltipProvider } from '@immich/ui';
  import type { Snippet } from 'svelte';
  import '../app.css';

  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();
</script>

<svelte:head>
  <title>{page.data.meta?.title || 'bo0kkeeper'}</title>
</svelte:head>

<TooltipProvider>
  {@render children?.()}
</TooltipProvider>
