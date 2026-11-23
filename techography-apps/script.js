(function(){'use strict';
var D=JSON.parse(document.getElementById('data').textContent);
var $=function(id){return document.getElementById(id)};
var listV=$('list-view'),detV=$('detail-view'),viewer=$('viewer'),frame=$('frame');
var url=function(s){return 'https://'+s+'.sites.tab.bot/'};
var newest=D.apps[0]&&D.apps[0].date;
function fmt(d){var m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];var p=d.split('-');return (+p[2])+' '+m[+p[1]-1]+' '+p[0]}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function render(q){
  q=(q||'').trim().toLowerCase();var ol=$('apps'),n=0,h='';
  D.apps.forEach(function(a,i){var hay=(a.name+' '+a.desc+' '+a.tag+' '+a.slug).toLowerCase();if(q&&hay.indexOf(q)<0)return;n++;
    h+='<li><button class="app" type="button" data-slug="'+a.slug+'"><span class="num">'+(i+1)+'</span><span class="ico" aria-hidden="true">'+a.emoji+'</span><span class="info"><b>'+esc(a.name)+'</b><p>'+esc(a.desc)+'</p><span class="chips"><span class="chip">'+esc(a.tag)+'</span><span class="chip">'+fmt(a.date)+'</span>'+(a.date===newest?'<span class="chip new">NEW</span>':'')+'</span></span><span class="go" aria-hidden="true">›</span></button></li>'});
  ol.innerHTML=h;$('empty').hidden=n>0;
  var mh='',mn=0;D.media.forEach(function(m){var hay=(m.name+' '+m.slug).toLowerCase();if(q&&hay.indexOf(q)<0)return;mn++;
    mh+='<li><a href="'+url(m.slug)+'" target="_blank" rel="noopener"><span>🎞️ '+esc(m.name)+'</span><small>'+fmt(m.date)+' ↗</small></a></li>';
    if(m.twin)mh+='<li><a href="'+url(m.twin)+'" target="_blank" rel="noopener"><span>↳ '+esc(m.name)+' (static copy)</span><small>↗</small></a></li>'});
  $('media').innerHTML=mh;$('mediaCount').textContent=mn+' links';$('mediaBox').hidden=q&&mn===0;
  if(q&&mn>0&&n===0)$('mediaBox').open=true;
  $('stats').textContent=q?(n+(n===1?' app mila':' apps mile')):(D.apps.length+' apps · '+(D.apps.length+Object.keys(D.twins).length+D.media.length+D.media.filter(function(m){return m.twin}).length)+' total links · newest first');
}
$('q').addEventListener('input',function(e){render(e.target.value)});
$('apps').addEventListener('click',function(e){var b=e.target.closest('.app');if(b)location.hash='#app='+b.dataset.slug});
var cur=null;
function show(slug){
  var i=-1,a=null;D.apps.forEach(function(x,k){if(x.slug===slug){a=x;i=k}});
  if(!a){closeViewer(true);detV.hidden=true;listV.hidden=false;document.title='Techography Apps · saari websites ek jagah';return}
  cur=a;listV.hidden=true;detV.hidden=false;window.scrollTo(0,0);
  $('dnum').textContent='#'+(i+1)+' of '+D.apps.length;$('demoji').textContent=a.emoji;$('dname').textContent=a.name;
  $('dmeta').textContent=fmt(a.date)+' · '+a.tag;$('ddesc').textContent=a.desc;
  $('dl').href=a.zip;$('dl').setAttribute('download',a.slug+'.zip');$('dlkb').textContent='('+a.zipKB+' KB .zip)';
  $('newtab').href=url(a.slug);$('vnew').href=url(a.slug);$('thumb').src=a.thumb;
  var t=a.twin&&D.twins[a.twin];$('twin').innerHTML=t?'<div class="twin">Testing version bhi hai: <a href="'+url(t.slug)+'" target="_blank" rel="noopener">'+esc(t.name)+' ↗</a> (code upar wale zip jaisa hi hai)</div>':'';
  document.title=a.name+' · Techography Apps';
}
function route(){var m=location.hash.match(/app=([a-z0-9-]+)/);show(m?m[1]:null)}
window.addEventListener('hashchange',route);
$('back').addEventListener('click',function(){if(history.length>1&&document.referrer.indexOf(location.host)>=0||history.state&&history.state.d){history.back()}else{location.hash=''}});
function isFs(){return document.fullscreenElement||document.webkitFullscreenElement}
function openViewer(){
  if(!cur)return;var u=url(cur.slug);if(frame.getAttribute('src')!==u)frame.src=u;
  viewer.hidden=false;document.body.classList.add('viewing');
  var req=viewer.requestFullscreen||viewer.webkitRequestFullscreen;
  if(req){try{var p=req.call(viewer,{navigationUI:'hide'});if(p&&p.catch)p.catch(function(){toast('Full screen yahan block hai: ↗ se new tab mein kholo')})}catch(e){}}
  try{if(screen.orientation&&screen.orientation.lock)screen.orientation.lock('portrait').catch(function(){})}catch(e){}
  history.pushState({v:1},'',location.href);
}
function closeViewer(fromPop){
  if(viewer.hidden)return;viewer.hidden=true;document.body.classList.remove('viewing');
  if(isFs()){(document.exitFullscreen||document.webkitExitFullscreen).call(document)}
  frame.src='about:blank';frame.removeAttribute('src');
  if(!fromPop&&history.state&&history.state.v)history.back();
}
$('openFs').addEventListener('click',openViewer);$('thumbBtn').addEventListener('click',openViewer);
$('vexit').addEventListener('click',function(){closeViewer(false)});
function fsChange(){if(!isFs()&&!viewer.hidden)closeViewer(false)}
document.addEventListener('fullscreenchange',fsChange);document.addEventListener('webkitfullscreenchange',fsChange);
window.addEventListener('popstate',function(){if(!viewer.hidden)closeViewer(true)});
$('copy').addEventListener('click',function(){var u=url(cur.slug);(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){toast('Link copy ho gaya ✅')},function(){prompt('Link copy karo:',u)})});
var tt;function toast(m){var t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(tt);tt=setTimeout(function(){t.classList.remove('show')},2200)}
// draggable exit bar: tap = action, drag = move it out of the way
(function(){var bar=document.querySelector('.vbar'),sx,sy,bx,by,moved=false,id=null;
bar.addEventListener('pointerdown',function(e){id=e.pointerId;moved=false;sx=e.clientX;sy=e.clientY;var r=bar.getBoundingClientRect();bx=r.left;by=r.top});
window.addEventListener('pointermove',function(e){if(id!==e.pointerId)return;var dx=e.clientX-sx,dy=e.clientY-sy;if(!moved&&Math.abs(dx)+Math.abs(dy)<8)return;moved=true;
  var x=Math.max(2,Math.min(innerWidth-bar.offsetWidth-2,bx+dx)),y=Math.max(2,Math.min(innerHeight-bar.offsetHeight-2,by+dy));bar.style.left=x+'px';bar.style.top=y+'px';bar.style.right='auto';bar.style.transform='none'});
window.addEventListener('pointerup',function(e){if(id===e.pointerId){id=null}});
bar.addEventListener('click',function(e){if(moved){e.preventDefault();e.stopPropagation();moved=false}},true)})();
render('');route();
})();
