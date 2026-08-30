// ---------- helpers ----------
const PALETTE = ['#00ff85','#e90052','#04f5ff','#ffd166','#c084fc','#ff8c42','#63e6be','#f472b6','#a3e635','#94a3b8'];
const colorFor = (name) => {
  const names = DATA.players.map(p=>p.name);
  const idx = names.indexOf(name);
  return PALETTE[idx % PALETTE.length];
};
const fmt1 = (v) => (v===null || v===undefined) ? '—' : (Math.round(v*10)/10).toString().replace('.', ',');
const monthCz = {August:'srpen',September:'září',October:'říjen',November:'listopad',December:'prosinec',January:'leden',February:'únor',March:'březen',April:'duben',May:'květen'};

const app = document.getElementById('app');
document.title = `${DATA.league_name} — FPL Minileague`;

// ---------- HERO ----------
const leader = [...DATA.players].sort((a,b)=>b.total-a.total)[0];
const heroHTML = `
  <div class="hero">
    <div class="hero-left">
      <p class="eyebrow">${DATA.league_name}</p>
      <h1>Sezónní přehled ${DATA.season || ''}</h1>
      <p>Statistiky ${DATA.players.length} manažerů napříč ${DATA.gw_labels.length} koly — body, forma, rekordy a měsíční vítězové na jednom místě.</p>
    </div>
    <div class="leader-card">
      <div class="label">Vede sezónu</div>
      <div class="name">${leader.name}</div>
      <div class="points">${leader.total}<span>bodů</span></div>
    </div>
  </div>
  <nav id="nav"></nav>
  <section class="panel" id="panel-table"></section>
  <section class="panel" id="panel-chart"></section>
  <section class="panel" id="panel-records"></section>
  <section class="panel" id="panel-motm"></section>
  <section class="panel" id="panel-wl"></section>
  <footer>Data z FPL API${DATA.generated_at ? ' · aktualizováno ' + DATA.generated_at.replace('T',' ').replace('Z',' UTC') : ''} · ${DATA.gw_labels[0]}–${DATA.gw_labels[DATA.gw_labels.length-1]}</footer>
`;
app.innerHTML = heroHTML;

// ---------- NAV ----------
const tabs = [
  {id:'table', label:'Tabulka'},
  {id:'chart', label:'Vývoj v kolech'},
  {id:'records', label:'Rekordy'},
  {id:'motm', label:'Manažer měsíce'},
  {id:'wl', label:'Výhry & prohry kola'},
];
const nav = document.getElementById('nav');
nav.innerHTML = tabs.map((t,i)=>`<button data-tab="${t.id}" class="${i===0?'active':''}">${t.label}</button>`).join('');
nav.addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('section.panel').forEach(s=>s.classList.remove('active'));
  document.getElementById('panel-'+btn.dataset.tab).classList.add('active');
  if(btn.dataset.tab==='chart' && !chartDrawn) drawChart();
});
document.getElementById('panel-table').classList.add('active');

