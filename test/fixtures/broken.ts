export function good(a: string): number {
  return a.length;
}

function broken(a: {{{ syntax error here
  return 1;
}

export function alsoGood(): void {}
