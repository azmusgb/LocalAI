(() => {
  'use strict';

  // The appliance proxies the host bridge, so the bridge port never has to be open to the network.
  const BRIDGE = '/api/gridcraft';
  const $ = id => document.getElementById(id);
  const status = $('status');
  const prompt = $('prompt');
  const run = $('run');
  const result = $('result');
  const duration = $('duration');

  function setStatus(state, text) {
    status.className = `status ${state}`;
    status.textContent = text;
  }

  async function health() {
    setStatus('checking', 'Checking bridge…');
    try {
      const r = await fetch(`${BRIDGE}/health`, { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const suffix = data.gridcraftConnected ? 'GridCraft ready' : 'Bridge ready · GridCraft starting';
      setStatus(data.gridcraftConnected ? 'healthy' : 'checking', suffix);
      return data;
    } catch (e) {
      setStatus('down', 'GridCraft bridge offline');
      result.textContent = `Bridge unavailable at ${BRIDGE}\n\n${e.message || e}`;
      return null;
    }
  }

  async function execute() {
    const text = prompt.value.trim();
    if (!text) return;
    run.disabled = true;
    duration.textContent = '';
    result.textContent = 'Running…';
    const started = performance.now();
    try {
      const r = await fetch(`${BRIDGE}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text })
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error([data.error || `HTTP ${r.status}`, data.reason].filter(Boolean).join(': '));
      result.textContent = data.answer || data.stdout || 'Completed.';
      duration.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
      await health();
    } catch (e) {
      result.textContent = `Error: ${e.message || e}\n\nThe request didn't finish. Try again; if it keeps failing, the reason above says why.`;
      // One failed request doesn't mean the bridge is down: show its real state.
      await health();
    } finally {
      run.disabled = false;
    }
  }

  $('refresh').addEventListener('click', health);
  $('example').addEventListener('click', () => {
    prompt.value = 'Inspect the current workbook. Summarize the sheets and used ranges, report any unsaved changes, and save the workbook if needed. Verify the final state before answering.';
    prompt.focus();
  });
  run.addEventListener('click', execute);
  prompt.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') execute();
  });

  health();
})();
