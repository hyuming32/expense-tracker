import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { isInvoiceRightQr, parseInvoiceQr, type ParsedInvoice } from '../domain';

interface InvoiceScannerModalProps {
  open: boolean;
  onClose: () => void;
  onDetected: (invoice: ParsedInvoice) => void;
}

interface BarcodeDetectionResult {
  rawValue?: string;
}

interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<BarcodeDetectionResult[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

async function createQrDetector(): Promise<BarcodeDetectorInstance | null> {
  const ctor = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  if (!ctor) {
    return null;
  }
  try {
    if (typeof ctor.getSupportedFormats === 'function') {
      const formats = await ctor.getSupportedFormats();
      if (!formats.includes('qr_code')) {
        return null;
      }
    }
    return new ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

function decodeCanvasWithJsQr(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    return null;
  }
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  return result?.data ?? null;
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取圖片'));
    };
    img.src = url;
  });
}

export function InvoiceScannerModal({ open, onClose, onDetected }: InvoiceScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [hint, setHint] = useState<string>('對準發票左邊的 QR Code');

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

  const handleDecodedText = useCallback(
    (rawText: string): boolean => {
      if (isInvoiceRightQr(rawText)) {
        setHint('請掃描左邊的 QR Code');
        return false;
      }
      const parsed = parseInvoiceQr(rawText);
      if (!parsed) {
        return false;
      }
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(50);
      }
      stopCamera();
      onDetected(parsed);
      return true;
    },
    [onDetected, stopCamera],
  );

  useEffect(() => {
    if (!open) {
      stopCamera();
      return;
    }

    let cancelled = false;
    let rafId = 0;
    let lastScanAt = 0;

    setCameraError(null);
    setHint('對準發票左邊的 QR Code');

    async function startScanning() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        if (!cancelled) {
          setCameraError('此裝置不支援即時相機掃描，請改用相簿選擇照片。');
        }
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });

        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          stopCamera();
          return;
        }
        video.srcObject = stream;
        await video.play();

        const detector = await createQrDetector();
        if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas');
        }
        const canvas = canvasRef.current;

        const tick = async (timestamp: number) => {
          if (cancelled) {
            return;
          }
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && timestamp - lastScanAt >= 120) {
            lastScanAt = timestamp;
            try {
              let rawText: string | null = null;
              if (detector) {
                const results = await detector.detect(video);
                rawText = results.find((item) => Boolean(item.rawValue))?.rawValue ?? null;
              } else if (video.videoWidth > 0 && video.videoHeight > 0) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                  rawText = decodeCanvasWithJsQr(canvas);
                }
              }

              if (rawText && handleDecodedText(rawText)) {
                return;
              }
            } catch {
              // 單幀解碼失敗時繼續下一幀掃描
            }
          }
          if (!cancelled) {
            rafId = window.requestAnimationFrame((ts) => {
              void tick(ts);
            });
          }
        };

        rafId = window.requestAnimationFrame((ts) => {
          void tick(ts);
        });
      } catch {
        if (!cancelled) {
          setCameraError('無法開啟相機（可能未授權或無可用相機），請從相簿選擇發票照片。');
        }
      }
    }

    void startScanning();

    return () => {
      cancelled = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      stopCamera();
    };
  }, [open, handleDecodedText, stopCamera]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }

    try {
      const img = await loadImageElement(file);
      const maxEdge = 1600;
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));

      const canvas = canvasRef.current ?? document.createElement('canvas');
      canvasRef.current = canvas;
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        setHint('無法處理照片，請再試一次');
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      const detector = await createQrDetector();
      let rawTexts: string[] = [];
      if (detector) {
        try {
          const results = await detector.detect(canvas);
          rawTexts = results
            .map((item) => item.rawValue)
            .filter((val): val is string => Boolean(val));
        } catch {
          rawTexts = [];
        }
      }

      if (rawTexts.length === 0) {
        const jsQrText = decodeCanvasWithJsQr(canvas);
        if (jsQrText) {
          rawTexts = [jsQrText];
        }
      }

      for (const text of rawTexts) {
        if (handleDecodedText(text)) {
          return;
        }
      }

      if (rawTexts.some((text) => isInvoiceRightQr(text))) {
        setHint('請掃描左邊的 QR Code');
      } else {
        setHint('未辨識到發票左側 QR Code，請重新選擇照片');
      }
    } catch {
      setHint('讀取照片失敗，請重新選擇');
    }
  }

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label="掃描電子發票"
    >
      {/* 頂部關閉列 */}
      <div className="relative z-10 flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium text-white/90">掃描電子發票</span>
        <button
          type="button"
          onClick={() => {
            stopCamera();
            onClose();
          }}
          className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/25"
        >
          關閉
        </button>
      </div>

      {/* 相機預覽與對準框 */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {!cameraError ? (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="h-full w-full object-cover"
            />
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6">
              <div className="h-56 w-56 rounded-2xl border-2 border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
              <p className="mt-5 rounded-full bg-black/70 px-4 py-1.5 text-center text-sm font-medium text-white">
                {hint}
              </p>
            </div>
          </>
        ) : (
          <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <p className="text-sm text-slate-200">{cameraError}</p>
            {hint !== '對準發票左邊的 QR Code' && (
              <p className="text-xs text-amber-300">{hint}</p>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              從相簿選擇照片
            </button>
          </div>
        )}
      </div>

      {/* 底部備用相簿按鈕 */}
      {!cameraError && (
        <div className="relative z-10 flex justify-center pb-6 pt-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-xl bg-white/15 px-4 py-2 text-xs font-medium text-white hover:bg-white/25"
          >
            從相簿選擇照片
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
