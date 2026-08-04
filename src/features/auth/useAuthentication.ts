import { useEffect, useMemo, useState } from "react";

import {
  changeBackendPassword,
  clearStoredAuthToken,
  createBackendUser,
  fetchCurrentAccount,
  logoutBackend,
  resetBackendUserPassword,
  setBackendUserActive,
  signInBackend,
  updateBackendPinnedProjects,
  updateBackendProfile,
  updateBackendUser,
  type AuthResult,
  type AuthUser,
} from "../../services/backendApi";
import { mergeUsers } from "../workspace/workspaceUtils";

type ShowToast = (message: string, type?: "success" | "error" | "info") => void;

export function useAuthentication(showToast: ShowToast) {
  const [account, setAccount] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaceAccounts, setWorkspaceAccounts] = useState<AuthUser[]>([]);

  useEffect(() => {
    let mounted = true;
    void fetchCurrentAccount()
      .then((sessionAccount) => {
        if (!mounted) return;
        setAccount(sessionAccount);
        setWorkspaceAccounts([sessionAccount]);
      })
      .catch(() => {
        if (!mounted) return;
        clearStoredAuthToken();
        setAccount(null);
      })
      .finally(() => {
        if (mounted) setAuthLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const workspaceUsers = useMemo(() => {
    if (!account) return workspaceAccounts;
    const byId = new Map([...workspaceAccounts, account].map((user) => [user.id, user]));
    return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
  }, [account, workspaceAccounts]);

  async function handleSignIn(email: string, password: string): Promise<AuthResult> {
    const result = await signInBackend(email, password);
    if (result.ok) {
      setAccount(result.account);
      setWorkspaceAccounts((current) => mergeUsers([result.account], current));
      showToast("Signed in.");
    }
    return result;
  }

  async function handleLogout() {
    await logoutBackend();
    setAccount(null);
    showToast("Signed out.");
  }

  async function handleUpdateProfile(
    updates: Pick<AuthUser, "name" | "avatarColor"> & { profileImageUrl?: string },
  ): Promise<AuthResult> {
    if (!account) return { ok: false, error: "Sign in first." };
    const result = await updateBackendProfile(updates);
    if (result.ok) {
      setAccount(result.account);
      setWorkspaceAccounts((current) => mergeUsers([result.account], current));
      showToast("Profile saved.");
    }
    return result;
  }

  async function handleToggleProjectPin(projectId: string) {
    if (!account) return;
    const currentPins = account.pinnedProjectIds ?? [];
    const nextPins = currentPins.includes(projectId)
      ? currentPins.filter((item) => item !== projectId)
      : [projectId, ...currentPins];
    const optimisticAccount = { ...account, pinnedProjectIds: nextPins };
    setAccount(optimisticAccount);
    setWorkspaceAccounts((current) => mergeUsers([optimisticAccount], current));

    const result = await updateBackendPinnedProjects(nextPins);
    if (result.ok) {
      setAccount(result.account);
      setWorkspaceAccounts((current) => mergeUsers([result.account], current));
      showToast(nextPins.includes(projectId) ? "Project pinned." : "Project unpinned.");
      return;
    }
    setAccount(account);
    setWorkspaceAccounts((current) => mergeUsers([account], current));
    showToast(result.error, "error");
  }

  async function handleChangePassword(
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<AuthResult> {
    if (!account) return { ok: false, error: "Sign in first." };
    const result = await changeBackendPassword(currentPassword, newPassword, confirmPassword);
    if (result.ok) {
      setAccount(null);
      showToast("Password changed. Sign in again.");
    }
    return result;
  }

  async function handleCreateUser(payload: {
    name: string;
    email: string;
    username?: string;
    password: string;
    role: "admin" | "user";
    active?: boolean;
  }) {
    const user = await createBackendUser(payload);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    showToast("User created.");
    return user;
  }

  async function handleUpdateUser(
    userId: string,
    payload: Partial<Pick<AuthUser, "name" | "email" | "role" | "active" | "avatarColor">>,
  ) {
    const user = await updateBackendUser(userId, payload);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    if (account?.id === user.id) setAccount(user);
    showToast("User saved.");
    return user;
  }

  async function handleResetUserPassword(userId: string, password: string, confirmPassword: string) {
    const user = await resetBackendUserPassword(userId, password, confirmPassword);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    showToast("Password reset.");
    return user;
  }

  async function handleToggleUserActive(userId: string, active: boolean) {
    const user = await setBackendUserActive(userId, active);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    showToast(active ? "User enabled." : "User disabled.");
    return user;
  }

  return {
    account,
    setAccount,
    authLoading,
    workspaceAccounts,
    setWorkspaceAccounts,
    workspaceUsers,
    handleSignIn,
    handleLogout,
    handleUpdateProfile,
    handleToggleProjectPin,
    handleChangePassword,
    handleCreateUser,
    handleUpdateUser,
    handleResetUserPassword,
    handleToggleUserActive,
  };
}
