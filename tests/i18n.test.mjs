import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument,makeWindow } from './helpers/dom.mjs';
const read = name => readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [html,runtime,app,progressHTML,progressScript,progressJSON] = await Promise.all(['index.html','i18n.js','app.js','progress.html','progress.js','progress.json'].map(read));
const fixture={hostname:'test-desktop',windows:[{address:'0x123',title:'Notes <private>',class:'editor',workspace:{id:1,name:'1'}}],activeWindow:{address:'0x123',title:'Notes <private>',workspace:{id:1}},workspaces:[{id:1,name:'1',windows:1},{id:-99,name:'special:scratchpad',windows:0}],monitors:[{name:'TEST-1',width:1920,height:1080,focused:true}],volume:{value:0.3,muted:false},capabilities:{keyboard:true,mouse:true,screenshot:true,live:true,audio:true},warnings:[]};
function harness({stored={},page=html,runApp=false,response}={}){
 const document=makeDocument(page),window=makeWindow();const saved=new Map(Object.entries(stored));const calls=[];let timer=0;
 const context=vm.createContext({document,window,localStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},navigator:{language:'pt-BR',languages:['pt-BR'],userAgent:'Test browser'},location:{hash:'',pathname:'/',search:''},history:{replaceState(){}},CustomEvent:class{constructor(type,{detail}={}){this.type=type;this.detail=detail;}},Intl,Date,Error,TypeError,TextDecoder,Uint8Array,AbortController,URL,Blob,performance,setTimeout:()=>++timer,clearTimeout(){},setInterval:()=>++timer,clearInterval(){},fetch:async(path,options)=>{calls.push({path,options});return response?response(path,options):{ok:true,json:async()=>path==='/api/audio'?{recordings:[]}:fixture};}});
 vm.runInContext(runtime,context);if(runApp)vm.runInContext(app,context);
 return{context,window,document,saved,calls,i18n:window.PonteI18n,el:selector=>document.querySelector(selector),run:source=>vm.runInContext(source,context)};
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('English is the fixed first-run language even on a Portuguese browser; keys and HTML bindings are complete',()=>{
 const h=harness();assert.equal(h.i18n.language,'en');assert.equal(h.document.documentElement.lang,'en');assert.equal(h.document.title,'Ponte — your Omarchy, within reach');assert.equal(h.el('.nav-item[data-nav="voz"]').textContent.trim(),'Voice');assert.equal(h.el('#keyboard-text').getAttribute('placeholder'),'Write here to type on the PC…');assert.equal(h.el('#fullscreen-button').getAttribute('aria-label'),'Enter fullscreen');
 for(const name of ['data-i18n','data-i18n-aria-label','data-i18n-placeholder','data-i18n-title','data-i18n-alt','data-i18n-content'])for(const el of h.document.querySelectorAll(`[${name}]`))assert.ok(Object.hasOwn(h.i18n.messages,el.getAttribute(name)),el.getAttribute(name));
 for(const source of [app,progressScript])for(const match of source.matchAll(/\b(?:t|h)\((['"])(.*?)\1/g))assert.ok(Object.hasOwn(h.i18n.messages,match[2]),match[2]);
});

test('Portuguese selection persists across reload, synchronizes the selector, and sets DOM locale before title',()=>{
 const h=harness();h.i18n.setLanguage('pt');assert.equal(h.saved.get('ponte-language'),'pt');assert.equal(h.document.documentElement.lang,'pt-BR');assert.equal(h.el('[data-language-select]').value,'pt');assert.equal(h.document.title,'Ponte — seu Omarchy, por perto');assert.equal(h.el('#keyboard-text').getAttribute('placeholder'),'Escreva aqui para digitar no PC…');assert.ok(h.document.titleEvents.filter(event=>event.title==='Ponte — seu Omarchy, por perto').every(event=>event.lang==='pt-BR'));
 const reloaded=harness({stored:Object.fromEntries(h.saved)});assert.equal(reloaded.i18n.language,'pt');assert.equal(reloaded.el('.nav-item[data-nav="voz"]').textContent.trim(),'Voz');reloaded.i18n.setLanguage('en');assert.equal(reloaded.document.documentElement.lang,'en');assert.equal(reloaded.saved.get('ponte-language'),'en');
});

test('Locale handles plurals, decimal sizes, parameterized feedback and escaped HTML',()=>{
 const h=harness();assert.equal(h.i18n.plural('{count} JANELA','{count} JANELAS',1),'1 WINDOW');assert.equal(h.i18n.plural('{count} JANELA','{count} JANELAS',2),'2 WINDOWS');assert.equal(h.i18n.formatBytes(1.5*1024*1024),'1.5 MB');const feedback=h.i18n.t('Área {workspace} em foco.',{workspace:'2'});assert.equal(feedback,'Workspace 2 focused.');assert.ok(h.i18n.html('Área {workspace}',{workspace:'<img src=x onerror=alert(1)>'}).includes('&lt;img'));h.i18n.setLanguage('pt');assert.equal(h.i18n.formatBytes(1.5*1024*1024),'1,5 MB');assert.equal(h.i18n.t(feedback),'Área 2 em foco.');
});

test('Ownership checks use own properties only, without Object.hasOwn',()=>{
 const h=harness();assert.equal(h.i18n.t('X {toString} Y',{toString:'Z'}),'X Z Y');assert.equal(h.i18n.t('X {toString} Y',{}),'X {toString} Y');assert.equal(h.i18n.t('X {constructor} Y',{}),'X {constructor} Y');assert.equal(h.i18n.apiMessage('WOL_INSTRUCTIONS',{interface:'enp12s0',mac:'d8:43:ae:8b:e8:a8'}),'Enable Wake-on-LAN in UEFI/BIOS (Power On By PCI-E) and Linux with sudo ethtool -s enp12s0 wol g. Wake with Magic Packet to d8:43:ae:8b:e8:a8 on UDP port 9.');
});

test('Every app page works in English, including internal Windows navigation and safe dynamic workspace labels',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();assert.equal(h.el('#hostname').textContent,'test-desktop');assert.equal(h.el('#window-count').textContent,'1 WINDOW');assert.equal(h.el('[data-window]').getAttribute('aria-label'),'Focus Notes <private>, workspace 1');assert.equal(h.el('#home-workspaces').querySelectorAll('button').length,1);
 h.run("navigate('inicio')");assert.equal(h.el('#page-inicio').hidden,false);for(const page of ['tela','controle','terminais','janelas','voz']){h.run(`navigate('${page}')`);assert.equal(h.el('#page-'+(page==='controle'?'tela':page)).hidden,false);assert.equal(h.el(`.nav-item[data-nav="${page}"]`).getAttribute('aria-current'),'page');}await flush();assert.match(h.el('#recording-list').textContent,/No recordings yet/);assert.ok(h.calls.every(call=>call.options.headers['Accept-Language']==='en'));assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));
});

test('Changing language preserves drafted text, selection, active controls, preview and live session without sending actions',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();h.run("navigate('controle');selectControlMode('keyboard')");const textarea=h.el('#keyboard-text');textarea.value='Draft with accents: Olá 👋';textarea.selectionStart=6;textarea.selectionEnd=10;textarea.focus();h.el('#pair-token').value='an unfinished key';h.el('#window-search').value='Notes';h.el('#live-quality').value='sharp';h.el('#record-audio').src='blob:preview';h.el('#record-preview').hidden=false;
 h.run("recordingURL='blob:preview';recordingBlob=new Blob(['synthetic']);screenMode='live';screenStatusMessage='';lastScreenTimestamp=1770000000000;liveSession={monitor:'TEST-1',profileLabel:'Mais nítido · até 6 quadros/s'};screenshotURL='blob:screen';screenZoomed=true;dragging=true;$('#screen-stage').classList.add('expanded');$('#record-state').textContent=t('PRÉVIA');$('#record-hint').textContent=t('Ouça antes. O envio é sua escolha.');");const live=h.run('liveSession');const blob=h.run('recordingBlob');h.i18n.setLanguage('pt');await flush();
 assert.equal(textarea.value,'Draft with accents: Olá 👋');assert.equal(textarea.selectionStart,6);assert.equal(textarea.selectionEnd,10);assert.equal(h.document.activeElement,textarea);assert.equal(h.el('#pair-token').value,'an unfinished key');assert.equal(h.el('#window-search').value,'Notes');assert.equal(h.el('#live-quality').value,'sharp');assert.equal(h.el('#record-audio').src,'blob:preview');assert.equal(h.el('#record-preview').hidden,false);assert.equal(h.run('recordingBlob'),blob);assert.equal(h.run('liveSession'),live);assert.equal(h.run('currentPage'),'controle');assert.equal(h.run('controlMode'),'keyboard');assert.equal(h.el('#record-state').textContent,'PRÉVIA');assert.equal(h.el('#drag-button').textContent,'Soltar');assert.equal(h.el('#zoom-button').getAttribute('aria-label'),'Ajustar imagem inteira à tela');assert.equal(h.el('#fullscreen-button').getAttribute('aria-label'),'Sair da tela cheia');assert.equal(h.el('#live-badge').textContent,'AO VIVO');assert.match(h.el('#capture-time').textContent,/^Quadro às /);assert.equal(h.saved.get('ponte-pair-token'),'synthetic-test-token');assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));
 h.i18n.setLanguage('en');assert.equal(h.el('#drag-button').textContent,'Release');assert.equal(h.el('#record-state').textContent,'PREVIEW');assert.match(h.el('#live-note').textContent,/Sharper/);assert.equal(h.el('#fullscreen-button').getAttribute('aria-label'),'Exit fullscreen');
});

