type ParsedRunnerArgs = {
  loopMode: boolean;
  liveMode: boolean;
  discoveryOnly: boolean;
  tuiMode: boolean;
  pollIntervalSec: number;
  maxPasses: number | null;
};

function parsePositiveInteger(value: string, flagName: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flagName} must be a positive integer, received "${value}"`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer, received "${value}"`);
  }

  return parsed;
}

export function parseRunnerArgs(args: string[], defaultPollIntervalSec: number): ParsedRunnerArgs {
  const intervalIdx = args.indexOf("--interval");
  let pollIntervalSec = defaultPollIntervalSec;

  if (intervalIdx !== -1) {
    const rawValue = args[intervalIdx + 1];
    if (rawValue == null || rawValue.startsWith("--")) {
      throw new Error("--interval requires a positive integer value in seconds");
    }
    pollIntervalSec = parsePositiveInteger(rawValue, "--interval");
  }

  const maxPassesIdx = args.indexOf("--max-passes");
  let maxPasses: number | null = null;
  if (maxPassesIdx !== -1) {
    const rawValue = args[maxPassesIdx + 1];
    if (rawValue == null || rawValue.startsWith("--")) {
      throw new Error("--max-passes requires a positive integer value");
    }
    maxPasses = parsePositiveInteger(rawValue, "--max-passes");
  }

  return {
    loopMode: args.includes("--loop"),
    liveMode: args.includes("--live"),
    discoveryOnly: args.includes("--discovery-only"),
    tuiMode: args.includes("--tui"),
    pollIntervalSec,
    maxPasses,
  };
}
