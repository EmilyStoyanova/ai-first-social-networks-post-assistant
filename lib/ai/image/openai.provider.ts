import { randomUUID } from "crypto";
import type { IImageProvider, ImageGenerationOptions, GeneratedImage } from "./image-provider";
import { ImageProviderError } from "./image-provider-errors";

const DEFAULT_BASE_URL = "https://api.openai.com";

interface OpenAIImageItem {
  url?: string;
  b64_json?: string;
}

interface OpenAIImageResponse {
  data: OpenAIImageItem[];
}

interface OpenAIErrorResponse {
  error?: { message?: string };
}

export class OpenAIImageProvider implements IImageProvider {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = "gpt-image-1",
    baseUrl?: string
  ) {
    this.base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage> {
    const w = options?.width ?? 1024;
    const h = options?.height ?? 1024;
    const size = this.resolveSize(w, h);

    // `options.negativePrompt` is deliberately dropped: the OpenAI Images API
    // has no negative-prompt parameter on any model, and appending exclusions to
    // the positive prompt is worse than omitting them.
    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      n: 1,
      size,
    };

    // gpt-image-1 always returns b64_json; dall-e-3 and dall-e-2 support url
    if (!this.model.startsWith("gpt-image")) {
      body.response_format = "url";
    }

    const res = await fetch(`${this.base}/v1/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let message = `OpenAI Images API error ${res.status}`;
      try {
        const parsed = JSON.parse(text) as OpenAIErrorResponse;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // use default message
      }
      throw new ImageProviderError(message);
    }

    const data = (await res.json()) as OpenAIImageResponse;
    const item = data.data?.[0];

    if (!item) {
      throw new ImageProviderError("OpenAI returned no image data");
    }

    let url: string;
    if (item.url) {
      url = item.url;
    } else if (item.b64_json) {
      url = `data:image/png;base64,${item.b64_json}`;
    } else {
      throw new ImageProviderError("OpenAI returned neither a URL nor base64 image data");
    }

    // OpenAI does not return output dimensions — infer from resolved size
    const [outW, outH] = size.split("x").map(Number);

    return {
      url,
      width: outW ?? w,
      height: outH ?? h,
      providerAssetId: randomUUID(),
    };
  }

  private resolveSize(width: number, height: number): string {
    if (this.model.startsWith("dall-e-2")) {
      return "1024x1024";
    }

    if (this.model === "dall-e-3") {
      if (width > height) return "1792x1024";
      if (height > width) return "1024x1792";
      return "1024x1024";
    }

    // gpt-image-1
    if (width > height) return "1536x1024";
    if (height > width) return "1024x1536";
    return "1024x1024";
  }
}
