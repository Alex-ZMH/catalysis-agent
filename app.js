(() => {
  const showcase = document.getElementById('showcase');
  const studio = document.getElementById('studio');
  const assistant = window.CatalysisWorkbench.mount(studio);
  let cases;
  let displayingStudio = false;
  function updateRoute() {
    const inStudio = location.hash === '#studio';
    showcase.hidden = inStudio;
    studio.hidden = !inStudio;
    document.title = inStudio ? '催化研究 Studio · 研究助手' : '催化研究 Studio · 从催化位点到工程设备';
    document.body.classList.toggle('studio-open', inStudio);
    document.querySelector('.skip-link').setAttribute('href', inStudio ? '#studio' : '#main');
    if (inStudio !== displayingStudio) {
      if (inStudio) {
        window.scrollTo(0, 0);
        assistant.enter();
      } else {
        assistant.leave();
      }
      displayingStudio = inStudio;
    }
    if (!inStudio && location.hash === '#home') window.scrollTo(0, 0);
  }
  function openDraft(text = '') {
    if (location.hash !== '#studio') location.hash = 'studio';
    updateRoute();
    assistant.prefill(text);
  }
  function selectCase(id, focusTab = false) {
    cases?.select(id);
    if (focusTab) document.querySelector('#cases [data-scale][aria-pressed="true"], #cases [role="tab"][aria-selected="true"]')?.focus({preventScroll:true});
  }
  window.CatalysisShowcase.mount(showcase, {openDraft, selectCase});
  cases = window.CatalysisCases.mount(document.getElementById('cases'), {openDraft});
  window.CatalysisLab.mount(document.getElementById('parameters'), {openDraft});
  showcase.addEventListener('click', event => {
    const link = event.target.closest('a[href="#studio"]');
    if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openDraft();
  });
  window.addEventListener('hashchange', updateRoute);
  updateRoute();
})();
