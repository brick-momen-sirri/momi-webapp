import { ChangeEvent, FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Camera,
  Check,
  Coins,
  ImageIcon,
  KeyRound,
  LogOut,
  Palette,
  Settings,
  ShieldCheck,
  UserPlus,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import type { Job } from "../types";
import type { AuthResult, AuthUser } from "../services/backendApi";
import { ThemeToggle, type ThemeMode } from "./ThemeToggle";

type AccountPanelProps = {
  account: AuthUser;
  users: AuthUser[];
  jobs: Job[];
  creditsRemaining: number;
  monthlyCreditsSpent: number;
  monthlyJobsCompleted: number;
  onUpdateProfile: (
    updates: Pick<AuthUser, "name" | "avatarColor"> & { profileImageUrl?: string },
  ) => Promise<AuthResult>;
  onChangePassword: (
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ) => Promise<AuthResult>;
  onCreateUser: (payload: {
    name: string;
    email: string;
    username?: string;
    password: string;
    role: "admin" | "user";
    active?: boolean;
  }) => Promise<AuthUser>;
  onUpdateUser: (
    userId: string,
    payload: Partial<Pick<AuthUser, "name" | "email" | "role" | "active" | "avatarColor">>,
  ) => Promise<AuthUser>;
  onResetUserPassword: (userId: string, password: string, confirmPassword: string) => Promise<AuthUser>;
  onToggleUserActive: (userId: string, active: boolean) => Promise<AuthUser>;
  onLogout: () => void;
  theme: ThemeMode;
  onThemeToggle: () => void;
};

const avatarColors = ["#11b8a5", "#ff6b35", "#4f46e5", "#0f766e", "#be123c", "#ca8a04"];

export function AccountPanel({
  account,
  users,
  jobs,
  creditsRemaining,
  monthlyCreditsSpent,
  monthlyJobsCompleted,
  onUpdateProfile,
  onChangePassword,
  onCreateUser,
  onUpdateUser,
  onResetUserPassword,
  onToggleUserActive,
  onLogout,
  theme,
  onThemeToggle,
}: AccountPanelProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="flex items-center gap-3">
        <Avatar account={account} size="large" />
        <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-5">{account.name}</p>
            <p className="truncate text-xs text-stone-500">{account.email}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-stone-500">
              <span className="inline-flex items-center gap-1">
                <WalletCards className="h-3 w-3" />
                {formatCredits(creditsRemaining)} left
              </span>
              <span className="inline-flex items-center gap-1">
                <Coins className="h-3 w-3" />
                {formatCredits(monthlyCreditsSpent)} this month
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <ThemeToggle theme={theme} onToggle={onThemeToggle} />
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="theme-toggle flex h-7 w-7 items-center justify-center rounded-md border border-line bg-white text-stone-500 transition hover:border-accent hover:bg-stone-50 hover:text-accent"
              title="Profile settings"
              aria-label="Profile settings"
            >
              <Settings className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="theme-toggle flex h-7 w-7 items-center justify-center rounded-md border border-line bg-white text-stone-500 transition hover:border-red-300 hover:bg-red-50 hover:text-red-600"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {isModalOpen ? (
        <ProfileSettingsModal
          account={account}
          jobs={jobs}
          creditsRemaining={creditsRemaining}
          monthlyCreditsSpent={monthlyCreditsSpent}
          monthlyJobsCompleted={monthlyJobsCompleted}
          users={users}
          onClose={() => setIsModalOpen(false)}
          onUpdateProfile={onUpdateProfile}
          onChangePassword={onChangePassword}
          onCreateUser={onCreateUser}
          onUpdateUser={onUpdateUser}
          onResetUserPassword={onResetUserPassword}
          onToggleUserActive={onToggleUserActive}
        />
      ) : null}
    </section>
  );
}

