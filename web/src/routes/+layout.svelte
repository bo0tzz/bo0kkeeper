<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { TooltipProvider } from '@immich/ui';
  import type { Snippet } from 'svelte';
  import '../app.css';

  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();

  // Nav grouped by workflow role; items within each group ordered by observed
  // visit frequency so the most-used surfaces are leftmost. Group separators
  // between work (daily), reference (occasional lookups), and config
  // (set-and-forget).
  const navGroups = [
    [
      { href: resolve('/banking'), label: 'Banking' },
      { href: resolve('/expenses'), label: 'Expenses' },
      { href: resolve('/wise'), label: 'Wise drafts' },
      { href: resolve('/aggregator'), label: 'BTW rollup' },
    ],
    [
      { href: resolve('/invoices'), label: 'Invoices' },
      { href: resolve('/clients'), label: 'Clients' },
      { href: resolve('/events'), label: 'Events' },
    ],
    [
      { href: resolve('/settings'), label: 'Settings' },
      { href: resolve('/system'), label: 'System' },
    ],
  ];
</script>

<svelte:head>
  <title>{page.data.meta?.title || 'bo0kkeeper'}</title>
</svelte:head>

<TooltipProvider>
  <nav class="border-b bg-white/80 backdrop-blur dark:bg-black/40">
    <div class="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
      <a href={resolve('/')} class="font-semibold">bo0kkeeper</a>
      <div class="flex flex-1 items-center gap-3 text-sm">
        {#each navGroups as group, groupIndex (groupIndex)}
          {#if groupIndex > 0}
            <span class="mx-1 h-5 w-px bg-subtle" aria-hidden="true"></span>
          {/if}
          {#each group as item (item.href)}
            {@const active = page.url.pathname.startsWith(item.href)}
            <a
              href={item.href}
              class="rounded px-2 py-1 transition {active ? 'bg-subtle font-medium' : 'hover:bg-subtle/50'}"
            >
              {item.label}
            </a>
          {/each}
        {/each}
      </div>
    </div>
  </nav>
  {@render children?.()}
</TooltipProvider>
