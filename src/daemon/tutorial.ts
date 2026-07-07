import manifestMarkdown from "../../assets/tutorial/manifest.md" with { type: "text" };
import dialogueLoopBody from "../../assets/tutorial/dialogue-loop.md" with { type: "text" };
import feynmanChecksBody from "../../assets/tutorial/feynman-checks.md" with { type: "text" };
import nextCourseBody from "../../assets/tutorial/next-course.md" with { type: "text" };
import reviewRailGlossaryBody from "../../assets/tutorial/review-rail-glossary.md" with { type: "text" };
import topicsMasteryBody from "../../assets/tutorial/topics-mastery.md" with { type: "text" };
import {
  createCourse,
  listCourses,
  replaceTopicTree,
  withStoreTransaction,
  type Course,
  type Store,
  type TopicTreeInput,
} from "../store";

export const TUTORIAL_SOURCE_NAME = "tutorial";

type TutorialManifest = Readonly<{
  title: string;
  description: string;
}>;

type TutorialTopicSource = Readonly<{
  path: string;
  title: string;
  body: string;
}>;

const parseTutorialManifest = (markdown: string): TutorialManifest => {
  const lines = markdown.split(/\r?\n/);
  const title =
    lines
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() ?? "Learning Overlearn";
  const descriptionLines: string[] = [];

  for (const line of lines.slice(1)) {
    if (line.startsWith("## ")) {
      break;
    }

    if (line.trim().length > 0) {
      descriptionLines.push(line.trim());
    }
  }

  return {
    title,
    description: descriptionLines.join(" "),
  };
};

const tutorialManifest = parseTutorialManifest(manifestMarkdown);

const tutorialTopicSources: readonly TutorialTopicSource[] = [
  {
    path: "dialogue-loop",
    title: "Dialogue loop",
    body: dialogueLoopBody,
  },
  {
    path: "topics-mastery",
    title: "Topics and mastery",
    body: topicsMasteryBody,
  },
  {
    path: "feynman-checks",
    title: "Feynman checks",
    body: feynmanChecksBody,
  },
  {
    path: "review-rail-glossary",
    title: "Review rail and glossary",
    body: reviewRailGlossaryBody,
  },
  {
    path: "next-course",
    title: "Creating your next course",
    body: nextCourseBody,
  },
];

export const tutorialTopics: readonly TopicTreeInput[] =
  tutorialTopicSources.map((topic, index) => ({
    path: topic.path,
    title: topic.title,
    body: topic.body.trim(),
    position: index,
    isCurrent: index === 0,
  }));

export const tutorialCourseContent = {
  title: tutorialManifest.title,
  description: tutorialManifest.description,
  topics: tutorialTopics,
} as const;

const findTutorialCourse = (store: Store): Course | undefined =>
  listCourses(store).find((course) => course.sourceName === TUTORIAL_SOURCE_NAME);

export const createTutorialCourse = (store: Store): Course =>
  withStoreTransaction(store, () => {
    // sourceName is the existing durable seed marker: it keeps the tutorial
    // idempotent without schema changes and without depending on mutable title text.
    const existing = findTutorialCourse(store);
    if (existing !== undefined) {
      return existing;
    }

    const course = createCourse(store, {
      title: tutorialCourseContent.title,
      description: tutorialCourseContent.description,
      status: "active",
      sourceName: TUTORIAL_SOURCE_NAME,
      manifestExtra: {
        tutorial: true,
        manifest: "assets/tutorial/manifest.md",
        topicCount: tutorialTopics.length,
      },
    });
    replaceTopicTree(store, course.id, tutorialTopics);

    return course;
  });
