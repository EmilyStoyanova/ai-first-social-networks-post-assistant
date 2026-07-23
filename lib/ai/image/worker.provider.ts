import { randomUUID } from "crypto";
import type { IImageProvider, ImageGenerationOptions, GeneratedImage } from "./image-provider";
import { ImageProviderError } from "./image-provider-errors";
import { requestSignal } from "@/lib/http/request-deadline";

interface WorkerResponse {
  imageUrl: string;
  width: number;
  height: number;
}

export class WorkerImageProvider implements IImageProvider {
  constructor(
    private readonly workerUrl: string,
    private readonly apiKey: string
  ) {}

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage> {
    // IMAGE_WORKER_URL is the worker base URL; the request always targets the
    // /generate-image endpoint. Appending is idempotent so a config that already
    // includes the path still resolves to a single /generate-image.
    const base = this.workerUrl.replace(/\/+$/, "");
    const url = base.endsWith("/generate-image") ? base : `${base}/generate-image`;

    // Per-request cap; squeezed smaller when a cron deadline leaves less budget so a
    // slow image generation cannot run past the function timeout.
    const TIMEOUT_MS = 120_000;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-worker-api-key": this.apiKey },
        body: JSON.stringify({ prompt }),
        signal: requestSignal(TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new ImageProviderError("Image worker request exceeded its deadline");
      }
      const providerError = new ImageProviderError(
        `Image worker unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
      (providerError as Error & { cause: unknown }).cause = err;
      throw providerError;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      const providerError = new ImageProviderError(`Image worker error ${res.status}: ${text}`);
      (providerError as Error & { cause: unknown }).cause = {
        url,
        status: res.status,
        statusText: res.statusText,
        body: text,
      };
      throw providerError;
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