test('Both API transports negotiate the selected language and preserve authenticated requests',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();h.i18n.setLanguage('pt');await flush();await h.run("screenResponse('/screenshot?monitor=TEST-1',new AbortController())");await h.run("api('/audio')");for(const call of h.calls.slice(-2)){assert.equal(call.options.headers['Accept-Language'],'pt-BR');assert.equal(call.options.headers.Authorization,'Bearer synthetic-test-token');}assert.equal(h.calls.at(-2).path,'/api/screenshot?monitor=TEST-1');
});

test('Progress displays the same roadmap in English and saved Portuguese, including retry errors',async()=>{
 const h=harness({page:progressHTML,response:async()=>({ok:true,json:async()=>JSON.parse(progressJSON)})});vm.runInContext(progressScript,h.context);await flush();assert.match(h.el('#progress').textContent,/Experimental alpha/);assert.match(h.el('#progress').textContent,/Controls and live monitors/);h.i18n.setLanguage('pt');assert.match(h.el('#progress').textContent,/Alfa experimental/);assert.match(h.el('#progress').textContent,/Controle e monitores ao vivo/);h.run('progressFailed=true;renderProgress()');assert.match(h.el('#updated').textContent,/Aguardando atualização/);h.i18n.setLanguage('en');assert.match(h.el('#updated').textContent,/Waiting for a server update/);
});

