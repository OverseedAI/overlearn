import { uiAssets } from "./spa-assets.gen";

/**
 * Serves the built SPA (ui/dist) embedded into the sidecar by
 * scripts/embed-ui-assets.ts. When the manifest is a stub (no UI build),
 * spaAvailable() is false and the daemon falls back to the legacy renderer.
 */

const decoded = new Map<string, Uint8Array>();

const assetBody = (route: string): Uint8Array | undefined => {
  const cached = decoded.get(route);
  if (cached !== undefined) {
    return cached;
  }

  const asset = uiAssets[route];
  if (asset === undefined) {
    return undefined;
  }

  const body = Uint8Array.from(Buffer.from(asset.base64, "base64"));
  decoded.set(route, body);
  return body;
};

export const spaAvailable = (): boolean => "/index.html" in uiAssets;

export const serveSpaAsset = (pathname: string): Response | undefined => {
  const route = pathname === "/" ? "/index.html" : pathname;
  const asset = uiAssets[route];
  const body = assetBody(route);
  if (asset === undefined || body === undefined) {
    return undefined;
  }

  return new Response(body, {
    headers: {
      "content-type": asset.type,
      // Hashed assets can cache forever; index.html must revalidate.
      "cache-control":
        route === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
};
