import { useCallback, useEffect, useState } from "react";

export type Route =
  | { view: "library" }
  | { view: "settings" }
  | { view: "course"; courseId: number }
  | { view: "wizard"; courseId: number };

function parseRoute(): Route {
  // Compatibility with the previous UI / Tauri bootstrap: /?course=<id>
  const query = new URLSearchParams(window.location.search);
  const queryCourse = Number(query.get("course"));
  const hash = window.location.hash.replace(/^#\/?/, "");
  const [head, tail] = hash.split("/");

  if (head === "course" && Number.isInteger(Number(tail))) {
    return { view: "course", courseId: Number(tail) };
  }
  if (head === "wizard" && Number.isInteger(Number(tail))) {
    return { view: "wizard", courseId: Number(tail) };
  }
  if (head === "settings") {
    return { view: "settings" };
  }
  if (hash === "" && Number.isInteger(queryCourse) && queryCourse > 0) {
    return { view: "course", courseId: queryCourse };
  }
  return { view: "library" };
}

function routeToHash(route: Route): string {
  switch (route.view) {
    case "library":
      return "#/library";
    case "settings":
      return "#/settings";
    case "course":
      return `#/course/${route.courseId}`;
    case "wizard":
      return `#/wizard/${route.courseId}`;
  }
}

export function useRoute(): { route: Route; navigate: (route: Route) => void } {
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = routeToHash(next);
  }, []);

  return { route, navigate };
}
