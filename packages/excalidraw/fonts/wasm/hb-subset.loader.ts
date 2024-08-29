import binary from "./hb-subset.wasm";
import bindings from "./hb-subset.bindings";

/**
 * Lazy loads wasm and respective bindings for font subsetting based on the harfbuzzjs.
 */
let loadedWasm: ReturnType<typeof load> | null = null;

// TODO: consider adding support for fetching the wasm from an URL (external CDN, data URL, etc.)
const load = (): Promise<{
  subset: (
    fontBuffer: ArrayBuffer,
    codePoints: ReadonlySet<number>,
  ) => Uint8Array;
}> => {
  return new Promise(async (resolve, reject) => {
    try {
      WebAssembly.instantiate(binary).then((module) => {
        const harfbuzzJsWasm = module.instance.exports;
        // @ts-expect-error since `.buffer` is custom prop
        const heapu8 = new Uint8Array(harfbuzzJsWasm.memory.buffer);

        const hbSubset = {
          subset: (
            fontBuffer: ArrayBuffer,
            codePoints: ReadonlySet<number>,
          ) => {
            return bindings.subset(
              harfbuzzJsWasm,
              heapu8,
              fontBuffer,
              codePoints,
            );
          },
        };

        resolve(hbSubset);
      });
    } catch (e) {
      reject(e);
    }
  });
};

// lazy load the default export
export default (): ReturnType<typeof load> => {
  if (!loadedWasm) {
    loadedWasm = load();
  }

  return loadedWasm;
};
