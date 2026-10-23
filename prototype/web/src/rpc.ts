// PROTOTYPE. Page-side handle on the agent worker.

import type { Notification, Reply, Request } from "./protocol";

type Listener = (n: Notification) => void;
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export class AgentWorker {
  private worker: Worker;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<Reply | Notification>) => {
      const d = e.data as any;
      if (typeof d.id === "number") {
        const p = this.pending.get(d.id);
        if (!p) return;
        this.pending.delete(d.id);
        if (d.ok) p.resolve(d.result);
        else p.reject(new Error(d.error));
      } else {
        for (const l of this.listeners) l(d as Notification);
      }
    };
    this.worker.onerror = (e) => {
      for (const l of this.listeners) l({ type: "error", message: e.message });
    };
  }

  call<T = unknown>(req: DistributiveOmit<Request, "id">): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...req });
    });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
