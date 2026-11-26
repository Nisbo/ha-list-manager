(() => {
  if (globalThis.HaListManagerQrEncoder) return;
  let loading;
  function load() {
    if (globalThis.QRCode) return Promise.resolve();
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = new URL("./qrcode.min.js", import.meta.url).href;
        script.onload = resolve;
        script.onerror = () => {
          script.remove();
          loading = null;
          reject(new Error("QR encoder could not be loaded"));
        };
        document.head.append(script);
      });
    }
    return loading;
  }
  globalThis.HaListManagerQrEncoder = { load };
})();
