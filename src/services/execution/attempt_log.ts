export interface AttemptEntry {
  timestamp: number;
  routeKey: string;
  profit: bigint;
  gasCost: bigint;
  success: boolean;
  error?: string;
}

export type AttemptLogSink = (entry: AttemptEntry) => void;

let sinks: AttemptLogSink[] = [];

export function setAttemptLogSink(sink: AttemptLogSink): void {
  sinks.push(sink);
}

export function logAttempt(entry: AttemptEntry): void {
  for (const sink of sinks) sink(entry);
}
