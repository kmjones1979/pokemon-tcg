// Public art gallery at /art — an epic showcase of every bespoke illustration
// generated for the TCG mode (Pokémon full-arts + Trainer art), with a lightbox
// and social sharing. Deep-linkable via /art?card=<id> which injects Open Graph
// meta so the shared card unfurls as a rich image on X / LinkedIn / iMessage.
//
// Credits The Pokémon Company for the characters and names the guest-artist
// styles used for stylistic generation.

let _cards = null;

// Guest-artist styles used to generate the marquee Ultra full-arts.
const GUEST_ARTISTS = [
  "Akira Toriyama", "Eiichiro Oda", "Hayao Miyazaki",
  "Roy Lichtenstein", "Killer Acid", "Osamu Tezuka",
];

async function loadCards() {
  if (_cards) return _cards;
  const { POKEMON, TRAINERS } = await import("../client/js/tcg/catalog.js");
  const pokes = POKEMON
    .filter((c) => c.genArt && c.art)
    .map((c) => ({
      id: c.id, name: c.name, art: c.art, type: c.type,
      rarity: c.rarity, stage: c.stage, illus: c.illus || null,
      mega: !!c.mega, ex: !!c.ex, kind: "pokemon",
    }));
  const trainers = TRAINERS
    .filter((c) => c.artStyle === "art" && c.art)
    .map((c) => ({
      id: c.id, name: c.name, art: c.art, type: c.kind,
      rarity: c.rarity, stage: null, illus: null, mega: false, ex: false, kind: "trainer",
    }));
  // Marquee first: Mega EX, then guest-artist Ultras, then other Ultras/Rares,
  // then the rest — so the gallery opens on its best work.
  const rank = (c) => (c.mega ? 0 : c.illus ? 1 : c.rarity === "ultra" ? 2 : c.rarity === "rare" ? 3 : 4);
  _cards = [...pokes, ...trainers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return _cards;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

function page(cards, origin, focus) {
  const data = JSON.stringify(cards).replace(/</g, "\\u003c");
  const og = focus || cards[0];
  const ogTitle = focus ? `${focus.name} — Pokémon Battle Art` : "Pokémon Battle — Art Gallery";
  const ogDesc = focus
    ? `${focus.name}${focus.illus ? `, illustrated in the style of ${focus.illus}` : ""} — one of hundreds of AI-generated cards for Pokémon Battle.`
    : "An epic gallery of AI-generated Pokémon TCG artwork — Mega EX full-arts, guest-artist Illustration Rares, and more.";
  const canonical = `${origin}/art${focus ? `?card=${encodeURIComponent(focus.id)}` : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(ogTitle)}</title>
<meta name="description" content="${esc(ogDesc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:image" content="${esc(og.art)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:image" content="${esc(og.art)}">
<style>${CSS}</style>
</head>
<body>
<div class="aurora"></div>
<header class="hero">
  <a class="back" href="/">← Pokémon Battle</a>
  <h1>Art Gallery</h1>
  <p class="sub">Every card in the TCG mode is illustrated with bespoke AI art — Mega&nbsp;EX full-arts, guest-artist Illustration Rares, and a whole Pokédex of styles. Tap any piece to enlarge and share.</p>
  <div class="filters" id="filters"></div>
</header>
<main id="grid" class="grid"></main>
<footer class="credits">
  <p><b>Pokémon</b>, character names and designs are © The Pokémon Company, Nintendo, Game&nbsp;Freak. This is a non-commercial fan project. Base reference artwork via <a href="https://pokeapi.co" target="_blank" rel="noopener">PokéAPI</a>.</p>
  <p>Card illustrations were AI-generated in the styles of celebrated illustrators, including our Guest Artists: ${GUEST_ARTISTS.map((a) => `<span>${esc(a)}</span>`).join(" · ")}. Styles are homages; no affiliation or endorsement is implied.</p>
</footer>

<div class="lightbox" id="lightbox" hidden>
  <button class="lb-close" id="lbClose" aria-label="Close">✕</button>
  <button class="lb-nav lb-prev" id="lbPrev" aria-label="Previous">‹</button>
  <button class="lb-nav lb-next" id="lbNext" aria-label="Next">›</button>
  <div class="lb-inner">
    <div class="lb-imgwrap"><img id="lbImg" alt=""></div>
    <div class="lb-meta">
      <div class="lb-badges" id="lbBadges"></div>
      <h2 id="lbName"></h2>
      <div class="lb-illus" id="lbIllus"></div>
      <div class="lb-share">
        <button class="share native" data-share="native">Share</button>
        <a class="share x" data-share="x" target="_blank" rel="noopener">X</a>
        <a class="share li" data-share="li" target="_blank" rel="noopener">LinkedIn</a>
        <a class="share em" data-share="email">Email</a>
        <a class="share sms" data-share="sms">Text</a>
        <button class="share copy" data-share="copy">Copy link</button>
      </div>
      <div class="lb-hint" id="lbHint">On phones, “Share” opens Instagram, Messages &amp; more.</div>
    </div>
  </div>
</div>

<script>
const CARDS = ${data};
const ORIGIN = ${JSON.stringify(origin)};
const FOCUS = ${JSON.stringify(focus ? focus.id : null)};
${JS}
</script>
</body>
</html>`;
}

const CSS = `
:root{--bg:#0a0812;--card:#141122;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:#eef;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
.aurora{position:fixed;inset:-30% -10% auto;height:70vh;z-index:0;pointer-events:none;filter:blur(70px);opacity:.55;
 background:radial-gradient(40% 60% at 20% 30%,#ff5f6d55,transparent),radial-gradient(45% 55% at 80% 20%,#6a9bff55,transparent),radial-gradient(50% 50% at 55% 70%,#c86bff55,transparent);
 animation:drift 18s ease-in-out infinite alternate}
@keyframes drift{to{transform:translateY(30px) scale(1.1)}}
.hero{position:relative;z-index:1;text-align:center;padding:44px 20px 22px;max-width:820px;margin:0 auto}
.back{display:inline-block;font-size:13px;opacity:.7;margin-bottom:16px}
.back:hover{opacity:1}
h1{font-size:clamp(38px,8vw,76px);font-weight:900;letter-spacing:-1px;line-height:1;
 background:linear-gradient(90deg,#ff5f6d,#ffc371,#47e0a0,#6a9bff,#c86bff);-webkit-background-clip:text;background-clip:text;color:transparent;
 background-size:200% auto;animation:sheen 6s linear infinite}
@keyframes sheen{to{background-position:200% center}}
.sub{margin:16px auto 0;max-width:620px;color:#b9bce0;font-size:15px;line-height:1.5}
.filters{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:22px}
.chip{padding:7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#cdd0e6;font-size:13px;font-weight:600;cursor:pointer;text-transform:capitalize;transition:.15s}
.chip:hover{background:rgba(255,255,255,.12)}
.chip.on{background:#fff;color:#111;border-color:#fff}
.grid{position:relative;z-index:1;column-count:4;column-gap:14px;padding:24px clamp(12px,3vw,40px) 40px;max-width:1500px;margin:0 auto}
@media(max-width:1200px){.grid{column-count:3}}
@media(max-width:820px){.grid{column-count:2}}
@media(max-width:480px){.grid{column-count:2;column-gap:8px;padding:16px 8px}}
.tile{break-inside:avoid;margin:0 0 14px;position:relative;border-radius:14px;overflow:hidden;cursor:pointer;background:var(--card);
 border:1px solid rgba(255,255,255,.08);box-shadow:0 6px 18px rgba(0,0,0,.4);transition:transform .18s ease,box-shadow .18s ease}
.tile:hover{transform:translateY(-4px);box-shadow:0 16px 34px rgba(0,0,0,.55)}
.tile img{display:block;width:100%;height:auto;background:#0d0b16}
.tile .cap{position:absolute;left:0;right:0;bottom:0;padding:26px 12px 10px;opacity:0;transition:.2s;
 background:linear-gradient(180deg,transparent,rgba(0,0,0,.82));font-weight:700;font-size:14px}
.tile:hover .cap{opacity:1}
.tile .cap small{display:block;font-weight:600;font-size:11px;opacity:.85;margin-top:2px}
.tag{position:absolute;top:8px;left:8px;font-size:9px;font-weight:900;letter-spacing:.4px;padding:3px 8px;border-radius:6px;color:#2a1c02;
 background:linear-gradient(90deg,#ffe08a,#ffb43d);box-shadow:0 2px 6px rgba(0,0,0,.4)}
.tag.guest{background:linear-gradient(90deg,#c86bff,#6a9bff);color:#fff}
.tag.ultra{background:linear-gradient(90deg,#ff5f6d,#ffc371);color:#2a1002}
.credits{position:relative;z-index:1;max-width:760px;margin:0 auto;padding:26px 22px 60px;text-align:center;color:#9598bd;font-size:12.5px;line-height:1.6}
.credits a{color:#9db4ff}
.credits span{color:#cdd0e6}
/* lightbox */
.lightbox{position:fixed;inset:0;z-index:50;background:rgba(4,3,10,.92);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px}
.lightbox[hidden]{display:none}
.lb-inner{display:flex;gap:26px;align-items:center;max-width:1100px;width:100%;max-height:92vh}
.lb-imgwrap{flex:1 1 60%;display:flex;align-items:center;justify-content:center;min-width:0}
.lb-imgwrap img{max-width:100%;max-height:88vh;border-radius:14px;box-shadow:0 20px 70px rgba(0,0,0,.7)}
.lb-meta{flex:0 0 300px;max-width:300px}
.lb-badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.lb-badge{font-size:10px;font-weight:900;letter-spacing:.4px;padding:3px 9px;border-radius:6px;text-transform:uppercase}
.b-mega{background:linear-gradient(90deg,#ffe08a,#ffb43d);color:#2a1c02}
.b-guest{background:linear-gradient(90deg,#c86bff,#6a9bff);color:#fff}
.b-type{background:rgba(255,255,255,.12);color:#dfe2ff}
.lb-meta h2{font-size:30px;font-weight:900;line-height:1.05;margin-bottom:6px}
.lb-illus{color:#b9bce0;font-size:14px;margin-bottom:20px}
.lb-illus b{color:#fff}
.lb-share{display:flex;flex-wrap:wrap;gap:8px}
.share{padding:9px 14px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#eef}
.share:hover{background:rgba(255,255,255,.16)}
.share.native{background:linear-gradient(90deg,#6a9bff,#c86bff);border:0;color:#fff}
.share.x{background:#111;border-color:#333}
.share.li{background:#0a66c2;border:0;color:#fff}
.share.copy.done{background:#2ec46a;border:0;color:#062}
.lb-hint{margin-top:14px;font-size:11px;color:#8a8daf}
.lb-close,.lb-nav{position:fixed;z-index:52;background:rgba(255,255,255,.1);border:0;color:#fff;cursor:pointer;border-radius:999px}
.lb-close{top:16px;right:16px;width:44px;height:44px;font-size:18px}
.lb-nav{top:50%;transform:translateY(-50%);width:52px;height:52px;font-size:30px;line-height:1}
.lb-prev{left:14px}.lb-next{right:14px}
.lb-close:hover,.lb-nav:hover{background:rgba(255,255,255,.22)}
@media(max-width:760px){.lb-inner{flex-direction:column;gap:12px;overflow:auto}.lb-meta{flex:none;max-width:100%;text-align:center}.lb-share{justify-content:center}.lb-badges{justify-content:center}.lb-imgwrap img{max-height:56vh}.lb-nav{width:42px;height:42px;font-size:24px}}
`;

const JS = `
const grid=document.getElementById('grid'),filters=document.getElementById('filters');
const lb=document.getElementById('lightbox');
let cur=-1,view=CARDS.slice();
const typeOf=c=>c.type;
const FILTERS=[['all','All'],['mega','Mega EX'],['guest','Guest Artists'],['ultra','Ultra'],['rare','Rare'],
 ['fire','Fire'],['water','Water'],['grass','Grass'],['lightning','Lightning'],['psychic','Psychic'],['fighting','Fighting'],['darkness','Darkness'],['metal','Metal'],['colorless','Colorless']];
let active='all';
function match(c){switch(active){case 'all':return true;case 'mega':return c.mega;case 'guest':return !!c.illus;case 'ultra':return c.rarity==='ultra';case 'rare':return c.rarity==='rare';default:return c.type===active;}}
function renderChips(){filters.innerHTML='';FILTERS.forEach(([k,label])=>{const b=document.createElement('button');b.className='chip'+(k===active?' on':'');b.textContent=label;b.onclick=()=>{active=k;renderChips();renderGrid();};filters.appendChild(b);});}
function tag(c){if(c.mega)return '<span class="tag">MEGA EX</span>';if(c.illus)return '<span class="tag guest">GUEST</span>';if(c.rarity==='ultra')return '<span class="tag ultra">ULTRA</span>';return '';}
function renderGrid(){view=CARDS.filter(match);grid.innerHTML='';view.forEach((c,i)=>{const t=document.createElement('div');t.className='tile';t.innerHTML=tag(c)+'<img loading="lazy" src="'+c.art+'" alt="'+c.name+'"><div class="cap">'+c.name+(c.illus?'<small>Illus. '+c.illus+'</small>':'')+'</div>';t.onclick=()=>open(i);grid.appendChild(t);});}
function open(i){cur=i;const c=view[i];document.getElementById('lbImg').src=c.art;document.getElementById('lbImg').alt=c.name;document.getElementById('lbName').textContent=c.name;
 const badges=[];if(c.mega)badges.push('<span class="lb-badge b-mega">Mega EX</span>');if(c.illus)badges.push('<span class="lb-badge b-guest">Guest Artist</span>');badges.push('<span class="lb-badge b-type">'+c.type+'</span>');
 document.getElementById('lbBadges').innerHTML=badges.join('');
 document.getElementById('lbIllus').innerHTML=c.illus?'Illustrated in the style of <b>'+c.illus+'</b>':'AI-generated illustration';
 wireShare(c);lb.hidden=false;document.body.style.overflow='hidden';history.replaceState(null,'',ORIGIN+'/art?card='+encodeURIComponent(c.id));}
function close(){lb.hidden=true;document.body.style.overflow='';cur=-1;history.replaceState(null,'',ORIGIN+'/art');}
function step(d){if(cur<0)return;open((cur+d+view.length)%view.length);}
function shareUrl(c){return ORIGIN+'/art?card='+encodeURIComponent(c.id);}
function shareText(c){return c.name+(c.illus?' — illustrated in the style of '+c.illus:'')+' · Pokémon Battle Art Gallery';}
function wireShare(c){const url=shareUrl(c),text=shareText(c);
 const x=document.querySelector('[data-share=x]');x.href='https://twitter.com/intent/tweet?text='+encodeURIComponent(text)+'&url='+encodeURIComponent(url);
 const li=document.querySelector('[data-share=li]');li.href='https://www.linkedin.com/sharing/share-offsite/?url='+encodeURIComponent(url);
 const em=document.querySelector('[data-share=email]');em.href='mailto:?subject='+encodeURIComponent(c.name+' — Pokémon Battle Art')+'&body='+encodeURIComponent(text+'\\n\\n'+url);
 const sms=document.querySelector('[data-share=sms]');sms.href='sms:?&body='+encodeURIComponent(text+' '+url);
 const nat=document.querySelector('[data-share=native]');nat.style.display=navigator.share?'':'none';
 nat.onclick=()=>{navigator.share&&navigator.share({title:c.name+' — Pokémon Battle',text,url}).catch(()=>{});};
 const cp=document.querySelector('[data-share=copy]');cp.classList.remove('done');cp.textContent='Copy link';
 cp.onclick=()=>{navigator.clipboard.writeText(url).then(()=>{cp.classList.add('done');cp.textContent='Copied!';setTimeout(()=>{cp.classList.remove('done');cp.textContent='Copy link';},1600);});};}
document.getElementById('lbClose').onclick=close;
document.getElementById('lbPrev').onclick=()=>step(-1);
document.getElementById('lbNext').onclick=()=>step(1);
lb.onclick=e=>{if(e.target===lb)close();};
document.addEventListener('keydown',e=>{if(lb.hidden)return;if(e.key==='Escape')close();if(e.key==='ArrowLeft')step(-1);if(e.key==='ArrowRight')step(1);});
renderChips();renderGrid();
if(FOCUS){const i=view.findIndex(c=>c.id===FOCUS);if(i>=0)open(i);}
`;

function mount(app) {
  app.get("/art", async (req, res) => {
    try {
      const cards = await loadCards();
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
      const origin = `${proto}://${req.get("host")}`;
      const focusId = req.query.card ? String(req.query.card) : null;
      const focus = focusId ? cards.find((c) => c.id === focusId) || null : null;
      res.set("content-type", "text/html; charset=utf-8");
      res.set("cache-control", "public, max-age=300");
      res.send(page(cards, origin, focus));
    } catch (err) {
      console.error("[art-gallery]", err);
      res.status(500).send("Gallery unavailable.");
    }
  });
}

module.exports = { mount };
