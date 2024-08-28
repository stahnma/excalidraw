import loadWoff2 from "../wasm/woff2.loader";
import loadHbSubset from "../wasm/hb-subset.loader";

// TODO: it's not super clear which of these is shared between threads and which one is isomoprhic from the browser / node perspective

/**
 * Shared code between the main thread and the worker.
 */
export const Commands = {
  Init: "INIT",
  Subset: "SUBSET",
} as const;

/**
 * Used by browser and node to subset the font based on the passed codepoints.
 */
export const subsetToBase64 = async (
  arrayBuffer: ArrayBuffer,
  codePoints: Array<number>,
): Promise<string> => {
  try {
    const buffer = await subsetToBinary(arrayBuffer, codePoints);
    return toBase64(buffer);
  } catch (e) {
    console.error("Skipped glyph subsetting", e);
    // Fallback to encoding whole font in case of errors
    return toBase64(arrayBuffer);
  }
};

/**
 * Used by both browser, node and the worker to subset the font based on the passed codepoints.
 * Accepting and returning ArrayBuffer to avoid copying large strings between workers and main thread.
 */
export const subsetToBinary = async (
  arrayBuffer: ArrayBuffer,
  codePoints: Array<number>,
): Promise<ArrayBuffer> => {
  // lazy loaded wasm modules to avoid multiple initializations in case of concurrent triggers
  // NOTE: could be expensive in case of being loaded as part of each new worker instance, so we need to keep the # of workes small
  const { compress, decompress } = await loadWoff2();
  const { subset } = await loadHbSubset();

  const decompressedBinary = decompress(arrayBuffer).buffer;
  const subsetSnft = subset(decompressedBinary, new Set(codePoints));
  const compressedBinary = compress(subsetSnft.buffer);

  return compressedBinary.buffer;
};

/**
 * Utility for both node and browser usage.
 * Isn't used inside the worker as we would like to avoid copying large binary strings (as dataurl) between workers and main thread.
 */
export const toBase64 = async (arrayBuffer: ArrayBuffer) => {
  let base64: string;

  if (typeof Buffer !== "undefined") {
    // node & server-side
    base64 = Buffer.from(arrayBuffer).toString("base64");
  } else {
    // browser - it's perfectly fine to treat each byte independently as we care only about turning individual bytes into codepoints, not about multi-byte unicode characters
    const byteString = String.fromCharCode(...new Uint8Array(arrayBuffer));
    base64 = btoa(byteString);
  }

  return `data:font/woff2;base64,${base64}`;
};
