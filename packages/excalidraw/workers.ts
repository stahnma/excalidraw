import { debounce } from "./utils";

type InitializeWorker = (worker: Worker) => void;

class IdleWorker extends Worker {
  constructor(workerUrl: URL) {
    super(workerUrl, { type: "module" });
  }

  /** use to prolong the worker's life or terminate it with a flush immediately */
  public resetTTL!: ReturnType<typeof debounce>;
}

/**
 * Pool of idle short-lived workers.
 *
 * IMPORTANT: for simplicity it does not limit the number of newly created workers, leaving it up to the caller to manage the pool size.
 */
export class WorkerPool<T, R> {
  private idleWorkers: Set<IdleWorker> = new Set();
  private readonly workerUrl: URL;
  private readonly workerTTL: number;

  private readonly initWorker: InitializeWorker;

  constructor(
    workerUrl: URL,
    options: {
      initWorker: InitializeWorker;
      ttl?: number;
    },
  ) {
    this.workerUrl = workerUrl;
    // by default, active & idle workers will be terminated after 10 seconds of inactivity
    this.workerTTL = options.ttl || 10_000;

    this.initWorker = options.initWorker;
  }

  public async postMessage(
    data: T,
    options: StructuredSerializeOptions,
  ): Promise<R> {
    let worker: IdleWorker;

    const idleWorker = Array.from(this.idleWorkers).shift();
    if (idleWorker) {
      this.idleWorkers.delete(idleWorker);
      worker = idleWorker;
    } else {
      worker = await this.createWorker();
    }

    return new Promise((resolve, reject) => {
      worker.onmessage = this.onMessageHandler(worker, resolve);
      worker.onerror = this.onErrorHandler(worker, reject);

      worker.postMessage(data, options);
      worker.resetTTL(reject);
    });
  }

  public async clear() {
    for (const worker of this.idleWorkers) {
      worker.resetTTL.cancel();
      worker.terminate();
    }

    this.idleWorkers.clear();
  }

  /**
   * Used to get a worker from the pool or create a new one if there is no idle available.
   */
  private async createWorker(): Promise<IdleWorker> {
    const worker = new IdleWorker(this.workerUrl);

    worker.resetTTL = debounce((reject?: (reason?: unknown) => void) => {
      worker.terminate();

      if (this.idleWorkers.has(worker)) {
        this.idleWorkers.delete(worker);

        // eslint-disable-next-line no-console
        console.debug("Idle worker has been released from the pool.");
      } else if (reject) {
        reject("Active worker's time-to-live expired!");
      }
    }, this.workerTTL);

    this.initWorker(worker);

    return worker;
  }

  private onMessageHandler(worker: IdleWorker, resolve: (value: R) => void) {
    return (e: { data: R }) => {
      worker.resetTTL();
      this.idleWorkers.add(worker);
      resolve(e.data);
    };
  }

  private onErrorHandler(
    worker: IdleWorker,
    reject: (reason?: unknown) => void,
  ) {
    return (e: ErrorEvent) => {
      worker.resetTTL.flush();
      reject(e);
    };
  }
}
