import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { saveLotteryDraw } from '../db/repository';
import type { LotteryDraw, Place, Transaction } from '../db/types';
import {
  claimDeadline,
  drawDateOfPeriod,
  formatCurrency,
  formatPeriodLabel,
  getLatestDrawnPeriod,
  getRecentPeriods,
  isPeriodDrawn,
  matchPeriod,
  PRIZE_LABELS,
  sanitizeDigitsInput,
} from '../domain';
import { type OcrProgress, recognizeLotteryScreenshot } from '../lib/lotteryOcr';
import { consumeSharedLotteryImage, isShareTargetUnsupported } from '../lib/shareTarget';

interface LotteryPageProps {
  transactions: readonly Transaction[];
  places: readonly Place[];
  lotteryDraws: readonly LotteryDraw[];
}

function formatDrawDateHint(period: string): string {
  const drawDate = drawDateOfPeriod(period);
  const month = Number(drawDate.slice(5, 7));
  return `尚未開獎（開獎日 ${month} 月 25 日）`;
}

export function LotteryPage({ transactions, places, lotteryDraws }: LotteryPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const periods = useMemo(() => getRecentPeriods(undefined, 12), []);
  const defaultPeriod = useMemo(() => getLatestDrawnPeriod(), []);
  const [selectedPeriod, setSelectedPeriod] = useState<string>(defaultPeriod);

  const drawByPeriod = useMemo(() => {
    const map = new Map<string, LotteryDraw>();
    for (const draw of lotteryDraws) {
      map.set(draw.period, draw);
    }
    return map;
  }, [lotteryDraws]);

  const placeMap = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);

  const savedDraw = drawByPeriod.get(selectedPeriod) ?? null;

  const [special, setSpecial] = useState('');
  const [grand, setGrand] = useState('');
  const [first, setFirst] = useState<string[]>(['', '', '']);
  const [extraSixth, setExtraSixth] = useState<string[]>([]);
  const [lowConfidenceFields, setLowConfidenceFields] = useState<Set<string>>(new Set());
  const [hasUnsavedDraft, setHasUnsavedDraft] = useState(false);

  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const [ocrMessage, setOcrMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shareUnsupported = useMemo(() => isShareTargetUnsupported(), []);

  // 切換期別或資料庫更新時同步表單（若尚未有未儲存草稿）
  useEffect(() => {
    if (savedDraw) {
      setSpecial(savedDraw.special);
      setGrand(savedDraw.grand);
      setFirst(
        savedDraw.first.length >= 3
          ? [...savedDraw.first]
          : [...savedDraw.first, ...Array(3 - savedDraw.first.length).fill('')],
      );
      setExtraSixth([...savedDraw.extraSixth]);
    } else {
      setSpecial('');
      setGrand('');
      setFirst(['', '', '']);
      setExtraSixth([]);
    }
    setLowConfidenceFields(new Set());
    setHasUnsavedDraft(false);
    setFormError(null);
    setSaveSuccessMsg(null);
    setOcrMessage(null);
  }, [selectedPeriod, savedDraw]);

  async function runOcrOnFile(file: File) {
    setFormError(null);
    setSaveSuccessMsg(null);
    setOcrMessage(null);
    setOcrProgress({ status: '準備辨識中', progress: 0 });
    try {
      const result = await recognizeLotteryScreenshot(file, (info) => {
        setOcrProgress(info);
      });
      setSpecial(result.draft.special);
      setGrand(result.draft.grand);
      setFirst(result.draft.first.length > 0 ? result.draft.first : ['', '', '']);
      setExtraSixth(result.draft.extraSixth);
      setLowConfidenceFields(new Set(result.draft.lowConfidenceFields));
      setHasUnsavedDraft(true);
      setOcrMessage(
        result.draft.lowConfidenceFields.length > 0
          ? '已填入辨識草稿，黃色標示欄位請人工確認後，按「確認並比對」存檔。'
          : '已填入辨識草稿，請核對號碼後按「確認並比對」存檔。',
      );
    } catch (error) {
      setFormError(error instanceof Error ? `截圖辨識失敗：${error.message}` : '截圖辨識失敗');
    } finally {
      setOcrProgress(null);
    }
  }

  // 處理從其他 App 透過 Web Share Target 分享進來的截圖
  useEffect(() => {
    if (searchParams.get('shared') !== '1') {
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('shared');
    setSearchParams(nextParams, { replace: true });

    void consumeSharedLotteryImage().then((file) => {
      if (file) {
        void runOcrOnFile(file);
      }
    });
  }, [searchParams, setSearchParams]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    void runOcrOnFile(file);
  }

  function clearConfidence(fieldKey: string) {
    if (!lowConfidenceFields.has(fieldKey)) {
      return;
    }
    setLowConfidenceFields((prev) => {
      const next = new Set(prev);
      next.delete(fieldKey);
      return next;
    });
  }

  function handleSpecialChange(value: string) {
    setSpecial(sanitizeDigitsInput(value).slice(0, 8));
    setHasUnsavedDraft(true);
    clearConfidence('special');
  }

  function handleGrandChange(value: string) {
    setGrand(sanitizeDigitsInput(value).slice(0, 8));
    setHasUnsavedDraft(true);
    clearConfidence('grand');
  }

  function handleFirstChange(index: number, value: string) {
    const cleaned = sanitizeDigitsInput(value).slice(0, 8);
    setFirst((prev) => prev.map((item, idx) => (idx === index ? cleaned : item)));
    setHasUnsavedDraft(true);
    clearConfidence(`first.${index}`);
  }

  function handleExtraSixthChange(index: number, value: string) {
    const cleaned = sanitizeDigitsInput(value).slice(0, 3);
    setExtraSixth((prev) => prev.map((item, idx) => (idx === index ? cleaned : item)));
    setHasUnsavedDraft(true);
    clearConfidence(`extraSixth.${index}`);
  }

  async function handleConfirmAndMatch() {
    setFormError(null);
    setSaveSuccessMsg(null);

    if (special.length !== 8) {
      setFormError('特別獎需為 8 碼數字');
      return;
    }
    if (grand.length !== 8) {
      setFormError('特獎需為 8 碼數字');
      return;
    }
    const trimmedFirst = first.map((f) => f.trim()).filter((f) => f.length > 0);
    if (trimmedFirst.length === 0 || trimmedFirst.some((f) => f.length !== 8)) {
      setFormError('頭獎至少需填寫 1 組，且每組需為 8 碼數字');
      return;
    }
    const trimmedExtra = extraSixth.map((e) => e.trim()).filter((e) => e.length > 0);
    if (trimmedExtra.some((e) => e.length !== 3)) {
      setFormError('增開六獎每組需為 3 碼數字');
      return;
    }

    setSaving(true);
    try {
      await saveLotteryDraw({
        period: selectedPeriod,
        special,
        grand,
        first: trimmedFirst,
        extraSixth: trimmedExtra,
      });
      setLowConfidenceFields(new Set());
      setHasUnsavedDraft(false);
      setOcrMessage(null);
      setSaveSuccessMsg('已儲存開獎號碼並完成比對');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  }

  const periodDrawn = isPeriodDrawn(selectedPeriod);
  const matchResult = useMemo(() => {
    if (!savedDraw) {
      return null;
    }
    return matchPeriod(transactions, savedDraw);
  }, [transactions, savedDraw]);

  const inputBaseClass =
    'w-full rounded-xl border px-3 py-2 font-mono text-sm tracking-wider outline-none transition-colors';
  const normalInputClass =
    'border-slate-300 bg-white text-slate-900 focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
  const lowConfidenceInputClass =
    'border-amber-400 bg-amber-50 text-slate-900 focus:border-amber-500 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-100';

  return (
    <div className="space-y-4 pb-24">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">發票兌獎</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            輸入或辨識開獎號碼，立即比對本機記帳發票
          </p>
        </div>
      </header>

      {/* 期別選單 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <label
          htmlFor="lottery-period-select"
          className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300"
        >
          選擇發票期別
        </label>
        <select
          id="lottery-period-select"
          value={selectedPeriod}
          onChange={(e) => setSelectedPeriod(e.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          {periods.map((period) => {
            const drawn = isPeriodDrawn(period);
            const hasSaved = drawByPeriod.has(period);
            const suffix = !drawn
              ? `（${formatDrawDateHint(period)}）`
              : hasSaved
                ? '（已輸入號碼）'
                : '';
            return (
              <option key={period} value={period}>
                {formatPeriodLabel(period)}
                {suffix}
              </option>
            );
          })}
        </select>

        {!periodDrawn && (
          <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
            {formatDrawDateHint(selectedPeriod)}
          </p>
        )}
      </section>

      {/* 開獎號碼輸入與截圖辨識區 */}
      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">開獎號碼</h2>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
              aria-label="從截圖辨識發票開獎號碼"
            />
            <button
              type="button"
              disabled={ocrProgress !== null}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl border border-emerald-600 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
            >
              📷 從截圖辨識
            </button>
          </div>
        </div>

        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          截圖僅在您的裝置本機辨識，不會上傳至任何伺服器。
          {shareUnsupported && ' iPhone 請按「從截圖辨識」選圖。'}
        </p>

        {ocrProgress && (
          <div className="space-y-1.5 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-800/70 dark:bg-sky-950/40 dark:text-sky-100">
            <div className="flex items-center justify-between font-medium">
              <span>{ocrProgress.status}</span>
              <span className="tabular-nums">{Math.round(ocrProgress.progress * 100)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-sky-200 dark:bg-sky-900">
              <div
                className="h-full bg-sky-600 transition-all dark:bg-sky-400"
                style={{ width: `${Math.round(ocrProgress.progress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {ocrMessage && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-100">
            {ocrMessage}
          </div>
        )}

        <div className="space-y-3">
          {/* 特別獎 */}
          <div>
            <label className="mb-1 flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
              <span>特別獎（1,000 萬元）</span>
              {special.length > 0 && special.length !== 8 && (
                <span className="text-rose-600 dark:text-rose-400">需為 8 碼</span>
              )}
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={special}
              onChange={(e) => handleSpecialChange(e.target.value)}
              placeholder="輸入 8 碼數字"
              className={`${inputBaseClass} ${
                lowConfidenceFields.has('special') ? lowConfidenceInputClass : normalInputClass
              }`}
            />
          </div>

          {/* 特獎 */}
          <div>
            <label className="mb-1 flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
              <span>特獎（200 萬元）</span>
              {grand.length > 0 && grand.length !== 8 && (
                <span className="text-rose-600 dark:text-rose-400">需為 8 碼</span>
              )}
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={grand}
              onChange={(e) => handleGrandChange(e.target.value)}
              placeholder="輸入 8 碼數字"
              className={`${inputBaseClass} ${
                lowConfidenceFields.has('grand') ? lowConfidenceInputClass : normalInputClass
              }`}
            />
          </div>

          {/* 頭獎 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                頭獎（20 萬元）
              </span>
              <button
                type="button"
                onClick={() => {
                  setFirst((prev) => [...prev, '']);
                  setHasUnsavedDraft(true);
                }}
                className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
              >
                ＋ 新增一組
              </button>
            </div>
            {first.map((val, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={val}
                    onChange={(e) => handleFirstChange(idx, e.target.value)}
                    placeholder={`頭獎第 ${idx + 1} 組（8 碼）`}
                    aria-label={`頭獎第 ${idx + 1} 組`}
                    className={`${inputBaseClass} ${
                      lowConfidenceFields.has(`first.${idx}`)
                        ? lowConfidenceInputClass
                        : normalInputClass
                    }`}
                  />
                  {val.length > 0 && val.length !== 8 && (
                    <span className="mt-0.5 block text-[11px] text-rose-600 dark:text-rose-400">
                      需為 8 碼（目前 {val.length} 碼）
                    </span>
                  )}
                </div>
                {first.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setFirst((prev) => prev.filter((_, i) => i !== idx));
                      setHasUnsavedDraft(true);
                    }}
                    className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    aria-label={`刪除頭獎第 ${idx + 1} 組`}
                  >
                    刪除
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 增開六獎 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                增開六獎（200 元，3 碼，可留空）
              </span>
              <button
                type="button"
                onClick={() => {
                  setExtraSixth((prev) => [...prev, '']);
                  setHasUnsavedDraft(true);
                }}
                className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
              >
                ＋ 新增增開六獎
              </button>
            </div>
            {extraSixth.map((val, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={val}
                    onChange={(e) => handleExtraSixthChange(idx, e.target.value)}
                    placeholder={`增開六獎第 ${idx + 1} 組（3 碼）`}
                    aria-label={`增開六獎第 ${idx + 1} 組`}
                    className={`${inputBaseClass} ${
                      lowConfidenceFields.has(`extraSixth.${idx}`)
                        ? lowConfidenceInputClass
                        : normalInputClass
                    }`}
                  />
                  {val.length > 0 && val.length !== 3 && (
                    <span className="mt-0.5 block text-[11px] text-rose-600 dark:text-rose-400">
                      需為 3 碼（目前 {val.length} 碼）
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setExtraSixth((prev) => prev.filter((_, i) => i !== idx));
                    setHasUnsavedDraft(true);
                  }}
                  className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  aria-label={`刪除增開六獎第 ${idx + 1} 組`}
                >
                  刪除
                </button>
              </div>
            ))}
          </div>
        </div>

        {formError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/40 dark:text-rose-200">
            {formError}
          </div>
        )}

        {saveSuccessMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200">
            {saveSuccessMsg}
          </div>
        )}

        <button
          type="button"
          disabled={saving}
          onClick={() => void handleConfirmAndMatch()}
          className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? '儲存中...' : hasUnsavedDraft ? '確認並比對（尚未存檔）' : '確認並比對'}
        </button>
      </section>

      {/* 對獎結果 */}
      {matchResult && (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">對獎結果</h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              領獎期限（估算）：{claimDeadline(selectedPeriod)}
            </span>
          </div>

          {matchResult.matched.length === 0 ? (
            <div className="rounded-xl bg-slate-50 px-4 py-5 text-center text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              這期沒有中獎，共比對 {matchResult.checkedCount} 張發票
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
                <span className="text-sm font-semibold">
                  恭喜中獎 {matchResult.matched.length} 張（共比對 {matchResult.checkedCount} 張）
                </span>
                <span className="text-base font-bold tabular-nums">
                  {formatCurrency(matchResult.totalAmount)}
                </span>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {matchResult.matched.map((item) => {
                  const place = item.transaction.placeId
                    ? placeMap.get(item.transaction.placeId)
                    : undefined;
                  const storeLabel = place
                    ? `${place.icon} ${place.name}`
                    : item.transaction.note || '未填寫店家／備註';
                  return (
                    <div
                      key={item.transaction.id}
                      className="flex items-center justify-between gap-3 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {item.transaction.invoiceNo}
                          </span>
                          <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            {PRIZE_LABELS[item.prize]}
                          </span>
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {item.transaction.date} · {storeLabel} · 消費{' '}
                          {formatCurrency(item.transaction.amount)}
                        </div>
                      </div>
                      <div className="shrink-0 font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                        +{formatCurrency(item.amount)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {matchResult.missingInvoiceCount > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              這期有 {matchResult.missingInvoiceCount} 筆交易沒有發票號碼，未納入比對
            </p>
          )}
        </section>
      )}
    </div>
  );
}
