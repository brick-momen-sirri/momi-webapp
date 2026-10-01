import { describe, expect, it, vi } from "vitest";

import { clearLinkedResultParam, linkedResultId, resultLinkUrl } from "./resultLink";

describe("result links", () => {
  it("name the job on the address the sharer is using", () => {
    expect(resultLinkUrl("job_1c1a3405", { origin: "http://momi.studio:8190", pathname: "/" })).toBe(
      "http://momi.studio:8190/?result=job_1c1a3405",
    );
    // Whatever else was in the sharer's address bar is not carried along.
    expect(resultLinkUrl("job_1", { origin: "http://10.0.0.5:8190", pathname: "" })).toBe("http://10.0.0.5:8190/?result=job_1");
  });

  it("read back only a well-formed job id", () => {
    expect(linkedResultId("?result=job_1c1a3405")).toBe("job_1c1a3405");
    expect(linkedResultId("?theme=dark&result=%20job_9%20")).toBe("job_9");
    expect(linkedResultId("")).toBeUndefined();
    expect(linkedResultId("?result=")).toBeUndefined();
    expect(linkedResultId("?result=../../api/auth/me")).toBeUndefined();
    expect(linkedResultId(`?result=${"x".repeat(200)}`)).toBeUndefined();
  });

  it("are dropped from the address once acted on, keeping the rest", () => {
    const replaceState = vi.fn();
    const win = { location: { href: "http://momi.studio:8190/?theme=dark&result=job_1#top" }, history: { state: null, replaceState } };
    clearLinkedResultParam(win as unknown as Window);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?theme=dark#top");

    replaceState.mockClear();
    clearLinkedResultParam({ location: { href: "http://momi.studio:8190/" }, history: { state: null, replaceState } } as unknown as Window);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
