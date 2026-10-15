import type {NetworkClock} from "../src/network.ts";
export class FakeClock implements NetworkClock {
  time = Date.now();
  next = 0;
  timers = new Map<number, {at: number; callback: () => void}>();
  now() {return this.time;}
  random() {return 0.4;}
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const id = ++this.next;this.timers.set(id, {at: this.time + ms, callback});
    return {id, unref() {return this;}} as unknown as NodeJS.Timeout;
  }
  clearTimeout(timer: NodeJS.Timeout) {this.timers.delete((timer as unknown as {id: number}).id);}
  async advance(ms: number) {
    const target = this.time + ms;await flush();
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;this.timers.delete(next[0]);next[1].callback();await flush();
    }
    this.time = target;await flush();
  }
}
export async function flush() {for (let i = 0; i < 30; i++) await Promise.resolve();}