test('Recorder permission, recording, finishing and preview translate without requesting another microphone or uploading',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();let requests=0;let trackStops=0;let active;
 h.context.navigator.mediaDevices={getUserMedia:async()=>{requests++;return{getTracks:()=>[{stop:()=>trackStops++}]};}};
 class Recorder {static isTypeSupported(){return true;}constructor(){active=this;this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';}}
 h.context.MediaRecorder=Recorder;h.window.MediaRecorder=Recorder;
 const starting=h.run('startRecording()');assert.equal(h.el('#record-state').textContent,'PERMISSION');assert.match(h.el('#record-button').textContent,/Cancel microphone access/);h.i18n.setLanguage('pt');assert.equal(h.el('#record-state').textContent,'PERMISSÃO');await starting;assert.equal(h.el('#record-state').textContent,'GRAVANDO');h.i18n.setLanguage('en');assert.equal(h.el('#record-state').textContent,'RECORDING');assert.equal(requests,1);assert.equal(trackStops,0);
 active.ondataavailable({data:new Blob(['synthetic recording'])});h.run('stopRecording()');assert.equal(h.el('#record-state').textContent,'FINISHING');h.i18n.setLanguage('pt');assert.equal(h.el('#record-state').textContent,'FINALIZANDO');active.onstop();assert.equal(h.el('#record-state').textContent,'PRÉVIA');assert.equal(h.el('#record-preview').hidden,false);assert.ok(trackStops>0);h.i18n.setLanguage('en');assert.equal(h.el('#record-state').textContent,'PREVIEW');assert.equal(h.el('#record-hint').textContent,'Listen first. You decide when to send.');assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));h.run('clearRecording()');
});

