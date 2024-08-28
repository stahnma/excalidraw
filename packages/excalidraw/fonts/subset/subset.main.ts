import { debounce } from "../../utils";

// TODO: whole worker pool could be reused

type WorkerOptions = {
  setIdle: () => void;
  terminateDebounced: ReturnType<typeof debounce>;
};

// any (active / idle) workers will be terminated after 5 seconds of inactivity
const WORKER_TTL = 5_000;

// pool of idle workers waiting to be re-used
const idleWorkerPool = new Map<Worker, WorkerOptions>();

/**
 * Used to get a worker from the pool or create a new one if there is no idle avaialble.
 *
 * NOTE: for simplicity does not limit the number of newly created workers, leaving it up to the caller to manage the pool size (essentially a promise pool).
 */
const getWorkerAsync = async (
  init: (worker: Worker) => void,
): Promise<[Worker, WorkerOptions]> => {
  let nextWorker: [Worker, WorkerOptions] | null = null;

  // map keeps an insertion order, so it's basically a FIFO queue
  const idleWorker = Array.from(idleWorkerPool).shift();

  if (idleWorker) {
    // remove from the pool
    idleWorkerPool.delete(idleWorker[0]);
    nextWorker = idleWorker;
  } else {
    // lazy load our worker chunk
    const { WorkerUrl } = await import("./subset.worker");

    const worker = new Worker(WorkerUrl, { type: "module" });

    // terminate the worker after 5 seconds of inactivity
    const terminateDebounced = debounce(() => {
      worker.terminate();
      idleWorkerPool.delete(worker);
      console.info("Subsetting worker has been terminated due to inactivity!");
    }, WORKER_TTL);

    const setIdle = () => {
      idleWorkerPool.set(worker, {
        terminateDebounced,
        setIdle,
      });
    };

    // init - only the first time
    init(worker);

    nextWorker = [worker, { terminateDebounced, setIdle }];
  }

  return nextWorker;
};

// used to skip using workers in case of errors
let shouldUseWorker = typeof Worker !== "undefined";

let subsetShared: typeof import("./subset.shared") | null = null;

export const subset = async (
  arrayBuffer: ArrayBuffer,
  codePoints: Array<number>,
): Promise<string> => {
  if (!subsetShared) {
    // load dynamically to force create a shared chunk between main thread and the worker thread
    subsetShared = await import("./subset.shared");
  }

  const { Commands, subsetToBase64, toBase64 } = subsetShared;

  if (shouldUseWorker) {
    return new Promise(async (resolve) => {
      const [worker, { terminateDebounced, setIdle }] = await getWorkerAsync(
        (worker: Worker) => {
          // for newly create workers, init just once
          worker.postMessage({
            command: Commands.Init,
            codePoints,
          });
        },
      );

      // fallback to main thread in case of errors
      worker.onerror = (e) => {
        // don't use workers if they are failing
        shouldUseWorker = false;
        console.error(e);
        terminateDebounced.flush();

        // fallback to the main thread
        resolve(subsetToBase64(arrayBuffer, codePoints));
      };

      worker.onmessage = (e: { data: ArrayBuffer }) => {
        // prolong the worker's life
        terminateDebounced();
        setIdle();

        // perform base 64 encoding in the main thread, to avoid copying large strings between workers and main thread
        resolve(toBase64(e.data));
      };

      worker.postMessage(
        {
          command: Commands.Subset,
          arrayBuffer
        },
        // avoids structural clone
        [arrayBuffer],
      );

      // clock is ticking
      terminateDebounced();
    });
  }

  return subsetToBase64(arrayBuffer, codePoints);
};
