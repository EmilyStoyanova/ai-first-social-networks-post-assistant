import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Compatibility redirect for the old Content Creation route.
 *
 * `/create/{slug}` used to host `GeneratePostForm`. Generation has moved back
 * to the company's own Posts tab (`/companies/{slug}/posts`), and `/create` is
 * now the Company Management shim — so this path keeps working for bookmarks,
 * the header's company switcher (which swaps the slug segment of whatever
 * `/create/{slug}` URL a user is on), and the older "Create content" links,
 * by landing on the same place `/create` does for that company.
 *
 * `/companies/{slug}` performs its own `getCompany` membership check and 404s
 * for a company the user cannot access, so no access check is duplicated here
 * — this route reveals nothing on its own.
 */
export default async function LegacyContentCreationPage({ params }: Props) {
  const { slug } = await params;
  redirect(`/companies/${slug}`);
}
