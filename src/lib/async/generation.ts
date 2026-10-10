export class Generation {
  private value = 0;

  get current(): number {
    return this.value;
  }

  next(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(token: number): boolean {
    return token === this.value;
  }
}
