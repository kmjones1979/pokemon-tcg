// /cards — a browsable gallery of every TCG card FACE (not just the art),
// rendered with the exact in-game renderer (card-face.js) so it always matches.
// Cards tilt in 3D toward the cursor with a holographic glare, and clicking one
// zooms it to center with a 360° spin (inspired by tcg.pokemon.com galleries).
//
// The page imports the client modules directly (served statically) and links
// tcg.css, so card faces are pixel-identical to the game. Grid art is swapped
// to ~75KB thumbnails for fast loading; the zoom view keeps full-res.

function page(origin) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Card Gallery — Pokémon Battle</title>
<meta name="description" content="Browse every card in Pokémon Battle's TCG mode — tilt them in 3D and click to zoom &amp; spin.">
<meta property="og:title" content="Pokémon Battle — Card Gallery">
<meta property="og:description" content="Browse every TCG card in 3D. Tilt, shine, click to zoom &amp; spin.">
<meta property="og:image" content="${origin}/client/js/tcg/tcg-art.js">
<link rel="stylesheet" href="/client/css/tcg.css">
<style>${CSS}</style>
</head>
<body>
<div class="aurora"></div>
<header class="hero">
  <a class="back" href="/">← Pokémon Battle</a>
  <h1>Card Gallery</h1>
  <p class="sub">Every card in the TCG mode. Move your cursor over a card to tilt it, and click to zoom &amp; spin.</p>
  <input id="search" class="search" type="search" placeholder="Search cards…" autocomplete="off">
  <div class="filters" id="filters"></div>
  <div class="artistbar" id="artistbar"></div>
  <button id="shineToggle" class="shinebtn" title="Turn off the animated card shine if the page feels laggy"></button>
</header>
<div id="count" class="count"></div>
<main id="grid" class="cards-grid"></main>
<footer class="credits">
  <p><b>Pokémon</b>, character names and designs are © The Pokémon Company, Nintendo, Game&nbsp;Freak. Non-commercial fan project. See the <a href="/art">art gallery</a> for illustration credits.</p>
</footer>

<div class="zoom" id="zoom" hidden>
  <button class="zoom-close" id="zoomClose" aria-label="Close">✕</button>
  <button class="zoom-nav zoom-prev" id="zoomPrev" aria-label="Previous">‹</button>
  <button class="zoom-nav zoom-next" id="zoomNext" aria-label="Next">›</button>
  <div class="zoom-stage" id="zoomStage"></div>
  <div class="zoom-meta" id="zoomMeta"></div>
</div>

