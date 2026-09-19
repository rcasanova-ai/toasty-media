const CUES = [
  { id:"drum-roll", label:"Drum Roll", icon:"🥁", type:"drumRoll", duration:2.4, category:"popular", aliases:["drumroll","roll","drums"] },
  { id:"level-up", label:"Level Up", icon:"⬆️", type:"levelUp", duration:1.15, category:"popular", aliases:["levelup","level up","power up","powerup"] },
  { id:"cholo-whistle", label:"Cholo Whistle", icon:"😗", type:"choloWhistle", duration:1.25, category:"popular", aliases:["cholo whistle","street whistle","ese whistle","mexican whistle"] },
  { id:"vine-boom", label:"Vine Boom", icon:"💥", type:"vineBoom", duration:0.8, category:"popular", aliases:["vine boom","boom","bass boom","big boom"] },
  { id:"air-horn", label:"Air Horn", icon:"📣", type:"airHorn", duration:1.1, category:"popular", aliases:["airhorn","air horn","horn"] },
  { id:"record-scratch", label:"Record Scratch", icon:"💿", type:"scratch", duration:0.8, category:"popular", aliases:["record scratch","scratch","needle scratch"] },
  { id:"crowd-oooh", label:"Crowd OOOH", icon:"😮", type:"crowdOooh", duration:1.25, category:"reactions", aliases:["crowd ooh","crowd oooh","oooh","ooh"] },
  { id:"applause", label:"Applause", icon:"👏", type:"applause", duration:1.8, category:"reactions", aliases:["clap","clapping","applause","cheer"] },
  { id:"slow-clap", label:"Slow Clap", icon:"👏", type:"slowClap", duration:2.2, category:"reactions", aliases:["slow clap"] },
  { id:"crickets", label:"Crickets", icon:"🦗", type:"crickets", duration:2.0, category:"reactions", aliases:["cricket","crickets","awkward silence"] },
  { id:"rimshot", label:"Rimshot", icon:"🥁", type:"rimshot", duration:0.65, category:"reactions", aliases:["rim shot","rimshot","ba dum tss","badum tish"] },
  { id:"sad-trombone", label:"Sad Trombone", icon:"🎺", type:"sadTrombone", duration:1.7, category:"fails", aliases:["sad trombone","wah wah","womp womp","fail horn"] },
  { id:"wrong-buzzer", label:"Wrong Buzzer", icon:"❌", type:"buzzer", duration:0.9, category:"fails", aliases:["wrong","wrong buzzer","buzzer","incorrect"] },
  { id:"error", label:"Error", icon:"⚠️", type:"error", duration:0.55, category:"fails", aliases:["error","error sound","computer error"] },
  { id:"power-down", label:"Power Down", icon:"🪫", type:"powerDown", duration:1.0, category:"fails", aliases:["power down","shutdown","dead"] },
  { id:"censor", label:"Censor Beep", icon:"🤬", type:"censor", duration:0.8, category:"production", aliases:["censor","censor beep","bleep","beep"] },
  { id:"dj-rewind", label:"DJ Rewind", icon:"⏪", type:"rewind", duration:1.15, category:"production", aliases:["rewind","dj rewind","run it back"] },
  { id:"whoosh", label:"Whoosh", icon:"💨", type:"whoosh", duration:0.65, category:"production", aliases:["whoosh","swoosh","transition"] },
  { id:"news-sting", label:"Breaking Sting", icon:"📰", type:"newsSting", duration:1.2, category:"production", aliases:["breaking news","news sting","news"] },
  { id:"notification", label:"Notification", icon:"🔔", type:"notification", duration:0.55, category:"production", aliases:["notification","ding","ping"] },
  { id:"camera", label:"Camera Shutter", icon:"📸", type:"camera", duration:0.28, category:"production", aliases:["camera","shutter","camera shutter"] },
  { id:"cash", label:"Cash Register", icon:"💰", type:"cash", duration:0.9, category:"hype", aliases:["cash","cash register","money","cha ching","ka ching"] },
  { id:"coin", label:"Coin", icon:"🪙", type:"coin", duration:0.5, category:"hype", aliases:["coin","coin sound"] },
  { id:"victory", label:"Victory", icon:"🏆", type:"victory", duration:1.5, category:"hype", aliases:["victory","winner","win","fanfare"] },
  { id:"sparkle", label:"Sparkle", icon:"✨", type:"sparkle", duration:0.9, category:"hype", aliases:["sparkle","magic","shimmer"] },
  { id:"mic-drop", label:"Mic Drop", icon:"🎤", type:"micDrop", duration:0.75, category:"hype", aliases:["mic drop","micdrop","drop the mic"] },
  { id:"heartbeat", label:"Heartbeat", icon:"❤️", type:"heartbeat", duration:1.9, category:"drama", aliases:["heartbeat","heart beat"] },
  { id:"suspense", label:"Suspense", icon:"😬", type:"suspense", duration:2.1, category:"drama", aliases:["suspense","tension","dramatic"] },
  { id:"reveal", label:"Reveal", icon:"🎭", type:"reveal", duration:1.15, category:"drama", aliases:["reveal","dramatic reveal","dun dun dun"] },
  { id:"thunder", label:"Thunder", icon:"🌩️", type:"thunder", duration:1.5, category:"chaos", aliases:["thunder","thunder crack"] },
  { id:"explosion", label:"Explosion", icon:"💣", type:"explosion", duration:1.15, category:"chaos", aliases:["explosion","explode","blast"] },
  { id:"siren", label:"Siren", icon:"🚨", type:"siren", duration:2.0, category:"chaos", aliases:["siren","police siren","alarm"] },
  { id:"klaxon", label:"Klaxon", icon:"🚨", type:"klaxon", duration:1.8, category:"chaos", aliases:["klaxon","warning horn","warning"] },
  { id:"laser", label:"Laser", icon:"🔫", type:"laser", duration:0.5, category:"chaos", aliases:["laser","pew","pew pew"] },
  { id:"glass", label:"Glass Break", icon:"🪟", type:"glass", duration:0.85, category:"chaos", aliases:["glass","glass break","breaking glass"] },
  { id:"finger-whistle", label:"Finger Whistle", icon:"🤌", type:"fingerWhistle", duration:0.9, category:"regional", aliases:["finger whistle","loud whistle","whistle"] }
];

