export type { HyperSyncGetResponse } from "./client.ts";
import { BlockField, JoinMode, LogField } from "./client.ts";
import { HYPERSYNC_BATCH_SIZE, HYPERSYNC_MAX_BLOCKS_PER_REQUEST } from "../config/index.ts";
import { normalizeTopic } from "./topics.ts";
import { normalizeEvmAddress } from "../utils/identity.ts";

export type HyperSyncLogFilter = {
  address?: string[];
  topics?: string[][];
};

type HyperSyncLogFilterInput = {
  address?: unknown[];
  topics?: unknown[][];
};

export type HyperSyncFieldSelection = {
  log: unknown[];
  block: unknown[];
};

export type HyperSyncLogQuery = {
  fromBlock: number;
  toBlock?: number;
  logs: HyperSyncLogFilter[];
  joinMode: unknown;
  maxNumLogs: number;
  maxNumBlocks?: number;
  fieldSelection: HyperSyncFieldSelection;
};

export type HyperSyncHistoricalQueryPolicyInput = {
  joinMode?: unknown;
  maxNumLogs?: number;
  maxNumBlocks?: number;
};

export const DEFAULT_HYPERSYNC_BLOCK_FIELDS = [BlockField.Number, BlockField.Timestamp];

export const DEFAULT_HYPERSYNC_LOG_FIELDS = [
  LogField.Address,
  LogField.Data,
  LogField.Topic0,
  LogField.Topic1,
  LogField.Topic2,
  LogField.Topic3,
  LogField.BlockNumber,
  LogField.TransactionHash,
  LogField.LogIndex,
  LogField.TransactionIndex,
];

type HyperSyncLogQueryOptions = {
  fromBlock: number;
  logs: HyperSyncLogFilterInput[];
  toBlock?: number;
  joinMode?: unknown;
  maxNumLogs?: number;
  maxNumBlocks?: number;
  logFields?: unknown[];
  blockFields?: unknown[];
};

function fieldKey(field: unknown) {
  return String(field);
}

function fieldLabel(field: unknown) {
  const label = fieldKey(field).trim();
  return label.length > 0 ? label : "<blank>";
}

function normalizeQueryBlock(name: string, value: number | undefined) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`HyperSync query ${name} must be a finite non-negative integer.`);
  }
  return numeric;
}

function normalizePositiveQueryLimit(name: string, value: number | undefined) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`HyperSync query ${name} must be a finite positive integer.`);
  }
  return numeric;
}

function validJoinModeValues() {
  return new Set(
    ["Default", "JoinAll", "JoinNothing"]
      .map((name) => (JoinMode as Record<string, unknown>)[name])
      .filter((value): value is number => typeof value === "number"),
  );
}

function normalizeJoinMode(joinMode: unknown) {
  const validValues = validJoinModeValues();
  const normalizeNumericJoinMode = (value: number) => {
    if (!Number.isInteger(value) || !validValues.has(value)) {
      throw new Error("HyperSync query joinMode must be a valid JoinMode enum value.");
    }
    return value;
  };

  if (typeof joinMode === "number") {
    return normalizeNumericJoinMode(joinMode);
  }

  if (typeof joinMode === "string") {
    const normalized = joinMode.trim();
    if (normalized.length === 0) {
      throw new Error("HyperSync query joinMode must be a valid JoinMode enum value.");
    }
    const namedJoinMode = (JoinMode as Record<string, unknown>)[normalized];
    if (typeof namedJoinMode === "number") return namedJoinMode;
    const numericJoinMode = Number(normalized);
    if (Number.isInteger(numericJoinMode)) return normalizeNumericJoinMode(numericJoinMode);
  }

  throw new Error("HyperSync query joinMode must be a valid JoinMode enum value.");
}

