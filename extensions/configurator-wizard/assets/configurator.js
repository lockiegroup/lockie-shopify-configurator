/**
 * Lockie Church configurator wizard — bootstrap.
 *
 * Stage 0: read the product's custom.config/price_table/addon_fees metafields
 * (injected server-side by the block as inline JSON, no extra network call)
 * and expose them for verification. Stage 1 replaces the stub below with the
 * actual step renderer.
 */
(function () {
  function readJSON(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      console.error("[lockie-configurator] failed to parse " + id, err);
      return null;
    }
  }

  function init(root) {
    var data = {
      config: readJSON(root.dataset.configId),
      priceTable: readJSON(root.dataset.priceTableId),
      addonFees: readJSON(root.dataset.addonFeesId),
    };

    window.__lockieConfigurator = window.__lockieConfigurator || {};
    window.__lockieConfigurator[root.dataset.blockId] = data;

    console.log("[lockie-configurator] block " + root.dataset.blockId + " loaded metafields:", data);
  }

  document.querySelectorAll("[data-lockie-configurator]").forEach(init);
})();
