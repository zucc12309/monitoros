import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({ width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...p });

export const HomeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><path d="M10.6 3.4a2 2 0 0 1 2.8 0l7 6.6c.4.4.6.9.6 1.5V19a2 2 0 0 1-2 2h-3.5a1 1 0 0 1-1-1v-4.5h-5V20a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2v-7.5c0-.6.2-1.1.6-1.5z" /></svg>
);
export const TvIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="m8 3 4 4 4-4" /></svg>
);
export const PlayCircleIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5 3.5-5 3.5z" fill="currentColor" /></svg>
);
export const GamepadIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6.5 7h11a4 4 0 0 1 3.9 4.8l-1 5a2.5 2.5 0 0 1-4.3 1.2L14.5 16h-5l-1.6 2a2.5 2.5 0 0 1-4.3-1.2l-1-5A4 4 0 0 1 6.5 7z" /><path d="M8 10v3M6.5 11.5h3" /><circle cx="15.5" cy="11" r=".6" fill="currentColor" /><circle cx="17" cy="12.5" r=".6" fill="currentColor" /></svg>
);
export const MonitorIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
);
export const FolderIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
export const GiftIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8v12M12 8S10.5 4 8.5 4a2 2 0 0 0 0 4M12 8s1.5-4 3.5-4a2 2 0 0 1 0 4" /></svg>
);
export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const BellIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" /></svg>
);
export const GearIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const PlayIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z" /></svg>
);
export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m5 12 5 5 9-10" /></svg>
);
export const GridIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></svg>
);
export const PhoneIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>
);
export const ExternalIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
);

export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 40" className={className} aria-hidden>
      <defs>
        <linearGradient id="mo-g" x1="0" x2="1">
          <stop offset="0" stopColor="#e04ccf" />
          <stop offset="1" stopColor="#7c6cff" />
        </linearGradient>
      </defs>
      <path fill="url(#mo-g)" d="M2 4c0-2 2-3 4-2l18 13L42 2c2-1 4 0 4 2v4L24 25 6 12v24c0 2-4 2-4 0z" />
      <path fill="#a79dff" d="M48 6c0-2 2-3 4-2l9 6c2 1 2 3 0 4l-9 6c-2 1-4 0-4-2zM48 22l14 10c1 1 1 3-1 3H48z" opacity=".9" />
    </svg>
  );
}