function normalizeLogFilter(filter: HyperSyncLogFilterInput, index: number): HyperSyncLogFilter {
  const address = Array.isArray(filter?.address)
    ? filter.address.map((entry) => normalizeEvmAddress(entry)).filter((entry): entry is string => entry != null)
    : [];
  const normalizedAddress = [...new Set(address)];
  const topics = Array.isArray(filter?.topics)
    ? filter.topics.map((group) =>
        Array.isArray(group) ? [...new Set(group.map(normalizeTopic).filter((entry) => entry.length > 0))] : [],
      )
    : [];
  const lastConstrainedTopicIndex = topics.findLastIndex((group) => group.length > 0);
  const normalizedTopics = lastConstrainedTopicIndex >= 0 ? topics.slice(0, lastConstrainedTopicIndex + 1).map((group) => [...group]) : [];

  if (normalizedAddress.length === 0 && normalizedTopics.length === 0) {
    throw new Error(`HyperSync query log filter #${index} must include at least one valid address or topic constraint.`);
  }

  return {
    ...(normalizedAddress.length > 0 ? { address: normalizedAddress } : {}),
    ...(normalizedTopics.length > 0 ? { topics: normalizedTopics } : {}),
  };
}

function normalizeFieldSelection(name: string, fields: unknown[], requiredFields: unknown[] = []) {
  const seen = new Set<string>();
  const normalized: unknown[] = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    const value = typeof field === "string" ? field.trim() : field;
    if (value == null) continue;
    if (typeof value === "string" && value.length === 0) continue;

    const key = fieldKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }

  if (normalized.length === 0) {
    throw new Error(`HyperSync query must request at least one ${name} field.`);
  }

  const missing = requiredFields.filter((field) => !seen.has(fieldKey(field)));
  if (missing.length > 0) {
    throw new Error(`HyperSync query ${name} fields must include ${missing.map(fieldLabel).join(", ")}.`);
  }

  return normalized;
}

export function buildHyperSyncLogQuery(options: HyperSyncLogQueryOptions): HyperSyncLogQuery {
  const {
    fromBlock,
    logs,
    toBlock,
    joinMode = JoinMode.JoinNothing,
    maxNumLogs = HYPERSYNC_BATCH_SIZE,
    maxNumBlocks = HYPERSYNC_MAX_BLOCKS_PER_REQUEST,
    logFields = DEFAULT_HYPERSYNC_LOG_FIELDS,
    blockFields = DEFAULT_HYPERSYNC_BLOCK_FIELDS,
  } = options;
  const normalizedFromBlock = normalizeQueryBlock("fromBlock", fromBlock);
  const normalizedToBlock = toBlock != null ? normalizeQueryBlock("toBlock", toBlock) : undefined;
  if (normalizedToBlock != null && normalizedToBlock < normalizedFromBlock) {
    throw new Error(`HyperSync query has invalid block range: fromBlock ${normalizedFromBlock} exceeds toBlock ${normalizedToBlock}.`);
  }
  if (!Array.isArray(logs) || logs.length === 0) {
    throw new Error("HyperSync query must include at least one log filter.");
  }
  const normalizedLogs = logs.map((filter, index) => normalizeLogFilter(filter, index));
  const normalizedLogFields = normalizeFieldSelection("log", logFields, [LogField.BlockNumber]);
  const normalizedBlockFields = normalizeFieldSelection("block", blockFields, [BlockField.Number]);
  const normalizedMaxNumLogs = normalizePositiveQueryLimit("maxNumLogs", maxNumLogs);
  const normalizedMaxNumBlocks = maxNumBlocks != null ? normalizePositiveQueryLimit("maxNumBlocks", maxNumBlocks) : undefined;
  const normalizedJoinMode = normalizeJoinMode(joinMode);

  return {
    fromBlock: normalizedFromBlock,
    ...(normalizedToBlock != null ? { toBlock: normalizedToBlock } : {}),
    logs: normalizedLogs,
    joinMode: normalizedJoinMode,
    maxNumLogs: normalizedMaxNumLogs,
    ...(normalizedMaxNumBlocks != null ? { maxNumBlocks: normalizedMaxNumBlocks } : {}),
    fieldSelection: {
      log: normalizedLogFields,
      block: normalizedBlockFields,
    },
  };
}

export function applyHistoricalHyperSyncQueryPolicy<T extends HyperSyncHistoricalQueryPolicyInput>(query: T) {
  return {
    ...query,
    joinMode: normalizeJoinMode(query.joinMode ?? JoinMode.JoinNothing),
    maxNumLogs: query.maxNumLogs ?? HYPERSYNC_BATCH_SIZE,
    maxNumBlocks: query.maxNumBlocks ?? HYPERSYNC_MAX_BLOCKS_PER_REQUEST,
  };
}
