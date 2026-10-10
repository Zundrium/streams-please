import { Generation } from '$lib/async/generation';

export type SeekSchedulerOptions = {
  perform: (target: number) => Promise<void>;
  canSeek: () => boolean;
  onError: (target: number, reason: unknown) => void;
  track?: (operation: Promise<void>) => Promise<void>;
};

export class SeekScheduler {
  private readonly options: SeekSchedulerOptions;
  private pending: number | null = null;
  private operation: Promise<void> | null = null;
  private readonly generation = new Generation();

  constructor(options: SeekSchedulerOptions) {
    this.options = options;
  }

  get pendingTarget(): number | null {
    return this.pending;
  }

  schedule(target: number): void {
    this.pending = target;
    this.flush();
  }

  invalidate(): void {
    this.generation.next();
    this.pending = null;
  }

  private flush(): void {
    if (this.operation || this.pending === null) return;
    const generation = this.generation.current;
    const run = this.drain(generation);
    const operation = this.options.track ? this.options.track(run) : run;
    this.operation = operation;
    const finish = () => this.finish(operation, generation);
    operation.then(finish, finish);
  }

  private finish(operation: Promise<void>, generation: number): void {
    if (this.operation !== operation) return;
    this.operation = null;
    if (this.generation.isCurrent(generation) && this.pending !== null && this.options.canSeek()) {
      this.flush();
    }
  }

  private async drain(generation: number): Promise<void> {
    while (this.generation.isCurrent(generation) && this.options.canSeek() && this.pending !== null) {
      const target = this.pending;
      this.pending = null;
      try {
        await this.options.perform(target);
      } catch (reason) {
        if (this.generation.isCurrent(generation)) this.options.onError(target, reason);
        return;
      }
    }
  }
}
