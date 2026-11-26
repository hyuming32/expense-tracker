import { useCallback, useEffect, useRef, useState } from 'react';
import { type BarcodeFormat, guessFormat } from '../lib/barcode';

const REQUIRED_FORMATS = [
  'code_39',
  'code_128',
  'ean_13',
  'ean_8',
  'upc_a',
  'itf',
  'qr_code',
] as const;

interface DetectedBarcodeLike {
  rawValue?: string;
  format?: string;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcodeLike[]>;
}

interface NativeBarcodeDetectorCtor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<readonly string[]>;
}

function mapDetectedFormat(rawFormat: string | undefined, code: string): BarcodeFormat {
  switch (rawFormat) {
    case 'code_39':
      return 'code39';
    case 'code_128':
      return 'code128';
    case 'ean_13':
      return 'ean13';
    case 'qr_code':
      return 'qr';
    default:
      return guessFormat(code);
  }
}

async function loadBarcodeDetector(): Promise<BarcodeDetectorLike> {
  const nativeCtor = (
    window as Window & { BarcodeDetector?: NativeBarcodeDetectorCtor }
  ).BarcodeDetector;

  if (nativeCtor && typeof nativeCtor.getSupportedFormats === 'function') {
    try {
      const supported = await nativeCtor.getSupportedFormats();
      const hasAll = REQUIRED_FORMATS.every((fmt) => supported.includes(fmt));
      if (hasAll) {
        return new nativeCtor({ formats: [...REQUIRED_FORMATS] });
      }
    } catch {
      // 原生檢查失敗時改用 polyfill
    }
  }

  // 動態載入 polyfill 與自架 WASM，避免首頁初始 bundle 膨脹或向外部 CDN 下載
  const [ponyfill, wasmModule] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);

  ponyfill.setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) => {
      if (path.endsWith('.wasm')) {
        return wasmModule.default;
      }
      return prefix + path;
    },
  });

  await ponyfill.prepareZXingModule();
  return new ponyfill.BarcodeDetector({ formats: [...REQUIRED_FORMATS] });
}

interface BarcodeScannerModalProps {
  open: boolean;
  onClose: () => void;
  onFallbackManual: () => void;
  onDetected: (result: { code: string; format: BarcodeFormat }) => void;
}

/**
 * 會員卡條碼相機掃描視窗（支援一維條碼與 QR Code，優先原生 BarcodeDetector，否則動態載入自架 WASM polyfill）。
 */
export function BarcodeScannerModal({
  open,
  onClose,
  onFallbackManual,
  onDetected,
}: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [preparing, setPreparing] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      stopCamera();
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let busy = false;

    setPreparing(true);
    setErrorMsg(null);

    async function start() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        if (!cancelled) {
          setPreparing(false);
          setErrorMsg('此裝置或瀏覽器不支援即時相機掃描。');
        }
        return;
      }

      let detector: BarcodeDetectorLike;
      try {
        detector = await loadBarcodeDetector();
      } catch (err) {
        if (!cancelled) {
          setPreparing(false);
          setErrorMsg(
            err instanceof Error ? `掃描模組載入失敗：${err.message}` : '掃描模組載入失敗。',
          );
        }
        return;
      }

      if (cancelled) return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setPreparing(false);
      } catch (err) {
        if (!cancelled) {
          setPreparing(false);
          const message =
            err instanceof Error && err.name === 'NotAllowedError'
              ? '相機權限被拒絕，無法開啟鏡頭掃描。'
              : '無法開啟相機，請確認裝置權限或改用手動輸入。';
          setErrorMsg(message);
        }
        return;
      }

      timerId = window.setInterval(() => {
        if (cancelled || busy) return;
        const video = videoRef.current;
        if (!video || video.readyState < 2 || video.videoWidth === 0) return;

        busy = true;
        const canvas = canvasRef.current ?? document.createElement('canvas');
        canvasRef.current = canvas;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          busy = false;
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        void detector
          .detect(canvas)
          .then((results) => {
            if (cancelled || results.length === 0) return;
            const first = results.find((r) => r.rawValue && r.rawValue.trim().length > 0);
            if (!first?.rawValue) return;

            const code = first.rawValue.trim();
            const format = mapDetectedFormat(first.format, code);
            if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
              navigator.vibrate(50);
            }
            stopCamera();
            onDetected({ code, format });
          })
          .catch(() => {
            // 單張影格辨識失敗忽略，繼續下一張
          })
          .finally(() => {
            busy = false;
          });
      }, 200);
    }

    void start();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearInterval(timerId);
      }
      stopCamera();
    };
  }, [open, onDetected, stopCamera]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="掃描會員卡條碼"
      className="fixed inset-0 z-50 flex flex-col justify-between bg-slate-950/95 p-4 text-white"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">掃描會員卡條碼</h2>
        <button
          type="button"
          onClick={() => {
            stopCamera();
            onClose();
          }}
          className="rounded-xl bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          取消
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4">
        {errorMsg ? (
          <div className="w-full space-y-4 rounded-2xl border border-red-500/40 bg-red-950/60 p-5 text-center">
            <p className="text-sm text-red-100">{errorMsg}</p>
            <button
              type="button"
              onClick={() => {
                stopCamera();
                onFallbackManual();
              }}
              className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              改為手動輸入
            </button>
          </div>
        ) : (
          <>
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-slate-700 bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              {preparing && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-sm font-medium text-slate-200">
                  準備掃描中…
                </div>
              )}
              {!preparing && (
                <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-emerald-400/80" />
              )}
            </div>
            <p className="text-xs text-slate-300">
              將會員卡條碼或 QR Code 對準框線內，支援一維條碼與 QR Code
            </p>
          </>
        )}
      </div>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => {
            stopCamera();
            onFallbackManual();
          }}
          className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
        >
          改為手動輸入號碼
        </button>
      </div>
    </div>
  );
}
