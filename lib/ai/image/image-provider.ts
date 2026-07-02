export interface ImageGenerationOptions {
  width?: number;
  height?: number;
}

export interface GeneratedImage {
  url: string;
  width: number;
  height: number;
  /** Stored in the cloudinaryId column as a generic provider asset ID. */
  providerAssetId: string;
}

export interface IImageProvider {
  generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage>;
}
