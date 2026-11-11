/* Art + metadata storage: relay (server-held Pinata key), the user's own Pinata key, or Irys/Arweave signed by the launcher's wallet. */

export async function pinViaProxy(meta, file, config) {
  const fd = new FormData(); fd.append("file", file, file.name); Object.entries(meta).forEach(([k, v]) => fd.append(k, v ?? ""));
  const r = await fetch(config.uploadProxy.replace(/\/$/, "") + "/pin", { method: "POST", body: fd });
  if (!r.ok) throw new Error("Relay refused the upload (" + r.status + ")");
  const j = await r.json(); if (!j.metadataUri) throw new Error("Relay returned no metadata URI"); return j.metadataUri;
}

export async function pinViaPinata(meta, file, jwt, config) {
  const h = { Authorization: "Bearer " + jwt };
  const fd = new FormData(); fd.append("file", file, file.name); fd.append("pinataMetadata", JSON.stringify({ name: meta.symbol + "-image" }));
  let r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: h, body: fd });
  if (!r.ok) throw new Error("Pinata rejected the image (" + r.status + "). Check the key.");
  const img = await r.json();
  const json = { name: meta.name, symbol: meta.symbol, description: meta.description, image: config.gateway + img.IpfsHash, showName: true, createdOn: "https://pump.fun" };
  if (meta.twitter) json.twitter = meta.twitter; if (meta.telegram) json.telegram = meta.telegram; if (meta.website) json.website = meta.website;
  r = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ pinataContent: json, pinataMetadata: { name: meta.symbol + "-metadata" } }) });
  if (!r.ok) throw new Error("Pinata rejected the metadata (" + r.status + ")");
  const m = await r.json(); return config.gateway + m.IpfsHash;
}

/* ---------- permanent storage via Irys (default route, no keys) ---------- */
let irysLoading = null;
export function loadIrys(config) {
  if (window.IrysWeb) return Promise.resolve();
  if (!irysLoading) irysLoading = new Promise((res, rej) => { const s = document.createElement("script"); s.src = config.irysBundle; s.onload = res; s.onerror = () => rej(new Error("Could not load the storage client")); document.head.appendChild(s); });
  return irysLoading;
}

export function walletForIrys(wallet, pubkey) {
  return {
    publicKey: pubkey,
    signMessage: async (m) => { const r = await wallet.signMessage(m); return r && r.signature ? r.signature : r; },
    sendTransaction: async (tx, conn, opts) => { if (wallet.signAndSendTransaction) { const r = await wallet.signAndSendTransaction(tx, opts); return r.signature || r; } const s = await wallet.signTransaction(tx); return await conn.sendRawTransaction(s.serialize(), opts); },
  };
}

/* shrink stills under the free tier (100 KiB): resize then step the JPEG quality down; keep PNG when it already fits */
export async function shrinkForUpload(file, limit = 95 * 1024) {
  if (file.size <= limit || file.type === "image/gif") return file;
  const bmp = await createImageBitmap(file);
  let s = Math.min(bmp.width, bmp.height, 512);
  for (let round = 0; round < 6; round++) {
    const cv = document.createElement("canvas"); cv.width = s; cv.height = s;
    const src = Math.min(bmp.width, bmp.height); cv.getContext("2d").drawImage(bmp, (bmp.width - src) / 2, (bmp.height - src) / 2, src, src, 0, 0, s, s);
    for (const q of [0.92, 0.85, 0.78, 0.7, 0.6]) {
      const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", q));
      if (blob.size <= limit) return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    }
    s = Math.round(s * 0.8);
  }
  throw new Error("Could not get the image under 100 KB. Try a simpler image.");
}

export async function pinViaIrys(meta, file, onStatus, { wallet, pubkey, config }) {
  onStatus("Loading storage client…"); await loadIrys(config);
  const { WebUploader, WebSolana } = window.IrysWeb;
  const irys = await WebUploader(WebSolana).withProvider(walletForIrys(wallet, pubkey)).withRpc(config.rpcs[0]).mainnet();
  onStatus("Preparing the art…"); const img = await shrinkForUpload(file);
  const bytes = img.size + 600;
  if (bytes > 100 * 1024) { const price = await irys.getPrice(bytes); const bal = await irys.getBalance(); if (bal.lt(price)) { onStatus("Funding storage (tiny SOL amount, approve in wallet)…"); await irys.fund(price.multipliedBy(1.2).integerValue()); } }
  onStatus("Sign the storage message in your wallet…");
  const up = await irys.uploadFile(img, { tags: [{ name: "Content-Type", value: img.type }, { name: "App-Name", value: "HOCK" }] });
  const imageUrl = config.irysGateway + up.id;
  const json = { name: meta.name, symbol: meta.symbol, description: meta.description, image: imageUrl, showName: true, createdOn: "https://pump.fun" };
  if (meta.twitter) json.twitter = meta.twitter; if (meta.telegram) json.telegram = meta.telegram; if (meta.website) json.website = meta.website;
  onStatus("Storing metadata…");
  const up2 = await irys.upload(JSON.stringify(json), { tags: [{ name: "Content-Type", value: "application/json" }, { name: "App-Name", value: "HOCK" }] });
  return { uri: config.irysGateway + up2.id, image: imageUrl };
}
