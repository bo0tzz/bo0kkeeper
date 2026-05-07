type AuthMe = {
  sub: string;
  email?: string;
  name?: string;
};

class AuthManager {
  user = $state<AuthMe | null>(null);
  loaded = $state(false);

  async load(fetchFn: typeof fetch = fetch): Promise<void> {
    try {
      const res = await fetchFn('/api/auth/me');
      this.user = res.ok ? ((await res.json()) as AuthMe) : null;
    } catch {
      this.user = null;
    } finally {
      this.loaded = true;
    }
  }

  get authenticated(): boolean {
    return this.user !== null;
  }

  loginUrl(returnTo: string): string {
    const params = new URLSearchParams({ return_to: returnTo });
    return `/api/auth/login?${params.toString()}`;
  }

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST' });
    this.user = null;
  }
}

export const authManager = new AuthManager();
