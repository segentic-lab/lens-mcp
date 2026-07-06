import { EventEmitter } from 'events';
import * as path from 'path';

// TODO: refactor this interface
interface Config {
  port: number;
  host: string;
}

/**
 * Main application class
 */
export class Application {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log('Starting...');
  }

  stop(): void {
    console.log('Stopping...');
  }
}

// HACK: workaround for issue #123
function helperFunction(a: string, b: number): boolean {
  return a.length > b;
}

export const processData = async (items: string[]): Promise<string[]> => {
  return items.map(i => i.toUpperCase());
};

export { helperFunction };

export default Application;
