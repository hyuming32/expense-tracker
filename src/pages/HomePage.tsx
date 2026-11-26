import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type BeforeInstallPromptEvent,
  InstallGuideSheet,
} from '../components/InstallGuideContent';
import { TransactionRow } from '../components/TransactionRow';
import type { TransactionDraft } from '../components/TransactionSheet';
import { useMoney, usePrivacy } from '../contexts/PrivacyContext';
import {
  type AmountColors,
  confirmRecurringOccurrence,
  dismissDataProtectionCard,
  dismissInstallPromptCard,
  type OnboardingMetaState,
  type PendingRecurringOccurrence,
  skipRecurringOccurrence,
} from '../db/repository';
import type {
  Account,
  Budget,
  Category,
  LotteryDraw,
  NoSpendDay,
  NotePreset,
  Place,
  Shortcut,
  Transaction,
} from '../db/types';
import {
  collectActiveDays,
  computeBudgetStatus,
  computeStreak,
  findFirstRecordDay,
  findMissingDays,
  formatMonthLabel,
  formatPeriodShortLabel,
  getCurrentMonthString,
  getLatestDrawnPeriod,
  getTodayDateString,
  type HomeLayoutItem,
  type HomeSectionKey,
  matchPeriod,
  monthSummary,
  parseQuickText,
  type QuickTextResult,
  shiftDate,
} from '../domain';
import {
  detectInstallPlatform,
  getHomeReminderCard,
  type InstallPlatform,
} from '../domain/onboarding';
import {
  chooseVoiceInputMode,
  describeSpeechError,
  KEYBOARD_DICTATION_TIP,
} from '../domain/voiceInput';
import { useOutboxCount } from '../hooks/useExpenseData';
import {
  formatSyncStatusText,
  formatSyncTimeLabel,
  loginAndSync,
  type SyncState,
  triggerSync,
} from '../sync/syncManager';

interface SpeechRecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface BrowserSpeechRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

interface HomePageProps {
  transactions: readonly Transaction[];
  shortcuts: readonly Shortcut[];
  lotteryDraws: readonly LotteryDraw[];
  budgets: readonly Budget[];
  noSpendDays: readonly NoSpendDay[];
  homeLayout: readonly HomeLayoutItem<HomeSectionKey>[];
  accounts: readonly Account[];
  categories: readonly Category[];
  places: readonly Place[];
  notePresets: readonly NotePreset[];
  defaultAccountId: string;
  accountMap: ReadonlyMap<string, Account>;
  categoryMap: ReadonlyMap<string, Category>;
  placeMap: ReadonlyMap<string, Place>;
  amountColors: AmountColors;
  syncState: SyncState;
  pendingRecurring: readonly PendingRecurringOccurrence[];
  isPersisted: boolean | null;
  isInstalled: boolean;
  installPlatform: InstallPlatform;
  deferredInstallPrompt: BeforeInstallPromptEvent | null;
  onboardingMeta: OnboardingMetaState | undefined;
  onTriggerInstall: () => Promise<void> | void;
  onOpenCreate: (draft?: TransactionDraft) => void;
  onEditTransaction: (tx: Transaction) => void;
  onQuickRecordShortcut: (shortcut: Shortcut) => void;
  onQuickRecordText: (parsed: QuickTextResult) => Promise<void> | void;
  onEditShortcut: (shortcut: Shortcut) => void;
}

