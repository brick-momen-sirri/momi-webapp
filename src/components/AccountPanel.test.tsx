// AccountPanel is the only surface that edits an account and, for admins, other
// people's accounts. Two things here are worth guarding closely:
//
//   1. The user-management panel is gated on `account.role === "admin"`. The
//      backend enforces this too, but a non-admin seeing those controls at all is
//      a bug worth catching in a test rather than in a support ticket.
//   2. Every mutation is delegated upward -- the panel holds draft state but never
//      decides the outcome. Tests assert on the arguments handed to the callbacks,
//      because that payload is what reaches the API.
//
// Most of this file's behavior lives behind the settings modal, which splits into
// Profile / Account / Security / Team tabs. Each tab mounts only while selected, so
// tests open the tab they are about to assert on.

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Job } from "../types";
import type { AuthUser } from "../services/backendApi";
import { AccountPanel } from "./AccountPanel";

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "usr_1",
    name: "Momen Sirri",
    email: "momen.sirri@brickvisual.com",
    role: "user",
    active: true,
    createdAt: "2026-01-15T10:00:00.000Z",
    updatedAt: "2026-01-15T10:00:00.000Z",
    avatarColor: "#11b8a5",
    ...overrides,
  } as AuthUser;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Veo 3",
    inputType: "single_image",
    prompt: "a shot",
    resolution: "1080p",
    status: "completed",
    inputImages: [],
    creditsUsed: 10,
    ...overrides,
  } as Job;
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = {
    account: user(),
    users: [user()],
    jobs: [] as Job[],
    creditsRemaining: 1200,
    monthlyCreditsSpent: 340,
    monthlyJobsCompleted: 7,
    onUpdateProfile: vi.fn().mockResolvedValue({ ok: true, account: user() }),
    onChangePassword: vi.fn().mockResolvedValue({ ok: true, account: user() }),
    onCreateUser: vi.fn().mockResolvedValue(user({ id: "usr_new" })),
    onUpdateUser: vi.fn().mockResolvedValue(user()),
    onResetUserPassword: vi.fn().mockResolvedValue(user()),
    onToggleUserActive: vi.fn().mockResolvedValue(user()),
    onLogout: vi.fn(),
    theme: "light" as const,
    onThemeToggle: vi.fn(),
    ...overrides,
  };
  return { ...render(<AccountPanel {...props} />), props };
}

async function openSettings(tab?: "Profile" | "Account" | "Security" | "Team") {
  const client = userEvent.setup();
  await client.click(screen.getByRole("button", { name: /profile settings/i }));
  const dialog = screen.getByRole("dialog");

  if (tab) {
    await client.click(within(dialog).getByRole("tab", { name: tab }));
  }

  return dialog;
}

// The account-information grid is a definition list: a <dt> label followed by its
// <dd> value. Reading the value via the label avoids matching the same word
// somewhere else in the modal -- "Admin" is also a role <option>, for instance.
function infoValue(dialog: HTMLElement, label: string) {
  return within(dialog).getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "";
}