test('Public API and native proxy translations remain in parity with authoritative catalogs',async()=>{
 const {messages}=await import('../backend/i18n.mjs');const h=harness();for(const [code,translations] of Object.entries(messages))assert.deepEqual(JSON.parse(JSON.stringify(h.i18n.apiMessages[code])),translations,code);
 const native=await readFile(new URL('../android/src/app/ponte/omarchy/ProxyMessages.java',import.meta.url),'utf8');for(const match of native.matchAll(/case "([^"]+)": return pt \? "([^"]+)" : "([^"]+)";/g))assert.deepEqual(JSON.parse(JSON.stringify(h.i18n.apiMessages[match[1]])),{en:match[3],pt:match[2]},match[1]);
});

test('Previously received warnings and API errors switch while offline using codes, preserving unknown messages',async()=>{
 let online=true;const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true,response:async(path)=>{if(!online)throw new TypeError('Synthetic offline');if(path==='/api/state')return{ok:true,json:async()=>({...fixture,warnings:['Mouse and shortcuts require the ydotool service.','Future server warning.'],warningCodes:['INPUT_UNAVAILABLE','FUTURE_WARNING']})};return{ok:false,status:400,json:async()=>({errorCode:'NUMBER_OUT_OF_RANGE',errorParameters:{min:1,max:10},error:'The number must be between 1 and 10.'})};}});await flush();await h.run("api('/action').catch(error=>recordError(error))");assert.equal(h.el('#record-error').textContent,'The number must be between 1 and 10.');assert.equal(h.el('#record-error').getAttribute('data-api-code'),'NUMBER_OUT_OF_RANGE');online=false;h.i18n.setLanguage('pt');await flush();assert.match(h.el('#warnings').textContent,/Mouse e atalhos dependem do serviço ydotool ativo/);assert.match(h.el('#warnings').textContent,/Future server warning/);assert.equal(h.el('#record-error').textContent,'Valor numérico deve estar entre 1 e 10.');h.i18n.setLanguage('en');await flush();assert.match(h.el('#warnings').textContent,/Mouse and shortcuts require/);assert.equal(h.el('#record-error').textContent,'The number must be between 1 and 10.');h.i18n.write(h.el('#record-error'),{errorCode:'FUTURE_ERROR',message:'Future server message.'});h.i18n.setLanguage('pt');assert.equal(h.el('#record-error').textContent,'Future server message.');
});

test('Denied microphone access and native proxy failures relocalize without reopening capture',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();let attempts=0;h.context.navigator.mediaDevices={getUserMedia:async()=>{attempts++;throw Object.assign(new Error('Device-specific text'),{name:'NotAllowedError'});}};h.window.MediaRecorder=function(){};await h.run('startRecording()');assert.match(h.el('#record-error').textContent,/Microphone access was denied/);h.i18n.setLanguage('pt');assert.match(h.el('#record-error').textContent,/Microfone não permitido/);assert.equal(attempts,1);h.i18n.write(h.el('#record-error'),{errorCode:'proxy_unavailable',message:'Could not connect securely to the PC. Check Tailscale.'});assert.match(h.el('#record-error').textContent,/Não foi possível conectar ao PC com segurança/);h.i18n.setLanguage('en');assert.match(h.el('#record-error').textContent,/Could not connect securely/);assert.equal(attempts,1);
});

