import { WorkerPool } from "../../workers";
import type { Commands } from "./subset.shared";

let subsetWorker: Promise<typeof import("./subset.worker")> | null = null;
let subsetShared: Promise<typeof import("./subset.shared")> | null = null;

const loadWorkerSubsetChunk = async () => {
  if (!subsetWorker) {
    subsetWorker = import("./subset.worker");
  }

  return subsetWorker;
};

const loadSharedSubsetChunk = async () => {
  if (!subsetShared) {
    // load dynamically to force create a shared chunk between main thread and the worker thread
    subsetShared = import("./subset.shared");
  }

  return subsetShared;
};

// TODO: could be extended with multiple commands in the future
type WorkerData = { command: typeof Commands.Subset; arrayBuffer: ArrayBuffer };

type WorkerResult<T extends WorkerData["command"]> =
  T extends typeof Commands.Subset ? ArrayBuffer : never;

let workerPool: Promise<
  WorkerPool<WorkerData, WorkerResult<WorkerData["command"]>>
> | null = null;

const getWorkerPool = (codePoints: Array<number>) => {
  if (!workerPool) {
    // immediately return to be concurrency-friendly and have really only one pool instance
    workerPool = new Promise(async (resolve, reject) => {
      try {
        const { WorkerUrl } = await loadWorkerSubsetChunk();
        const { Commands } = await loadSharedSubsetChunk();

        const pool = new WorkerPool<
          WorkerData,
          WorkerResult<WorkerData["command"]>
        >(WorkerUrl, {
          initWorker: (worker: Worker) => {
            // initialize the newly create worker with codepoints
            worker.postMessage({ command: Commands.Init, codePoints });
          },
        });

        resolve(pool);
      } catch (e) {
        // we failed during worker pool initialization, fallback to main thread
        shouldUseWorkers = false;
        reject(e);
      }
    });
  }

  return workerPool;
};

let shouldUseWorkers = typeof Worker !== "undefined";

export const subsetWoff2GlyphsByCodepoints = async (
  arrayBuffer: ArrayBuffer,
  codePoints: Array<number>,
): Promise<string> => {
  const { Commands, subsetToBase64, toBase64 } = await loadSharedSubsetChunk();

  if (shouldUseWorkers) {
    return new Promise(async (resolve) => {
      try {
        const workerPool = await getWorkerPool(codePoints);
        const result = await workerPool.postMessage(
          {
            command: Commands.Subset,
            arrayBuffer,
          } as const,
          { transfer: [arrayBuffer] },
        );

        resolve(toBase64(result));
      } catch (e) {
        // don't use workers if they are failing
        shouldUseWorkers = false;
        console.error(e);

        // fallback to the main thread
        resolve(subsetToBase64(arrayBuffer, codePoints));
      }
    });
  }

  return subsetToBase64(arrayBuffer, codePoints);
};
