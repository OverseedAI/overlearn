import { Buffer } from "node:buffer";

import type { PromptAttachment } from "./adapter/types";

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ALLOWED_FILE_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const allowedImageMimeTypes = new Set<string>(ALLOWED_IMAGE_MIME_TYPES);
const allowedFileMimeTypes = new Set<string>(ALLOWED_FILE_MIME_TYPES);

const attachmentLabel = (value: Record<string, unknown>, index: number): string =>
  typeof value["name"] === "string" && value["name"].trim().length > 0
    ? `Attachment “${value["name"]}”`
    : `Attachment ${index + 1}`;

const isBase64 = (data: string): boolean => {
  if (data.length % 4 !== 0) {
    return false;
  }

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) {
      return false;
    }
  }

  for (let index = contentLength; index < data.length; index += 1) {
    if (data[index] !== "=") {
      return false;
    }
  }

  return true;
};

const decodedAttachmentSize = (data: string, label: string): number => {
  if (!isBase64(data)) {
    throw new Error(`${label} must contain valid base64 data.`);
  }

  return Buffer.from(data, "base64").byteLength;
};

const parsePromptAttachment = (
  value: unknown,
  index: number,
): PromptAttachment => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Attachment ${index + 1} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const label = attachmentLabel(record, index);
  const kind = record["kind"];
  const name = record["name"];
  const mimeType = record["mimeType"];
  const data = record["data"];

  if (kind !== "image" && kind !== "file") {
    throw new Error(`${label} kind must be image or file.`);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${label} must have a name.`);
  }
  if (typeof mimeType !== "string") {
    throw new Error(`${label} must have a MIME type.`);
  }
  if (typeof data !== "string") {
    throw new Error(`${label} must contain base64 data.`);
  }

  const supported =
    kind === "image"
      ? allowedImageMimeTypes.has(mimeType)
      : allowedFileMimeTypes.has(mimeType);
  if (!supported) {
    throw new Error(`${label} has an unsupported format (${mimeType || "unknown"}).`);
  }

  if (decodedAttachmentSize(data, label) > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${label} exceeds the 10 MB size limit.`);
  }

  return { kind, name, mimeType, data };
};

export const parsePromptAttachments = (
  value: unknown,
): readonly PromptAttachment[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("attachments must be an array.");
  }

  return value.map(parsePromptAttachment);
};
