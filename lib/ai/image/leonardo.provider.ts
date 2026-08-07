import type { IImageProvider, ImageGenerationOptions, GeneratedImage } from "./image-provider";
import { ImageProviderError } from "./image-provider-errors";

const DEFAULT_BASE_URL = "https://cloud.leonardo.ai";
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 20; // 60 seconds max

type GenerationStatus = "PENDING" | "COMPLETE" | "FAILED";

interface StartResponse {
  sdGenerationJob: { generationId: string };
}

interface PollResponse {
  generations_by_pk: {
    status: GenerationStatus;
    generated_images: Array<{ id: string; url: string; width?: number; height?: number }>;
  };
}

export class LeonardoProvider implements IImageProvider {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string | null,
    baseUrl?: string
  ) {
    this.base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage> {
    const width = options?.width ?? 1024;
    const height = options?.height ?? 1024;

    const generationId = await this.startGeneration(prompt, width, height, options?.negativePrompt);
    return this.pollUntilComplete(generationId, width, height);
  }

  private async startGeneration(
    prompt: string,
    width: number,
    height: number,
    negativePrompt?: string
  ): Promise<string> {
    const body: Record<string, unknown> = {
      prompt,
      width,
      height,
      num_images: 1,
    };
    if (this.modelId) body.modelId = this.modelId;
    // Documented top-level field on POST /generations.
    if (negativePrompt) body.negative_prompt = negativePrompt;

    const res = await fetch(`${this.base}/api/rest/v1/generations`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ImageProviderError(`Leonardo API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as StartResponse;
    const generationId = data.sdGenerationJob?.generationId;
    if (!generationId) {
      throw new ImageProviderError("Leonardo API returned no generationId");
    }
    return generationId;
  }

  private async pollUntilComplete(
    generationId: string,
    fallbackWidth: number,
    fallbackHeight: number
  ): Promise<GeneratedImage> {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await sleep(POLL_INTERVAL_MS);

      const res = await fetch(`${this.base}/api/rest/v1/generations/${generationId}`, {
        headers: this.headers(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new ImageProviderError(`Leonardo poll error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as PollResponse;
      const gen = data.generations_by_pk;

      if (gen.status === "FAILED") {
        throw new ImageProviderError("Leonardo image generation failed");
      }

      if (gen.status === "COMPLETE") {
        const img = gen.generated_images[0];
        if (!img)
          throw new ImageProviderError("Leonardo returned no images in completed generation");
        return {
          url: img.url,
          width: img.width ?? fallbackWidth,
          height: img.height ?? fallbackHeight,
          providerAssetId: generationId,
        };
      }
    }

    throw new ImageProviderError(
      `Leonardo generation timed out after ${(POLL_INTERVAL_MS * MAX_POLLS) / 1000}s`
    );
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
