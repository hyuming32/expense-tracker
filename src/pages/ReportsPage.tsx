import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Category, Transaction } from '../db/types';
import {
  categoryBreakdown,
  formatCurrency,
  formatMonthLabel,
  getCurrentMonthString,
  monthlyTrend,
  shiftMonth,
} from '../domain';

interface ReportsPageProps {
  transactions: readonly Transaction[];
  categories: readonly Category[];
}

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

function formatShortMonth(monthStr: string): string {
  const [, month] = monthStr.split('-');
  return `${Number(month ?? 1)}月`;
}

export function ReportsPage({ transactions, categories }: ReportsPageProps) {
  const [month, setMonth] = useState(getCurrentMonthString);

  const breakdown = useMemo(
    () => categoryBreakdown(transactions, categories, month),
    [transactions, categories, month],
  );

  const trend = useMemo(() => monthlyTrend(transactions, month, 12), [transactions, month]);

  const totalExpense = useMemo(
    () => breakdown.reduce((sum, item) => sum + item.amount, 0),
    [breakdown],
  );

  const hasTrendData = useMemo(
    () => trend.some((item) => item.income > 0 || item.expense > 0),
    [trend],
  );

  return (
    <div className="space-y-4 pb-24">
      {/* 月份切換列 */}
      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          aria-label="上個月"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          ◀
        </button>
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {formatMonthLabel(month)}報表
        </h1>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          aria-label="下個月"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          ▶
        </button>
      </div>

      {/* 支出分類圓餅圖 */}
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
            這個月還沒有紀錄
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
                  <Tooltip
                    formatter={(value) => formatCurrency(Number(value ?? 0))}
                  />
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

      {/* 近 12 個月收支長條圖 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            近 12 個月收支趨勢
          </h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">不含轉帳</span>
        </div>

        {!hasTrendData ? (
          <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            這個月還沒有紀錄
          </div>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="month"
                  tickFormatter={formatShortMonth}
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
                  labelFormatter={(label) => formatMonthLabel(String(label))}
                  formatter={(value) => formatCurrency(Number(value ?? 0))}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="income" name="收入" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expense" name="支出" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}
