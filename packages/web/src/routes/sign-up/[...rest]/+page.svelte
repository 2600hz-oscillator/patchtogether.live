<script lang="ts">
  import { SignUp } from 'svelte-clerk';
</script>

<div class="auth-page">
  <SignUp />
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
