import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * The Channels area has no page of its own — it is always a channel and a view
 * (§ the same shape as Settings). "All Channels, Calendar" is the landing:
 * planning is what the area is for, and All Channels is the only scope that is
 * correct for every company, however many networks it has connected.
 */
export default async function ChannelsIndexPage({ params }: Props) {
  const { slug } = await params;
  redirect(`/companies/${slug}/channels/all/calendar`);
}
