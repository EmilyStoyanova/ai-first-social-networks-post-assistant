export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
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
}

export interface FeedItemContext {
  id: string;
  title: string | null;
  content: string | null;
  url: string;
  publishedAt: Date | null;
  /** ContentSource.config.includeSourceLink of the item's source; undefined = inherit. */
  sourceLinkPreference?: boolean;
}

export interface LlmContext {
  provider: string;
  model: string;
}

export interface GenerationContext {
  company: CompanyContext;
  brand: BrandContext | null;
  channel: ChannelContext;
  feedItems: FeedItemContext[];
  llm: LlmContext;
}
