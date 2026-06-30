import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      isGlobalAdmin: boolean;
      preferredLanguage: "en" | "bg";
    };
  }

  /**
   * Extends the built-in User returned from `authorize` so the
   * jwt/session callbacks receive our custom fields without casting.
   */
  interface User {
    isGlobalAdmin: boolean;
    preferredLanguage: "en" | "bg";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    isGlobalAdmin: boolean;
    preferredLanguage: "en" | "bg";
  }
}
