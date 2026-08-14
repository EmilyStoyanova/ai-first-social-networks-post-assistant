import { requestSignal } from "@/lib/http/request-deadline";
import { buildCloudinarySignature, readCloudinaryCredentials } from "./signature";

/**
 * Destroying a stored Cloudinary image.
 *
 * The counterpart to uploadImageToCloudinary, and deliberately the same shape:
 * signed server-side only, and it NEVER throws — every failure comes back as a
 * message. Callers here are cleanup paths running after a database commit, where
 * a throw would turn "one orphaned remote file" into a failed user action.
 *
 * A public id Cloudinary does not know is reported as SUCCESS. Deletion is meant
 * to be idempotent: a retry, a double-click, or a row whose asset was already
 * removed by hand must all end in the same place — the resource is gone.
 */

export type CloudinaryDeleteResult = { success: true } | { success: false; message: string };

/** Short: nothing downstream waits on it, and a hung call must not hold a request. */
const DESTROY_TIMEOUT_MS = 10_000;

interface CloudinaryDestroyResponse {
  result?: string;
  error?: { message: string };
}

export async function deleteImageFromCloudinary(publicId: string): Promise<CloudinaryDeleteResult> {
  if (!publicId) return { success: false, message: "Missing Cloudinary public id." };

  const credentials = readCloudinaryCredentials();
  // Not configured is not an error to report upward: an install with no
  // Cloudinary never uploaded anything, so there is nothing to destroy.
  if (!credentials) return { success: true };

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signParams: Record<string, string> = { public_id: publicId, timestamp };
  const signature = buildCloudinarySignature(signParams, credentials.apiSecret);

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", credentials.apiKey);
  form.append("timestamp", timestamp);
  form.append("signature", signature);

  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${credentials.cloudName}/image/destroy`, {
      method: "POST",
      body: form,
      signal: requestSignal(DESTROY_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      success: false,
      message: isTimeout ? "Image delete timed out." : "Image delete request failed.",
    };
  }

  let data: CloudinaryDestroyResponse;
  try {
    data = (await res.json()) as CloudinaryDestroyResponse;
  } catch {
    return { success: false, message: "Invalid response from image service." };
  }

  if (!res.ok || data.error) {
    return { success: false, message: data.error?.message ?? "Image delete failed." };
  }

  // "ok" — destroyed. "not found" — already gone, which is the same outcome.
  if (data.result === "ok" || data.result === "not found") return { success: true };

  return { success: false, message: `Unexpected Cloudinary result: ${data.result ?? "none"}.` };
}
