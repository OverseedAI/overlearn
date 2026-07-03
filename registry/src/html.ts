import type { CourseMetadata, TopicOutline } from "./types";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const formatDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
};

const css = String.raw`
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #11110f;
  color: #f4f4f1;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(180deg, rgb(159 207 134 / 8%), transparent 22rem),
    #11110f;
}

a {
  color: inherit;
}

.shell {
  width: min(100%, 76rem);
  margin: 0 auto;
  padding: 1rem;
}

.site-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid #2f302b;
  padding: 1.5rem 0 1rem;
}

.brand {
  display: grid;
  gap: 0.35rem;
}

.brand a {
  width: fit-content;
  color: #9fcf86;
  font-size: 0.9rem;
  text-decoration: none;
}

h1,
h2,
h3,
p {
  margin: 0;
}

h1 {
  color: #fafaf8;
  font-size: clamp(1.7rem, 3vw, 2.65rem);
  font-weight: 650;
  letter-spacing: 0;
}

.subtle {
  color: #a7a9a0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: 0.85rem;
  padding: 1rem 0 2rem;
}

.card,
.panel {
  border: 1px solid #30312d;
  border-radius: 8px;
  background: #171814;
}

.card {
  display: grid;
  gap: 0.8rem;
  min-height: 13rem;
  padding: 1rem;
  text-decoration: none;
}

.card:hover {
  border-color: #58724b;
  background: #1c2119;
}

.card h2,
.panel h2 {
  color: #fafaf8;
  font-size: 1.05rem;
  font-weight: 650;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.pill {
  border: 1px solid #3a4933;
  border-radius: 999px;
  color: #d5d5cf;
  padding: 0.2rem 0.45rem;
  font-size: 0.78rem;
  line-height: 1.3;
}

.panels {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
  gap: 1rem;
  padding: 1rem 0 2rem;
}

.panel {
  padding: 1rem;
}

.panel + .panel {
  margin-top: 1rem;
}

.topic-tree,
.topic-children {
  display: grid;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.topic-children {
  margin-top: 0.45rem;
  border-left: 1px solid #30352d;
  padding-left: 0.9rem;
}

.topic-title {
  color: #eeeeea;
}

.topic-path,
code {
  color: #a7a9a0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.86rem;
}

.snippet {
  display: block;
  overflow-x: auto;
  border: 1px solid #30312d;
  border-radius: 8px;
  background: #0d0e0c;
  color: #d9f6b3;
  padding: 0.75rem;
}

.empty {
  border: 1px dashed #3a3b35;
  border-radius: 8px;
  color: #a7a9a0;
  padding: 1rem;
}

@media (max-width: 760px) {
  .site-header,
  .panels {
    grid-template-columns: 1fr;
    display: grid;
  }
}
`;

const layout = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
  <main class="shell">${body}</main>
</body>
</html>`;

const courseCard = (course: CourseMetadata): string =>
  `<a class="card" href="/c/${escapeHtml(course.slug)}">
    <div class="brand">
      <h2>${escapeHtml(course.title)}</h2>
      <p class="subtle">${escapeHtml(course.slug)} by ${escapeHtml(course.publisher.login)}</p>
    </div>
    <div class="meta">
      <span class="pill">${course.topicCount} topics</span>
      <span class="pill">${course.glossarySize} glossary</span>
      <span class="pill">${course.demoCount} demos</span>
      <span class="pill">${escapeHtml(formatDate(course.publishedAt))}</span>
    </div>
  </a>`;

const renderTopicTree = (topics: readonly TopicOutline[]): string => {
  if (topics.length === 0) {
    return '<p class="empty">No topic outline published yet.</p>';
  }

  return `<ul class="topic-tree">${topics
    .map(
      (topic) => `<li>
        <div>
          <span class="topic-title">${escapeHtml(topic.title)}</span>
          <span class="topic-path">${escapeHtml(topic.path)}</span>
        </div>
        ${
          topic.children.length === 0
            ? ""
            : `<div class="topic-children">${renderTopicTree(topic.children)}</div>`
        }
      </li>`,
    )
    .join("")}</ul>`;
};

export const renderIndex = (courses: readonly CourseMetadata[]): string =>
  layout(
    "Overlearn Registry",
    `<header class="site-header">
      <div class="brand">
        <a href="/">overlearn</a>
        <h1>Shared Courses</h1>
        <p class="subtle">Course bundles published by learners — fetch one with learn fetch &lt;slug&gt;.</p>
      </div>
      <p class="subtle">${courses.length} courses</p>
    </header>
    ${
      courses.length === 0
        ? '<section class="grid"><p class="empty">No courses published yet.</p></section>'
        : `<section class="grid">${courses.map(courseCard).join("")}</section>`
    }`,
  );

export const renderCoursePage = (course: CourseMetadata): string =>
  layout(
    `${course.title} - Overlearn Registry`,
    `<header class="site-header">
      <div class="brand">
        <a href="/courses">Courses</a>
        <h1>${escapeHtml(course.title)}</h1>
        <p class="subtle">${escapeHtml(course.slug)} by ${escapeHtml(
          course.publisher.login,
        )}</p>
      </div>
      <p class="subtle">Published ${escapeHtml(formatDate(course.publishedAt))}</p>
    </header>
    <section class="panels">
      <div class="panel">
        <h2>Topic Outline</h2>
        <div style="height:0.8rem"></div>
        ${renderTopicTree(course.topics)}
      </div>
      <aside>
        <div class="panel">
          <h2>Fetch</h2>
          <div style="height:0.8rem"></div>
          <code class="snippet">learn fetch ${escapeHtml(course.slug)}</code>
        </div>
        <div class="panel">
          <h2>Metadata</h2>
          <div style="height:0.8rem"></div>
          <div class="meta">
            <span class="pill">${course.topicCount} topics</span>
            <span class="pill">${course.glossarySize} glossary</span>
            <span class="pill">${course.demoCount} demos</span>
            <span class="pill">${course.fileCount} files</span>
          </div>
        </div>
      </aside>
    </section>`,
  );
