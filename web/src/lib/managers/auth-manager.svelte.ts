import { getMe, loginUrl, logout, type AuthMe } from '$lib/services/auth.service';

class AuthManager {
  user = $state<AuthMe | null>(null);
  loaded = $state(false);

  async load(fetchFn: typeof fetch = fetch): Promise<void> {
    this.user = await getMe(fetchFn);
    this.loaded = true;
  }

  get authenticated(): boolean {
    return this.user !== null;
  }

  loginUrl(returnTo: string): string {
    return loginUrl(returnTo);
  }

  async logout(): Promise<void> {
    await logout();
    this.user = null;
  }
}

export const authManager = new AuthManager();
