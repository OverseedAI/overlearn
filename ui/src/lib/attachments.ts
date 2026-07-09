import type { PromptAttachment } from "./types";

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

export const ATTACHMENT_ACCEPT = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_FILE_MIME_TYPES,
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".json",
  ".pdf",
].join(",");

const allowedImageMimeTypes = new Set<string>(ALLOWED_IMAGE_MIME_TYPES);
const allowedFileMimeTypes = new Set<string>(ALLOWED_FILE_MIME_TYPES);
const mimeTypeByExtension: Readonly<Record<string, string>> = {
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  webp: "image/webp",
};

export const attachmentMimeType = (file: File): string => {
  if (file.type.length > 0) {
    return file.type.toLowerCase();
  }

  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return extension === undefined ? "" : (mimeTypeByExtension[extension] ?? "");
};

export const attachmentKind = (mimeType: string): PromptAttachment["kind"] =>
  mimeType.startsWith("image/") ? "image" : "file";

export const validateAttachmentFile = (
  file: File,
  mimeType: string,
): string | undefined => {
  const kind = attachmentKind(mimeType);
  const supported =
    kind === "image"
      ? allowedImageMimeTypes.has(mimeType)
      : allowedFileMimeTypes.has(mimeType);

  if (!supported) {
    return `${file.name} has an unsupported format. Use PNG, JPEG, WebP, GIF, PDF, TXT, Markdown, CSV, or JSON.`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} exceeds the 10 MB size limit.`;
  }

  return undefined;
};

export const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Couldn’t read ${file.name}.`));
        return;
      }

      const separator = reader.result.indexOf(",");
      if (separator === -1) {
        reject(new Error(`Couldn’t parse ${file.name}.`));
        return;
      }

      resolve(reader.result.slice(separator + 1));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error(`Couldn’t read ${file.name}.`));
    });
    reader.readAsDataURL(file);
  });
