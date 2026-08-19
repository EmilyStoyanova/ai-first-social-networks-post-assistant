/**
 * What one image generation did, reported by the image pipeline.
 *
 * Types only, for the same reason `attempt-record.ts` is: the image services are
 * shared by the manual "Generate image" button and by automatic generation, and
 * neither should acquire a database dependency it does not otherwise have.
 *
 * The fields a trace actually needs here are the ones the outcome never carried:
 * a `MediaDTO` says an image exists, not what was ASKED for. The exact positive
 * prompt (post prompt + channel hints + quality suffix), the negative prompt, the
 * provider, the model and the dimensions are all decided inside the pipeline and
 * were previously unrecoverable afterwards.
 */

export interface ImageGenerationRecord {
  /** The post's own `imagePrompt`, or the manual override, before assembly. */
  basePrompt: string;
  /** The prompt EXACTLY as sent to the provider. */
  prompt: string;
  /** Defects and exclusions sent alongside it, when the provider supports them. */
  negativePrompt: string | null;
  provider: string;
  model: string | null;
  style: string | null;
  width: number;
  height: number;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  /** Set on success — what the provider returned and what was stored. */
  result?: {
    url: string;
    width: number;
    height: number;
    providerAssetId: string;
    mediaAssetId: string;
  };
  /** Set on failure — the pipeline's own code and message. */
  error?: { code: string; message?: string };
}

export type ImageGenerationRecorder = (record: ImageGenerationRecord) => void;
