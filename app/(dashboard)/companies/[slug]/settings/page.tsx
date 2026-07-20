import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * Settings has no page of its own — it is a group of sub-pages (§2.4), so this
 * sends the visitor to the first one.
 *
 * The exception is a Buffer OAuth result. `?buffer=` is only meaningful to the
 * Integrations page, and legacy links still carry it here by way of
 * `?tab=settings&buffer=connected`; landing that on Brand would drop the
 * outcome of a connection the user just authorized.
 *
 * A temporary redirect, not permanent: Settings gains a General sub-page when
 * there is a backend for one, and that will become the landing section.
 */
export default async function SettingsIndexPage({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const buffer = Array.isArray(sp.buffer) ? sp.buffer[0] : sp.buffer;
  if (typeof buffer === "string" && buffer.length > 0) {
    redirect(`/companies/${slug}/settings/buffer?buffer=${encodeURIComponent(buffer)}`);
  }

  redirect(`/companies/${slug}/settings/brand`);
}
