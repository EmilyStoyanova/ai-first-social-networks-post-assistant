import type { IImageProvider, GeneratedImage, ImageGenerationOptions } from "./image-provider";
import { LeonardoProvider } from "./leonardo.provider";
import { OpenAIImageProvider } from "./openai.provider";
import { FalProvider } from "./fal.provider";
import { IdeogramProvider } from "./ideogram.provider";
import { WorkerImageProvider } from "./worker.provider";
import { ImageProviderError } from "./image-provider-errors";

const MOCK_IMAGE_URL = "https://placehold.co/1024x1024/e5e7eb/6b7280?text=AI+Image+%28Mock%29";

class MockImageProvider implements IImageProvider {
  async generate(_prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage> {
    return {
      url: MOCK_IMAGE_URL,
      width: options?.width ?? 1024,
      height: options?.height ?? 1024,
      providerAssetId: "mock-asset-id",
    };
  }
}

type ImageProviderName = "openai" | "leonardo" | "fal" | "ideogram" | "worker" | "mock";

function resolveProviderName(): ImageProviderName {
  const raw = process.env.IMAGE_PROVIDER?.toLowerCase().trim();
  if (raw === "openai") return "openai";
  if (raw === "leonardo") return "leonardo";
  if (raw === "fal") return "fal";
  if (raw === "ideogram") return "ideogram";
  if (raw === "worker") return "worker";
  // Default to mock so the app works without any image provider key configured.
  // Set IMAGE_PROVIDER=IDEOGRAM (or FAL / OPENAI / LEONARDO) to enable real generation.
  return "mock";
}

export function getImageProvider(): IImageProvider {
  // AI_MOCK_MODE always wins regardless of IMAGE_PROVIDER
  if (process.env.AI_MOCK_MODE === "true") {
    return new MockImageProvider();
  }

  const provider = resolveProviderName();

  switch (provider) {
    case "mock": {
      return new MockImageProvider();
    }

    case "fal": {
      const apiKey = process.env.FAL_API_KEY;
      if (!apiKey) {
        throw new ImageProviderError(
          "FAL_API_KEY is not set. Set IMAGE_PROVIDER=MOCK or add your Fal.ai key."
        );
      }
      const model = process.env.FAL_MODEL ?? "fal-ai/flux/schnell";
      const baseUrl = process.env.FAL_API_URL;
      return new FalProvider(apiKey, model, baseUrl);
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new ImageProviderError(
          "OPENAI_API_KEY is not set. Set IMAGE_PROVIDER=FAL or IMAGE_PROVIDER=MOCK."
        );
      }
      const model = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
      const baseUrl = process.env.OPENAI_API_URL;
      return new OpenAIImageProvider(apiKey, model, baseUrl);
    }

    case "ideogram": {
      const apiKey = process.env.IDEOGRAM_API_KEY;
      if (!apiKey) {
        throw new ImageProviderError(
          "IDEOGRAM_API_KEY is not set. Set IMAGE_PROVIDER=MOCK or add your Ideogram key."
        );
      }
      const model = process.env.IDEOGRAM_MODEL ?? "V_2";
      const baseUrl = process.env.IDEOGRAM_API_URL;
      return new IdeogramProvider(apiKey, model, baseUrl);
    }

    case "leonardo": {
      const apiKey = process.env.LEONARDO_API_KEY;
      if (!apiKey) {
        throw new ImageProviderError(
          "LEONARDO_API_KEY is not set. Set IMAGE_PROVIDER=IDEOGRAM or IMAGE_PROVIDER=MOCK."
        );
      }
      const modelId = process.env.LEONARDO_MODEL_ID ?? null;
      const baseUrl = process.env.LEONARDO_API_URL;
      return new LeonardoProvider(apiKey, modelId, baseUrl);
    }

    case "worker": {
      const workerUrl = process.env.IMAGE_WORKER_URL;
      if (!workerUrl) {
        throw new ImageProviderError(
          "IMAGE_WORKER_URL is not set. Set IMAGE_PROVIDER=MOCK or configure your image worker URL."
        );
      }
      return new WorkerImageProvider(workerUrl);
    }

    default: {
      const _exhaustive: never = provider;
      throw new ImageProviderError(`Unknown IMAGE_PROVIDER: "${String(_exhaustive)}"`);
    }
  }
}
