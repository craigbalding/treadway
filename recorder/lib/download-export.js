// Export local JSON without opening an OS file chooser. A completed Chrome
// download, rather than merely an allocated download ID, acknowledges the save.
(function (root) {
  'use strict';

  async function save(text, run, options = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(run)) throw new Error('Invalid recording filename');
    const downloads = options.downloads || root.chrome.downloads;
    const urls = options.urls || root.URL;
    const BlobClass = options.BlobClass || root.Blob;
    const url = urls.createObjectURL(new BlobClass([text], { type: 'application/json' }));
    try {
      const id = await downloads.download({ url, filename: 'Treadway/journeys/' + run + '.json',
        saveAs: false, conflictAction: 'overwrite' });
      return await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        function finish(error, item) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          downloads.onChanged.removeListener(changed);
          if (error) reject(error);
          else resolve({ id, filename: item.filename });
        }
        async function inspect() {
          try {
            const [item] = await downloads.search({ id });
            if (!item) return finish(new Error('Download status unavailable; save is unconfirmed'));
            if (item.state === 'complete') finish(null, item);
            else if (item.state === 'interrupted') finish(new Error('Download interrupted: ' + (item.error || 'unknown')));
          } catch (error) { finish(error); }
        }
        function changed(delta) {
          if (delta.id === id && (delta.state || delta.error)) inspect();
        }
        downloads.onChanged.addListener(changed);
        timer = setTimeout(() => finish(new Error('Download outcome unconfirmed; recording retained for Save again')),
          options.timeoutMs || 30000);
        // Covers completion before listener registration, without a lost edge.
        inspect();
      });
    } finally { urls.revokeObjectURL(url); }
  }

  root.TreadwayDownloadExport = { save };
  if (typeof module !== 'undefined' && module.exports) module.exports = { save };
})(typeof globalThis !== 'undefined' ? globalThis : this);
