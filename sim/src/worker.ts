/**
 * Web Worker entry: runs renderImpasto / planImpasto off the main thread.
 *
 * Loaded as a module worker it serves requests on its own scope; on the page, `renderInWorker` /
 * `planInWorker` from the main entry talk to it:
 *
 *   import ImpastoWorker from 'impasto-sim/worker?worker';   // Vite
 *   import { renderInWorker } from 'impasto-sim';
 *   const worker = new ImpastoWorker();
 *   const result = await renderInWorker(worker, file, { preset: 'oil', onProgress, signal });
 *
 * Result buffers are transferred back, not copied. `serveImpasto` also works on any MessagePort.
 */
import { planImpasto, renderImpasto, type ImpastoImageSource, type ImpastoOptions, type ImpastoPlanResult, type ImpastoResult, type ProgressInfo } from './index.ts';

/** Options that can cross to a worker (functions and signals cannot; renderInWorker forwards them). */
export type WorkerImpastoOptions = Omit<ImpastoOptions, 'signal' | 'onProgress'>;

export type WorkerRequest =
  | { type: 'render' | 'plan'; id: number; image: ImpastoImageSource; options?: WorkerImpastoOptions }
  | { type: 'abort'; id: number };

export type WorkerResponse =
  | { type: 'progress'; id: number; info: ProgressInfo }
  | { type: 'result'; id: number; result: ImpastoResult | ImpastoPlanResult }
  | { type: 'error'; id: number; error: { name: string; message: string; code?: string } };

/** The part of Worker / MessagePort / a worker's global scope used here. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  start?(): void;
}

/** Answers WorkerRequests arriving on `port`. */
export function serveImpasto(port: MessagePortLike): void {
  const running = new Map<number, AbortController>();
  port.addEventListener('message', (e) => {
    const req = e.data as WorkerRequest;
    if (!req || typeof req !== 'object' || typeof req.id !== 'number') return;
    if (req.type === 'abort') { running.get(req.id)?.abort(); return; }
    if (req.type !== 'render' && req.type !== 'plan') return;
    const ac = new AbortController();
    running.set(req.id, ac);
    const options: ImpastoOptions = { ...req.options, signal: ac.signal, onProgress: (info) => port.postMessage({ type: 'progress', id: req.id, info } satisfies WorkerResponse) };
    const job: Promise<ImpastoResult | ImpastoPlanResult> = req.type === 'render' ? renderImpasto(req.image, options) : planImpasto(req.image, options);
    job.then((result) => {
      const transfer = 'image' in result ? [result.image.data.buffer, result.surface.height.buffer, result.surface.color.buffer] as ArrayBuffer[] : [];
      port.postMessage({ type: 'result', id: req.id, result } satisfies WorkerResponse, transfer);
    }, (err: unknown) => {
      const x = err as { name?: unknown; message?: unknown; code?: unknown };
      port.postMessage({ type: 'error', id: req.id, error: { name: String(x?.name ?? 'Error'), message: String(x?.message ?? err), code: typeof x?.code === 'string' ? x.code : undefined } } satisfies WorkerResponse);
    }).finally(() => running.delete(req.id));
  });
  port.start?.();
}

// In a dedicated or shared worker, serve on the worker's own scope. Elsewhere (Node, the page)
// importing this module does nothing.
const WGS = (globalThis as Record<string, unknown>).WorkerGlobalScope;
if (typeof WGS === 'function' && globalThis instanceof (WGS as new () => object)) serveImpasto(globalThis as unknown as MessagePortLike);