const TABS = [
  ["all","All"],["popular","Popular"],["reactions","Reactions"],["hype","Hype"],
  ["fails","Fails"],["production","Production"],["drama","Drama"],["chaos","Chaos"],["regional","Street"]
].map(([id,label])=>({id,label}));

let activeSoundboard = null;

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
}

export function resolveSoundCommand(text) {
  const input = normalize(text);
  if (!input) return null;
  const commandLike = /\b(play|give me|hit me with|hit the|drop|cue|sound|trigger|run|hottie)\b/.test(input);
  if (!commandLike) return null;
  const ranked = CUES
    .flatMap(cue => [cue.label, cue.id, ...(cue.aliases || [])].map(alias => ({ cue, alias: normalize(alias) })))
    .filter(x => x.alias && input.includes(x.alias))
    .sort((a,b) => b.alias.length - a.alias.length);
  return ranked[0]?.cue || null;
}

export function triggerSoundFromInstruction(text) {
  const cue = resolveSoundCommand(text);
  if (!cue || !activeSoundboard) return null;
  activeSoundboard.play(cue);
  activeSoundboard.flash(cue.id);
  return cue;
}

export class Soundboard {
  constructor({ container, volumeInput, tabsContainer, searchInput }) {
    this.container = container;
    this.volumeInput = volumeInput;
    this.tabsContainer = tabsContainer;
    this.searchInput = searchInput;
    this.audioContext = null;
    this.master = null;
    this.volume = Number(volumeInput?.value || 0.65);
    this.activeTab = "all";
    this.query = "";
    activeSoundboard = this;
    this.renderTabs();
    this.render();
    this.volumeInput?.addEventListener("input", () => {
      this.volume = Number(this.volumeInput.value);
      if (this.master) this.master.gain.value = this.volume;
    });
    this.searchInput?.addEventListener("input", () => {
      this.query = normalize(this.searchInput.value);
      this.render();
    });
  }

