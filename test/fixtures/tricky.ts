// unicode: héllo wörld 你好 🎉
export default function défaultFn(ünïcode: string): void {}

export class Widget {
  onClick = (e: MouseEvent) => { console.log(e); };
  static create(): Widget { return new Widget(); }
  get value(): number { return 1; }
  private async #hidden(): Promise<void> {}
}

export async function* gen(): AsyncGenerator<number> { yield 1; }

const obj = {
  methodInObject(a: number) { return a; },
};

export function overloaded(a: string): void;
export function overloaded(a: number): void;
export function overloaded(a: unknown): void {}

namespace NS {
  export function inNamespace(): void {}
}