<script type="module">
import { renderTcgCard } from "/client/js/tcg/card-face.js";
import { POKEMON, ENERGY, TRAINERS } from "/client/js/tcg/catalog.js";
${JS}
</script>
</body>
</html>`;
}

const CSS = `
:root{--bg:#0a0812}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:#eef;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
/* Static blurred backdrop. It used to animate (drift), but animating a
   filter:blur(70px) layer re-rasterizes every frame and stutters on weak GPUs
   even at idle — so it's frozen. */
.aurora{position:fixed;inset:-30% -10% auto;height:70vh;z-index:0;pointer-events:none;filter:blur(70px);opacity:.5;
 background:radial-gradient(40% 60% at 20% 30%,#ff5f6d55,transparent),radial-gradient(45% 55% at 80% 20%,#6a9bff55,transparent),radial-gradient(50% 50% at 55% 70%,#c86bff55,transparent)}
.hero{position:relative;z-index:1;text-align:center;padding:40px 20px 14px;max-width:860px;margin:0 auto}
.back{display:inline-block;font-size:13px;opacity:.7;margin-bottom:14px}.back:hover{opacity:1}
h1{font-size:clamp(36px,7vw,68px);font-weight:900;letter-spacing:-1px;line-height:1;
 background:linear-gradient(90deg,#ff5f6d,#ffc371,#47e0a0,#6a9bff,#c86bff);-webkit-background-clip:text;background-clip:text;color:transparent;background-size:200% auto;animation:sheen 6s linear infinite}
@keyframes sheen{to{background-position:200% center}}
.sub{margin:14px auto 0;max-width:560px;color:#b9bce0;font-size:15px;line-height:1.5}
.search{margin:20px auto 6px;display:block;width:min(360px,90%);padding:11px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.16);
 background:rgba(255,255,255,.06);color:#fff;font-size:15px;text-align:center}
.search:focus{outline:none;border-color:#6a9bff}
.filters{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px}
.chip{padding:7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#cdd0e6;font-size:13px;font-weight:600;cursor:pointer;transition:.15s}
.chip:hover{background:rgba(255,255,255,.12)}.chip.on{background:#fff;color:#111;border-color:#fff}
.artistbar{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;align-items:center;margin:12px auto 0;max-width:760px}
.artistbar .albl{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#8a8daf;margin-right:2px}
.achip{padding:5px 11px;border-radius:999px;border:1px solid transparent;font-size:12px;font-weight:700;cursor:pointer;
 background:linear-gradient(90deg,rgba(200,107,255,.16),rgba(106,155,255,.16));color:#dcd6ff;transition:.15s}
.achip:hover{background:linear-gradient(90deg,rgba(200,107,255,.3),rgba(106,155,255,.3))}.achip.on{background:linear-gradient(90deg,#c86bff,#6a9bff);color:#fff}
.shinebtn{position:relative;z-index:1;margin:14px auto 0;display:block;cursor:pointer;padding:6px 14px;border-radius:999px;
 font-size:12px;font-weight:700;color:#e7d6ff;border:1px solid rgba(180,130,255,.4);
 background:linear-gradient(90deg,rgba(150,110,255,.18),rgba(200,107,255,.18));transition:.15s}
.shinebtn:hover{background:linear-gradient(90deg,rgba(150,110,255,.34),rgba(200,107,255,.34))}
.count{position:relative;z-index:1;text-align:center;color:#8a8daf;font-size:12.5px;margin:10px 0 0}
.cards-grid{position:relative;z-index:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:26px 20px;
 padding:26px clamp(14px,4vw,52px) 50px;max-width:1600px;margin:0 auto}
@media(max-width:520px){.cards-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:18px 12px}}
/* 3D tilt wrapper. content-visibility culls off-screen cards (huge win for a
   200+ card grid — the browser skips their layout/paint entirely). will-change
   and mix-blend-mode are applied ONLY to the hovered card (.live), so we don't
   promote 200 permanent GPU layers or force 200 blend-mode composites at idle. */
.cw{perspective:900px;content-visibility:auto;contain-intrinsic-size:190px 320px}
.cw.live{content-visibility:visible}
.cw .tcg-card{width:100%!important;cursor:pointer;transition:transform .35s cubic-bezier(.2,.8,.3,1),box-shadow .35s;transform-style:preserve-3d}
.cw.live .tcg-card{transition:transform .06s linear;will-change:transform}
.cw .glare{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .3s;z-index:6}
.cw.live .glare{mix-blend-mode:overlay}
/* zoom overlay */
.zoom{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
 background:rgba(4,3,10,.94);backdrop-filter:blur(10px);padding:20px}
.zoom[hidden]{display:none}
.zoom-stage{perspective:1400px;display:flex;align-items:center;justify-content:center}
.zoom-stage .tcg-card{width:340px!important;transform-style:preserve-3d;box-shadow:0 30px 90px rgba(0,0,0,.7)}
@media(max-width:520px){.zoom-stage .tcg-card{width:76vw!important}}
.zoom-stage .tcg-card.spin{animation:zoomSpin 1.05s cubic-bezier(.2,.7,.2,1)}
@keyframes zoomSpin{0%{transform:rotateY(0) scale(.55);opacity:.2}100%{transform:rotateY(360deg) scale(1);opacity:1}}
.zoom-stage .glare{position:absolute;inset:0;border-radius:inherit;pointer-events:none;mix-blend-mode:overlay;z-index:6;
 background:radial-gradient(circle at 50% 30%,rgba(255,255,255,.4),transparent 55%);opacity:.5}
.zoom-meta{color:#cdd0e6;font-size:14px;text-align:center;z-index:2}
.zoom-meta b{color:#fff}
.zoom-close,.zoom-nav{position:fixed;z-index:62;background:rgba(255,255,255,.1);border:0;color:#fff;cursor:pointer;border-radius:999px}
.zoom-close{top:16px;right:16px;width:44px;height:44px;font-size:18px}
.zoom-nav{top:50%;transform:translateY(-50%);width:52px;height:52px;font-size:30px}
.zoom-prev{left:14px}.zoom-next{right:14px}
.zoom-close:hover,.zoom-nav:hover{background:rgba(255,255,255,.22)}
.credits{position:relative;z-index:1;max-width:760px;margin:0 auto;padding:20px 22px 60px;text-align:center;color:#9598bd;font-size:12.5px;line-height:1.6}
.credits a{color:#9db4ff}
`;

const JS = `
const grid=document.getElementById('grid'),filters=document.getElementById('filters'),artistbar=document.getElementById('artistbar');
const search=document.getElementById('search'),countEl=document.getElementById('count');
const zoom=document.getElementById('zoom'),zoomStage=document.getElementById('zoomStage'),zoomMeta=document.getElementById('zoomMeta');
const ALL=[...POKEMON,...TRAINERS,...ENERGY];
// Marquee ordering: Mega EX → guest → ultra → rare → the rest.
const rank=c=>c.mega?0:c.illus?1:c.rarity==='ultra'?2:c.rarity==='rare'?3:c.kind==='energy'?6:4;
ALL.sort((a,b)=>rank(a)-rank(b)||(a.name||'').localeCompare(b.name||''));
const thumb=a=>/\\/tcg-art\\/[^/]+\\.png$/.test(a||'')?a.replace('/tcg-art/','/tcg-art/thumb/').replace(/\\.png$/,'.jpg'):a;
const ARTISTS=[...new Set(ALL.filter(c=>c.illus).map(c=>c.illus))].sort();
const FILTERS=[['all','All'],['mega','Mega EX'],['guest','Guest Art'],['ultra','Ultra'],['rare','Rare'],
 ['pokemon','Pokémon'],['trainer','Trainers'],['energy','Energy'],
 ['fire','Fire'],['water','Water'],['grass','Grass'],['lightning','Lightning'],['psychic','Psychic'],['fighting','Fighting'],['darkness','Darkness'],['metal','Metal'],['dragon','Dragon'],['fairy','Fairy'],['colorless','Colorless']];
const TYPES=new Set(['fire','water','grass','lightning','psychic','fighting','darkness','metal','dragon','fairy','colorless']);
let active='all', q='';
let view=[];

function matches(c){
  if(q && !((c.name||'').toLowerCase().includes(q))) return false;
  if(active.slice(0,7)==='artist:') return c.illus===active.slice(7);
  switch(active){
    case 'all':return true;
    case 'mega':return !!c.mega;
    case 'guest':return !!c.illus;
    case 'ultra':return c.rarity==='ultra';
    case 'rare':return c.rarity==='rare';
    case 'pokemon':return c.kind==='pokemon';
    case 'trainer':return ['item','supporter','stadium'].includes(c.kind);
    case 'energy':return c.kind==='energy';
    default:return TYPES.has(active) ? (c.type===active || c.energyType===active) : true;
  }
}
function renderChips(){
  filters.innerHTML='';FILTERS.forEach(([k,label])=>{const b=document.createElement('button');b.className='chip'+(k===active?' on':'');b.textContent=label;b.onclick=()=>{active=k;renderChips();renderGrid();};filters.appendChild(b);});
  artistbar.innerHTML='<span class="albl">Guest artists</span>';
  ARTISTS.forEach(n=>{const b=document.createElement('button');b.className='achip'+(active==='artist:'+n?' on':'');b.textContent=n;b.onclick=()=>{active='artist:'+n;renderChips();renderGrid();};artistbar.appendChild(b);});
}
function makeCardNode(card){
  const node=renderTcgCard(card,{size:'full'});
  node.querySelectorAll('img').forEach(im=>{const t=thumb(im.getAttribute('src'));im.setAttribute('src',t);im.setAttribute('loading','lazy');im.setAttribute('decoding','async');});
  const glare=document.createElement('div');glare.className='glare';node.appendChild(glare);
  return {node,glare};
}
function attachTilt(cw){
  const card=cw.querySelector('.tcg-card'),glare=cw.querySelector('.glare');
  cw.addEventListener('pointermove',e=>{
    const r=cw.getBoundingClientRect(),px=(e.clientX-r.left)/r.width,py=(e.clientY-r.top)/r.height;
    cw.classList.add('live');
    card.style.transform='rotateX('+(-(py-.5)*22)+'deg) rotateY('+((px-.5)*24)+'deg) scale(1.07)';
    glare.style.background='radial-gradient(circle at '+(px*100)+'% '+(py*100)+'%, rgba(255,255,255,.4), transparent 45%)';
    glare.style.opacity='1';
  });
  cw.addEventListener('pointerleave',()=>{cw.classList.remove('live');card.style.transform='';glare.style.opacity='0';});
}
function renderGrid(){
  view=ALL.filter(matches);
  countEl.textContent=view.length+' of '+ALL.length+' cards';
  grid.innerHTML='';
  const frag=document.createDocumentFragment();
  view.forEach((card,i)=>{
    const cw=document.createElement('div');cw.className='cw';
    const {node}=makeCardNode(card);
    cw.appendChild(node);
    attachTilt(cw);
    node.addEventListener('click',()=>openZoom(i));
    frag.appendChild(cw);
  });
  grid.appendChild(frag);
}
// ---- zoom + spin ----
let cur=-1;
function openZoom(i){
  cur=i;const card=view[i];
  zoomStage.innerHTML='';
  const node=renderTcgCard(card,{size:'full'}); // full-res art in the zoom
  const glare=document.createElement('div');glare.className='glare';node.appendChild(glare);
  node.classList.add('spin');
  zoomStage.appendChild(node);
  node.addEventListener('animationend',()=>{node.classList.remove('spin');},{once:true});
  // mouse tilt after landing
  zoom.onpointermove=e=>{
    const r=node.getBoundingClientRect(),px=(e.clientX-r.left)/r.width,py=(e.clientY-r.top)/r.height;
    if(node.classList.contains('spin'))return;
    node.style.transform='rotateX('+(-(py-.5)*20)+'deg) rotateY('+((px-.5)*26)+'deg)';
    glare.style.background='radial-gradient(circle at '+(px*100)+'% '+(py*100)+'%, rgba(255,255,255,.5), transparent 50%)';
  };
  const bits=[card.name];
  if(card.illus)bits.push('Illus. '+card.illus);
  if(card.rarity)bits.push(card.rarity.charAt(0).toUpperCase()+card.rarity.slice(1));
  zoomMeta.innerHTML='<b>'+card.name+'</b>'+(card.illus?' · Illus. '+card.illus:'')+(card.mega?' · Mega EX':'');
  zoom.hidden=false;document.body.style.overflow='hidden';
}
function closeZoom(){zoom.hidden=true;document.body.style.overflow='';cur=-1;}
function step(d){if(cur<0)return;openZoom((cur+d+view.length)%view.length);}
document.getElementById('zoomClose').onclick=closeZoom;
document.getElementById('zoomPrev').onclick=()=>step(-1);
document.getElementById('zoomNext').onclick=()=>step(1);
zoom.addEventListener('click',e=>{if(e.target===zoom)closeZoom();});
document.addEventListener('keydown',e=>{if(zoom.hidden)return;if(e.key==='Escape')closeZoom();if(e.key==='ArrowLeft')step(-1);if(e.key==='ArrowRight')step(1);});
search.addEventListener('input',()=>{q=search.value.trim().toLowerCase();renderGrid();});

// Shine toggle — mirrors the in-game setting via the same localStorage key, so
// disabling the foil animation on the laggy 200-card grid sticks across visits.
const SHINE_KEY='tcg-shine-off';
const shineOff=()=>{try{return localStorage.getItem(SHINE_KEY)==='1';}catch{return false;}};
const shineToggle=document.getElementById('shineToggle');
function syncShine(){document.body.classList.toggle('no-shine',shineOff());shineToggle.textContent='✨ Shine: '+(shineOff()?'Off':'On');}
shineToggle.addEventListener('click',()=>{try{localStorage.setItem(SHINE_KEY,shineOff()?'0':'1');}catch{}syncShine();});
syncShine();

renderChips();renderGrid();
`;

function mount(app) {
  app.get("/cards", (req, res) => {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const origin = `${proto}://${req.get("host")}`;
    res.set("content-type", "text/html; charset=utf-8");
    res.set("cache-control", "public, max-age=300");
    res.send(page(origin));
  });
}

module.exports = { mount };
