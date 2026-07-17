import {
  BufferApiError,
  BufferTokenExpiredError,
  BufferInvalidProfileError,
} from "./buffer-errors";

// Buffer's current GraphQL API (the legacy api.bufferapp.com/1 REST API does not
// accept tokens issued by auth.buffer.com).
const API_URL = "https://api.buffer.com";

const LOG_LIMIT = 500;

export interface BufferProfile {
  id: string;
  name: string;
  service: string;
  formattedUsername: string;
}

export interface BufferPublishResult {
  updateId: string;
  status: string;
  publishedUrl: string | null;
}

interface RawChannel {
  id: string;
  name: string;
  service: string;
  displayName?: string | null;
}

interface RawCreatePostPayload {
  createPost?: {
    __typename?: string;
    post?: { id: string; status?: string | null; externalLink?: string | null } | null;
    message?: string;
  } | null;
}

interface RawGetPostPayload {
  post?: { externalLink?: string | null } | null;
}

/**
 * Buffer rejects posts without a channel-specific type in `metadata`
 * (verified via live API: "Facebook posts require a type (post, story, or reel)").
 * Services not listed here are sent without metadata.
 */
function buildMetadataArg(service: string): string {
  const s = service.toLowerCase().replace(/\s+/g, "-");
  if (s === "facebook" || s === "facebook-group") {
    return ", metadata: { facebook: { type: post } }";
  }
  if (
    s === "instagram" ||
    s === "instagram-business" ||
    s === "instagrambusiness" ||
    s === "instagram-creator" ||
    s === "instagramcreator"
  ) {
    return ", metadata: { instagram: { type: post, shouldShareToFeed: true } }";
  }
  return "";
}

export class BufferClient {
  constructor(private readonly accessToken: string) {}

  private async query<T>(query: string): Promise<T> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ query }),
    });

    if (res.status === 401 || res.status === 403) throw new BufferTokenExpiredError();
    if (res.status === 429) {
      throw new BufferApiError("Buffer rate limit reached. Please try again later.", 429);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      // Response bodies never contain tokens — safe to log truncated.
      console.error(`[buffer] API HTTP ${res.status}: ${body.slice(0, LOG_LIMIT)}`);
      throw new BufferApiError(`Buffer API error ${res.status}: ${body.slice(0, 200)}`, res.status);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      const message = json.errors.map((e) => e.message).join("; ");
      console.error(`[buffer] GraphQL errors: ${message.slice(0, LOG_LIMIT)}`);
      throw new BufferApiError(message);
    }
    if (!json.data) throw new BufferApiError("Buffer returned an empty response.");
    return json.data;
  }

  async getProfiles(): Promise<BufferProfile[]> {
    const account = await this.query<{
      account: { organizations: Array<{ id: string }> } | null;
    }>("query GetOrganizations { account { organizations { id } } }");

    const orgIds = account.account?.organizations?.map((o) => o.id) ?? [];
    const profiles: BufferProfile[] = [];

    for (const orgId of orgIds) {
      const data = await this.query<{ channels: RawChannel[] | null }>(
        `query GetChannels { channels(input: { organizationId: ${JSON.stringify(orgId)} }) { id name service displayName } }`
      );
      for (const c of data.channels ?? []) {
        profiles.push({
          id: c.id,
          name: c.displayName ?? c.name,
          service: c.service,
          formattedUsername: c.name,
        });
      }
    }

    return profiles;
  }

  async publishUpdate(
    profileIds: string[],
    text: string,
    options?: { mediaUrl?: string }
  ): Promise<BufferPublishResult> {
    // The createPost metadata is service-specific, so resolve each channel's service first.
    const profiles = await this.getProfiles();
    let first: BufferPublishResult | null = null;

    for (const channelId of profileIds) {
      const profile = profiles.find((p) => p.id === channelId);
      if (!profile) throw new BufferInvalidProfileError();
      const service = profile.service.toLowerCase();

      // Deliberately kept after v2-3 moved policy into lib/ai/channel-policy.ts,
      // which is the source of truth for OUR channels. This guard is not a
      // duplicate of it: it keys off the service Buffer reports for the target
      // profile, so it still fires when Post.channel disagrees with the profile
      // actually being published to — a real, observed data condition that a
      // Post.channel-based check cannot see. Last line of defence at the API
      // boundary; the policy layer rejects long before this.
      if (service === "instagram" && !options?.mediaUrl) {
        throw new BufferApiError(
          "Instagram posts require at least one image or video. Attach an image to the post before publishing."
        );
      }

      // Arguments are inlined as JSON-escaped literals (valid GraphQL string syntax)
      // to avoid depending on unpublished input type names for variables.
      const assets = options?.mediaUrl
        ? `, assets: [{ image: { url: ${JSON.stringify(options.mediaUrl)} } }]`
        : "";
      const mutation = `mutation CreatePost {
        createPost(input: {
          text: ${JSON.stringify(text)},
          channelId: ${JSON.stringify(channelId)},
          schedulingType: automatic,
          mode: shareNow${buildMetadataArg(service)}${assets}
        }) {
          __typename
          ... on PostActionSuccess { post { id status externalLink } }
          ... on MutationError { message }
        }
      }`;

      const data = await this.query<RawCreatePostPayload>(mutation);
      const payload = data.createPost;

      if (!payload?.post?.id) {
        const typename = payload?.__typename ?? "UnknownError";
        const message = payload?.message ?? "Buffer did not return a post ID.";
        console.error(`[buffer] createPost ${typename} for channel ${channelId}: ${message}`);
        if (typename === "UnauthorizedError") throw new BufferTokenExpiredError();
        if (typename === "NotFoundError") throw new BufferInvalidProfileError();
        throw new BufferApiError(message);
      }

      first ??= {
        updateId: payload.post.id,
        status: payload.post.status ?? "sent",
        publishedUrl: payload.post.externalLink ?? null,
      };
    }

    if (!first) throw new BufferApiError("No Buffer channel was selected.");
    return first;
  }

  async getPostLink(bufferPostId: string): Promise<string | null> {
    const data = await this.query<RawGetPostPayload>(
      `query GetPostLink { post(input: { id: ${JSON.stringify(bufferPostId)} }) { externalLink } }`
    );
    return data.post?.externalLink ?? null;
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.query<{ account: { id: string } | null }>(
        "query ValidateConnection { account { id } }"
      );
      return true;
    } catch {
      return false;
    }
  }
}
