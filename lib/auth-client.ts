import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

// Two-factor: the sign-in form sends the person to the challenge page itself
// (it keeps the destination), so the plugin doesn't redirect.
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});
