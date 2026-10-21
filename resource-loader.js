(() => {
  const scriptLoads = new Map();

  window.loadExternalScript = (src) => {
    if (scriptLoads.has(src)) return scriptLoads.get(src);

    const existingScript = document.querySelector(`script[src="${src}"]`);
    if (existingScript && existingScript.dataset.loaded === 'true') {
      return Promise.resolve();
    }

    const script = existingScript || document.createElement('script');
    const loadPromise = new Promise((resolve, reject) => {
      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', () => {
        scriptLoads.delete(src);
        script.remove();
        reject(new Error(`Failed to load required script: ${src}`));
      }, { once: true });
    });

    scriptLoads.set(src, loadPromise);
    if (!existingScript) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
    return loadPromise;
  };
})();
