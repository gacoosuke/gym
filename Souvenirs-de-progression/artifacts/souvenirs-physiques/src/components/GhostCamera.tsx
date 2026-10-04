import { Camera, ImagePlus } from 'lucide-react';

export default function GhostCamera({ onClick, label = "Ajouter une photo" }: { onClick: () => void; label?: string }) {
  return <button data-testid="button-add-photo" onClick={onClick} aria-label={label} className="group relative flex min-h-40 w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-dashed border-[#555965] bg-[#20232d] text-[#c8c4bb] transition hover:border-[#e8b66d] hover:bg-[#252832]">
    <span className="absolute -right-5 -top-9 h-28 w-28 rounded-full border border-[#454954] opacity-50 transition group-hover:scale-110" />
    <span className="relative grid h-12 w-12 place-items-center rounded-full bg-[#303440] text-[#e8b66d]"><Camera size={21}/></span>
    <span className="relative text-sm font-semibold">{label}</span>
    <span className="relative flex items-center gap-1 text-xs text-[#858a97]"><ImagePlus size={13}/> Les images restent entre vous</span>
  </button>
}