// ---------- TABLE ----------
let sortKey = 'total', sortDir = -1;
function renderTable(){
  const rows = [...DATA.players].sort((a,b)=> (a[sortKey]<b[sortKey]?1:-1) * sortDir);
  const cols = [
    {k:'rank', label:'#'},
    {k:'name', label:'Manažer'},
    {k:'total', label:'Body'},
    {k:'avg', label:'Průměr/kolo'},
    {k:'form5', label:'Forma (5)'},
    {k:'max', label:'Max'},
    {k:'min', label:'Min'},
    {k:'sd', label:'Kolísavost'},
    {k:'transfer_cost', label:'Body za přestupy'},
  ];
  const thead = cols.map(c=>`<th class="${c.k==='name'?'':'num'}" data-key="${c.k}">${c.label}${sortKey===c.k?(sortDir===1?' ▲':' ▼'):''}</th>`).join('');
  const tbody = rows.map(p=>{
    const last8 = p.gws.slice(-8).map(v=>v===null?0:v);
    const maxv = Math.max(...p.gws.filter(v=>v!==null));
    const bars = last8.map(v=>`<i style="height:${Math.max(4,(v/maxv)*20)}px;"></i>`).join('');
    return `<tr>
      <td class="rank">${p.rank}</td>
      <td class="player">${p.name}</td>
      <td class="num total">${p.total}</td>
      <td class="num">${fmt1(p.avg)}</td>
      <td class="num">${p.form5}</td>
      <td class="num">${p.max}</td>
      <td class="num">${p.min}</td>
      <td class="num">${fmt1(p.sd)}</td>
      <td class="num">${p.transfer_cost}</td>
    </tr>`;
  }).join('');
  document.getElementById('panel-table').innerHTML = `
    <div class="card">
      <h2>Celková tabulka</h2>
      <p class="sub">Klikni na název sloupce pro seřazení. Posledních 8 mini sloupečků v hlavě zatím netěžíme — forma je vidět v grafu.</p>
      <div class="table-scroll">
        <table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
      </div>
    </div>`;
  document.querySelectorAll('#panel-table th[data-key]').forEach(th=>{
    th.addEventListener('click', ()=>{
      const k = th.dataset.key;
      if(sortKey===k) sortDir *= -1; else {sortKey=k; sortDir=-1;}
      renderTable();
    });
  });
}
renderTable();

// ---------- CHART ----------
let chartDrawn = false;
let activeNames = new Set(DATA.players.map(p=>p.name));
function drawChart(){
  chartDrawn = true;
  const panel = document.getElementById('panel-chart');
  panel.innerHTML = `
    <div class="card">
      <h2>Vývoj kumulativních bodů</h2>
      <p class="sub">Klikni na jméno a schovej/zobraz křivku manažera.</p>
      <div class="legend-pills" id="legend"></div>
      <div class="chart-wrap"><canvas id="gwChart"></canvas></div>
    </div>`;
  const legend = document.getElementById('legend');
  legend.innerHTML = DATA.players.map(p=>`<span class="pill on" style="border-color:${colorFor(p.name)}; background:${colorFor(p.name)}22;" data-name="${p.name}">${p.name}</span>`).join('');

  const cumulative = {};
  DATA.players.forEach(p=>{
    let sum = 0;
    cumulative[p.name] = p.gws.map(v=>{ sum += (v||0); return sum; });
  });

  const ctx = document.getElementById('gwChart').getContext('2d');
  const datasets = DATA.players.map(p=>({
    label: p.name,
    data: cumulative[p.name],
    borderColor: colorFor(p.name),
    backgroundColor: colorFor(p.name),
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    tension: 0.25,
  }));
  const chart = new Chart(ctx, {
    type:'line',
    data:{ labels: DATA.gw_labels.map(l=>l.replace('GW ','')), datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'nearest', intersect:false},
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{ title:(items)=> 'GW '+items[0].label } } },
      scales:{
        x:{ grid:{color:'rgba(242,238,244,0.06)'}, ticks:{color:'#c6b9cb', maxTicksLimit:12} },
        y:{ grid:{color:'rgba(242,238,244,0.06)'}, ticks:{color:'#c6b9cb'} }
      }
    }
  });

  legend.addEventListener('click', (e)=>{
    const pill = e.target.closest('.pill');
    if(!pill) return;
    const name = pill.dataset.name;
    const ds = chart.data.datasets.find(d=>d.label===name);
    const idx = chart.data.datasets.indexOf(ds);
    const meta = chart.getDatasetMeta(idx);
    meta.hidden = !meta.hidden;
    pill.classList.toggle('on', !meta.hidden);
    chart.update();
  });
}

