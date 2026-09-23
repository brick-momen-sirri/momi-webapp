import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearMediaAccessToken, storeMediaAccess } from "../services/api/mediaAccess";
import { ProfileAvatar } from "./ProfileAvatar";

describe("ProfileAvatar", () => {
  afterEach(() => clearMediaAccessToken());

  it("adds media access to managed portrait renditions", () => {
    storeMediaAccess({
      token: "mt_test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      cookie: false,
    });

    render(
      <ProfileAvatar
        user={{
          name: "Momen Sirri",
          avatar: "MS",
          avatarColor: "#14b8a6",
          profileImageUrl: "/api/profile-pictures/momen-dsc6470-0123456789/avatar-256.webp",
        }}
        alt="Momen Sirri"
      />,
    );

    const image = screen.getByRole("img", { name: "Momen Sirri" });
    expect(image).toHaveAttribute(
      "src",
      "/api/profile-pictures/momen-dsc6470-0123456789/avatar-256.webp?access_token=mt_test",
    );
    expect(image.getAttribute("srcset")).toContain("avatar-64.webp?access_token=mt_test 64w");
  });

  it("falls back to initials when the image cannot load", () => {
    render(
      <ProfileAvatar
        user={{
          name: "Momen Sirri",
          avatar: "MS",
          avatarColor: "#14b8a6",
          profileImageUrl: "/api/profile-pictures/missing/avatar-256.webp",
        }}
        alt="Momen Sirri"
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Momen Sirri" }));

    expect(screen.queryByRole("img", { name: "Momen Sirri" })).not.toBeInTheDocument();
    expect(screen.getByText("MS")).toBeInTheDocument();
  });
});