  renderTabs() {
    if (!this.tabsContainer) return;
    this.tabsContainer.replaceChildren(...TABS.map(tab => {
      const button=document.createElement("button");
      button.type="button";
      button.textContent=tab.label;
      button.dataset.tab=tab.id;
      button.setAttribute("aria-pressed",String(tab.id===this.activeTab));
      button.addEventListener("click",()=>{
        this.activeTab=tab.id;
        this.tabsContainer.querySelectorAll("button").forEach(other=>other.setAttribute("aria-pressed",String(other.dataset.tab===tab.id)));
        this.render();
      });
      return button;
    }));
  }

  visibleCues() {
    return CUES.filter(cue => {
      const tab=this.activeTab==="all" || cue.category===this.activeTab;
      const hay=normalize([cue.label,...(cue.aliases||[])].join(" "));
      return tab && (!this.query || hay.includes(this.query));
    });
  }

  render() {
    if (!this.container) return;
    const cues=this.visibleCues();
    if (!cues.length) {
      const empty=document.createElement("p");
      empty.className="soundboard-empty";
      empty.textContent="No matching sounds.";
      this.container.replaceChildren(empty);
      return;
    }
    this.container.replaceChildren(...cues.map(cue=>{
      const button=document.createElement("button");
      button.type="button";
      button.className="sound-tile";
      button.dataset.cue=cue.id;
      button.dataset.category=cue.category;
      button.title=(cue.aliases||[]).join(", ");
      const play=document.createElement("span");
      play.className="sound-play";
      play.setAttribute("aria-hidden","true");
      play.textContent=cue.icon || "▶";
      const wave=document.createElement("span");
      wave.className="sound-wave";
      wave.setAttribute("aria-hidden","true");
      wave.innerHTML=`<svg viewBox="0 0 100 30" preserveAspectRatio="none"><path d="${organicWavePath(cue.id)}"></path></svg>`;
      const playhead=document.createElement("span");
      playhead.className="sound-playhead";
      wave.appendChild(playhead);
      const meta=document.createElement("span");
      meta.className="sound-meta";
      const label=document.createElement("span");
      label.className="sound-label";
      label.textContent=cue.label;
      const duration=document.createElement("span");
      duration.className="sound-duration";
      duration.textContent=`${cue.duration.toFixed(1)}s`;
      meta.append(label,duration);
      button.append(play,wave,meta);
      button.addEventListener("click",()=>{ this.play(cue); this.flash(cue.id); });
      return button;
    }));
  }

  flash(id) {
    const button=this.container?.querySelector(`[data-cue="${CSS.escape(id)}"]`);
    const cue=CUES.find(item=>item.id===id);
    if (!button || !cue) return;
    button.style.setProperty("--dur",`${cue.duration}s`);
    button.classList.remove("is-active");
    void button.offsetWidth;
    button.classList.add("is-active");
    window.setTimeout(()=>button.classList.remove("is-active"),Math.max(cue.duration*1000,220));
  }

  ensureContext() {
    if (!this.audioContext) {
      this.audioContext=new AudioContext();
      this.master=this.audioContext.createGain();
      this.master.gain.value=this.volume;
      this.master.connect(this.audioContext.destination);
    }
    if (this.audioContext.state==="suspended") this.audioContext.resume().catch(()=>{});
    return this.audioContext;
  }

