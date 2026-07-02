import {
  BufferApiError,
  BufferTokenExpiredError,
  BufferInvalidProfileError,
} from "./buffer-errors";

const API_BASE = "https://api.bufferapp.com/1";

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

interface RawProfile {
  id: string;
  formatted_username: string;
  service: string;
  service_username?: string;
}

interface RawCreateResponse {
  success?: boolean;
  updates?: Array<{ id: string; status: string }>;
  message?: string;
  error?: string;
  error_description?: string;
  code?: number;
}

export class BufferClient {
  constructor(private readonly accessToken: string) {}

  async getProfiles(): Promise<BufferProfile[]> {
    const params = new URLSearchParams({ access_token: this.accessToken });
    const res = await fetch(`${API_BASE}/profiles.json?${params.toString()}`);

    if (res.status === 401 || res.status === 403) throw new BufferTokenExpiredError();
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new BufferApiError(`Buffer profiles error ${res.status}: ${body}`, res.status);
    }

    const data = (await res.json()) as RawProfile[];
    if (!Array.isArray(data)) return [];

    return data.map((p) => ({
      id: p.id,
      name: p.formatted_username ?? p.service_username ?? p.service,
      service: p.service,
      formattedUsername: p.formatted_username,
    }));
  }

  async publishUpdate(
    profileIds: string[],
    text: string,
    options?: { mediaUrl?: string }
  ): Promise<BufferPublishResult> {
    const body = new URLSearchParams();
    body.set("access_token", this.accessToken);
    body.set("text", text);
    body.set("now", "true");
    profileIds.forEach((id) => body.append("profile_ids[]", id));
    if (options?.mediaUrl) {
      body.set("media[picture]", options.mediaUrl);
    }

    const res = await fetch(`${API_BASE}/updates/create.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (res.status === 401) throw new BufferTokenExpiredError();
    if (res.status === 403) throw new BufferInvalidProfileError();

    if (res.status === 429) {
      throw new BufferApiError("Buffer rate limit reached. Please try again later.", 429);
    }

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as RawCreateResponse | null;
      const msg =
        data?.error_description ?? data?.error ?? data?.message ?? `Buffer error ${res.status}`;
      throw new BufferApiError(msg, res.status);
    }

    const data = (await res.json()) as RawCreateResponse;
    const update = data.updates?.[0];
    if (!update?.id) {
      throw new BufferApiError("Buffer did not return a post ID.");
    }

    return { updateId: update.id, status: update.status ?? "buffer" };
  }

  async validateConnection(): Promise<boolean> {
    try {
      const params = new URLSearchParams({ access_token: this.accessToken });
      const res = await fetch(`${API_BASE}/user.json?${params.toString()}`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
