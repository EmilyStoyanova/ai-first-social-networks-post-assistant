import { randomUUID } from "crypto";
import type { IImageProvider, ImageGenerationOptions, GeneratedImage } from "./image-provider";
import { ImageProviderError } from "./image-provider-errors";

const DEFAULT_BASE_URL = "https://api.ideogram.ai";
const DEFAULT_MODEL = "V_2";

type IdeogramAspectRatio =
  "ASPECT_1_1" | "ASPECT_16_9" | "ASPECT_9_16" | "ASPECT_4_3" | "ASPECT_3_4";

const ASPECT_DIMENSIONS: Record<IdeogramAspectRatio, { width: number; height: number }> = {
  ASPECT_1_1: { width: 1024, height: 1024 },
  ASPECT_16_9: { width: 1344, height: 768 },
  ASPECT_9_16: { width: 768, height: 1344 },
  ASPECT_4_3: { width: 1365, height: 1024 },
  ASPECT_3_4: { width: 1024, height: 1365 },
};

/**
 * Ideogram accepts `negative_prompt` on /generate only for the V_1 and V_2
 * model families; newer models dropped the field. Sending it elsewhere would be
 * inventing an API, so those models simply go without.
 */
const MODELS_SUPPORTING_NEGATIVE_PROMPT = new Set(["V_1", "V_1_TURBO", "V_2", "V_2_TURBO"]);

interface IdeogramImageData {
  url: string;
  resolution?: string;
}

interface IdeogramResponse {
  data: IdeogramImageData[];
}

interface IdeogramErrorResponse {
  message?: string;
  detail?: string;
}

export class IdeogramProvider implements IImageProvider {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    baseUrl?: string
  ) {
    this.base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage> {
    const w = options?.width ?? 1024;
    const h = options?.height ?? 1024;
    const aspectRatio = this.resolveAspectRatio(w, h);
    const dims = ASPECT_DIMENSIONS[aspectRatio];

    const imageRequest: Record<string, unknown> = {
      prompt,
      model: this.model,
      aspect_ratio: aspectRatio,
      num_images: 1,
      magic_prompt_option: "AUTO",
    };
    if (options?.negativePrompt && MODELS_SUPPORTING_NEGATIVE_PROMPT.has(this.model)) {
      imageRequest.negative_prompt = options.negativePrompt;
    }

    const res = await fetch(`${this.base}/generate`, {
      method: "POST",
      headers: {
        "Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_request: imageRequest }),
    });

    if (!res.ok) {
      if (res.status === 402) {
        throw new ImageProviderError(
          "Ideogram API error 402: insufficient credits. Add credits at ideogram.ai/manage-api."
        );
      }
      const text = await res.text().catch(() => res.statusText);
      let message = `Ideogram API error ${res.status}`;
      try {
        const err = JSON.parse(text) as IdeogramErrorResponse;
        if (err.detail) message = err.detail;
        else if (err.message) message = err.message;
      } catch {
        // use default message
      }
      throw new ImageProviderError(message);
    }

    const data = (await res.json()) as IdeogramResponse;
    const image = data.data?.[0];

    if (!image?.url) {
      throw new ImageProviderError("Ideogram returned no image data");
    }

    // Resolution comes back as "WxH" string; fall back to aspect ratio dims.
    let outW = dims.width;
    let outH = dims.height;
    if (image.resolution) {
      const parts = image.resolution.split("x").map(Number);
      if (parts.length === 2 && parts[0] && parts[1]) {
        outW = parts[0];
        outH = parts[1];
      }
    }

    return {
      url: image.url,
      width: outW,
      height: outH,
      providerAssetId: randomUUID(),
    };
  }

  private resolveAspectRatio(width: number, height: number): IdeogramAspectRatio {
    if (width === height) return "ASPECT_1_1";
    const ratio = width / height;
    if (width > height) {
      return ratio >= 1.6 ? "ASPECT_16_9" : "ASPECT_4_3";
    }
    const invRatio = height / width;
    return invRatio >= 1.6 ? "ASPECT_9_16" : "ASPECT_3_4";
  }
}
