import { useEffect, useState } from 'react';
import { getGetMediaContentQueryKey, useGetMediaContent } from '@workspace/api-client-react';

export function relativeTakenAt(value: string) {
  const delta = new Date(value).getTime() - Date.now();
  const seconds = Math.round(delta / 1000);
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60,'second'],[60,'minute'],[24,'hour'],[30,'day'],[12,'month'],[Number.POSITIVE_INFINITY,'year']];
  let amount=seconds;
  for(const [threshold,unit] of steps){
    if(Math.abs(amount)<threshold) return new Intl.RelativeTimeFormat('fr-FR',{numeric:'auto'}).format(amount,unit);
    amount=Math.round(amount/threshold);
  }
  return new Intl.RelativeTimeFormat('fr-FR',{numeric:'auto'}).format(amount,'year');
}

export function PrivatePhoto({ id, alt }: { id: string; alt: string }) {
  const { data, isLoading, isError } = useGetMediaContent(id, { query: { queryKey: getGetMediaContentQueryKey(id), enabled: !!id } });
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!data) return;
    const next = URL.createObjectURL(data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [data]);
  if (isLoading) return <div className="skeleton h-full min-h-44 w-full" aria-label="Chargement de la photo" />;
  if (isError || !url) return <div className="grid h-full min-h-44 place-items-center text-xs text-[#858a97]">Aperçu indisponible</div>;
  return <img className="photo-image" src={url} alt={alt}/>;
}

export default function MemberGallery({ photos, members, onSelect }: { photos: any[]; members: any[]; onSelect: (photo: any) => void }) {
  if (!photos.length) return <div className="panel rounded-2xl px-6 py-12 text-center">
    <div className="mx-auto mb-4 h-12 w-12 rounded-full border border-[#555965] bg-[#292d37]"/>
    <h3 className="font-semibold text-[#eee9df]">Aucun souvenir ici, pour l’instant</h3>
    <p className="mx-auto mt-2 max-w-sm text-sm text-[#9297a3]">Choisissez un autre membre ou ajoutez une photo pour commencer à remplir cette galerie.</p>
  </div>;
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
    {photos.map((photo) => <button data-testid={`photo-${photo.id}`} key={photo.id} onClick={() => onSelect(photo)} className="photo-card aspect-[4/5] rounded-xl text-left">
      <PrivatePhoto id={photo.id} alt={photo.caption || `Souvenir de ${photo.memberName}`}/>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#12141be8] to-transparent px-3 pb-3 pt-10">
        <p className="truncate text-sm font-semibold">{photo.caption || 'Sans légende'}</p>
        <p title={new Date(photo.takenAt).toLocaleString('fr-FR')} className="mt-1 text-xs text-[#c1c1c5]">{photo.memberName} · {relativeTakenAt(photo.takenAt)}</p>
      </div>
      <span className="absolute left-2 top-2 flex -space-x-1">{(photo.taggedMemberIds || []).map((id: string) => {
        const member = members.find((m) => m.id === id); return member ? <i key={id} title={member.name} className="h-2.5 w-2.5 rounded-full border border-[#191c25]" style={{backgroundColor:member.color}}/> : null
      })}</span>
    </button>)}
  </div>
}