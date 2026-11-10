// Presentation-only navigation. Existing session, capture and recording code is untouched.
(() => {
  const consoleEl = document.querySelector('#liveConsole');
  const body = consoleEl?.querySelector('.lv-body');
  if (!body) return;
  const groups = {
    host: [
      ['Stage', ['lv-ai-producer','lv-audience']],
      ['Script', ['lv-run-of-show','lv-prep','lv-teleprompter']],
      ['Audio', ['lv-audio']]
    ],
    producer: [
      ['Session', ['lv-record','lv-show-actions']],
      ['Guests', ['lv-sources']],
      ['Scenes', ['lv-scenes']],
      ['Graphics', ['lv-graphics','lv-end-card']],
      ['Audio', ['lv-audio']],
      ['Tools', ['lv-ai-producer-pane','lv-focus-brief','lv-post-production','lv-run-of-show']]
    ]
  };
  const panels = [...body.querySelectorAll('.lv-panel')].filter(el => !el.classList.contains('lv-program'));
  const nav = document.createElement('nav');
  nav.className = 'studio-clean-tabs';
  nav.setAttribute('aria-label','Workspace sections');
  const stage = body.querySelector('.lv-program');
  stage?.insertAdjacentElement('afterend', nav);
  const selection = {host:'Stage',producer:'Session'};
  let role = '';
  function render() {
    const nextRole = consoleEl.dataset.lvView === 'producer' ? 'producer' : 'host';
    if (nextRole !== role) { role = nextRole; nav.replaceChildren(); }
    const entries = groups[role];
    if (!entries.some(([name]) => name === selection[role])) selection[role] = entries[0][0];
    nav.replaceChildren(...entries.map(([name]) => {
      const button = document.createElement('button');
      button.type='button'; button.textContent=name;
      button.className='studio-clean-tab';
      button.setAttribute('aria-current',String(selection[role]===name));
      button.addEventListener('click',()=>{selection[role]=name;render();});
      return button;
    }));
    const visible = new Set(entries.find(([name])=>name===selection[role])[1]);
    panels.forEach(panel=>{
      const mapped = Object.values(groups).flat().some(([,classes])=>classes.some(cls=>panel.classList.contains(cls)));
      if (mapped) panel.classList.toggle('studio-clean-inactive', ![...visible].some(cls=>panel.classList.contains(cls)));
    });
  }
  const observer = new MutationObserver(()=>{if(consoleEl.dataset.lvView!==role)render();});
  observer.observe(consoleEl,{attributes:true,attributeFilter:['data-lv-view']});
  render();
})();
