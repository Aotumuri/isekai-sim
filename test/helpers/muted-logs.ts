export function withMutedSimulationLogs<T>(operation: () => T): T {
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    return operation();
  } finally {
    console.info = originalInfo;
  }
}
