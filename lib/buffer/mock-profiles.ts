import type { BufferProfile } from "./buffer-client";

/**
 * The profile list AI_MOCK_MODE answers with.
 *
 * Shaped exactly like Buffer's own so mock mode runs the real code — the
 * selector's channel filter and the publish guard both map these through
 * `bufferServiceToChannel` rather than being handed a channel outright.
 */
export const MOCK_BUFFER_PROFILES: readonly BufferProfile[] = [
  {
    id: "mock-profile-fb",
    name: "Mock Facebook Page",
    service: "facebook",
    formattedUsername: "mock-facebook-page",
  },
  {
    id: "mock-profile-li",
    name: "Mock LinkedIn Company",
    service: "linkedin",
    formattedUsername: "mock-linkedin-company",
  },
  {
    id: "mock-profile-ig",
    name: "Mock Instagram Account",
    service: "instagram",
    formattedUsername: "mock-instagram-account",
  },
];
