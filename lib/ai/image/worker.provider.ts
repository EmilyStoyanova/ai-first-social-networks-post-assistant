import { randomUUID } from "crypto";
import type { IImageProvider, ImageGenerationOptions, GeneratedImage } from "./image-provider";
import { ImageProviderError } from "./image-provider-errors";

interface WorkerResponse {
  imageUrl: string;
  width: number;
  height: number;
}

export class WorkerImageProvider implements IImageProvider {
  constructor(private readonly workerUrl: string) {}

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage> {
    const url = this.workerUrl.replace(/\/$/, "");

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
    } catch (err) {
      throw new ImageProviderError(
        `Image worker unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ImageProviderError(`Image worker error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as WorkerResponse;

    if (!data.imageUrl) {
      throw new ImageProviderError("Image worker returned no imageUrl");
    }

    return {
      url: data.imageUrl,
      width: data.width ?? options?.width ?? 1024,
      height: data.height ?? options?.height ?? 1024,
      providerAssetId: randomUUID(),
    };
  }
}