function ProfileSettingsModal({
  account,
  jobs,
  creditsRemaining,
  monthlyCreditsSpent,
  monthlyJobsCompleted,
  users,
  onClose,
  onUpdateProfile,
  onChangePassword,
  onCreateUser,
  onUpdateUser,
  onResetUserPassword,
  onToggleUserActive,
}: {
  account: AuthUser;
  jobs: Job[];
  creditsRemaining: number;
  monthlyCreditsSpent: number;
  monthlyJobsCompleted: number;
  users: AuthUser[];
  onClose: () => void;
  onUpdateProfile: AccountPanelProps["onUpdateProfile"];
  onChangePassword: AccountPanelProps["onChangePassword"];
  onCreateUser: AccountPanelProps["onCreateUser"];
  onUpdateUser: AccountPanelProps["onUpdateUser"];
  onResetUserPassword: AccountPanelProps["onResetUserPassword"];
  onToggleUserActive: AccountPanelProps["onToggleUserActive"];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(account.name);
  const [avatarColor, setAvatarColor] = useState(account.avatarColor);
  const [profileImageUrl, setProfileImageUrl] = useState(account.profileImageUrl);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");

  const stats = useMemo(() => {
    const userJobs = jobs.filter((job) => job.userId === account.id);
    return {
      total: userJobs.length,
      creditsUsed: userJobs.reduce((sum, job) => sum + (job.creditsUsed ?? 0), 0),
    };
  }, [account.id, jobs]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleProfileSubmit(event: FormEvent) {
    event.preventDefault();
    setProfileMessage("");
    const result = await onUpdateProfile({ name, avatarColor, profileImageUrl });
    setProfileMessage(result.ok ? "Profile saved." : result.error);
  }

  async function handlePasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setPasswordMessage("");
    const result = await onChangePassword(currentPassword, newPassword, confirmPassword);

    if (result.ok) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage("Password changed.");
      return;
    }

    setPasswordMessage(result.error);
  }

  function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setProfileImageUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  function handleOverlayMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-stone-950/50 p-3"
      onMouseDown={handleOverlayMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-settings-title"
    >
      <div className="relative z-[1010] max-h-[92vh] w-full max-w-4xl overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white px-4 py-3">
          <div>
            <h2 id="profile-settings-title" className="text-base font-bold">
              Profile settings
            </h2>
            <p className="mt-0.5 text-xs text-stone-500">Manage account details and password.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <form onSubmit={handleProfileSubmit} className="rounded-lg border border-line bg-mist/40 p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <UserRound className="h-3.5 w-3.5" />
              Profile
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <Avatar account={{ ...account, name, avatarColor, profileImageUrl }} size="large" />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-600 transition hover:bg-stone-50"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Change picture
                  </button>
                  <button
                    type="button"
                    onClick={() => setProfileImageUrl(undefined)}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-600 transition hover:bg-stone-50"
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                    Remove picture
                  </button>
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />

                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-stone-500">Display name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="h-9 w-full rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                </label>

                <div>
                  <p className="mb-1 text-xs font-semibold text-stone-500">Email</p>
                  <p className="rounded-md border border-line bg-white px-3 py-2 text-sm text-stone-600">{account.email}</p>
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-stone-500">
                    <Palette className="h-3.5 w-3.5" />
                    Account icon color
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {avatarColors.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setAvatarColor(color)}
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-line"
                        style={{ backgroundColor: color }}
                        title={`Use ${color}`}
                      >
                        {avatarColor === color ? <Check className="h-4 w-4 text-white" /> : null}
                      </button>
                    ))}
                  </div>
                </div>

                {profileMessage ? <p className="text-xs font-semibold text-stone-600">{profileMessage}</p> : null}
              </div>
            </div>

            <div className="mt-3 flex justify-end">
              <button
                type="submit"
                className="h-9 rounded-md bg-ink px-4 text-xs font-bold text-white transition hover:bg-stone-700"
              >
                Save profile
              </button>
            </div>
          </form>

          <section className="rounded-lg border border-line bg-white p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <WalletCards className="h-3.5 w-3.5" />
              Account information
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <InfoItem label="User ID" value={account.id} />
              <InfoItem label="Team name" value="Creative Studio" />
              <InfoItem label="Role" value={account.role === "admin" ? "Admin" : "User"} />
              <InfoItem label="Status" value={account.active ? "Active" : "Disabled"} />
              <InfoItem label="Joined date" value={formatDate(account.createdAt)} />
              <InfoItem label="Total generated jobs" value={String(stats.total)} />
              <InfoItem label="Used credits" value={formatCredits(stats.creditsUsed)} />
              <InfoItem label="This month credits" value={formatCredits(monthlyCreditsSpent)} />
              <InfoItem label="This month jobs" value={String(monthlyJobsCompleted)} />
              <InfoItem label="Remaining credits" value={formatCredits(creditsRemaining)} />
            </div>
          </section>

          {account.role === "admin" ? (
            <AdminUsersPanel
              users={users}
              currentUserId={account.id}
              onCreateUser={onCreateUser}
              onUpdateUser={onUpdateUser}
              onResetUserPassword={onResetUserPassword}
              onToggleUserActive={onToggleUserActive}
            />
          ) : null}

          <form onSubmit={handlePasswordSubmit} className="rounded-lg border border-line bg-white p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <KeyRound className="h-3.5 w-3.5" />
              Password
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                type="password"
                placeholder="Current password"
                className="h-9 rounded-md border border-line px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              <input
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                placeholder="New password"
                className="h-9 rounded-md border border-line px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              <input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                placeholder="Confirm new password"
                className="h-9 rounded-md border border-line px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>
            {passwordMessage ? <p className="mt-2 text-xs font-semibold text-stone-600">{passwordMessage}</p> : null}
            <div className="mt-3 flex justify-end">
              <button
                type="submit"
                className="h-9 rounded-md border border-line bg-white px-4 text-xs font-bold text-stone-700 transition hover:bg-stone-50"
              >
                Change password
              </button>
            </div>
          </form>
        </div>

        <div className="flex justify-end gap-2 border-t border-line bg-white px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-line bg-white px-4 text-xs font-bold text-stone-700 transition hover:bg-stone-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AdminUsersPanel({
  users,
  currentUserId,
  onCreateUser,
  onUpdateUser,
  onResetUserPassword,
  onToggleUserActive,
}: {
  users: AuthUser[];
  currentUserId: string;
  onCreateUser: AccountPanelProps["onCreateUser"];
  onUpdateUser: AccountPanelProps["onUpdateUser"];
  onResetUserPassword: AccountPanelProps["onResetUserPassword"];
  onToggleUserActive: AccountPanelProps["onToggleUserActive"];
}) {
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "user" as "admin" | "user" });
  const [drafts, setDrafts] = useState<Record<string, { name: string; email: string; role: "admin" | "user"; active: boolean }>>({});
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [userSearch, setUserSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled">("all");
  const [showAllUsers, setShowAllUsers] = useState(false);
  const [message, setMessage] = useState("");

  const hasUserFilter = Boolean(userSearch.trim()) || roleFilter !== "all" || statusFilter !== "all";
  const filteredUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    return users.filter((user) => {
      const draft = drafts[user.id];
      const searchTarget = [
        user.name,
        user.displayName,
        user.email,
        user.username,
        draft?.name,
        draft?.email,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matchesQuery = !query || searchTarget.includes(query);
      const matchesRole = roleFilter === "all" || (draft?.role ?? user.role) === roleFilter;
      const isActive = draft?.active ?? user.active;
      const matchesStatus = statusFilter === "all" || (statusFilter === "active" ? isActive : !isActive);
      return matchesQuery && matchesRole && matchesStatus;
    });
  }, [drafts, roleFilter, statusFilter, userSearch, users]);
  const visibleUsers = hasUserFilter || showAllUsers ? filteredUsers : [];

  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const user of users) {
        next[user.id] = next[user.id] ?? {
          name: user.name,
          email: user.email,
          role: user.role,
          active: user.active,
        };
      }
      for (const userId of Object.keys(next)) {
        if (!users.some((user) => user.id === userId)) {
          delete next[userId];
        }
      }
      return next;
    });
  }, [users]);

  async function handleCreateUser(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      await onCreateUser(newUser);
      setNewUser({ name: "", email: "", password: "", role: "user" });
      setMessage("User created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create user.");
    }
  }

  async function handleSaveUser(userId: string) {
    const draft = drafts[userId];
    if (!draft) return;
    setMessage("");
    try {
      await onUpdateUser(userId, draft);
      setMessage("User saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save user.");
    }
  }

  async function handleToggleActive(user: AuthUser) {
    setMessage("");
    try {
      await onToggleUserActive(user.id, !user.active);
      setMessage(user.active ? "User disabled." : "User enabled.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update user status.");
    }
  }

  async function handleResetPassword(userId: string) {
    const password = resetPasswords[userId] ?? "";
    setMessage("");
    try {
      await onResetUserPassword(userId, password, password);
      setResetPasswords((current) => ({ ...current, [userId]: "" }));
      setMessage("Password reset.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not reset password.");
    }
  }

  function updateDraft(userId: string, updates: Partial<{ name: string; email: string; role: "admin" | "user"; active: boolean }>) {
    setDrafts((current) => ({
      ...current,
      [userId]: {
        ...(current[userId] ?? { name: "", email: "", role: "user", active: true }),
        ...updates,
      },
    }));
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
        <ShieldCheck className="h-3.5 w-3.5" />
        Admin users
      </div>

      <form onSubmit={handleCreateUser} className="grid gap-2 rounded-md border border-line bg-mist/40 p-3 sm:grid-cols-2">
        <input
          value={newUser.name}
          onChange={(event) => setNewUser((current) => ({ ...current, name: event.target.value }))}
          placeholder="Display name"
          className="h-9 min-w-0 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <input
          value={newUser.email}
          onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))}
          placeholder="name.surname@brickvisual.com"
          className="h-9 min-w-0 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <input
          value={newUser.password}
          onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))}
          type="password"
          placeholder="Temporary password"
          className="h-9 min-w-0 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <select
          value={newUser.role}
          onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value as "admin" | "user" }))}
          className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button
          type="submit"
          className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-xs font-bold text-white transition hover:bg-stone-700 sm:col-span-2"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Create
        </button>
      </form>

      <div className="mt-3 grid gap-2 rounded-md border border-line bg-white p-2 sm:grid-cols-[minmax(0,1fr)_140px_140px]">
        <input
          value={userSearch}
          onChange={(event) => setUserSearch(event.target.value)}
          placeholder="Search users by name, email, or username"
          className="h-9 min-w-0 rounded-md border border-line px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <select
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value as "all" | "admin" | "user")}
          className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          aria-label="Filter users by role"
        >
          <option value="all">All roles</option>
          <option value="admin">Admins</option>
          <option value="user">Users</option>
        </select>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "disabled")}
          className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          aria-label="Filter users by status"
        >
          <option value="all">All status</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-stone-500">
          {hasUserFilter || showAllUsers
            ? `Showing ${visibleUsers.length} of ${users.length} users`
            : `${users.length} users available. Search to edit one.`}
        </p>
        <button
          type="button"
          onClick={() => setShowAllUsers((current) => !current)}
          className="h-8 rounded-md border border-line bg-white px-3 text-xs font-bold text-stone-700 transition hover:bg-stone-50"
        >
          {showAllUsers ? "Hide list" : "Show all"}
        </button>
      </div>

      <div className="mt-3 space-y-2">
        {visibleUsers.map((user) => {
          const draft = drafts[user.id] ?? { name: user.name, email: user.email, role: user.role, active: user.active };
          return (
            <div key={user.id} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-2">
              <input
                value={draft.name}
                onChange={(event) => updateDraft(user.id, { name: event.target.value })}
                className="h-9 min-w-0 rounded-md border border-line px-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                aria-label={`${user.name} display name`}
              />
              <input
                value={draft.email}
                onChange={(event) => updateDraft(user.id, { email: event.target.value })}
                className="h-9 min-w-0 rounded-md border border-line px-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                aria-label={`${user.name} email`}
              />
              <select
                value={draft.role}
                onChange={(event) => updateDraft(user.id, { role: event.target.value as "admin" | "user" })}
                className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                aria-label={`${user.name} role`}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="button"
                onClick={() => handleSaveUser(user.id)}
                className="h-9 min-w-0 rounded-md border border-line px-3 text-xs font-bold text-stone-700 transition hover:bg-stone-50"
              >
                Save
              </button>
              <input
                value={resetPasswords[user.id] ?? ""}
                onChange={(event) => setResetPasswords((current) => ({ ...current, [user.id]: event.target.value }))}
                type="password"
                placeholder="New password"
                className="h-9 min-w-0 rounded-md border border-line px-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="button"
                onClick={() => handleResetPassword(user.id)}
                className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md border border-line px-3 text-xs font-bold text-stone-700 transition hover:bg-stone-50"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Reset
              </button>
              <button
                type="button"
                onClick={() => handleToggleActive(user)}
                disabled={user.id === currentUserId}
                className="h-9 min-w-0 rounded-md border border-line px-3 text-xs font-bold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {user.active ? "Disable" : "Enable"}
              </button>
            </div>
          );
        })}
        {!visibleUsers.length && hasUserFilter ? (
          <div className="rounded-md border border-dashed border-line px-3 py-5 text-center text-sm font-semibold text-stone-500">
            No users match the current filters.
          </div>
        ) : null}
        {!visibleUsers.length && !hasUserFilter ? (
          <div className="rounded-md border border-dashed border-line px-3 py-5 text-center text-sm font-semibold text-stone-500">
            Search by name, email, or username to manage a user.
          </div>
        ) : null}
      </div>

      {message ? <p className="mt-2 text-xs font-semibold text-stone-600">{message}</p> : null}
    </section>
  );
}

function Avatar({
  account,
  size = "small",
}: {
  account: Pick<AuthUser, "name" | "avatar" | "avatarColor" | "profileImageUrl">;
  size?: "small" | "large";
}) {
  const initials = account.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || account.avatar;

  return (
    <span
      className={`${size === "large" ? "h-14 w-14 text-base" : "h-8 w-8 text-xs"} flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white`}
      style={{ backgroundColor: account.avatarColor }}
    >
      {account.profileImageUrl ? (
        <img src={account.profileImageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        initials
      )}
    </span>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-mist/70 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-1 truncate font-semibold text-ink">{value}</p>
    </div>
  );
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(date));
}

function formatCredits(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}
