/* OrbitTrader Manager Pro — shared demo-account book layer (manager.html only).
 * The manager previously showed 14 fabricated clients ("Ahmed Khan" etc.) with
 * invented balances. This layer replaces that with the REAL demo accounts the
 * Trader app on this device stores in localStorage key `orbit-accts`
 * ({id,label,balance,positions,orders,deals,deposits}), and badges every
 * client-performance figure as PAPER. Manager-only metadata (notes, tags,
 * leverage, group, blocked, credit) is preserved per login across syncs.
 * Manager dealing actions that move money (force-close, stop-out, approved
 * deposit/withdraw, balance adjust, SL/TP, order cancel) are written back to
 * `orbit-accts` so the Trader app stays in sync. Never touches api.js.
 */
(function(){
"use strict";
var ACCT="orbit-accts";

function num(x){var n=+x;return isFinite(n)?n:x;}
function readAccts(){try{var a=JSON.parse(localStorage.getItem(ACCT)||"[]");return Array.isArray(a)?a:[];}catch(e){return[];}}

/* ---------- sync shared demo accounts into the manager book ---------- */
function syncBook(){
  var as=readAccts();
  if(!S.mpSeq)S.mpSeq=100000;
  var logins={};as.forEach(function(a){logins[num(a.id)]=true;});
  var hasLogin=function(l){return logins[num(l)]===true;};

  // 1) clients: drop anything not in the shared book, upsert the rest
  S.clients=S.clients.filter(function(c){return hasLogin(c.login);});
  as.forEach(function(a){
    var login=num(a.id);
    var c=S.clients.find(function(x){return num(x.login)===login;});
    if(!c){
      c={login:login,name:"",group:"std",balance:0,credit:0,lev:100,blocked:false,
         notes:"",tags:[],docs:{id:false,poa:false},ib:null,logins:[],paper:true,depNet:0};
      S.clients.push(c);
    }
    c.name=String(a.label||("Demo "+a.id));
    c.balance=+a.balance||0;
    c.paper=true;
    c.lastSeen=+a.lastSeen||null;
    c.depNet=(a.deposits||[]).reduce(function(t,d){return t+(+d.amount||0);},0);
    // 2) positions (manager-unique ids; tid keeps the trader-side id)
    S.positions=S.positions.filter(function(p){return num(p.client)!==login;});
    (a.positions||[]).forEach(function(p){
      S.positions.push({id:S.mpSeq++,tid:p.id,client:login,sym:p.sym,dir:p.dir,
        vol:+p.vol||0,open:+p.open||0,sl:p.sl==null?null:+p.sl,tp:p.tp==null?null:+p.tp,
        time:p.time||Date.now(),ts:p.ts||0,beT:p.beT||0,beO:p.beO||0,swap:p.swap||0,fill:p.fill||"FOK"});
    });
    // 3) pending orders
    S.orders=S.orders.filter(function(o){return num(o.client)!==login;});
    (a.orders||[]).forEach(function(o){
      S.orders.push({id:S.mpSeq++,tid:o.id,client:login,sym:o.sym,dir:o.dir,vol:+o.vol||0,
        type:o.type||"buy limit",price:+o.price||0,limitPx:o.limitPx==null?null:+o.limitPx,
        sl:o.sl==null?null:+o.sl,tp:o.tp==null?null:+o.tp,expiry:"GTC",time:o.time||Date.now()});
    });
    // 4) closed deals: drop seeded demos unconditionally (provenance-tagged),
    //    keep manager-created `mgr` deals alongside shared ones.
    //    v5.8 A01: trader-mapped deals are tagged tmap+tid and REPLACED on
    //    every sync (upsert on account+deal) — repeated syncs stay idempotent
    //    instead of duplicating rows.
    S.deals=(S.deals||[]).filter(function(d){return d.mgr||(!d.seed&&!d.tmap&&hasLogin(d.client));});
    var mapped=(a.deals||[]).map(function(d){
      return {t:d.time,client:login,sym:d.sym,dir:d.dir,vol:+d.vol||0,open:+d.open||0,
              close:+d.close||0,pl:+d.pl||0,spreadRev:0,id:"t"+d.id,tmap:1,tid:d.id};
    });
    S.deals=S.deals.concat(mapped).sort(function(x,y){return (y.t||0)-(x.t||0);});
  });

  // 5) drop dealing-desk queue items that reference unknown clients,
  //    and any provenance-tagged seeded demos even on login collision
  S.requests=(S.requests||[]).filter(function(r){return !r.seed&&hasLogin(r.login);});
  S.kyc=(S.kyc||[]).filter(function(k){return !k.seed&&hasLogin(k.login);});

  // 5b) drop orphaned book rows whose client is no longer in the book
  var okC={};S.clients.forEach(function(c){okC[num(c.login)]=1;});
  var hasC=function(l){return okC[num(l)]===1;};
  S.positions=S.positions.filter(function(p){return hasC(p.client);});
  S.orders=S.orders.filter(function(o){return hasC(o.client);});
  S.deals=(S.deals||[]).filter(function(d){return d.mgr||(!d.seed&&hasC(d.client));});

  // 6) first sync: the seeded daily totals + feed were fabricated — zero them
  if(!S.proSynced){
    S.proSynced=true;S.depToday=0;S.wdToday=0;S.eqHist=[];
    feedMsg("System","Manager linked to "+as.length+" demo account"+(as.length===1?"":"s")+" on this device");
  }

  // 6b) money-tab KPIs from REAL trader deposits (not the old fabricated seed):
  //     today's deposits>0 -> depToday, today's withdrawals (amount<0) -> wdToday
  try{
    var tKey=dayKey(Date.now()),dep=0,wd=0;
    as.forEach(function(a){
      (a.deposits||[]).forEach(function(d){
        if(dayKey(+d.time||0)!==tKey)return;
        var v=+d.amount||0;if(v>0)dep+=v;else wd+=-v;
      });
    });
    S.depToday=Math.round(dep*100)/100;S.wdToday=Math.round(wd*100)/100;
  }catch(e){}

  // 6c) client price alerts (armed only) surface in the manager risk tab
  try{
    var ca=[];
    as.forEach(function(a){
      (a.alerts||[]).forEach(function(al){
        if(!al||al.fired)return;
        ca.push({login:num(a.id),sym:al.sym||"",price:+al.price||0,kind:al.kind||"price"});
      });
    });
    S.clientAlerts=ca.slice(0,100);
  }catch(e){S.clientAlerts=[];}

  // 7) rebuild the 7-day P/L series from REAL closed-deal history (was seeded)
  try{
    var days=[];var nowD=new Date();
    for(var i=6;i>=0;i--){days.push(dayKey(new Date(nowD.getTime()-i*86400000).getTime()));}
    var per={};days.forEach(function(k){per[k]=0;});
    (S.deals||[]).forEach(function(x){var k=dayKey(x.t||0);if(k in per)per[k]+=+x.pl||0;});
    S.plDay=days.map(function(k){return Math.round(per[k]*100)/100;});
  }catch(e){}
  save();
}

/* ---------- write manager dealing mutations back to orbit-accts ---------- */
function pushBack(login){
  try{
    var as=readAccts();
    var a=as.find(function(x){return num(x.id)===num(login);});
    if(!a)return;
    var c=S.clients.find(function(x){return num(x.login)===num(login);});
    if(c)a.balance=c.balance;
    a.positions=S.positions.filter(function(p){return num(p.client)===num(login);}).map(function(p){
      if(p.tid==null)p.tid=S.mpSeq++;
      return {id:p.tid,sym:p.sym,dir:p.dir,vol:p.vol,open:p.open,sl:p.sl,tp:p.tp,
              ts:p.ts||0,beT:p.beT||0,beO:p.beO||0,swap:p.swap||0,fill:p.fill||"FOK",time:p.time||Date.now()};
    });
    a.orders=S.orders.filter(function(o){return num(o.client)===num(login);}).map(function(o){
      if(o.tid==null)o.tid=S.mpSeq++;
      return {id:o.tid,sym:o.sym,dir:o.dir,vol:o.vol,type:o.type,price:o.price,
              limitPx:o.limitPx,sl:o.sl,tp:o.tp,time:o.time||Date.now()};
    });
    if(!a.seq)a.seq={p:1,o:1,a:1,d:1};
    (S.deals||[]).filter(function(d){return d.mgr&&!d.synced&&num(d.client)===num(login);}).forEach(function(d){
      a.deals.unshift({id:a.seq.d++,ticket:d.tid||0,sym:d.sym,dir:d.dir,vol:d.vol,
        open:d.open,close:d.close,pl:d.pl,time:d.t||Date.now(),openTime:d.t||Date.now(),swap:0,reason:"manager"});
      d.synced=true;
    });
    if(a.deals.length>300)a.deals.length=300;
    localStorage.setItem(ACCT,JSON.stringify(as));
  }catch(e){}
}

/* ---------- leaderboard (paper) ---------- */
function closedPL(login){
  return (S.deals||[]).reduce(function(t,d){return num(d.client)===num(login)?t+(+d.pl||0):t;},0);
}
function renderBoard(){
  var el=document.getElementById("board-list");if(!el)return;
  var rows=S.clients.map(function(c){
    var f=cFloat(c.login),closed=closedPL(c.login);
    var total=closed+(f==null?0:f);
    // return on capital: P/L relative to equity excluding all P/L (deposits
    // and the trader's starting balance stay in the base, P/L does not)
    var base=c.balance-closed;
    var ret=base>0?total/base*100:null;
    return {c:c,eq:cEq(c),closed:closed,float:f,total:total,ret:ret};
  }).sort(function(a,b){return (b.ret==null?-1e18:b.ret)-(a.ret==null?-1e18:a.ret);});
  el.innerHTML=rows.map(function(r,i){
    var c=r.c;
    var rcol=r.ret==null?"var(--text3)":r.ret>=0?"var(--green)":"var(--red)";
    var tcol=r.total>=0?"var(--green)":"var(--red)";
    var rpct=r.ret==null?"—":(r.ret>=0?"+":"\u2212")+Math.abs(r.ret).toFixed(1)+"%";
    return '<div class="crow"><div class="av" style="'+(i===0?"background:var(--gold-dim);color:var(--gold)":"")+'">'+(i+1)+'</div>'+
      '<div style="flex:1;min-width:0"><div class="cn">'+esc(c.name)+' <span class="pbadge">PAPER</span></div>'+
      '<div class="cl num">'+c.login+' · eq '+money(r.eq)+' · closed '+sgn(r.closed)+'</div></div>'+
      '<div class="cr"><div class="ce num" style="color:'+rcol+'">'+rpct+'</div>'+
      '<div class="cf num" style="color:'+tcol+'">'+sgn(r.total)+' total</div></div></div>';
  }).join("")||'<div class="empty">No demo accounts on this device yet.<br>Create one in the Trader app — it appears here automatically.</div>';
}

/* ---------- broadcast segments: make the audience picker real ---------- */
var _segSig="";
function fillSeg(){
  var seg=document.getElementById("bc-seg");if(!seg)return;
  var sig=(S.groups||[]).map(function(g){return g.id;}).join(",");
  if(sig===_segSig&&seg.options.length>1)return;
  _segSig=sig;
  var v=seg.value;
  seg.innerHTML='<option value="all">All traders</option><option value="demo">Demo accounts</option><option value="vip">VIP only</option>'+
    (S.groups||[]).map(function(g){return '<option value="group:'+g.id+'">'+esc(g.name)+' only</option>';}).join("");
  seg.value=v;
}

function init(){
  syncBook();
  try{fillPosFilters();}catch(e){}
  try{fillPendFilters();}catch(e){}
  if(typeof shLogin!=="undefined"&&shLogin&&!cli(shLogin)){try{closeSheet();}catch(e){}}
  renderAll();
}

window.MP={syncBook:syncBook,pushBack:pushBack,init:init,renderBoard:renderBoard,closedPL:closedPL};

/* ---------- wire into the existing manager ---------- */
TABS.push("leaderboard");

var _mnav=mnav;
mnav=function(t){_mnav(t);if(t==="leaderboard")renderBoard();};

var _renderAll=renderAll;
renderAll=function(){
  _renderAll();
  renderBoard();
  fillSeg();
};

var _renderClients=renderClients;
renderClients=function(){
  _renderClients();
  var cl=document.getElementById("cli-list");
  if(cl&&S.clients.length===0){
    cl.innerHTML='<div class="empty">No demo accounts on this device yet.<br>Create one in the Trader app — it appears here automatically.</div>';
  }
};

var _boot=boot;
boot=function(){_boot();init();};

/* manager dealing actions on paper accounts write back to orbit-accts */
var _mgrClose=mgrClose;
mgrClose=function(id){
  var p=S.positions.find(function(x){return x.id===id;});
  var login=p?p.client:null,tid=p?p.tid:null,nL=(S.deals||[]).length;
  _mgrClose(id);
  var d=(S.deals||[])[0];
  if(d&&(S.deals||[]).length===nL+1&&login!=null&&num(d.client)===num(login)){d.mgr=1;d.tid=tid;}
  try{save();}catch(e){}
  if(login!=null)pushBack(login);
};

var _stopoutAll=stopoutAll;
stopoutAll=function(login){
  var nL=(S.deals||[]).length;
  _stopoutAll(login);
  (S.deals||[]).slice(0,Math.max(0,(S.deals||[]).length-nL)).forEach(function(d){
    if(num(d.client)===num(login)){d.mgr=1;}
  });
  try{save();}catch(e){}
  pushBack(login);
};

var _saveModPos=saveModPos;
saveModPos=function(id){
  var p=S.positions.find(function(x){return x.id===id;});
  var login=p?p.client:null;
  _saveModPos(id);
  if(login!=null)pushBack(login);
};

var _cancelOrder=cancelOrder;
cancelOrder=function(id){
  var o=S.orders.find(function(x){return x.id===id;});
  var login=o?o.client:null;
  _cancelOrder(id);
  if(login!=null)pushBack(login);
};

var _reqDo=reqDo;
reqDo=function(id,ok){
  var r=S.requests.find(function(x){return x.id===id;});
  var login=r?r.login:null;
  _reqDo(id,ok);
  if(login!=null&&ok)pushBack(login);
};

var _balAdjDo=balAdjDo;
balAdjDo=function(){
  var login=(typeof shLogin!=="undefined")?shLogin:null;
  _balAdjDo();
  if(login!=null)pushBack(login);
};

var _doResetDemo=doResetDemo;
doResetDemo=function(){_doResetDemo();init();};

window.addEventListener("storage",function(e){
  if(e.key===ACCT){init();}
});
})();
