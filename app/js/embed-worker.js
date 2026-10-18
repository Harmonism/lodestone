// embed-worker.js — embeds the practitioner's question on-device with the same
// multilingual-e5-small model that embedded the corpus. Runs off the UI thread.
import { pipeline, env } from "../vendor/transformers.min.js";

const MODEL = "Xenova/multilingual-e5-small";

// The retrieval model ships inside the pack, at vendor/models/. It used to be
// fetched from huggingface.co at setup, which made an app whose whole claim is
// owned substrate depend on a third party at the one moment a practitioner is
// least able to diagnose it — and left the app silently keyword-only wherever
// that host is slow, blocked or down. allowRemoteModels = false makes the
// dependency impossible rather than merely unlikely: if the local files are
// missing the load fails loudly instead of reaching out.
env.allowLocalModels = true;
env.allowRemoteModels = false;
// A path, not a full URL. transformers.js classifies an absolute http(s)
// localModelPath as remote, skips the local fetch entirely and goes to
// huggingface.co — which, with allowRemoteModels = false, fails at the tokenizer
// while the weights still load. The pipeline then exists with a non-callable
// tokenizer, so loading looks successful and every embed throws.
env.localModelPath = new URL("../vendor/models/", import.meta.url).pathname;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

let extractor = null;

async function init(progress) {
  if (extractor) return;
  extractor = await pipeline("feature-extraction", MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: p => {
      if (progress && p.status === "progress" && p.total) postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
    },
  });
  // Loading is not the same as working. A pipeline whose tokenizer failed to
  // resolve is returned intact, with `tokenizer` a plain object rather than a
  // callable, and only throws on the first embed — by which time the app has
  // already reported deep retrieval ready and is quietly keyword-only. One real
  // embed here turns that into a failure at setup, where it is visible.
  const probe = await extractor("query: test", { pooling: "mean", normalize: true });
  if (!probe?.data?.length) throw new Error("the retrieval model loaded but produced no vector");
}

onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      await init(true);
      postMessage({ type: "ready" });
    } else if (data.type === "embed") {
      await init(false);
      const out = await extractor("query: " + data.text, { pooling: "mean", normalize: true });
      postMessage({ type: "vec", id: data.id, vec: out.data }, [out.data.buffer]);
    }
  } catch (e) {
    postMessage({ type: "error", id: data.id, error: String(e && e.message || e) });
  }
};
