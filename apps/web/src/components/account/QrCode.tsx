import { useMemo } from "react";
import { encodeQr, qrSvgPath } from "./qr";

/** QR code rendered as crisp SVG (always dark-on-white so phone cameras can read it in dark mode). */
export function QrCode({ value, size = 200, label }: { value: string; size?: number; label?: string }) {
  const qr = useMemo(() => { try { return encodeQr(value); } catch { return null; } }, [value]);
  if (!qr) return null;
  const border = 4;
  const dim = qr.size + border * 2;
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label ?? "QR code"}
      shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 6, display: "block" }} data-testid="mfa-qr" data-qr-version={qr.version}
    >
      <rect width={dim} height={dim} fill="#fff" />
      <path d={qrSvgPath(qr, border)} fill="#000" />
    </svg>
  );
}
