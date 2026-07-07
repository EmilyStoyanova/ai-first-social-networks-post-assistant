import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/client";
import { credentialsSchema } from "@/lib/validators/auth.schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },

  pages: {
    signIn: "/login",
  },

  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },

      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        try {
          const user = await prisma.user.findUnique({
            where: { email },
            select: {
              id: true,
              email: true,
              name: true,
              passwordHash: true,
              isGlobalAdmin: true,
              preferredLang: true,
              emailVerified: true,
            },
          });

          if (!user) return null;

          const isValid = await bcrypt.compare(password, user.passwordHash);
          if (!isValid) return null;

          if (!user.emailVerified) return null;

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            isGlobalAdmin: user.isGlobalAdmin,
            preferredLanguage: user.preferredLang as "en" | "bg",
          };
        } catch (err) {
          console.error("[auth] authorize() error:", err);
          return null;
        }
      },
    }),
  ],

  callbacks: {
    jwt({ token, user }) {
      // `user` is only present on the initial sign-in
      if (user) {
        if (user.id) token.id = user.id;
        token.isGlobalAdmin = user.isGlobalAdmin;
        token.preferredLanguage = user.preferredLanguage;
      }
      return token;
    },

    session({ session, token }) {
      session.user.id = token.id;
      session.user.isGlobalAdmin = token.isGlobalAdmin;
      session.user.preferredLanguage = token.preferredLanguage;
      return session;
    },
  },
});
