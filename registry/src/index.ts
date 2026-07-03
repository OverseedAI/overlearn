import { courseMetadata, validateRegistryBundle } from "./bundle";
import { verifyGitHubPublisher } from "./github";
import { renderCoursePage, renderIndex } from "./html";
import { installScript } from "./install-script";
import { landingPage } from "./landing";
import {
  bundleKey,
  chooseSlug,
  deleteMetadata,
  getMetadata,
  listMetadata,
  putMetadata,
  requireSlug,
} from "./storage";
import type { Env } from "./types";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const textEncoder = new TextEncoder();

const json = (value: unknown, init: ResponseInit = {}): Response =>
  Response.json(value, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });

const html = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });

const shellScript = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, {
    ...init,
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "text/x-shellscript; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });

const notFound = (): Response => json({ error: "Not found." }, { status: 404 });

const readJsonBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (textEncoder.encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Response("Bundle exceeds 5 MB.", { status: 413 });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Response("Expected JSON body.", { status: 400 });
  }
};

const publicCourseUrl = (request: Request, slug: string): string =>
  new URL(`/c/${slug}`, request.url).href;

const apiCourses = async (request: Request, env: Env): Promise<Response> => {
  if (request.method === "GET") {
    return json({ courses: await listMetadata(env) });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }

  const publisher = await verifyGitHubPublisher(request, env);
  const validated = validateRegistryBundle(await readJsonBody(request));
  const selected = await chooseSlug(env, validated.courseName, publisher.login);
  const now = new Date().toISOString();
  const metadata = courseMetadata(
    validated,
    publisher,
    selected.slug,
    now,
    selected.previous,
  );

  await env.COURSES.put(bundleKey(selected.slug), JSON.stringify(validated.bundle), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
  });
  await putMetadata(env, metadata);

  return json(
    {
      slug: selected.slug,
      url: publicCourseUrl(request, selected.slug),
      course: metadata,
    },
    { status: selected.previous === undefined ? 201 : 200 },
  );
};

const apiCourseBundle = async (env: Env, slug: string): Promise<Response> => {
  const object = await env.COURSES.get(bundleKey(slug));
  if (object === null) {
    return notFound();
  }

  return new Response(object.body, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": `attachment; filename="${slug}.json"`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
};

const apiCourse = async (
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> => {
  if (request.method === "GET") {
    const metadata = await getMetadata(env, slug);
    return metadata === undefined ? notFound() : json({ course: metadata });
  }

  if (request.method !== "DELETE") {
    return new Response("Method not allowed.", { status: 405 });
  }

  const publisher = await verifyGitHubPublisher(request, env);
  const metadata = await getMetadata(env, slug);
  if (metadata === undefined) {
    return notFound();
  }

  if (metadata.publisher.login !== publisher.login) {
    return json({ error: "Only the publishing GitHub user can unpublish this course." }, { status: 403 });
  }

  await env.COURSES.delete(bundleKey(slug));
  await deleteMetadata(env, slug);

  return json({ ok: true, slug });
};

const coursePage = async (env: Env, slug: string): Promise<Response> => {
  const metadata = await getMetadata(env, slug);
  if (metadata === undefined) {
    return html(renderIndex([]), { status: 404 });
  }

  return html(renderCoursePage(metadata));
};

const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/") {
    if (request.method !== "GET") {
      return new Response("Method not allowed.", { status: 405 });
    }

    return html(landingPage);
  }

  if (path === "/courses") {
    return html(renderIndex(await listMetadata(env)));
  }

  if (path === "/install.sh" || path === "/install") {
    if (request.method !== "GET") {
      return new Response("Method not allowed.", { status: 405 });
    }

    return shellScript(installScript);
  }

  if (path === "/api/courses") {
    return apiCourses(request, env);
  }

  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "c" && segments.length === 2) {
    return coursePage(env, requireSlug(segments[1]));
  }

  if (segments[0] === "api" && segments[1] === "courses" && segments[2] !== undefined) {
    const slug = requireSlug(segments[2]);

    if (segments.length === 4 && segments[3] === "bundle") {
      if (request.method !== "GET") {
        return new Response("Method not allowed.", { status: 405 });
      }

      return apiCourseBundle(env, slug);
    }

    if (segments.length === 3) {
      return apiCourse(request, env, slug);
    }
  }

  return notFound();
};

const errorResponse = async (error: unknown): Promise<Response> => {
  if (error instanceof Response) {
    const contentType = error.headers.get("Content-Type");
    if (contentType !== null && contentType.includes("application/json")) {
      return error;
    }

    const body = await error.text();
    return json(
      { error: body.trim().length === 0 ? error.statusText || "Request failed." : body },
      { status: error.status },
    );
  }

  const message = error instanceof Error ? error.message : "Unknown error.";
  return json({ error: message }, { status: 400 });
};

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    try {
      return await route(request, env);
    } catch (error) {
      return await errorResponse(error);
    }
  },
};
