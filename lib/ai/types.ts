export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
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
}

export interface FeedItemContext {
  title: string | null;
  content: string | null;
  url: string;
  publishedAt: Date | null;
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