test('Network failures are localized for both ordinary API requests and monitor capture',async()=>{
 const h=harness({runApp:true,response:async()=>{throw new TypeError('Failed to fetch');}});h.i18n.setLanguage('pt');for(const request of ["api('/state')","screenResponse('/screenshot?monitor=TEST-1',new AbortController())"])await assert.rejects(h.run(request),/Sem resposta do PC/);h.i18n.setLanguage('en');for(const request of ["api('/state')","screenResponse('/screenshot?monitor=TEST-1',new AbortController())"])await assert.rejects(h.run(request),/No response from the PC/);
});

test('Saved recording dates and sizes relocalize in place without restarting browser playback or replacing its title',async()=>{
 const createdAt='2026-09-05T12:34:00.000Z';const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true,response:async path=>({ok:true,json:async()=>path==='/api/audio'?{recordings:[{id:'synthetic',name:'My own recording <title>',createdAt,size:1.5*1024*1024}]}:fixture})});await flush();h.run("navigate('voz')");await flush();const card=h.el('[data-recording="synthetic"]'),player=card.querySelector('audio'),date=card.querySelector('[data-i18n-date]');player.src='blob:already-loaded';player.currentTime=24.5;player.paused=false;assert.equal(date.textContent,new Date(createdAt).toLocaleString('en',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}));h.i18n.setLanguage('pt');await flush();assert.equal(card.querySelector('audio'),player);assert.equal(player.src,'blob:already-loaded');assert.equal(player.currentTime,24.5);assert.equal(player.paused,false);assert.equal(card.querySelector('strong').textContent,'My own recording <title>');assert.equal(date.textContent,new Date(createdAt).toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}));assert.match(card.textContent,/1,5 MB/);assert.match(card.textContent,/Tocar no PC/);
});

test('Screen is the first destination and native pause prevents polling from restarting capture',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();
 assert.equal(h.run('currentPage'),'tela');assert.equal(h.el('#page-tela').hidden,false);
 h.window.dispatchEvent({type:'ponte-native-pause'});await flush();
 const before=h.calls.filter(call=>call.path.startsWith('/api/stream')).length;
 await h.run('pollState()');await flush();
 assert.equal(h.calls.filter(call=>call.path.startsWith('/api/stream')).length,before);
 assert.equal(h.run('screenIsVisible()'),false);
 h.window.dispatchEvent({type:'ponte-native-resume'});await flush();
 assert.equal(h.run('screenIsVisible()'),true);
 assert.ok(h.calls.filter(call=>call.path.startsWith('/api/stream')).length>before);
});

