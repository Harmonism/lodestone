// llm-worker.js — hosts the WebLLM engine off the UI thread (WebGPU inference on this device).
import { WebWorkerMLCEngineHandler } from "../vendor/web-llm.js";
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = msg => handler.onmessage(msg);
