import { randomUUID } from "crypto";
import type { IImageProvider, ImageGenerationOptions, GeneratedImage } from "./image-provider";
import { ImageProviderError } from "./image-provider-errors";

const DEFAULT_BASE_URL = "https://fal.run";
const DEFAULT_MODEL = "fal-ai/flux/schnell";

interface FalImageResult {
  url: string;
  width: number;
  height: number;
  content_type: string;
}

interface FalImageResponse {
  images: FalImageResult[];
}

interface FalErrorResponse {
  message?: string;
  detail?: string | { msg: string }[];
}

export class FalProvider implements IImageProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly baseUrl?: string
  ) {}

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage> {
    const base = (this.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const w = options?.width ?? 1024;
    const h = options?.height ?? 1024;

    const res = await fetch(`${base}/${this.model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      // `options.negativePrompt` is deliberately dropped. The default model
      // (FLUX schnell) is guidance-distilled and its fal schema has no
      // `negative_prompt` field, so there is nothing to forward it to. Folding
      // it into the positive prompt would summon the defects it lists.
      body: JSON.stringify({
        prompt,
        image_size: { width: w, height: h },
        num_images: 1,
        enable_safety_checker: true,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let message = `Fal.ai API error ${res.status}`;
      try {
        const err = JSON.parse(text) as FalErrorResponse;
        const detail = err.detail;
        if (typeof detail === "string") message = detail;
        else if (Array.isArray(detail)) message = detail.map((d) => d.msg).join("; ");
        else if (err.message) message = err.message;
      } catch {
        // use default message
      }
      throw new ImageProviderError(message);
    }

    const data = (await res.json()) as FalImageResponse;
    const image = data.images?.[0];

    if (!image?.url) {
      throw new ImageProviderError("Fal.ai returned no image data");
    }

    return {
      url: image.url,
      width: image.width ?? w,
      height: image.height ?? h,
      providerAssetId: randomUUID(),
    };
  }
}
