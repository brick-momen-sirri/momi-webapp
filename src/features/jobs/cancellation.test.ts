import { describe, expect, it } from "vitest";
import { canCancelJob, cancellationNote } from "./cancellation";

const users = [
  { id: "usr_artist", name: "Rana" },
  { id: "usr_admin", name: "Momen" },
];

describe("canCancelJob", () => {
  it("lets the submitter and any admin cancel, and nobody else", () => {
    const job = { userId: "usr_artist" };
    expect(canCancelJob({ id: "usr_artist", role: "user" }, job)).toBe(true);
    expect(canCancelJob({ id: "usr_admin", role: "admin" }, job)).toBe(true);
    expect(canCancelJob({ id: "usr_other", role: "user" }, job)).toBe(false);
    expect(canCancelJob(undefined, job)).toBe(false);
  });
});

describe("cancellationNote", () => {
  it("says the owner canceled it when the submitter did", () => {
    expect(cancellationNote({ userId: "usr_artist", status: "canceled", canceledBy: "usr_artist" }, users)).toBe(
      "Canceled by the owner",
    );
  });

  it("names the admin who canceled someone else's job", () => {
    expect(cancellationNote({ userId: "usr_artist", status: "canceled", canceledBy: "usr_admin" }, users)).toBe(
      "Canceled by admin Momen",
    );
  });

  it("still says it was an admin when the account is not in the roster", () => {
    expect(cancellationNote({ userId: "usr_artist", status: "canceled", canceledBy: "usr_gone" }, users)).toBe(
      "Canceled by an admin",
    );
  });

  it("reads as a request while the pod is still being stopped", () => {
    expect(
      cancellationNote({ userId: "usr_artist", status: "running", cancelRequested: true, canceledBy: "usr_admin" }, users),
    ).toBe("Cancel requested by admin Momen");
  });

  it("says nothing for jobs canceled before the canceller was recorded", () => {
    expect(cancellationNote({ userId: "usr_artist", status: "canceled" }, users)).toBeUndefined();
  });
});
