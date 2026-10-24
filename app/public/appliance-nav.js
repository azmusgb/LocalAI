/**
 * LocalAI Appliance Suite - Universal Navigation Bar
 * <appliance-nav current="hub|terminal|materials"></appliance-nav>
 *
 * Lightweight, zero-dependency Web Component for seamless 1-click transit
 * across LocalAI Hub, LocalAI Terminal (Workshop OS), and LocalAI Materials (Filament Inventory).
 * Its styles are in app.css ("Suite bar"): the hub loads one stylesheet and injects none.
 */
class ApplianceNav extends HTMLElement {
  static get observedAttributes() {
    return ['current', 'hub-url', 'terminal-url', 'materials-url'];
  }

  attributeChangedCallback() {
    this.render();
  }

  // The host is the landmark, so the brand and status sit inside it for screen readers.
  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'navigation');
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'LocalAI apps');
    this.render();
    this.checkHealth();
  }

  playChime(kind = 'done') {
    ApplianceSound.play(kind);
  }

  // Where each app lives. The hub is this appliance (Caddy on 443, also over Tailscale); port 3080 answers on
  // the Windows host only, so it is never linked. Materials is the hosted PWA; Terminal is the workshop display.
  static get homes() {
    return {
      hub: 'https://10.0.0.21/',
      terminal: 'http://10.0.0.124/',
      materials: 'https://filamentinventory.netlify.app/',
    };
  }

  get currentApp() {
    const attr = this.getAttribute('current');
    if (attr) return attr.toLowerCase();
    const host = window.location.hostname;
    if (host === '10.0.0.124' || host.includes('workshop') || host.includes('bambuhelper')) return 'terminal';
    if (host.includes('filamentinventory') || window.location.pathname.startsWith('/materials')) return 'materials';
    return 'hub';
  }

  // The app you're in links to its own root, so the hub works the same on the LAN and over Tailscale.
  linkFor(app) {
    return this.getAttribute(`${app}-url`) || (this.currentApp === app ? '/' : ApplianceNav.homes[app]);
  }

  get hubUrl() { return this.linkFor('hub'); }

  get terminalUrl() { return this.linkFor('terminal'); }

  get materialsUrl() { return this.linkFor('materials'); }

  // Only the hub has a health check to ask; the other apps show no status rather than a guess.
  async checkHealth() {
    const dot = this.querySelector('#an-lan-dot');
    const label = this.querySelector('#an-lan-label');
    if (!dot || !label) return;
    if (this.currentApp !== 'hub') {
      dot.parentElement.style.display = "none";
      return;
    }
    const res = await fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(2500) }).catch(() => null);
    const ok = Boolean(res && res.ok);
    dot.className = ok ? 'an-dot an-online' : 'an-dot an-standby';
    label.textContent = ok ? 'Online' : 'Not answering';
  }

  render() {
    const cur = this.currentApp;
    this.innerHTML = `

      <div class="an-bar">
        <div class="an-brand-section">
          <div class="an-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
              <path d="M5 12c2.6-5.6 11.4-5.6 14 0-2.6 5.6-11.4 5.6-14 0Z" stroke="#04111f" stroke-width="2.2"/>
              <circle cx="12" cy="12" r="2.2" fill="#04111f"/>
            </svg>
          </div>
          <div class="an-brand-title">
            <span>LocalAI</span>
            <span class="an-brand-pill">Suite</span>
          </div>
        </div>

        <div class="an-links">
          <a href="${this.hubUrl}" class="an-nav-item ${cur === 'hub' ? 'an-active' : ''}" id="an-link-hub">
            <svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z"/></svg>
            <span>Hub</span>
          </a>

          <a href="${this.terminalUrl}" class="an-nav-item ${cur === 'terminal' ? 'an-active' : ''}" id="an-link-terminal">
            <svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5"/><path d="M13 15h4"/></svg>
            <span>Terminal</span>
          </a>

          <a href="${this.materialsUrl}" class="an-nav-item ${cur === 'materials' ? 'an-active' : ''}" id="an-link-materials">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v5M12 16v5"/></svg>
            <span>Materials</span>
          </a>
        </div>

        <div class="an-status-section">
          <span class="an-dot an-standby" id="an-lan-dot"></span>
          <span id="an-lan-label">Checking…</span>
        </div>
      </div>
    `;
  }
}

if (!customElements.get('appliance-nav')) {
  customElements.define('appliance-nav', ApplianceNav);
}

/**
 * Universal Acoustic Alert Synthesizer
 * Harmonized with LocalAI Terminal ESP32 piezo tones (C5-E5-G5 success, A4-E5 notice, F5-C#5 error)
 */
let _applianceAudioCtx = null;
const ApplianceSound = {
  play(kind = 'done') {
    try {
      if (!_applianceAudioCtx) _applianceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_applianceAudioCtx.state === 'suspended') _applianceAudioCtx.resume();
      const t = _applianceAudioCtx.currentTime;
      let notes = [523.25, 659.25, 783.99]; // done / complete: C5 -> E5 -> G5
      let step = 0.12, decay = 0.45;

      if (kind === 'notice' || kind === 'info') {
        notes = [440.00, 659.25]; // A4 -> E5 rising fifth
        step = 0.14; decay = 0.40;
      } else if (kind === 'attention' || kind === 'warning') {
        notes = [659.25, 440.00]; // E5 -> A4 falling fifth
        step = 0.14; decay = 0.40;
      } else if (kind === 'error' || kind === 'bad') {
        notes = [698.46, 554.37]; // F5 -> C#5 descending tritone/minor third
        step = 0.16; decay = 0.50;
      }

      notes.forEach((freq, idx) => {
        const osc = _applianceAudioCtx.createOscillator();
        const gain = _applianceAudioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t + idx * step);
        gain.gain.setValueAtTime(0, t + idx * step);
        gain.gain.linearRampToValueAtTime(0.12, t + idx * step + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + idx * step + decay);
        osc.connect(gain);
        gain.connect(_applianceAudioCtx.destination);
        osc.start(t + idx * step);
        osc.stop(t + idx * step + decay + 0.05);
      });
    } catch {}
  }
};

if (typeof window !== 'undefined') {
  window.ApplianceSound = ApplianceSound;
  window.LocalAISound = ApplianceSound;
}

