export class OperationTracker {
  private readonly pending = new Set<Promise<unknown>>();

  get size(): number {
    return this.pending.size;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    const release = () => this.pending.delete(operation);
    operation.then(release, release);
    return operation;
  }

  async settled(): Promise<void> {
    if (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
