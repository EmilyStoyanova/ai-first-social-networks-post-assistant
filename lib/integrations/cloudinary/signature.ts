import crypto from "crypto";

/**
 * Cloudinary's signed-request signature, shared by upload and destroy.
 *
 * The rule is the same for every signed endpoint: take the parameters that are
 * actually sent (excluding `file`, `api_key` and `resource_type`), sort them by
 * name, join as `k=v&k=v`, append the API secret, SHA-1. Getting the parameter
 * SET wrong is the usual cause of "Invalid Signature", so callers sign exactly
 * the object they then post.
 */
export function buildCloudinarySignature(params: Record<string, string>, secret: string): string {
  const str = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHash("sha1")
    .update(str + secret)
    .digest("hex");
}

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Reads the three env vars, or null when the integration is not configured. */
export function readCloudinaryCredentials(): CloudinaryCredentials | null {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}
