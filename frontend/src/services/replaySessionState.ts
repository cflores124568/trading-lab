export type ReplaySessionStatus = "draft" | "active" | "paused" | "completed" | "review";

export function getReplaySessionStatus(input: {
  hasLaunch: boolean;
  isPlaying: boolean;
  isComplete: boolean;
  isReviewMode: boolean;
}): ReplaySessionStatus {
  if (!input.hasLaunch) {
    return "draft";
  }

  if (input.isReviewMode) {
    return "review";
  }

  if (input.isPlaying) {
    return "active";
  }

  if (input.isComplete) {
    return "completed";
  }

  return "paused";
}

export function formatReplaySessionStatus(status: string): string {
  if (status === "active") {
    return "Sim Running";
  }

  if (status === "paused") {
    return "Sim Paused";
  }

  if (status === "completed") {
    return "Sim Finished";
  }

  if (status === "review") {
    return "Review Mode";
  }

  if (status === "draft") {
    return "Draft";
  }

  return status
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
