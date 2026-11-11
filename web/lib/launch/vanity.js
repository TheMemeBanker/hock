/* Vanity mint (optional): grind for a base58 key ending in `suffix` across web workers. */
import { Keypair } from "@solana/web3.js";

const WORKER_SRC = `importScripts("https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.0/lib/index.iife.min.js");
let stop=false; onmessage=(e)=>{ if(e.data==="stop"){stop=true;return;} const suffix=e.data; let n=0;
  while(!stop){ const kp=solanaWeb3.Keypair.generate(); n++; if(kp.publicKey.toBase58().endsWith(suffix)){ postMessage({found:Array.from(kp.secretKey),n}); return; } if(n%2000===0) postMessage({n:2000}); } };`;

let cancelCurrent = null;
export function cancelVanity() { if (cancelCurrent) cancelCurrent(); }

export function grindVanity(suffix, onProgress) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" }));
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)); const ws = []; let total = 0, done = false;
    const finish = (kp) => { if (done) return; done = true; ws.forEach(w => { try { w.postMessage("stop"); w.terminate(); } catch (e) {} }); resolve(kp); };
    for (let i = 0; i < n; i++) {
      const w = new Worker(url); ws.push(w);
      w.onmessage = (e) => { if (e.data.found) finish(Keypair.fromSecretKey(Uint8Array.from(e.data.found))); else { total += e.data.n; onProgress(total, n); } };
      w.onerror = () => { finish(null); };
      w.postMessage(suffix);
    }
    cancelCurrent = () => finish(null);
  });
}
