export const STAGES = {
  PENDING: "pending",
  PENDING_PLAN: "pending_plan",
  FETCHING_SOURCE: "fetching_source",
  ATTACHING: "attaching",
  PLANNING: "planning",
  PLANNED: "planned",
  EXECUTING: "executing",
  DETECTING_IMAGE: "detecting_image",
  DOWNLOADING: "downloading",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  STOPPED: "stopped",
  FAILED: "failed"
};

export function makeOperationId(item, phase) {
  const sequence = getQueueItemNumber(item);
  return `${Date.now()}-${sequence || "x"}-${phase}-${Math.random().toString(16).slice(2)}`;
}

export function getQueueItemNumber(item, items = []) {
  const savedNumber = Number(item?.sequenceNumber);
  if (Number.isFinite(savedNumber) && savedNumber > 0) return savedNumber;
  const index = items.findIndex((entry) => entry.id === item?.id);
  return index === -1 ? 0 : index + 1;
}

export function isTimeoutError(error) {
  const message = String(error?.message || error?.error || error || "");
  return /超时|timeout/i.test(message);
}

export function shouldRestartFromPlanAfterTimeout(item, error, stopRequested) {
  return isTimeoutError(error) && !item.timeoutRestarted && !stopRequested;
}

export function resetItemForFullRetry(item) {
  item.stage = STAGES.PENDING_PLAN;
  item.error = "";
  item.failedPhase = "";
  item.failedSequenceNumber = 0;
  item.diagnostics = null;
  item.planText = "";
  item.attempts = { plan: 0, execute: 0, download: 0 };
}

export function markItemFailed(item, error, items = []) {
  const normalized = normalizeAutomationError(error);
  item.stage = STAGES.FAILED;
  item.error = normalized.error;
  item.failedPhase = normalized.phase;
  item.failedSequenceNumber = getQueueItemNumber(item, items);
  item.diagnostics = normalized.diagnostics;
}

export function normalizeAutomationError(error) {
  if (error && typeof error === "object") {
    return {
      phase: String(error.phase || error.failedPhase || "unknown"),
      error: String(error.error || error.message || error),
      diagnostics: error.diagnostics || null
    };
  }

  return {
    phase: "unknown",
    error: String(error || "未知错误"),
    diagnostics: null
  };
}

export function isActiveStage(stage) {
  return stage === STAGES.FETCHING_SOURCE
    || stage === STAGES.ATTACHING
    || stage === STAGES.PLANNING
    || stage === STAGES.EXECUTING
    || stage === STAGES.DETECTING_IMAGE
    || stage === STAGES.DOWNLOADING;
}

export function isTerminalStage(stage) {
  return stage === STAGES.COMPLETED
    || stage === STAGES.FAILED
    || stage === STAGES.SKIPPED
    || stage === STAGES.STOPPED;
}

export function stageLabel(stage) {
  const labels = {
    [STAGES.PENDING]: "等待规划",
    [STAGES.PENDING_PLAN]: "等待规划",
    [STAGES.FETCHING_SOURCE]: "下载源图中",
    [STAGES.ATTACHING]: "附件确认中",
    [STAGES.PLANNING]: "规划中",
    [STAGES.PLANNED]: "规划完成",
    [STAGES.EXECUTING]: "执行中",
    [STAGES.DETECTING_IMAGE]: "检测新图中",
    [STAGES.DOWNLOADING]: "下载中",
    [STAGES.COMPLETED]: "已完成",
    [STAGES.SKIPPED]: "已跳过",
    [STAGES.STOPPED]: "已停止",
    [STAGES.FAILED]: "失败"
  };
  return labels[stage] || stage;
}
