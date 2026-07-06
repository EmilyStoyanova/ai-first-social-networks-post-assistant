import { BufferApiError, BufferTokenExpiredError } from "./buffer-errors";

// Buffer's current GraphQL API (the legacy api.bufferapp.com/1 REST API does not
// accept tokens issued by auth.buffer.com).
const API_URL = "https://api.buffer.com";

export interface BufferProfile {
  id: string;
  name: string;
  service: string;
  formattedUsername: string;
}

export interface BufferPublishResult {
  updateId: string;
  status: string;
}

interface RawChannel {
  id: string;
  name: string;
  service: string;
  displayName?: string | null;
}

interface RawCreatePostPayload {
  createPost?: {
    post?: { id: string } | null;
    message?: string;
  } | null;
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
      throw new BufferApiError(`Buffer API error ${res.status}: ${body}`, res.status);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new BufferApiError(json.errors.map((e) => e.message).join("; "));
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
    let first: BufferPublishResult | null = null;

    for (const channelId of profileIds) {
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
          mode: shareNow${assets}
        }) {
          ... on PostActionSuccess { post { id } }
          ... on MutationError { message }
        }
      }`;

      const data = await this.query<RawCreatePostPayload>(mutation);
      const payload = data.createPost;
      if (!payload?.post?.id) {
        throw new BufferApiError(payload?.message ?? "Buffer did not return a post ID.");
      }
      first ??= { updateId: payload.post.id, status: "sent" };
    }

    if (!first) throw new BufferApiError("No Buffer channel was selected.");
    return first;
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