describe("summary card", () => {
  it("shows who is signed in", () => {
    renderPanel();
    expect(screen.getByText("Momen Sirri")).toBeInTheDocument();
    expect(screen.getByText("momen.sirri@brickvisual.com")).toBeInTheDocument();
  });

  it("shows remaining and month-to-date credits", () => {
    renderPanel({ creditsRemaining: 1200, monthlyCreditsSpent: 340 });
    expect(screen.getByText(/1,?200 left/)).toBeInTheDocument();
    expect(screen.getByText(/340 this month/)).toBeInTheDocument();
  });

  it("keeps the settings modal closed until asked", () => {
    renderPanel();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("delegates sign-out rather than clearing state itself", async () => {
    const onLogout = vi.fn();
    renderPanel({ onLogout });
    await userEvent.setup().click(screen.getByRole("button", { name: /sign out/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("delegates the theme toggle", async () => {
    const onThemeToggle = vi.fn();
    renderPanel({ onThemeToggle });
    const toggle = screen.getByRole("button", { name: /dark mode|light mode|theme/i });
    await userEvent.setup().click(toggle);
    expect(onThemeToggle).toHaveBeenCalledTimes(1);
  });
});

describe("settings modal", () => {
  it("opens on the settings button and closes again on Done", async () => {
    const client = userEvent.setup();
    renderPanel();

    await client.click(screen.getByRole("button", { name: /profile settings/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await client.click(screen.getByRole("button", { name: /^done$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape", async () => {
    const client = userEvent.setup();
    renderPanel();
    await client.click(screen.getByRole("button", { name: /profile settings/i }));

    await client.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the Profile tab", async () => {
    renderPanel();
    const dialog = await openSettings();
    expect(within(dialog).getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByLabelText("Display name")).toBeInTheDocument();
  });

  it("moves between tabs with the arrow keys", async () => {
    const client = userEvent.setup();
    renderPanel();
    const dialog = await openSettings();

    within(dialog).getByRole("tab", { name: "Profile" }).focus();
    await client.keyboard("{ArrowDown}");

    expect(within(dialog).getByRole("tab", { name: "Account" })).toHaveAttribute("aria-selected", "true");
  });

  it("reports the account's role and status as badges", async () => {
    renderPanel({ account: user({ role: "admin", active: false }) });
    const dialog = await openSettings("Account");

    expect(infoValue(dialog, "Role")).toBe("Admin");
    expect(infoValue(dialog, "Status")).toBe("Disabled");
  });

  it("counts only this account's jobs in the usage stats", async () => {
    // Two jobs, one belonging to someone else. Attributing another user's spend
    // to this account would misreport usage on a shared workspace.
    renderPanel({
      account: user({ id: "usr_1" }),
      jobs: [job({ id: "a", userId: "usr_1", creditsUsed: 10 }), job({ id: "b", userId: "usr_2", creditsUsed: 999 })],
    });
    const dialog = await openSettings("Account");

    expect(infoValue(dialog, "Total generated jobs")).toBe("1");
    expect(infoValue(dialog, "Used credits")).toBe("10");
  });

  it("says so plainly when the account has never signed in", async () => {
    renderPanel({ account: user({ lastLoginAt: undefined }) });
    const dialog = await openSettings("Account");

    expect(infoValue(dialog, "Last sign-in")).toBe("Never");
  });
});

describe("profile form", () => {
  it("sends the edited display name upward", async () => {
    const client = userEvent.setup();
    const onUpdateProfile = vi.fn().mockResolvedValue({ ok: true, account: user() });
    renderPanel({ onUpdateProfile });
    await openSettings();

    const nameField = screen.getByLabelText("Display name");
    await client.clear(nameField);
    await client.type(nameField, "Momen S.");
    await client.click(screen.getByRole("button", { name: /save profile/i }));

    expect(onUpdateProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Momen S." }));
  });

  // An always-enabled Save invites no-op writes and makes it impossible to tell
  // whether anything is pending.
  it("cannot be saved until something actually changes", async () => {
    const client = userEvent.setup();
    const onUpdateProfile = vi.fn().mockResolvedValue({ ok: true, account: user() });
    renderPanel({ onUpdateProfile });
    await openSettings();

    expect(screen.getByRole("button", { name: /save profile/i })).toBeDisabled();

    await client.type(screen.getByLabelText("Display name"), " Jr");

    expect(screen.getByRole("button", { name: /save profile/i })).toBeEnabled();
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it("refuses a blank display name", async () => {
    const client = userEvent.setup();
    renderPanel();
    await openSettings();

    await client.clear(screen.getByLabelText("Display name"));

    expect(screen.getByRole("button", { name: /save profile/i })).toBeDisabled();
  });

  it("surfaces a rejected profile update instead of pretending it saved", async () => {
    const client = userEvent.setup();
    const onUpdateProfile = vi.fn().mockResolvedValue({ ok: false, error: "Display name is already taken." });
    renderPanel({ onUpdateProfile });
    await openSettings();

    await client.type(screen.getByLabelText("Display name"), " Jr");
    await client.click(screen.getByRole("button", { name: /save profile/i }));

    expect(await screen.findByText("Display name is already taken.")).toBeInTheDocument();
  });

  it("keeps the email read-only, because only an admin can change it", async () => {
    renderPanel();
    const dialog = await openSettings();
    const email = within(dialog).getByDisplayValue("momen.sirri@brickvisual.com");

    expect(email).toHaveAttribute("readonly");
    expect(email).toBeDisabled();
  });

  // Avatars are stored as data URLs on the account, so an oversized file would be
  // inlined into every auth response rather than being rejected up front.
  it("rejects an oversized picture instead of inlining it", async () => {
    renderPanel();
    const dialog = await openSettings();
    const file = new File([new Uint8Array(9 * 1024 * 1024)], "huge.png", { type: "image/png" });

    await userEvent.setup().upload(within(dialog).getByLabelText("Profile picture file"), file);

    expect(await within(dialog).findByText(/pick one under/i)).toBeInTheDocument();
  });

  // `accept="image/*"` filters the native picker, but a drag-drop still lands a
  // File on the input, so the handler checks the type itself. applyAccept is off
  // here so the test exercises that check rather than userEvent's own filtering.
  it("rejects a non-image file", async () => {
    renderPanel();
    const dialog = await openSettings();
    const file = new File(["not an image"], "notes.txt", { type: "text/plain" });

    await userEvent.setup({ applyAccept: false }).upload(within(dialog).getByLabelText("Profile picture file"), file);

    expect(await within(dialog).findByText(/pick an image file/i)).toBeInTheDocument();
  });
});

describe("password form", () => {
  const goodPassword = "new-value-123";

  it("passes current, new, and confirmation values in that order", async () => {
    const client = userEvent.setup();
    const onChangePassword = vi.fn().mockResolvedValue({ ok: true, account: user() });
    renderPanel({ onChangePassword });
    const dialog = await openSettings("Security");

    await client.type(within(dialog).getByPlaceholderText("Current password"), "old-value");
    await client.type(within(dialog).getByPlaceholderText("New password"), goodPassword);
    await client.type(within(dialog).getByPlaceholderText("Confirm new password"), goodPassword);
    await client.click(within(dialog).getByRole("button", { name: /change password/i }));

    expect(onChangePassword).toHaveBeenCalledWith("old-value", goodPassword, goodPassword);
  });

  it("clears the fields once the change succeeds", async () => {
    const client = userEvent.setup();
    renderPanel({ onChangePassword: vi.fn().mockResolvedValue({ ok: true, account: user() }) });
    const dialog = await openSettings("Security");

    await client.type(within(dialog).getByPlaceholderText("Current password"), "old-value");
    await client.type(within(dialog).getByPlaceholderText("New password"), goodPassword);
    await client.type(within(dialog).getByPlaceholderText("Confirm new password"), goodPassword);
    await client.click(within(dialog).getByRole("button", { name: /change password/i }));

    expect(await within(dialog).findByText("Password changed.")).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText("Current password")).toHaveValue("");
    expect(within(dialog).getByPlaceholderText("New password")).toHaveValue("");
  });

  it("keeps what was typed when the change is rejected", async () => {
    const client = userEvent.setup();
    renderPanel({ onChangePassword: vi.fn().mockResolvedValue({ ok: false, error: "Current password is incorrect." }) });
    const dialog = await openSettings("Security");

    await client.type(within(dialog).getByPlaceholderText("Current password"), "wrong-value");
    await client.type(within(dialog).getByPlaceholderText("New password"), goodPassword);
    await client.type(within(dialog).getByPlaceholderText("Confirm new password"), goodPassword);
    await client.click(within(dialog).getByRole("button", { name: /change password/i }));

    expect(await within(dialog).findByText("Current password is incorrect.")).toBeInTheDocument();
    // Not cleared: retyping everything after a typo is worse than leaving it.
    expect(within(dialog).getByPlaceholderText("Current password")).toHaveValue("wrong-value");
  });

  // The backend rejects these too, but a round-trip to learn the confirmation was
  // mistyped is a worse experience than refusing to submit.
  it("will not submit a mismatched confirmation", async () => {
    const client = userEvent.setup();
    const onChangePassword = vi.fn();
    renderPanel({ onChangePassword });
    const dialog = await openSettings("Security");

    await client.type(within(dialog).getByPlaceholderText("Current password"), "old-value");
    await client.type(within(dialog).getByPlaceholderText("New password"), goodPassword);
    await client.type(within(dialog).getByPlaceholderText("Confirm new password"), "something-else");

    expect(within(dialog).getByRole("button", { name: /change password/i })).toBeDisabled();
    expect(onChangePassword).not.toHaveBeenCalled();
  });

  it("will not submit a password under eight characters", async () => {
    const client = userEvent.setup();
    renderPanel();
    const dialog = await openSettings("Security");

    await client.type(within(dialog).getByPlaceholderText("Current password"), "old-value");
    await client.type(within(dialog).getByPlaceholderText("New password"), "short");
    await client.type(within(dialog).getByPlaceholderText("Confirm new password"), "short");

    expect(within(dialog).getByRole("button", { name: /change password/i })).toBeDisabled();
  });

  it("reveals the fields on Show", async () => {
    const client = userEvent.setup();
    renderPanel();
    const dialog = await openSettings("Security");

    expect(within(dialog).getByPlaceholderText("New password")).toHaveAttribute("type", "password");
    await client.click(within(dialog).getByRole("button", { name: /^show$/i }));
    expect(within(dialog).getByPlaceholderText("New password")).toHaveAttribute("type", "text");
  });
});

describe("admin user management", () => {
  it("is hidden from a non-admin account", async () => {
    renderPanel({ account: user({ role: "user" }) });
    const dialog = await openSettings();

    expect(within(dialog).queryByRole("tab", { name: "Team" })).toBeNull();
    expect(within(dialog).queryByLabelText(/search users/i)).toBeNull();
    expect(within(dialog).queryByLabelText(/filter users by role/i)).toBeNull();
  });

  it("is available to an admin account", async () => {
    renderPanel({ account: user({ role: "admin" }) });
    const dialog = await openSettings("Team");

    expect(within(dialog).getByLabelText(/search users/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/filter users by role/i)).toBeInTheDocument();
  });

  // The signed-in admin is given a name that appears nowhere in the managed list,
  // because the profile form's own name field would otherwise match the
  // display-value queries below and hide a broken filter.
  it("shows no user rows until a filter is applied", async () => {
    renderPanel({
      account: user({ id: "usr_admin", name: "Admin Owner", role: "admin" }),
      users: [user({ id: "usr_1", name: "Momen Sirri" }), user({ id: "usr_2", name: "Nour Ahmad" })],
    });
    const dialog = await openSettings("Team");

    // A workspace can have hundreds of accounts, so the list stays collapsed
    // until someone searches or asks for all of them.
    expect(within(dialog).queryByDisplayValue("Momen Sirri")).toBeNull();
    expect(within(dialog).queryByDisplayValue("Nour Ahmad")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /show all/i })).toBeInTheDocument();
  });

  it("reveals every user on Show all", async () => {
    const client = userEvent.setup();
    renderPanel({
      account: user({ id: "usr_admin", name: "Admin Owner", role: "admin" }),
      users: [user({ id: "usr_1", name: "Momen Sirri" }), user({ id: "usr_2", name: "Nour Ahmad" })],
    });
    const dialog = await openSettings("Team");

    await client.click(within(dialog).getByRole("button", { name: /show all/i }));

    expect(within(dialog).getByDisplayValue("Momen Sirri")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("Nour Ahmad")).toBeInTheDocument();
  });

  it("narrows the user list by search text", async () => {
    const client = userEvent.setup();
    renderPanel({
      account: user({ id: "usr_admin", name: "Admin Owner", role: "admin" }),
      users: [
        user({ id: "usr_1", name: "Momen Sirri", email: "momen.sirri@brickvisual.com" }),
        user({ id: "usr_2", name: "Nour Ahmad", email: "nour.ahmad@brickvisual.com" }),
      ],
    });
    const dialog = await openSettings("Team");

    await client.type(within(dialog).getByLabelText(/search users/i), "nour");

    expect(within(dialog).queryByDisplayValue("Momen Sirri")).toBeNull();
    expect(within(dialog).getByDisplayValue("Nour Ahmad")).toBeInTheDocument();
  });

  it("matches the search against email as well as name", async () => {
    const client = userEvent.setup();
    renderPanel({
      account: user({ id: "usr_admin", name: "Admin Owner", role: "admin" }),
      users: [
        user({ id: "usr_1", name: "Momen Sirri", email: "momen.sirri@brickvisual.com" }),
        user({ id: "usr_2", name: "Nour Ahmad", email: "nour.ahmad@brickvisual.com" }),
      ],
    });
    const dialog = await openSettings("Team");

    await client.type(within(dialog).getByLabelText(/search users/i), "nour.ahmad@");

    expect(within(dialog).getByDisplayValue("Nour Ahmad")).toBeInTheDocument();
    expect(within(dialog).queryByDisplayValue("Momen Sirri")).toBeNull();
  });

  it("narrows the user list by role", async () => {
    const client = userEvent.setup();
    renderPanel({
      account: user({ role: "admin" }),
      users: [user({ id: "usr_1", name: "An Admin", role: "admin" }), user({ id: "usr_2", name: "A Regular", role: "user" })],
    });
    const dialog = await openSettings("Team");

    await client.selectOptions(within(dialog).getByLabelText(/filter users by role/i), "admin");

    expect(within(dialog).getByDisplayValue("An Admin")).toBeInTheDocument();
    expect(within(dialog).queryByDisplayValue("A Regular")).toBeNull();
  });

  it("narrows the user list by status", async () => {
    const client = userEvent.setup();
    renderPanel({
      account: user({ role: "admin" }),
      users: [user({ id: "usr_1", name: "Still Here", active: true }), user({ id: "usr_2", name: "Long Gone", active: false })],
    });
    const dialog = await openSettings("Team");

    await client.selectOptions(within(dialog).getByLabelText(/filter users by status/i), "disabled");

    expect(within(dialog).getByDisplayValue("Long Gone")).toBeInTheDocument();
    expect(within(dialog).queryByDisplayValue("Still Here")).toBeNull();
  });

  it("hands a new user's details to the create callback", async () => {
    const client = userEvent.setup();
    const onCreateUser = vi.fn().mockResolvedValue(user({ id: "usr_new" }));
    renderPanel({ account: user({ role: "admin" }), onCreateUser });
    const dialog = await openSettings("Team");

    await client.type(within(dialog).getByLabelText(/new user email/i), "new.hire@brickvisual.com");
    await client.type(within(dialog).getByLabelText(/new user temporary password/i), "temp-value-1");
    await client.click(within(dialog).getByRole("button", { name: /^create$/i }));

    expect(onCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new.hire@brickvisual.com", password: "temp-value-1", role: "user" }),
    );
  });

  it("reports a failed creation rather than clearing the form", async () => {
    const client = userEvent.setup();
    const onCreateUser = vi.fn().mockRejectedValue(new Error("That email is already registered."));
    renderPanel({ account: user({ role: "admin" }), onCreateUser });
    const dialog = await openSettings("Team");

    await client.type(within(dialog).getByLabelText(/new user email/i), "taken@brickvisual.com");
    await client.click(within(dialog).getByRole("button", { name: /^create$/i }));

    expect(await within(dialog).findByText("That email is already registered.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/new user email/i)).toHaveValue("taken@brickvisual.com");
  });

  it("will not let an admin disable their own account", async () => {
    const client = userEvent.setup();
    renderPanel({
      account: user({ id: "usr_admin", name: "Admin Owner", role: "admin" }),
      users: [user({ id: "usr_admin", name: "Admin Owner", role: "admin" })],
    });
    const dialog = await openSettings("Team");

    await client.click(within(dialog).getByRole("button", { name: /show all/i }));

    expect(within(dialog).getByRole("button", { name: /^disable$/i })).toBeDisabled();
  });
});
