import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMoney } from '../contexts/PrivacyContext';
import { db, ExpenseDatabase, FAMILY_DB_NAME } from '../db/database';
import type { Member, Transaction } from '../db/types';
import {
  getActiveLedger,
  getFamilyConfig,
  isFamilyReadOnly,
  setActiveLedger,
} from '../family/familyConfig';
import {
  createFamilyLedger,
  discardFamilyLedger,
  type FamilySyncState,
  getMembers,
  inviteMember,
  joinFamilyLedger,
  removeMember,
  triggerFamilySync,
  updateMyProfile,
  useFamilySyncState,
} from '../family/familyManager';
import { DriveAuthCancelledError } from '../sync/auth';
import { formatSyncTimeLabel } from '../sync/syncManager';

export const FAMILY_MEMBER_COLOR_PALETTE = [
  '#2563EB', // 寶藍
  '#10B981', // 翠綠
  '#F59E0B', // 琥珀
  '#E11D48', // 玫紅
  '#8B5CF6', // 紫羅蘭
  '#EC4899', // 粉紅
  '#0EA5E9', // 天藍
  '#8B5E3C', // 暖棕
] as const;

interface FamilyLedgerSectionProps {
  isFamilyMode?: boolean;
  members?: readonly Member[];
}

function formatFamilySyncStatusText(syncState: FamilySyncState): string {
  switch (syncState.status) {
    case 'idle':
      return syncState.lastSyncAt
        ? `上次同步 · ${formatSyncTimeLabel(syncState.lastSyncAt)}`
        : '待同步';
    case 'syncing':
      return '同步中…';
    case 'synced':
      return syncState.lastSyncAt
        ? `已同步 · ${formatSyncTimeLabel(syncState.lastSyncAt)}`
        : '已同步';
    case 'offline':
      return '離線，恢復網路後自動同步';
    case 'reauth':
      return '需要重新授權';
    case 'error':
      return syncState.errorMessage ? `同步失敗：${syncState.errorMessage}` : '同步失敗';
    case 'removed':
      return '已被移出家庭帳本';
  }
}

function ColorSwatchPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (color: string) => void;
  label: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">{label}</div>
      <div className="flex flex-wrap gap-2">
        {FAMILY_MEMBER_COLOR_PALETTE.map((swatch) => {
          const selected = value.toUpperCase() === swatch.toUpperCase();
          return (
            <button
              key={swatch}
              type="button"
              onClick={() => onChange(swatch)}
              aria-label={`選擇顏色 ${swatch}`}
              aria-pressed={selected}
              className={`h-7 w-7 rounded-full border-2 transition-transform ${
                selected
                  ? 'scale-110 border-slate-900 ring-2 ring-emerald-500/40 dark:border-white'
                  : 'border-white shadow-sm hover:scale-105 dark:border-slate-800'
              }`}
              style={{ backgroundColor: swatch }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * 設定頁「家庭帳本」管理區塊（建立、加入、成員管理、個人資料、同步與最近刪除）。
 */
export function FamilyLedgerSection({
  isFamilyMode = getActiveLedger() === 'family',
  members: propMembers,
}: FamilyLedgerSectionProps) {
  const formatMoney = useMoney();
  const familySyncState = useFamilySyncState();

  const familyConfig = getFamilyConfig();
  const readOnly = isFamilyReadOnly();

  // 非家庭模式下（例如已加入家庭帳本但切回個人帳本檢視設定）需另外讀取家庭資料庫的成員與已刪除交易
  const [standaloneMembers, setStandaloneMembers] = useState<Member[]>([]);
  const [standaloneDeletedTxs, setStandaloneDeletedTxs] = useState<Transaction[]>([]);

  const loadStandaloneFamilyData = useCallback(async () => {
    if (isFamilyMode || !familyConfig) {
      return;
    }
    const famDb = new ExpenseDatabase(FAMILY_DB_NAME);
    try {
      const [loadedMembers, allTxs] = await Promise.all([
        getMembers(famDb),
        famDb.transactions.toArray(),
      ]);
      setStandaloneMembers(loadedMembers);
      setStandaloneDeletedTxs(
        allTxs
          .filter((t) => t.deleted)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 30),
      );
    } finally {
      famDb.close();
    }
  }, [isFamilyMode, familyConfig?.fileId]);

  useEffect(() => {
    void loadStandaloneFamilyData();
  }, [loadStandaloneFamilyData]);

  const liveDeletedTxs =
    useLiveQuery(async () => {
      if (!isFamilyMode || !familyConfig) {
        return [] as Transaction[];
      }
      const rows = await db.transactions.toArray();
      return rows
        .filter((t) => t.deleted)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 30);
    }, [isFamilyMode, familyConfig?.fileId]) ?? [];

  const members = useMemo(
    () => (isFamilyMode ? (propMembers ?? []) : standaloneMembers),
    [isFamilyMode, propMembers, standaloneMembers],
  );
  const deletedTxs = isFamilyMode ? liveDeletedTxs : standaloneDeletedTxs;

  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const myMember = familyConfig ? memberMap.get(familyConfig.memberId) : undefined;

  // 未設定時建立／加入表單狀態
  const [setupMode, setSetupMode] = useState<'idle' | 'create' | 'join'>('idle');
  const [ledgerNameInput, setLedgerNameInput] = useState('我們家');
  const [myNameInput, setMyNameInput] = useState('');
  const [myColorInput, setMyColorInput] = useState<string>(FAMILY_MEMBER_COLOR_PALETTE[0]);

  // 已設定時編輯個人資料、邀請、移除與捨棄副本狀態
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileColor, setProfileColor] = useState<string>(FAMILY_MEMBER_COLOR_PALETTE[0]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [confirmingRemoveMember, setConfirmingRemoveMember] = useState<Member | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (myMember && !editingProfile) {
      setProfileName(myMember.name);
      setProfileColor(myMember.color);
    }
  }, [myMember, editingProfile]);

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await createFamilyLedger({
        ledgerName: ledgerNameInput,
        myName: myNameInput,
        color: myColorInput,
      });
      setActiveLedger('family');
      window.location.reload();
    } catch (err) {
      if (err instanceof DriveAuthCancelledError) {
        setSetupMode('idle');
      } else {
        setErrorMessage(err instanceof Error ? err.message : '建立家庭帳本失敗');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await joinFamilyLedger({
        myName: myNameInput,
        color: myColorInput,
      });
      setActiveLedger('family');
      window.location.reload();
    } catch (err) {
      if (err instanceof DriveAuthCancelledError) {
        setSetupMode('idle');
      } else {
        setErrorMessage(err instanceof Error ? err.message : '加入家庭帳本失敗');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await updateMyProfile({
        name: profileName,
        color: profileColor,
      });
      setEditingProfile(false);
      setStatusMessage('已更新我的名字與代表色');
      await loadStandaloneFamilyData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '更新個人資料失敗');
    } finally {
      setBusy(false);
    }
  }

  async function handleInviteSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await inviteMember(inviteEmail);
      setInviteEmail('');
      setStatusMessage('已寄出邀請，請對方打開 App → 設定 → 家庭帳本 → 加入');
    } catch (err) {
      if (!(err instanceof DriveAuthCancelledError)) {
        setErrorMessage(err instanceof Error ? err.message : '寄送邀請失敗');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmRemove() {
    if (!confirmingRemoveMember || busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await removeMember(confirmingRemoveMember.id);
      setStatusMessage(`已移出成員「${confirmingRemoveMember.name}」`);
      setConfirmingRemoveMember(null);
      await loadStandaloneFamilyData();
    } catch (err) {
      if (!(err instanceof DriveAuthCancelledError)) {
        setErrorMessage(err instanceof Error ? err.message : '移出成員失敗');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmDiscard() {
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      await discardFamilyLedger();
      window.location.reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '刪除本機副本失敗');
      setBusy(false);
    }
  }

  function openSetupMode(nextMode: 'create' | 'join') {
    setSetupMode(nextMode);
    setErrorMessage(null);
    setStatusMessage(null);
    if (nextMode === 'create') {
      setLedgerNameInput('我們家');
      setMyColorInput(FAMILY_MEMBER_COLOR_PALETTE[0]);
    } else {
      setMyColorInput(FAMILY_MEMBER_COLOR_PALETTE[1]);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">家庭帳本</h2>
          {familyConfig && (
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {familyConfig.ledgerName}
            </span>
          )}
        </div>

        {familyConfig && !isFamilyMode && (
          <button
            type="button"
            onClick={() => {
              setActiveLedger('family');
              window.location.reload();
            }}
            className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            切換到家庭帳本
          </button>
        )}
      </div>

      {statusMessage && (
        <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200">
          {errorMessage}
        </div>
      )}

      {!familyConfig ? (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            和家人用各自的 Google 帳號共用一本帳，資料存在建立者的 Google 雲端
          </p>

          {setupMode === 'idle' && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openSetupMode('create')}
                className="rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-700"
              >
                建立家庭帳本
              </button>
              <button
                type="button"
                onClick={() => openSetupMode('join')}
                className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                加入家庭帳本
              </button>
            </div>
          )}

          {setupMode === 'create' && (
            <form
              onSubmit={(e) => void handleCreateSubmit(e)}
              className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/60"
            >
              <div>
                <label
                  htmlFor="family-ledger-name"
                  className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
                >
                  帳本名稱
                </label>
                <input
                  id="family-ledger-name"
                  type="text"
                  value={ledgerNameInput}
                  onChange={(e) => setLedgerNameInput(e.target.value)}
                  placeholder="我們家"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="family-create-my-name"
                  className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
                >
                  我的名字
                </label>
                <input
                  id="family-create-my-name"
                  type="text"
                  value={myNameInput}
                  onChange={(e) => setMyNameInput(e.target.value)}
                  placeholder="例如：爸爸、媽媽"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>

              <ColorSwatchPicker
                label="我的代表色"
                value={myColorInput}
                onChange={setMyColorInput}
              />

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSetupMode('idle');
                    setErrorMessage(null);
                  }}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? '建立中…' : '建立並切換'}
                </button>
              </div>
            </form>
          )}

          {setupMode === 'join' && (
            <form
              onSubmit={(e) => void handleJoinSubmit(e)}
              className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/60"
            >
              <div>
                <label
                  htmlFor="family-join-my-name"
                  className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
                >
                  我的名字
                </label>
                <input
                  id="family-join-my-name"
                  type="text"
                  value={myNameInput}
                  onChange={(e) => setMyNameInput(e.target.value)}
                  placeholder="例如：媽媽"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>

              <ColorSwatchPicker
                label="我的代表色"
                value={myColorInput}
                onChange={setMyColorInput}
              />

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSetupMode('idle');
                    setErrorMessage(null);
                  }}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? '加入中…' : '加入家庭帳本'}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* 被移出唯讀警示與刪除副本 */}
          {readOnly && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/70 dark:bg-amber-950/40">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                  你已被移出家庭帳本，這裡是唯讀副本
                </p>
                {!confirmingDiscard && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmingDiscard(true)}
                    className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-slate-900 dark:text-red-400"
                  >
                    刪除這份副本
                  </button>
                )}
              </div>
              {confirmingDiscard && (
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-amber-200/70 pt-2 dark:border-amber-800/60">
                  <span className="text-xs text-amber-800 dark:text-amber-300">
                    刪除後會清除本機家庭帳本資料並切回個人帳本。
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmingDiscard(false)}
                      className="rounded-lg px-2.5 py-1 text-xs text-slate-600 hover:bg-amber-100 dark:text-slate-300 dark:hover:bg-amber-900/40"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleConfirmDiscard()}
                      className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {busy ? '刪除中…' : '確認刪除'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 同步狀態（家庭模式且非唯讀時顯示控制按鈕） */}
          {isFamilyMode && !readOnly && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/50">
              <div className="min-w-0 space-y-0.5 text-xs">
                <div className="font-medium text-slate-700 dark:text-slate-200">
                  同步狀態：{formatFamilySyncStatusText(familySyncState)}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  上次同步：
                  {familySyncState.lastSyncAt
                    ? formatSyncTimeLabel(familySyncState.lastSyncAt)
                    : '尚未同步'}
                </div>
              </div>
              <button
                type="button"
                disabled={familySyncState.status === 'syncing'}
                onClick={() => void triggerFamilySync({ interactive: true })}
                className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                  familySyncState.status === 'reauth'
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : familySyncState.status === 'error'
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {familySyncState.status === 'reauth'
                  ? '重新授權'
                  : familySyncState.status === 'syncing'
                    ? '同步中…'
                    : '立即同步'}
              </button>
            </div>
          )}

          {/* 我的名字與代表色 */}
          <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="font-medium text-slate-500 dark:text-slate-400">我的身分</span>
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: myMember?.color ?? FAMILY_MEMBER_COLOR_PALETTE[0] }}
                  aria-hidden="true"
                />
                <span className="truncate font-semibold text-slate-900 dark:text-slate-100">
                  {myMember?.name ?? familyConfig.email}
                </span>
              </div>
              {!readOnly && !editingProfile && (
                <button
                  type="button"
                  onClick={() => {
                    setProfileName(myMember?.name ?? '');
                    setProfileColor(myMember?.color ?? FAMILY_MEMBER_COLOR_PALETTE[0]);
                    setEditingProfile(true);
                    setErrorMessage(null);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  編輯
                </button>
              )}
            </div>

            {editingProfile && (
              <form
                onSubmit={(e) => void handleSaveProfile(e)}
                className="mt-3 space-y-3 border-t border-slate-200/70 pt-3 dark:border-slate-700"
              >
                <div>
                  <label
                    htmlFor="family-edit-my-name"
                    className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
                  >
                    我的名字
                  </label>
                  <input
                    id="family-edit-my-name"
                    type="text"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
                <ColorSwatchPicker
                  label="代表色"
                  value={profileColor}
                  onChange={setProfileColor}
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditingProfile(false)}
                    className="rounded-lg px-3 py-1 text-xs text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-700"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    儲存
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* 成員清單 */}
          <div>
            <h3 className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
              成員清單（{members.length}）
            </h3>
            {members.length === 0 ? (
              <div className="rounded-xl border border-slate-100 px-3 py-4 text-center text-xs text-slate-400 dark:border-slate-800">
                尚無成員資料
              </div>
            ) : (
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                {members.map((member) => {
                  const canRemove =
                    familyConfig.role === 'owner' &&
                    !readOnly &&
                    member.id !== familyConfig.memberId &&
                    !member.removed;

                  return (
                    <div
                      key={member.id}
                      className={`flex items-center justify-between gap-2 px-3 py-2.5 ${
                        member.removed ? 'opacity-50' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: member.color }}
                            aria-hidden="true"
                          />
                          <span className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                            {member.name}
                          </span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            {member.role === 'owner' ? '建立者' : '成員'}
                          </span>
                          {member.removed && (
                            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                              已移出
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                          {member.email}
                        </div>
                      </div>

                      {canRemove && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmingRemoveMember(member)}
                          className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                        >
                          移出
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {confirmingRemoveMember && (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                  確定要移出「{confirmingRemoveMember.name}」嗎？
                </div>
                <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                  對方將失去雲端檔案存取權限，其本機帳本會變為唯讀副本。
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmingRemoveMember(null)}
                    className="rounded-lg px-2.5 py-1 text-xs text-slate-700 hover:bg-amber-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleConfirmRemove()}
                    className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy ? '處理中…' : '確認移出'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 邀請家人（僅建立者且非唯讀時顯示） */}
          {familyConfig.role === 'owner' && !readOnly && (
            <form
              onSubmit={(e) => void handleInviteSubmit(e)}
              className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800"
            >
              <label
                htmlFor="family-invite-email"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-200"
              >
                邀請家人
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="family-invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="輸入家人的 Gmail"
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 outline-none focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={busy || !inviteEmail.trim()}
                  className="shrink-0 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? '邀請中…' : '邀請'}
                </button>
              </div>
            </form>
          )}

          {/* 最近刪除（所有人皆可檢視） */}
          <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                最近刪除（{deletedTxs.length}）
              </h3>
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                依刪除時間由新到舊，最多 30 筆
              </span>
            </div>

            {deletedTxs.length === 0 ? (
              <div className="rounded-xl border border-slate-100 px-3 py-4 text-center text-xs text-slate-400 dark:border-slate-800">
                目前沒有最近刪除的紀錄
              </div>
            ) : (
              <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                {deletedTxs.map((tx) => {
                  const deleterName = tx.lastEditedBy
                    ? (memberMap.get(tx.lastEditedBy)?.name ?? '家人')
                    : '未知';
                  return (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-800 dark:text-slate-200">
                          {tx.date} · {tx.note?.trim() || '（無備註）'}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          由 {deleterName} 於 {formatSyncTimeLabel(tx.updatedAt)} 刪除
                        </div>
                      </div>
                      <div className="shrink-0 font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                        {formatMoney(tx.amount)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
