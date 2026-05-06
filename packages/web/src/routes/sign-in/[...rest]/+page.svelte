<script lang="ts">
  import { SignIn } from 'svelte-clerk';
</script>

<div class="auth-page">
  <SignIn />
</div>

<style>
  .auth-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    padding: 2rem;
  }
</style>
