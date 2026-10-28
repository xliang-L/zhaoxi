/* Presentation only. Existing domain requests and confirmation handlers stay inline. */
(() => {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  function showPanel(name, updateHash = false) {
    if (!tabs.some(tab => tab.dataset.tab === name)) name = 'plans';
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    }
    if (updateHash) history.replaceState(null, '', '#' + name);
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => showPanel(tab.dataset.tab, true));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab);
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      showPanel(tabs[next].dataset.tab, true);
      tabs[next].focus();
    });
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-open-plan]')) return;
    showPanel('plans', true);
    resetPlan();
    const editor = document.getElementById('plan-editor');
    editor.open = true;
    editor.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    requestAnimationFrame(() => document.querySelector('#plan-form [name="title"]').focus({ preventScroll: true }));
  });
  window.addEventListener('hashchange', () => showPanel(location.hash.slice(1)));
  showPanel(location.hash.slice(1));
})();
