import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { saveReportPeriodKind, type AmountColors } from '../db/repository';
import type { Category, Transaction } from '../db/types';
import {
  categoryBreakdownInRange,
  categoryCompare,
  clipToElapsed,
  compareSummary,
  formatCurrency,
  getTodayDateString,
  periodRange,
  periodSummary,
  periodTrend,
  sameLastYear,
  shiftPeriod,
  type CompareResult,
  type PeriodKind,
} from '../domain';
import { useReportPeriodKind } from '../hooks/useExpenseData';

interface ReportsPageProps {
  transactions: readonly Transaction[];
  categories: readonly Category[];
  amountColors: AmountColors;
}

const PERIOD_TABS: ReadonlyArray<{ kind: PeriodKind; label: string }> = [
  { kind: 'month', label: '月' },
  { kind: 'quarter', label: '季' },
  { kind: 'year', label: '年' },
];

const TREND_COUNTS: Record<PeriodKind, number> = {
  month: 12,
  quarter: 8,
  year: 5,
};

const TREND_TITLES: Record<PeriodKind, string> = {
  month: '近 12 個月收支趨勢',
  quarter: '近 8 季收支趨勢',
  year: '近 5 年收支趨勢',
};

const PIE_COLORS = [
  '#10b981',
  '#3b82f6',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#64748b',
] as const;

function formatSignedCurrency(amount: number): string {
  if (amount > 0) {
    return `+${formatCurrency(amount)}`;
  }
  return formatCurrency(amount);
}

function formatPctBadge(pct: number | null): string {
  if (pct === null) {
    return '—';
  }
  if (pct > 0) {
    return `▲${Math.abs(pct)}%`;
  }
  if (pct < 0) {
    return `▼${Math.abs(pct)}%`;
  }
  return '0%';
}

function getDeltaColorClass(diff: number, inverseGood: boolean): string {
  if (diff === 0) {
    return 'text-slate-500 dark:text-slate-400';
  }
  const isPositiveOutcome = inverseGood ? diff < 0 : diff > 0;
  return isPositiveOutcome
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400';
}

function renderCompareLine(
  prefix: string,
  cmp: CompareResult,
  inverseGood: boolean,
  withAmount: boolean,
) {
  const colorClass = getDeltaColorClass(cmp.diff, inverseGood);
  const pctText = formatPctBadge(cmp.pct);
  const amountText = withAmount && cmp.diff !== 0 ? `（${formatSignedCurrency(cmp.diff)}）` : '';

  return (
    <div className="mt-1 flex flex-wrap items-baseline gap-1 text-[11px] leading-tight">
      <span className="text-slate-400 dark:text-slate-500">{prefix}</span>
      <span className={`font-medium tabular-nums ${colorClass}`}>
        {pctText}
        {amountText}
      </span>
    </div>
  );
}

