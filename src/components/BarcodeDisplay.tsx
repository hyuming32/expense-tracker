import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import {
  type BarcodeFormat,
  barcodeToRects,
  encodeCode39,
  encodeCode128,
  encodeEan13,
} from '../lib/barcode';

interface BarcodeDisplayProps {
  code: string;
  format: BarcodeFormat;
  height?: number;
  className?: string;
}

/**
 * 渲染一維條碼（SVG）或 QR Code（SVG），一律白底黑條以確保掃描辨識率。
 */
export function BarcodeDisplay({
  code,
  format,
  height = 96,
  className = '',
}: BarcodeDisplayProps) {
  const rendered = useMemo(() => {
    try {
      if (format === 'qr') {
        const qr = qrcode(0, 'M');
        qr.addData(code);
        qr.make();
        const count = qr.getModuleCount();
        const quiet = 4;
        const size = count + quiet * 2;
        const rects: Array<{ x: number; y: number }> = [];
        for (let r = 0; r < count; r += 1) {
          for (let c = 0; c < count; c += 1) {
            if (qr.isDark(r, c)) {
              rects.push({ x: c + quiet, y: r + quiet });
            }
          }
        }
        return { kind: 'qr' as const, size, rects, error: null };
      }

      let bars: number[];
      if (format === 'code39') {
        bars = encodeCode39(code);
      } else if (format === 'ean13') {
        bars = encodeEan13(code);
      } else {
        bars = encodeCode128(code);
      }

      const { totalWidth, rects } = barcodeToRects(bars, 10);
      return { kind: '1d' as const, totalWidth, rects, error: null };
    } catch (err) {
      return {
        kind: 'error' as const,
        error: err instanceof Error ? err.message : '條碼格式不正確',
      };
    }
  }, [code, format]);

  if (rendered.kind === 'error') {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-center text-xs text-red-700">
        無法產生條碼：{rendered.error}
      </div>
    );
  }

  if (rendered.kind === 'qr') {
    return (
      <div className={`flex items-center justify-center bg-white ${className}`}>
        <svg
          viewBox={`0 0 ${rendered.size} ${rendered.size}`}
          className="h-56 w-56 max-w-full"
          shapeRendering="crispEdges"
          role="img"
          aria-label={`QR Code：${code}`}
        >
          <rect width={rendered.size} height={rendered.size} fill="#ffffff" />
          {rendered.rects.map((cell, idx) => (
            <rect
              key={idx}
              x={cell.x}
              y={cell.y}
              width={1}
              height={1}
              fill="#000000"
            />
          ))}
        </svg>
      </div>
    );
  }

  return (
    <div className={`w-full bg-white ${className}`}>
      <svg
        viewBox={`0 0 ${rendered.totalWidth} ${height}`}
        className="h-28 w-full sm:h-36"
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        role="img"
        aria-label={`條碼：${code}`}
      >
        <rect width={rendered.totalWidth} height={height} fill="#ffffff" />
        {rendered.rects.map((rect, idx) => (
          <rect
            key={idx}
            x={rect.x}
            y={0}
            width={rect.width}
            height={height}
            fill="#000000"
          />
        ))}
      </svg>
    </div>
  );
}
