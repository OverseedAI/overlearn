export type SplitAgentText = Readonly<{
  thinking: string;
  text: string;
}>;

const internalCourseTerms =
  /\b(fresh course|course state|store state|current topic|no topics yet|transcript|turn payload|orientation|calibrat\w*|entry point|durable|mcp|tool call|topic snapshot|learner-facing)\b/i;

const internalPlanningTerms =
  /\b(I|we)\s+(need|should|must|will|would|can|have to)\b/i;

const thirdPersonLearnerTerms =
  /\b(the learner|learner just|learner has|learner wants|learner asked|learner selected)\b/i;

const looksLikeLeakedThinking = (paragraph: string): boolean => {
  const trimmed = paragraph.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (thirdPersonLearnerTerms.test(trimmed) && internalCourseTerms.test(trimmed)) {
    return true;
  }

  return internalPlanningTerms.test(trimmed) && internalCourseTerms.test(trimmed);
};

export const splitLeadingLeakedThinking = (text: string): SplitAgentText => {
  const normalized = text.replaceAll("\r\n", "\n");
  const parts = normalized.split(/(\n\s*\n)/);
  let index = 0;

  while (index < parts.length) {
    const paragraph = parts[index] ?? "";
    if (!looksLikeLeakedThinking(paragraph)) {
      break;
    }

    index += 1;
    if (index < parts.length && /^\n\s*\n$/.test(parts[index] ?? "")) {
      index += 1;
    }
  }

  if (index === 0) {
    return { thinking: "", text };
  }

  const thinking = parts.slice(0, index).join("").trim();
  const visible = parts.slice(index).join("").trimStart();

  return {
    thinking,
    text: visible,
  };
};