test('Direct touch maps taps to monitor pixels and keeps pan and pinch from clicking',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();
 assert.equal(h.el('#direct-touch-indicator').hidden,true);
 h.run("selectControlMode('touch')");
 assert.equal(h.run('controlMode'),'touch');
 assert.equal(h.el('#remote-controls').hidden,true);
 assert.equal(h.el('[data-control-mode="touch"]').getAttribute('aria-pressed'),'true');
 assert.equal(h.el('[data-control-mode="view"]').getAttribute('aria-pressed'),'false');
 assert.equal(h.el('#screen-stage').getAttribute('data-input-mode'),'touch');
 assert.equal(h.el('#direct-touch-indicator').hidden,false);
 assert.match(h.el('#direct-touch-indicator').textContent,/Direct touch on/);
 assert.match(h.el('.viewer-tip').textContent,/Tap = click/);
 assert.match(h.el('#toast').textContent,/A tap now clicks the PC/);
 assert.equal(h.el('#toast').hidden,false);
 assert.equal(h.saved.get('ponte-direct-touch-seen'),'1');
 assert.match(h.el('#screen-preview').getAttribute('aria-label'),/Tap to click/);
 assert.equal(h.run('currentPage'),'tela');
 h.run("$('#toast').hidden=true;selectControlMode('view')");
 assert.equal(h.el('#direct-touch-indicator').hidden,true);
 assert.match(h.el('.viewer-tip').textContent,/Open Direct touch/);
 h.run("selectControlMode('touch')");
 assert.equal(h.el('#toast').hidden,true);
 assert.equal(h.el('#direct-touch-indicator').hidden,false);
 h.run("selectControlMode('mouse')");
 assert.equal(h.el('#touchpad').closest('[data-control-panel]').hidden,false);
 assert.equal(h.run('lastInputMode'),'mouse');
 h.run("selectControlMode('touch');connected=true;screenshotURL='blob:screen'");
 const pixel=h.run("JSON.stringify(mapTouchToMonitorPixel(240,135,{imageWidth:480,imageHeight:270,monitorWidth:1920,monitorHeight:1080}))");
 assert.equal(pixel,'{"x":960,"y":540}');
 await h.run("sendMonitorClick({x:100,y:40},'left')");await flush();
 await h.run("sendMonitorClick({x:8,y:9},'right')");await flush();
 const actions=h.calls.filter(call=>call.path==='/api/action').map(call=>JSON.parse(call.options.body));
 assert.deepEqual(actions,[
  {type:'mouse.clickAt',monitor:'TEST-1',x:100,y:40,button:'left'},
  {type:'mouse.clickAt',monitor:'TEST-1',x:8,y:9,button:'right'},
 ]);
 assert.equal(h.run("classifyScreenGesture({pointerCount:1,moved:true,durationMs:40})"),'pan');
 assert.equal(h.run("classifyScreenGesture({pointerCount:2,moved:false,durationMs:40})"),'pinch');
 h.run("liveSession={monitor:'TEST-1',fps:10,scale:0.5,region:null};viewRegion={x:100,y:80,w:640,h:360};screenZoom=1;syncLiveRegion()");
 assert.equal(h.run('JSON.stringify(liveSession.region)'),'{"x":100,"y":80,"w":640,"h":360}');
 assert.equal(h.run('liveSession.refreshing'),true);
 h.run("viewRegion=null;screenZoom=1;syncLiveRegion()");
 assert.equal(h.run('liveSession.region'),null);
});

test('native live zoom requests a preview-matched region without CSS zoom',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();
 h.run("screenshotURL='blob:screen';screenMode='live';liveSession={monitor:'TEST-1',fps:10,scale:0.5,region:null,refreshing:false};$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=960;$('#screen-image').naturalHeight=540;$('#zoom-button').click()");
 assert.equal(h.run('screenZoom'),1);
 assert.equal(h.run('JSON.stringify(viewRegion)'),'{"x":765,"y":430,"w":390,"h":220}');
 assert.equal(h.run('JSON.stringify(liveSession.region)'),'{"x":765,"y":430,"w":390,"h":220}');
 assert.equal(h.run('liveSession.refreshing'),true);
 assert.equal(h.el('#zoom-button').getAttribute('aria-pressed'),'true');
 assert.ok(h.el('#screen-stage').classList.contains('region-zoom'));
 assert.equal(h.el('#screen-stage').classList.contains('zoomed'),false);
 h.run("$('#zoom-button').click()");
 assert.equal(h.run('viewRegion'),null);
 assert.equal(h.run('liveSession.region'),null);
 assert.equal(h.el('#zoom-button').getAttribute('aria-pressed'),'false');
 assert.equal(h.el('#screen-stage').classList.contains('region-zoom'),false);
});

