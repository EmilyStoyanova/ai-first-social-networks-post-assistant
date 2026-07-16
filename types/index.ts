export type ApiSuccess<T> = {
  data: T;
  meta?: {
    page?: number;
    total?: number;
    pageSize?: number;
  };
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type UserRole = "owner" | "editor";
export type GlobalRole = "global_admin" | UserRole;

export type SocialChannel = "facebook" | "linkedin" | "instagram" | "tiktok";
export type AutomationMode = "semi_automated" | "fully_automated";
export type PostStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "sent_to_buffer"
  | "published"
  | "failed";
