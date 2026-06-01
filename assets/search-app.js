/* ============================================================================
   Consilia — Search application  (production)
   Keyword (MiniSearch) · Semantic (BGE-M3) · Find similar (cosine)
   --------------------------------------------------------------------------
   Semantic + similar use the real pipeline:
     • output/embeddings.safetensors  (precomputed BGE-M3 vectors, F32 N×1024)
     • output/embeddings_meta.json    (ids / dims / n / model)
     • query embedding via the HuggingFace Inference API (token) OR a local
       ONNX model (transformers.js, Xenova/bge-m3), exactly as the corpus.
   When embeddings.safetensors is absent (e.g. this preview), the app falls
   back to a synthetic projection so the interface stays fully explorable and
   shows a "Preview" notice.  Power-iteration PCA + k-means topic clustering
   drive the semantic map.
   ============================================================================ */

/* ── normalisation + highlight (j=i, v=u, ae=e) ─────────────────────────── */
function normalise(t){ return t.toLowerCase().replace(/æ/g,'e').replace(/ę/g,'e').replace(/ae/g,'e').replace(/j/g,'i').replace(/v/g,'u'); }
function termToRegexPart(t){ let p=''; for(let i=0;i<t.length;i++){switch(t[i]){case 'i':p+='[ij]';break;case 'u':p+='[uv]';break;case 'e':p+='(?:ae|[eæę])';break;default:p+=t[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}} return p; }
function buildHighlightRe(raw){ const toks=raw.trim().split(/\s+/).filter(Boolean); if(!toks.length) return null; return new RegExp(`(${toks.map(t=>termToRegexPart(normalise(t))).join('|')})`,'gi'); }
function highlightText(text,re){ if(!re) return esc(text); re.lastIndex=0; const parts=[]; let last=0,m; while((m=re.exec(text))!==null){ parts.push(esc(text.slice(last,m.index))); parts.push(`<mark>${esc(m[0])}</mark>`); last=m.index+m[0].length; } parts.push(esc(text.slice(last))); return parts.join(''); }
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function snippet(text,re,len=190){ if(!text) return ''; if(re){ re.lastIndex=0; const m=re.exec(text); if(m){ const s=Math.max(0,m.index-70); return (s>0?'…':'')+text.slice(s,s+len)+(s+len<text.length?'…':''); } } return text.slice(0,len)+(text.length>len?'…':''); }

/* ── colour helpers ─────────────────────────────────────────────────────── */
const CLUSTER_PALETTE = ['#8a3f2b','#3f6b5e','#9a7a2e','#56688c','#7c4a6b','#6b853f','#b06a35','#4a7d86','#86564a','#5a5f7a','#7d8a4a','#9c4f57'];
const VOL_COLORS = ['#8a3f2b','#3f6b5e','#9a7a2e','#56688c','#7c4a6b','#6b853f'];
let volColorMap = {};
function volColor(v){ if(!(v in volColorMap)) volColorMap[v]=VOL_COLORS[Object.keys(volColorMap).length%VOL_COLORS.length]; return volColorMap[v]; }
function volShort(v){ const m=String(v).match(/_(v\d+)$/i)||String(v).match(/v(\d+)\b/i); return m?(m[1].startsWith('v')?m[1]:'v'+m[1]):String(v).slice(-4); }
function volLabel(v){ return v.replace(/_/g,' '); }
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function hexToRgb(h){ h=h.replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join(''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function semScoreColor(t){ // t∈[0,1] muted→accent
  t=Math.max(0,Math.min(1,t));
  const a=hexToRgb(cssVar('--faint')||'#b6a98f'), b=hexToRgb(cssVar('--accent')||'#8a3f2b');
  const m=a.map((v,i)=>Math.round(v+(b[i]-v)*t)); return `rgb(${m[0]},${m[1]},${m[2]})`;
}

/* ── Latin/EN/DE stopwords for cluster labelling ────────────────────────── */
const LAT_STOP = new Set(['an','de','et','in','ad','per','cum','non','sed','quia','quod','vel','aut','est','si','ut','ex','pro','qui','quae','dum','nam','iam','nec','neu','etiam','tamen','autem','vero','enim','ergo','ideo','item','idem','igitur','quando','quomodo','quoniam','quam','inter','post','ante','apud','sine','sive','atque','neque','quin','qua','quo','ubi','unde','nisi','possit','potest','possint','potuit','posse','posset','debet','debetur','debeatur','debent','debere','consilivm','consilium','consilii','consilio','consiliis','esse','fuit','sunt','fuerit','sit','sint','fuerat','fuisse','erat','erit','habet','habuit','habeat','habere','habens','habeatur','habentur','dici','dictum','dicta','dixit','dixerit','dicatur','dicendum','fieri','fieret','facta','factum','facti','facere','factus','tenetur','teneatur','teneri','quid','quis','aliquid','aliquis','aliqua','aliquam','alicui','ille','illa','illud','ipse','ipsa','ipsum','hoc','haec','hic','tale','talis','eadem','propter','contra','super','ultra','secundum','coram','circa','the','of','and','to','is','are','that','from','this','with','for','not','but','when','by','be','oder','und','der','die','das']);

/* ── state ──────────────────────────────────────────────────────────────── */
let consilia={}, authors={}, miniSearch=null;
let allItems=[], items=[];                    // items = current volume
let volume=null, searchMode='keyword', embedMode='hf', similarScope='volume';
let pcaColorMode='cluster', usingDemo=false;
let lastResults=[];                            // [{id, score, match?}]
let searchTimer=null, searchSeq=0;

// embeddings
let semEmbeddings=null;                         // Float32Array N*D
let semMeta=null;                               // {ids, dims, n, model}
let embedDemo=false;
let semExtractor=null, localModelState='';      // local ONNX (transformers.js)
let idToIdx={};                                 // id → embedding row

// pca / clusters
let pcaCoords=null, clusterAssignments=null, clusterLabels=null;
let simRefId=null;

/* ── boot ──────────────────────────────────────────────────────────────── */
Promise.all([
  fetch('output/consilia.json').then(r=>r.ok?r.json():Promise.reject()).catch(()=>window.CONSILIA_DATA),
  fetch('output/authors.json').then(r=>r.ok?r.json():Promise.reject()).catch(()=>window.AUTHORS_DATA),
]).then(([cd,ad])=>{
  usingDemo = !cd || cd===window.CONSILIA_DATA;
  consilia=(cd||window.CONSILIA_DATA).consilia;
  authors = ad||window.AUTHORS_DATA;
  allItems=Object.values(consilia);

  const authSel=document.getElementById('author-select');
  const allOpt=document.createElement('option'); allOpt.value=''; allOpt.textContent='All authors'; authSel.appendChild(allOpt);
  Object.entries(authors).forEach(([viaf,info])=>{ const o=document.createElement('option'); o.value=viaf; o.textContent=info.name||viaf.replace(/_/g,' '); authSel.appendChild(o); });
  authSel.addEventListener('change',()=>{ populateVolumes(authSel.value); const s=document.getElementById('volume-select'); if(s.options.length) loadVolume(s.options[0].value); });

  populateVolumes('');
  const vsel=document.getElementById('volume-select');
  vsel.addEventListener('change',()=>loadVolume(vsel.value));
  loadVolume(vsel.options[0].value);

  // ?similar=N&vol= deep link from the reader
  const sp=new URLSearchParams(location.search); const simN=parseInt(sp.get('similar'));
  if(simN){ const v=sp.get('vol'); if(v && [...vsel.options].some(o=>o.value===v)){ vsel.value=v; loadVolume(v); } setMode('similar'); findSimilarByNVol(simN, sp.get('vol')||volume); }

  // restore HF token + local-model preference
  const tok=document.getElementById('hf-token'); const stored=localStorage.getItem('hf_token');
  if(stored) tok.value=stored;
  tok.addEventListener('input',()=>{ const v=tok.value.trim(); if(v) localStorage.setItem('hf_token',v); else localStorage.removeItem('hf_token'); setModelStatus(v?'Token saved · HF API ready':'Enter a token, or switch to Local model',''); });
  if(localStorage.getItem('use_local_model')){ embedMode='local'; }
}).catch(e=>{ document.getElementById('empty-text').textContent='Could not load corpus: '+e; });

function populateVolumes(authorFilter){
  const all=[...new Set(allItems.map(c=>c.volume))].sort();
  const f=authorFilter?all.filter(v=>authors[authorFilter]?.prints?.includes(v)):all;
  const sel=document.getElementById('volume-select'); sel.innerHTML='';
  f.forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=volLabel(v); sel.appendChild(o); });
}
function loadVolume(v){
  volume=v;
  items=allItems.filter(c=>c.volume===v).sort((a,b)=>a.n-b.n||String(a.id).localeCompare(String(b.id)));
  miniSearch=new MiniSearch({ fields:['title','summary','body'], idField:'id', processTerm:normalise,
    searchOptions:{ boost:{title:3,summary:1.5,body:1}, prefix:true, fuzzy:t=>t.length>4?0.15:false } });
  miniSearch.addAll(items.map(c=>({ id:c.id, title:c.title||'', summary:c.summary||'', body:Array.isArray(c.body)?c.body.join(' '):(c.body||'') })));
  runSearch();
}

/* ── embeddings: real safetensors, else synthetic fallback ──────────────── */
function setModelStatus(msg,cls=''){ const el=document.getElementById('model-status'); if(el){ el.textContent=msg; el.className='status '+cls; } }
function fetchTimeout(url,ms,kind){ return Promise.race([
  fetch(url).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return kind==='buf'?r.arrayBuffer():r.json(); }),
  new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms)),
]); }
async function loadSafetensors(url){
  const buf=await fetchTimeout(url,5000,'buf');
  const view=new DataView(buf); const headerLen=Number(view.getBigUint64(0,true));
  const header=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,8,headerLen)));
  const dataStart=8+headerLen; const out={};
  for(const [name,meta] of Object.entries(header)){ if(name==='__metadata__') continue; const [s,e]=meta.data_offsets; const bytes=buf.slice(dataStart+s,dataStart+e); out[name]=meta.dtype==='F32'?new Float32Array(bytes):bytes; }
  return out;
}
function buildSyntheticEmbeddings(){
  const vecs=window.buildDemoVectors?window.buildDemoVectors():{};
  const ids=allItems.map(c=>c.id).filter(id=>vecs[id]);
  const dims=window.SEM_DIM||24;
  const flat=new Float32Array(ids.length*dims);
  ids.forEach((id,i)=>{ const v=vecs[id]; for(let d=0;d<dims;d++) flat[i*dims+d]=v[d]; });
  semMeta={ ids, dims, n:ids.length, model:'synthetic-preview' };
  semEmbeddings=flat; embedDemo=true;
}
async function ensureEmbeddings(){
  if(semEmbeddings) return;
  setModelStatus('Loading embeddings…','busy');
  try{
    const [tensors,meta]=await Promise.all([ loadSafetensors('output/embeddings.safetensors'), fetchTimeout('output/embeddings_meta.json',5000,'json') ]);
    const key = tensors.embeddings ? 'embeddings' : Object.keys(tensors)[0];
    semEmbeddings=tensors[key]; semMeta=meta; embedDemo=false;
    if(!semMeta.dims) semMeta.dims=semEmbeddings.length/semMeta.n;
    document.getElementById('embed-note').style.display='none';
    setModelStatus(`${semMeta.n} BGE-M3 vectors loaded`,'ready');
  }catch(e){
    buildSyntheticEmbeddings();
    document.getElementById('embed-note').style.display='';
    setModelStatus('Preview mode · synthetic projection','');
  }
  idToIdx={}; semMeta.ids.forEach((id,i)=>idToIdx[id]=i);
}

