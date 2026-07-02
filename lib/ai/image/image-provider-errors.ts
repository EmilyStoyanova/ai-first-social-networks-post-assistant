export class ImageProviderError extends Error {
  readonly code = "IMAGE_PROVIDER_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "ImageProviderError";
  }
}
