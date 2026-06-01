/* ============================================================================
   Consilia — shared theme controller + Tweaks panel
   Applies palette / type / density / dark-mode preferences (persisted in
   localStorage so they carry across Reader and Search), and wires the host
   "Tweaks" toolbar protocol so the panel shows on demand.
   ============================================================================ */
(function () {
  const KEY = 'consilia-prefs-v1';
  const DEFAULTS = { palette: 'parchment', type: 'spectral', density: 'balanced', dark: false };
  let panel = null;

  function load() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  let prefs = load();

  function apply() {
    const r = document.documentElement;
    r.dataset.palette = prefs.palette;
    r.dataset.type    = prefs.type;
    r.dataset.density = prefs.density;
    if (prefs.dark) r.dataset.theme = 'dark'; else r.removeAttribute('data-theme');
    syncControls();
    syncThemeToggle();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {} }

  // apply ASAP (before DOMContentLoaded to limit flash)
  apply();

  // ── theme toggle button in the masthead ─────────────────────────────────
  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5z"/></svg>';
  function syncThemeToggle() {
    const b = document.getElementById('theme-toggle');
    if (b) { b.innerHTML = prefs.dark ? SUN : MOON; b.title = prefs.dark ? 'Light mode' : 'Dark reading mode'; }
  }
  function toggleDark() { prefs.dark = !prefs.dark; apply(); save(); }

  // ── Tweaks panel ─────────────────────────────────────────────────────────
  const PALETTES = [
    { id: 'parchment', label: 'Parchment', sw: ['#fbf7ee', '#8a3f2b', '#2b2419'] },
    { id: 'stone',     label: 'Stone',     sw: ['#fbfbf8', '#2c3742', '#23241f'] },
    { id: 'oxblood',   label: 'Oxblood',   sw: ['#fbf6ed', '#6e2733', '#2a2018'] },
  ];
  const TYPES   = [{ id: 'spectral', label: 'Spectral' }, { id: 'garamond', label: 'Garamond' }];
  const DENS    = [{ id: 'compact', label: 'Compact' }, { id: 'balanced', label: 'Balanced' }, { id: 'airy', label: 'Airy' }];

  function buildPanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'tweaks-panel';
    panel.innerHTML = `
      <div class="tw-head">
        <h4>Tweaks</h4>
        <button id="tw-close" title="Close">&#x2715;</button>
      </div>
      <div class="tw-body">
        <div class="tw-group" data-key="palette">
          <label>Palette</label>
          <div class="tw-swatch" id="tw-palette"></div>
        </div>
        <div class="tw-group" data-key="type">
          <label>Type pairing</label>
          <div class="tw-row" id="tw-type"></div>
        </div>
        <div class="tw-group" data-key="density">
          <label>Density</label>
          <div class="tw-row" id="tw-density"></div>
        </div>
        <div class="tw-group" data-key="dark">
          <label>Reading mode</label>
          <div class="tw-row" id="tw-dark"></div>
        </div>
      </div>`;
    document.body.appendChild(panel);

    // palette swatches
    const ps = panel.querySelector('#tw-palette');
    PALETTES.forEach(p => {
      const b = document.createElement('button');
      b.dataset.val = p.id;
      b.title = p.label;
      b.style.background = `linear-gradient(135deg, ${p.sw[0]} 0 45%, ${p.sw[1]} 45% 78%, ${p.sw[2]} 78% 100%)`;
      b.addEventListener('click', () => { prefs.palette = p.id; apply(); save(); });
      ps.appendChild(b);
    });
    // type
    const ts = panel.querySelector('#tw-type');
    TYPES.forEach(t => ts.appendChild(opt(t.label, () => { prefs.type = t.id; apply(); save(); }, 'type', t.id)));
    // density
    const ds = panel.querySelector('#tw-density');
    DENS.forEach(d => ds.appendChild(opt(d.label, () => { prefs.density = d.id; apply(); save(); }, 'density', d.id)));
    // dark
    const ks = panel.querySelector('#tw-dark');
    [['Light', false], ['Dark', true]].forEach(([lbl, val]) =>
      ks.appendChild(opt(lbl, () => { prefs.dark = val; apply(); save(); }, 'dark', val)));

    panel.querySelector('#tw-close').addEventListener('click', dismiss);
    syncControls();
    return panel;
  }
  function opt(label, onClick, key, val) {
    const b = document.createElement('button');
    b.className = 'tw-opt';
    b.textContent = label;
    b.dataset.key = key; b.dataset.val = String(val);
    b.addEventListener('click', onClick);
    return b;
  }
  function syncControls() {
    if (!panel) return;
    panel.querySelectorAll('#tw-palette button').forEach(b =>
      b.classList.toggle('active', b.dataset.val === prefs.palette));
    panel.querySelectorAll('.tw-opt').forEach(b => {
      const k = b.dataset.key;
      b.classList.toggle('active', String(prefs[k]) === b.dataset.val);
    });
  }

  // ── host protocol ─────────────────────────────────────────────────────────
  function openPanel() { buildPanel().classList.add('open'); }
  function closePanel() { if (panel) panel.classList.remove('open'); }
  function dismiss() { closePanel(); try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch (e) {} }

  window.addEventListener('message', (e) => {
    const t = e && e.data && e.data.type;
    if (t === '__activate_edit_mode') openPanel();
    else if (t === '__deactivate_edit_mode') closePanel();
  });

  function boot() {
    syncThemeToggle();
    const tb = document.getElementById('theme-toggle');
    if (tb) tb.addEventListener('click', toggleDark);
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // expose for inline use if needed
  window.ConsiliaTheme = { toggleDark, get prefs() { return prefs; } };
})();
