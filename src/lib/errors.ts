export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
