import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ slug: string; channel: string }>;
}

/** A channel with no view named lands on its calendar — the area's default. */
export default async function ChannelIndexPage({ params }: Props) {
  const { slug, channel } = await params;
  redirect(`/companies/${slug}/channels/${encodeURIComponent(channel)}/calendar`);
}
