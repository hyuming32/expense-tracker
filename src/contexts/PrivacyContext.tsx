import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { setHideAmountsDefault as persistHideAmountsDefault } from '../db/repository';
import { formatDisplayCurrency } from '../domain';

interface PrivacyContextValue {
  hideAmounts: boolean;
  defaultHideAmounts: boolean;
  setHideAmounts: (hide: boolean) => void;
  toggleHideAmounts: () => void;
  setDefaultHideAmounts: (enabled: boolean) => Promise<void>;
}

const PrivacyContext = createContext<PrivacyContextValue>({
  hideAmounts: false,
  defaultHideAmounts: false,
  setHideAmounts: () => {},
  toggleHideAmounts: () => {},
  setDefaultHideAmounts: async () => {},
});

interface PrivacyProviderProps {
  initialDefault: boolean | undefined;
  children: ReactNode;
}

/**
 * 提供全域「隱藏金額」狀態與切換方法的 Context Provider。
 */
export function PrivacyProvider({ initialDefault, children }: PrivacyProviderProps) {
  const [hideAmounts, setHideAmounts] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!initializedRef.current && initialDefault !== undefined) {
      initializedRef.current = true;
      setHideAmounts(initialDefault);
    }
  }, [initialDefault]);

  const toggleHideAmounts = useCallback(() => {
    setHideAmounts((prev) => !prev);
  }, []);

  const setDefaultHideAmounts = useCallback(async (enabled: boolean) => {
    await persistHideAmountsDefault(enabled);
    setHideAmounts(enabled);
  }, []);

  return (
    <PrivacyContext.Provider
      value={{
        hideAmounts,
        defaultHideAmounts: initialDefault ?? false,
        setHideAmounts,
        toggleHideAmounts,
        setDefaultHideAmounts,
      }}
    >
      {children}
    </PrivacyContext.Provider>
  );
}

/**
 * 取得隱藏金額狀態與控制函式。
 */
export function usePrivacy(): PrivacyContextValue {
  return useContext(PrivacyContext);
}

/**
 * 回傳依目前隱私狀態格式化金額的函式（隱藏時顯示「NT$ ••••」）。
 */
export function useMoney(): (amount: number) => string {
  const { hideAmounts } = usePrivacy();
  return useCallback(
    (amount: number) => formatDisplayCurrency(amount, hideAmounts),
    [hideAmounts],
  );
}

/**
 * 顯示格式化金額的元件，當開啟隱藏金額時自動遮罩為「NT$ ••••」。
 */
export function Money({ amount }: { amount: number }) {
  const formatMoney = useMoney();
  return <>{formatMoney(amount)}</>;
}