export function HomePage({
  transactions,
  shortcuts,
  lotteryDraws,
  budgets,
  noSpendDays,
  homeLayout,
  accounts,
  categories,
  places,
  notePresets,
  defaultAccountId,
  accountMap,
  categoryMap,
  placeMap,
  amountColors,
  syncState,
  pendingRecurring,
  isPersisted,
  isInstalled,
  installPlatform,
  deferredInstallPrompt,
  onboardingMeta,
  onTriggerInstall,
  onOpenCreate,
  onEditTransaction,
  onQuickRecordShortcut,
  onQuickRecordText,
  onEditShortcut,
}: HomePageProps) {
  const formatMoney = useMoney();
  const { hideAmounts, toggleHideAmounts } = usePrivacy();
  const currentMonth = getCurrentMonthString();
  const today = getTodayDateString();
  const summary = useMemo(() => monthSummary(transactions, currentMonth), [transactions, currentMonth]);
  const budgetStatus = useMemo(
    () => computeBudgetStatus(budgets, transactions, categories, today),
    [budgets, transactions, categories, today],
  );
  const topBudgetCategories = useMemo(
    () => budgetStatus.categories.slice(0, 3),
    [budgetStatus.categories],
  );
  const { streakResult, recentMissingCount } = useMemo(() => {
    const activeDays = collectActiveDays(transactions, noSpendDays);
    const streak = computeStreak(activeDays, today);
    const firstDay = findFirstRecordDay(transactions, noSpendDays);
    const sevenDaysAgo = shiftDate(today, -7);
    const effectiveStart = firstDay
      ? firstDay > sevenDaysAgo
        ? firstDay
        : sevenDaysAgo
      : null;
    const missing = findMissingDays(activeDays, effectiveStart, today);
    return {
      streakResult: streak,
      recentMissingCount: missing.length,
    };
  }, [transactions, noSpendDays, today]);
  const recentTransactions = useMemo(() => transactions.slice(0, 10), [transactions]);
  const visibleShortcuts = useMemo(() => shortcuts.slice(0, 8), [shortcuts]);
  const latestDrawnPeriod = getLatestDrawnPeriod();
  const latestDraw = useMemo(
    () => lotteryDraws.find((d) => d.period === latestDrawnPeriod) ?? null,
    [lotteryDraws, latestDrawnPeriod],
  );
  const latestMatchResult = useMemo(
    () => (latestDraw ? matchPeriod(transactions, latestDraw) : null),
    [transactions, latestDraw],
  );
  const outboxCount = useOutboxCount();
  const syncStatusText = formatSyncStatusText(syncState);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [quickText, setQuickText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [submittingQuickText, setSubmittingQuickText] = useState(false);
  const [installSheetOpen, setInstallSheetOpen] = useState(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const quickTextInputRef = useRef<HTMLInputElement | null>(null);
  const [voiceTip, setVoiceTip] = useState('');
  const voiceMode = useMemo(
    () =>
      typeof navigator === 'undefined'
        ? 'none'
        : chooseVoiceInputMode(
            detectInstallPlatform({
              userAgent: navigator.userAgent,
              platform: navigator.platform,
              maxTouchPoints: navigator.maxTouchPoints,
            }),
            getSpeechRecognitionCtor() !== null,
          ),
    [],
  );
  const speechSupported = voiceMode !== 'none';

  const reminderCard = useMemo(() => {
    if (!onboardingMeta) {
      return null;
    }
    return getHomeReminderCard({
      dataProtection: {
        isSyncEnabled: syncState.status !== 'disabled',
        isPersisted,
        transactionCount: transactions.length,
        lastJsonBackupAt: onboardingMeta.lastJsonBackupAt,
        dismissedAt: onboardingMeta.dataProtectionDismissedAt,
        now: Date.now(),
      },
      installPrompt: {
        isInstalled,
        transactionCount: transactions.length,
        dismissedAt: onboardingMeta.installPromptDismissedAt,
        now: Date.now(),
      },
    });
  }, [onboardingMeta, syncState.status, isPersisted, transactions.length, isInstalled]);

  const parsedQuickText = useMemo(() => {
    const trimmed = quickText.trim();
    if (!trimmed) {
      return null;
    }
    return parseQuickText(trimmed, {
      categories,
      accounts,
      places,
      notePresets,
      today,
      defaultAccountId,
    });
  }, [quickText, categories, accounts, places, notePresets, today, defaultAccountId]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // 忽略語音辨識清理階段錯誤
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function buildDraftFromParsed(parsed: QuickTextResult): TransactionDraft {
    return {
      kind: parsed.kind,
      amount: parsed.amount,
      accountId: parsed.accountId,
      toAccountId: parsed.toAccountId,
      categoryId: parsed.categoryId,
      note: parsed.note,
      tags: parsed.tags,
      date: parsed.date,
      placeId: parsed.placeId,
    };
  }

  async function handleSubmitQuickText() {
    if (!parsedQuickText || submittingQuickText) {
      return;
    }
    if (parsedQuickText.amount !== null && parsedQuickText.amount > 0) {
      setSubmittingQuickText(true);
      try {
        await onQuickRecordText(parsedQuickText);
        setQuickText('');
      } finally {
        setSubmittingQuickText(false);
      }
      return;
    }
    onOpenCreate(buildDraftFromParsed(parsedQuickText));
  }

  function handleToggleVoiceInput() {
    if (voiceMode === 'keyboard-dictation') {
      // iPhone：Web Speech API 不穩定，改用系統鍵盤聽寫
      quickTextInputRef.current?.focus();
      setVoiceTip(KEYBOARD_DICTATION_TIP);
      return;
    }
    setVoiceTip('');
    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        setIsListening(false);
      }
      return;
    }
    const SpeechCtor = getSpeechRecognitionCtor();
    if (!SpeechCtor) {
      return;
    }
    try {
      const recognition = new SpeechCtor();
      recognition.lang = 'zh-TW';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      let gotResult = false;
      recognition.onresult = (event) => {
        gotResult = true;
        const transcript = event.results[0]?.[0]?.transcript?.trim();
        if (transcript) {
          setQuickText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
        }
      };
      let errorShown = false;
      recognition.onerror = (event) => {
        errorShown = true;
        setVoiceTip(describeSpeechError(event?.error));
        setIsListening(false);
        recognitionRef.current = null;
      };
      recognition.onend = () => {
        if (!gotResult && !errorShown) {
          setVoiceTip(describeSpeechError('no-speech'));
        }
        setIsListening(false);
        recognitionRef.current = null;
      };
      recognitionRef.current = recognition;
      setIsListening(true);
      recognition.start();
    } catch {
      setVoiceTip(describeSpeechError(undefined));
      setIsListening(false);
      recognitionRef.current = null;
    }
  }

  const shortcutsVisible = useMemo(
    () => homeLayout.find((item) => item.key === 'shortcuts')?.visible ?? true,
    [homeLayout],
  );

  function renderHomeSection(sectionKey: HomeSectionKey) {
    switch (sectionKey) {
      case 'syncStatus':
        return (
          <div className="space-y-2">
            <div className="flex items-center justify-end px-1">
              {syncState.status !== 'disabled' && syncState.status !== 'syncing' && outboxCount > 0 ? (
                <button
                  type="button"
                  onClick={() => void triggerSync()}
                  className="text-xs font-medium text-amber-600 underline-offset-2 hover:underline dark:text-amber-400"
                >
                  有 {outboxCount} 筆尚未同步
                </button>
              ) : (
                <span className="text-xs text-slate-500 dark:text-slate-400">{syncStatusText}</span>
              )}
            </div>

            {syncState.status === 'error' && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-800/70 dark:bg-red-950/40 dark:text-red-100"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="font-semibold">
                    同步失敗：{syncState.errorMessage ?? '未知錯誤'}
                  </div>
                  <div className="text-red-700 dark:text-red-300">
                    上次成功同步：
                    {syncState.lastSyncAt ? formatSyncTimeLabel(syncState.lastSyncAt) : '尚未同步'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void triggerSync()}
                  className="shrink-0 rounded-xl bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700"
                >
                  重試
                </button>
              </div>
            )}

            {syncState.status === 'reauth' && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-100"
              >
                <div className="font-semibold">Google 登入已過期，請重新登入</div>
                <button
                  type="button"
                  onClick={() => void loginAndSync()}
                  className="shrink-0 rounded-xl bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
                >
                  重新登入
                </button>
              </div>
            )}

            {syncState.status === 'offline' && (
              <div
                role="status"
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100"
              >
                <div className="font-medium">目前離線，資料已存在手機，恢復網路後會自動同步</div>
                <span className="shrink-0 font-semibold tabular-nums text-slate-600 dark:text-slate-300">
                  未同步 {outboxCount} 筆
                </span>
              </div>
            )}
          </div>
        );

      case 'reminders':
        if (reminderCard === 'data-protection') {
          return (
            <section className="rounded-2xl border border-amber-200 bg-amber-50/90 p-4 text-xs text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-100">
              <p className="leading-relaxed">
                你的帳目只存在這支手機的瀏覽器裡，清除瀏覽器資料或換手機就會不見。建議開啟 Google
                雲端同步，或到設定匯出備份。
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void dismissDataProtectionCard()}
                  className="rounded-xl px-3 py-1.5 font-medium text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/50"
                >
                  稍後
                </button>
                <button
                  type="button"
                  onClick={() => void loginAndSync()}
                  className="rounded-xl bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-slate-950 dark:hover:bg-amber-400"
                >
                  開啟同步
                </button>
              </div>
            </section>
          );
        }
        if (reminderCard === 'install-pwa') {
          return (
            <section className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-xs text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-100">
              <button
                type="button"
                onClick={() => setInstallSheetOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left font-medium hover:underline"
              >
                <span aria-hidden="true">📲</span>
                <span>加到主畫面，記帳更快</span>
              </button>
              <button
                type="button"
                onClick={() => void dismissInstallPromptCard()}
                aria-label="關閉加到主畫面提醒"
                className="shrink-0 rounded-lg px-2 py-1 text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
              >
                ✕
              </button>
            </section>
          );
        }
        return null;

      case 'quickText':
        return (
          <section className="space-y-2">
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm focus-within:border-emerald-500 dark:border-slate-800 dark:bg-slate-900 dark:focus-within:border-emerald-500">
          <input
            ref={quickTextInputRef}
            type="text"
            value={quickText}
            onChange={(e) => {
              setQuickText(e.target.value);
              if (voiceTip) {
                setVoiceTip('');
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleSubmitQuickText();
              }
            }}
            placeholder="一句話記帳，例如：午餐 牛肉麵 180"
            aria-label="一句話記帳"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          {speechSupported && (
            <button
              type="button"
              onClick={handleToggleVoiceInput}
              aria-label={isListening ? '停止語音輸入' : '語音輸入'}
              title={isListening ? '聆聽中，點擊停止' : '語音輸入（中文）'}
              className={`shrink-0 rounded-xl px-2.5 py-1.5 text-sm transition-colors ${
                isListening
                  ? 'animate-pulse bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-300'
                  : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              🎤
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSubmitQuickText()}
            disabled={!parsedQuickText || submittingQuickText}
            className="shrink-0 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
          >
            記下
          </button>
        </div>

        {voiceTip && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {voiceTip}
          </p>
        )}

        {parsedQuickText && (() => {
          const matchedCategory = parsedQuickText.categoryId
            ? categoryMap.get(parsedQuickText.categoryId)
            : undefined;
          const fromAccount = accountMap.get(parsedQuickText.accountId);
          const toAccount = parsedQuickText.toAccountId
            ? accountMap.get(parsedQuickText.toAccountId)
            : undefined;
          const matchedPlace = parsedQuickText.placeId
            ? placeMap.get(parsedQuickText.placeId)
            : undefined;
          const categoryLabel =
            parsedQuickText.kind === 'transfer'
              ? '轉帳'
              : parsedQuickText.confidence.category
                ? (matchedCategory?.name ?? '其他')
                : '其他（點此修改）';
          const categoryIcon =
            parsedQuickText.kind === 'transfer'
              ? '🔄'
              : (matchedCategory?.icon ?? '📦');

          return (
            <button
              type="button"
              onClick={() => onOpenCreate(buildDraftFromParsed(parsedQuickText))}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-emerald-700"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                  <span aria-hidden="true">{categoryIcon}</span>
                  <span>{categoryLabel}</span>
                  {parsedQuickText.note && (
                    <span className="truncate text-slate-600 dark:text-slate-300">
                      · {parsedQuickText.note}
                    </span>
                  )}
                  {parsedQuickText.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                  <span>
                    {parsedQuickText.kind === 'transfer'
                      ? `${fromAccount?.name ?? '帳戶'} → ${toAccount?.name ?? '帳戶'}`
                      : (fromAccount?.name ?? '帳戶')}
                  </span>
                  {parsedQuickText.date !== today && <span>· {parsedQuickText.date}</span>}
                  {matchedPlace && (
                    <span>
                      · {matchedPlace.icon} {matchedPlace.name}
                    </span>
                  )}
                </div>
              </div>
              <div
                className="shrink-0 text-base font-bold tabular-nums"
                style={
                  parsedQuickText.amount !== null
                    ? parsedQuickText.kind === 'expense'
                      ? { color: amountColors.expense }
                      : parsedQuickText.kind === 'income'
                        ? { color: amountColors.income }
                        : undefined
                    : undefined
                }
              >
                {parsedQuickText.amount !== null ? (
                  formatMoney(parsedQuickText.amount)
                ) : (
                  <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    點此補填金額
                  </span>
                )}
              </div>
            </button>
          );
        })()}
      </section>
        );

      case 'summary':
        return (
      <section className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm dark:bg-slate-800">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-base font-semibold">{formatMonthLabel(currentMonth)}收支</h1>
          <span className="text-xs text-slate-300">僅計入一般收支</span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-slate-300">本月支出</div>
            <div className="mt-1 text-lg font-bold tabular-nums" style={{ color: amountColors.expense }}>
              {formatMoney(summary.expense)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-300">本月收入</div>
            <div className="mt-1 text-lg font-bold tabular-nums" style={{ color: amountColors.income }}>
              {formatMoney(summary.income)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-300">結餘</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-white">
              {formatMoney(summary.net)}
            </div>
          </div>
        </div>
      </section>
        );

      case 'habit':
        return (
        <Link
          to="/calendar"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-emerald-700"
        >
          <div className="flex flex-wrap items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
            <span>
              {streakResult.streak >= 2
                ? `🔥 已連續記帳 ${streakResult.streak} 天`
                : '今天記一筆，開始累積連續天數'}
            </span>
            {!streakResult.todayRecorded && (
              <span className="text-slate-500 dark:text-slate-400">· 今天還沒記喔</span>
            )}
          </div>
          {recentMissingCount > 0 ? (
            <span className="font-semibold text-amber-600 dark:text-amber-400">
              最近有 {recentMissingCount} 天沒記，去補一下 →
            </span>
          ) : (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              補帳日曆 →
            </span>
          )}
        </Link>
        );

      case 'budget':
        return !budgetStatus.total && topBudgetCategories.length === 0 ? (
        <Link
          to="/settings?section=budget"
          className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs font-medium text-slate-600 transition-colors hover:border-emerald-300 hover:text-emerald-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-emerald-700 dark:hover:text-emerald-300"
        >
          <span>設定每月預算，掌握每天還能花多少 →</span>
        </Link>
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">本月預算</h2>
              {budgetStatus.total && budgetStatus.total.status !== 'normal' && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    budgetStatus.total.status === 'over'
                      ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                  }`}
                >
                  {budgetStatus.total.statusLabel}
                </span>
              )}
            </div>
            <Link
              to="/settings?section=budget"
              className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
            >
              調整 →
            </Link>
          </div>

          {budgetStatus.total && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                {budgetStatus.total.remaining < 0 ? (
                  <div className="text-lg font-bold tabular-nums text-red-600 dark:text-red-400">
                    已超支 {formatMoney(Math.abs(budgetStatus.total.remaining))}
                  </div>
                ) : (
                  <div
                    className={`text-base font-bold tabular-nums sm:text-lg ${
                      budgetStatus.total.status === 'warning'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    還剩 {formatMoney(budgetStatus.total.remaining)}，平均每天可花{' '}
                    {formatMoney(budgetStatus.total.perDay)}
                  </div>
                )}
              </div>

              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all ${
                    budgetStatus.total.status === 'over'
                      ? 'bg-red-500'
                      : budgetStatus.total.status === 'warning'
                        ? 'bg-amber-500'
                        : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(100, Math.round(budgetStatus.total.ratio * 100))}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs tabular-nums text-slate-500 dark:text-slate-400">
                <span>
                  已花 {formatMoney(budgetStatus.total.spent)} ／ 預算{' '}
                  {formatMoney(budgetStatus.total.budget)}
                </span>
                <span>剩餘 {budgetStatus.daysLeft} 天</span>
              </div>
            </div>
          )}

          {topBudgetCategories.length > 0 && (
            <div
              className={`space-y-2 ${
                budgetStatus.total
                  ? 'mt-3 border-t border-slate-100 pt-3 dark:border-slate-800'
                  : ''
              }`}
            >
              {topBudgetCategories.map((item) => (
                <div key={item.categoryId} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex min-w-0 items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
                      <span className="shrink-0">{item.categoryIcon}</span>
                      <span className="truncate">{item.categoryName}</span>
                      {item.status !== 'normal' && (
                        <span
                          className={`shrink-0 text-[10px] font-semibold ${
                            item.status === 'over'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {item.statusLabel}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
                      {formatMoney(item.spent)} / {formatMoney(item.budget)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className={`h-full rounded-full ${
                        item.status === 'over'
                          ? 'bg-red-500'
                          : item.status === 'warning'
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(100, Math.round(item.ratio * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      );

      case 'lottery':
        if (!latestDraw) {
          return (
        <Link
          to="/lottery"
          className="flex items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-950/50"
        >
          <span>🎟️ {formatPeriodShortLabel(latestDrawnPeriod)}發票開獎了，去對獎</span>
          <span className="text-xs text-amber-700 dark:text-amber-300">前往 →</span>
        </Link>
          );
        }
        if (latestMatchResult && latestMatchResult.matched.length > 0) {
          return (
          <Link
            to="/lottery"
            className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900 transition-colors hover:bg-emerald-100 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-950/60"
          >
            <span>
              🎉 中獎 {latestMatchResult.matched.length} 張，共{' '}
              {formatMoney(latestMatchResult.totalAmount)}
            </span>
            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              查看明細 →
            </span>
          </Link>
          );
        }
        return null;

      case 'pendingRecurring':
        if (pendingRecurring.length === 0) {
          return null;
        }
        return (
        <section className="overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/70 dark:border-amber-800/70 dark:bg-amber-950/30">
          <div className="flex items-center justify-between border-b border-amber-200/70 px-4 py-2.5 dark:border-amber-800/60">
            <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              待確認週期收支（{pendingRecurring.length}）
            </h2>
          </div>
          <div className="divide-y divide-amber-200/60 dark:divide-amber-800/50">
            {pendingRecurring.map((item) => {
              const { rule, occurrenceDate } = item;
              const category = rule.categoryId ? categoryMap.get(rule.categoryId) : undefined;
              const account = accountMap.get(rule.accountId);
              const toAccount = rule.toAccountId ? accountMap.get(rule.toAccountId) : undefined;
              const title =
                rule.note ||
                (rule.kind === 'transfer'
                  ? `${account?.name ?? '帳戶'} → ${toAccount?.name ?? '帳戶'}`
                  : (category?.name ?? '週期收支'));

              return (
                <div
                  key={item.transactionId}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      <span>🔁</span>
                      <span className="truncate">{title}</span>
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">
                      {occurrenceDate} · {account?.name ?? ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className="text-sm font-semibold tabular-nums"
                      style={
                        rule.kind === 'expense'
                          ? { color: amountColors.expense }
                          : rule.kind === 'income'
                            ? { color: amountColors.income }
                            : undefined
                      }
                    >
                      {formatMoney(rule.amount)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void confirmRecurringOccurrence(rule, occurrenceDate)}
                      className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                    >
                      入帳
                    </button>
                    <button
                      type="button"
                      onClick={() => void skipRecurringOccurrence(rule, occurrenceDate)}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      略過這期
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        );

      case 'recentTransactions':
        return (
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">最近紀錄</h2>
          <Link to="/transactions" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            查看全部
          </Link>
        </div>

        {recentTransactions.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            尚無記帳紀錄，點擊右下角「＋」開始記一筆
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {recentTransactions.map((tx) => (
              <TransactionRow
                key={tx.id}
                transaction={tx}
                accountMap={accountMap}
                categoryMap={categoryMap}
                placeMap={placeMap}
                amountColors={amountColors}
                onSelect={onEditTransaction}
                showDate
              />
            ))}
          </div>
        )}
      </section>
        );

      case 'shortcuts':
        return null;
    }
  }

  return (
    <div className="space-y-4 pb-40">
      {/* 隱私隱藏金額切換按鈕 */}
      <div className="flex items-center justify-end px-1">
        <button
          type="button"
          onClick={toggleHideAmounts}
          aria-label={hideAmounts ? '顯示金額' : '隱藏金額'}
          aria-pressed={hideAmounts}
          title={hideAmounts ? '目前隱藏金額，點擊顯示' : '點擊隱藏所有金額'}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            hideAmounts
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
          }`}
        >
          <span aria-hidden="true">👁</span>
          <span>{hideAmounts ? '已隱藏金額' : '隱藏金額'}</span>
        </button>
      </div>

      {homeLayout
        .filter((item) => item.visible && item.key !== 'shortcuts')
        .map((item) => (
          <Fragment key={item.key}>{renderHomeSection(item.key)}</Fragment>
        ))}

      {/* 首頁捷徑列（「＋」按鈕上方） */}
      {shortcutsVisible && (
      <div className="fixed bottom-[148px] left-1/2 z-20 w-full max-w-[720px] -translate-x-1/2 px-4">
        {visibleShortcuts.length === 0 ? (
          <div className="pointer-events-none flex justify-end">
            <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-[11px] text-slate-500 shadow-sm backdrop-blur dark:border-slate-700/80 dark:bg-slate-900/90 dark:text-slate-400">
              記帳後點「存成捷徑」或至設定頁新增首頁捷徑
            </span>
          </div>
        ) : (
          <div
            className="flex items-center gap-2 overflow-x-auto py-1"
            aria-label="首頁捷徑列"
          >
            {visibleShortcuts.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                onClick={() => {
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  if (shortcut.amount !== null) {
                    onQuickRecordShortcut(shortcut);
                  } else {
                    onOpenCreate({
                      kind: shortcut.kind,
                      amount: null,
                      accountId: shortcut.accountId,
                      toAccountId: shortcut.toAccountId,
                      categoryId: shortcut.categoryId,
                      note: shortcut.note,
                    });
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onEditShortcut(shortcut);
                }}
                onTouchStart={() => {
                  longPressTriggeredRef.current = false;
                  clearLongPressTimer();
                  longPressTimerRef.current = window.setTimeout(() => {
                    longPressTriggeredRef.current = true;
                    onEditShortcut(shortcut);
                  }, 500);
                }}
                onTouchEnd={clearLongPressTimer}
                onTouchMove={clearLongPressTimer}
                onTouchCancel={clearLongPressTimer}
                title="點一下記帳，長按或右鍵可編輯／刪除"
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-800 shadow-sm backdrop-blur transition-colors hover:border-emerald-400 hover:bg-emerald-50 active:scale-95 dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-100 dark:hover:border-emerald-500 dark:hover:bg-slate-800"
              >
                <span aria-hidden="true">{shortcut.icon}</span>
                <span>{shortcut.label}</span>
                {shortcut.amount !== null && (
                  <span
                    className="tabular-nums font-semibold"
                    style={
                      shortcut.kind === 'expense'
                        ? { color: amountColors.expense }
                        : shortcut.kind === 'income'
                          ? { color: amountColors.income }
                          : undefined
                    }
                  >
                    {formatMoney(shortcut.amount)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {/* 右下角固定新增按鈕 */}
      <button
        type="button"
        onClick={() => onOpenCreate()}
        aria-label="記一筆"
        className="fixed bottom-20 right-5 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-2xl font-bold text-white shadow-lg transition-transform hover:scale-105 hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:hover:bg-emerald-600"
      >
        ＋
      </button>

      <InstallGuideSheet
        open={installSheetOpen}
        platform={installPlatform}
        deferredPrompt={deferredInstallPrompt}
        onTriggerInstall={onTriggerInstall}
        onClose={() => setInstallSheetOpen(false)}
      />
    </div>
  );
}