test('View, touchpad and keyboard keep one monitor stream and preserve a manual pause',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();
 h.run("stopLive();liveSession={monitor:'TEST-1'};screenMode='live';liveWanted=true");
 const stream=h.run('liveSession');const image=h.el('#screen-image');
 h.run("navigate('controle')");
 assert.equal(h.el('#page-tela').hidden,false);assert.equal(h.el('#touchpad').closest('[data-control-panel]').hidden,false);
 assert.equal(h.run('liveSession'),stream);assert.equal(h.run('screenIsVisible()'),true);
 h.run("selectControlMode('keyboard')");h.el('#keyboard-text').value='Keep my draft';h.el('#keyboard-text').focus();
 assert.equal(h.run('liveSession'),stream);assert.equal(h.el('#screen-image'),image);
 h.run("selectControlMode('view')");
 assert.equal(h.el('#remote-controls').hidden,true);assert.equal(h.el('#keyboard-text').value,'Keep my draft');
 assert.equal(h.document.activeElement,null);assert.equal(h.run('liveSession'),stream);
 h.run("stopLive();liveWanted=false;selectControlMode('mouse');reconcileLive();selectControlMode('keyboard');reconcileLive()");
 assert.equal(h.run('liveSession'),null);assert.equal(h.run('liveWanted'),false);
 assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));
});

test('Collapsing remote controls discards queued movement and releases an active drag',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();
 h.run("navigate('controle');pointers.set(7,{x:100,y:100});moveQueue={dx:90,dy:30,scroll:4};dragging=true;selectControlMode('view')");await flush();
 assert.equal(h.run('pointers.size'),0);assert.equal(h.run('dragging'),false);
 assert.equal(h.run('JSON.stringify(moveQueue)'),'{"dx":0,"dy":0,"scroll":0}');
 const actions=h.calls.filter(call=>call.path==='/api/action').map(call=>JSON.parse(call.options.body));
 assert.deepEqual(actions,[{type:'mouse.drag',pressed:false}]);
});

test('The reduced keyboard viewport stays stable when a send button takes focus',async()=>{
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true});await flush();
 h.window.innerWidth=390;h.window.innerHeight=844;h.run("selectControlMode('keyboard')");
 h.el('#keyboard-text').focus();h.window.innerHeight=420;h.run('syncRemoteViewport()');
 assert.equal(h.document.body.getAttribute('data-keyboard-open'),'true');
 h.el('#send-text').focus();h.run('syncRemoteViewport()');
 assert.equal(h.document.body.getAttribute('data-keyboard-open'),'true');
 h.window.innerHeight=844;h.run('syncRemoteViewport()');
 assert.equal(h.document.body.getAttribute('data-keyboard-open'),'false');
});

test('Terminal text remains readable above empty pane rows and relocalizes without losing input or pause',async()=>{
 const session={id:'123456789abcdef0123456789',title:'Terminal 1',cols:40,rows:24,inMode:false,attachCommand:'synthetic attachment'};
 const h=harness({stored:{'ponte-pair-token':'synthetic-test-token'},runApp:true,response:async path=>({ok:true,json:async()=>path==='/api/terminals'?{available:true,sessions:[session],limit:4}:path.startsWith('/api/terminals/')?{...session,text:'Output belongs to the session\n$ '+ '\n'.repeat(23)}:fixture})});await flush();
 h.run("navigate('terminais')");await flush();await flush();
 assert.equal(h.el('#terminal-output').textContent,'Output belongs to the session\n$ ');
 h.el('#terminal-input').value='Unsent terminal draft';h.run('terminalPaused=true;terminalControls()');
 h.i18n.setLanguage('pt');await flush();
 assert.equal(h.el('#terminal-pause').textContent,'Retomar leitura');
 assert.equal(h.el('#terminal-status').textContent,'Conectado à sessão de texto.');
 h.i18n.setLanguage('en');await flush();
 assert.equal(h.el('#terminal-pause').textContent,'Resume output');
 assert.equal(h.el('#terminal-status').textContent,'Connected to the text session.');
 assert.equal(h.el('#terminal-input').value,'Unsent terminal draft');
 assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));
});
