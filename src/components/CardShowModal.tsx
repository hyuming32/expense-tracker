import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { touchCardUsed } from '../db/repository';
import type { WalletCard } from '../db/types';
import { BarcodeDisplay } from './BarcodeDisplay';

interface CardShowModalProps {
  open: boolean;
  cards: readonly WalletCard[];
  initialCardId?: string | null;
  onClose: () => void;
}

/**
 * 全螢幕出示載具或會員卡條碼（固定白底黑條、支援左右滑動切換與螢幕恆亮 WakeLock）。
 */
export function CardShowModal({
  open,
  cards,
  initialCardId,
  onClose,
}: CardShowModalProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const touchStartXRef = useRef<number | null>(null);
  const touchedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      touchedIdsRef.current.clear();
      return;
    }
    if (initialCardId) {
      const idx = cards.findIndex((c) => c.id === initialCardId);
      setActiveIndex(idx >= 0 ? idx : 0);
    } else {
      setActiveIndex(0);
    }
  }, [open, initialCardId, cards]);

  const currentCard = cards[activeIndex] ?? cards[0] ?? null;

  // 記錄卡片最後使用時間
  useEffect(() => {
    if (!open || !currentCard) return;
    if (touchedIdsRef.current.has(currentCard.id)) return;
    touchedIdsRef.current.add(currentCard.id);
    void touchCardUsed(currentCard.id);
  }, [open, currentCard]);

  // 嘗試鎖定螢幕恆亮（不支援或拒絕時略過）
  useEffect(() => {
    if (!open) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    async function requestWakeLock() {
      try {
        if ('wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function') {
          const lock = await navigator.wakeLock.request('screen');
          if (cancelled) {
            await lock.release();
          } else {
            sentinel = lock;
          }
        }
      } catch {
        // 不支援或系統拒絕時靜默略過
      }
    }

    void requestWakeLock();
    return () => {
      cancelled = true;
      if (sentinel) {
        void sentinel.release().catch(() => {});
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  function handlePrev() {
    if (cards.length <= 1) return;
    setActiveIndex((prev) => (prev - 1 + cards.length) % cards.length);
  }

  function handleNext() {
    if (cards.length <= 1) return;
    setActiveIndex((prev) => (prev + 1) % cards.length);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="出示條碼"
      className="fixed inset-0 z-50 flex flex-col justify-between bg-white px-5 py-6 text-slate-900"
      onTouchStart={(e) => {
        touchStartXRef.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const startX = touchStartXRef.current;
        const endX = e.changedTouches[0]?.clientX;
        touchStartXRef.current = null;
        if (startX === null || endX === undefined) return;
        const delta = endX - startX;
        if (delta > 50) {
          handlePrev();
        } else if (delta < -50) {
          handleNext();
        }
      }}
    >
      {/* 頂部標題與關閉 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {currentCard ? (
            <>
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ backgroundColor: currentCard.color }}
                aria-hidden="true"
              />
              <h2 className="text-lg font-bold text-slate-900">{currentCard.name}</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {currentCard.type === 'carrier' ? '載具' : '會員卡'}
              </span>
            </>
          ) : (
            <h2 className="text-lg font-bold text-slate-900">出示條碼</h2>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          完成
        </button>
      </div>

      {/* 中央條碼區（白底黑條） */}
      {currentCard ? (
        <div className="mx-auto flex w-full max-w-lg flex-col items-center justify-center gap-5 px-2">
          <div className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-6 shadow-sm">
            <BarcodeDisplay code={currentCard.code} format={currentCard.format} />
          </div>

          <div className="select-all text-center font-mono text-2xl font-bold tracking-wider text-slate-900 sm:text-3xl">
            {currentCard.code}
          </div>

          {cards.length > 1 && (
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={handlePrev}
                aria-label="上一張卡片"
                className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                ← 上一張
              </button>
              <div className="flex items-center gap-1.5" aria-hidden="true">
                {cards.map((c, idx) => (
                  <span
                    key={c.id}
                    className={`h-2 rounded-full transition-all ${
                      idx === activeIndex ? 'w-5 bg-slate-900' : 'w-2 bg-slate-300'
                    }`}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={handleNext}
                aria-label="下一張卡片"
                className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                下一張 →
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-4 text-center">
          <div className="text-4xl" aria-hidden="true">
            💳
          </div>
          <p className="text-sm text-slate-600">
            尚未設定手機條碼載具或會員卡，新增後即可在結帳時一鍵出示。
          </p>
          <Link
            to="/cards"
            onClick={onClose}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            前往設定卡片
          </Link>
        </div>
      )}

      {/* 底部提示與管理連結 */}
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-xs text-slate-500">掃不到時請把螢幕調亮</p>
        {currentCard && (
          <Link
            to="/cards"
            onClick={onClose}
            className="text-xs font-medium text-slate-500 underline-offset-2 hover:underline"
          >
            管理載具與會員卡
          </Link>
        )}
      </div>
    </div>
  );
}
