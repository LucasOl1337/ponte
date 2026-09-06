// Deliberately small DOM for deterministic interaction tests. This exercises the
// shipped scripts without a browser, a live desktop, or microphone permission.
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_,name) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[name]));
const voidTags = new Set(['meta','link','img','input','br','hr','source','use']);
class Events {
  listeners = new Map();
  addEventListener(name,callback) { const entries=this.listeners.get(name)||[]; entries.push(callback); this.listeners.set(name,entries); }
  dispatchEvent(event) { event.target ||= this; for(const callback of this.listeners.get(event.type)||[]) callback(event); return true; }
}
class Element extends Events {
  constructor(tag,document,attrs={}) {
    super(); this.tagName=tag.toUpperCase(); this.ownerDocument=document; this.attrs=attrs; this.nodes=[];
    this.value=attrs.value||''; this.hidden='hidden' in attrs; this.disabled='disabled' in attrs; this.style={setProperty(name,value){this[name]=value;}};
    this.clientWidth=0; this.clientHeight=0; this.scrollLeft=0; this.scrollTop=0; this.naturalWidth=0; this.naturalHeight=0;
    this.getBoundingClientRect=()=>({left:this._left||0,top:this._top||0,right:(this._left||0)+this.clientWidth,bottom:(this._top||0)+this.clientHeight,width:this.clientWidth,height:this.clientHeight,x:this._left||0,y:this._top||0});
    this.setPointerCapture=()=>{}; this.releasePointerCapture=()=>{};
    this.classList={contains:name=>(this.attrs.class||'').split(/\s+/).includes(name),toggle:(name,force)=>{const classes=new Set((this.attrs.class||'').split(/\s+/).filter(Boolean));const add=force===undefined?!classes.has(name):force;if(add)classes.add(name);else classes.delete(name);this.attrs.class=[...classes].join(' ');return add;},add:(...names)=>names.forEach(name=>this.classList.toggle(name,true)),remove:(...names)=>names.forEach(name=>this.classList.toggle(name,false))};
  }
  get id(){return this.attrs.id||'';}
  get dataset(){return Object.fromEntries(Object.entries(this.attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));}
  get textContent(){return this.nodes.map(node=>typeof node==='string'?node:node.textContent).join('');}
  set textContent(value){this.nodes=[String(value)];if(this.tagName==='TITLE')this.ownerDocument.titleEvents.push({title:String(value),lang:this.ownerDocument.documentElement?.lang});}
  get innerHTML(){return this.textContent;}
  set innerHTML(value){this.nodes=[];parse(String(value),this,this.ownerDocument);}
  getAttribute(name){return this.attrs[name]??null;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  removeAttribute(name){delete this.attrs[name];}
  matches(selector){return selector.split(',').some(part=>{part=part.trim();const tag=/^[\w-]+/.exec(part);if(tag&&this.tagName!==tag[0].toUpperCase())return false;const id=/#([\w-]+)/.exec(part);if(id&&id[1]!==this.id)return false;for(const m of part.matchAll(/\.([\w-]+)/g))if(!this.classList.contains(m[1]))return false;for(const m of part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g))if(!(m[1] in this.attrs)||(m[2]!==undefined&&this.attrs[m[1]]!==m[2]))return false;return true;});}
  querySelectorAll(selector){const result=[];const visit=element=>{for(const child of element.nodes){if(typeof child==='string')continue;if(child.matches(selector))result.push(child);visit(child);}};visit(this);return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){let current=this;while(current){if(current.matches(selector))return current;current=current.parentElement;}return null;}
  focus(){this.ownerDocument.activeElement=this;}
  blur(){if(this.ownerDocument.activeElement===this)this.ownerDocument.activeElement=null;}
  pause(){this.paused=true;}
  load(){}
  play(){this.paused=false;return Promise.resolve();}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
function parse(source,parent,document){
 const stack=[parent];
 for(const part of source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|[^<]+/g)){
  const token=part[0];if(token.startsWith('<!'))continue;
  if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
  if(token.startsWith('<')){const tag=/^<([\w-]+)/.exec(token)?.[1];if(!tag)continue;const attrs={};for(const a of token.slice(tag.length+1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[a[1]]=decode(a[2]??a[3]??a[4]??'');const element=new Element(tag,document,attrs);element.parentElement=stack.at(-1);element.parentElement.nodes.push(element);if(!voidTags.has(tag)&&!token.endsWith('/>'))stack.push(element);
  }else stack.at(-1).nodes.push(decode(token));
 }
}
export function makeDocument(html){
 const document=new Element('document',null);document.ownerDocument=document;document.titleEvents=[];document.hidden=false;document.getElementById=id=>document.querySelector('#'+id);parse(html,document,document);document.documentElement=document.querySelector('html');document.body=document.querySelector('body');Object.defineProperty(document,'title',{get:()=>document.querySelector('title').textContent,set:value=>{document.querySelector('title').textContent=value;}});return document;
}
export function makeWindow(){const window=new Events();window.matchMedia=()=>({matches:false});window.scrollTo=()=>{};window.isSecureContext=true;return window;}
