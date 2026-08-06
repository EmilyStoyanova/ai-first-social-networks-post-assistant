export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Optional JSON schema for structured output (Ollama `format`). Set by translation to
   * constrain the reply to a strict {title, content} object. Providers that do not support
   * structured output ignore it.
   */
  format?: unknown;
  /**
   * Optional penalty on already-emitted tokens (Ollama `repeat_penalty`; 1 = no penalty).
   * Translation raises it on a regeneration to break the decoding loops the self-hosted
   * model falls into. Providers without an equivalent knob ignore it.
   */
  repeatPenalty?: number;
}

export interface LlmResponse {
  text: string;
  raw?: unknown;
}

export interface ILlmProvider {
  generate(request: LlmRequest): Promise<LlmResponse>;
}

// Context types shared between router and prompt builder

export interface CompanyContext {
  name: string;
  website: string | null;
  automationMode: string;
  defaultLang: string;
}

export interface BrandContext {
  companyDescription: string | null;
  toneOfVoice: string | null;
  targetAudience: string | null;
  forbiddenWords: string[];
  /**
   * Competitor names from Brand Setup. Positioning context for the text prompt
   * only — deliberately NOT passed to image generation, where a brand name in
   * the prompt would invite logo/style imitation.
   */
  competitors: string[];
  primaryColor: string | null;
  secondaryColor: string | null;
}

export interface ChannelContext {
  channel: string;
  postingLanguage: string;
  imageRequired: boolean;
  automationModeOverride: string | null;
  maxTextLength: number | null;
  /** Channel default for appending the source article URL (v2-1). */
  includeSourceLink: boolean;
  /** Generate an AI image for the post as soon as it is created, with no user click. */
  autoGenerateImage: boolean;
}

export interface FeedItemContext {
  id: string;
  title: string | null;
  content: string | null;
  url: string;
  publishedAt: Date | null;
  /** ContentSource.config.includeSourceLink of the item's source; undefined = inherit. */
  sourceLinkPreference?: boolean;
  /**
   * Whether this item is a single-use article (rss/product_page) governed by the
   * one-post-per-article reservation, or evergreen (prompt/calendar_event) and
   * therefore reusable and never consumed. Omitted defaults to consumable so
   * article contexts that predate this flag keep their behaviour.
   */
  consumable?: boolean;
  /**
   * Whether `title`/`content` above hold the LLM translation rather than the
   * original article text (v2-4). Provenance only — the text is already
   * resolved; nothing downstream should re-decide based on this.
   */
  usedTranslation?: boolean;
}

export interface GenerationContext {
  company: CompanyContext;
  brand: BrandContext | null;
  channel: ChannelContext;
  feedItems: FeedItemContext[];
  /**
   * Whether the company has at least one enabled *article* source (rss or
   * product_page) — the sources subject to one-post-per-article (Phase 0).
   * Distinguishes "no article source configured → mission/brand post" from
   * "article source configured but every eligible article is already used →
   * skip cleanly". Evergreen prompt/calendar sources deliberately do NOT set
   * this flag: an empty article window with an evergreen item present must still
   * generate, not skip.
   */
  hasArticleSources: boolean;
}
