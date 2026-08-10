import { ChangeEvent, FormEvent, MouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Camera,
  Check,
  CheckCircle2,
  Coins,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Palette,
  Settings,
  Trash2,
  UserRound,
  UserPlus,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import type { Job } from "../types";
import type { AuthResult, AuthUser } from "../services/backendApi";
import { useResetWhenChanged } from "../utils/useResetWhenChanged";
import { ThemeToggle, type ThemeMode } from "./ThemeToggle";

type AccountPanelProps = {
  account: AuthUser;
  users: AuthUser[];
  jobs: Job[];
  creditsRemaining: number;
  monthlyCreditsSpent: number;
  monthlyJobsCompleted: number;
  onUpdateProfile: (updates: Pick<AuthUser, "name" | "avatarColor"> & { profileImageUrl?: string }) => Promise<AuthResult>;
  onChangePassword: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<AuthResult>;
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

// The backend rejects anything shorter (authService.validatePasswordPair), so the
// same floor is enforced here to save a round-trip on an obvious mistake.
const minPasswordLength = 8;

// Profile images travel as data URLs inside the account payload, so an unbounded
// upload would put a multi-megabyte string in every auth response. Oversized files
// are refused outright and everything else is downscaled before it is stored.
const maxAvatarUploadBytes = 8 * 1024 * 1024;
const avatarPixelSize = 256;

const fieldClass =
  "h-9 w-full min-w-0 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20";
const secondaryButtonClass =
  "flex h-9 items-center justify-center gap-1.5 rounded-md border border-line bg-white px-3 text-xs font-bold text-stone-700 transition hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass =
  "flex h-9 items-center justify-center gap-1.5 rounded-md bg-ink px-4 text-xs font-bold text-white transition hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50";

type Feedback = { tone: "success" | "error"; text: string };

type SettingsTab = "profile" | "account" | "security" | "team";

const tabs: { id: SettingsTab; label: string; heading: string; description: string; icon: typeof UserRound }[] = [
  {
    id: "profile",
    label: "Profile",
    heading: "Profile",
    description: "How your name and picture appear across the workspace.",
    icon: UserRound,
  },
  {
    id: "account",
    label: "Account",
    heading: "Account & usage",
    description: "Credit balance, job counts, and account metadata.",
    icon: Gauge,
  },
  {
    id: "security",
    label: "Security",
    heading: "Security",
    description: "Change the password used to sign in to this account.",
    icon: KeyRound,
  },
  {
    id: "team",
    label: "Team",
    heading: "Team management",
    description: "Create workspace accounts and manage existing ones.",
    icon: Users,
  },
];

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");

  const visibleTabs = useMemo(() => tabs.filter((tab) => tab.id !== "team" || account.role === "admin"), [account.role]);
  const activeMeta = visibleTabs.find((tab) => tab.id === activeTab) ?? visibleTabs[0];

  const stats = useMemo(() => {
    const userJobs = jobs.filter((job) => job.userId === account.id);
    return {
      total: userJobs.length,
      creditsUsed: userJobs.reduce((sum, job) => sum + (job.creditsUsed ?? 0), 0),
    };
  }, [account.id, jobs]);

  // Escape closes, and Tab is kept inside the dialog. Without the trap, tabbing
  // walks out into the workspace behind the overlay, where clicks do nothing.
  useEffect(() => {
    const node = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    node?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab" || !node) {
        return;
      }

      // The picture picker is a display:none file input driven by its own button,
      // so it is skipped rather than becoming an invisible stop in the cycle.
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]):not([type="file"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

      if (!focusable.length) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  function handleOverlayMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  // Arrow keys move between tabs, which is what a tablist is expected to do once
  // it stops being a plain row of buttons.
  function handleTabKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";

    if (!forward && !backward) {
      return;
    }

    event.preventDefault();
    const index = visibleTabs.findIndex((tab) => tab.id === activeTab);
    const nextIndex = (index + (forward ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
    setActiveTab(visibleTabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-stone-950/60 p-3"
      onMouseDown={handleOverlayMouseDown}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-settings-title"
        className="relative z-[1010] flex h-[min(88vh,760px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-line bg-white shadow-2xl outline-none sm:flex-row"
      >
        <aside className="flex shrink-0 flex-col border-b border-line bg-mist/40 sm:w-56 sm:border-b-0 sm:border-r">
          <div className="hidden min-w-0 items-center gap-3 border-b border-line px-4 py-4 sm:flex">
            <Avatar account={account} size="small" />
            <div className="min-w-0">
              <p id="profile-settings-title" className="truncate text-sm font-bold leading-tight">
                {account.name}
              </p>
              <p className="truncate text-[11px] text-stone-500">{account.email}</p>
            </div>
          </div>

          <nav
            role="tablist"
            aria-orientation="vertical"
            aria-label="Profile settings sections"
            onKeyDown={handleTabKeyDown}
            className="flex gap-1 overflow-x-auto p-2 sm:flex-col sm:overflow-x-visible"
          >
            {visibleTabs.map((tab, index) => {
              const isActive = tab.id === activeTab;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`profile-tab-${tab.id}`}
                  aria-selected={isActive}
                  aria-controls={`profile-panel-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:w-full ${
                    isActive ? "bg-white text-ink shadow-sm" : "text-stone-500 hover:bg-white hover:text-stone-700"
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 ${isActive ? "text-accent" : ""}`} />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <h2 className="text-base font-bold leading-tight">{activeMeta.heading}</h2>
              <p className="mt-0.5 text-xs text-stone-500">{activeMeta.description}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              title="Close"
              aria-label="Close profile settings"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
            {activeTab === "profile" ? (
              <TabPanel id="profile">
                <ProfileTab account={account} onUpdateProfile={onUpdateProfile} />
              </TabPanel>
            ) : null}

            {activeTab === "account" ? (
              <TabPanel id="account">
                <AccountTab
                  account={account}
                  creditsRemaining={creditsRemaining}
                  monthlyCreditsSpent={monthlyCreditsSpent}
                  monthlyJobsCompleted={monthlyJobsCompleted}
                  totalJobs={stats.total}
                  lifetimeCreditsUsed={stats.creditsUsed}
                />
              </TabPanel>
            ) : null}

            {activeTab === "security" ? (
              <TabPanel id="security">
                <SecurityTab account={account} onChangePassword={onChangePassword} />
              </TabPanel>
            ) : null}

            {activeTab === "team" ? (
              <TabPanel id="team">
                <AdminUsersPanel
                  users={users}
                  currentUserId={account.id}
                  onCreateUser={onCreateUser}
                  onUpdateUser={onUpdateUser}
                  onResetUserPassword={onResetUserPassword}
                  onToggleUserActive={onToggleUserActive}
                />
              </TabPanel>
            ) : null}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="truncate text-[11px] text-stone-500">Signed in as {account.email}</p>
            <button type="button" onClick={onClose} className={secondaryButtonClass}>
              Done
            </button>
          </footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TabPanel({ id, children }: { id: SettingsTab; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`profile-panel-${id}`} aria-labelledby={`profile-tab-${id}`} className="space-y-4">
      {children}
    </div>
  );
}

function ProfileTab({
  account,
  onUpdateProfile,
}: {
  account: AuthUser;
  onUpdateProfile: AccountPanelProps["onUpdateProfile"];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(account.name);
  const [avatarColor, setAvatarColor] = useState(account.avatarColor);
  const [profileImageUrl, setProfileImageUrl] = useState(account.profileImageUrl);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const trimmedName = name.trim();
  const isDirty =
    trimmedName !== account.name ||
    avatarColor !== account.avatarColor ||
    (profileImageUrl ?? "") !== (account.profileImageUrl ?? "");
  const canSave = isDirty && trimmedName.length > 0 && !isSaving;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (isSaving) {
      return;
    }

    setFeedback(null);
    setIsSaving(true);
    try {
      const result = await onUpdateProfile({ name: trimmedName, avatarColor, profileImageUrl });
      setFeedback(result.ok ? { tone: "success", text: "Profile saved." } : { tone: "error", text: result.error });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not save the profile." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setFeedback(null);

    if (!file.type.startsWith("image/")) {
      setFeedback({ tone: "error", text: "Pick an image file (PNG, JPG, or WebP)." });
      return;
    }

    if (file.size > maxAvatarUploadBytes) {
      setFeedback({
        tone: "error",
        text: `That image is ${formatBytes(file.size)}. Pick one under ${formatBytes(maxAvatarUploadBytes)}.`,
      });
      return;
    }

    try {
      setProfileImageUrl(await downscaleImage(file));
    } catch {
      setFeedback({ tone: "error", text: "Could not read that image. Try a different file." });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <SectionCard title="Picture" icon={Camera}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar account={{ ...account, name: trimmedName || account.name, avatarColor, profileImageUrl }} size="large" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => fileInputRef.current?.click()} className={secondaryButtonClass}>
                <Camera className="h-3.5 w-3.5" />
                Change picture
              </button>
              <button
                type="button"
                onClick={() => setProfileImageUrl(undefined)}
                disabled={!profileImageUrl}
                className={secondaryButtonClass}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove picture
              </button>
            </div>
            <p className="text-[11px] text-stone-500">
              PNG, JPG, or WebP up to {formatBytes(maxAvatarUploadBytes)}. Larger images are resized to {avatarPixelSize}px.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoChange}
              aria-label="Profile picture file"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Identity" icon={UserRound}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-stone-500">Display name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className={fieldClass} />
          </label>

          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-stone-500">
              <Lock className="h-3 w-3" />
              Email
            </span>
            <input
              value={account.email}
              readOnly
              disabled
              className={`${fieldClass} cursor-not-allowed bg-mist/70 text-stone-500`}
            />
            <span className="mt-1 block text-[11px] text-stone-500">Managed by an administrator.</span>
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Account icon color" icon={Palette}>
        <div role="radiogroup" aria-label="Account icon color" className="flex flex-wrap gap-2">
          {avatarColors.map((color) => {
            const isSelected = avatarColor === color;
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Account icon color ${color}`}
                onClick={() => setAvatarColor(color)}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  isSelected ? "ring-2 ring-accent" : "border border-line hover:scale-105"
                }`}
                style={{ backgroundColor: color }}
              >
                {isSelected ? <Check className="h-4 w-4 text-white" /> : null}
              </button>
            );
          })}
        </div>
      </SectionCard>

      <FeedbackBanner feedback={feedback} />

      <div className="flex items-center justify-end gap-2">
        {isDirty ? <p className="mr-auto text-[11px] font-semibold text-stone-500">You have unsaved changes.</p> : null}
        <button type="submit" disabled={!canSave} className={primaryButtonClass}>
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {isSaving ? "Saving" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

function AccountTab({
  account,
  creditsRemaining,
  monthlyCreditsSpent,
  monthlyJobsCompleted,
  totalJobs,
  lifetimeCreditsUsed,
}: {
  account: AuthUser;
  creditsRemaining: number;
  monthlyCreditsSpent: number;
  monthlyJobsCompleted: number;
  totalJobs: number;
  lifetimeCreditsUsed: number;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="Remaining credits" value={formatCredits(creditsRemaining)} icon={WalletCards} emphasis />
        <MetricTile label="Credits this month" value={formatCredits(monthlyCreditsSpent)} icon={Coins} />
        <MetricTile label="Jobs this month" value={String(monthlyJobsCompleted)} icon={Gauge} />
      </div>

      <SectionCard title="Account information" icon={UserRound}>
        <dl className="grid gap-2 sm:grid-cols-2">
          <InfoItem label="User ID" value={account.id} mono />
          <InfoItem
            label="Role"
            value={
              <Badge tone={account.role === "admin" ? "accent" : "neutral"}>{account.role === "admin" ? "Admin" : "User"}</Badge>
            }
          />
          <InfoItem
            label="Status"
            value={<Badge tone={account.active ? "positive" : "negative"}>{account.active ? "Active" : "Disabled"}</Badge>}
          />
          <InfoItem label="Joined" value={formatDate(account.createdAt)} />
          <InfoItem label="Last sign-in" value={account.lastLoginAt ? formatDateTime(account.lastLoginAt) : "Never"} />
          <InfoItem label="Total generated jobs" value={String(totalJobs)} />
          <InfoItem label="Used credits" value={formatCredits(lifetimeCreditsUsed)} />
        </dl>
      </SectionCard>
    </>
  );
}

function SecurityTab({
  account,
  onChangePassword,
}: {
  account: AuthUser;
  onChangePassword: AccountPanelProps["onChangePassword"];
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const checks = [
    { label: `At least ${minPasswordLength} characters`, met: newPassword.length >= minPasswordLength },
    { label: "Different from the current password", met: newPassword.length > 0 && newPassword !== currentPassword },
    { label: "Matches the confirmation", met: newPassword.length > 0 && newPassword === confirmPassword },
  ];
  const canSubmit = currentPassword.length > 0 && checks.every((check) => check.met) && !isSaving;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (isSaving) {
      return;
    }

    setFeedback(null);
    setIsSaving(true);
    try {
      const result = await onChangePassword(currentPassword, newPassword, confirmPassword);

      if (result.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setFeedback({ tone: "success", text: "Password changed." });
        return;
      }

      setFeedback({ tone: "error", text: result.error });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not change the password." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <SectionCard
        title="Change password"
        icon={KeyRound}
        action={
          <button
            type="button"
            onClick={() => setShowPasswords((current) => !current)}
            className="flex items-center gap-1.5 text-[11px] font-bold text-stone-500 transition hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showPasswords ? "Hide" : "Show"}
          </button>
        }
      >
        <div className="grid max-w-md gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-stone-500">Current password</span>
            <input
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type={showPasswords ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Current password"
              className={fieldClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-stone-500">New password</span>
            <input
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              type={showPasswords ? "text" : "password"}
              autoComplete="new-password"
              placeholder="New password"
              className={fieldClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-stone-500">Confirm new password</span>
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type={showPasswords ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Confirm new password"
              className={fieldClass}
            />
          </label>
        </div>

        <ul className="mt-3 space-y-1">
          {checks.map((check) => (
            <li
              key={check.label}
              className={`flex items-center gap-1.5 text-[11px] font-semibold ${check.met ? "text-teal-700" : "text-stone-500"}`}
            >
              {check.met ? <CheckCircle2 className="h-3 w-3" /> : <span className="h-3 w-3 rounded-full border border-line" />}
              {check.label}
            </li>
          ))}
        </ul>
      </SectionCard>

      <FeedbackBanner feedback={feedback} />

      <div className="flex items-center justify-end gap-2">
        <p className="mr-auto text-[11px] text-stone-500">
          Signing in as <span className="font-semibold">{account.email}</span>
        </p>
        <button type="submit" disabled={!canSubmit} className={primaryButtonClass}>
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {isSaving ? "Changing" : "Change password"}
        </button>
      </div>
    </form>
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
  const [drafts, setDrafts] = useState<Record<string, { name: string; email: string; role: "admin" | "user"; active: boolean }>>(
    {},
  );
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [userSearch, setUserSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled">("all");
  const [showAllUsers, setShowAllUsers] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const hasUserFilter = Boolean(userSearch.trim()) || roleFilter !== "all" || statusFilter !== "all";
  const filteredUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    return users.filter((user) => {
      const draft = drafts[user.id];
      const searchTarget = [user.name, user.displayName, user.email, user.username, draft?.name, draft?.email]
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

  // Drafts are seeded from whatever users have arrived. Keyed on the id list so
  // it re-seeds when the list changes, without an effect and the extra render it
  // caused every time the user list loaded.
  useResetWhenChanged(users.map((user) => user.id).join(","), () => {
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
  });

  async function handleCreateUser(event: FormEvent) {
    event.preventDefault();

    if (isCreating) {
      return;
    }

    setFeedback(null);
    setIsCreating(true);
    try {
      await onCreateUser(newUser);
      setNewUser({ name: "", email: "", password: "", role: "user" });
      setFeedback({ tone: "success", text: "User created." });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not create user." });
    } finally {
      setIsCreating(false);
    }
  }

  // Every per-user mutation funnels through here so a single row cannot be
  // double-submitted while its request is still in flight.
  async function runUserAction(userId: string, action: () => Promise<unknown>, successText: string, failureText: string) {
    if (pendingUserId) {
      return;
    }

    setFeedback(null);
    setPendingUserId(userId);
    try {
      await action();
      setFeedback({ tone: "success", text: successText });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : failureText });
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleSaveUser(userId: string) {
    const draft = drafts[userId];
    if (!draft) return;
    await runUserAction(userId, () => onUpdateUser(userId, draft), "User saved.", "Could not save user.");
  }

  async function handleToggleActive(user: AuthUser) {
    await runUserAction(
      user.id,
      () => onToggleUserActive(user.id, !user.active),
      user.active ? "User disabled." : "User enabled.",
      "Could not update user status.",
    );
  }

  async function handleResetPassword(userId: string) {
    const password = resetPasswords[userId] ?? "";
    await runUserAction(
      userId,
      async () => {
        await onResetUserPassword(userId, password, password);
        setResetPasswords((current) => ({ ...current, [userId]: "" }));
      },
      "Password reset.",
      "Could not reset password.",
    );
  }

  function updateDraft(
    userId: string,
    updates: Partial<{ name: string; email: string; role: "admin" | "user"; active: boolean }>,
  ) {
    setDrafts((current) => ({
      ...current,
      [userId]: {
        ...(current[userId] ?? { name: "", email: "", role: "user", active: true }),
        ...updates,
      },
    }));
  }

  return (
    <>
      <SectionCard title="Invite a user" icon={UserPlus}>
        <form onSubmit={handleCreateUser} className="grid gap-2 sm:grid-cols-2">
          <input
            value={newUser.name}
            onChange={(event) => setNewUser((current) => ({ ...current, name: event.target.value }))}
            placeholder="Display name"
            aria-label="New user display name"
            className={fieldClass}
          />
          <input
            value={newUser.email}
            onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))}
            placeholder="name.surname@brickvisual.com"
            aria-label="New user email"
            className={fieldClass}
          />
          <input
            value={newUser.password}
            onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))}
            type="password"
            placeholder="Temporary password"
            aria-label="New user temporary password"
            className={fieldClass}
          />
          <select
            value={newUser.role}
            onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value as "admin" | "user" }))}
            aria-label="New user role"
            className={fieldClass}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <div className="sm:col-span-2 sm:justify-self-end">
            <button type="submit" disabled={isCreating} className={primaryButtonClass}>
              {isCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              Create
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title="Existing users"
        icon={Users}
        action={
          <button type="button" onClick={() => setShowAllUsers((current) => !current)} className={secondaryButtonClass}>
            {showAllUsers ? "Hide list" : "Show all"}
          </button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_140px]">
          <input
            value={userSearch}
            onChange={(event) => setUserSearch(event.target.value)}
            placeholder="Search users by name, email, or username"
            aria-label="Search users"
            className={fieldClass}
          />
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value as "all" | "admin" | "user")}
            className={fieldClass}
            aria-label="Filter users by role"
          >
            <option value="all">All roles</option>
            <option value="admin">Admins</option>
            <option value="user">Users</option>
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "disabled")}
            className={fieldClass}
            aria-label="Filter users by status"
          >
            <option value="all">All status</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <p className="mt-2 text-[11px] font-semibold text-stone-500">
          {hasUserFilter || showAllUsers
            ? `Showing ${visibleUsers.length} of ${users.length} users`
            : `${users.length} users available. Search to edit one.`}
        </p>

        <div className="mt-3 space-y-2">
          {visibleUsers.map((user) => {
            const draft = drafts[user.id] ?? { name: user.name, email: user.email, role: user.role, active: user.active };
            const isPending = pendingUserId === user.id;
            return (
              <div key={user.id} className="rounded-md border border-line bg-mist/40 p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar account={user} size="small" />
                    <p className="truncate text-xs font-bold">{user.name}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role === "admin" ? "Admin" : "User"}</Badge>
                    <Badge tone={user.active ? "positive" : "negative"}>{user.active ? "Active" : "Disabled"}</Badge>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    value={draft.name}
                    onChange={(event) => updateDraft(user.id, { name: event.target.value })}
                    className={fieldClass}
                    aria-label={`${user.name} display name`}
                  />
                  <input
                    value={draft.email}
                    onChange={(event) => updateDraft(user.id, { email: event.target.value })}
                    className={fieldClass}
                    aria-label={`${user.name} email`}
                  />
                  <select
                    value={draft.role}
                    onChange={(event) => updateDraft(user.id, { role: event.target.value as "admin" | "user" })}
                    className={fieldClass}
                    aria-label={`${user.name} role`}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => handleSaveUser(user.id)}
                    disabled={isPending}
                    className={secondaryButtonClass}
                  >
                    Save
                  </button>
                  <input
                    value={resetPasswords[user.id] ?? ""}
                    onChange={(event) => setResetPasswords((current) => ({ ...current, [user.id]: event.target.value }))}
                    type="password"
                    placeholder="New password"
                    aria-label={`${user.name} new password`}
                    className={fieldClass}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => handleResetPassword(user.id)}
                      disabled={isPending}
                      className={secondaryButtonClass}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleActive(user)}
                      disabled={user.id === currentUserId || isPending}
                      title={user.id === currentUserId ? "You cannot disable your own account" : undefined}
                      className={secondaryButtonClass}
                    >
                      {user.active ? "Disable" : "Enable"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {!visibleUsers.length ? (
            <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm font-semibold text-stone-500">
              {hasUserFilter
                ? "No users match the current filters."
                : "Search by name, email, or username to manage a user."}
            </div>
          ) : null}
        </div>
      </SectionCard>

      <FeedbackBanner feedback={feedback} />
    </>
  );
}

function SectionCard({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: typeof UserRound;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-white p-3.5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-stone-500">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

// Messages are the only place the modal reports an outcome, so success and failure
// are told apart by color and icon rather than by reading the sentence, and the
// live region exists before the first message so it actually gets announced.
function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  return (
    <div aria-live="polite">
      {feedback ? (
        <p
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs font-semibold ${
            feedback.tone === "success" ? "border-teal-100 bg-teal-50 text-teal-700" : "border-red-100 bg-red-50 text-red-700"
          }`}
        >
          {feedback.tone === "success" ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}

function MetricTile({
  label,
  value,
  icon: Icon,
  emphasis = false,
}: {
  label: string;
  value: string;
  icon: typeof UserRound;
  emphasis?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${emphasis ? "border-accent/40 bg-teal-50" : "border-line bg-mist/40"}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-stone-500">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className={`mt-1.5 text-2xl font-bold leading-none ${emphasis ? "text-accent" : "text-ink"}`}>{value}</p>
    </div>
  );
}

function Badge({ tone, children }: { tone: "accent" | "neutral" | "positive" | "negative"; children: ReactNode }) {
  const toneClass = {
    accent: "border-teal-100 bg-teal-50 text-teal-700",
    neutral: "border-line bg-mist/70 text-stone-600",
    positive: "border-teal-100 bg-teal-50 text-teal-700",
    negative: "border-red-100 bg-red-50 text-red-700",
  }[tone];

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${toneClass}`}>
      {children}
    </span>
  );
}

function Avatar({
  account,
  size = "small",
}: {
  account: Pick<AuthUser, "name" | "avatar" | "avatarColor" | "profileImageUrl">;
  size?: "small" | "large";
}) {
  const initials =
    account.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || account.avatar;

  return (
    <span
      className={`${size === "large" ? "h-16 w-16 text-lg" : "h-8 w-8 text-xs"} flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white`}
      style={{ backgroundColor: account.avatarColor }}
    >
      {account.profileImageUrl ? <img src={account.profileImageUrl} alt="" className="h-full w-full object-cover" /> : initials}
    </span>
  );
}

function InfoItem({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-md bg-mist/70 px-3 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className={`mt-1 truncate text-sm font-semibold text-ink ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

// Reads the file, paints it into a square-bounded canvas, and hands back a JPEG
// data URL. Keeps stored avatars in the low tens of kilobytes no matter what the
// user picked from their camera roll.
async function downscaleImage(file: File): Promise<string> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unreadable file.")));
    reader.onerror = () => reject(reader.error ?? new Error("Unreadable file."));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Unsupported image."));
    element.src = source;
  });

  const scale = Math.min(1, avatarPixelSize / Math.max(image.width, image.height, 1));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas unavailable.");
  }

  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(date));
}

function formatDateTime(date: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function formatCredits(value: number) {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
