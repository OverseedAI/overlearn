export type SplitAgentText = Readonly<{
  thinking: string;
  text: string;
}>;

const internalCourseTerms =
  /\b(fresh course|course[- ]state|store[- ]state|rebuild(?:ing)? (?:the )?course (?:state|context)|current topic|no topics yet|transcript|turn payload|draft[- ]course payload|orientation|calibrat\w*|entry point|durable|mcp|tool call|topic snapshot|learner-facing|system prompt|scratchpad|reasoning channel|internal plan\w*)\b/i;

const internalPlanningTerms =
  /\b(I|we)(?:\s+|['’](?:ll|d)\s+)(need|should|must|will|would|can|have to|first need to)\b/i;

const thirdPersonLearnerTerms =
  /\b(the learner|learner['’]s|learner just|learner has|learner wants|learner asked|learner selected|learner profile)\b/i;

const internalCommandTerms =
  /\b(rebuild[- ]course[- ]state|get[-_ ]course[-_ ]state)\b/i;

const shortReplyMaxCharacters = 2_000;

const looksLikeLeakedThinking = (paragraph: string): boolean => {
  const trimmed = paragraph.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (internalCommandTerms.test(trimmed)) {
    return true;
  }

  if (thirdPersonLearnerTerms.test(trimmed) && internalCourseTerms.test(trimmed)) {
    return true;
  }

  return internalPlanningTerms.test(trimmed) && internalCourseTerms.test(trimmed);
};

export const splitLeadingLeakedThinking = (text: string): SplitAgentText => {
  const normalized = text.replaceAll("\r\n", "\n");
  const paragraphs = normalized.split(/\n\s*\n/);
  const leakedIndexes = new Set<number>();

  for (const [index, paragraph] of paragraphs.entries()) {
    if (looksLikeLeakedThinking(paragraph)) {
      leakedIndexes.add(index);
      continue;
    }

    // Long teaching replies only trim a leading scratchpad. In short draft
    // and orientation replies, inspect every paragraph because harnesses can
    // interleave a planning note with otherwise learner-facing prose.
    if (normalized.length > shortReplyMaxCharacters) {
      break;
    }
  }

  if (leakedIndexes.size === 0) {
    return { thinking: "", text };
  }

  const thinking = paragraphs
    .filter((_, index) => leakedIndexes.has(index))
    .map((paragraph) => paragraph.trim())
    .join("\n\n");
  const visible = paragraphs
    .filter((_, index) => !leakedIndexes.has(index))
    .join("\n\n")
    .trimStart();

  return {
    thinking,
    text: visible,
  };
};
