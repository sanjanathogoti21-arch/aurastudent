const C='aurastudent-v39',F=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./badge-96.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);if(u.origin!==location.origin)return;
e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(C).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('./index.html'))))});
self.addEventListener('notificationclick',e=>{e.notification.close();const k=(e.notification.data||{}).kind;e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{if(l.length){const c=l[0];if(k)try{c.postMessage({type:'aura-open',view:'buddy'})}catch(_){}return c.focus()}return clients.openWindow(k?'./index.html?go=buddy':'./index.html')}))});
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){}
const t=d.title||'AuraStudent',title=/^AuraStudent/i.test(t)?t:'AuraStudent \u00b7 '+t,kind=d.kind||'';
e.waitUntil((async()=>{
 const l=await clients.matchAll({type:'window',includeUncontrolled:true});
 for(const c of l)try{c.postMessage({type:'aura-push',kind,title:t,body:d.body||''})}catch(_){}
 /* Study buddy events: if the app is on screen it shows its own toast + sound, so no system banner */
 if(kind&&l.some(c=>c.visibilityState==='visible'))return;
 await self.registration.showNotification(title,{body:d.body||'You have an upcoming item.',icon:'icon-192.png',badge:'badge-96.png',tag:d.tag||'aura',renotify:true,requireInteraction:true,silent:false,vibrate:[250,120,250,120,400],timestamp:Date.now(),data:{url:'./index.html',kind}})
})())});
