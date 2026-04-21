import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { sleep } from "./text-runtime.js";

type WhatsAppOutboundPayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: readonly string[];
};

type WhatsAppLoadedMediaLike = {
  buffer: Buffer;
  contentType?: string;
  kind?: string;
  fileName?: string;
};

export type CanonicalWhatsAppLoadedMedia = {
  buffer: Buffer;
  kind: "image" | "audio" | "video" | "document";
  mimetype: string;
  fileName?: string;
};

export function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export function resolveWhatsAppOutboundMediaUrls(
  payload: Pick<WhatsAppOutboundPayloadLike, "mediaUrl" | "mediaUrls">,
): string[] {
  const mediaUrls = payload.mediaUrls?.length
    ? [...payload.mediaUrls]
    : resolveOutboundMediaUrls({ mediaUrl: payload.mediaUrl, mediaUrls: undefined });
  return mediaUrls.map((entry) => entry.trim()).filter(Boolean);
}

// Keep new WhatsApp outbound-media behavior in this helper so payload, gateway, and auto-reply paths stay aligned.
export function normalizeWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike>(
  payload: T,
): Omit<T, "text" | "mediaUrl" | "mediaUrls"> & {
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
} {
  const mediaUrls = resolveWhatsAppOutboundMediaUrls(payload);
  return {
    ...payload,
    text: normalizeWhatsAppPayloadText(payload.text),
    mediaUrl: mediaUrls[0],
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
  };
}

export function normalizeWhatsAppLoadedMedia(
  media: WhatsAppLoadedMediaLike,
  mediaUrl?: string,
): CanonicalWhatsAppLoadedMedia {
  const kind =
    media.kind === "image" || media.kind === "audio" || media.kind === "video"
      ? media.kind
      : "document";
  const mimetype =
    kind === "audio" && media.contentType === "audio/ogg"
      ? "audio/ogg; codecs=opus"
      : (media.contentType ?? "application/octet-stream");
  const fileName =
    kind === "document" ? (media.fileName ?? mediaUrl?.split("/").pop() ?? "file") : undefined;
  return {
    buffer: media.buffer,
    kind,
    mimetype,
    ...(fileName ? { fileName } : {}),
  };
}

export function isRetryableWhatsAppOutboundError(error: unknown): boolean {
  const errorText = error instanceof Error ? error.message : String(error);
  return /closed|reset|timed\s*out|disconnect/i.test(errorText);
}

export async function sendWhatsAppOutboundWithRetry<T>(params: {
  send: () => Promise<T>;
  onRetry?: (params: {
    attempt: number;
    maxAttempts: number;
    backoffMs: number;
    error: unknown;
    errorText: string;
  }) => Promise<void> | void;
  maxAttempts?: number;
}): Promise<T> {
  const maxAttempts = params.maxAttempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await params.send();
    } catch (error) {
      lastError = error;
      const errorText = error instanceof Error ? error.message : String(error);
      const isLastAttempt = attempt === maxAttempts;
      if (!isRetryableWhatsAppOutboundError(error) || isLastAttempt) {
        throw error;
      }
      const backoffMs = 500 * attempt;
      await params.onRetry?.({
        attempt,
        maxAttempts,
        backoffMs,
        error,
        errorText,
      });
      await sleep(backoffMs);
    }
  }
  throw lastError;
}
