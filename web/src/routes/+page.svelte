<script lang="ts">
  import { Button, Heading, Stack, Text } from '@immich/ui';
</script>

<main class="mx-auto max-w-2xl px-6 py-16">
  <Stack gap={4}>
    <Heading size="large" tag="h1">bo0kkeeper</Heading>
    <Text>Bookkeeping automation.</Text>
    <Stack gap={2}>
      <Button href="/events">Events</Button>
      <Button href="/expenses">Expenses</Button>
    </Stack>
  </Stack>
</main>
