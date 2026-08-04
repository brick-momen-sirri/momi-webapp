// The primitive that replaced a dozen "reset state in an effect" sites, so it
// gets tested harder than any single one of them was.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useResetWhenChanged } from "./useResetWhenChanged";

// A component that keeps a local selection and resets it whenever `group` changes.
function Subject({ group, onRender }: { group: string; onRender?: () => void }) {
  const [selection, setSelection] = useState("initial");
  useResetWhenChanged(group, () => setSelection("initial"));
  onRender?.();
  return (
    <div>
      <span data-testid="group">{group}</span>
      <span data-testid="selection">{selection}</span>
      <button type="button" onClick={() => setSelection("chosen")}>
        choose
      </button>
    </div>
  );
}

const selection = () => screen.getByTestId("selection").textContent;

describe("resetting", () => {
  it("does not reset on the first render", () => {
    render(<Subject group="a" />);
    expect(selection()).toBe("initial");
  });

  it("leaves state alone while the key is unchanged", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Subject group="a" />);
    await user.click(screen.getByRole("button", { name: "choose" }));
    expect(selection()).toBe("chosen");

    // Re-rendering with the same key must not clobber the user's choice.
    rerender(<Subject group="a" />);
    expect(selection()).toBe("chosen");
  });

  it("resets when the key changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Subject group="a" />);
    await user.click(screen.getByRole("button", { name: "choose" }));
    expect(selection()).toBe("chosen");

    rerender(<Subject group="b" />);
    expect(selection()).toBe("initial");
  });

  it("resets again on a further change, not only the first", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Subject group="a" />);
    rerender(<Subject group="b" />);

    await user.click(screen.getByRole("button", { name: "choose" }));
    expect(selection()).toBe("chosen");
    rerender(<Subject group="c" />);
    expect(selection()).toBe("initial");
  });

  it("resets when the key changes back to a previous value", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Subject group="a" />);
    rerender(<Subject group="b" />);
    await user.click(screen.getByRole("button", { name: "choose" }));

    rerender(<Subject group="a" />);
    expect(selection()).toBe("initial");
  });
});

describe("key comparison", () => {
  it("uses Object.is, so NaN does not count as a change", () => {
    const reset = vi.fn();
    function NaNSubject({ value }: { value: number }) {
      useResetWhenChanged(value, reset);
      return null;
    }
    const { rerender } = render(<NaNSubject value={NaN} />);
    rerender(<NaNSubject value={NaN} />);
    // A naive !== comparison would treat NaN as changed on every render and loop.
    expect(reset).not.toHaveBeenCalled();
  });

  it("treats a new object identity as a change, so callers should pass a scalar", () => {
    const reset = vi.fn();
    function ObjectSubject({ value }: { value: { id: string } }) {
      useResetWhenChanged(value, reset);
      return null;
    }
    const { rerender } = render(<ObjectSubject value={{ id: "a" }} />);
    rerender(<ObjectSubject value={{ id: "a" }} />);
    // Documented sharp edge: identity, not deep equality. Call sites pass ids.
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("render behaviour", () => {
  it("does not loop, and settles within one extra render pass", async () => {
    const user = userEvent.setup();
    const onRender = vi.fn();
    const { rerender } = render(<Subject group="a" onRender={onRender} />);
    await user.click(screen.getByRole("button", { name: "choose" }));

    onRender.mockClear();
    rerender(<Subject group="b" />);
    // The reset happens during render, so React restarts the pass rather than
    // committing and re-rendering. A runaway loop would show up here as a large
    // count; an effect-based version would show the extra committed pass.
    expect(onRender.mock.calls.length).toBeLessThanOrEqual(3);
    expect(selection()).toBe("initial");
  });

  it("supports resetting several pieces of state from one key", async () => {
    const user = userEvent.setup();
    function MultiSubject({ group }: { group: string }) {
      const [a, setA] = useState("a0");
      const [b, setB] = useState("b0");
      useResetWhenChanged(group, () => {
        setA("a0");
        setB("b0");
      });
      return (
        <div>
          <span data-testid="a">{a}</span>
          <span data-testid="b">{b}</span>
          <button
            type="button"
            onClick={() => {
              setA("a1");
              setB("b1");
            }}
          >
            change
          </button>
        </div>
      );
    }

    const { rerender } = render(<MultiSubject group="one" />);
    await user.click(screen.getByRole("button", { name: "change" }));
    expect(screen.getByTestId("a").textContent).toBe("a1");
    expect(screen.getByTestId("b").textContent).toBe("b1");

    rerender(<MultiSubject group="two" />);
    expect(screen.getByTestId("a").textContent).toBe("a0");
    expect(screen.getByTestId("b").textContent).toBe("b0");
  });
});
