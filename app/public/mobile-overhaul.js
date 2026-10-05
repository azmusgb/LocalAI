(() => {
  'use strict';

  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

  function navigate(view) {
    if (!view) return;
    if (typeof window.showView === 'function') {
      window.showView(view);
      return;
    }
    const button = [...document.querySelectorAll('.navbtn[data-view]')]
      .find((item) => item.dataset.view === view);
    if (button) button.click();
  }

  function loadIntegrationEnhancement() {
    if (!document.querySelector('link[data-localai-integration-v2]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/integration-hub-v2.css';
      link.dataset.localaiIntegrationV2 = 'true';
      document.head.appendChild(link);
    }

    if (!document.querySelector('script[data-localai-integration-v2]')) {
      const script = document.createElement('script');
      script.src = '/integration-hub-v2.js';
      script.defer = true;
      script.dataset.localaiIntegrationV2 = 'true';
      document.head.appendChild(script);
    }
  }

  function installMobileHeader() {
    const main = document.querySelector('main');
    if (!main || main.querySelector('.mobile-header')) return;

    main.id = main.id || 'main-content';

    if (!document.querySelector('.skip-link')) {
      const skip = document.createElement('a');
      skip.className = 'skip-link';
      skip.href = '#main-content';
      skip.textContent = 'Skip to content';
      document.body.prepend(skip);
    }

    const header = document.createElement('div');
    header.className = 'mobile-header';
    header.innerHTML = `
      <div class="mobile-brand" aria-label="Local AI">
        <span class="mobile-brand-mark" aria-hidden="true"></span>
        <span>
          <span class="mobile-brand-name">Local AI</span>
          <span class="mobile-brand-sub">Private Intelligence Hub</span>
        </span>
      </div>
      <button class="pill mobile-health-button" type="button" aria-label="Open system status">
        <span id="mobileHeaderDot" class="dot"></span>
        <span id="mobileHeaderState">Checking…</span>
      </button>`;

    main.prepend(header);
    header.querySelector('.mobile-health-button')?.addEventListener('click', () => navigate('status'));
  }

  function mirrorHealthState() {
    const sourceDot = document.getElementById('homeDot');
    const sourceState = document.getElementById('homeState');
    const targetDot = document.getElementById('mobileHeaderDot');
    const targetState = document.getElementById('mobileHeaderState');
    if (!sourceDot || !targetDot || !targetState) return;

    targetDot.className = sourceDot.className;
    targetState.textContent = sourceState?.textContent || 'Checking…';
  }

  function improveViewportBehavior() {
    document.querySelectorAll('input, textarea').forEach((input) => {
      input.addEventListener('focus', () => {
        if (!isPhone()) return;
        window.setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
      }, { passive: true });
    });

    document.addEventListener('click', (event) => {
      const navButton = event.target.closest?.('.navbtn');
      if (navButton && isPhone()) window.scrollTo({ top: 0, behavior: 'smooth' });
    }, { passive: true });
  }

  function init() {
    loadIntegrationEnhancement();
    installMobileHeader();
    improveViewportBehavior();
    mirrorHealthState();

    const observer = new MutationObserver(mirrorHealthState);
    const state = document.getElementById('homeState');
    if (state) observer.observe(state, { childList: true, characterData: true, subtree: true });

    window.addEventListener('resize', mirrorHealthState, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
