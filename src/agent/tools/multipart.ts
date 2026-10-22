import type { MultipartContent, MultipartPart } from "../schemas.js";

/** Convenience constructors for `MultipartContent` parts. */

export function textPart(text: string): MultipartPart {
    return { type: "text", text };
}

export function imagePart(mimeType: string, data: string): MultipartPart {
    return { type: "image", mimeType, data };
}

export function resourcePart(options: {
    uri: string;
    mimeType?: string | null;
    text?: string | null;
    blob?: string | null;
}): MultipartPart {
    return {
        type: "resource",
        uri: options.uri,
        mimeType: options.mimeType ?? null,
        text: options.text ?? null,
        blob: options.blob ?? null,
    };
}

export function structuredPart(data: unknown): MultipartPart {
    return { type: "structured", data };
}

export function multipart(parts: MultipartPart[]): MultipartContent {
    return { type: "multipart", parts };
}