  play(cue) {
    const ctx=this.ensureContext();
    const now=ctx.currentTime+0.01;
    const tone=(freq,start,dur,{type="sine",gain=.3,endFreq=null}={})=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.type=type; o.frequency.setValueAtTime(freq,start);
      if(endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(20,endFreq),start+dur);
      g.gain.setValueAtTime(.0001,start);
      g.gain.exponentialRampToValueAtTime(Math.max(.001,gain),start+.01);
      g.gain.exponentialRampToValueAtTime(.0001,start+dur);
      o.connect(g).connect(this.master); o.start(start); o.stop(start+dur+.03);
    };
    const noise=(start,dur,{gain=.3,low=0,high=0}={})=>{
      const b=ctx.createBuffer(1,Math.max(1,Math.floor(ctx.sampleRate*dur)),ctx.sampleRate),d=b.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*(1-i/d.length);
      const s=ctx.createBufferSource(),g=ctx.createGain(); s.buffer=b; g.gain.value=gain;
      let last=s;
      if(low||high){ const f=ctx.createBiquadFilter(); f.type=low&&high?"bandpass":low?"highpass":"lowpass"; f.frequency.value=low&&high?(low+high)/2:(low||high); if(low&&high) f.Q.value=1.2; last.connect(f); last=f; }
      last.connect(g).connect(this.master); s.start(start);
    };
    const seq=(notes,step=.12,dur=.22,type="triangle",gain=.3)=>notes.forEach((n,i)=>tone(n,now+i*step,dur,{type,gain}));

