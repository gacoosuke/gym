import { useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, CalendarClock, Check, ChevronDown, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import imageCompression from 'browser-image-compression';
import ExifReader from 'exifreader';
import { useQueryClient } from '@tanstack/react-query';
import { getGetMediaQueryKey, getGetCalendarQueryKey, getGetStorageQueryKey, useUploadMedia } from '@workspace/api-client-react';
import { PrivatePhoto } from './MemberGallery';
import { localDateTimeFromDate, localDateTimeToIso } from '@/lib/dates';

type Member = {id:string;name:string;color:string};
type UploadItem = {id:string;file:File};

function parseExifDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const normalized = raw.trim();
  const match = normalized.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const [, year, month, day, hours, minutes, seconds] = match;
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  }

  const isoCandidate = normalized.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i);
  if (isoCandidate) return normalized.slice(0, 16);

  const dateCandidate = Date.parse(normalized);
  if (Number.isFinite(dateCandidate)) {
    return localDateTimeFromDate(new Date(dateCandidate));
  }

  return null;
}

async function extractExifDate(file: File): Promise<string | null> {
  try {
    const tags = await ExifReader.load(file);
    const candidates: string[] = [];
    const entries = Object.entries(tags as Record<string, { description?: string } | undefined>);
    for (const [key, value] of entries) {
      const description = value?.description;
      if (typeof description === 'string' && description.trim()) candidates.push(description);
      if (typeof key === 'string' && /date|time/i.test(key) && typeof description === 'string' && description.trim()) {
        candidates.push(description);
      }
    }
    for (const candidate of candidates) {
      const parsed = parseExifDate(candidate);
      if (parsed) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export default function BulkUploader({ open, onClose, member, members, ghostPhoto }: {open:boolean;onClose:()=>void;member:Member;members:Member[];ghostPhoto?:any}) {
  const input = useRef<HTMLInputElement>(null);
  const [files,setFiles]=useState<UploadItem[]>([]);
  const [dates,setDates]=useState<Record<string,string>>({});
  const [tags,setTags]=useState<string[]>([]);
  const [caption,setCaption]=useState('');
  const [ghost,setGhost]=useState(false);
  const [previewUrl,setPreviewUrl]=useState('');
  const [index,setIndex]=useState(-1);
  const [done,setDone]=useState(false);
  const [error,setError]=useState('');
  const upload=useUploadMedia();
  const qc=useQueryClient();
  useEffect(()=>{
    if(!files[0]){setPreviewUrl('');return}
    const next=URL.createObjectURL(files[0].file);setPreviewUrl(next);
    return ()=>URL.revokeObjectURL(next);
  },[files]);
  useEffect(()=>{
    if(!open)return;
    setFiles([]);setDates({});setTags([]);setCaption('');setGhost(false);setIndex(-1);setDone(false);setError('');
  },[open]);
  const dateFor=(item:UploadItem)=>dates[item.id] || '';
  const processFiles=async (selected:File[])=>{
    const next=selected.filter(file=>file.type.startsWith('image/')).map(file=>({id:crypto.randomUUID(),file}));
    const found:Record<string,string>={};
    await Promise.all(next.map(async item=>{
      const exifDate = await extractExifDate(item.file);
      if (exifDate) found[item.id] = exifDate;
    }));
    setFiles(current=>[...current,...next]);setDates(current=>({...current,...found}));
  };
  const choose=(list:FileList|null)=>{if(list)void processFiles(Array.from(list));};
  const capture=async()=>{
    setError('');
    if(!Capacitor.isNativePlatform()){
      input.current?.setAttribute('capture','environment');input.current?.click();return;
    }
    try{
      const photo=await Camera.getPhoto({quality:90,allowEditing:false,resultType:CameraResultType.DataUrl,source:CameraSource.Camera});
      if(!photo.dataUrl)throw new Error('La caméra n’a renvoyé aucune image.');
      const blob=await (await fetch(photo.dataUrl)).blob();
      const type=blob.type||`image/${photo.format||'jpeg'}`;
      await processFiles([new File([blob],`souvenir-${Date.now()}.${photo.format||'jpg'}`,{type,lastModified:Date.now()})]);
    }catch(error){
      if(error instanceof Error&&!/cancel|dismiss/i.test(error.message))setError('La caméra n’a pas pu prendre la photo. Vérifiez son autorisation.');
    }
  };
  const send=async()=>{
    if(!files.length)return;
    setError('');setIndex(0);
    for(let i=0;i<files.length;i++){
      const item=files[i];
      const chosenDate = dateFor(item);
      if (!chosenDate) {
        setError(`La date de prise de « ${item.file.name} » est absente. Sélectionnez-la avant de continuer.`);
        setIndex(-1);
        return;
      }
      setIndex(i);
      try {
        const compressed=await imageCompression(item.file,{maxSizeMB:3,maxWidthOrHeight:2400,useWebWorker:true,preserveExif:true});
        await upload.mutateAsync({data:{file:compressed,memberId:member.id as any,takenAt:localDateTimeToIso(chosenDate),taggedMemberIds:JSON.stringify(tags),caption:caption||undefined}});
      }catch(e){setError(e instanceof Error?e.message:'Un envoi a échoué. Vérifiez votre connexion.');setIndex(-1);return}
    }
    await Promise.all([qc.invalidateQueries({queryKey:getGetMediaQueryKey()}),qc.invalidateQueries({queryKey:getGetCalendarQueryKey()}),qc.invalidateQueries({queryKey:getGetStorageQueryKey()})]);
    setDone(true);setIndex(-1);
  };
  if(!open)return null;
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="presentation" onClick={onClose}>
    <section onClick={e=>e.stopPropagation()} aria-label="Ajouter des photos" className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-[#393d49] bg-[#20232d] p-5 shadow-2xl sm:rounded-3xl sm:p-7">
      <header className="mb-5 flex items-start justify-between"><div><p className="text-xs uppercase tracking-[.18em] text-[#e8b66d]">Nouveau souvenir</p><h2 className="mt-1 font-serif text-2xl font-bold">{done?'C’est dans l’album.':'Ajouter des photos'}</h2></div><button onClick={onClose} aria-label="Fermer" className="rounded-full p-2 text-[#9297a3] hover:bg-[#303440]"><X size={19}/></button></header>
      {done ? <div className="py-8 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#34483e] text-[#92c3a2]"><Check/></span><p className="mt-4 text-sm text-[#bdc0c8]">{files.length} photo{files.length>1?'s':''} ajoutée{files.length>1?'s':''} à vos souvenirs.</p><button className="mt-6 rounded-full bg-[#e8b66d] px-6 py-3 text-sm font-bold text-[#191c25]" onClick={onClose}>Terminé</button></div> :
      <>
        <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={e=>{choose(e.target.files);e.currentTarget.value=''}}/>
        <div className="grid gap-2 sm:grid-cols-2"><button onClick={()=>input.current?.click()} className="flex items-center justify-center gap-3 rounded-2xl border border-dashed border-[#626673] bg-[#252832] py-5 text-sm font-semibold text-[#eee9df] hover:border-[#e8b66d]"><ImagePlus className="text-[#e8b66d]"/>Choisir des images</button><button onClick={capture} className="flex items-center justify-center gap-3 rounded-2xl border border-[#626673] bg-[#252832] py-5 text-sm font-semibold text-[#eee9df] hover:border-[#e8b66d]"><CameraIcon className="text-[#e8b66d]"/>Prendre une photo</button></div>
        <p className="mt-2 text-xs text-[#9297a3]">La date de prise est lue depuis les métadonnées quand elles existent. Vérifiez-la pour chaque image.</p>
        {files.length>0&&<div className="mt-4 max-h-52 space-y-2 overflow-y-auto">{files.map(item=><label key={item.id} className="flex items-center gap-3 rounded-xl bg-[#191c25] p-3"><span className="min-w-0 flex-1 truncate text-sm">{item.file.name}</span><span className="flex items-center gap-1 text-[10px] text-[#9297a3]"><CalendarClock size={12}/> Date de prise</span><input aria-label={`Date de prise de ${item.file.name}`} type="datetime-local" value={dateFor(item)} onChange={e=>setDates(v=>({...v,[item.id]:e.target.value}))} className="w-[160px] rounded-lg border border-[#3d414d] bg-[#252832] px-2 py-1.5 text-xs"/></label>)}</div>}
        <div className="mt-5"><label className="mb-2 block text-xs font-semibold text-[#bdc0c8]">Qui apparaît sur la photo ?</label><div className="flex flex-wrap gap-2">{members.map(m=><button key={m.id} onClick={()=>setTags(v=>v.includes(m.id)?v.filter(id=>id!==m.id):[...v,m.id])} className={`rounded-full border px-3 py-1.5 text-xs ${tags.includes(m.id)?'border-transparent bg-[#41444e] text-[#fff]':'border-[#41444e] text-[#a6aab3]'}`}><i className="mr-2 inline-block h-2 w-2 rounded-full" style={{backgroundColor:m.color}}/>{m.name}</button>)}</div></div>
        <label className="mt-4 block text-xs font-semibold text-[#bdc0c8]">Légende facultative<input maxLength={500} value={caption} onChange={e=>setCaption(e.target.value)} placeholder="Un détail qui mérite d’être gardé…" className="mt-2 w-full rounded-xl border border-[#3d414d] bg-[#191c25] px-4 py-3 text-sm outline-none focus:border-[#e8b66d]"/></label>
        <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-xl bg-[#191c25] p-3 text-sm"><input type="checkbox" checked={ghost} onChange={e=>setGhost(e.target.checked)} className="accent-[#e8b66d]"/><span className="flex-1">Afficher le fantôme de la dernière photo</span><ChevronDown size={15} className="text-[#9297a3]"/></label>
        {ghost&&<div className="relative mt-3 aspect-[4/3] overflow-hidden rounded-xl border border-[#414550] bg-[#14161d]"><p className="absolute left-2 top-2 z-10 rounded-full bg-[#191c25]/85 px-2.5 py-1 text-[10px] text-[#eee9df]">Aperçu du fantôme · photo la plus récente</p>{ghostPhoto?<PrivatePhoto id={ghostPhoto.id} alt="Dernière photo utilisée comme fantôme"/>:<div className="grid h-full place-items-center text-xs text-[#9297a3]">Aucune photo existante à superposer</div>}{previewUrl&&<img src={previewUrl} alt="Nouvelle photo en premier plan" className="absolute inset-0 h-full w-full object-cover" style={{opacity:.58}}/>}</div>}
        {error&&<p role="alert" className="mt-3 rounded-lg bg-[#492c30] p-3 text-sm text-[#f0b0ac]">{error}</p>}
        {index>=0&&<p className="mt-3 flex items-center gap-2 text-sm text-[#e8b66d]"><LoaderCircle size={16} className="animate-spin"/>Envoi {index+1} sur {files.length}…</p>}
        <button disabled={!files.length||index>=0} onClick={send} className="mt-5 w-full rounded-full bg-[#e8b66d] px-5 py-3.5 text-sm font-bold text-[#191c25] transition hover:bg-[#f1c886] disabled:cursor-not-allowed disabled:opacity-40">{index>=0?'Envoi en cours…':`Ajouter ${files.length||''} photo${files.length>1?'s':''}`}</button>
      </>}
    </section>
  </div>
}