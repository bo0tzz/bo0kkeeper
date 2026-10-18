/**
 * Thin SDK wiring layer. The generated `@bo0kkeeper/sdk` bakes the OpenAPI
 * `server` as `defaults.baseUrl = "/api"` and its path strings also start
 * with `/api/...` (controllers declare @Controller('/api/foo')). Prepending
 * the baseUrl would double it to `/api/api/foo` — set it to empty so the
 * paths resolve as-is until a server-side @Controller cleanup moves to
 * app.setGlobalPrefix('api').
 *
 * No fetch override here: SDK calls go through the browser's native fetch,
 * which still sends same-origin cookies, so auth works. The silent-refresh
 * on 401 lives in `services/api.ts` and only applies to calls that go
 * through that wrapper — SDK calls fall through to the full
 * login-redirect flow on expiry. Acceptable trade for the POC migration;
 * we can set `defaults.fetch` to a wrapped fetch here if that ever bites.
 */
import { defaults } from '@bo0kkeeper/sdk';

defaults.baseUrl = '';
