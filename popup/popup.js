const status = document.getElementById('status');
async function currentTab(){ return (await chrome.tabs.query({active:true,currentWindow:true}))[0]; }
async function refresh(){
  const t=await currentTab();
  if(!t?.id){status.textContent='Nenhuma guia ativa.';return;}
  try {
    const xs=await chrome.tabCapture.getCapturedTabs();
    const c=xs.find(x=>x.tabId===t.id);
    status.innerHTML=c?.status==='active' ? '<b>ATIVO</b><br>Gravação contínua em andamento.' : c?.status==='pending' ? '<b>PENDENTE</b><br>Aguardando ativação do Chrome.' : 'Parado.';
  } catch(e){ status.textContent='Pronto.'; }
}
document.getElementById('start').onclick=async()=>{
  status.textContent='Iniciando captura...';
  try {
    const t=await currentTab();
    const r=await chrome.runtime.sendMessage({type:'START_RECORDING',tabId:t.id});
    if(!r?.ok) throw Error(r?.error||'Falha ao iniciar');
    status.innerHTML='<b>ATIVO</b><br>Gravação contínua iniciada. Você pode sair da frente do computador.';
  } catch(e){ status.textContent='ERRO: '+e.message; }
};
document.getElementById('stop').onclick=async()=>{
  status.textContent='Finalizando e salvando o último segmento...';
  try {
    const t=await currentTab();
    const r=await chrome.runtime.sendMessage({type:'STOP_RECORDING',tabId:t.id});
    if(!r?.ok) throw Error(r?.error||'Falha ao finalizar');
    status.textContent=r.saved ? `Finalizado: ${r.name}. A conversão para MP3 será feita automaticamente.` : 'Finalizado, mas não havia segmento para salvar.';
  } catch(e){ status.textContent='ERRO AO SALVAR: '+e.message; }
};
refresh();

async function showLogs(){
  const {logs=[]}=await chrome.storage.local.get('logs');
  const el=document.getElementById('logs');
  el.textContent=logs.map(l=>new Date(l.t).toLocaleTimeString()+' ['+l.src+'] '+l.msg).join('\n')||'(sem eventos)';
  el.scrollTop=el.scrollHeight;
}
document.getElementById('clear').onclick=async e=>{e.preventDefault();await chrome.storage.local.set({logs:[]});showLogs();};
showLogs(); setInterval(showLogs,1500);