export function ReportsPage({ transactions, categories, amountColors }: ReportsPageProps) {
  const savedKind = useReportPeriodKind();
  const [periodKind, setPeriodKind] = useState<PeriodKind>(savedKind);
  const [anchor, setAnchor] = useState<string>(getTodayDateString);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setPeriodKind(savedKind);
  }, [savedKind]);

  const today = getTodayDateString();

  const currentRange = useMemo(() => periodRange(periodKind, anchor), [periodKind, anchor]);
  const prevRange = useMemo(() => shiftPeriod(currentRange, -1), [currentRange]);
  const lastYearRange = useMemo(() => sameLastYear(currentRange), [currentRange]);

  const elapsedPrev = useMemo(
    () => clipToElapsed(currentRange, prevRange, today),
    [currentRange, prevRange, today],
  );
  const elapsedLastYear = useMemo(
    () => clipToElapsed(currentRange, lastYearRange, today),
    [currentRange, lastYearRange, today],
  );

  const isInProgress = elapsedPrev.isInProgress;

  // 若期間進行中，摘要與上一期／去年同期都只比較到同一天
  const currentSumForPrev = useMemo(
    () => periodSummary(transactions, elapsedPrev.range),
    [transactions, elapsedPrev.range],
  );
  const prevSum = useMemo(
    () => periodSummary(transactions, elapsedPrev.compareRange),
    [transactions, elapsedPrev.compareRange],
  );
  const currentSumForLastYear = useMemo(
    () => periodSummary(transactions, elapsedLastYear.range),
    [transactions, elapsedLastYear.range],
  );
  const lastYearSum = useMemo(
    () => periodSummary(transactions, elapsedLastYear.compareRange),
    [transactions, elapsedLastYear.compareRange],
  );

  const expensePrevCmp = useMemo(
    () => compareSummary(currentSumForPrev.expense, prevSum.expense),
    [currentSumForPrev.expense, prevSum.expense],
  );
  const expenseLastYearCmp = useMemo(
    () => compareSummary(currentSumForLastYear.expense, lastYearSum.expense),
    [currentSumForLastYear.expense, lastYearSum.expense],
  );

  const incomePrevCmp = useMemo(
    () => compareSummary(currentSumForPrev.income, prevSum.income),
    [currentSumForPrev.income, prevSum.income],
  );
  const incomeLastYearCmp = useMemo(
    () => compareSummary(currentSumForLastYear.income, lastYearSum.income),
    [currentSumForLastYear.income, lastYearSum.income],
  );

  const netPrevCmp = useMemo(
    () => compareSummary(currentSumForPrev.net, prevSum.net),
    [currentSumForPrev.net, prevSum.net],
  );
  const netLastYearCmp = useMemo(
    () => compareSummary(currentSumForLastYear.net, lastYearSum.net),
    [currentSumForLastYear.net, lastYearSum.net],
  );

  const breakdown = useMemo(
    () => categoryBreakdownInRange(transactions, categories, currentRange),
    [transactions, categories, currentRange],
  );

  const totalExpense = useMemo(
    () => breakdown.reduce((sum, item) => sum + item.amount, 0),
    [breakdown],
  );

  const categoryRows = useMemo(
    () =>
      categoryCompare(
        transactions,
        categories,
        elapsedPrev.range,
        elapsedPrev.compareRange,
      ),
    [transactions, categories, elapsedPrev.range, elapsedPrev.compareRange],
  );

  const trend = useMemo(
    () => periodTrend(transactions, periodKind, currentRange, TREND_COUNTS[periodKind]),
    [transactions, periodKind, currentRange],
  );

  const hasTrendData = useMemo(
    () => trend.some((item) => item.income > 0 || item.expense > 0 || item.lastYearExpense > 0),
    [trend],
  );

  function handleSelectKind(kind: PeriodKind) {
    setPeriodKind(kind);
    void saveReportPeriodKind(kind);
  }

  function handleShift(delta: number) {
    const next = shiftPeriod(currentRange, delta);
    setAnchor(next.start);
  }

  function toggleCategory(categoryId: string) {
    setExpandedCategories((prev) => ({
      ...prev,
      [categoryId]: !prev[categoryId],
    }));
  }

  return (
    <div className="space-y-4 pb-24">
      {/* 期間模式分段按鈕：月｜季｜年 */}
      <div
        role="tablist"
        aria-label="報表期間類型"
        className="grid grid-cols-3 rounded-2xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900"
      >
        {PERIOD_TABS.map((tab) => {
          const active = periodKind === tab.kind;
          return (
            <button
              key={tab.kind}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => handleSelectKind(tab.kind)}
              className={`rounded-xl py-2 text-sm font-medium transition-colors ${
                active
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 期間切換列 */}
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => handleShift(-1)}
            aria-label="上一期"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ◀
          </button>
          <div className="flex flex-wrap items-center justify-center gap-2 text-center">
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {currentRange.label}
            </h1>
            {isInProgress && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                進行中
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => handleShift(1)}
            aria-label="下一期"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ▶
          </button>
        </div>
        {isInProgress && (
          <p className="mt-1 text-center text-[11px] text-slate-500 dark:text-slate-400">
            比較到同一天（{elapsedPrev.range.start.slice(5)}–{elapsedPrev.range.end.slice(5)} 對比{' '}
            {elapsedPrev.compareRange.start.slice(5)}–{elapsedPrev.compareRange.end.slice(5)}）
          </p>
        )}
      </div>

      {/* 1. 摘要卡 */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">本期支出</div>
          <div
            className="mt-1 text-xl font-bold tabular-nums"
            style={{ color: amountColors.expense }}
          >
            {formatCurrency(currentSumForPrev.expense)}
          </div>
          {renderCompareLine('比上一期', expensePrevCmp, true, true)}
          {renderCompareLine('比去年同期', expenseLastYearCmp, true, false)}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">本期收入</div>
          <div
            className="mt-1 text-xl font-bold tabular-nums"
            style={{ color: amountColors.income }}
          >
            {formatCurrency(currentSumForPrev.income)}
          </div>
          {renderCompareLine('比上一期', incomePrevCmp, false, true)}
          {renderCompareLine('比去年同期', incomeLastYearCmp, false, false)}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">本期結餘</div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {formatCurrency(currentSumForPrev.net)}
          </div>
          {renderCompareLine('比上一期', netPrevCmp, false, true)}
          {renderCompareLine('比去年同期', netLastYearCmp, false, false)}
        </div>
      </section>

      {/* 2. 支出分類圓餅圖 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">支出分類佔比</h2>
          {totalExpense > 0 && (
            <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">
              總支出 {formatCurrency(totalExpense)}
            </span>
          )}
        </div>

        {breakdown.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            這段期間還沒有支出紀錄
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 sm:items-center">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={breakdown}
                    dataKey="amount"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={84}
                    paddingAngle={2}
                  >
                    {breakdown.map((entry, idx) => (
                      <Cell
                        key={entry.categoryId}
                        fill={PIE_COLORS[idx % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(Number(value ?? 0))} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-2">
              {breakdown.map((item, idx) => (
                <div
                  key={item.categoryId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}
                      aria-hidden="true"
                    />
                    <span className="shrink-0">{item.icon}</span>
                    <span className="truncate font-medium text-slate-800 dark:text-slate-200">
                      {item.name}
                    </span>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrency(item.amount)}
                    </span>
                    <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                      {item.percentage.toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 3. 分類比較表 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">分類比較表</h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            依增減金額排序・不含轉帳
          </span>
        </div>

        {categoryRows.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            尚無可比較的支出分類
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-2 font-medium">分類</th>
                  <th className="py-2 px-2 text-right font-medium">本期</th>
                  <th className="py-2 px-2 text-right font-medium">上一期</th>
                  <th className="py-2 px-2 text-right font-medium">增減金額</th>
                  <th className="py-2 pl-2 text-right font-medium">增減%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {categoryRows.map((row) => {
                  const hasChildren = row.children.length > 0;
                  const isExpanded = Boolean(expandedCategories[row.categoryId]);
                  const deltaClass = getDeltaColorClass(row.diff, true);

                  return (
                    <Fragment key={row.categoryId}>
                      <tr
                        onClick={hasChildren ? () => toggleCategory(row.categoryId) : undefined}
                        className={
                          hasChildren
                            ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60'
                            : undefined
                        }
                      >
                        <td className="py-2.5 pr-2">
                          <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200">
                            {hasChildren ? (
                              <span
                                className="inline-block w-3 text-[10px] text-slate-400"
                                aria-hidden="true"
                              >
                                {isExpanded ? '▾' : '▸'}
                              </span>
                            ) : (
                              <span className="inline-block w-3" aria-hidden="true" />
                            )}
                            <span>{row.icon}</span>
                            <span className="truncate">{row.name}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                          {formatCurrency(row.current)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                          {formatCurrency(row.previous)}
                        </td>
                        <td className={`py-2.5 px-2 text-right font-medium tabular-nums ${deltaClass}`}>
                          {formatSignedCurrency(row.diff)}
                        </td>
                        <td className={`py-2.5 pl-2 text-right font-medium tabular-nums ${deltaClass}`}>
                          {formatPctBadge(row.pct)}
                        </td>
                      </tr>

                      {hasChildren &&
                        isExpanded &&
                        row.children.map((sub) => {
                          const subDeltaClass = getDeltaColorClass(sub.diff, true);
                          return (
                            <tr
                              key={sub.categoryId}
                              className="bg-slate-50/70 dark:bg-slate-800/30"
                            >
                              <td className="py-2 pl-7 pr-2">
                                <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                                  <span>{sub.icon}</span>
                                  <span className="truncate">{sub.name}</span>
                                </div>
                              </td>
                              <td className="py-2 px-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                                {formatCurrency(sub.current)}
                              </td>
                              <td className="py-2 px-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                                {formatCurrency(sub.previous)}
                              </td>
                              <td className={`py-2 px-2 text-right tabular-nums ${subDeltaClass}`}>
                                {formatSignedCurrency(sub.diff)}
                              </td>
                              <td className={`py-2 pl-2 text-right tabular-nums ${subDeltaClass}`}>
                                {formatPctBadge(sub.pct)}
                              </td>
                            </tr>
                          );
                        })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. 趨勢長條圖 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {TREND_TITLES[periodKind]}
          </h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">不含轉帳</span>
        </div>

        {!hasTrendData ? (
          <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            這段期間還沒有紀錄
          </div>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="shortLabel"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                />
                <Tooltip
                  labelFormatter={(_, payload) => {
                    const item = payload?.[0]?.payload as { label?: string } | undefined;
                    return item?.label ?? '';
                  }}
                  formatter={(value) => formatCurrency(Number(value ?? 0))}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar
                  dataKey="income"
                  name="收入"
                  fill={amountColors.income}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="expense"
                  name="支出"
                  fill={amountColors.expense}
                  radius={[4, 4, 0, 0]}
                />
                <Line
                  type="monotone"
                  dataKey="lastYearExpense"
                  name="去年同期支出"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={{ r: 2.5, fill: '#94a3b8' }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}
