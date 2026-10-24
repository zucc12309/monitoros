import { useMemo } from "react";
import qrcode from "qrcode-generator";

export function QrCode({ text, size = 180 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    return { d, n };
  }, [text]);
  return (
    <svg viewBox={`-2 -2 ${path.n + 4} ${path.n + 4}`} style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }} className="rounded-xl bg-white" role="img" aria-label={`QR code for ${text}`}>
      <path d={path.d} fill="#000" />
    </svg>
  );
}