    switch(cue.type){
      case "drumRoll": for(let i=0;i<28;i++) noise(now+i*.075,.055,{gain:.15+i*.006,low:500,high:6500}); tone(110,now+2.12,.28,{type:"sine",gain:.45,endFreq:62}); break;
      case "levelUp": seq([261.63,329.63,392,523.25,659.25,783.99],.105,.3,"square",.19); break;
      case "choloWhistle": tone(1250,now,.55,{gain:.28,endFreq:1900}); tone(1900,now+.48,.55,{gain:.3,endFreq:1420}); tone(1420,now+.92,.28,{gain:.27,endFreq:1680}); break;
      case "fingerWhistle": tone(1800,now,.2,{gain:.34,endFreq:2550}); tone(2550,now+.18,.45,{gain:.32,endFreq:2300}); break;
      case "vineBoom": tone(82,now,.72,{type:"sine",gain:.55,endFreq:36}); noise(now,.32,{gain:.2,high:800}); break;
      case "airHorn": [220,233].forEach(f=>tone(f,now,.95,{type:"sawtooth",gain:.19,endFreq:f*.96})); break;
      case "scratch": for(let i=0;i<8;i++) noise(now+i*.06,.08,{gain:.16,low:1200,high:7000}); tone(800,now,.55,{type:"sawtooth",gain:.08,endFreq:120}); break;
      case "crowdOooh": [196,220,247,294].forEach((f,i)=>tone(f,now+i*.015,1.0,{type:"sine",gain:.075,endFreq:f*.9})); noise(now,.9,{gain:.05,low:180,high:1200}); break;
      case "applause": for(let i=0;i<24;i++) noise(now+i*.065+Math.random()*.04,.045,{gain:.09+Math.random()*.08,low:700,high:7000}); break;
      case "slowClap": [0,.62,1.24,1.86].forEach(t=>noise(now+t,.12,{gain:.26,low:500,high:6500})); break;
      case "crickets": for(let i=0;i<7;i++){ tone(4200,now+i*.27,.035,{gain:.12}); tone(4600,now+i*.27+.055,.03,{gain:.1}); } break;
      case "rimshot": tone(180,now,.08,{type:"triangle",gain:.3,endFreq:90}); noise(now+.07,.22,{gain:.24,low:1400,high:8500}); break;
      case "sadTrombone": seq([233,220,207,196],.34,.42,"sawtooth",.16); break;
      case "buzzer": tone(135,now,.75,{type:"square",gain:.25}); tone(145,now,.75,{type:"square",gain:.12}); break;
      case "error": seq([330,220],.2,.25,"square",.2); break;
      case "powerDown": tone(520,now,.9,{type:"sawtooth",gain:.2,endFreq:55}); break;
      case "censor": tone(1000,now,.75,{type:"sine",gain:.28}); break;
      case "rewind": tone(1700,now,.9,{type:"sawtooth",gain:.12,endFreq:180}); noise(now,.8,{gain:.1,low:1000,high:7000}); break;
      case "whoosh": noise(now,.6,{gain:.24,low:700,high:8000}); break;
      case "newsSting": seq([196,294,392,523],.12,.35,"sawtooth",.14); tone(98,now+.42,.55,{gain:.35,endFreq:65}); break;
      case "notification": seq([659,988],.12,.3,"sine",.25); break;
      case "camera": noise(now,.06,{gain:.22,low:800,high:9000}); tone(120,now+.07,.09,{type:"square",gain:.12}); break;
      case "cash": tone(1200,now,.18,{type:"square",gain:.11}); seq([784,988,1319],.13,.4,"sine",.22); break;
      case "coin": tone(1320,now,.18,{type:"square",gain:.18}); tone(1760,now+.1,.3,{gain:.19}); break;
      case "victory": seq([262,330,392,523,659,784],.12,.45,"square",.13); break;
      case "sparkle": seq([1047,1319,1568,2093],.09,.35,"sine",.16); break;
      case "micDrop": tone(70,now,.52,{gain:.48,endFreq:38}); noise(now+.18,.28,{gain:.19,high:900}); break;
      case "heartbeat": [0,.22,.82,1.04,1.64].forEach((t,i)=>tone(i%2?70:85,now+t,.12,{gain:.3,endFreq:55})); break;
      case "suspense": for(let i=0;i<14;i++) tone(110+i*5,now+i*.14,.11,{type:"triangle",gain:.06+i*.007}); break;
      case "reveal": seq([196,196,196],.27,.5,"sawtooth",.15); tone(98,now+.55,.55,{gain:.35,endFreq:62}); break;
      case "thunder": noise(now,1.3,{gain:.36,high:700}); tone(58,now,.95,{gain:.3,endFreq:32}); break;
      case "explosion": noise(now,.95,{gain:.48,high:1200}); tone(64,now,.8,{gain:.5,endFreq:28}); break;
      case "siren": for(let i=0;i<4;i++){ tone(620,now+i*.48,.25,{type:"sine",gain:.16,endFreq:880}); tone(880,now+i*.48+.24,.25,{type:"sine",gain:.16,endFreq:620}); } break;
      case "klaxon": [0,.42,.84,1.26].forEach(t=>{tone(185,now+t,.3,{type:"sawtooth",gain:.2});tone(205,now+t,.3,{type:"sawtooth",gain:.12});}); break;
      case "laser": tone(1500,now,.42,{type:"square",gain:.18,endFreq:110}); break;
      case "glass": for(let i=0;i<11;i++) tone(900+Math.random()*4200,now+Math.random()*.2,.22+Math.random()*.35,{type:"sine",gain:.045}); noise(now,.35,{gain:.13,low:1800,high:9500}); break;
      default: seq([440,660],.12,.25,"sine",.2);
    }
  }
}

function organicWavePath(seed) {
  const segments=16, viewW=100, viewH=30, mid=viewH/2; let hash=0;
  for(let i=0;i<seed.length;i++) hash=(hash*31+seed.charCodeAt(i))>>>0;
  const amplitudeAt=i=>{const x=Math.sin((hash+i*97)*12.9898)*43758.5453; const rand=x-Math.floor(x); const envelope=Math.sin((Math.PI*i)/segments)*.7+.3; return(.2+rand*.8)*envelope;};
  const stepX=viewW/segments,top=[],bottom=[];
  for(let i=0;i<=segments;i++){const a=amplitudeAt(i),x=(i*stepX).toFixed(1);top.push(`${x} ${(mid-a*(mid-1.5)).toFixed(1)}`);bottom.unshift(`${x} ${(mid+a*(mid-1.5)).toFixed(1)}`);}
  return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
}
