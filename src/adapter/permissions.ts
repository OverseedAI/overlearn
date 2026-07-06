import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  PermissionRule,
} from "./types";

export const defaultPermissionPolicy: PermissionPolicy = {
  allow: [],
  defaultDecision: "deny",
  defaultReason: "Permission was not pre-approved by the session policy.",
};

const fieldMatches = (ruleValue: string | undefined, requestValue: string): boolean =>
  ruleValue === undefined || ruleValue === requestValue;

const ruleMatches = (
  rule: PermissionRule,
  request: PermissionRequest,
): boolean =>
  fieldMatches(rule.action, request.action) &&
  fieldMatches(rule.resource, request.resource ?? "");

export const evaluatePermissionRequest = (
  request: PermissionRequest,
  policy: PermissionPolicy = defaultPermissionPolicy,
): PermissionDecision => {
  const match = policy.allow.find((rule) => ruleMatches(rule, request));

  if (match !== undefined) {
    return {
      allowed: true,
      reason: match.reason ?? "Permission matched the pre-approved allowlist.",
    };
  }

  if (policy.defaultDecision === "allow") {
    return {
      allowed: true,
      reason: policy.defaultReason ?? "Permission allowed by default policy.",
    };
  }

  return {
    allowed: false,
    reason:
      policy.defaultReason ??
      defaultPermissionPolicy.defaultReason ??
      "Permission denied by default policy.",
  };
};
