// App-level tests: the boot sequence, the auth gate, and the flows that span
// several components. These are the ones that catch a regression no unit test
// would -- a panel that stops rendering because a fetch it never used began
// failing, or the whole app blanking because one endpoint returned a 500.
//
// The harness stubs fetch rather than the backendApi module; see
// src/test/appHarness.tsx for why.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { backendJob, backendProject, backendUser, defaultState, installBackend, type Harness } from "./test/appHarness";

let harness: Harness;

function boot(mutate: (state: ReturnType<typeof defaultState>) => void = () => {}) {
  const state = defaultState();
  mutate(state);
  harness = installBackend(state);
  return render(<App />);
}

// App gates everything behind the session restore, so almost every test starts
// by waiting for that to settle.
async function bootSignedIn(mutate: (state: ReturnType<typeof defaultState>) => void = () => {}) {
  const result = boot(mutate);
  await waitFor(() => expect(harness.callsTo("/api/auth/me").length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryAllByText(/Sign in/i)).toHaveLength(0), { timeout: 4000 });
  return result;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("boot and the auth gate", () => {
  it("shows the sign-in screen when there is no session", async () => {
    boot((state) => {
      state.user = null;
    });
    // The 401 from /api/auth/me is the signal, not the absence of a token.
    await waitFor(() => expect(screen.queryAllByText(/Sign in/i).length).toBeGreaterThan(0));
  });

  it("does not fetch workspace data before a session exists", async () => {
    boot((state) => {
      state.user = null;
    });
    await waitFor(() => expect(screen.queryAllByText(/Sign in/i).length).toBeGreaterThan(0));
    // Fetching projects or jobs for an anonymous visitor would be a wasted
    // round trip that always 401s.
    expect(harness.callsTo("/api/projects")).toHaveLength(0);
    expect(harness.callsTo("/api/jobs")).toHaveLength(0);
  });

  it("renders the workspace when the session restores", async () => {
    await bootSignedIn();
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
  });

  it("clears a stale token when the session is rejected", async () => {
    window.localStorage.setItem("momi_auth_token_v1", "sess_stale");
    boot((state) => {
      state.user = null;
    });
    await waitFor(() => expect(screen.queryAllByText(/Sign in/i).length).toBeGreaterThan(0));
    // Leaving it behind means every later request carries a token the backend
    // has already refused.
    expect(window.localStorage.getItem("momi_auth_token_v1")).toBeNull();
  });
});

describe("workspace load", () => {
  it("loads the catalogue, projects and jobs once signed in", async () => {
    await bootSignedIn();
    await waitFor(() => {
      expect(harness.callsTo("/api/models").length).toBeGreaterThan(0);
      expect(harness.callsTo("/api/projects").length).toBeGreaterThan(0);
      expect(harness.callsTo("/api/jobs").length).toBeGreaterThan(0);
    });
  });

  it("asks for a bounded page of jobs rather than the whole history", async () => {
    await bootSignedIn();
    await waitFor(() => expect(harness.callsTo("/api/jobs").length).toBeGreaterThan(0));
    const call = harness.callsTo("/api/jobs")[0];
    const limit = new URLSearchParams(call.search).get("limit");
    expect(limit).toBeTruthy();
    expect(Number(limit)).toBeGreaterThan(0);
    expect(Number(limit)).toBeLessThanOrEqual(250);
  });

  it("renders a job returned by the backend", async () => {
    await bootSignedIn((state) => {
      state.jobs = [backendJob({ id: "job_1", prompt: "a distinctive harness prompt" })];
    });
    await waitFor(() => expect(screen.getByText(/a distinctive harness prompt/)).toBeInTheDocument());
  });

  it("renders the project the backend returned", async () => {
    await bootSignedIn((state) => {
      state.projects = [backendProject({ name: "Harness Tower" })];
    });
    await waitFor(() => expect(screen.getAllByText(/Harness Tower/).length).toBeGreaterThan(0));
  });

  it("skips the Comfy pool fetch when local Comfy is disabled", async () => {
    await bootSignedIn();
    await waitFor(() => expect(harness.callsTo("/api/models").length).toBeGreaterThan(0));
    // RunPod is the production backend; polling a local pool that is not running
    // would just log connection failures every tick.
    expect(harness.callsTo("/api/comfy/servers")).toHaveLength(0);
  });

  it("fetches the Comfy pool when local Comfy is enabled", async () => {
    await bootSignedIn((state) => {
      state.runtime = { ...state.runtime, localComfyEnabled: true };
    });
    await waitFor(() => expect(harness.callsTo("/api/comfy/servers").length).toBeGreaterThan(0));
  });
});

describe("resilience", () => {
  it("still renders the workspace when the job list fails", async () => {
    await bootSignedIn((state) => {
      state.overrides["/api/jobs"] = { status: 500, body: { error: "job store unavailable" } };
    });
    // A failing panel must not blank the whole app -- the shell and the other
    // panels are what the artist needs to see the failure in context.
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
  });

  it("still renders when credits are unavailable", async () => {
    await bootSignedIn((state) => {
      state.overrides["/api/credits"] = { status: 503, body: { error: "credit tracker down" } };
    });
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
  });

  it("still renders when the model catalogue fails", async () => {
    await bootSignedIn((state) => {
      state.overrides["/api/models"] = { status: 500, body: { error: "workflow scan failed" } };
    });
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
  });

  it("survives an empty workspace with no projects, jobs or models", async () => {
    await bootSignedIn((state) => {
      state.projects = [];
      state.jobs = [];
      state.models = [];
    });
    // The first-run state: nothing configured yet. It must render, not throw.
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
  });

  it("hits no unrouted endpoint during a normal boot", async () => {
    await bootSignedIn();
    await waitFor(() => expect(harness.callsTo("/api/jobs").length).toBeGreaterThan(0));
    // If App starts calling something new, this fails and the harness gets a
    // route -- rather than the call silently receiving a 404 body.
    expect(harness.unrouted).toEqual([]);
  });
});

describe("main workspace sections", () => {
  it("defaults to Animation and keeps its inputs when visiting Still Images", async () => {
    const user = userEvent.setup();
    await bootSignedIn();

    const animationPrompt = await screen.findByRole("textbox", { name: "Generation prompt" });
    await user.type(animationPrompt, "keep this animation prompt");

    expect(screen.getByRole("button", { name: /^Animation/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /^Still Images/ }));

    expect(screen.getByRole("heading", { name: "Still image results" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Generation Settings" })).not.toBeInTheDocument();
    const cameraNumber = screen.getByRole("textbox", { name: "Camera number" });
    await user.clear(cameraNumber);
    await user.type(cameraNumber, "0042");
    // The preview mirrors what the backend actually writes -- date, lowercased
    // model, four-digit project code, cam-NN, and a placeholder version -- rather
    // than the invented SHORT_Name_Workflow_CAM0042 format it used to show. The
    // date is left unpinned so this does not fail tomorrow.
    expect(screen.getByText(/^\d{8}_general-enhancement_.+_cam-42_v###\.png$/)).toBeInTheDocument();
    expect(harness.callsTo("/api/jobs").filter((call) => call.method === "POST")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /^Animation/ }));
    expect(screen.getByRole("textbox", { name: "Generation prompt" })).toHaveValue("keep this animation prompt");
    expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument();
  });

  it("keeps one Save result destination when switching between Animation and Still Images", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("momi_generation_settings_v1", JSON.stringify({ selectedProjectId: "proj_1" }));
    await bootSignedIn((state) => {
      state.projects = [
        backendProject({ folders: [{ folderId: "fld_interiors", name: "Interiors", archived: false }] }),
      ];
    });

    const animationDestination = await screen.findByRole("combobox", { name: "Save result to" });
    await user.selectOptions(animationDestination, "fld_interiors");
    expect(animationDestination).toHaveValue("fld_interiors");

    await user.click(screen.getByRole("button", { name: /^Still Images/ }));
    expect(screen.getByRole("combobox", { name: "Save result to" })).toHaveValue("fld_interiors");

    await user.selectOptions(screen.getByRole("combobox", { name: "Save result to" }), "");
    await user.click(screen.getByRole("button", { name: /^Animation/ }));
    expect(screen.getByRole("combobox", { name: "Save result to" })).toHaveValue("");
  });

  it("brings back each project's own Save result destination when switching projects", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("momi_generation_settings_v1", JSON.stringify({ selectedProjectId: "proj_1" }));
    await bootSignedIn((state) => {
      state.projects = [
        backendProject({
          folders: [
            { folderId: "fld_sara", parentId: null, name: "Sara Haddad", archived: false },
            { folderId: "fld_sara_01", parentId: "fld_sara", name: "01 Camera Moves", archived: false },
            { folderId: "fld_omar", parentId: null, name: "Omar Khalil", archived: false },
            { folderId: "fld_omar_01", parentId: "fld_omar", name: "01 Camera Moves", archived: false },
          ],
        }),
        backendProject({
          id: "proj_2",
          name: "Harbour Pavilion",
          folders: [{ folderId: "fld_lookdev", parentId: null, name: "Lookdev", archived: false }],
        }),
      ];
    });

    const destination = await screen.findByRole("combobox", { name: "Save result to" });
    // Same-named subfolders are told apart by their parent, in tree order.
    expect(Array.from((destination as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      "Root",
      "Omar Khalil",
      "Omar Khalil / 01 Camera Moves",
      "Sara Haddad",
      "Sara Haddad / 01 Camera Moves",
    ]);
    await user.selectOptions(destination, "fld_sara_01");

    await user.click(screen.getByRole("button", { name: "Select project Harbour Pavilion" }));
    expect(screen.getByRole("combobox", { name: "Save result to" })).toHaveValue("");
    await user.selectOptions(screen.getByRole("combobox", { name: "Save result to" }), "fld_lookdev");

    await user.click(screen.getByRole("button", { name: "Select project Glass Tower" }));
    expect(screen.getByRole("combobox", { name: "Save result to" })).toHaveValue("fld_sara_01");

    await user.click(screen.getByRole("button", { name: "Select project Harbour Pavilion" }));
    expect(screen.getByRole("combobox", { name: "Save result to" })).toHaveValue("fld_lookdev");
  });

  it("labels a result card with its folder's full path", async () => {
    window.localStorage.setItem("momi_generation_settings_v1", JSON.stringify({ selectedProjectId: "proj_1" }));
    await bootSignedIn((state) => {
      state.projects = [
        backendProject({
          folders: [
            { folderId: "fld_sara", parentId: null, name: "Sara Haddad", archived: false },
            { folderId: "fld_sara_0100", parentId: "fld_sara", name: "Shot 0100", archived: false },
          ],
        }),
      ];
      state.jobs = [backendJob({ folderId: "fld_sara_0100", folderName: "Shot 0100" })];
    });

    await waitFor(() =>
      expect(
        screen.getAllByText("Sara Haddad / Shot 0100").some((element) => element.tagName === "SPAN"),
      ).toBe(true),
    );
  });

  it("shows all Still Images categories without submitting a job", async () => {
    const user = userEvent.setup();
    await bootSignedIn();
    // bootSignedIn only settles the session; the workspace shell arrives one
    // fetch later. Clicking before it does finds the loading screen instead,
    // which only shows up when the suite is under enough load to lose the race.
    await user.click(await screen.findByRole("button", { name: /^Still Images/ }));

    for (const category of ["General Enhancement", "Pro Upscaler", "Reference Generator", "Flux 2 Klein Edit"]) {
      expect(screen.getByRole("button", { name: category })).toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: "Flux 2 Klein Edit" }));
    await user.selectOptions(screen.getByLabelText("Image count"), "3");
    expect(screen.getByLabelText("Upload Image 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(harness.callsTo("/api/jobs").filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("session teardown", () => {
  it("signing out returns to the sign-in screen and drops the token", async () => {
    const user = userEvent.setup();
    await bootSignedIn();
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
    window.localStorage.setItem("momi_auth_token_v1", "sess_test");

    const signOut = screen.queryByRole("button", { name: /sign out|log out/i });
    if (!signOut) {
      // The control lives inside the account panel; open it first.
      const account = screen.getAllByRole("button").find((b) => /momen|account/i.test(b.textContent ?? ""));
      if (account) await user.click(account);
    }
    const control = screen.queryByRole("button", { name: /sign out|log out/i });
    expect(control, "a sign-out control must be reachable").toBeTruthy();
    await user.click(control as HTMLElement);

    await waitFor(() => expect(harness.callsTo("/api/auth/logout").length).toBeGreaterThan(0));
    await waitFor(() => expect(window.localStorage.getItem("momi_auth_token_v1")).toBeNull());
  });
});

describe("role-gated surfaces", () => {
  it("offers admin controls to an admin", async () => {
    await bootSignedIn((state) => {
      state.user = backendUser({ role: "admin" });
      state.users = [state.user];
    });
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
    // The user list is admin-only data; App requests it for an admin.
    expect(harness.callsTo("/api/users").length).toBeGreaterThan(0);
  });

  it("renders for a non-admin without crashing", async () => {
    await bootSignedIn((state) => {
      state.user = backendUser({ id: "usr_artist", name: "artist", role: "user" });
      state.users = [state.user];
    });
    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
  });

  // A viewer used to get a fully live form and learn about the refusal only from
  // one "Project editor access required." toast per Generate attempt, after the
  // upload had already been sent.
  it("presents a view-only form to a project viewer", async () => {
    window.localStorage.setItem("momi_generation_settings_v1", JSON.stringify({ selectedProjectId: "proj_1" }));
    await bootSignedIn((state) => {
      state.user = backendUser({ id: "usr_artist", name: "artist", role: "user" });
      state.users = [state.user];
      state.projects = [
        backendProject({
          members: [
            { userId: "usr_momen", role: "owner" },
            { userId: "usr_artist", role: "viewer" },
          ],
        }),
      ];
    });

    await waitFor(() => expect(screen.getByText(/View-only access to Glass Tower/i)).toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Generation prompt" })).toBeDisabled();
    expect(screen.getByLabelText("Upload Input image")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Generate/ })).toBeDisabled();
    expect(screen.getByText(/Ask a project owner for editor access\./i)).toBeInTheDocument();
  });

  it("leaves the form live for a project editor", async () => {
    window.localStorage.setItem("momi_generation_settings_v1", JSON.stringify({ selectedProjectId: "proj_1" }));
    await bootSignedIn((state) => {
      state.user = backendUser({ id: "usr_artist", name: "artist", role: "user" });
      state.users = [state.user];
      state.projects = [
        backendProject({
          members: [
            { userId: "usr_momen", role: "owner" },
            { userId: "usr_artist", role: "editor" },
          ],
        }),
      ];
    });

    await waitFor(() => expect(screen.getByText(/AI generation jobs/i)).toBeInTheDocument());
    expect(screen.queryByText(/View-only access/i)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Generation prompt" })).toBeEnabled();
    expect(screen.getByLabelText("Upload Input image")).toBeEnabled();
  });
});

describe("shared result links", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    Reflect.deleteProperty(window, "isSecureContext");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("open a result from another project that is not on the loaded page, in its folder", async () => {
    window.history.replaceState(null, "", "/?result=job_old");
    await bootSignedIn((state) => {
      state.projects = [
        backendProject(),
        backendProject({
          id: "proj_2",
          name: "Marina",
          shortName: "MAR",
          folders: [{ folderId: "fld_shot", parentId: null, name: "SHOT0002", archived: false }],
        }),
      ];
      state.jobs = [backendJob({ id: "job_new", prompt: "the newest result on page one" })];
      state.overrides["/api/jobs/job_old"] = {
        body: {
          job: backendJob({
            id: "job_old",
            projectId: "proj_2",
            folderId: "fld_shot",
            prompt: "the shared marina flythrough",
            createdAt: "2026-07-01T10:00:00.000Z",
          }),
        },
      };
    });

    await waitFor(() => expect(screen.getByText(/the shared marina flythrough/)).toBeInTheDocument());
    expect(screen.getByText(/the shared marina flythrough/).closest("article")).toHaveAttribute("data-linked", "true");
    expect(screen.getByText("Opened the shared result in Marina.")).toBeInTheDocument();
    // The project's own newest page replaced the old one, and the linked result stayed.
    await waitFor(() =>
      expect(harness.calls.some((call) => call.path === "/api/jobs" && call.search.includes("folderId=fld_shot"))).toBe(true),
    );
    expect(screen.getByText(/the shared marina flythrough/)).toBeInTheDocument();
    expect(screen.queryByText(/the newest result on page one/)).toBeNull();
    expect(harness.callsTo("/api/jobs/job_old")).toHaveLength(1);
    expect(window.location.search).toBe("");
  });

  it("say so when the result cannot be opened, and drop the link", async () => {
    window.history.replaceState(null, "", "/?result=job_gone");
    await bootSignedIn((state) => {
      state.overrides["/api/jobs/job_gone"] = { status: 404, body: { error: "Job not found" } };
    });

    await waitFor(() => expect(screen.getByText(/That result link can't be opened/)).toBeInTheDocument());
    expect(document.querySelector("[data-linked]")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("ask a signed-out colleague to sign in, and keep the link for after", async () => {
    window.history.replaceState(null, "", "/?result=job_1");
    boot((state) => {
      state.user = null;
    });

    await waitFor(() => expect(screen.getByText("Sign in to open the result that was shared with you.")).toBeInTheDocument());
    expect(harness.callsTo("/api/jobs/job_1")).toHaveLength(0);
    expect(window.location.search).toBe("?result=job_1");
  });

  it("open a still image result in Still Images, without refetching one already loaded", async () => {
    window.history.replaceState(null, "", "/?result=job_still");
    await bootSignedIn((state) => {
      state.jobs = [
        backendJob({
          id: "job_still",
          modelId: "still_general-enhancement",
          workflowOptions: { stillImage: { categoryId: "general-enhancement", settings: {} } },
        }),
      ];
    });

    await waitFor(() => expect(screen.getByText("Still image results")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector("[data-linked]")?.id).toBe("result-card-job_still"));
    expect(harness.callsTo("/api/jobs/job_still")).toHaveLength(0);
  });

  it("copy a link that names the result", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await bootSignedIn();

    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?result=job_1`));
    expect(screen.getByText("Link copied. Anyone with access to this project can open it.")).toBeInTheDocument();
  });
});
