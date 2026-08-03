/**
 * 抖音下载助手 - WASM 加载器与算法桥接
 */
(function (global) {
  "use strict";

  let wasmInstance = null;
  let wasmLoadingPromise = null;

  async function initWasm() {
    if (wasmInstance) return wasmInstance;
    if (wasmLoadingPromise) return wasmLoadingPromise;

    wasmLoadingPromise = (async () => {
      try {
        let wasmUrl = "build/douyin.wasm";
        if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
          wasmUrl = chrome.runtime.getURL("build/douyin.wasm");
        }

        let bytes;
        if (typeof process !== "undefined" && process.versions && process.versions.node && typeof require === "function") {
          const fs = require("fs");
          const path = require("path");
          const wasmPath = path.resolve(__dirname, "..", "build", "douyin.wasm");
          if (fs.existsSync(wasmPath)) {
            bytes = fs.readFileSync(wasmPath);
          } else {
            const distWasmPath = path.resolve(__dirname, "build", "douyin.wasm");
            bytes = fs.readFileSync(distWasmPath);
          }
        } else {
          const response = await fetch(wasmUrl);
          bytes = await response.arrayBuffer();
        }

        const module = await WebAssembly.instantiate(bytes, {
          env: {
            abort(msg, file, line, col) {
              console.error("[Douyin WASM] Abort called:", { msg, file, line, col });
            }
          }
        });

        wasmInstance = module.instance;
        console.log("[Douyin WASM] 核心 WebAssembly 算法模块成功装载并在沙箱中就绪");
        return wasmInstance;
      } catch (err) {
        console.error("[Douyin WASM] 加载 WASM 核心模块失败:", err);
        throw err;
      }
    })();

    return wasmLoadingPromise;
  }

  // 内存辅助读写机制
  function writeStringToMemory(instance, str, ptr) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str || "");
    const memView = new Uint8Array(instance.exports.memory.buffer);
    memView.set(bytes, ptr);
    return bytes.length;
  }

  function readStringFromMemory(instance, ptr, len) {
    const memView = new Uint8Array(instance.exports.memory.buffer, ptr, len);
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(memView);
  }

  async function isVideoUrl(url) {
    if (!url) return false;
    const instance = await initWasm();
    const { getInBufPtr, isVideoUrlWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const inLen = writeStringToMemory(instance, url, inPtr);
    const res = isVideoUrlWasm(inPtr, inLen);
    return res === 1;
  }

  async function isTargetApi(url) {
    if (!url) return false;
    const instance = await initWasm();
    const { getInBufPtr, isTargetApiWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const inLen = writeStringToMemory(instance, url, inPtr);
    const res = isTargetApiWasm(inPtr, inLen);
    return res === 1;
  }

  async function cleanVideoUrl(url) {
    if (!url) return "";
    const instance = await initWasm();
    const { getInBufPtr, getOutBufPtr, cleanVideoUrlWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const outPtr = getOutBufPtr ? getOutBufPtr() : inPtr + 4096;

    const inLen = writeStringToMemory(instance, url, inPtr);
    const outLen = cleanVideoUrlWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  async function sanitizeFilename(name) {
    const instance = await initWasm();
    const { getInBufPtr, getOutBufPtr, sanitizeFilenameWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const outPtr = getOutBufPtr ? getOutBufPtr() : inPtr + 4096;

    const inLen = writeStringToMemory(instance, name || "", inPtr);
    const outLen = sanitizeFilenameWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  async function buildDownloadPath(type, timestamp, index, ext) {
    const instance = await initWasm();
    const { getInBufPtr, getOutBufPtr, buildDownloadPathWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const outPtr = getOutBufPtr ? getOutBufPtr() : inPtr + 4096;

    const typeLen = writeStringToMemory(instance, type || "video", inPtr);
    const extPtr = inPtr + typeLen + 16;
    const extLen = writeStringToMemory(instance, ext || "", extPtr);

    const tsBigInt = BigInt(timestamp || Date.now());
    const outLen = buildDownloadPathWasm(inPtr, typeLen, tsBigInt, index || 0, extPtr, extLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  global.DouyinWasm = {
    initWasm,
    isVideoUrl,
    isTargetApi,
    cleanVideoUrl,
    sanitizeFilename,
    buildDownloadPath
  };
})(typeof window !== "undefined" ? window : globalThis);
