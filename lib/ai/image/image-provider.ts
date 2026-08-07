export interface ImageGenerationOptions {
  width?: number;
  height?: number;
  /**
   * Defects and exclusions, comma-separated. Optional and best-effort: providers
   * whose API has no negative-prompt field ignore it rather than folding it back
   * into the positive prompt, where a diffusion text encoder would read it as a
   * request for the very things it lists.
   */
  negativePrompt?: string;
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
