interface AmountCalculatorKeypadProps {
  onToken: (token: string) => void;
  onEvaluate: () => void;
  onDone: () => void;
  allowDecimal?: boolean;
}

interface KeypadButton {
  label: string;
  value: string;
  variant: 'digit' | 'operator' | 'action' | 'equal' | 'done';
  colSpan?: number;
}

const BASE_TOP_BUTTONS: ReadonlyArray<KeypadButton> = [
  { label: 'C', value: 'C', variant: 'action' },
  { label: '÷', value: '÷', variant: 'operator' },
  { label: '×', value: '×', variant: 'operator' },
  { label: '⌫', value: '⌫', variant: 'action' },
  { label: '7', value: '7', variant: 'digit' },
  { label: '8', value: '8', variant: 'digit' },
  { label: '9', value: '9', variant: 'digit' },
  { label: '−', value: '−', variant: 'operator' },
  { label: '4', value: '4', variant: 'digit' },
  { label: '5', value: '5', variant: 'digit' },
  { label: '6', value: '6', variant: 'digit' },
  { label: '＋', value: '＋', variant: 'operator' },
  { label: '1', value: '1', variant: 'digit' },
  { label: '2', value: '2', variant: 'digit' },
  { label: '3', value: '3', variant: 'digit' },
  { label: '=', value: '=', variant: 'equal' },
];

const INTEGER_BOTTOM_BUTTONS: ReadonlyArray<KeypadButton> = [
  { label: '0', value: '0', variant: 'digit' },
  { label: '00', value: '00', variant: 'digit' },
  { label: '完成', value: 'DONE', variant: 'done', colSpan: 2 },
];

const DECIMAL_BOTTOM_BUTTONS: ReadonlyArray<KeypadButton> = [
  { label: '0', value: '0', variant: 'digit' },
  { label: '.', value: '.', variant: 'digit' },
  { label: '00', value: '00', variant: 'digit' },
  { label: '完成', value: 'DONE', variant: 'done' },
];

const VARIANT_CLASSES: Record<
  'digit' | 'operator' | 'action' | 'equal' | 'done',
  string
> = {
  digit:
    'bg-white text-slate-900 border border-slate-200 hover:bg-slate-50 active:bg-slate-100 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-700',
  operator:
    'bg-slate-100 text-slate-800 border border-slate-200 font-semibold hover:bg-slate-200 active:bg-slate-300 dark:bg-slate-700/80 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-700',
  action:
    'bg-slate-100 text-slate-600 border border-slate-200 font-medium hover:bg-slate-200 active:bg-slate-300 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700',
  equal:
    'bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold hover:bg-emerald-100 active:bg-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-900/60',
  done:
    'bg-emerald-600 text-white font-semibold hover:bg-emerald-700 active:bg-emerald-800 dark:bg-emerald-500 dark:hover:bg-emerald-600',
};

/**
 * 記帳金額專用計算機鍵盤（避免在手機上跳出系統虛擬鍵盤）。
 */
export function AmountCalculatorKeypad({
  onToken,
  onEvaluate,
  onDone,
  allowDecimal = false,
}: AmountCalculatorKeypadProps) {
  const buttons = allowDecimal
    ? [...BASE_TOP_BUTTONS, ...DECIMAL_BOTTOM_BUTTONS]
    : [...BASE_TOP_BUTTONS, ...INTEGER_BOTTOM_BUTTONS];

  return (
    <div
      className="mt-2 grid grid-cols-4 gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/80"
      role="group"
      aria-label="金額計算機鍵盤"
    >
      {buttons.map((btn) => (
        <button
          key={btn.label}
          type="button"
          onClick={() => {
            if (btn.value === '=') {
              onEvaluate();
            } else if (btn.value === 'DONE') {
              onDone();
            } else {
              onToken(btn.value);
            }
          }}
          className={`flex h-11 items-center justify-center rounded-lg text-base transition-colors select-none ${
            btn.colSpan === 2 ? 'col-span-2' : ''
          } ${VARIANT_CLASSES[btn.variant]}`}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}
