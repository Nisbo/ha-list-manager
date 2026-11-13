// Shared camera lifecycle and decoder; card-specific bookings stay in their cards.
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const uuid = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (Number(c) ^ (typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(1))[0] : Math.random()*256) & 15 >> Number(c)/4).toString(16));
let decoderLoading;
let cameraOwner;
let cameraRequest = 0;
function loadDecoder() {
  if (!decoderLoading) decoderLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./html5-qrcode.min.js", import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => { script.remove(); decoderLoading = null; reject(new Error("decoder")); };
    document.head.append(script);
  });
  return decoderLoading;
}
const cameraStyles = `
.hmlm-camera-overlay{position:fixed;inset:0;z-index:11000;display:grid;place-items:center;padding:max(18px,env(safe-area-inset-top),var(--safe-area-inset-top,0px)) max(18px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom),var(--safe-area-inset-bottom,0px)) max(18px,env(safe-area-inset-left));background:#0009;color:var(--primary-text-color)}
.hmlm-camera-overlay[hidden]{display:none!important}.hmlm-camera-overlay *{box-sizing:border-box}.hmlm-camera-overlay .scan-dialog{width:min(640px,100%);max-height:calc(100dvh - max(36px,env(safe-area-inset-top),var(--safe-area-inset-top,0px)) - max(18px,env(safe-area-inset-bottom),var(--safe-area-inset-bottom,0px)));overflow:auto;overscroll-behavior:contain;padding:24px;border-radius:18px;background:var(--card-background-color,#fff);box-shadow:0 4px 24px #0006;font:inherit}.hmlm-camera-overlay header{display:flex;align-items:center;gap:12px;margin-bottom:18px}.hmlm-camera-overlay h2{font-size:24px;margin:0;flex:1}.hmlm-camera-overlay p{line-height:1.5;color:var(--secondary-text-color)}.hmlm-camera-overlay button{font:inherit;color:var(--primary-text-color);background:transparent;border:0;border-radius:24px;padding:8px;min-height:44px;cursor:pointer}.hmlm-camera-overlay .scan-camera{width:100%;min-height:180px}.hmlm-camera-overlay video{max-width:100%}
`;
class CameraScanner {
  constructor({hass,onCapture,onError,allowText=false}){this.getHass=hass;this.onCapture=onCapture;this.onError=onError;this.allowText=allowText;}
  t(key){return this.getHass()?.localize?.(`component.ha_list_manager.config_panel.scan.${key}`)||"";}
  formats(){
    const f=window.Html5QrcodeSupportedFormats;
    return this.allowText?Object.values(f).filter(value=>typeof value==="number"):[f.EAN_13,f.EAN_8,f.UPC_A,f.UPC_E,f.CODE_128];
  }
  header(title){return `<header><h2>${esc(title)}</h2><button type="button" data-close aria-label="${esc(this.t("close"))}"><ha-icon icon="mdi:close"></ha-icon></button></header>`;}
  stop(){this.disposed=true;return this.close();}
  async open(context = {}){
    if(this.camera)return;
    this.disposed=false;
    const request=++cameraRequest;
    if(cameraOwner)await cameraOwner.close();
    // Closing a previous owner is asynchronous. Only the latest request may
    // acquire the camera after that wait; detached views must not reopen it.
    if(request!==cameraRequest||this.disposed)return;
    if(!window.isSecureContext){this.onError(this.t("camera_secure"));return;}
    if(!navigator.mediaDevices?.getUserMedia){this.onError(this.t("camera_unavailable"));return;}
    cameraOwner=this;const camera={...context,handled:false,cancelled:false,request_id:uuid()};this.camera=camera;
    const portal=document.createElement("div");portal.className="hmlm-scan-overlay hmlm-camera-overlay";const id="hmlm-camera-"+uuid();
    portal.innerHTML=`<style>${cameraStyles}</style><section class="scan-dialog" role="dialog" aria-modal="true">${this.header(this.t("camera_title"))}<p>${esc(this.t("camera_hint"))}</p><div class="scan-camera" id="${id}"></div><p data-camera-status>${esc(this.t("camera_loading"))}</p></section>`;camera.portal=portal;
    const cancel=()=>this.close();portal.onclick=e=>{if(e.target===portal)cancel();};portal.querySelector("[data-close]").onclick=cancel;
    camera.keydown=e=>{if(e.key==="Escape"){e.preventDefault();e.stopImmediatePropagation();cancel();}};document.addEventListener("keydown",camera.keydown,true);document.body.append(portal);
    camera.starting=(async()=>{await loadDecoder();if(camera.cancelled)return;camera.decoder=new window.Html5Qrcode(id,{formatsToSupport:this.formats(),verbose:false});await camera.decoder.start({facingMode:"environment"},{fps:10,aspectRatio:1,videoConstraints:{facingMode:"environment",width:{ideal:1280},height:{ideal:1280},aspectRatio:{ideal:1}},qrbox:(width,height)=>{const size=Math.floor(Math.min(width,height)*0.9);return {width:size,height:size};}},camera.onCode=code=>{
      if(camera.handled||camera.cancelled)return;
      if(!code.trim()||!this.allowText&&!/^\d{4,32}$/.test(code.trim())){portal.querySelector("[data-camera-status]").textContent=this.t("camera_product_only");return;}
      camera.handled=true;camera.ean=code.trim();this.close().then(()=>!this.disposed&&this.onCapture(camera));
    },()=>{});if(!camera.cancelled){portal.querySelector("[data-camera-status]").textContent="";this.startFrameDecoder(camera,id);}})();
    try{await camera.starting;}catch(e){if(!camera.cancelled){await this.close();this.onError(this.t("camera_unavailable"));}}
  }
  startFrameDecoder(camera,id){
    // The live decoder downsamples to the on-screen viewfinder. The public
    // image API also checks native-resolution crops and quarter-turn rotation.
    // Keep at most one decode in flight and release every frame when done.
    if(typeof camera.decoder.scanFileV2!=="function")return;
    const holder=document.createElement("div");holder.id=id+"-frames";
    holder.hidden=true;camera.portal.append(holder);
    camera.frameDecoder=new window.Html5Qrcode(holder.id,{formatsToSupport:this.formats(),verbose:false});
    camera.frameAngle=0;
    camera.frameTimer=setInterval(()=>{
      if(camera.cancelled||camera.handled||camera.frameWork)return;
      const video=camera.portal.querySelector("video");
      if(!video?.videoWidth||!video.videoHeight)return;
      camera.frameWork=(async()=>{
        const crop=Math.floor(Math.min(video.videoWidth,video.videoHeight)*0.9);
        const canvas=document.createElement("canvas");canvas.width=canvas.height=Math.min(crop,1280);
        const context=canvas.getContext("2d");
        if(!context)return;
        context.translate(canvas.width/2,canvas.height/2);context.rotate(camera.frameAngle);
        camera.frameAngle=camera.frameAngle?0:Math.PI/2;
        context.drawImage(video,(video.videoWidth-crop)/2,(video.videoHeight-crop)/2,crop,crop,
          -canvas.width/2,-canvas.height/2,canvas.width,canvas.height);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
        if(!blob||camera.cancelled||camera.handled)return;
        try{
          const result=await camera.frameDecoder.scanFileV2(new File([blob],"frame.png",{type:"image/png"}),false);
          if(!camera.cancelled&&!camera.handled)camera.onCode(result.decodedText);
        }catch(_notRecognized){}
      })().finally(()=>{camera.frameWork=null;});
    },500);
  }
  close(){
    const camera=this.camera;if(!camera)return Promise.resolve();if(camera.closing)return camera.closing;
    camera.cancelled=true;clearInterval(camera.frameTimer);document.removeEventListener("keydown",camera.keydown,true);camera.portal.hidden=true;
    camera.closing=(async()=>{
      await camera.starting?.catch(()=>{});
      await camera.frameWork?.catch(()=>{});
      const streams=[...camera.portal.querySelectorAll("video")].map(video=>video.srcObject).filter(Boolean);
      try{if(camera.decoder?.isScanning)await camera.decoder.stop();}
      catch(error){console.warn("Camera cleanup failed",error);}
      finally{
        // Release browser tracks even if the decoder failed while stopping.
        streams.forEach(stream=>stream.getTracks().forEach(track=>track.stop()));
        for(const reader of [camera.decoder,camera.frameDecoder]){try{reader?.clear();}catch(_error){}}
        camera.portal.remove();if(this.camera===camera)this.camera=null;if(cameraOwner===this)cameraOwner=null;
      }
    })();return camera.closing;
  }
}
globalThis.HaListManagerCamera=CameraScanner;
