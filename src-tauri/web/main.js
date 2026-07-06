/* global document, window */

const invoke = window.__TAURI__?.core?.invoke;

const elements = {
  configPath: document.querySelector("#configPath"),
  courseList: document.querySelector("#courseList"),
  emptyState: document.querySelector("#emptyState"),
  pickCourse: document.querySelector("#pickCourse"),
  statusLine: document.querySelector("#statusLine"),
  template: document.querySelector("#courseTemplate"),
};

let launcherState = null;

const setStatus = (message, tone = "neutral") => {
  elements.statusLine.textContent = message;
  elements.statusLine.dataset.tone = tone;
};

const invokeCommand = async (command, args = {}) => {
  if (invoke === undefined) {
    throw new Error("Tauri command bridge is unavailable.");
  }

  return await invoke(command, args);
};

const shortenPath = (path) => path.replace(/^\/home\/[^/]+/, "~");

const render = (state) => {
  launcherState = state;
  elements.configPath.textContent = `Config: ${shortenPath(state.configPath)}`;
  elements.courseList.replaceChildren();

  const courses = state.config.courses ?? [];
  elements.emptyState.hidden = courses.length !== 0;

  for (const course of courses) {
    const fragment = elements.template.content.cloneNode(true);
    const card = fragment.querySelector(".course-card");

    card.querySelector(".course-title").textContent = course.title;
    card.querySelector(".course-path").textContent = shortenPath(course.courseDir);
    card.querySelector(".working-dir").textContent =
      course.workingDir === null || course.workingDir === undefined
        ? "Working dir: not set"
        : `Working dir: ${shortenPath(course.workingDir)}`;

    card
      .querySelector(".open-course")
      .addEventListener("click", () => openCourse(course.courseDir));
    card
      .querySelector(".set-working-dir")
      .addEventListener("click", () => pickWorkingDir(course.courseDir));
    card
      .querySelector(".clear-working-dir")
      .addEventListener("click", () => clearWorkingDir(course.courseDir));
    card
      .querySelector(".remove-course")
      .addEventListener("click", () => removeCourse(course.courseDir));

    elements.courseList.append(card);
  }
};

const refresh = async () => {
  render(await invokeCommand("get_launcher_state"));
};

const pickCourse = async () => {
  setStatus("Selecting course...");
  const nextState = await invokeCommand("pick_course_dir");
  if (nextState !== null) {
    render(nextState);
    setStatus("Course added.");
  } else {
    setStatus("");
  }
};

const pickWorkingDir = async (courseDir) => {
  setStatus("Selecting working directory...");
  const nextState = await invokeCommand("pick_working_dir", { courseDir });
  if (nextState !== null) {
    render(nextState);
    setStatus("Working directory saved.");
  } else {
    setStatus("");
  }
};

const clearWorkingDir = async (courseDir) => {
  render(await invokeCommand("clear_working_dir", { courseDir }));
  setStatus("Working directory cleared.");
};

const removeCourse = async (courseDir) => {
  render(await invokeCommand("remove_course", { courseDir }));
  setStatus("Course removed.");
};

const openCourse = async (courseDir) => {
  setStatus("Starting daemon...");
  const result = await invokeCommand("open_course", { courseDir });
  setStatus(
    result.startedByApp
      ? `Daemon started on port ${result.port}.`
      : `Using daemon on port ${result.port}.`,
  );
  window.location.href = result.url;
};

const run = async () => {
  elements.pickCourse.addEventListener("click", () => {
    pickCourse().catch((error) => setStatus(error.message, "error"));
  });

  await refresh();
};

run().catch((error) => {
  const fallback = launcherState === null ? "Launcher failed." : error.message;
  setStatus(`${fallback} ${error.message}`, "error");
});
