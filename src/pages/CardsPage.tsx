import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { CardShowModal } from '../components/CardShowModal';
import {
  deleteCard,
  reorderCards,
  saveCarrierCard,
  saveMemberCard,
} from '../db/repository';
import type { WalletCard, WalletCardFormat } from '../db/types';
import {
  CARD_COLOR_PALETTE,
  isValidCarrier,
  MEMBER_CARD_NAME_MAX_LENGTH,
  normalizeCarrier,
  pickCardColor,
} from '../domain/carrier';
import { type BarcodeFormat, guessFormat } from '../lib/barcode';

interface CardsPageProps {
  cards: readonly WalletCard[];
}

const FORMAT_LABELS: Record<WalletCardFormat, string> = {
  code39: 'Code 39',
  code128: 'Code 128',
  ean13: 'EAN-13',
  qr: 'QR Code',
};

export function CardsPage({ cards }: CardsPageProps) {
  const carrierCard = useMemo(
    () => cards.find((c) => c.type === 'carrier') ?? null,
    [cards],
  );
  const memberCards = useMemo(
    () => cards.filter((c) => c.type === 'member'),
    [cards],
  );

  // 載具編輯狀態
  const [carrierInput, setCarrierInput] = useState('');
  const [carrierTouched, setCarrierTouched] = useState(false);
  const [carrierStatus, setCarrierStatus] = useState<string | null>(null);
  const [savingCarrier, setSavingCarrier] = useState(false);

  useEffect(() => {
    setCarrierInput(carrierCard?.code ?? '');
    setCarrierTouched(false);
  }, [carrierCard?.code]);

  const normalizedCarrier = useMemo(
    () => normalizeCarrier(carrierInput),
    [carrierInput],
  );
  const carrierError =
    carrierTouched && normalizedCarrier.length > 0 && !isValidCarrier(normalizedCarrier)
      ? '手機條碼是 / 加 7 個英數字，例如 /ABC1234'
      : null;

  // 新增／編輯會員卡狀態
  const [editingId, setEditingId] = useState<string | null>(null);
  const [memberName, setMemberName] = useState('');
  const [memberCode, setMemberCode] = useState('');
  const [memberFormat, setMemberFormat] = useState<BarcodeFormat | 'auto'>('auto');
  const [memberColor, setMemberColor] = useState<string>(CARD_COLOR_PALETTE[0]);
  const [showManualForm, setShowManualForm] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [savingMember, setSavingMember] = useState(false);

  // 全螢幕出示條碼狀態
  const [showModalOpen, setShowModalOpen] = useState(false);
  const [showCardId, setShowCardId] = useState<string | null>(null);

  function resetMemberForm() {
    setEditingId(null);
    setMemberName('');
    setMemberCode('');
    setMemberFormat('auto');
    setMemberColor(CARD_COLOR_PALETTE[0]);
    setShowManualForm(false);
    setMemberError(null);
  }

  function startEditMember(card: WalletCard) {
    setEditingId(card.id);
    setMemberName(card.name);
    setMemberCode(card.code);
    setMemberFormat(card.format);
    setMemberColor(card.color);
    setShowManualForm(true);
    setMemberError(null);
  }

  async function handleSaveCarrier(e: React.FormEvent) {
    e.preventDefault();
    setCarrierTouched(true);
    setCarrierStatus(null);
    if (!isValidCarrier(normalizedCarrier)) {
      return;
    }
    setSavingCarrier(true);
    try {
      await saveCarrierCard(normalizedCarrier);
      setCarrierStatus('已儲存手機條碼');
    } catch (err) {
      setCarrierStatus(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSavingCarrier(false);
    }
  }

  async function handleDeleteCarrier() {
    if (!carrierCard) return;
    await deleteCard(carrierCard.id);
    setCarrierInput('');
    setCarrierTouched(false);
    setCarrierStatus('已刪除手機條碼');
  }

  async function handleSaveMember(e: React.FormEvent) {
    e.preventDefault();
    setMemberError(null);
    const trimmedName = memberName.trim();
    const trimmedCode = memberCode.trim();
    if (!trimmedName) {
      setMemberError('請輸入會員卡名稱');
      return;
    }
    if (trimmedName.length > MEMBER_CARD_NAME_MAX_LENGTH) {
      setMemberError(`會員卡名稱最多 ${MEMBER_CARD_NAME_MAX_LENGTH} 字`);
      return;
    }
    if (!trimmedCode) {
      setMemberError('請輸入或掃描條碼號碼');
      return;
    }

    setSavingMember(true);
    try {
      await saveMemberCard({
        id: editingId ?? undefined,
        name: trimmedName,
        code: trimmedCode,
        format: memberFormat,
        color: memberColor || pickCardColor(trimmedName),
      });
      resetMemberForm();
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSavingMember(false);
    }
  }

  async function handleMoveMember(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= memberCards.length) return;
    const ids = memberCards.map((c) => c.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(target, 0, moved);
    await reorderCards(ids);
  }

  const resolvedPreviewFormat =
    memberFormat === 'auto' ? guessFormat(memberCode.trim()) : memberFormat;

  return (
    <div className="space-y-5 pb-28">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            載具與會員卡
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            結帳時一鍵出示手機條碼與會員卡
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cards.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setShowCardId(cards[0]?.id ?? null);
                setShowModalOpen(true);
              }}
              className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              💳 出示條碼
            </button>
          )}
          <Link
            to="/settings"
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            回設定
          </Link>
        </div>
      </div>

      {/* 手機條碼載具區塊 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            電子發票手機條碼（載具）
          </h2>
          {carrierCard && (
            <button
              type="button"
              onClick={() => {
                setShowCardId(carrierCard.id);
                setShowModalOpen(true);
              }}
              className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
            >
              出示載具
            </button>
          )}
        </div>

        <form onSubmit={(e) => void handleSaveCarrier(e)} className="space-y-3">
          <div>
            <label
              htmlFor="carrier-code-input"
              className="mb-1 block text-xs text-slate-600 dark:text-slate-400"
            >
              手機條碼
            </label>
            <input
              id="carrier-code-input"
              type="text"
              value={carrierInput}
              onChange={(e) => {
                setCarrierInput(e.target.value);
                setCarrierTouched(true);
                setCarrierStatus(null);
              }}
              placeholder="/ABC1234"
              maxLength={12}
              autoCapitalize="characters"
              autoCorrect="off"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-900"
            />
            {carrierError && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {carrierError}
              </p>
            )}
            {!carrierError && carrierStatus && (
              <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                {carrierStatus}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={savingCarrier || !isValidCarrier(normalizedCarrier)}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {carrierCard ? '更新載具' : '儲存載具'}
            </button>
            {carrierCard && (
              <button
                type="button"
                onClick={() => void handleDeleteCarrier()}
                className="rounded-xl border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                刪除載具
              </button>
            )}
          </div>
        </form>
      </section>

      {/* 新增／編輯會員卡區塊 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {editingId ? '編輯會員卡' : '新增會員卡'}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={resetMemberForm}
              className="text-xs text-slate-500 hover:underline dark:text-slate-400"
            >
              取消編輯
            </button>
          )}
        </div>

        <form onSubmit={(e) => void handleSaveMember(e)} className="space-y-3">
          <div>
            <label
              htmlFor="member-name-input"
              className="mb-1 block text-xs text-slate-600 dark:text-slate-400"
            >
              會員卡名稱（最多 {MEMBER_CARD_NAME_MAX_LENGTH} 字）
            </label>
            <input
              id="member-name-input"
              type="text"
              value={memberName}
              onChange={(e) => {
                const next = e.target.value;
                setMemberName(next);
                if (!editingId) {
                  setMemberColor(pickCardColor(next));
                }
              }}
              placeholder="例如：全聯福利卡"
              maxLength={MEMBER_CARD_NAME_MAX_LENGTH}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-900"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setMemberError(null);
                setScannerOpen(true);
              }}
              className="flex-1 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200"
            >
              📷 用相機掃描
            </button>
            <button
              type="button"
              onClick={() => setShowManualForm(true)}
              className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              ⌨️ 手動輸入號碼
            </button>
          </div>

          {(showManualForm || memberCode.length > 0 || editingId) && (
            <div className="space-y-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/40">
              <div>
                <label
                  htmlFor="member-code-input"
                  className="mb-1 block text-xs text-slate-600 dark:text-slate-400"
                >
                  條碼號碼
                </label>
                <input
                  id="member-code-input"
                  type="text"
                  value={memberCode}
                  onChange={(e) => setMemberCode(e.target.value)}
                  placeholder="輸入條碼內容"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="member-format-select"
                  className="mb-1 block text-xs text-slate-600 dark:text-slate-400"
                >
                  條碼格式（自動判斷：{FORMAT_LABELS[resolvedPreviewFormat]}）
                </label>
                <select
                  id="member-format-select"
                  value={memberFormat}
                  onChange={(e) =>
                    setMemberFormat(e.target.value as BarcodeFormat | 'auto')
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value="auto">自動判斷（預設）</option>
                  <option value="code128">Code 128</option>
                  <option value="code39">Code 39</option>
                  <option value="ean13">EAN-13</option>
                  <option value="qr">QR Code</option>
                </select>
              </div>

              <div>
                <span className="mb-1.5 block text-xs text-slate-600 dark:text-slate-400">
                  卡片顏色
                </span>
                <div className="flex flex-wrap gap-2">
                  {CARD_COLOR_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setMemberColor(color)}
                      aria-label={`選擇顏色 ${color}`}
                      className={`h-7 w-7 rounded-full border-2 transition-transform ${
                        memberColor === color
                          ? 'scale-110 border-slate-900 dark:border-white'
                          : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              {memberError && (
                <p className="text-xs text-red-600 dark:text-red-400">{memberError}</p>
              )}

              <button
                type="submit"
                disabled={savingMember}
                className="w-full rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {editingId ? '儲存變更' : '新增會員卡'}
              </button>
            </div>
          )}
        </form>

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          部分會員卡的條碼每次都會變（例如有倒數秒數的動態 QR Code），這種無法存進來，請繼續用原本的 App。
        </p>
      </section>

      {/* 已儲存會員卡清單 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          已儲存會員卡（{memberCards.length}）
        </h2>

        {memberCards.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            尚未新增會員卡
          </p>
        ) : (
          <div className="space-y-2.5">
            {memberCards.map((card, index) => (
              <div
                key={card.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"
              >
                <button
                  type="button"
                  onClick={() => {
                    setShowCardId(card.id);
                    setShowModalOpen(true);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span
                    className="h-8 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: card.color }}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {card.name}
                    </div>
                    <div className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                      {card.code} · {FORMAT_LABELS[card.format]}
                    </div>
                  </div>
                </button>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => void handleMoveMember(index, -1)}
                    aria-label={`上移 ${card.name}`}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === memberCards.length - 1}
                    onClick={() => void handleMoveMember(index, 1)}
                    aria-label={`下移 ${card.name}`}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => startEditMember(card)}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    編輯
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteCard(card.id)}
                    className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    刪除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <BarcodeScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onFallbackManual={() => {
          setScannerOpen(false);
          setShowManualForm(true);
        }}
        onDetected={({ code, format }) => {
          setScannerOpen(false);
          setMemberCode(code);
          setMemberFormat(format);
          setShowManualForm(true);
        }}
      />

      <CardShowModal
        open={showModalOpen}
        cards={cards}
        initialCardId={showCardId}
        onClose={() => setShowModalOpen(false)}
      />
    </div>
  );
}
