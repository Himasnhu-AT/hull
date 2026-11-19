// AOTT HUD stylesheet: the "iron and bone" identity. Graphite translucent panels with hairline borders,
// bone text, one accent (signal amber), oxblood for danger, steel for info; system-ui sans, uppercase letter-spaced
// labels, tabular numerals. Injected once by hud.ts. Everything in play hugs the corners; the centre holds only the
// reticle and the world markers.

export const HUD_CSS = `
.aott-root{--panel:rgba(14,16,18,.72);--panel-s:rgba(14,16,18,.9);--line:rgba(230,225,214,.14);--line-s:rgba(230,225,214,.28);
  --bone:#e6e1d6;--muted:#9a968c;--amber:#f0a43a;--amber-d:rgba(240,164,58,.14);--blood:#c4372b;--steel:#8fb3c9;
  --ink:#0b0c0d;--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --shadow:0 1px 2px rgba(0,0,0,.85);--gut:20px;--s:1;
  position:fixed;inset:0;z-index:10;pointer-events:none;overflow:hidden;font-family:var(--font);color:var(--bone);
  font-feature-settings:"tnum" 1;-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none}
.aott-root *{box-sizing:border-box}
.aott-root button{font:inherit;margin:0;color:inherit}
.aott-game{position:absolute;inset:0;pointer-events:none;transition:opacity .35s}
.aott-root.hud-off .aott-game{opacity:0}
.aott-num{font-variant-numeric:tabular-nums}

.aott-panel{background:var(--panel);border:1px solid var(--line);border-radius:2px;box-shadow:0 8px 24px rgba(0,0,0,.28)}
.aott-label{font-size:10px;font-weight:650;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);white-space:nowrap;text-shadow:var(--shadow)}

/* ---------- top-left: emblem + mode ---------- */
.aott-tl{position:absolute;left:var(--gut);top:16px;transform:scale(var(--s));transform-origin:0 0;display:flex;align-items:center;gap:10px;padding:6px 14px 6px 8px}
.aott-tl svg{width:20px;height:24px;flex:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
.aott-mode{display:flex;flex-direction:column;gap:2px}
.aott-mode b{font-size:12px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;text-shadow:var(--shadow)}
.aott-mode span{font-size:10px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--amber);text-shadow:var(--shadow)}
.aott-mode span:empty{display:none}

/* ---------- bottom-left: status (HP, gas, blades) + controls card ---------- */
.aott-blc{position:absolute;left:var(--gut);bottom:var(--gut);transform:scale(var(--s));transform-origin:0 100%;display:flex;flex-direction:column;align-items:flex-start;gap:8px;
  max-width:calc(100vw - 2 * var(--gut))}
.aott-status{width:292px;max-width:100%;padding:11px 14px 12px;display:grid;grid-template-columns:52px 1fr 38px;align-items:center;gap:9px 10px}
.aott-status .v{font-size:13px;font-weight:650;text-align:right;font-variant-numeric:tabular-nums;text-shadow:var(--shadow)}
.aott-status .v small{font-size:9px;font-weight:600;color:var(--muted);margin-left:1px}
.aott-track{position:relative;height:4px;background:rgba(230,225,214,.12);overflow:hidden}
.aott-fill{position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(1);background:var(--bone)}
.aott-hp .aott-fill{transition:background-color .2s}
.aott-status[data-low="1"] .aott-hp .aott-fill{background:var(--blood)}
.aott-status[data-low="1"] .aott-hp{animation:aott-blink .5s ease-in-out infinite alternate}
.aott-status[data-low="1"] .v.hp{color:#ec8a7f}
.aott-gas{height:9px;background:rgba(230,225,214,.08)}
.aott-gas .aott-fill{background:var(--amber)}
.aott-gas::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(90deg,transparent 0 calc(5% - 2px),rgba(10,11,12,.95) calc(5% - 2px) 5%)}
.aott-gas[data-lv="low"] .aott-fill{background:var(--blood);animation:aott-blink .45s ease-in-out infinite alternate}
.aott-gas[data-lv="mid"] .aott-fill{background:#d98f2e}
.aott-blades{display:flex;gap:6px;align-items:center}
.aott-blade{position:relative;flex:1;height:8px;max-width:84px;background:rgba(230,225,214,.1);overflow:hidden;
  clip-path:polygon(0 0,86% 0,100% 50%,86% 100%,0 100%)}
.aott-blade .aott-fill{background:linear-gradient(90deg,#b9b4a8,var(--bone) 70%,#fff)}
.aott-blades.low .aott-fill{background:var(--blood)}
.aott-blades.swap{animation:aott-blink .25s ease-in-out infinite alternate}
@keyframes aott-blink{from{opacity:1}to{opacity:.35}}

.aott-cc{display:grid;grid-template-columns:auto auto;gap:5px 10px;align-items:center;padding:10px 14px 10px 12px;font-size:11.5px;line-height:1.2;
  color:var(--muted);opacity:0;visibility:hidden;transform:translateY(6px);transition:opacity .2s,transform .2s,visibility .2s}
.aott-cc.on{opacity:1;visibility:visible;transform:none}
.aott-cc .k{display:flex;gap:3px;justify-content:flex-end}
.aott-cc .t{white-space:nowrap}
.aott-cc .t b{color:var(--bone);font-weight:650}
.aott-root .aott-cc kbd{height:18px;min-width:19px;padding:0 4px;font-size:10px}

/* ---------- bottom-right: speed, combo, kills, score ---------- */
.aott-br{position:absolute;right:var(--gut);bottom:var(--gut);transform:scale(var(--s));transform-origin:100% 100%;width:212px;padding:10px 14px 12px}
.aott-combo{position:absolute;right:0;bottom:calc(100% + 8px);font-size:13px;font-weight:800;letter-spacing:.22em;color:var(--amber);
  text-shadow:0 0 12px rgba(240,164,58,.35),var(--shadow);opacity:0;transition:opacity .2s;white-space:nowrap}
.aott-combo.on{opacity:1}
.aott-speed-row{display:flex;align-items:baseline;justify-content:flex-end;gap:7px}
.aott-speed{font-size:46px;font-weight:700;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums;text-shadow:0 2px 10px rgba(0,0,0,.45)}
.aott-speed-row .aott-label{color:var(--muted)}
.aott-speed-bar{margin:8px 0 9px;height:2px}
.aott-speed-bar .aott-fill{background:var(--amber);transform:scaleX(0)}
.aott-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;border-top:1px solid var(--line);padding-top:8px}
.aott-stats div{display:flex;flex-direction:column;gap:2px}
.aott-stats div + div{text-align:right}
.aott-stats b{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}

/* ---------- top-right: training clock, then the feed ---------- */
.aott-tr{position:absolute;right:var(--gut);top:16px;transform:scale(var(--s));transform-origin:100% 0;min-width:176px;padding:8px 14px 9px;display:none}
.aott-tr.on{display:block}
.aott-tr-row{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.aott-tr-row[hidden]{display:none}
.aott-tr-row + .aott-tr-row{margin-top:4px}
.aott-tr-row b{font-size:22px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.aott-tr-row b.sm{font-size:16px}
.aott-feed{position:absolute;right:var(--gut);top:16px;transform:scale(var(--s));transform-origin:100% 0;display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:min(380px,calc(100vw - 40px))}
.aott-root.tr-on .aott-feed{top:calc(16px + 76px * var(--s))}
.aott-feed div{padding:6px 12px 6px 11px;font-size:12.5px;line-height:1.3;color:var(--bone);background:var(--panel);border:1px solid var(--line);
  border-right:2px solid var(--line-s);opacity:0;transform:translateX(10px);transition:opacity .22s,transform .22s}
.aott-feed div.on{opacity:1;transform:none}
.aott-feed div.kill{border-right-color:var(--amber)}
.aott-feed div.warn{border-right-color:var(--blood);color:#f2d3cf}
.aott-feed div.radio{border-right-color:var(--steel)}
.aott-feed b{font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:11px;color:var(--steel)}
.aott-feed div.warn b{color:#ec8a7f}

/* ---------- top-centre: objective + toast ---------- */
.aott-obj{position:absolute;left:50%;top:16px;transform:translateX(-50%) scale(var(--s));transform-origin:50% 0;max-width:min(760px,calc(100vw - 480px));padding:7px 16px 7px 14px;
  display:flex;align-items:center;gap:10px;font-size:11.5px;font-weight:650;letter-spacing:.16em;text-transform:uppercase;
  white-space:nowrap;opacity:0;transition:opacity .3s}
.aott-obj::before{content:"";flex:none;width:6px;height:6px;background:var(--amber);transform:rotate(45deg)}
.aott-obj span{overflow:hidden;text-overflow:ellipsis}
.aott-obj.on{opacity:1}
.aott-toast{position:absolute;left:50%;top:calc(16px + 44px * var(--s));transform:translate(-50%,-6px) scale(var(--s));transform-origin:50% 0;max-width:min(640px,calc(100vw - 40px));padding:9px 18px;
  font-size:14px;font-weight:650;letter-spacing:.04em;text-align:center;border-radius:2px;opacity:0;transition:opacity .22s,transform .22s}
.aott-toast.on{opacity:1;transform:translate(-50%,0) scale(var(--s))}
.aott-toast.info{background:var(--panel-s);border:1px solid var(--line);box-shadow:inset 0 2px 0 var(--amber),0 8px 24px rgba(0,0,0,.35);color:var(--bone)}
.aott-toast.warn{background:rgba(120,24,18,.92);border:1px solid rgba(236,138,127,.5);color:#fff3f0;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.aott-toast.warn.on{animation:aott-shake .36s}
@keyframes aott-shake{0%,100%{transform:translate(-50%,0) scale(var(--s))}25%{transform:translate(calc(-50% - 5px),0) scale(var(--s))}75%{transform:translate(calc(-50% + 5px),0) scale(var(--s))}}

/* ---------- centre: reticle, hook state, aim distance ---------- */
.aott-ret{position:fixed;left:50%;top:50%;width:0;height:0;transform:scale(var(--s))}
.aott-ticks{position:absolute;left:0;top:0;width:0;height:0;transition:transform .14s,opacity .14s}
.aott-ticks i{position:absolute;left:-.75px;top:-12px;width:1.5px;height:6px;background:var(--bone);box-shadow:0 0 0 1px rgba(0,0,0,.4),0 0 3px rgba(0,0,0,.5);
  transform-origin:.75px 12px;transition:background-color .14s}
.aott-ticks i:nth-child(2){transform:rotate(90deg)}
.aott-ticks i:nth-child(3){transform:rotate(180deg)}
.aott-ticks i:nth-child(4){transform:rotate(270deg)}
.aott-ret[data-valid="0"] .aott-ticks{transform:rotate(45deg) scale(.8);opacity:.75}
.aott-ret[data-valid="0"] .aott-ticks i{background:var(--blood)}
.aott-dot{position:absolute;left:-1.5px;top:-1.5px;width:3px;height:3px;border-radius:50%;background:var(--bone);box-shadow:0 0 0 1px rgba(0,0,0,.5)}
.aott-ret[data-valid="0"] .aott-dot{opacity:.45}
.aott-lock{position:absolute;left:-22px;top:-22px;width:44px;height:44px;overflow:visible;opacity:0;transform:scale(1.25);transition:opacity .12s,transform .12s}
.aott-ret[data-lock="1"] .aott-lock{opacity:1;transform:none}
.aott-dist{position:absolute;left:0;top:22px;transform:translateX(-50%);padding:1px 5px 1px 6px;white-space:nowrap;font-size:10px;font-weight:650;
  letter-spacing:.12em;font-variant-numeric:tabular-nums;color:var(--bone);background:rgba(14,16,18,.55);border-radius:2px}
.aott-dist:empty{display:none}
.aott-hk{position:absolute;top:-9px;width:10px;height:18px;color:rgba(230,225,214,.5);transition:color .08s,transform .08s}
.aott-hk[data-side="0"]{left:-36px}
.aott-hk[data-side="1"]{left:26px}
.aott-hk svg{position:absolute;inset:0;width:10px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:square;filter:drop-shadow(0 0 1px rgba(0,0,0,.9))}
.aott-hk span{position:absolute;left:-6px;right:-6px;top:21px;text-align:center;font-size:9px;font-weight:700;letter-spacing:.08em;color:inherit;text-shadow:0 1px 2px #000}
.aott-hk[data-state="flying"]{color:rgba(240,164,58,.75)}
.aott-hk[data-state="attached"]{color:var(--amber);filter:drop-shadow(0 0 3px rgba(240,164,58,.7))}
.aott-hk[data-side="0"][data-state="attached"]{transform:translateX(-4px)}
.aott-hk[data-side="1"][data-state="attached"]{transform:translateX(4px)}

/* ---------- world markers: nape diamonds, rope targets, threat chevrons ---------- */
.aott-napes,.aott-tgts,.aott-threats{position:absolute;inset:0;pointer-events:none;overflow:hidden;transition:opacity .15s}
.aott-nape{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}
.aott-nape i{position:absolute;left:-4.5px;top:-4.5px;width:9px;height:9px;background:var(--blood);border:1px solid #f4e2dc;transform:rotate(45deg);
  box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 6px rgba(196,55,43,.75)}
.aott-nape b{position:absolute;left:9px;top:-7px;padding:1px 4px;font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--bone);white-space:nowrap;
  font-variant-numeric:tabular-nums;background:rgba(14,16,18,.6);border-radius:2px}
.aott-nape b:empty{display:none}
.aott-root.grabbed .aott-tgts,.aott-root.grabbed .aott-threats{opacity:0}
.aott-tgt{position:absolute;left:0;top:0;width:0;height:0;display:none;will-change:transform;color:var(--amber)}
.aott-tgt svg{position:absolute;top:-12px;width:9px;height:24px;overflow:visible;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:square;
  filter:drop-shadow(0 0 1.5px rgba(0,0,0,.95));transition:transform .1s}
.aott-tgt[data-side="0"] svg{left:-15px}
.aott-tgt[data-side="1"] svg{left:6px}
.aott-tgt i{position:absolute;left:-2px;top:-2px;width:4px;height:4px;background:currentColor;box-shadow:0 0 0 1px rgba(0,0,0,.6)}
.aott-tgt[data-att="1"] i{left:-3px;top:-3px;width:6px;height:6px;box-shadow:0 0 0 1px rgba(0,0,0,.7),0 0 0 4px rgba(240,164,58,.3)}
.aott-root .aott-tgt kbd,.aott-root .aott-tgt kbd.z,.aott-root .aott-tgt kbd.x{position:absolute;top:-30px;height:16px;min-width:16px;padding:0 3px;font-size:10px;border-bottom-width:1px;
  color:var(--ink);background:var(--amber);border-color:var(--amber)}
.aott-tgt[data-side="0"] kbd{right:6px}
.aott-tgt[data-side="1"] kbd{left:6px}
.aott-tgt[data-att="1"] svg{stroke-width:3;filter:drop-shadow(0 0 4px rgba(240,164,58,.8)) drop-shadow(0 0 1px #000)}
.aott-tgt[data-side="0"][data-att="1"] svg{transform:translateX(5px)}
.aott-tgt[data-side="1"][data-att="1"] svg{transform:translateX(-5px)}
.aott-thr{position:absolute;left:0;top:0;width:0;height:0;display:none;will-change:transform}
.aott-thr svg{position:absolute;left:-10px;top:-9px;width:20px;height:16px;overflow:visible;fill:var(--blood);stroke:rgba(10,4,3,.8);stroke-width:1.2;
  stroke-linejoin:round;opacity:.85;filter:drop-shadow(0 0 3px rgba(196,55,43,.6))}
.aott-thr.danger svg{fill:#e5483a;opacity:1;transform:scale(1.35);animation:aott-thr .38s ease-in-out infinite alternate}
@keyframes aott-thr{from{transform:scale(1.3)}to{transform:scale(1.6);filter:drop-shadow(0 0 7px rgba(229,72,58,.9))}}

/* ---------- kill cam / cutscenes: a clean frame ---------- */
.aott-ret,.aott-status,.aott-br,.aott-tr,.aott-tl{transition:opacity .15s}
.aott-root.cine .aott-ret,.aott-root.cine .aott-napes,.aott-root.cine .aott-tgts,.aott-root.cine .aott-threats,
.aott-root.cine .aott-hint,.aott-root.cine .aott-cc{opacity:0}
.aott-root.cine .aott-status,.aott-root.cine .aott-br,.aott-root.cine .aott-tr,.aott-root.cine .aott-obj.on,.aott-root.cine .aott-tl{opacity:.16}
.aott-game::before,.aott-game::after{content:"";position:absolute;left:0;right:0;height:0;background:#000;z-index:1;pointer-events:none;transition:height .18s ease-out}
.aott-game::before{top:0}
.aott-game::after{bottom:0}
.aott-root.cine .aott-game::before,.aott-root.cine .aott-game::after{height:9vh}

/* ---------- bottom-centre: tutorial hint ---------- */
.aott-hint{position:absolute;left:50%;bottom:var(--gut);transform-origin:50% 100%;display:flex;align-items:center;gap:12px;padding:9px 18px 9px 10px;
  max-width:min(600px,calc(100vw - 600px));min-width:min(260px,calc(100vw - 40px));font-size:14px;font-weight:550;line-height:1.3;color:var(--bone);
  opacity:0;transform:translate(-50%,8px) scale(var(--s));transition:opacity .22s,transform .22s}
.aott-hint.on{opacity:1;transform:translate(-50%,0) scale(var(--s))}
.aott-root.grabbed .aott-hint{opacity:0}
.aott-hint .ks{display:flex;gap:4px;flex:none}
.aott-root .aott-hint kbd{height:26px;min-width:28px;font-size:13px}

/* ---------- hurt: an oxblood edge flash; grabbed: vignette + mash prompt ---------- */
.aott-hit,.aott-vig{position:absolute;inset:0;pointer-events:none;opacity:0}
.aott-hit{background:radial-gradient(ellipse 80% 75% at 50% 50%,transparent 55%,rgba(196,55,43,.55) 100%)}
.aott-vig{transition:opacity .2s;background:radial-gradient(ellipse 75% 70% at 50% 50%,transparent 50%,rgba(120,12,6,.7) 100%)}
.aott-root.grabbed .aott-vig{opacity:1;animation:aott-vig .9s ease-in-out infinite alternate}
@keyframes aott-vig{from{opacity:.7}to{opacity:1}}
.aott-grab{position:absolute;left:50%;top:64%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:12px;
  padding:18px 30px 16px;background:rgba(14,16,18,.78);border:1px solid rgba(196,55,43,.55);border-radius:2px;box-shadow:0 12px 40px rgba(0,0,0,.4);
  opacity:0;visibility:hidden;transition:opacity .15s,visibility .15s}
.aott-root.grabbed .aott-grab{opacity:1;visibility:visible}
.aott-grab-t{display:flex;align-items:center;gap:14px;font-weight:800;font-size:clamp(26px,4.4vw,48px);letter-spacing:.24em;padding-left:.24em;
  color:var(--bone);text-shadow:0 2px 14px rgba(0,0,0,.8);white-space:nowrap;animation:aott-mash .3s ease-in-out infinite alternate}
.aott-root .aott-grab-t kbd{height:auto;padding:8px 0;min-width:clamp(110px,14vw,180px);font-size:clamp(14px,2vw,20px);letter-spacing:.14em;
  color:var(--ink);background:var(--amber);border-color:var(--amber);border-bottom:4px solid #9a6420;animation:aott-press .15s ease-in-out infinite alternate}
@keyframes aott-mash{from{transform:scale(1)}to{transform:scale(1.05)}}
@keyframes aott-press{from{transform:translateY(0)}to{transform:translateY(2px);border-bottom-width:2px}}
.aott-grab-bar{width:min(340px,70vw);height:6px;background:rgba(230,225,214,.14)}
.aott-grab .aott-label{color:#ec8a7f;font-size:11px}
.aott-grab-bar .aott-fill{background:var(--amber);transform:scaleX(0)}

/* ---------- subtitles, fades, cinematic lines ---------- */
.aott-sub{position:absolute;left:50%;bottom:12vh;transform:translateX(-50%);width:max-content;max-width:min(880px,88vw);text-align:center;z-index:3;
  padding:6px 16px;font-size:clamp(15px,1.7vw,21px);font-weight:500;line-height:1.42;color:#f4f1ea;text-wrap:balance;opacity:0;transition:opacity .25s;
  text-shadow:0 1px 2px #000,0 0 10px rgba(0,0,0,.95),0 0 22px rgba(0,0,0,.7)}
.aott-sub.on{opacity:1}
.aott-sub b{display:block;margin-bottom:2px;font-size:.62em;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:var(--amber)}
.aott-sub.narr span{font-style:italic;color:#e9e2cf}
.aott-fade{position:absolute;inset:0;background:#000;opacity:0;transition:opacity .6s;pointer-events:none;z-index:1}
.aott-fade.on{opacity:1}
.aott-big{position:absolute;left:0;right:0;top:27%;text-align:center;opacity:0;transition:opacity .6s}
.aott-big.on{opacity:1}
.aott-big span{display:inline-block;max-width:94vw;padding-left:.26em;text-wrap:balance;font-weight:800;line-height:1.15;text-transform:uppercase;
  font-size:clamp(20px,3.8vw,50px);letter-spacing:.26em;color:var(--bone);text-shadow:0 2px 18px rgba(0,0,0,.7),0 0 2px rgba(0,0,0,.8)}
.aott-big i{display:block;height:1px;margin:14px auto 0;width:min(36vw,380px);transform:scaleX(0);
  background:linear-gradient(90deg,transparent,var(--amber),transparent)}
.aott-big.on span{animation:aott-big-in .8s cubic-bezier(.2,.7,.2,1) both}
.aott-big.on i{animation:aott-line .8s .15s ease-out both}
@keyframes aott-big-in{from{letter-spacing:.5em;opacity:0}to{letter-spacing:.26em;opacity:1}}
@keyframes aott-line{to{transform:scaleX(1)}}

/* ---------- damage numbers ---------- */
.aott-dmgs{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.aott-dmg{position:absolute;left:0;top:0;transform:translate(-50%,-50%);font-weight:800;font-size:30px;line-height:1;letter-spacing:-.01em;
  color:var(--bone);white-space:nowrap;font-variant-numeric:tabular-nums;will-change:transform,opacity;
  text-shadow:-1.5px -1.5px 0 #0b0c0d,1.5px -1.5px 0 #0b0c0d,-1.5px 1.5px 0 #0b0c0d,1.5px 1.5px 0 #0b0c0d,0 2px 8px rgba(0,0,0,.6);
  animation:aott-dmg 1.2s cubic-bezier(.2,.8,.3,1) forwards}
.aott-dmg.kill{font-size:50px;color:var(--amber);
  text-shadow:-2px -2px 0 #0b0c0d,2px -2px 0 #0b0c0d,-2px 2px 0 #0b0c0d,2px 2px 0 #0b0c0d,0 0 16px rgba(240,164,58,.45)}
@keyframes aott-dmg{
  0%{opacity:0;transform:translate(-50%,-50%) scale(.4)}
  14%{opacity:1;transform:translate(-50%,-50%) scale(1.18)}
  26%{opacity:1;transform:translate(-50%,-50%) scale(1)}
  70%{opacity:1;transform:translate(-50%,calc(-50% - 24px)) scale(1)}
  100%{opacity:0;transform:translate(-50%,calc(-50% - 64px)) scale(.94)}}
@keyframes aott-dmg-fade{0%{opacity:0}10%,70%{opacity:1}100%{opacity:0}}

/* ---------- keycaps ---------- */
.aott-root kbd{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:22px;padding:0 6px;
  font-family:var(--font);font-weight:700;font-size:11.5px;line-height:1;letter-spacing:.02em;white-space:nowrap;vertical-align:middle;
  color:var(--bone);background:rgba(230,225,214,.08);border:1px solid var(--line-s);border-bottom-width:2px;border-radius:3px}
.aott-root kbd.z,.aott-root kbd.x{color:var(--amber);border-color:rgba(240,164,58,.55)}
.aott-root kbd.w{min-width:48px}
.aott-root kbd.sp{min-width:96px}

/* ---------- full screens ---------- */
.aott-screen{position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;pointer-events:none;opacity:0;visibility:hidden;
  transition:opacity .35s,visibility .35s;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:rgba(230,225,214,.2) transparent}
.aott-screen.on{opacity:1;visibility:visible;pointer-events:auto}
.aott-center{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px}
.aott-split{min-height:100%;display:grid;grid-template-columns:minmax(320px,clamp(440px,28vw,540px)) minmax(0,1fr);align-items:end;gap:48px;
  padding:clamp(28px,6vh,64px) clamp(24px,5vw,72px)}
.aott-split > .aott-side{align-self:end;justify-self:end;width:min(640px,100%)}
.aott-menu{background:linear-gradient(90deg,rgba(9,10,11,.94) 0%,rgba(9,10,11,.8) 30%,rgba(9,10,11,.28) 62%,rgba(9,10,11,.1) 100%),
  linear-gradient(0deg,rgba(9,10,11,.55),transparent 40%)}
.aott-pause{background:linear-gradient(90deg,rgba(9,10,11,.92) 0%,rgba(9,10,11,.78) 34%,rgba(9,10,11,.5) 100%);
  backdrop-filter:blur(3px) saturate(.7);-webkit-backdrop-filter:blur(3px) saturate(.7)}
.aott-dim{background:rgba(9,10,11,.8);backdrop-filter:blur(3px) saturate(.7);-webkit-backdrop-filter:blur(3px) saturate(.7)}
.aott-death{background:radial-gradient(ellipse 80% 70% at 50% 45%,rgba(70,10,6,.4),rgba(9,6,6,.94) 75%)}
.aott-death.win{background:radial-gradient(ellipse 80% 70% at 50% 45%,rgba(60,44,18,.3),rgba(9,10,11,.93) 75%)}

/* brand block (title) */
.aott-brand{display:flex;flex-direction:column;gap:0}
.aott-brand svg{width:clamp(48px,3.8vw,76px);height:auto;aspect-ratio:100/120;margin-bottom:18px;filter:drop-shadow(0 4px 14px rgba(0,0,0,.5))}
.aott-word{margin:0;font-size:clamp(64px,8.4vw,150px);font-weight:900;line-height:.86;letter-spacing:.2em;margin-right:-.2em;color:var(--bone);
  text-shadow:0 4px 30px rgba(0,0,0,.45)}
.aott-tag{display:flex;align-items:center;gap:12px;margin-top:18px;font-size:12px;font-weight:650;letter-spacing:.32em;text-transform:uppercase;color:var(--muted)}
.aott-tag::before{content:"";width:28px;height:1px;background:var(--amber)}
.aott-h{margin:0;font-size:clamp(30px,4vw,44px);font-weight:800;letter-spacing:.2em;text-transform:uppercase;line-height:1}
.aott-main{display:flex;flex-direction:column;min-width:0}
.aott-h-sm,.aott-card-h .aott-h{font-size:22px;letter-spacing:.22em}
.aott-card .aott-keys-note{margin:-4px 0 18px}
.aott-kicker{font-size:11px;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--amber)}
.aott-death:not(.win) .aott-kicker{color:#e0675a}
.aott-note{margin:0;font-size:12.5px;line-height:1.5;color:var(--muted)}
.aott-note b{color:var(--bone);font-weight:650}
.aott-foot{margin-top:22px;font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:rgba(154,150,140,.8)}

/* menu rows: the title list, pause list, mission chapters */
.aott-rows{display:flex;flex-direction:column;margin-top:34px;border-bottom:1px solid var(--line)}
.aott-row{pointer-events:auto;cursor:pointer;position:relative;display:grid;grid-template-columns:34px 1fr 16px;align-items:center;column-gap:10px;
  width:100%;padding:13px 14px 13px 12px;text-align:left;background:transparent;border:0;border-top:1px solid var(--line);
  transition:background-color .15s}
.aott-row::before{content:"";position:absolute;left:0;top:-1px;bottom:0;width:2px;background:var(--amber);transform:scaleY(0);transition:transform .15s}
.aott-row i{font-style:normal;font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--muted);font-variant-numeric:tabular-nums}
.aott-row b{display:block;font-size:15px;font-weight:700;letter-spacing:.2em;text-transform:uppercase}
.aott-row small{display:block;margin-top:3px;font-size:12px;letter-spacing:.02em;color:var(--muted)}
.aott-row u{text-decoration:none;font-size:15px;color:var(--muted);opacity:0;transform:translateX(-4px);transition:opacity .15s,transform .15s}
.aott-row:hover,.aott-row.sel,.aott-row:focus-visible{background:linear-gradient(90deg,var(--amber-d),rgba(240,164,58,.02) 80%)}
.aott-row:hover::before,.aott-row.sel::before,.aott-row:focus-visible::before{transform:none}
.aott-row:hover i,.aott-row.sel i,.aott-row:focus-visible i,.aott-row.sel u,.aott-row:hover u{color:var(--amber)}
.aott-row.sel u,.aott-row:hover u{opacity:1;transform:none}
.aott-row:focus{outline:none}
.aott-row.sub b{font-size:13px;color:var(--muted)}
.aott-row.sub.sel b,.aott-row.sub:hover b{color:var(--bone)}
.aott-row.locked{cursor:default;opacity:.4}
.aott-row[hidden]{display:none}

/* plain buttons (death, results, keys) */
.aott-btns{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:26px}
.aott-btn{pointer-events:auto;cursor:pointer;min-width:168px;padding:12px 22px;border-radius:2px;border:1px solid var(--line-s);background:rgba(230,225,214,.04);
  font-size:12px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;transition:background-color .15s,border-color .15s,color .15s}
.aott-btn.primary{border-color:rgba(240,164,58,.6);color:var(--amber)}
.aott-btn:hover,.aott-btn.sel,.aott-btn:focus-visible{border-color:var(--amber);background:var(--amber-d);color:#fff}
.aott-btn.primary.sel,.aott-btn.primary:hover{background:var(--amber);color:var(--ink)}
.aott-btn:focus{outline:none}
.aott-btn[hidden]{display:none}

/* cards */
.aott-card{width:min(720px,100%);padding:26px 28px 28px;background:var(--panel-s);border:1px solid var(--line);border-radius:2px;
  box-shadow:0 24px 60px rgba(0,0,0,.45)}
.aott-card-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:12px;margin-bottom:16px;border-bottom:1px solid var(--line)}
.aott-cells{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);margin-top:24px}
.aott-cells div{padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.aott-cells div + div{border-left:1px solid var(--line)}
.aott-cells b{font-size:clamp(20px,2.6vw,28px);font-weight:700;font-variant-numeric:tabular-nums}
.aott-cells b small{font-size:.45em;font-weight:650;letter-spacing:.14em;color:var(--muted);margin-left:5px}
.aott-end{width:min(620px,100%);text-align:center}
.aott-end .aott-cells div{align-items:center}
.aott-cause{margin:12px 0 0;font-size:clamp(26px,4vw,46px);font-weight:800;letter-spacing:.08em;text-transform:uppercase;line-height:1.08;text-wrap:balance}
.aott-badge{display:none;margin-top:12px;padding:5px 12px;text-transform:uppercase;font-size:10.5px;font-weight:800;letter-spacing:.28em;color:var(--ink);background:var(--amber)}
.aott-result-card.rec .aott-badge{display:inline-block}
.aott-time{margin-top:14px;font-size:clamp(52px,8vw,88px);font-weight:700;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}

/* controls reference (title + pause): MOVE / ROPES / GAS / CUT */
.aott-ctl-card{padding:16px 18px 16px}
.aott-ctl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}
.aott-grp{display:flex;flex-direction:column;align-items:center;gap:10px;min-width:0;padding:12px 8px 12px;background:rgba(14,16,18,.92)}
.aott-grp-h{font-size:10.5px;font-weight:700;letter-spacing:.26em;color:var(--muted)}
.aott-grp-k{display:flex;align-items:flex-end;justify-content:center;gap:5px;height:57px}
.aott-root .aott-grp-k kbd{height:27px;min-width:30px;font-size:13px}
.aott-root .aott-grp-k kbd.w{min-width:62px}
.aott-root .aott-grp-k kbd.sp{min-width:104px}
.aott-arrows{display:grid;grid-template-columns:repeat(3,30px);grid-template-rows:27px 27px;gap:3px}
.aott-arrows kbd:nth-child(1){grid-column:2;grid-row:1}
.aott-arrows kbd:nth-child(2){grid-column:1;grid-row:2}
.aott-arrows kbd:nth-child(3){grid-column:2;grid-row:2}
.aott-arrows kbd:nth-child(4){grid-column:3;grid-row:2}
.aott-grp ul{list-style:none;margin:0;padding:0;font-size:11.5px;line-height:1.45;text-align:center;color:var(--muted)}
.aott-grp li b{color:var(--bone);font-weight:650}
.aott-ctl-more{margin-top:12px;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:6px 14px;font-size:11.5px;color:var(--muted)}
.aott-ctl-more span{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.aott-root .aott-ctl-more kbd{height:19px;min-width:20px;padding:0 4px;font-size:10px}
.aott-ctl-card .aott-note{margin-top:10px;text-align:center;font-size:11.5px}

/* KEYS */
.aott-keys-card{width:min(860px,100%)}
.aott-kb{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 28px}
.aott-kb-h{grid-column:1/-1;margin-top:12px;padding-bottom:5px;border-bottom:1px solid var(--line);font-size:10.5px;font-weight:700;letter-spacing:.26em;color:var(--amber)}
.aott-kb-h:first-child{margin-top:0}
.aott-kb-r{display:grid;grid-template-columns:1fr 88px 88px;gap:6px;align-items:center;padding:3px 0;font-size:13px;color:var(--bone)}
.aott-kb-r button{pointer-events:auto;cursor:pointer;height:28px;padding:0 6px;border-radius:3px;font-weight:700;font-size:12.5px;
  background:rgba(230,225,214,.07);border:1px solid var(--line-s);border-bottom-width:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:border-color .12s,background-color .12s}
.aott-kb-r button:hover{border-color:rgba(230,225,214,.5)}
.aott-kb-r button:focus{outline:none}
.aott-kb-r button.empty{color:var(--muted);font-weight:500}
.aott-kb-r button.wait{border-color:var(--amber);color:var(--amber);background:var(--amber-d);animation:aott-blink .5s ease-in-out infinite alternate}
.aott-kb-r button.sel,.aott-kb-r button:focus-visible{border-color:var(--amber);box-shadow:0 0 0 1px var(--amber)}

/* MISSIONS */
.aott-missions-card{width:min(760px,100%)}
.aott-mlist{display:flex;flex-direction:column;gap:22px}
.aott-mission-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:8px}
.aott-mission-h b{font-size:15px;font-weight:800;letter-spacing:.2em;text-transform:uppercase}
.aott-mission-h span{font-size:10.5px;font-weight:650;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.aott-mission .aott-rows{margin-top:0}

/* ---------- responsive ---------- */
@media (min-width:1600px) and (min-height:900px){.aott-root{--s:1.2;--gut:28px}}
@media (min-width:2200px) and (min-height:1250px){.aott-root{--s:1.5;--gut:36px}}
@media (max-width:1180px){
  .aott-hint{bottom:calc(var(--gut) + 150px);max-width:min(560px,calc(100vw - 40px))}
}
@media (max-width:1000px){
  .aott-split{grid-template-columns:1fr;align-items:start;gap:28px}
  .aott-split > .aott-side{justify-self:stretch;width:100%;max-width:720px}
  .aott-split > .aott-main{max-width:560px}
  .aott-menu{background:linear-gradient(180deg,rgba(9,10,11,.9),rgba(9,10,11,.78))}
  .aott-obj{max-width:calc(100vw - 260px)}
}
@media (max-height:760px) and (min-width:1001px){
  .aott-word{font-size:clamp(56px,13vh,104px)}
  .aott-brand svg{width:44px;margin-bottom:12px}
  .aott-tag{margin-top:14px}
  .aott-rows{margin-top:22px}
  .aott-row{padding-top:10px;padding-bottom:10px}
  .aott-grp ul{display:none}
  .aott-grp-k{height:auto}
}
@media (max-width:700px){
  /* phone-sized: speed top-left, training clock top-right, objective and toast under them; the status block bottom-left,
     hint and feed stacked above it. The controls card and the mode badge give way. */
  .aott-root{--gut:10px}
  .aott-tl,.aott-cc{display:none}
  .aott-br{top:10px;left:10px;right:auto;bottom:auto;width:auto;min-width:118px;padding:6px 10px;transform-origin:0 0}
  .aott-combo{right:auto;left:0;bottom:auto;top:calc(100% + 6px)}
  .aott-speed{font-size:28px}
  .aott-speed-bar{margin:5px 0 0}
  .aott-stats{display:none}
  .aott-tr{top:10px;right:10px;min-width:0;padding:5px 10px}
  .aott-tr-row b{font-size:18px}
  .aott-obj{top:64px;max-width:calc(100vw - 20px);font-size:10.5px;letter-spacing:.12em;white-space:normal;line-height:1.35}
  .aott-toast{top:140px;font-size:13px;max-width:calc(100vw - 20px)}
  .aott-feed{top:auto;bottom:196px;max-width:calc(100vw - 20px)}
  .aott-root.tr-on .aott-feed{top:auto}
  .aott-status{width:min(292px,calc(100vw - 20px))}
  .aott-hint{bottom:128px;max-width:calc(100vw - 20px);font-size:13px}
  .aott-ctl{grid-template-columns:repeat(2,minmax(0,1fr))}
  .aott-kb{grid-template-columns:1fr}
  .aott-cells div{padding:10px 8px}
  .aott-card{padding:20px 16px 22px}
}

/* ---------- reduced motion: keep the fades, drop the movement and the pulsing ---------- */
@media (prefers-reduced-motion:reduce){
  .aott-root .aott-hp,.aott-root .aott-fill,.aott-root .aott-blades,.aott-root .aott-thr svg,.aott-root .aott-vig,.aott-root .aott-grab-t,
  .aott-root .aott-grab-t kbd,.aott-root .aott-kb-r button.wait,.aott-root .aott-toast.warn.on{animation:none!important}
  .aott-root .aott-big.on span,.aott-root .aott-big.on i{animation:none!important}
  .aott-root .aott-big i{transform:none}
  .aott-root .aott-dmg{animation-name:aott-dmg-fade}
  .aott-root .aott-cc,.aott-root .aott-feed div,.aott-root .aott-row u{transform:none!important}
  .aott-root .aott-hint,.aott-root .aott-hint.on,.aott-root .aott-toast,.aott-root .aott-toast.on{transform:translate(-50%,0) scale(var(--s))}
  .aott-root .aott-ticks,.aott-root .aott-lock,.aott-root .aott-hk,.aott-root .aott-row::before{transition:none}
}
`;