/* query embedding: synthetic (preview) · local ONNX · HF API */
function querySyntheticVec(text){
  const dim=semMeta.dims, centers=window.demoClusterCenters||[];
  const KW=[['feud','success','hered','fili','primogenit','intestat','legat','frat','postum'],['dos','dot','matrimon','uxor','coniug','aliment','nupt','pact'],['iudic','process','praescript','fideiuss','servitut','condicion','iurisdict','usur','mora','iter','delegat'],['cambi','mercat','societ','empt','vendit','negoti','lucr','damn'],['crimen','falsi','poena','test','reus','tortur','notari'],['ecclesi','decim','canon','novali','beneficium']];
  const toks=normalise(text).split(/\s+/).filter(Boolean); const acc=new Array(dim).fill(0); let hit=0;
  toks.forEach(tk=>KW.forEach((kws,k)=>{ if(kws.some(w=>tk.startsWith(w)||(w.startsWith(tk)&&tk.length>=4))){ const c=centers[k]||[]; for(let d=0;d<dim;d++) acc[d]+=c[d]||0; hit++; } }));
  if(!hit) toks.forEach(tk=>{ for(let i=0;i<tk.length;i++) acc[(tk.charCodeAt(i)*7+i)%dim]+=0.5; });
  let n=Math.sqrt(acc.reduce((s,x)=>s+x*x,0))||1; return Float32Array.from(acc.map(x=>x/n));
}
async function embedQuery(text){
  if(embedDemo) return querySyntheticVec(text);
  if(embedMode==='local' && localModelState==='ready' && semExtractor){ const out=await semExtractor(text,{pooling:'cls',normalize:true}); return out.data instanceof Float32Array?out.data:new Float32Array(out.data); }
  if(embedMode==='local' && localModelState!=='ready') throw new Error('Local model not loaded — click “Download BGE-M3 ONNX model”.');
  return embedQueryViaAPI(text);
}
async function embedQueryViaAPI(text){
  const token=localStorage.getItem('hf_token')||'';
  if(!token) throw new Error('No HuggingFace token — enter one above, or switch to Local model.');
  const resp=await fetch('https://api-inference.huggingface.co/models/BAAI/bge-m3',{ method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`}, body:JSON.stringify({inputs:text}) });
  if(resp.status===503){ const info=await resp.json().catch(()=>({})); const wait=Math.min((info.estimated_time??20)*1000,30000); setModelStatus(`Model warming up (~${(wait/1000).toFixed(0)} s)…`,'busy'); await new Promise(r=>setTimeout(r,wait)); return embedQueryViaAPI(text); }
  if(resp.status===401||resp.status===403) throw new Error('HF token missing or invalid.');
  if(!resp.ok){ const err=await resp.json().catch(()=>({})); throw new Error(err.error||('HF API error '+resp.status)); }
  let raw=await resp.json(); while(Array.isArray(raw)&&Array.isArray(raw[0])) raw=raw[0];
  const v=new Float32Array(raw); let n=0; for(let i=0;i<v.length;i++) n+=v[i]*v[i]; n=Math.sqrt(n); if(n>0) for(let i=0;i<v.length;i++) v[i]/=n; return v;
}

/* local ONNX model (transformers.js) */
function setEmbedMode(m){ embedMode=m; document.getElementById('etab-hf').classList.toggle('active',m==='hf'); document.getElementById('etab-local').classList.toggle('active',m==='local'); document.getElementById('epanel-hf').style.display=m==='hf'?'':'none'; document.getElementById('epanel-local').style.display=m==='local'?'':'none'; }
async function activateLocalModel(){ if(localModelState==='ready'){ setModelStatus('Local model active · queries run offline','ready'); return; } if(localModelState==='loading') return; await loadLocalModel(); }
async function loadLocalModel(){
  localModelState='loading'; const btn=document.getElementById('btn-local-model'); if(btn){ btn.textContent='Downloading…'; btn.disabled=true; }
  setModelStatus('Downloading BGE-M3 ONNX — first time only, cached (~130 MB)…','busy');
  try{
    const { pipeline, env }=await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2/dist/transformers.min.js');
    env.allowRemoteModels=true;
    semExtractor=await pipeline('feature-extraction','Xenova/bge-m3',{ quantized:true, progress_callback:p=>{ if(p.status==='downloading'&&p.total){ setModelStatus(`Downloading ${p.name??'model'} … ${((p.loaded/p.total)*100).toFixed(0)}%`,'busy'); } } });
    localModelState='ready'; localStorage.setItem('use_local_model','1');
    if(btn){ btn.textContent='Local model active ✓'; btn.disabled=false; }
    setModelStatus('Local model active · queries run offline','ready');
  }catch(e){ localModelState=''; if(btn){ btn.textContent='Download BGE-M3 ONNX model (~130 MB)'; btn.disabled=false; } setModelStatus('Download failed: '+e.message,''); }
}

/* ── mode / scope toggles ───────────────────────────────────────────────── */
function setMode(m){
  searchMode=m;
  ['keyword','semantic','similar'].forEach(x=>document.getElementById('btn-'+x).classList.toggle('active',x===m));
  document.getElementById('sem-controls').classList.toggle('show',m==='semantic');
  document.getElementById('sim-controls').classList.toggle('show',m==='similar');
  document.getElementById('topk-ctrl').style.display=(m==='semantic'||m==='similar')?'':'none';
  document.getElementById('scope-ctrl').style.display=(m==='semantic')?'':'none';
  document.getElementById('fields-block').style.display=(m==='keyword')?'':'none';
  document.getElementById('pca-block').style.display=(m==='keyword')?'none':'';
  const hint=document.getElementById('search-hint');
  if(m==='keyword') hint.innerHTML='Normalised &mdash; <kbd>j</kbd>=<kbd>i</kbd> &nbsp; <kbd>v</kbd>=<kbd>u</kbd> &nbsp; <kbd>ae</kbd>=<kbd>e</kbd> &nbsp;·&nbsp; prefix &amp; fuzzy';
  else if(m==='semantic'){ hint.innerHTML='BGE-M3 · query in Latin, German or English — ranked by meaning'; setEmbedMode(embedMode); }
  else hint.innerHTML='Cosine similarity · BGE-M3 embeddings · pick a reference consilium below';
  const sf=document.getElementById('search-input').closest('.search-field');
  if(sf) sf.style.display=(m==='similar')?'none':'';
  runSearch();
}
function setSimilarScope(s){ similarScope=s; ['volume','author','all'].forEach(x=>document.getElementById('spill-'+x).classList.toggle('active',x===s)); if(simRefId) runSearch(); }
function setPcaColor(m){ pcaColorMode=m; document.getElementById('pcb-cluster').classList.toggle('active',m==='cluster'); document.getElementById('pcb-volume').classList.toggle('active',m==='volume'); if(m==='cluster'&&!clusterAssignments&&pcaCoords) computeClusters(); else renderPCAScatter(); }

/* ── search dispatch ────────────────────────────────────────────────────── */
document.getElementById('search-input').addEventListener('input',()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(runSearch,220); });
document.getElementById('search-clear').addEventListener('click',()=>{ document.getElementById('search-input').value=''; runSearch(); });
function showResults(on,msg){ document.getElementById('results-layout').style.display=on?'grid':'none'; document.getElementById('empty-state').style.display=on?'none':'block'; if(!on&&msg) document.getElementById('empty-text').textContent=msg; }
function topK(){ return Math.max(1,parseInt(document.getElementById('topk-input').value||'20',10)); }
function rerender(){ runSearch(); }

async function runSearch(){
  const q=document.getElementById('search-input').value.trim();
  document.getElementById('search-clear').style.display=q?'block':'none';
  const seq=++searchSeq;
  if(searchMode==='keyword'){
    if(!q){ showResults(false,'Begin typing to search the consilia.'); lastResults=[]; return; }
    const t0=performance.now(); const re=buildHighlightRe(q);
    lastResults=miniSearch.search(q).map(r=>({id:r.id,score:r.score,match:r.match}));
    showResults(true);
    document.getElementById('count-head').textContent='Matches'; document.getElementById('score-head').textContent='Score range';
    renderKeyword(re); renderStats(); timing(t0,q,'MiniSearch');
    return;
  }
  // semantic / similar need embeddings
  if(searchMode==='semantic' && !q){ showResults(false,'Enter a phrase — results rank by meaning, not exact words.'); lastResults=[]; return; }
  if(searchMode==='similar' && simRefId===null){ showResults(false,'Choose a reference consilium — click ≈ on any result, or enter its n above.'); lastResults=[]; return; }
  showResults(true);
  document.getElementById('results-list').innerHTML='<div class="state-msg">Loading…</div>';
  try{
    await ensureEmbeddings(); if(seq!==searchSeq) return;
    if(!semMeta.dims) semMeta.dims=semEmbeddings.length/semMeta.n;
    if(searchMode==='semantic') await runSemantic(q,seq); else runSimilar();
  }catch(e){ document.getElementById('results-list').innerHTML=`<div class="state-msg">${esc(e.message)}</div>`; setModelStatus(e.message,''); }
}
function timing(t0,q,engine){ document.getElementById('result-timing').textContent=(q?`“${q}” · `:'')+`${lastResults.length} result${lastResults.length===1?'':'s'} · ${(performance.now()-t0).toFixed(1)} ms`+(engine?` · ${engine}`:''); }

/* ── semantic ───────────────────────────────────────────────────────────── */
async function runSemantic(q,seq){
  const t0=performance.now();
  setModelStatus(embedDemo?'Preview · synthetic projection':(embedMode==='local'?'Embedding via local BGE-M3…':'Embedding via HF API…'),'busy');
  const qv=await embedQuery(q); if(seq!==searchSeq) return;
  const D=semMeta.dims, scope=document.getElementById('scope-select').value;
  const scored=[];
  for(let i=0;i<semMeta.n;i++){ const c=consilia[semMeta.ids[i]]; if(!c) continue; let s=0; const off=i*D; for(let d=0;d<D;d++) s+=qv[d]*semEmbeddings[off+d]; scored.push({id:c.id,score:s}); }
  scored.sort((a,b)=>b.score-a.score);
  const scoped=scored.filter(r=>scope==='all'||consilia[r.id]?.volume===volume);
  lastResults=scoped.slice(0,topK());
  document.getElementById('count-head').textContent='Neighbours'; document.getElementById('score-head').textContent='Similarity range';
  setModelStatus(embedDemo?'Preview · synthetic projection':`${semMeta.n} consilia scored · ${embedMode==='local'?'local':'HF API'}`, embedDemo?'':'ready');
  renderSemantic(false); renderStats(scope==='all'?allItems.length:items.length);
  ensurePCA();
  timing(t0,q,'BGE-M3');
}

/* ── similar ────────────────────────────────────────────────────────────── */
function scopeItems(ref){ if(similarScope==='all') return allItems; if(similarScope==='author') return allItems.filter(c=>c.author_viaf===ref.author_viaf); return allItems.filter(c=>c.volume===ref.volume); }
function setSimRef(id){ simRefId=id; const c=consilia[id];
  document.getElementById('sim-chip-row').style.display='block'; document.getElementById('sim-ref-row').style.display='none';
  document.getElementById('chip-n').textContent='n = '+c.n; document.getElementById('chip-title').textContent=c.title; document.getElementById('sim-n-input').value=c.n; runSearch(); }
function clearSimilar(){ simRefId=null; document.getElementById('sim-chip-row').style.display='none'; document.getElementById('sim-ref-row').style.display='flex'; document.getElementById('sim-n-input').value=''; document.getElementById('sim-status').textContent=''; runSearch(); }
function findSimilarFromCard(n,vol){ setMode('similar'); findSimilarByNVol(n,vol); window.scrollTo({top:0,behavior:'smooth'}); }
function findSimilarByInput(){ const n=parseInt(document.getElementById('sim-n-input').value); if(!n) return; findSimilarByNVol(n,volume); }
function findSimilarByNVol(n,vol){ const c=allItems.find(x=>x.n===n&&x.volume===vol)||allItems.find(x=>x.n===n); if(c) setSimRef(c.id); else document.getElementById('sim-status').textContent=`n=${n} not found`; }
function runSimilar(){
  const t0=performance.now(); const ref=consilia[simRefId]; if(!ref){ showResults(false,'Reference not found.'); return; }
  const ri=idToIdx[simRefId];
  if(ri==null){ document.getElementById('results-list').innerHTML='<div class="state-msg">No embedding for this consilium.</div>'; return; }
  const D=semMeta.dims, base=ri*D; const pool=scopeItems(ref);
  const scored=[];
  for(const c of pool){ if(c.id===simRefId) continue; const i=idToIdx[c.id]; if(i==null) continue; let s=0; const off=i*D; for(let d=0;d<D;d++) s+=semEmbeddings[base+d]*semEmbeddings[off+d]; scored.push({id:c.id,score:s}); }
  scored.sort((a,b)=>b.score-a.score); lastResults=scored.slice(0,topK());
  document.getElementById('count-head').textContent='Similar consilia'; document.getElementById('score-head').textContent='Similarity range';
  const scopeLabel=similarScope==='volume'?volShort(ref.volume):(similarScope==='author'?'all by author':'all corpus');
  document.getElementById('sim-status').textContent=`${scored.length} candidates · ${scopeLabel} · ${embedDemo?'synthetic':'BGE-M3'} cosine`;
  renderSemantic(true); renderStats(scored.length); ensurePCA();
  timing(t0,'','cosine');
}

/* ── sorting ────────────────────────────────────────────────────────────── */
function sortResults(){ const mode=document.getElementById('sort-select').value; return [...lastResults].sort((a,b)=> mode==='n' ? ((consilia[a.id]?.n??0)-(consilia[b.id]?.n??0)) : (b.score-a.score)); }

/* ── render: keyword cards ──────────────────────────────────────────────── */
function renderKeyword(re){
  const list=document.getElementById('results-list'); list.innerHTML='';
  const sorted=sortResults(); if(!sorted.length){ list.innerHTML='<div class="state-msg">No matching consilia.</div>'; return; }
  const maxScore=Math.max(...sorted.map(r=>r.score),1);
  sorted.forEach(r=>{ const c=consilia[r.id]; if(!c) return;
    const matched=new Set(Object.values(r.match||{}).flat());
    let snip=''; const body=Array.isArray(c.body)?c.body.join(' '):(c.body||'');
    if(matched.has('title')) snip=highlightText(c.title,re);
    else if(matched.has('summary')&&c.summary) snip=highlightText(snippet(c.summary,re),re);
    else snip=highlightText(snippet(body,re),re);
    const el=document.createElement('a'); el.className='result-card'; el.href=`index.html?n=${c.n}&vol=${encodeURIComponent(c.volume)}`;
    el.innerHTML=`
      <div class="rc-head">
        <span class="rc-n">n ${c.n}</span>
        <span class="rc-title">${esc(c.title)}</span>
        <span class="rc-score">${r.score.toFixed(1)}</span>
        <button class="sim-btn" title="Find similar" onclick="event.preventDefault();event.stopPropagation();findSimilarFromCard(${c.n},'${c.volume}')">&#8776;</button>
      </div>
      <div class="rc-fields">${['title','summary','body'].map(f=>`<span class="field-tag ${matched.has(f)?'matched':''}">${f}</span>`).join('')}</div>
      <div class="rc-meter"><div class="rc-meter-fill" style="width:${(r.score/maxScore*100).toFixed(0)}%"></div></div>
      <div class="rc-snippet">${snip}</div>`;
    list.appendChild(el);
  });
}

/* ── render: semantic / similar cards ───────────────────────────────────── */
function renderSemantic(isSimilar){
  const list=document.getElementById('results-list'); list.innerHTML='';
  const sorted=sortResults(); if(!sorted.length){ list.innerHTML='<div class="state-msg">No results in scope.</div>'; return; }
  const maxScore=sorted[0]?.score||1;
  const showVol=isSimilar?similarScope!=='volume':(document.getElementById('scope-select').value==='all');
  sorted.forEach(r=>{ const c=consilia[r.id]; if(!c) return;
    const color=semScoreColor(r.score/(maxScore||1));
    const raw=c.summary||(Array.isArray(c.body)?c.body.join(' '):(c.body||''));
    const el=document.createElement('a'); el.className='result-card'; el.href=`index.html?n=${c.n}&vol=${encodeURIComponent(c.volume)}`;
    el.innerHTML=`
      <div class="rc-head">
        <span class="rc-n">n ${c.n}</span>
        <span class="rc-title">${esc(c.title)}</span>
        ${showVol?`<span class="vol-badge">${volShort(c.volume)}</span>`:''}
        <span class="rc-score" style="color:${color}">${r.score.toFixed(3)}</span>
        <button class="sim-btn" title="Find similar" onclick="event.preventDefault();event.stopPropagation();findSimilarFromCard(${c.n},'${c.volume}')">&#8776;</button>
      </div>
      <div class="rc-meter"><div class="rc-meter-fill" style="width:${Math.max(0,r.score/maxScore*100).toFixed(0)}%;background:${color}"></div></div>
      <div class="rc-snippet">${esc(snippet(raw,null,210))}</div>`;
    list.appendChild(el);
  });
}

/* ── render: stats ──────────────────────────────────────────────────────── */
function renderStats(total){
  if(total==null) total=items.length;
  const count=lastResults.length;
  document.getElementById('stat-count').textContent=count;
  document.getElementById('stat-pct').textContent=`${total?((count/total)*100).toFixed(1):0}% of ${total} consilia`;
  if(searchMode==='keyword'){
    const fc={title:0,summary:0,body:0};
    lastResults.forEach(r=>new Set(Object.values(r.match||{}).flat()).forEach(f=>{ if(f in fc) fc[f]++; }));
    const mx=Math.max(...Object.values(fc),1);
    ['title','summary','body'].forEach(f=>{ document.getElementById('cnt-'+f).textContent=fc[f]; document.getElementById('bar-'+f).style.width=`${(fc[f]/mx*100).toFixed(0)}%`; });
  }
  if(lastResults.length){ const sc=lastResults.map(r=>r.score), fx=searchMode==='keyword'?(x=>x.toFixed(2)):(x=>x.toFixed(3));
    document.getElementById('stat-score-max').textContent=fx(Math.max(...sc)); document.getElementById('stat-score-min').textContent=fx(Math.min(...sc));
  } else { document.getElementById('stat-score-max').textContent='—'; document.getElementById('stat-score-min').textContent='—'; }
  renderDistribution();
}
function renderDistribution(){
  const bars=document.getElementById('dist-bars'), axis=document.getElementById('dist-axis');
  let pool=items;
  if(searchMode==='similar'&&simRefId) pool=scopeItems(consilia[simRefId]);
  else if(searchMode==='semantic'&&document.getElementById('scope-select').value==='all') pool=allItems;
  const ns=pool.map(c=>c.n).filter(n=>n!=null); if(!ns.length){ bars.innerHTML=''; axis.innerHTML=''; return; }
  const lo=Math.min(...ns), hi=Math.max(...ns), nb=Math.min(28,Math.max(8,Math.round((hi-lo)/4)||8));
  const counts=new Array(nb).fill(0); const inResult=new Set(lastResults.map(r=>r.id));
  pool.forEach(c=>{ if(inResult.has(c.id)){ const b=Math.min(nb-1,Math.floor((c.n-lo)/((hi-lo+1)/nb))); counts[b]++; } });
  const mx=Math.max(...counts,1);
  bars.innerHTML=counts.map(v=>`<div class="dist-bar" style="height:${(v/mx*100).toFixed(0)}%" title="${v}"></div>`).join('');
  axis.innerHTML=`<span>${lo}</span><span>${hi}</span>`;
}

/* ── PCA + clusters ─────────────────────────────────────────────────────── */
function ensurePCA(){ document.getElementById('pca-block').style.display=''; if(!pcaCoords) computeAndRenderPCA(); else if(pcaColorMode==='cluster'&&!clusterAssignments) computeClusters(); else renderPCAScatter(); }
async function computeAndRenderPCA(){
  const canvas=document.getElementById('pca-canvas'), ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height); ctx.fillStyle=cssVar('--faint'); ctx.font='12px monospace'; ctx.fillText('Computing projection…',16,canvas.height/2);
  await new Promise(r=>setTimeout(r,0));
  const N=semMeta.n, D=semMeta.dims, X=semEmbeddings;
  const mean=new Float32Array(D);
  for(let i=0;i<N;i++){ const off=i*D; for(let d=0;d<D;d++) mean[d]+=X[off+d]; }
  for(let d=0;d<D;d++) mean[d]/=N;
  const u=[new Float32Array(D),new Float32Array(D)];
  for(let k=0;k<2;k++){ for(let d=0;d<D;d++) u[k][d]=Math.random()-0.5; let n=0; for(let d=0;d<D;d++) n+=u[k][d]**2; n=Math.sqrt(n); for(let d=0;d<D;d++) u[k][d]/=n; }
  for(let it=0;it<6;it++){ for(let k=0;k<2;k++){
    const a=new Float32Array(N); for(let i=0;i<N;i++){ const off=i*D; let s=0; for(let d=0;d<D;d++) s+=(X[off+d]-mean[d])*u[k][d]; a[i]=s; }
    const v=new Float32Array(D); for(let i=0;i<N;i++){ const off=i*D; for(let d=0;d<D;d++) v[d]+=a[i]*(X[off+d]-mean[d]); }
    for(let j=0;j<k;j++){ let dotp=0; for(let d=0;d<D;d++) dotp+=v[d]*u[j][d]; for(let d=0;d<D;d++) v[d]-=dotp*u[j][d]; }
    let n=0; for(let d=0;d<D;d++) n+=v[d]**2; n=Math.sqrt(n); if(n>0) for(let d=0;d<D;d++) u[k][d]=v[d]/n;
  } }
  const coords=new Float32Array(N*2); let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(let i=0;i<N;i++){ const off=i*D; let px=0,py=0; for(let d=0;d<D;d++){ const x=X[off+d]-mean[d]; px+=x*u[0][d]; py+=x*u[1][d]; } coords[i*2]=px; coords[i*2+1]=py; if(px<minX)minX=px; if(px>maxX)maxX=px; if(py<minY)minY=py; if(py>maxY)maxY=py; }
  pcaCoords={ raw:coords, minX,maxX,minY,maxY, N };
  if(pcaColorMode==='cluster') computeClusters(); else renderPCAScatter();
}
function computeClusters(){
  if(!pcaCoords) return; const { raw:coords, N }=pcaCoords;
  const k=Math.max(3,Math.min(CLUSTER_PALETTE.length, Math.round(Math.sqrt(N/2))||6));
  const cx=new Float32Array(k), cy=new Float32Array(k);
  const seed=Math.floor(Math.random()*N); cx[0]=coords[seed*2]; cy[0]=coords[seed*2+1];
  for(let ki=1;ki<k;ki++){ const d2=new Float32Array(N); let tot=0; for(let i=0;i<N;i++){ let md=Infinity; for(let j=0;j<ki;j++){ const dx=coords[i*2]-cx[j],dy=coords[i*2+1]-cy[j]; md=Math.min(md,dx*dx+dy*dy); } d2[i]=md; tot+=md; } let r=Math.random()*tot,acc=0; for(let i=0;i<N;i++){ acc+=d2[i]; if(acc>=r){ cx[ki]=coords[i*2]; cy[ki]=coords[i*2+1]; break; } } }
  const asgn=new Int32Array(N);
  for(let it=0;it<25;it++){ let changed=0; for(let i=0;i<N;i++){ let bk=0,bd=Infinity; for(let ki=0;ki<k;ki++){ const dx=coords[i*2]-cx[ki],dy=coords[i*2+1]-cy[ki]; const d=dx*dx+dy*dy; if(d<bd){bd=d;bk=ki;} } if(asgn[i]!==bk){ asgn[i]=bk; changed++; } } if(!changed) break; const sx=new Float32Array(k),sy=new Float32Array(k),cn=new Int32Array(k); for(let i=0;i<N;i++){ const ki=asgn[i]; sx[ki]+=coords[i*2]; sy[ki]+=coords[i*2+1]; cn[ki]++; } for(let ki=0;ki<k;ki++){ if(cn[ki]){ cx[ki]=sx[ki]/cn[ki]; cy[ki]=sy[ki]/cn[ki]; } } }
  clusterAssignments=asgn; clusterLabels=buildClusterLabels(asgn,k); renderPCAScatter();
}
function buildClusterLabels(asgn,k){
  const MINF=Math.max(2,Math.round(semMeta.n*0.02));
  const cf=Array.from({length:k},()=>({})), corpus={};
  asgn.forEach((ki,i)=>{ const c=consilia[semMeta.ids[i]]; if(!c) return;
    const titleClean=(c.title||'').replace(/CONSILI[VU]M?\s*[IVXLCDM\d\.]+\s*/i,'');
    const text=(titleClean+' '+(c.summary||'')).toLowerCase().replace(/[^a-zäöüàáâãèéêëìíïòóôùúæœ\s]/g,' ');
    const seen=new Set();
    text.split(/\s+/).forEach(w=>{ if(w.length<4||LAT_STOP.has(w)) return; cf[ki][w]=(cf[ki][w]||0)+1; if(!seen.has(w)){ corpus[w]=(corpus[w]||0)+1; seen.add(w); } });
  });
  const cdf={}; cf.forEach(f=>Object.keys(f).forEach(w=>cdf[w]=(cdf[w]||0)+1));
  return cf.map(f=>{ const total=Object.values(f).reduce((s,n)=>s+n,0)||1;
    const scored=Object.entries(f).filter(([w])=>(corpus[w]||0)>=MINF).map(([w,cnt])=>[w,(cnt/total)*Math.log((k+1)/(cdf[w]||1))]).filter(([,s])=>s>0.001);
    scored.sort((a,b)=>b[1]-a[1]); return scored.slice(0,3).map(([w])=>w).join(', ')||'—'; });
}
function renderPCAScatter(){
  if(!pcaCoords) return;
  const canvas=document.getElementById('pca-canvas'), W=canvas.width,H=canvas.height, ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);
  const { raw,minX,maxX,minY,maxY,N }=pcaCoords; const pad=22;
  const sx=x=>pad+(x-minX)/((maxX-minX)||1)*(W-2*pad), sy=y=>H-pad-(y-minY)/((maxY-minY)||1)*(H-2*pad);
  const useCluster=pcaColorMode==='cluster'&&clusterAssignments;
  const color=i=>{ if(useCluster) return CLUSTER_PALETTE[clusterAssignments[i]%CLUSTER_PALETTE.length]; const v=consilia[semMeta.ids[i]]?.volume; return v?volColor(v):'#888'; };
  const hi=new Set(lastResults.map(r=>idToIdx[r.id]).filter(i=>i!=null)); if(simRefId!=null&&idToIdx[simRefId]!=null) hi.add(idToIdx[simRefId]);
  const r0 = N>400?2:3;
  for(let i=0;i<N;i++){ const px=sx(raw[i*2]),py=sy(raw[i*2+1]); ctx.beginPath(); ctx.arc(px,py,r0,0,7); ctx.fillStyle=(hi.size&&!hi.has(i))?color(i)+'2b':color(i)+'bb'; ctx.fill(); }
  hi.forEach(i=>{ if(i<0||i>=N) return; const isRef=(semMeta.ids[i]===simRefId); const px=sx(raw[i*2]),py=sy(raw[i*2+1]); ctx.beginPath(); ctx.arc(px,py,isRef?7:5,0,7); ctx.fillStyle=isRef?cssVar('--paper'):color(i); ctx.fill(); ctx.lineWidth=isRef?2.4:1.4; ctx.strokeStyle=isRef?color(i):cssVar('--paper'); ctx.stroke(); });
  const legend=document.getElementById('pca-legend');
  if(useCluster){ const used=[...new Set(clusterAssignments)].sort((a,b)=>a-b);
    legend.innerHTML=used.map(ki=>`<span class="row"><span class="pca-dot" style="background:${CLUSTER_PALETTE[ki%CLUSTER_PALETTE.length]}"></span>${esc((clusterLabels&&clusterLabels[ki])||('cluster '+(ki+1)))}</span>`).join('');
  } else { const vols=[...new Set(semMeta.ids.map(id=>consilia[id]?.volume).filter(Boolean))];
    legend.innerHTML=vols.map(v=>`<span class="row"><span class="pca-dot" style="background:${volColor(v)}"></span>${esc(volLabel(v))}</span>`).join('');
  }
  const tip=document.getElementById('pca-tooltip');
  canvas.onmousemove=e=>{ const rect=canvas.getBoundingClientRect(); const mx=(e.clientX-rect.left)*(W/rect.width), my=(e.clientY-rect.top)*(H/rect.height); let best=-1,bd=80; for(let i=0;i<N;i++){ const px=sx(raw[i*2]),py=sy(raw[i*2+1]); const d=(px-mx)**2+(py-my)**2; if(d<bd){bd=d;best=i;} } if(best>=0){ const c=consilia[semMeta.ids[best]]; const hit=lastResults.find(r=>r.id===semMeta.ids[best]); tip.innerHTML=`<span class="tn">n ${c?.n}</span> ${esc(c?.title??'')}`+(hit?`<br>score ${hit.score.toFixed(3)}`:'')+`<br><span style="opacity:.6">${esc(volShort(c?.volume??''))}</span>`; tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY-8)+'px'; } else tip.style.display='none'; };
  canvas.onmouseleave=()=>tip.style.display='none';
  canvas.onclick=e=>{ const rect=canvas.getBoundingClientRect(); const mx=(e.clientX-rect.left)*(W/rect.width), my=(e.clientY-rect.top)*(H/rect.height); let best=-1,bd=120; for(let i=0;i<N;i++){ const px=sx(raw[i*2]),py=sy(raw[i*2+1]); const d=(px-mx)**2+(py-my)**2; if(d<bd){bd=d;best=i;} } if(best>=0){ const c=consilia[semMeta.ids[best]]; if(c) window.open(`index.html?n=${c.n}&vol=${encodeURIComponent(c.volume)}`,'_blank'); } };
}