// ---------- RECORDS ----------
function renderRecords(){
  const bestRows = DATA.best.map(r=>`
    <div class="rec-row">
      <span class="rec-rank">${r.rank}.</span>
      <span class="rec-name">${r.name}</span>
      <span class="rec-meta">${r.gw}</span>
      <span class="rec-pts good">${r.points}</span>
    </div>`).join('');
  const worstRows = DATA.worst.map(r=>`
    <div class="rec-row">
      <span class="rec-rank">${r.rank}.</span>
      <span class="rec-name">${r.name}</span>
      <span class="rec-meta">${r.gw}</span>
      <span class="rec-pts bad">${r.points}</span>
    </div>`).join('');
  document.getElementById('panel-records').innerHTML = `
    <div class="card">
      <h2>Nejlepší a nejhorší výkony v kole</h2>
      <p class="sub">TOP záznamy napříč celou sezónou, bez ohledu na to, kdo je zrovna nahoře v tabulce.</p>
      <div class="records-grid">
        <div><h3 style="font-size:14px;color:var(--green);margin:0 0 8px;">Nejlepší kola</h3>${bestRows}</div>
        <div><h3 style="font-size:14px;color:var(--pink);margin:0 0 8px;">Nejhorší kola</h3>${worstRows}</div>
      </div>
    </div>`;
}
renderRecords();

// ---------- MOTM ----------
function renderMotm(){
  const rows = DATA.motm.map(m=>`
    <div class="motm-row">
      <div class="motm-month">${monthCz[m.month]||m.month}</div>
      <div class="medal"><span class="medal-dot" style="background:var(--gold);"></span><div><div class="medal-name">${m.gold.name}</div><div class="medal-pts">${m.gold.points} b.</div></div></div>
      <div class="medal"><span class="medal-dot" style="background:#c9c9d4;"></span><div><div class="medal-name">${m.silver.name}</div><div class="medal-pts">${m.silver.points} b.</div></div></div>
      <div class="medal"><span class="medal-dot" style="background:#cd8a4d;"></span><div><div class="medal-name">${m.bronze.name}</div><div class="medal-pts">${m.bronze.points} b.</div></div></div>
    </div>`).join('');
  document.getElementById('panel-motm').innerHTML = `
    <div class="card">
      <h2>Manažer měsíce</h2>
      <p class="sub">Součet bodů v rámci kalendářního měsíce — zlato, stříbro, bronz.</p>
      <div class="motm-list">${rows}</div>
    </div>`;
}
renderMotm();

// ---------- WIN/LOSE ----------
function renderWL(){
  const maxWin = Math.max(...DATA.winners.map(w=>w.count));
  const maxLose = Math.max(...DATA.losers.map(w=>w.count));
  const winRows = DATA.winners.map(w=>`
    <div class="wl-row">
      <span class="wl-name">${w.name}</span>
      <div class="wl-track"><div class="wl-fill" style="width:${(w.count/maxWin)*100}%; background:var(--green);"></div></div>
      <span class="wl-count">${w.count}</span>
    </div>`).join('');
  const loseRows = DATA.losers.map(w=>`
    <div class="wl-row">
      <span class="wl-name">${w.name}</span>
      <div class="wl-track"><div class="wl-fill" style="width:${(w.count/maxLose)*100}%; background:var(--pink);"></div></div>
      <span class="wl-count">${w.count}</span>
    </div>`).join('');
  document.getElementById('panel-wl').innerHTML = `
    <div class="card">
      <h2>Kolikrát kdo vyhrál / prohrál kolo</h2>
      <p class="sub">Počet kol, ve kterých byl daný manažer nejlepší, respektive nejhorší z miniligy.</p>
      <div class="records-grid">
        <div><h3 style="font-size:14px;color:var(--green);margin:0 0 12px;">Výhry kola</h3><div class="wl-bars">${winRows}</div></div>
        <div><h3 style="font-size:14px;color:var(--pink);margin:0 0 12px;">Prohry kola</h3><div class="wl-bars">${loseRows}</div></div>
      </div>
    </div>`;
}
renderWL();
