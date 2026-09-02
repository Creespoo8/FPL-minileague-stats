// ---------- helpers ----------
// Barvy generujeme rovnoměrně po barevném kole podle POČTU manažerů, ne z pevné
// palety — díky tomu nikdy nedojde k tomu, že by dva manažeři měli stejnou barvu
// (dřív se to stávalo, když jich bylo víc než barev v paletě).
const PLAYER_COLORS = (() => {
  const names = DATA.players.map(p=>p.name);
  const n = names.length;
  const map = {};
  names.forEach((name, i) => {
    map[name] = { h: Math.round((360 / n) * i), s: 82, l: 58 };
  });
  return map;
})();
const colorFor = (name, alpha = 1) => {
  const c = PLAYER_COLORS[name];
  if (!c) return `rgba(148,163,184,${alpha})`;
  return `hsla(${c.h}, ${c.s}%, ${c.l}%, ${alpha})`;
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
let sortKey = 'total', sortDir = 1;
function renderTable(){
  const rows = [...DATA.players].sort((a,b)=> (a[sortKey]<b[sortKey]?1:-1) * sortDir);
  const cols = [
    {k:'rank', label:'#'},
    {k:'name', label:'Manažer'},
    {k:'total', label:'Body'},
    {k:'transfer_cost', label:'Body za přestupy'},
    {k:'avg', label:'Průměr/kolo'},
    {k:'form5', label:'Forma (5)'},
    {k:'max', label:'Max'},
    {k:'min', label:'Min'},
    {k:'consistency', label:'Konzistence'},
  ];
  const thead = cols.map(c=>{
    const title = c.k==='consistency' ? ' title="100% × (1 − odchylka bodů / vlastní průměr) — vyšší % = stabilnější výkony"' : '';
    const arrow = sortKey===c.k ? (sortDir===1?' ▼':' ▲') : '';
    return `<th class="${c.k==='name'?'':'num'}" data-key="${c.k}"${title}>${c.label}${arrow}</th>`;
  }).join('');
  const tbody = rows.map(p=>{
    const last8 = p.gws.slice(-8).map(v=>v===null?0:v);
    const maxv = Math.max(...p.gws.filter(v=>v!==null));
    const bars = last8.map(v=>`<i style="height:${Math.max(4,(v/maxv)*20)}px;"></i>`).join('');
    return `<tr>
      <td class="rank">${p.rank}</td>
      <td class="player">${p.name}</td>
      <td class="num total">${p.total}</td>
      <td class="num">${p.transfer_cost}</td>
      <td class="num">${fmt1(p.avg)}</td>
      <td class="num">${p.form5}</td>
      <td class="num">${p.max}</td>
      <td class="num">${p.min}</td>
      <td class="num">${p.consistency===null||p.consistency===undefined?'—':fmt1(p.consistency)+'\u00a0%'}</td>
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
      if(sortKey===k){
        sortDir *= -1;
      } else {
        sortKey = k;
        // Rank a jméno: první klik vzestupně (1, 2, 3… / A-Z).
        // Všechny číselné statistiky: první klik sestupně (nejlepší nahoře).
        sortDir = (k==='rank' || k==='name') ? -1 : 1;
      }
      renderTable();
    });
  });
}
renderTable();

// ---------- CHART ----------
let chartDrawn = false;
function drawChart(){
  chartDrawn = true;
  const panel = document.getElementById('panel-chart');
  panel.innerHTML = `
    <div class="card">
      <h2>Vývoj pořadí v kolech</h2>
      <p class="sub">Najeď myší na jméno vpravo pro zvýraznění, klikni pro schování/zobrazení. 1. místo = vede ligu po daném kole.</p>
      <div class="chart-wrap">
        <canvas id="gwChart"></canvas>
        <div id="rankLabels" style="position:absolute; top:0; left:0; height:100%; width:100%; pointer-events:none;"></div>
      </div>
    </div>`;

  // Kolik kol už bylo odehráno (aspoň jeden manažer má non-null skóre) —
  // dál za tímto bodem necháváme v datech null, aby graf měl mezeru, ne umělou rovnou čáru.
  let lastPlayedIdx = -1;
  DATA.players.forEach(p=>{
    p.gws.forEach((v, idx)=>{ if(v !== null && idx > lastPlayedIdx) lastPlayedIdx = idx; });
  });
  const numGW = lastPlayedIdx + 1;
  const totalGW = DATA.gw_labels.length; // vždy 38, i když se ještě neodehrálo

  // Kumulativní body po jednotlivých odehraných kolech.
  const cumulative = {};
  DATA.players.forEach(p=>{
    let sum = 0;
    cumulative[p.name] = [];
    for(let i=0;i<numGW;i++){
      sum += (p.gws[i] || 0);
      cumulative[p.name].push(sum);
    }
  });

  // Z kumulativních bodů spočítáme pořadí (1 = nejvíc bodů) po každém odehraném kole,
  // zbytek sezóny (dosud neodehraná kola) necháme jako null.
  const positions = {};
  DATA.players.forEach(p=>{ positions[p.name] = new Array(totalGW).fill(null); });
  for(let i=0;i<numGW;i++){
    const snapshot = DATA.players.map(p=>({name:p.name, pts:cumulative[p.name][i]}));
    snapshot.sort((a,b)=> b.pts - a.pts);
    snapshot.forEach((s, rankIdx)=>{ positions[s.name][i] = rankIdx+1; });
  }

  // Jména napravo od grafu — poziciovaná dynamicky na výšku posledního odehraného
  // bodu dané křivky, takže vždy odpovídají aktuálnímu pořadí manažera.
  const rankLabelsEl = document.getElementById('rankLabels');
  const labelEls = DATA.players.map(p=>{
    const el = document.createElement('div');
    el.textContent = p.name;
    el.style.position = 'absolute';
    el.style.fontSize = '13px';
    el.style.fontWeight = '600';
    el.style.color = colorFor(p.name, 1);
    el.style.whiteSpace = 'nowrap';
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.style.transform = 'translateY(-50%)';
    rankLabelsEl.appendChild(el);
    return el;
  });

  let chart = null;
  function positionLabels(){
    if(!chart) return;
    const area = chart.chartArea;
    DATA.players.forEach((p,i)=>{
      const meta = chart.getDatasetMeta(i);
      let lastIdx = -1;
      for(let j=chart.data.datasets[i].data.length-1;j>=0;j--){
        if(chart.data.datasets[i].data[j] !== null){ lastIdx = j; break; }
      }
      const el = labelEls[i];
      if(lastIdx === -1 || meta.hidden){
        el.style.opacity = meta.hidden ? '0.3' : '0';
        return;
      }
      el.style.opacity = '1';
      const point = meta.data[lastIdx];
      el.style.top = point.y + 'px';
      el.style.left = (area.right + 10) + 'px';
    });
  }
  const positionPlugin = { id:'positionPlugin', afterRender(){ positionLabels(); } };

  const ctx = document.getElementById('gwChart').getContext('2d');
  const datasets = DATA.players.map(p=>({
    label: p.name,
    data: positions[p.name],
    borderColor: colorFor(p.name),
    backgroundColor: colorFor(p.name),
    borderWidth: 2.5,
    pointRadius: 2,
    pointHoverRadius: 5,
    tension: 0.25,
    spanGaps: false,
  }));
  chart = new Chart(ctx, {
    type:'line',
    data:{ labels: DATA.gw_labels.map(l=>l.replace('GW ','')), datasets },
    plugins:[positionPlugin],
    options:{
      responsive:true, maintainAspectRatio:false,
      layout:{ padding:{ right: 170 } },
      interaction:{mode:'index', intersect:false},
      plugins:{ legend:{display:false},
        tooltip:{
          itemSort:(a,b)=> a.parsed.y - b.parsed.y,
          filter:(item)=> item.parsed.y !== null,
          callbacks:{
            title:(items)=> 'GW '+items[0].label,
            label:(item)=> `${item.parsed.y}. ${item.dataset.label}`
          }
        } },
      scales:{
        x:{ grid:{color:'rgba(242,238,244,0.06)'}, ticks:{color:'#c6b9cb', maxTicksLimit:12} },
        y:{
          reverse:true,
          min:1,
          max:DATA.players.length,
          ticks:{color:'#c6b9cb', stepSize:1, precision:0},
          grid:{color:'rgba(242,238,244,0.06)'}
        }
      }
    }
  });

  labelEls.forEach((el,i)=>{
    el.addEventListener('mouseenter', ()=>{
      chart.data.datasets.forEach((ds,j)=>{
        const isTarget = j===i;
        ds.borderColor = colorFor(ds.label, isTarget ? 1 : 0.1);
        ds.borderWidth = isTarget ? 4 : 2.5;
        labelEls[j].style.opacity = isTarget ? '1' : '0.25';
      });
      chart.update('none');
    });
    el.addEventListener('mouseleave', ()=>{
      chart.data.datasets.forEach((ds,j)=>{
        ds.borderColor = colorFor(ds.label, 1);
        ds.borderWidth = 2.5;
        labelEls[j].style.opacity = '1';
      });
      chart.update('none');
    });
    el.addEventListener('click', ()=>{
      const meta = chart.getDatasetMeta(i);
      meta.hidden = !meta.hidden;
      chart.update();
    });
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
